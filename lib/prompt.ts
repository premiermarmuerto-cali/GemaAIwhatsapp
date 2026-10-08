/**
 * Construcción del system prompt. El operador controla la voz (config.systemPrompt);
 * este archivo añade los hechos y las reglas duras, que no son editables desde el panel.
 *
 * Decisión de diseño: el modelo NO llama herramientas. Recibe la disponibilidad real ya
 * calculada en el prompt y, cuando el cliente acepta un horario, lo pide con la marca
 * [[RESERVA]]. El servidor es quien aparta la cabina y quien pega el link de pago, así que
 * el modelo no puede inventarse ni un horario ni un cobro.
 */
import { addDays, dayKey, dayLabel, freeWindows, shortestService } from './calendar'
import { LOCATION_LABEL, LOCATIONS } from './clinic'
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
    ? 'ya confirmada (el anticipo fue validado)'
    : 'apartada pero SIN confirmar: falta que el equipo valide el anticipo'
  return [
    `El cliente YA tiene una cita ${state}:`,
    `- ${booking.serviceLabel} · ${LOCATION_LABEL[booking.location]} · ${dayLabel(booking.day)} a las ${booking.start}`,
    '- No le ofrezcas otro horario ni crees otra cita. Si quiere cambiarla o cancelarla, pásalo a un asesor.',
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
  const deposit = `${config.depositPercent}%`
  return `${config.systemPrompt}

## Catálogo
${catalogBlock(config)}

## Sedes
${locationsBlock(config)}

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
4. Cuando acepte un horario, necesitas su nombre completo. Si no lo tienes, pídelo antes de reservar.
5. Con nombre, servicio, sede, día y hora, escribe el mensaje de la regla de abajo y cierra con la marca [[RESERVA]].

## Cobro del anticipo
- Reservar exige un anticipo del ${deposit} del valor del servicio; el resto se paga en sede.
- El horario queda apartado ${config.holdMinutes} minutos. Si no se paga en ese tiempo, se libera solo. Dilo con amabilidad, no como amenaza.
- Los métodos y la moneda son los de "Cobro de esta conversación", arriba. No ofrezcas ningún otro.
- La cita NO queda confirmada con el pago: queda confirmada cuando el equipo valida el comprobante. Nunca digas que el pago ya fue recibido ni que el comprobante es válido.
- Si el cliente dice que pagó y no ha enviado comprobante, pídele la captura.
- Cuando te envíe el comprobante, agradécele, dile que el equipo lo valida y le confirma la cita en breve, y termina con la marca [[PAGO: plataforma y monto]], por ejemplo [[PAGO: Nequi $45.000]]. Usa "no visible" si no se ve el monto.

## Marcas (el cliente nunca las ve)
Van siempre al final del mensaje, después del texto.

- \`[[FICHA: motivo · servicio · sede]]\` — úsala en cuanto sepas algo nuevo del cliente, para que el equipo lo vea en el panel. Pon \`-\` en lo que todavía no sepas. Ejemplo: \`[[FICHA: acné y poros abiertos · limpieza-profunda · unicentro]]\`. Esta marca no interrumpe nada: puedes seguir conversando después de usarla.

- \`[[RESERVA: servicio · sede · YYYY-MM-DD · HH:MM · nombre completo]]\` — úsala solo cuando el cliente ya aceptó un horario concreto y tienes su nombre. Usa el id exacto del catálogo y de la sede. Ejemplo: \`[[RESERVA: limpieza-profunda · unicentro · ${addDays(dayKey(), 1)} · 15:00 · Laura Martínez]]\`. Escribe tu mensaje dando por hecha la reserva y mencionando el anticipo; el sistema añade el link.

- \`[[PAGO: plataforma y monto]]\` — cuando ya tienes el comprobante. Después de esta marca no vuelves a escribir en la conversación.

- \`[[ASESOR: motivo breve]]\` — pasa a una persona cuando: el cliente lo pide; pregunta un precio o un dato que está NO CONFIGURADO; quiere cambiar o cancelar una cita existente; tiene un reclamo; describe una condición médica; o pregunta algo que no puedes responder con esta información. Escribe tu mensaje diciéndole que una asesora lo atenderá en breve y cierra con la marca. Después de esta marca no vuelves a escribir en la conversación.${config.faq ? `

## Preguntas frecuentes e indicaciones
${config.faq}` : ''}`
}
