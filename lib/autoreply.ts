import { generateReply } from './ai'
import { chargeText, createBooking, liveBookingOf, markDepositClaimed, serviceText, setPaymentLink } from './booking'
import { clock12, dayLabel, isClock, isDayKey, nextHumanWindow } from './calendar'
import { isLocation, LOCATION_LABEL } from './clinic'
import { attachBooking, getHistory, getSummary, recordOutbound, requestAgent, saveLead } from './chats'
import { generarLinkPagoBold } from './bold'
import { amountOf, getConfig, paymentFor, resolveService } from './config'
import { mediaBusy } from './media'
import { regionOf } from './phone'
import { buildPromptContext, buildSystemPrompt } from './prompt'
import { rateLimit } from './ratelimit'
import { SEPARATOR, styleModelText, toMessages } from './reply-style'
import { keys, redis } from './redis'
import { sendWhatsAppText } from './whatsapp'
import { HOLD_STATUSES, type AppConfig, type Booking, type Location, type Message } from './types'

const HISTORY_FOR_MODEL = 30
// Mitigación para el plan Hobby de Vercel: el after() del webhook corre en segundo plano
// con un presupuesto de tiempo mucho menor al maxDuration declarado en el route (la
// plataforma lo recorta silenciosamente, sin lanzar ningún error atrapable). Estos tres
// valores se acortaron a propósito para que la cadena completa (espera + IA + envío) quepa
// dentro de esa ventana. Si se sube a un plan con más presupuesto, se pueden volver a subir.
// Espera a que el cliente termine de escribir: varios mensajes seguidos reciben una sola respuesta (cada envío se cobra).
const DEBOUNCE_MS = 1200
// Solo aplica si llega una foto o audio junto al texto; para texto puro cuesta ~0ms.
const MEDIA_WAIT_MS = 8_000
// Si la función muere a mitad de camino (timeout de la plataforma), el `finally` que
// libera este candado NO llega a correr: el chat queda bloqueado el resto del TTL sin
// que nada lo explique. Antes eran 90s de silencio total; con menos tiempo de ejecución
// real por mensaje, no hace falta tanto margen.
const LOCK_SECONDS = 20
const MAX_TURNS = 3
const BOLD_TIMEOUT_MS = 5_000
// Pausa entre los mensajes de una misma respuesta. Corta a propósito: este tiempo cuenta dentro del
// presupuesto del after() del webhook (ver nota de arriba), y una respuesta lleva hasta 4 mensajes.
const MESSAGE_GAP_MS = 1_200
const PENDING_SECONDS = 600
const PER_PHONE_LIMIT = Number(process.env.AI_MAX_REPLIES_PER_PHONE) || 15 // por cada 10 min
const GLOBAL_LIMIT = Number(process.env.AI_MAX_REPLIES_PER_HOUR) || 300

/**
 * Marcas con las que Gema actúa sobre el sistema; el cliente nunca las ve.
 *   FICHA   datos del prospecto (no interrumpe la conversación)
 *   RESERVA aparta la cabina y dispara el cobro del anticipo
 *   LINK    reenvía el link de pago de la cita apartada
 *   TRANSFERENCIA  datos para transferir a Premier en vez del link (se valida con comprobante)
 *   PAREJA  acompaña a RESERVA: la cita es para dos personas a la vez (2x1), dos cabinas
 *   COMPLETO acompaña a RESERVA: el cliente paga la sesión completa en vez del anticipo
 *   PAGO    llegó el comprobante → una persona lo valida
 *   ASESOR  todo lo demás que necesita una persona
 */
const MARKERS = /\[\[\s*(ASESOR|PAGO|RESERVA|FICHA|LINK|TRANSFERENCIA|PAREJA|COMPLETO)\s*(?::([^\]]*))?\]\]/gi

// Frases con las que el modelo a veces da una cita por hecha sin haber emitido [[RESERVA]].
const SOUNDS_BOOKED = /\b(te (agend|reserv)[eoé]|qued[oóa]s?\s+agendad|cita\s+qued[oó]|confirmo\s+tu\s+cita|ya\s+(est[aá]s?|qued[oó])\s+reservad)/i
// Frases con las que promete un link sin emitir [[LINK]] (pasó en una prueba real: "Aquí va el
// link" y el mensaje salía sin link). Si hay una cita apartada, el sistema lo reenvía igual.
const PROMISES_LINK = /(aqu[ií]\s+(va|tienes|est[aá]|te\s+(dejo|env[ií]o|paso))|te\s+(env[ií]o|enviar[eé]|mando|paso|comparto|dejo))[^.\n]{0,25}\b(link|enlace)\b/i
// Datos de pago escritos por el modelo: secuencias de 7+ dígitos (teléfonos, cuentas), titulares
// o cuentas bancarias. Nunca los tiene, así que si aparecen son inventados (pasó en una prueba:
// dio el teléfono del propio cliente como "número de Nequi"). Los precios usan puntos y no coinciden.
const PAYMENT_DATA_LIKE = /\d(?:[ -]?\d){6,}|\btitular\b|\bcuenta\s+(de\s+)?(ahorros|corriente)\b/i

/** Quita del texto del modelo las líneas con datos de pago inventados. Solo se aplica a lo que escribió el modelo. */
function stripInventedPaymentData(phone: string, text: string): string {
  const lines = text.split('\n')
  const kept = lines.filter((line) => !PAYMENT_DATA_LIKE.test(line))
  if (kept.length === lines.length) return text
  console.warn(`[autoreply] Gema escribió datos de pago para ${phone}; se quitaron ${lines.length - kept.length} línea(s)`)
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
const RESERVA_NUDGE = 'Tu respuesta anterior dio la cita por hecha pero NO incluyó la marca [[RESERVA: servicio · sede · YYYY-MM-DD · HH:MM · nombre completo]]. Sin esa marca el sistema no aparta ningún horario. Vuelve a escribir tu respuesta completa incluyendo la marca (más [[PAREJA: nombre]], [[COMPLETO]] o [[TRANSFERENCIA]] si corresponden). Si todavía te falta algún dato para reservar, pídelo en vez de dar la cita por hecha.'

/** La respuesta da la cita por hecha (o pide datos de pago/pareja) sin la marca de reserva, y el cliente no tiene cita. */
function forgotReserva(reply: string, bookingId: string | undefined): boolean {
  if (bookingId) return false
  const found = [...reply.matchAll(MARKERS)].map((marker) => marker[1].toUpperCase())
  if (found.includes('RESERVA') || found.includes('ASESOR') || found.includes('PAGO')) return false
  const plain = reply.replace(MARKERS, '')
  return (SOUNDS_BOOKED.test(plain) && !ASKS_FOR_NAME.test(plain)) || found.some((kind) => ['TRANSFERENCIA', 'PAREJA', 'COMPLETO'].includes(kind))
}

// Montos en pesos escritos por el modelo ("$340.000", "$85.000 COP por persona").
const AMOUNT = /\$\s?\d[\d.,]*/

/**
 * En el mensaje de una reserva el monto lo pone el servidor (sale de la cita creada). El modelo
 * igual escribía montos, a veces mal: "$340.000" por una pareja con 2x1 que paga $170.000. Se
 * quitan las frases del modelo con montos; el servidor añade el correcto después.
 */
function stripModelAmounts(phone: string, text: string): string {
  let removed = 0
  const parts = text.split(SEPARATOR).map((part) => {
    const sentences = part.split(/(?<=[.!?])\s+|\n+/)
    const kept = sentences.filter((sentence) => !AMOUNT.test(sentence))
    removed += sentences.length - kept.length
    return kept.join(' ').replace(/\s{2,}/g, ' ').trim()
  })
  if (!removed) return text
  console.warn(`[autoreply] Gema escribió montos en la reserva de ${phone}; se quitaron ${removed} frase(s)`)
  return parts.filter(Boolean).join(SEPARATOR)
}

// Lo que dice un cliente que quiere transferir en vez de usar el link. [[TRANSFERENCIA]] solo se
// respeta si lo dijo: en una prueba el modelo la añadió sola y el cliente habría recibido datos
// de transferencia en vez del link de Bold.
const WANTS_TRANSFER = /transf|consign|nequi|daviplata|bancolombia|llave|bre-?b|cuenta|zelle|wise|paypal|binance|other (method|way)|otro (medio|m[eé]todo)/i

// Promete que "una asesora te confirma / te contacta" sin emitir [[ASESOR]]: nadie se entera y el
// cliente queda esperando (pasó en una prueba con una pregunta sobre una promoción).
const ADVISOR_VERB = '(confirma|contacta|escribe|atiende|ayuda|responde|comparte|env[ií]a|explica)'
const PROMISES_ADVISOR = new RegExp(
  // En singular: "nuestras asesoras te atienden de lunes a sábado" es informar el horario, no prometer.
  `\\b(una|la|nuestra)\\s+asesora\\s+(te|le|lo|la|se\\s+lo|se\\s+la)\\s+${ADVISOR_VERB}|\\b(te|se\\s+lo|se\\s+la)\\s+${ADVISOR_VERB}\\s+(una|la|nuestra)\\s+asesora`,
  'i',
)
// Si en el mismo mensaje pide el nombre, todavía no está reservando: le faltan datos, y eso es correcto.
const ASKS_FOR_NAME = /\b(tu|su)\s+nombre\b/i

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Firma de sendWhatsAppText: se puede inyectar otra (p. ej. scripts/simulate-chat.ts) para probar sin llamar a Meta. */
export type SendFn = (to: string, body: string) => Promise<string | undefined>

/** El webhook lo llama tras guardar un mensaje del cliente que merece respuesta. */
export async function markPendingReply(phone: string) {
  await redis().set(keys.replyPending(phone), '1', { ex: PENDING_SECONDS })
}

/**
 * Atiende los mensajes pendientes de un chat. Un solo turno de IA a la vez por chat (lock);
 * quien no consigue el lock no hace nada, porque el dueño del lock vuelve a mirar los pendientes antes de salir.
 */
export async function autoReply(phone: string, depth = 0) {
  const db = redis()
  const lockKey = keys.replyLock(phone)
  const lockId = crypto.randomUUID()
  if (!(await db.set(lockKey, lockId, { nx: true, ex: LOCK_SECONDS }))) return

  try {
    if (depth === 0) await sleep(DEBOUNCE_MS)
    // Una foto o un audio del mismo turno todavía se está analizando: se responde cuando Gema ya lo entienda.
    for (const until = Date.now() + MEDIA_WAIT_MS; Date.now() < until && await mediaBusy(phone);) await sleep(1000)
    for (let turn = 0; turn < MAX_TURNS && await db.getdel(keys.replyPending(phone)); turn++) {
      await db.expire(lockKey, LOCK_SECONDS)
      await replyOnce(phone)
    }
  } finally {
    if (await db.get(lockKey) === lockId) await db.del(lockKey)
  }

  // Un mensaje que llegó justo entre la última revisión y la liberación del lock no puede quedar sin respuesta.
  if (depth < 2 && await db.exists(keys.replyPending(phone))) await autoReply(phone, depth + 1)
}

type Parsed = { servicio: string; sede: string; day: string; start: string; name: string }

/** `servicio · sede · YYYY-MM-DD · HH:MM · nombre` → campos sueltos. */
function parseReserva(payload: string): Parsed | null {
  const parts = payload.split('·').map((part) => part.trim())
  if (parts.length < 4) return null
  const [servicio, sede, day, start, ...rest] = parts
  if (!isDayKey(day) || !isClock(start)) return null
  return { servicio: servicio.toLowerCase(), sede: sede.toLowerCase(), day, start, name: rest.join(' · ').slice(0, 80) }
}

/** `motivo · servicio · sede`, con `-` para lo que no se sabe. */
function parseFicha(payload: string) {
  const [concern, serviceId, location] = payload.split('·').map((part) => part.trim())
  const clean = (value: string | undefined) => (value && value !== '-' ? value : '')
  return { concern: clean(concern), serviceId: clean(serviceId).toLowerCase(), location: clean(location).toLowerCase() as Location | '' }
}

/**
 * Intenta la reserva que pidió el modelo y devuelve lo que hay que añadir al mensaje.
 * Nunca devuelve el link si la cabina no quedó apartada: así el cliente no paga por un horario que no existe.
 */
/** `summary`: confirmación compuesta por el servidor, por si al texto del modelo no le queda nada. */
type Applied = { append: string; replaceText?: string; escalate?: string; summary?: string }

/** "Listo, Laura: tu cita de *X* queda apartada para el lunes 19 oct a las 6:30 p.m. en Chipichape." */
function bookedLine(booking: Booking): string {
  const firstName = booking.name.split(' ')[0]
  return `Listo${firstName ? `, ${firstName}` : ''}: tu cita de *${serviceText(booking)}* queda apartada para el ${dayLabel(booking.day)} a las ${clock12(booking.start)} en ${LOCATION_LABEL[booking.location]}.`
}

/** "ahora" o "mañana a las 10:00 a.m.": cuándo atiende una persona, con el mismo horario de agendamiento. */
export function humanWhen(): string {
  const when = nextHumanWindow()
  return when === 'ahora' ? 'en este momento' : `${when}`
}

/** Minutos que le quedan al apartado, para decírselo al cliente al reenviar datos de pago. */
function holdMinutesLeft(booking: Booking): number {
  return Math.max(0, Math.round((booking.holdUntil - Date.now()) / 60_000))
}

/**
 * El cliente prefiere transferir directo a Premier (Nequi o llave) en vez del link: el servidor
 * pega los datos de la configuración y la cita la confirma el operador al validar el comprobante.
 */
function transferAppend(config: AppConfig, booking: Booking): Applied {
  const data = paymentFor(config, regionOf(booking.phone)).instructions
  if (!data) {
    return {
      append: `\n\nUna asesora te comparte los datos para transferir ${humanWhen()}`,
      escalate: `La clienta quiere pagar ${chargeText(booking)} (${booking.deposit}) de la cita ${booking.id} por transferencia, pero los datos de transferencia no están configurados`,
    }
  }
  const deposit = booking.deposit ? ` de ${booking.deposit}` : ''
  return {
    append: `\n\nPuedes transferir ${chargeText(booking)}${deposit} a:\n${data}\nTu horario sigue apartado ${holdMinutesLeft(booking)} minutos. Cuando transfieras, mándame aquí la captura del comprobante y una asesora lo revisa`,
  }
}

/**
 * La descripción de un comprobante entre los últimos mensajes del cliente (los que esta respuesta
 * contesta). El análisis de imágenes (lib/ai.ts) empieza esas descripciones con "Comprobante de pago".
 */
function receiptNote(history: Message[]): string {
  for (let index = history.length - 1; index >= 0 && history[index].sender === 'user'; index--) {
    const media = history[index].media
    if (media?.kind === 'image' && media.status === 'ready' && /^\s*comprobante de pago/i.test(media.note ?? '')) return media.note ?? ''
  }
  return ''
}

/** Con qué se paga el link de Bold según el país: fuera de Colombia, solo tarjeta y en pesos. */
function linkMethods(phone: string): string {
  return regionOf(phone) === 'CO' ? 'con tarjeta, PSE o Nequi' : 'con tarjeta de crédito (se cobra en pesos colombianos; tu banco hace la conversión)'
}

/** Link de Bold por lo que la cita debe pagar para reservar (anticipo o total), que vence con el apartado. */
async function boldLinkFor(booking: Booking): Promise<string> {
  const amount = amountOf(booking.deposit)
  if (!amount) return ''
  const concept = `${booking.paymentPlan === 'full' ? 'Pago' : 'Anticipo'} ${serviceText(booking)}`
  return (await generarLinkPagoBold(amount, concept, booking.id, { timeoutMs: BOLD_TIMEOUT_MS, expiraEn: booking.holdUntil })) || ''
}

/**
 * Reenvía el link de Bold de la cita apartada. Si la cita no lo tiene (Bold falló al reservar, o
 * la creó un operador) se genera uno nuevo que vence con el apartado.
 * `implicit`: Gema prometió el link sin la marca; si no hay cita apartada, no se hace nada.
 */
async function resendLink(config: AppConfig, phone: string, { implicit = false } = {}): Promise<Applied> {
  const booking = await liveBookingOf(phone)
  if (!booking || !HOLD_STATUSES.includes(booking.status)) {
    return implicit ? { append: '' } : { append: '', escalate: 'Gema quiso reenviar un link de pago, pero no hay una cita apartada' }
  }
  let url = booking.paymentLink
  if (!url && paymentFor(config, regionOf(phone)).bold) {
    url = await boldLinkFor(booking)
    if (url) await setPaymentLink(booking.id, url)
  }
  if (!url) {
    return {
      append: `\n\nUna asesora te envía el link de pago ${humanWhen()}`,
      escalate: `La clienta pidió el link de pago de la cita ${booking.id}, pero no hay ninguno para reenviar`,
    }
  }
  const deposit = booking.deposit ? ` de ${booking.deposit}` : ''
  return { append: `\n\nAquí tienes el link para pagar ${chargeText(booking)}${deposit} ${linkMethods(phone)}:\n${url}\nTu horario sigue apartado ${holdMinutesLeft(booking)} minutos.` }
}

/** Pareja: `companion` es el nombre del acompañante ('' si no lo dio). null = cita individual. */
export async function applyReserva(
  config: AppConfig,
  phone: string,
  payload: string,
  { transfer = false, companion = null as string | null, payFull = false } = {},
): Promise<Applied> {
  const parsed = parseReserva(payload)
  if (!parsed) {
    console.warn(`[autoreply] marca RESERVA ilegible para ${phone}: "${payload}"`)
    return { append: '', escalate: 'Gema intentó agendar con datos incompletos' }
  }

  const service = resolveService(config, parsed.servicio)
  if (!service) return { append: '', escalate: `Gema pidió un servicio que no existe: "${parsed.servicio}"` }
  if (!isLocation(parsed.sede)) return { append: '', escalate: `Gema pidió una sede que no existe: "${parsed.sede}"` }
  if (!service.price) return { append: '', escalate: `El precio de ${service.label} no está configurado` }

  // Una sola cita viva por cliente, impuesta aquí y no solo pedida en el prompt: el modelo ya
  // agendó una segunda (con su segundo link de cobro) pese a la instrucción. El mensaje de Gema
  // dio la reserva por hecha, así que se reemplaza entero en vez de añadirle una corrección.
  const existing = await liveBookingOf(phone)
  if (existing) {
    const state = existing.status === 'confirmed' ? 'confirmada' : 'apartada'
    return {
      append: '',
      replaceText: `Ya tienes una cita ${state}: *${serviceText(existing)}* el ${dayLabel(existing.day)} a las ${clock12(existing.start)} en ${LOCATION_LABEL[existing.location]}. Si quieres cambiarla o agendar otra, una asesora te ayuda ${humanWhen()}`,
      escalate: `La clienta pidió otra cita teniendo la ${existing.id} (${existing.day} ${existing.start}) ${state}`,
    }
  }

  const chat = await getSummary(phone)
  const pair = companion !== null
  const result = await createBooking(config, {
    phone,
    name: parsed.name || chat?.name || '',
    location: parsed.sede,
    serviceId: service.id,
    day: parsed.day,
    start: parsed.start,
    concern: chat?.lead.concern ?? '',
    notes: pair ? `Pareja 2x1 · acompañante: ${companion || 'sin nombre'}` : '',
    source: 'bot',
    people: pair ? 2 : 1,
    payFull,
  })

  if (!result.ok) {
    if (result.reason === 'cabins') {
      return {
        append: `\n\nEn ${LOCATION_LABEL[parsed.sede]} no podemos atender a dos personas a la misma hora; una asesora te ayuda a coordinarlo ${humanWhen()}`,
        escalate: `Pareja 2x1 pedida en ${LOCATION_LABEL[parsed.sede]}, que tiene una sola cabina configurada`,
      }
    }
    if (result.reason === 'taken') {
      const options = result.alternatives.slice(0, 4)
      return {
        append: options.length
          ? `\n\nEse horario se acaba de ocupar, justo alguien lo tomó. Para ${dayLabel(parsed.day)} en ${LOCATION_LABEL[parsed.sede]} me quedan: ${options.join(', ')}\n\ncuál te sirve?`
          : '\n\nEse horario se acaba de ocupar y ese día ya no me queda espacio\n\nte busco otro día?',
      }
    }
    if (result.reason === 'closed') return { append: `\n\nEse día la sede está cerrada, te busco otra fecha?` }
    return { append: '', escalate: 'No se pudo crear la cita' }
  }

  const { booking } = result
  await attachBooking(phone, booking.id, { name: booking.name, serviceId: booking.serviceId, location: booking.location })

  // El cobro lo escribe el servidor, nunca el modelo: los datos salen de la config,
  // según el país del número (misma lógica por región que la consola original).
  // El cliente ya dijo que prefiere transferir: datos de transferencia en vez del link. El mensaje
  // lo compone el servidor entero, porque en este paso el modelo tiende a inventarse los datos.
  if (transfer) {
    const result = transferAppend(config, booking)
    return { ...result, replaceText: `${bookedLine(booking)}${result.append}` }
  }

  const payment = paymentFor(config, regionOf(phone))
  if (!payment.configured) {
    return { append: '', escalate: `Cita ${booking.id} apartada, pero los datos de cobro de ${regionOf(phone)} no están configurados` }
  }

  const deposit = booking.deposit ? ` de ${booking.deposit}` : ''

  // Link único de Bold con el id de la cita como referencia: así el webhook sabe qué cita
  // confirmar cuando llega el pago. Timeout corto porque esto corre dentro del after() del
  // webhook de WhatsApp, que en el plan Hobby tiene poco margen (ver lib/autoreply.ts arriba).
  // El link vence junto con el apartado: así nadie puede pagar un horario que ya se liberó.
  const boldUrl = payment.bold ? await boldLinkFor(booking) : ''
  if (boldUrl) {
    // Se guarda en la cita para poder reenviarlo si el cliente lo pierde ([[LINK]]).
    await setPaymentLink(booking.id, boldUrl)
    return {
      summary: bookedLine(booking),
      append: `\n\nPara dejarla reservada necesitamos ${chargeText(booking)}${deposit}. Puedes pagarlo aquí ${linkMethods(phone)}:\n${boldUrl}\nTu horario queda apartado ${config.holdMinutes} minutos y apenas se confirme el pago te aviso por aquí`,
    }
  }

  // Sin link de Bold (no aplica, o Bold falló): datos fijos de la configuración, con comprobante.
  const how = [
    config.payLink && `Link de pago: ${config.payLink}`,
    payment.instructions,
  ].filter(Boolean).join('\n')
  if (!how) {
    return {
      append: `\n\nNo pude generar tu link de pago en este momento; una asesora te lo envía ${humanWhen()}.`,
      escalate: `Cita ${booking.id} apartada, pero no se pudo generar el link de Bold y no hay datos de cobro de respaldo`,
    }
  }
  return {
    summary: bookedLine(booking),
    append: `\n\nPara dejarla reservada necesitamos ${chargeText(booking)}${deposit}.\n${how}\nTu horario queda apartado ${config.holdMinutes} minutos. Cuando pagues, mándame el comprobante por aquí`,
  }
}

/**
 * Un turno de IA para un chat. Exportada (no solo de uso interno) para que
 * scripts/simulate-chat.ts pueda correr la misma lógica inyectando un `send` falso.
 */
export async function replyOnce(phone: string, { send = sendWhatsAppText }: { send?: SendFn } = {}) {
  const chat = await getSummary(phone)
  if (!chat?.botActive) return

  // Protecciones contra gasto de cuota: si se superan, el chat pasa a una persona en vez de quedar sin respuesta.
  if (!(await rateLimit('ai-phone', phone, PER_PHONE_LIMIT, 600)).ok) {
    console.warn(`[autoreply] ${phone} superó ${PER_PHONE_LIMIT} respuestas/10 min`)
    return requestAgent(phone, 'Demasiados mensajes seguidos: Gema se pausó para cuidar la cuota')
  }
  if (!(await rateLimit('ai-global', 'all', GLOBAL_LIMIT, 3600)).ok) {
    console.warn(`[autoreply] tope global de ${GLOBAL_LIMIT} respuestas/hora alcanzado`)
    return requestAgent(phone, 'Se alcanzó el tope de respuestas de IA por hora')
  }

  const config = await getConfig()
  const prompt = buildSystemPrompt(config, phone, await buildPromptContext(config, phone, chat.lead))
  let reply: string | null = null
  let answeredUpTo = chat.lastInboundAt
  let history: Message[] = []
  for (let draft = 0; draft < 2; draft++) {
    history = await getHistory(phone, HISTORY_FOR_MODEL)
    try {
      reply = await generateReply(prompt, history).catch((error) => {
        console.warn(`[autoreply] reintentando ${phone}:`, error instanceof Error ? error.message : error)
        return generateReply(prompt, history)
      })
    } catch (error) {
      console.error(`[autoreply] Gema no pudo responder a ${phone}:`, error)
      return requestAgent(phone, 'Gema no pudo generar una respuesta')
    }
    if (!reply) return

    // El operador pudo tomar el control mientras el modelo respondía.
    const latest = await getSummary(phone)
    if (!latest?.botActive) return
    // Si el cliente escribió mientras el modelo pensaba, se rehace una vez para responder todo en un solo mensaje.
    if (latest.lastInboundAt <= answeredUpTo) break
    answeredUpTo = latest.lastInboundAt
  }
  if (!reply) return

  // El modelo a veces escribe "te agendo" y manda [[TRANSFERENCIA]] sin la marca [[RESERVA]]: sin ella
  // no se aparta nada. Se le pide una sola vez que la incluya; si aun así falta, actúa la red de abajo.
  if (forgotReserva(reply, chat.bookingId)) {
    console.warn(`[autoreply] ${phone}: el modelo dio la cita por hecha sin [[RESERVA]]; se reintenta`)
    reply = await generateReply(prompt, history, RESERVA_NUDGE).catch(() => null) ?? reply
  }

  const markers = [...reply.matchAll(MARKERS)].map((marker) => ({ kind: marker[1].toUpperCase(), payload: (marker[2] ?? '').trim() }))
  // Lo que viene del modelo pasa por la red de datos de pago; lo que añade el servidor después, no.
  // Después se parte en mensajes (|||) y se le da la puntuación de WhatsApp; los textos del servidor
  // se unen con el mismo separador y viajan enteros.
  let text = styleModelText(stripInventedPaymentData(phone, reply.replace(MARKERS, '').trim()))

  // FICHA es silenciosa: solo enriquece el panel y el prompt de la próxima vuelta.
  const ficha = markers.find((marker) => marker.kind === 'FICHA')
  if (ficha) await saveLead(phone, parseFicha(ficha.payload))

  // La reserva se intenta antes de enviar: el texto que sale ya refleja lo que de verdad pasó.
  let escalation = markers.find((marker) => marker.kind === 'PAGO') ?? markers.find((marker) => marker.kind === 'ASESOR')
  const reserva = markers.find((marker) => marker.kind === 'RESERVA')
  const clientSaid = history.filter((message) => message.sender === 'user').slice(-6).map((message) => message.text).join(' ')
  const transfer = markers.some((marker) => marker.kind === 'TRANSFERENCIA') && WANTS_TRANSFER.test(clientSaid)
  if (reserva) text = stripModelAmounts(phone, text)
  const pareja = markers.find((marker) => marker.kind === 'PAREJA')
  const payFull = markers.some((marker) => marker.kind === 'COMPLETO')
  const link = markers.some((marker) => marker.kind === 'LINK')
  let applied: Applied | null = null
  if (reserva) {
    const companion = pareja ? (pareja.payload === '-' ? '' : pareja.payload.slice(0, 80)) : null
    applied = await applyReserva(config, phone, reserva.payload, { transfer, companion, payFull })
  } else if (transfer) {
    // El mensaje lo compone entero el servidor: el texto del modelo en este paso es justo donde
    // tiende a inventarse números y titulares.
    const booking = await liveBookingOf(phone)
    const result = booking && HOLD_STATUSES.includes(booking.status)
      ? transferAppend(config, booking)
      : { append: `\n\nUna asesora te ayuda con la transferencia ${humanWhen()}`, escalate: 'La clienta quiere transferir, pero no hay una cita apartada' }
    applied = { ...result, replaceText: `Claro${result.append}` }
  } else if (link || PROMISES_LINK.test(text)) {
    applied = await resendLink(config, phone, { implicit: !link })
  }
  if (applied) {
    // Lo del servidor (el link, las cuentas, los montos) va en su propio mensaje y nunca se parte:
    // los "\n\n" que separan sus bloques pasan a ser separadores de mensaje.
    const server = (value: string) => value.trim().replace(/\n\n/g, SEPARATOR)
    text = applied.replaceText !== undefined
      ? server(applied.replaceText)
      : [text || applied.summary || '', server(applied.append)].filter(Boolean).join(SEPARATOR)
    if (applied.escalate) escalation = { kind: 'ASESOR', payload: applied.escalate }
  }

  // Red de seguridad: el modelo a veces "confirma" una cita en el texto sin emitir [[RESERVA]].
  // Sin esto el cliente se queda creyendo que tiene un horario que el sistema nunca creó, y
  // nadie se entera. Mejor escalar a una persona que dejar pasar una confirmación fantasma.
  if (!reserva && !escalation && !chat.bookingId && SOUNDS_BOOKED.test(text) && !ASKS_FOR_NAME.test(text)) {
    escalation = { kind: 'ASESOR', payload: 'Gema pareció confirmar una cita sin generar la marca de reserva' }
    // El texto del modelo daba la cita por hecha (y a veces traía "[datos de Nequi aquí]" de
    // relleno): se cambia por uno honesto, porque la cita todavía no existe.
    text = `Gracias, ya tengo tus datos${SEPARATOR}Una asesora termina de agendar tu cita y te comparte cómo pagar ${humanWhen()}`
  }
  // Lo mismo con una asesora prometida sin escalar: la promesa se cumple escalando.
  if (!escalation && PROMISES_ADVISOR.test(text)) {
    escalation = { kind: 'ASESOR', payload: `Gema le dijo al cliente que una asesora lo contacta: "${text.slice(0, 120)}"` }
  }

  // Comprobante en imagen: pasa a una asesora aunque el modelo no haya puesto [[PAGO]]. Premier
  // quiere que todo pago por transferencia lo revise una persona. Si la cita ya está confirmada
  // (Bold la confirmó sola), no hace falta.
  const receipt = receiptNote(history)
  if (receipt && escalation?.kind !== 'PAGO' && (await liveBookingOf(phone))?.status !== 'confirmed') {
    escalation = { kind: 'PAGO', payload: `Comprobante recibido: ${receipt.replace(/\s+/g, ' ').slice(0, 160)}` }
  }

  // El cliente dice que pagó: el horario no se puede caer mientras el operador revisa.
  if (escalation?.kind === 'PAGO' && chat.bookingId) await markDepositClaimed(chat.bookingId, config)

  // Cada mensaje sale por separado, con una pausa corta entre uno y otro como si alguien escribiera.
  // Todos van dentro de la ventana de 24 h (la respuesta a un mensaje del cliente), así que no cuestan más.
  const messages = toMessages(text)
  for (const [index, message] of messages.entries()) {
    try {
      if (index > 0) await sleep(MESSAGE_GAP_MS)
      const waId = await send(phone, message)
      await recordOutbound(phone, { id: waId ?? crypto.randomUUID(), sender: 'gem', text: message, at: Date.now() })
    } catch (error) {
      console.error(`[autoreply] WhatsApp rechazó la respuesta a ${phone}:`, error)
      // El motivo real (token vencido, número no autorizado en modo desarrollo, etc.) se
      // muestra en el panel: así el operador no depende de revisar logs del servidor.
      const detail = error instanceof Error ? error.message : String(error)
      return requestAgent(phone, `WhatsApp rechazó el envío: ${detail}`)
    }
  }
  if (escalation) await requestAgent(phone, escalation.payload, escalation.kind === 'PAGO' ? 'payment' : 'help')
}
