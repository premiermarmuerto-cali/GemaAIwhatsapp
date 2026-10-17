/**
 * Construcción del system prompt. El operador controla la voz (config.systemPrompt);
 * este archivo añade los hechos y las reglas duras, que no son editables desde el panel.
 *
 * Decisión de diseño: el modelo NO llama herramientas. Recibe la disponibilidad real ya
 * calculada en el prompt y, cuando el cliente acepta un horario, lo pide con la marca
 * [[RESERVA]]. El servidor es quien aparta la cabina y quien pega el link de pago, así que
 * el modelo no puede inventarse ni un horario ni un cobro.
 */
import { addDays, clock12, dayKey, dayLabel, freeWindows, nextHumanWindow, shortestService } from './calendar'
import { LOCATION_LABEL, LOCATIONS, WEEKDAY_LABEL } from './clinic'
import { depositOf, paymentFor } from './config'
import { isClosed, liveBookingOf, occupancyOf } from './booking'
import { formatPhone, countryOf, regionOf } from './phone'
import type { AppConfig, Booking, Lead, Location } from './types'

/** Días de agenda que se le muestran al modelo. Más que esto solo gasta tokens. */
const PROMPT_DAYS = 5

export type PromptContext = {
  /** Huecos por sede, listos para contárselos al cliente. */
  agenda: string
  booking: Booking | null
  lead: Lead
}

function unconfigured(label: string) {
  return `${label}: NO CONFIGURADO — no des ningún valor; si el cliente lo pregunta, pásalo a un asesor`
}

function catalogBlock(config: AppConfig): string {
  return config.services.map((service) => {
    const price = service.price
      ? `${service.price} (anticipo ${depositOf(config, service.price)})`
      : 'precio NO CONFIGURADO: no lo cotices, pasa a un asesor'
    return `- \`${service.id}\` · *${service.label}* · ${service.durationMin} min · ${price}${service.summary ? ` · ${service.summary}` : ''}`
  }).join('\n')
}

/** Cuándo atiende una persona, con la misma regla de los horarios de agendamiento. */
function humanHoursLine(): string {
  const when = nextHumanWindow()
  return when === 'ahora'
    ? 'una asesora lo atiende ahora mismo.'
    : `la asesora lo atiende ${when}. Horario de atención de asesoras: lunes a sábado de 10:00 a.m. a 6:00 p.m.; domingo no hay atención humana. Nunca digas "en breve" si ya no hay asesoras.`
}

/**
 * Horario de agendamiento en lenguaje natural, sacado de config.hours para que nunca se
 * desincronice del calendario: "lunes a jueves 10:00 a.m.–8:30 p.m.; viernes …".
 */
function hoursSummary(config: AppConfig): string {
  const order = [1, 2, 3, 4, 5, 6, 0]
  const text = (index: number) => config.hours[index]?.length
    ? config.hours[index].map((range) => range.split('-').map(clock12).join('–')).join(' y ')
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
    `- Métodos aceptados para el anticipo: ${payment.methods}. No ofrezcas otros.`,
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
  const payment = paymentFor(config, regionOf(phone))
  const common = [
    `- Reservar exige un anticipo del ${config.depositPercent}% del valor del servicio; el resto se paga en sede.`,
    `- El horario queda apartado ${config.holdMinutes} minutos. Si no se paga en ese tiempo, se libera solo. Dilo con amabilidad, no como amenaza.`,
    '- Los métodos y la moneda son los de "Cobro de esta conversación", arriba. No ofrezcas ningún otro.',
    '- No escribas el monto del anticipo ni los datos de pago en el mensaje de la reserva: el sistema los añade al final. Nunca digas "aquí va el link" o "te envío los datos" sin la marca que corresponde: sin la marca no se envía nada.',
  ]
  const receipt = [
    '- Si dice que ya transfirió y no ha enviado comprobante, pídele la captura.',
    '- Cuando te envíe el comprobante, agradécele, dile que el equipo lo valida y le confirma la cita en breve, y termina con la marca [[PAGO: plataforma y monto]], por ejemplo [[PAGO: Nequi $45.000]]. Usa "no visible" si no se ve el monto. Nunca digas que el pago ya fue recibido ni que el comprobante es válido.',
  ]
  if (!payment.bold) {
    return [...common, '- La cita queda confirmada cuando el equipo valida el comprobante.', ...receipt].join('\n')
  }
  return [
    ...common,
    '- Por defecto el anticipo se paga con el link de Bold que el sistema añade al reservar (tarjeta, PSE o Nequi). Con ese link la cita se confirma sola cuando Bold confirma el pago y al cliente le llega aquí la confirmación: no le pidas comprobante ni le digas que el equipo lo valida. Si dice que ya pagó con el link, dile que apenas Bold lo confirme le llega aquí la confirmación.',
    '- Si pide el link otra vez o dice que lo perdió, usa la marca [[LINK]]: el sistema lo vuelve a enviar.',
    '- Solo si el cliente prefiere transferir directo a la cuenta de Premier (Nequi o llave), usa la marca [[TRANSFERENCIA]]: el sistema añade los datos de transferencia. Si lo dice antes de reservar, ponla junto con [[RESERVA]] en el mismo mensaje y el sistema enviará esos datos en vez del link. Por transferencia la cita la confirma el equipo al validar el comprobante:',
    ...receipt,
  ].join('\n')
}

/** Huecos reales de las dos sedes para los próximos días. Es lo único que el modelo puede ofrecer. */
export async function buildAgendaBlock(config: AppConfig, now = Date.now()): Promise<string> {
  const today = dayKey(now)
  const days = Array.from({ length: Math.min(PROMPT_DAYS, config.horizonDays) }, (_, index) => addDays(today, index))
  const minMinutes = shortestService(config)

  // Esto corre en el camino crítico de cada respuesta de WhatsApp: todo en paralelo.
  const [closedFlags, occupancies] = await Promise.all([
    Promise.all(days.map((day) => isClosed(day))),
    Promise.all(LOCATIONS.map((location) => Promise.all(days.map((day) => occupancyOf(location, day))))),
  ])

  return LOCATIONS.map((location, locationIndex) => {
    const rows = days.map((day, dayIndex) => {
      const closed = closedFlags[dayIndex]
      if (closed) return `  - ${dayLabel(day, { short: true })}: cerrado (${closed})`
      const windows = freeWindows(config, location, day, occupancies[locationIndex][dayIndex], { now, minMinutes })
      const free = windows.length ? windows.map((window) => `${window.from}–${window.to}`).join(', ') : 'sin horarios libres'
      return `  - ${dayLabel(day, { short: true })}${day === today ? ' (hoy)' : ''}: ${free}`
    })
    return `- ${LOCATION_LABEL[location]} (\`${location}\`):\n${rows.join('\n')}`
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
      : 'apartada, esperando el pago del anticipo'
  return [
    `El cliente YA tiene una cita ${state}:`,
    `- ${booking.serviceLabel} · ${LOCATION_LABEL[booking.location]} · ${dayLabel(booking.day)} a las ${booking.start}`,
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
  return `${config.systemPrompt}

## Catálogo
${catalogBlock(config)}

## Sedes
${locationsBlock(config)}

## Horario
- Horario de agendamiento de las sedes: ${hoursSummary(config)}
- Ese es el horario que das si preguntan a qué hora atienden o pueden asistir.
- Tú atiendes por WhatsApp las 24 horas, todos los días, aunque la clínica esté cerrada: responde con normalidad a cualquier hora y agenda para el próximo horario disponible. Nunca digas que estás fuera de horario.

## Cobro de esta conversación
${paymentBlock(config, phone)}

## Disponibilidad real (calculada ahora mismo — hoy es ${dayKey()}, ${dayLabel(dayKey())})
Usa SIEMPRE ${dayKey().slice(0, 4)} como año en las fechas que escribas en [[RESERVA]]. Nunca
un año distinto, aunque tu memoria de entrenamiento sugiera otro: hoy es exactamente ${dayKey()}.
${context.agenda}

Cada rango es cabina libre continua. Para ofrecer una hora, la sesión completa tiene que caber
dentro de un rango: una limpieza de 60 min dentro de "10:00–13:00" puede empezar a las 10:00,
10:15… hasta las 12:00, nunca a las 12:30. No ofrezcas nada fuera de estos rangos, ni "cualquier
hora de la mañana": siempre dos o tres horas concretas. Se agenda con al menos
${config.leadTimeHours} h de antelación y hasta ${config.horizonDays} días adelante.

## Estado de este cliente
${bookingBlock(context.booking)}
${leadBlock(context.lead)}

## Cómo escribes
- Responde en el idioma en que escribe el cliente.
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
1. Primero entiende la piel: pregunta qué le preocupa (acné, manchas, poros, resequedad, puntos negros) y si ya se ha hecho limpiezas antes. Una pregunta por mensaje, no un cuestionario.
2. Recomienda UN protocolo del catálogo y di su precio y su duración.
3. Pregunta en qué sede le queda mejor y ofrécele dos o tres horarios concretos de los rangos libres.
4. Cuando acepte un horario, necesitas su nombre completo. Si no lo tienes, pídelo antes de reservar, y mientras tanto no digas "te agendo" ni des la cita por hecha: todavía no lo está.
5. Con nombre, servicio, sede, día y hora, escribe el mensaje de la regla de abajo y cierra con la marca [[RESERVA]] (y [[TRANSFERENCIA]] si ya dijo que prefiere transferir).

## Cobro del anticipo
${cobroBlock(config, phone)}

## Marcas (el cliente nunca las ve)
Van siempre al final del mensaje, después del texto.

- \`[[FICHA: motivo · servicio · sede]]\` — úsala en cuanto sepas algo nuevo del cliente, para que el equipo lo vea en el panel. Pon \`-\` en lo que todavía no sepas. Ejemplo: \`[[FICHA: acné y poros abiertos · limpieza-profunda · unicentro]]\`. Esta marca no interrumpe nada: puedes seguir conversando después de usarla.

- \`[[RESERVA: servicio · sede · YYYY-MM-DD · HH:MM · nombre completo]]\` — úsala solo cuando el cliente ya aceptó un horario concreto y tienes su nombre. Usa el id exacto del catálogo y de la sede. Ejemplo: \`[[RESERVA: limpieza-profunda · unicentro · ${addDays(dayKey(), 1)} · 15:00 · Laura Martínez]]\`. Escribe tu mensaje dando por hecha la reserva, sin el monto ni el link: el sistema los añade.

- \`[[LINK]]\` — el cliente pide otra vez el link de pago de su cita apartada. El sistema lo añade; tú solo dile que ahí va.

- \`[[TRANSFERENCIA]]\` — el cliente prefiere transferir directo a Premier en vez de pagar con el link. El sistema añade los datos de transferencia; tú pídele que te envíe el comprobante cuando transfiera. Tú NO tienes número de Nequi, llave, cuenta ni titular de Premier: nunca escribas ninguno, ni siquiera de ejemplo.

- \`[[PAGO: plataforma y monto]]\` — cuando ya tienes el comprobante. Después de esta marca no vuelves a escribir en la conversación.

- \`[[ASESOR: motivo breve]]\` — pasa a una persona cuando: el cliente lo pide; pregunta un precio o un dato que está NO CONFIGURADO; quiere cambiar o cancelar una cita existente; tiene un reclamo; describe una condición médica; o pregunta algo que no puedes responder con esta información. Escribe tu mensaje diciéndole cuándo lo atenderá una persona: ${humanHoursLine()} Cierra con la marca. Después de esta marca no vuelves a escribir en la conversación.${config.faq ? `

## Preguntas frecuentes e indicaciones
${config.faq}` : ''}`
}
