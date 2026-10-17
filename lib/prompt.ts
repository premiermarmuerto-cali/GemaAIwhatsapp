/**
 * Construcción del system prompt. El operador controla la voz (config.systemPrompt);
 * este archivo añade los hechos y las reglas duras, que no son editables desde el panel.
 *
 * Decisión de diseño: el modelo NO llama herramientas. Recibe la disponibilidad real ya
 * calculada en el prompt y, cuando el cliente acepta un horario, lo pide con la marca
 * [[RESERVA]]. El servidor es quien aparta la cabina y quien pega el link de pago, así que
 * el modelo no puede inventarse ni un horario ni un cobro.
 */
import { addDays, clock12, dayKey, dayLabel, nextHumanWindow, startWindows, type Occupancy } from './calendar'
import { LOCATION_LABEL, LOCATIONS, WEEKDAY_LABEL } from './clinic'
import { amountOf, bookingPrice, depositOf, paymentFor, pesos, twoForOneApplies } from './config'
import { chargeText, liveBookingOf, serviceText, sweepExpiredHolds } from './booking'
import { keys, redis, toHash } from './redis'
import { formatPhone, countryOf, regionOf } from './phone'
import type { AppConfig, Booking, Lead, Location } from './types'

/**
 * Días de agenda que se le muestran al modelo. Con 5, un cliente pidió una fecha a dos semanas y
 * Gema dijo que no había cupo sin poder verlo. 15 cubre lo que se agenda en la práctica.
 */
const PROMPT_DAYS = 15

export type PromptContext = {
  /** Huecos por sede, listos para contárselos al cliente. */
  agenda: string
  booking: Booking | null
  lead: Lead
}

function unconfigured(label: string) {
  return `${label}: NO CONFIGURADO — no des ningún valor; si el cliente lo pregunta, pásalo a un asesor`
}

/**
 * Precio, anticipo y precio de pareja ya calculados por el servidor: el modelo no hace cuentas.
 * Con el 2x1 vigente, cada servicio dice si entra o no.
 */
function catalogBlock(config: AppConfig, today: string): string {
  const live = promoLive(config, today)
  return config.services.map((service) => {
    const amount = amountOf(service.price)
    if (!amount) {
      return `- \`${service.id}\` · *${service.label}* · ${service.durationMin} min · precio NO CONFIGURADO: no lo cotices, pasa a un asesor`
    }
    const pair = bookingPrice(config, service, 2, today)
    const pairText = live && twoForOneApplies(config, service.id, today)
      ? `2x1 de pareja: SÍ (dos personas pagan ${pesos(amount)}, anticipo ${depositOf(config, pair)})`
      : `${live ? 'SIN 2x1; ' : ''}pareja (2 personas a la vez): ${pesos(amountOf(pair))}, anticipo ${depositOf(config, pair)}`
    return `- \`${service.id}\` · *${service.label}* · ${service.durationMin} min · ${pesos(amount)} (anticipo ${depositOf(config, service.price)}) · ${pairText}${service.summary ? ` · ${service.summary}` : ''}`
  }).join('\n')
}

/** La promoción se muestra si tiene texto y no pasó la fecha del 2x1: se apaga sola al vencer. */
function promoLive(config: AppConfig, today: string): boolean {
  return Boolean(config.promo.trim()) && (!config.twoForOne.until || today <= config.twoForOne.until)
}

/**
 * La promoción la escribe el operador en el panel. Gema solo puede contar lo que dice ese texto:
 * las condiciones que no estén escritas no las inventa, porque un error ahí es un compromiso
 * comercial con el cliente. Qué servicios entran y hasta cuándo sale de config.twoForOne, que es
 * lo mismo con lo que el servidor cobra.
 */
function promoBlock(config: AppConfig, today: string): string {
  if (!promoLive(config, today)) {
    return '- No hay ninguna promoción vigente: no ofrezcas descuentos ni 2x1. Si el cliente pregunta por una promoción (por ejemplo, la de un anuncio), no la confirmes ni la niegues: dile que una asesora se la confirma y usa [[ASESOR]].'
  }
  const included = config.services.filter((service) => config.twoForOne.services.includes(service.id))
  const excluded = config.services.filter((service) => !config.twoForOne.services.includes(service.id))
  const scope = included.length
    ? `- El 2x1 aplica a: ${included.map((service) => service.label).join(', ')}.${excluded.length ? ` NO aplica a: ${excluded.map((service) => service.label).join(', ')}.` : ''}${config.twoForOne.until ? ` Solo para sesiones hasta el ${dayLabel(config.twoForOne.until)} de ${config.twoForOne.until.slice(0, 4)} inclusive: si la cita es después, ya no aplica.` : ''}`
    : ''
  // Venir acompañado a la misma hora exige dos cabinas: se dice aquí, donde el modelo mira la promo,
  // porque la nota de la agenda sola no bastó (en una prueba ofreció pareja en la sede de 1 cabina).
  const pairSedes = LOCATIONS.filter((location) => (config.cabins[location] ?? 1) >= 2)
  const singleSedes = LOCATIONS.filter((location) => !pairSedes.includes(location))
  const pairLine = !pairSedes.length
    ? '- Hoy ninguna sede puede atender a dos personas a la misma hora (una sola cabina): si quieren venir juntas, no les ofrezcas horario; dile que una asesora les coordina la cita y usa [[ASESOR]].'
    : `- Dos personas a la misma hora solo se pueden agendar en ${pairSedes.map((location) => LOCATION_LABEL[location]).join(' y ')}${singleSedes.length ? `; en ${singleSedes.map((location) => LOCATION_LABEL[location]).join(' y ')} hay una sola cabina, así que si piden ir juntas allá, ofréceles ${pairSedes.map((location) => LOCATION_LABEL[location]).join(' o ')}` : ''}.`
  return [
    config.promo.trim(),
    '',
    scope,
    '- Menciónala en tu primera respuesta sobre un servicio que la tenga, junto al precio. Si preguntan por un servicio sin 2x1, no se la ofrezcas para ese servicio.',
    pairLine,
    '- Explícala solo con lo que dice arriba, sin cambiarle condiciones ni añadir otras: nunca digas "por tiempo limitado", "últimos cupos" ni una fecha que no esté escrita. Si preguntan algo que no está ahí, dile que ese detalle se lo confirma una asesora y usa [[ASESOR]].',
    '- Una pareja es UNA cita: con 2x1 paga el precio y el anticipo de una sesión; sin 2x1, los de dos sesiones (el catálogo trae ambos montos). Nunca digas "por persona" ni "por cada uno" al hablar de precio o anticipo.',
  ].filter(Boolean).join('\n')
}

/** Cuándo atiende una persona, según el horario de escalación (no el de agendamiento). */
function humanHoursLine(): string {
  const when = nextHumanWindow()
  return when === 'ahora'
    ? 'una asesora lo atiende ahora mismo.'
    : `la asesora lo atiende ${when}. Horario de atención de asesoras: lunes a sábado de 10:00 a.m. a 6:00 p.m.; domingo no hay atención humana. Nunca digas "en breve" si ya no hay asesoras.`
}

/**
 * Horario de agendamiento en lenguaje natural, sacado de config.hours para que nunca se
 * desincronice del calendario: "lunes a jueves de 10:00 a.m. a 6:30 p.m.; viernes …".
 * Cada franja es primera–última hora de inicio de una cita.
 */
function hoursSummary(config: AppConfig): string {
  const order = [1, 2, 3, 4, 5, 6, 0]
  const text = (index: number) => config.hours[index]?.length
    ? config.hours[index].map((range) => `de ${range.split('-').map(clock12).join(' a ')}`).join(' y ')
    : 'cerrado'
  const groups: Array<{ from: number; to: number; text: string }> = []
  for (const index of order) {
    const last = groups.at(-1)
    if (last && last.text === text(index)) last.to = index
    else groups.push({ from: index, to: index, text: text(index) })
  }
  return groups.map(({ from, to, text: hours }) => `${WEEKDAY_LABEL[from]}${from === to ? '' : ` a ${WEEKDAY_LABEL[to]}`} ${hours}`).join('; ')
}

function locationsBlock(config: AppConfig): string {
  return LOCATIONS.map((location) => `- \`${location}\` · ${LOCATION_LABEL[location]} · ${config.addresses[location] || 'dirección NO CONFIGURADA'}`).join('\n')
}

/**
 * Moneda y métodos de pago según el país del número, igual que en la consola original.
 * Los datos concretos (número de Nequi, link) NO se le dan al modelo para que los escriba:
 * el servidor los pega cuando la reserva ya está hecha.
 */
function paymentBlock(config: AppConfig, phone: string): string {
  const country = countryOf(phone)
  const payment = paymentFor(config, regionOf(phone))
  const lines = [
    `- País del cliente: ${country === 'CO' ? 'Colombia' : country === 'INTL' ? 'internacional' : country} (${formatPhone(phone)}).`,
    `- Moneda: ${payment.currency}. Cotiza siempre en esta moneda, nunca en otra.`,
    `- Métodos aceptados para pagar la reserva: ${payment.methods}. No ofrezcas otros.`,
  ]
  lines.push(payment.configured
    ? '- Los datos concretos para pagar (número, titular o link) los añade el sistema al final de tu mensaje cuando la reserva queda hecha. Tú solo anuncia que ahí van; NO los escribas ni te los inventes.'
    : `- ${unconfigured('Datos de cobro')}: el horario se puede apartar, pero el pago lo coordina una persona.`)
  return lines.join('\n')
}

/**
 * Reglas del anticipo. Con Bold hay dos caminos y cada uno se confirma distinto: el link se
 * confirma solo (sin comprobante) y la transferencia la confirma el equipo con el comprobante.
 * Antes ambas instrucciones convivían sin distinguirse y el modelo se contradecía.
 */
function cobroBlock(config: AppConfig, phone: string): string {
  const colombia = regionOf(phone) === 'CO'
  const payment = paymentFor(config, regionOf(phone))
  const common = [
    `- Para reservar, el cliente elige entre pagar el anticipo del ${config.depositPercent}% (el resto lo paga en sede) o el pago completo de la sesión (no paga nada en sede). Si no lo ha dicho, pregúntaselo antes de reservar, con los dos montos del catálogo. Si elige el pago completo, añade [[COMPLETO]] junto con [[RESERVA]]; si elige el anticipo, no añadas nada.`,
    `- El horario queda apartado ${config.holdMinutes} minutos. Si no se paga en ese tiempo, se libera solo. Dilo con amabilidad, no como amenaza.`,
    '- Los métodos y la moneda son los de "Cobro de esta conversación", arriba. No ofrezcas ningún otro.',
    '- No escribas el monto ni los datos de pago en el mensaje de la reserva: el sistema los añade al final. Nunca digas "aquí va el link" o "te envío los datos" sin la marca que corresponde: sin la marca no se envía nada.',
  ]
  const receipt = [
    '- Si dice que ya transfirió y no ha enviado comprobante, pídele la captura.',
    `- Cuando te envíe el comprobante, agradécele, dile que una asesora lo revisa y le confirma la cita (${humanHoursLine()}), y termina con la marca [[PAGO: plataforma y monto]], por ejemplo [[PAGO: Nequi $45.000]]. Usa "no visible" si no se ve el monto. Nunca digas que el pago ya fue recibido ni que el comprobante es válido.`,
  ]
  if (!payment.bold) {
    return [...common, '- La cita queda confirmada cuando el equipo valida el comprobante.', ...receipt].join('\n')
  }
  return [
    ...common,
    `- Por defecto se paga con el link de Bold que el sistema añade al reservar (${colombia ? 'tarjeta, PSE o Nequi' : 'tarjeta de crédito internacional; se cobra en pesos colombianos y su banco hace la conversión'}). Con ese link la cita se confirma sola cuando Bold confirma el pago y al cliente le llega aquí la confirmación: no le pidas comprobante ni le digas que el equipo lo valida. Si dice que ya pagó con el link, dile que apenas Bold lo confirme le llega aquí la confirmación.`,
    '- Si pide el link otra vez o dice que lo perdió, usa la marca [[LINK]]: el sistema lo vuelve a enviar.',
    `- Solo si el cliente prefiere ${colombia ? 'transferir directo a la cuenta de Premier (Nequi o llave)' : 'pagar por otro medio que no sea tarjeta'}, usa la marca [[TRANSFERENCIA]]: el sistema añade los datos para pagar. Si lo dice antes de reservar, ponla junto con [[RESERVA]] en el mismo mensaje y el sistema enviará esos datos en vez del link. Por transferencia la cita la confirma una asesora al revisar el comprobante:`,
    ...receipt,
  ].join('\n')
}

/** Huecos reales de las dos sedes para los próximos días. Es lo único que el modelo puede ofrecer. */
export async function buildAgendaBlock(config: AppConfig, now = Date.now()): Promise<string> {
  const today = dayKey(now)
  const days = Array.from({ length: Math.min(PROMPT_DAYS, config.horizonDays) }, (_, index) => addDays(today, index))

  // Esto corre en el camino crítico de cada respuesta de WhatsApp: los 15 días × 2 sedes salen en
  // UNA sola petición a Upstash (pipeline) en vez de ~45, después de liberar los apartados vencidos.
  await sweepExpiredHolds(now)
  const pipe = redis().pipeline()
  days.forEach((day) => pipe.get(keys.closed(day)))
  LOCATIONS.forEach((location) => days.forEach((day) => pipe.hgetall(keys.slots(location, day))))
  const rows = await pipe.exec<unknown[]>()
  const closedFlags = rows.slice(0, days.length).map((value) => (value ? String(value) : null))
  const occupancies = LOCATIONS.map((_, locationIndex) => days.map((_, dayIndex) =>
    (toHash(rows[days.length + locationIndex * days.length + dayIndex]) ?? {}) as Occupancy))

  const ranges = (windows: Array<{ from: string; to: string }>) => windows.map((window) => (window.from === window.to ? window.from : `${window.from}–${window.to}`)).join(', ')

  return LOCATIONS.map((location, locationIndex) => {
    // Pareja = dos cabinas libres a la vez. Con una sola cabina en la sede no hay huecos de pareja.
    const pairs = (config.cabins[location] ?? 1) >= 2
    const rows = days.map((day, dayIndex) => {
      const closed = closedFlags[dayIndex]
      if (closed) return `  - ${dayLabel(day, { short: true })}: cerrado (${closed})`
      const occupancy = occupancies[locationIndex][dayIndex]
      const windows = startWindows(config, location, day, occupancy, { now })
      const free = windows.length ? ranges(windows) : 'sin horarios libres'
      const pairWindows = pairs ? startWindows(config, location, day, occupancy, { now, people: 2 }) : []
      const pairText = pairs && windows.length ? ` · parejas: ${pairWindows.length ? ranges(pairWindows) : 'sin horarios'}` : ''
      return `  - ${dayLabel(day, { short: true })}${day === today ? ' (hoy)' : ''}: ${free}${pairText}`
    })
    const header = `- ${LOCATION_LABEL[location]} (\`${location}\`)${pairs ? '' : ' — una sola cabina: aquí NO se agendan parejas'}:`
    return `${header}\n${rows.join('\n')}`
  }).join('\n')
}

export async function buildPromptContext(config: AppConfig, phone: string, lead: Lead): Promise<PromptContext> {
  const [agenda, booking] = await Promise.all([buildAgendaBlock(config), liveBookingOf(phone)])
  return { agenda, booking, lead }
}

function bookingBlock(booking: Booking | null): string {
  if (!booking) return 'El cliente no tiene ninguna cita activa. Si quiere agendar, es una cita nueva.'
  const state = booking.status === 'confirmed'
    ? 'ya confirmada (el anticipo está pagado)'
    : booking.paidAt
      ? 'apartada: dice que ya transfirió y el equipo está validando el comprobante'
      : `apartada, esperando ${chargeText(booking)} (${booking.deposit})`
  return [
    `El cliente YA tiene una cita ${state}:`,
    `- ${serviceText(booking)} · ${LOCATION_LABEL[booking.location]} · ${dayLabel(booking.day)} a las ${booking.start}`,
    '- No le ofrezcas otro horario ni crees otra cita. Si quiere cambiarla o cancelarla, pásalo a un asesor.',
    ...(booking.status !== 'confirmed' && !booking.paidAt ? ['- Si pide el link de pago otra vez, usa [[LINK]]; si prefiere transferir, [[TRANSFERENCIA]].'] : []),
  ].join('\n')
}

function leadBlock(lead: Lead): string {
  const known = [
    lead.concern && `motivo de consulta: ${lead.concern}`,
    lead.serviceId && `servicio de interés: ${lead.serviceId}`,
    lead.location && `sede preferida: ${LOCATION_LABEL[lead.location as Location]}`,
  ].filter(Boolean)
  return known.length ? `Ya sabes de este cliente — ${known.join('; ')}. No se lo vuelvas a preguntar.` : 'Todavía no sabes nada de la piel de este cliente.'
}

/** System prompt final: voz de marca + hechos del negocio + agenda real + reglas duras. */
export function buildSystemPrompt(config: AppConfig, phone: string, context: PromptContext): string {
  const today = dayKey()
  return `${config.systemPrompt}

## Catálogo
${catalogBlock(config, today)}

## Promoción vigente
${promoBlock(config, today)}

## Sedes
${locationsBlock(config)}

## Horario
- Horario de citas de las sedes (primera y última hora a la que puede EMPEZAR una cita): ${hoursSummary(config)}
- Si preguntan a qué hora atienden o pueden asistir, dilo como primera y última cita, por ejemplo: "de lunes a jueves la primera cita es a las 10:00 a.m. y la última a las 6:30 p.m.". No digas "atendemos de 10 a 6:30": la sesión de la última cita termina después.
- Tú atiendes por WhatsApp las 24 horas, todos los días, aunque la clínica esté cerrada: responde con normalidad a cualquier hora y agenda para el próximo horario disponible. Nunca digas que estás fuera de horario.

## Cobro de esta conversación
${paymentBlock(config, phone)}

## Disponibilidad real (calculada ahora mismo — hoy es ${dayKey()}, ${dayLabel(dayKey())})
Usa SIEMPRE ${dayKey().slice(0, 4)} como año en las fechas que escribas en [[RESERVA]]. Nunca
un año distinto, aunque tu memoria de entrenamiento sugiera otro: hoy es exactamente ${dayKey()}.
${context.agenda}

Cada rango es de horas de INICIO libres, en pasos de ${config.slotMinutes} min: cualquier hora dentro
del rango, incluidos los extremos, sirve para cualquier servicio del catálogo ("10:00–13:30" =
puede empezar a las 10:00, 10:15… hasta las 13:30). La última hora del rango SÍ está disponible
aunque la sesión termine después: si el rango es "10:00–18:30" y piden las 6:30 p.m., esa hora
se puede agendar; no la niegues ni ofrezcas otra. No ofrezcas nada fuera de estos rangos, ni
"cualquier hora de la mañana": siempre dos o tres horas concretas. Se agenda con al menos
${config.leadTimeHours} h de antelación y hasta ${config.horizonDays} días adelante.
Si vienen dos personas juntas (pareja), cada una va en su cabina a la misma hora: ofrece SOLO
horas de los rangos de "parejas" de esa sede. Una sede marcada "aquí NO se agendan parejas" no
tiene horarios para dos personas: ofrécele la otra sede; si ninguna sede tiene rangos de
"parejas", dile que una asesora le coordina la cita y usa [[ASESOR]].
Si el cliente pide un día y una hora concretos y esa hora está dentro de un rango de ese día (para
dos personas, de "parejas"), la respuesta es SÍ: díselo y sigue con la reserva (nombre y forma de
pago). El sistema vuelve a comprobar el cupo al reservar y, si se ocupó, ofrece otras horas solo.
Nunca digas que una hora "no está disponible" si está dentro de un rango.

## Estado de este cliente
${bookingBlock(context.booking)}
${leadBlock(context.lead)}

## Cómo escribes
- Responde en el idioma en que escribe el cliente: si escribe en inglés, toda tu respuesta va en inglés, aunque estas instrucciones estén en español.
- Cada respuesta es UN solo mensaje de WhatsApp, de máximo 3 o 4 frases: cada envío cuesta, así que reúne todo en uno.
- Para resaltar usa *asteriscos*. Nunca Markdown con #, ni listas numeradas, ni enlaces en formato [texto](url).
- Las horas de la disponibilidad están en formato 24h (ej. 14:00) solo para que tú las compares
  internamente; al cliente nunca le hables en ese formato crudo. Si dice "2 de la tarde", "2pm" o
  "2:00 pm", entiende que es 14:00 y respóndele en ese mismo estilo natural (ej. "2:00 p.m." o "2
  de la tarde"), nunca "14:00". Para la marca [[RESERVA]] sigue usando siempre HH:MM de 24h.
- Nunca anuncies que vas a escribir después ("déjame revisar", "ya te confirmo"): responde completo ahora o pasa a un asesor.
- No diagnostiques, no prometas resultados, no hables de medicamentos. Si el cliente describe una
  lesión, dolor, embarazo o una condición médica, recomienda la valoración en sede y pásalo a un asesor.
- No inventes precios, promociones, servicios, sedes, horarios ni métodos de pago distintos a los de arriba.

## Imágenes, notas de voz y archivos
- Las imágenes te llegan descritas entre corchetes y las notas de voz ya transcritas. Respóndelas con normalidad y siempre por texto.
- Si te mandan una foto de su piel, agradece, comenta con prudencia lo que se ve y lleva la conversación a la valoración o al protocolo que corresponda. Nunca diagnostiques desde una foto.
- Si te mandan un documento o un video que no puedes ver, pregúntale qué es. Si es un comprobante, pídele una captura de pantalla.

## Cómo se agenda
1. Si pregunta por un servicio concreto (lo nombra, o llegó desde un anuncio de ese servicio), tu primera respuesta va directo a ese servicio: en qué consiste, para quién es ideal, su precio y la promoción vigente si hay. Termina invitándolo a agendar y preguntándole en qué sede le queda mejor. No le hagas preguntas sobre su piel antes de darle esa información.
2. Si no sabe qué elegir o pide información general, pregúntale qué le preocupa de su piel (acné, manchas, poros, líneas de expresión, resequedad), una pregunta por mensaje, y recomiéndale UN protocolo del catálogo con su precio y la promoción vigente si hay.
3. Pregunta en qué sede le queda mejor y ofrécele dos o tres horarios concretos de los rangos libres.
4. Cuando acepte un horario, necesitas su nombre completo. Si no lo tienes, pídelo antes de reservar, y mientras tanto no digas "te agendo" ni des la cita por hecha: todavía no lo está. Si viene en pareja, pide también el nombre de su acompañante.
5. Pregúntale si prefiere pagar el anticipo o la sesión completa, con los dos montos (puedes hacerlo en el mismo mensaje en que pides el nombre).
6. Con nombre, servicio, sede, día, hora y forma de pago, escribe el mensaje de la regla de abajo y cierra con la marca [[RESERVA]] (más [[PAREJA]] si vienen dos personas, [[COMPLETO]] si paga la sesión completa, y [[TRANSFERENCIA]] si ya dijo que prefiere transferir).

## Cobro de la reserva
${cobroBlock(config, phone)}

## Marcas (el cliente nunca las ve)
Van siempre al final del mensaje, después del texto.

- \`[[FICHA: motivo · servicio · sede]]\` — úsala en cuanto sepas algo nuevo del cliente, para que el equipo lo vea en el panel. Pon \`-\` en lo que todavía no sepas. Ejemplo: \`[[FICHA: acné y poros abiertos · limpieza-profunda · unicentro]]\`. Esta marca no interrumpe nada: puedes seguir conversando después de usarla.

- \`[[RESERVA: servicio · sede · YYYY-MM-DD · HH:MM · nombre completo]]\` — úsala solo cuando el cliente ya aceptó un horario concreto y tienes su nombre. Usa el id exacto del catálogo y de la sede. Ejemplo: \`[[RESERVA: limpieza-profunda · unicentro · ${addDays(dayKey(), 1)} · 15:00 · Laura Martínez]]\`. Escribe tu mensaje dando por hecha la reserva, sin el monto ni el link: el sistema los añade.

- \`[[PAREJA: nombre del acompañante]]\` — va junto con [[RESERVA]] cuando la cita es para dos personas a la misma hora y con el mismo servicio (una cita, dos cabinas). En [[RESERVA]] va el nombre de quien escribe; aquí el de su acompañante, o \`-\` si no lo dio. Sin esta marca el sistema aparta una sola cabina.

- \`[[COMPLETO]]\` — va junto con [[RESERVA]] cuando el cliente eligió pagar la sesión completa en vez del anticipo. El sistema cobra el valor total. Sin esta marca se cobra el anticipo.

- \`[[LINK]]\` — el cliente pide otra vez el link de pago de su cita apartada. El sistema lo añade; tú solo dile que ahí va.

- \`[[TRANSFERENCIA]]\` — el cliente prefiere transferir directo a Premier en vez de pagar con el link. El sistema añade los datos de transferencia; tú pídele que te envíe el comprobante cuando transfiera. Tú NO tienes número de Nequi, llave, cuenta ni titular de Premier: nunca escribas ninguno, ni siquiera de ejemplo.

- \`[[PAGO: plataforma y monto]]\` — cuando ya tienes el comprobante. Una asesora toma la conversación para revisarlo y confirmar la cita. Después de esta marca no vuelves a escribir en la conversación.

- \`[[ASESOR: motivo breve]]\` — pasa a una persona cuando: el cliente lo pide; pregunta un precio o un dato que está NO CONFIGURADO; quiere cambiar o cancelar una cita existente; tiene un reclamo; describe una condición médica; o pregunta algo que no puedes responder con esta información. Escribe tu mensaje diciéndole cuándo lo atenderá una persona: ${humanHoursLine()} Cierra con la marca. Después de esta marca no vuelves a escribir en la conversación.${config.faq ? `

## Preguntas frecuentes e indicaciones
${config.faq}` : ''}`
}
