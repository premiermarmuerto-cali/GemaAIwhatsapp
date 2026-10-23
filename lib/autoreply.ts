import { extractReserva, generateReply, type ExtractedReserva } from './ai'
import { annotateBooking, bookingsOfPhone, chargeText, confirmAttendance, createBooking, liveBookingOf, markDepositClaimed, moveBooking, rescheduleBooking, serviceText, setPaymentLink } from './booking'
import { addDays, clock12, dayKey, dayLabel, isClock, isDayKey, nextHumanWindow, toClock, toMinutes } from './calendar'
import { isLocation, LOCATION_LABEL, LOCATIONS, MONTH_NAME } from './clinic'
import { attachBooking, getHistory, getSummary, markChatAuto, noteForTeam, recordOutbound, requestAgent, saveContactPhone, saveLead, setObjection, updateChat } from './chats'
import { trackConversion } from './conversions'
import { generarLinkPagoBold } from './bold'
import { amountOf, getConfig, paymentFor, pesos, resolveService, twoForOneApplies } from './config'
import { mediaBusy } from './media'
import { isWhatsAppUserId, regionOf } from './phone'
import { rescheduleTeamBooking, teamBookingOf, updateBookingDetails } from './booking'
import { buildPromptContext, buildSystemPrompt, promoLive } from './prompt'
import { rateLimit } from './ratelimit'
import { insertAfter, SEPARATOR, styleModelText, toMessages } from './reply-style'
import { keys, redis } from './redis'
import { sendWhatsAppImage, sendWhatsAppText } from './whatsapp'
import { buildWelcome, needsAnswerAfterWelcome, WELCOME_KIND, type Welcome } from './welcome'
import { askedSlot, availabilityNote } from './availability-note'
import { isOptOut } from './optout'
import { preferencesFrom } from './preferences'
import { renderPreset } from './presets'
import { bumpRev } from './revision'
import { HOLD_STATUSES, type AppConfig, type Booking, type ChatSummary, type Location, type Message } from './types'

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
// Un mensaje que se responde más de 30 min después de escrito (entrega tardía de Meta, caída): Gema se disculpa.
const LATE_REPLY_MS = 30 * 60_000
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
 *   REPROGRAMAR mueve la cita viva a otro día/hora/sede conservando el pago
 *   CANCELAR    cancela la cita viva y libera el cupo; si estaba pagada, una persona hace el reembolso
 *   ASISTE  el cliente confirmó que asiste a su cita
 *   PAGO    llegó el comprobante → una persona lo valida
 *   EFECTIVO insiste en pagar todo en la sede, sin anticipo → Johanna decide si hace la excepción
 *           (si nadie responde en 30 min, Gema retoma: ver cashRetakes en lib/automations.ts)
 *   ASESOR  todo lo demás que necesita una persona
 */
const MARKERS = /\[\[\s*(ASESOR|PAGO|EFECTIVO|RESERVA|FICHA|LINK|TRANSFERENCIA|PAREJA|COMPLETO|REPROGRAMAR|CANCELAR|ASISTE)\s*(?::([^\]]*))?\]\]/gi

// El cliente quiere pagar en efectivo o en la sede: la objeción que más frena la venta (VIRAND, 19 oct).
// 20 oct: una clienta escribió "pago cuando llegue" y no se reconoció; ahora cubre "al llegar",
// "en el lugar", "en físico", "allá mismo" y similares.
const SAYS_CASH = /\befectivo\b|\bcash\b|contra\s*entrega|\ben\s+f[ií]sico\b|\bpag(o|ar|amos|ar[ií]a|ue|uemos)\b[^.?!\n]{0,30}?\b(all[aá]|ah[ií]\s+mismo|al\s+llegar|cuando\s+llegue|el\s+d[ií]a\s+de\s+la\s+cita|en\s+(el\s+|la\s+)?(local|sede|cl[ií]nica|cabina|sitio|lugar|establecimiento|spa|centro\s+comercial|persona))(?![a-záéíóúñ])/i
// "el resto lo pago allá": acepta el anticipo y pregunta por el saldo; no es pagar todo en efectivo.
const CASH_REMAINDER = /\b(resto|saldo|lo\s+dem[aá]s|diferencia|restante|lo\s+que\s+falta)\b/i
/** Pide pagar todo en efectivo o en la sede (no solo el saldo después del anticipo). */
export const saysCash = (text: string) => SAYS_CASH.test(text) && !CASH_REMAINDER.test(text)
/** Motivo con el que el chat pasa a Johanna; lib/automations.ts lo reconoce para retomar a los 30 min. */
/** Gema habla de cobrar: en una cita que agendó un asesor, eso no le toca (ver teamBookingOf). */
const TALKS_PAYMENT = /\b(anticipo|abono|link (de|para) pag\w*|pagar|pago|transferencia|transferir|nequi|bancolombia|daviplata|comprobante)\b/i

/** El cliente nombra una hora ("a las 11", "2 pm", "11:30") o elige una de las ofrecidas ("esa", "la primera"). */
const PICKS_TIME = /\b\d{1,2}(:\d{2})?\s*(a\.?\s?m\.?|p\.?\s?m\.?|am|pm|h)?\b|\b(esa|ese horario|la primera|la segunda|la [uú]ltima|mediod[ií]a)\b/i

export const CASH_REASON ='Pago en efectivo: quiere pagar todo en la sede, sin anticipo'

// Frases con las que el modelo a veces da una cita por hecha sin haber emitido [[RESERVA]].
// "Te dejo agendada", "te tengo agendada", "queda separada" (Nana, 23 oct: Gema se lo dijo dos veces, la
// cita nunca se creó y nadie se enteró).
const SOUNDS_BOOKED = /\b(te (agend|reserv)[eoé]|(entonces,? )?(agend|reserv)(emos|amos|ar[eé]|o)\b|voy a (reservar|agendar|apartar)|aqu[ií] (va|est[aá]) tu (reserva|cita)|qued[oóa]s?\s+agendad|cita\s+qued[oó]|confirmo\s+tu\s+cita|ya\s+(est[aá]s?|qued[oó])\s+reservad|te (dejo|tengo|qued[oó]) (agendad|separad|apartad|reservad)[oa]s?|qued[aoó]s?\s+(separad|apartad)[oa]s?)/i
/** El modelo dice que no hay espacio (se verifica contra la agenda: ver askedSlot). */
const DENIES_SPACE = /\bno (hay|tengo|me queda|queda|nos queda)\s+(espacio|cupo|disponibilidad|agenda)|\bno (est[aá]|se encuentra) disponible|\bya (est[aá]|fue) (ocupad|tomad)|\bsin (espacio|cupo)\b/i
// Frases con las que promete un link sin emitir [[LINK]] (pasó en una prueba real: "Aquí va el
// link" y el mensaje salía sin link). Si hay una cita apartada, el sistema lo reenvía igual.
// Frases con las que el modelo "entrega" datos de pago escritos por él, sin la marca [[TRANSFERENCIA]]
// ("Aquí están los datos para el anticipo", "datos de la cuenta"). Los datos reales los pega solo el servidor.
const PROMISES_PAYMENT_DATA = /\b(aqu[ií]|ah[ií])\s+(est[aá]n|van|tienes|te dejo)[^.\n]{0,40}\b(datos|cuenta|n[uú]mero)|\b(te\s+)?(voy a\s+)?(env[ií]o|enviar|mando|mandar|paso|pasar)\s+(los\s+)?datos\b|\bdatos\s+(para|de)\s+(el\s+|la\s+|tu\s+)?(anticipo|transferencia|pago|cuenta)|\bdatos de la cuenta\b/i
// "te la cambié para el jueves", "quedó para las 4": da por hecho un cambio de horario.
const CLAIMS_RESCHEDULE = /\b(te la |la )?(cambi[eé]|mov[ií]|reprogram[eé]|pas[eé])\s+(para|al|a las)\b/i
// Botón del recordatorio o mensaje equivalente.
const CONFIRMS_ATTENDANCE = /^\s*(s[ií],?\s*)?confirmo( mi (cita|asistencia))?\s*[.!]?\s*$/i
// "el nombre de tu hermana", "cómo se llama tu novio": pide el nombre del acompañante.
const ASKS_COMPANION_NAME = /\bnombre\s+(completo\s+)?de\s+(tu|su)\s+\w+|c[oó]mo se llama\s+(tu|su)\s+\w+/i
// Texto entre corchetes simples ("[datos de la cuenta]"): relleno del modelo, nunca una marca válida.
const BRACKET_PLACEHOLDER = /\[(?!\[)[^\]\n]{2,60}\]/
const PROMISES_LINK =/(aqu[ií]\s+(va|tienes|est[aá]|te\s+(dejo|env[ií]o|paso))|te\s+(env[ií]o|enviar[eé]|mando|paso|comparto|dejo))[^.\n]{0,25}\b(link|enlace)\b/i
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
const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Formas en que se escribe una hora: "18:30", "6:30", "6:30 pm", "6 y media", "10 am", "las 10". */
function hourPattern(hhmm: string): RegExp {
  const [h24, mm] = hhmm.split(':').map(Number)
  const h12 = h24 % 12 || 12
  const minutes = String(mm).padStart(2, '0')
  const forms = [`0?${h24}:${minutes}`, `${h12}:${minutes}`]
  if (mm === 0) forms.push(`${h12}\\s*(am|a\\.\\s?m|pm|p\\.\\s?m|de la (mañana|manana|tarde|noche))`, `las ${h12}\\b`)
  if (mm === 30) forms.push(`${h12}\\s*y\\s*media`)
  return new RegExp(`\\b(${forms.join('|')})`, 'i')
}

const ANY_HOUR = /\b([01]?\d|2[0-3])(?::([0-5]\d))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?(?=[\s.,;!?)]|$)/gi

/** "10:30 a.m." → "10:30", "6:30" → "18:30" (sin a.m./p.m., de 1 a 7 es de la tarde: horario de citas). */
function hoursIn(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(ANY_HOUR)) {
    const [, hourText, minutes, suffix] = match
    if (!minutes && !suffix) continue // un número suelto no es una hora
    let hour = Number(hourText)
    const pm = suffix?.toLowerCase().startsWith('p')
    if (pm && hour < 12) hour += 12
    if (!suffix && hour >= 1 && hour <= 7) hour += 12
    out.push(`${String(hour).padStart(2, '0')}:${minutes ?? '00'}`)
  }
  return [...new Set(out)]
}

/**
 * La lectura estructurada (extractReserva) a veces inventa lo que falta: un nombre "Cliente" o una
 * hora que nadie eligió. Solo se reserva si el nombre lo escribió el cliente y la hora la dijo él,
 * o fue la única hora que Gema le ofreció justo antes de que siguiera adelante (aceptación implícita).
 */
export function groundedInChat(extracted: ExtractedReserva, history: Message[]): boolean {
  const clientText = fold(history.filter((message) => message.sender === 'user').map((message) => message.text).join(' \n '))
  const firstName = fold(extracted.nombre.split(/\s+/)[0] ?? '')
  if (!isRealName(extracted.nombre) || firstName.length < 2 || !clientText.includes(firstName)) return false

  const hour = hourPattern(extracted.hora)
  if (history.some((message) => message.sender === 'user' && hour.test(message.text))) return true
  // Aceptación implícita: de las horas que Gema mencionó en sus últimos mensajes, se descartan las que
  // el cliente había pedido (la que no estaba libre); si queda exactamente una, es la que aceptó.
  const lastClient = history.map((message) => message.sender).lastIndexOf('user')
  const offers = history.slice(0, lastClient).filter((message) => message.sender !== 'user').slice(-3).map((message) => message.text).join(' ')
  const clientMessages = history.filter((message) => message.sender === 'user')
  const offered = hoursIn(offers).filter((clock) => !clientMessages.some((message) => hourPattern(clock).test(message.text)))
  return offered.length === 1 && offered[0] === extracted.hora
}

/** La respuesta da la cita por hecha (o pide datos de pago/pareja) sin la marca de reserva, y el cliente no tiene cita. */
function forgotReserva(reply: string, bookingId: string | undefined, cashBooking = false): boolean {
  if (bookingId) return false
  const found = [...reply.matchAll(MARKERS)].map((marker) => marker[1].toUpperCase())
  // EFECTIVO pasa el chat a Johanna, salvo con cashBooking: ahí acompaña a RESERVA y sin ella es un olvido.
  if (found.includes('RESERVA') || found.includes('ASESOR') || found.includes('PAGO') || (found.includes('EFECTIVO') && !cashBooking)) return false
  const plain = reply.replace(MARKERS, '')
  // Si está pidiendo un nombre (el suyo o el de quien la acompaña en el 2x1), todavía le faltan datos
  // para reservar: es lo correcto, no un olvido. Premier agenda cada cita con el nombre de cada persona.
  if (ASKS_FOR_NAME.test(plain) || ASKS_COMPANION_NAME.test(plain)) return false
  // Entregar datos de pago o un link sin que exista la cita también es un olvido de la reserva
  // (salió "voy a reservar… aquí va el link" con [[LINK]] y sin [[RESERVA]]).
  const handsOverPayment = PROMISES_PAYMENT_DATA.test(plain) || BRACKET_PLACEHOLDER.test(plain) || PROMISES_LINK.test(plain)
  return SOUNDS_BOOKED.test(plain) || handsOverPayment || found.some((kind) => ['TRANSFERENCIA', 'PAREJA', 'COMPLETO', 'LINK', 'EFECTIVO'].includes(kind))
}

/**
 * Lo que eligió el cliente según sus propios mensajes, no según las marcas del modelo: en una prueba
 * real dijo "pago completo, puedo por nequi?" y que iba con su hermana, y el modelo reservó con solo
 * [[RESERVA]] (anticipo, link de Bold, una persona). Gana la última mención del cliente.
 */
const SAYS_FULL = /\b(complet[oa]s?|todo de una( vez)?|pag(o|ar|amos|ar[ií]a)\s+(el\s+)?(total|todo))\b/i
const SAYS_DEPOSIT = /\b(anticipo|abono|la mitad|50 ?%)\b/i
const SAYS_LINK = /\b(link|enlace|tarjeta|pse|bold|cr[eé]dito|d[eé]bito)\b/i
const SAYS_PAIR = /\b(con|y)\s+(mi|una|un)\s+(herman[oa]|novi[oa]|espos[oa]|amig[oa]|mam[aá]|madre|pap[aá]|padre|hij[oa]|prim[oa]|pareja|compañer[oa]|soci[oa]|t[ií][oa]|cuñad[oa]|suegr[oa]|sobrin[oa]|vecin[oa])\b|\b(dos personas|las dos|los dos|ambas|ambos|vamos dos|somos dos|para dos)\b/i
// "ya pagué", "listo ya transferí": no está eligiendo medio, está avisando que pagó.
const SAYS_PAID = /\b(ya\s+(te\s+)?(pagu[eé]|transfer[ií]|consign[eé]|envi[eé])|listo,?\s+(ya\s+)?(pagu|transfer|consign))/i
const SAYS_ALONE =/\b(solo yo|yo sol[oa]|solo para m[ií]|nada m[aá]s yo|una persona|para m[ií] sol[oa]|voy sol[oa])\b/i

/** La opción que el cliente mencionó de última, recorriendo sus mensajes del más nuevo al más viejo. */
function latestOf<T>(texts: string[], options: Array<[RegExp, T]>): T | null {
  for (const text of [...texts].reverse()) {
    let best: { at: number; value: T } | null = null
    for (const [pattern, value] of options) {
      const global = new RegExp(pattern.source, 'gi')
      for (const match of text.matchAll(global)) if (!best || match.index! >= best.at) best = { at: match.index!, value }
    }
    if (best) return best.value
  }
  return null
}

/**
 * Palabras que identifican a cada servicio sin confundirlo con otro ("pigmentación", "profunda",
 * "dispositivo"…): las de su nombre que no aparecen en el nombre de ningún otro servicio.
 */
function distinctiveWords(config: AppConfig): Map<string, string[]> {
  const wordsOf = (label: string) => fold(label).split(/[^a-z0-9]+/).filter((word) => word.length >= 5)
  return new Map(config.services.map((service) => {
    const others = new Set(config.services.filter((other) => other.id !== service.id).flatMap((other) => wordsOf(other.label)))
    return [service.id, wordsOf(service.label).filter((word) => !others.has(word))]
  }))
}

// Palabras que acompañan al nombre de un servicio sin decir cuál es ("quiero la de ...", "esa").
const FILLER_WORDS = new Set(['la', 'el', 'de', 'del', 'e', 'y', 'con', 'esa', 'ese', 'esta', 'este', 'una', 'un', 'quiero', 'me', 'interesa', 'por', 'favor', 'si', 'mejor', 'limpieza', 'facial'])

/**
 * Nombre de servicio ambiguo. "Limpieza e hidratación" es el comienzo literal de "Limpieza e
 * Hidratación y Pigmentación", pero también cabe en "Limpieza Peeling y Hidratación": con el
 * Peeling recién ofrecido, el modelo elegía Pigmentación y le decía a la clienta que no tenía 2x1
 * (19 oct, 10 de 15 pruebas, y la regla del prompt sola no lo corrigió). Si el último mensaje es
 * solo un nombre que cabe en varios servicios, el servidor le dice al modelo cuál es: el que Gema
 * acababa de nombrar o, si no hay uno solo, que pregunte.
 */
export function serviceHint(config: AppConfig, history: Message[]): string | undefined {
  const last = history.at(-1)
  if (last?.sender !== 'user') return undefined
  const words = fold(last.text).split(/[^a-z0-9]+/).filter(Boolean)
  if (!words.length || words.length > 8) return undefined
  const labelWords = new Map(config.services.map((service) => [service.id, new Set(fold(service.label).split(/[^a-z0-9]+/).filter(Boolean))]))
  // Solo si el mensaje es un nombre de servicio y nada más ("limpieza e hidratación", "la de hidratación").
  const allLabelWords = new Set([...labelWords.values()].flatMap((set) => [...set]))
  if (!words.every((word) => FILLER_WORDS.has(word) || allLabelWords.has(word))) return undefined
  const key = words.filter((word) => !FILLER_WORDS.has(word))
  if (!key.length) return undefined
  const candidates = config.services.filter((service) => key.every((word) => labelWords.get(service.id)!.has(word)))
  if (candidates.length < 2) return undefined

  const distinctive = distinctiveWords(config)
  const previous = fold([...history].reverse().find((message) => message.sender === 'gem')?.text ?? '')
  const named = candidates.filter((service) => (distinctive.get(service.id) ?? []).some((word) => previous.includes(word)))
  const today = dayKey()
  if (named.length === 1) {
    const [service] = named
    const others = candidates.filter((other) => other.id !== service.id).map((other) => other.label)
    return `Nota del sistema: con "${last.text.trim()}" el cliente se refiere a *${service.label}* (\`${service.id}\`), el que le nombraste en tu mensaje anterior${twoForOneApplies(config, service.id, today) ? ', y que SÍ tiene 2x1' : ''}. No es ${others.join(' ni ')}. Sigue con ese servicio.`
  }
  const options = (named.length ? named : candidates).map((service) => service.label)
  return `Nota del sistema: "${last.text.trim()}" puede ser ${options.join(', ').replace(/, ([^,]*)$/, ' o $1')}. No elijas tú ni digas que no tiene 2x1: pregúntale cuál, en una frase y con los nombres completos.`
}

// Pregunta cuánto hay que dejar para apartar: el anticipo.
const ASKS_DEPOSIT = /anticipo|abono|apart(ar|o)|separ(ar|o)|reserv(ar|a)\b.*(cu[aá]nto|pag)|cu[aá]nto\s+(hay\s+que|toca|se\s+(deja|paga)|debo|tengo\s+que)\s+(dejar|pagar|abonar)/i
// Ya le explicó que el anticipo se descuenta del valor (lo que hay que decir la primera vez).
const EXPLAINED_DEPOSIT = /descuenta|parte del valor|no es un (costo|cobro)/i
// Insiste en no pagar nada antes.
const INSISTS_CASH = /\bnada\s+antes|\bsolo\s+(en\s+)?efectivo|\btodo\s+(en\s+efectivo|all[aá])|\bno\s+(pago|voy\s+a\s+pagar|quiero\s+pagar)\b/i

/**
 * Pago en efectivo y anticipo. Con solo la regla del prompt, a "yo pago en efectivo allá" el modelo
 * contestaba "el anticipo se debe pagar antes" (0 de 5 decían que se descuenta del valor, 20 oct): el
 * encuadre que VIRAND pidió evitar. La nota llega después del historial, justo antes de responder.
 */
export function paymentNote(history: Message[], cashBooking = false, perk = ''): string | undefined {
  const last = history.at(-1)
  if (last?.sender !== 'user') return undefined
  if (cashBooking && (saysCash(last.text) || INSISTS_CASH.test(last.text))) {
    return 'Nota del sistema: el cliente quiere pagar en efectivo en la sede. La respuesta es SÍ: paga todo en la sede el día de la cita y no tiene que pagar nada antes. NO le digas que necesita el anticipo para agendar, no le ofrezcas link ni le insistas. Pide solo lo que falte (cuál limpieza, sede, día y hora, nombre completo). Si ya tienes todo, reserva YA con [[RESERVA]] y [[EFECTIVO]]: no le pidas que confirme nada (ni el nombre ni el pago), ya lo dijo.'
  }
  const explained = history.slice(0, -1).some((message) => message.sender === 'gem' && EXPLAINED_DEPOSIT.test(message.text) && /efectivo|en la sede/i.test(message.text))
  if (saysCash(last.text) || (explained && INSISTS_CASH.test(last.text))) {
    return explained && INSISTS_CASH.test(last.text)
      ? 'Nota del sistema: ya le explicaste que el anticipo se descuenta del valor y el cliente insiste en no pagar nada antes. No le discutas: dile que lo confirmas con la sede y cuándo le respondes, y usa la marca [[EFECTIVO]].'
      : 'Nota del sistema: el cliente quiere pagar en efectivo o en la sede. Respóndele que sí: el resto lo paga en la sede el día de la cita, en efectivo o como prefiera. Solo el anticipo se paga antes, porque separa su cupo, y se descuenta del valor de su limpieza: no es un costo adicional. Dilo con esas palabras, con la cuenta del catálogo para su servicio, y una sola pregunta (por ejemplo si le envías el link para separarlo). No uses [[EFECTIVO]] todavía.'
  }
  if (ASKS_DEPOSIT.test(last.text)) {
    return [
      'Nota del sistema: al hablar del anticipo dilo como algo simbólico y seguro: se descuenta del valor de la limpieza (no es un cobro extra) y se pide solo para asegurar su espacio, porque hay personas que reservan y no llegan. Da la cuenta del catálogo para ese servicio: cuánto deja ahora, cuánto paga en la sede y el total.',
      perk ? `Cuéntale que si agenda hoy con su anticipo, de cortesía le regalamos ${perk}.` : '',
      cashBooking ? 'No le ofrezcas tú pagar todo en la sede: eso solo si él lo pide.' : 'No ofrezcas reservar sin anticipo ni pagar todo en la sede: esa opción no existe.',
    ].filter(Boolean).join(' ')
  }
  return undefined
}

/**
 * Cliente con nombre de usuario de WhatsApp: Meta no entrega su número, solo un identificador. Se le
 * escribe igual por WhatsApp, pero la sede no tiene cómo llamarlo; por eso Gema le pide un celular al
 * agendar (Premier, 20 oct 2026). Es opcional: si no lo da, la cita se agenda igual.
 */
const HIDDEN_NUMBER_NOTE = 'Nota del sistema: este cliente usa nombre de usuario de WhatsApp y su número no es visible para nosotros. SOLO cuando le pidas el nombre completo para agendar (no antes), pídele en esa misma frase un número de celular de contacto, por si la sede necesita llamarlo ("me regalas tu nombre completo y un celular de contacto?"). Si no lo quiere dar, agenda igual y no se lo vuelvas a pedir.'

/** Celular en los mensajes recientes del cliente: "300 123 4567", "+57 3001234567", "+1 305…". */
export function contactPhoneIn(history: Message[]): string | null {
  for (const message of [...history].reverse()) {
    if (message.sender !== 'user') continue
    const text = message.text.replace(/[\s.\-()]+/g, ' ')
    // Con "+" y otro indicativo (no +57), es un número del exterior: va tal cual.
    const international = /\+\s?(\d[\d\s]{7,16}\d)/.exec(text)
    if (international && !/^57/.test(international[1])) return international[1].replace(/\s/g, '')
    const colombian = /(?:\+?57\s?)?\b(3\d{2})\s?(\d{3})\s?(\d{4})\b/.exec(text)
    if (colombian) return `57${colombian[1]}${colombian[2]}${colombian[3]}`
  }
  return null
}

/** Dijo que no le interesa: Gema se despide sin insistir (los automáticos ya se detuvieron en el webhook). */
export function optOutNote(chat: Pick<ChatSummary, 'optedOut'>, history: Message[]): string | undefined {
  const last = history.at(-1)
  if (!chat.optedOut || last?.sender !== 'user' || !(isOptOut(last.text) || /ahora_no$/i.test(last.buttonPayload ?? ''))) return undefined
  return 'Nota del sistema: el cliente dijo que no le interesa o que ahora no. Despídete en una o dos frases cortas y amables, sin insistir, sin ofrecer nada y sin hacer preguntas. Puedes decirle que si más adelante quiere consentir su piel, aquí estás. No uses marcas.'
}

/**
 * Su mensaje llegó o se procesó tarde (Meta reintentó la entrega, o se cayó el servicio): Gema
 * empieza disculpándose por la demora. 20 oct: chats del 18 y 19 recibieron la primera respuesta
 * más de un día después, sin una palabra al respecto.
 */
export function lateNote(history: Message[], now = Date.now()): string | undefined {
  const last = history.at(-1)
  if (last?.sender !== 'user' || now - last.at < LATE_REPLY_MS) return undefined
  const hours = Math.round((now - last.at) / 3_600_000)
  return `Nota del sistema: el mensaje del cliente nos llegó con retraso (lo escribió hace ${hours >= 1 ? `unas ${hours} horas` : 'un buen rato'}). Empieza con una disculpa corta y humana por la demora ("perdona la demora en responderte") y sigue normal.`
}

/** Horas sin conversar a partir de las que el cliente "vuelve": Gema retoma, no empieza de cero. */
const RETURN_GAP_MS = 6 * 3_600_000
/** Al volver, Gema lee más mensajes de la conversación anterior. */
const HISTORY_ON_RETURN = 50
// Quedó en confirmar algo: "te confirmo", "le pregunto a mi amiga", "tengo que cuadrar con mi hermana".
const SAYS_WILL_CONFIRM = /\b(te\s+(confirmo|aviso|escribo|cuento|digo)|le\s+(pregunto|consulto|confirmo|digo|aviso)|(confirmo|cuadro|hablo|pregunto|consulto|miro)\s+con\b|(voy a|tengo que|debo|necesito)\s+(confirmar|preguntar|cuadrar|consultar|mirar|revisar))/i

/**
 * El cliente vuelve a escribir horas o días después (lo normal en el 2x1: queda en confirmar el día con
 * su acompañante). El modelo no ve fechas en el historial: sin esto saludaba como a un cliente nuevo,
 * repetía la promoción o daba por buenos el "hoy" y las horas que ofreció el día anterior.
 */
export function returnNote(history: Message[], now = Date.now()): string | undefined {
  // Los mensajes que el cliente acaba de mandar (pueden ser varios seguidos).
  let start = history.length
  while (start > 0 && history[start - 1].sender === 'user') start--
  if (start === history.length) return undefined
  const before = history.slice(0, start)
  // La última vez que de verdad conversaron: los seguimientos y plantillas automáticos no cuentan.
  const lastTalk = [...before].reverse().find((message) => !message.auto)
  const gap = lastTalk ? history[start].at - lastTalk.at : 0
  // Si nadie le había respondido todavía, no hay conversación que retomar.
  if (!lastTalk || gap < RETURN_GAP_MS || !before.some((message) => message.sender !== 'user' && !message.auto)) return undefined
  const hours = Math.round(gap / 3_600_000)
  const lastDay = dayKey(lastTalk.at)
  const when = lastDay === addDays(dayKey(now), -1) ? 'ayer' : `el ${dayLabel(lastDay)}`
  const clientTexts = before.filter((message) => message.sender === 'user').map((message) => message.text)
  const pair = latestOf(clientTexts.slice(-10), [[SAYS_PAIR, 'pair'], [SAYS_ALONE, 'alone']] as Array<[RegExp, 'pair' | 'alone']>) === 'pair'
  const pending = clientTexts.slice(-4).some((text) => SAYS_WILL_CONFIRM.test(text))
  return [
    `Nota del sistema: el cliente vuelve a escribir después de ${hours < 48 ? `unas ${hours} horas` : `${Math.round(hours / 24)} días`}; la última conversación fue ${when}. Retómala donde quedó, como alguien que se acuerda de él: no lo saludes como a un cliente nuevo ni le repitas lo que ya le explicaste (promoción, ritual, precios).`,
    'Lo que en los mensajes anteriores era "hoy" o "mañana" se refiere a ese día, no a hoy, y las horas que le ofreciste pueden ya no estar: ofrece solo de la disponibilidad de ahora.',
    pending ? `Quedó en confirmar algo${pair ? ' con su acompañante' : ''}: si su mensaje no lo dice, pregúntale primero si ya lo pudo confirmar.` : '',
    pair ? 'Viene con acompañante (2x1): ofrécele horas de los rangos de "parejas" y, si aún no lo tienes, pídele el nombre de la otra persona.' : '',
  ].filter(Boolean).join(' ')
}

/**
 * Cliente con una cita del equipo (ver teamBookingOf). Con solo la regla del prompt, a "a las 11 está
 * bien" el modelo le pedía el nombre completo como a un cliente nuevo en vez de reprogramar (prueba del 23 oct).
 */
export function teamNote(booking: Booking, now = Date.now()): string {
  // "No alcanzó a venir" solo si el equipo la marcó así; si la hora pasó sin marcar, no se sabe si vino.
  const state = booking.status === 'no_show' ? ', y no alcanzó a venir' : booking.startTs <= now ? ', y la hora de esa cita ya pasó (no sabes si vino: no lo afirmes)' : ''
  return [
    `Nota del sistema: este cliente tiene la cita que le agendó ${booking.advisor || 'un asesor del equipo'} (${serviceText(booking)}, ${dayLabel(booking.day)} a las ${clock12(booking.start)} en ${LOCATION_LABEL[booking.location]})${state}.`,
    `Si quiere otra fecha, cuando acepte una hora concreta usa YA [[REPROGRAMAR: sede · YYYY-MM-DD · HH:MM]]: es la misma cita, ya tienes su nombre (${booking.name || 'está en la cita'}) y no se le pide nada más, ni pago ni anticipo.`,
  ].join(' ')
}

/**
 * La bienvenida ofrece dos servicios y el cliente elige horario sin decir cuál limpieza: el modelo
 * suponía uno (en una prueba cotizó Líneas a quien no la había pedido). Mientras ningún mensaje
 * del cliente nombre un servicio, se le recuerda preguntarlo.
 */
export function serviceChoiceNote(config: AppConfig, history: Message[]): string | undefined {
  if (!history.some((message) => message.auto === WELCOME_KIND)) return undefined
  const words = distinctiveWords(config)
  const said = fold(history.filter((message) => message.sender === 'user').map((message) => message.text).join(' '))
  if ([...words.values()].some((list) => list.some((word) => said.includes(word))) || /arruga|anti ?edad|acne|grasa|mancha/.test(said)) return undefined
  return 'Nota del sistema: el cliente todavía no dijo cuál limpieza quiere. No supongas ninguna: antes de reservar, pregúntale cuál de las de la bienvenida (con su nombre corto, por ejemplo "la de Peeling o la de Líneas"), en el mismo mensaje en que pidas los nombres.'
}

// "2×1" con el signo de multiplicar es como lo escribe el anuncio (y lo copian los clientes).
const PROMO_WORD = /2\s?[x×]\s?1|dos por uno/i
const DENIES = /\b(no|sin|tampoco|solo|solamente|unicamente)\b|no aplica|no tiene|no cuenta|no incluye|no entra/i

/**
 * Red de seguridad del 2x1: el modelo no puede darle la promoción a un servicio que no la tiene.
 * Se quita la frase que nombra el 2x1 junto a un servicio sin 2x1, salvo que lo niegue ("en esa no
 * hay 2x1") o que en la misma frase nombre también uno que sí lo tiene ("sí lo tiene la de peeling").
 */
export function stripWrongPromo(config: AppConfig, phone: string, text: string): string {
  if (!PROMO_WORD.test(text)) return text
  const today = dayKey()
  const words = distinctiveWords(config)
  const mentions = (sentence: string, ids: string[]) => ids.some((id) => (words.get(id) ?? []).some((word) => fold(sentence).includes(word)))
  const withPromo = config.services.filter((service) => twoForOneApplies(config, service.id, today)).map((service) => service.id)
  const without = config.services.filter((service) => !withPromo.includes(service.id)).map((service) => service.id)
  let removed = 0
  const parts = text.split(SEPARATOR).map((part) => part.split(/(?<=[.!?])\s+/).filter((sentence) => {
    const wrong = PROMO_WORD.test(sentence) && mentions(sentence, without) && !mentions(sentence, withPromo) && !DENIES.test(fold(sentence))
    if (wrong) removed++
    return !wrong
  }).join(' ').trim())
  if (!removed) return text
  console.warn(`[autoreply] ${phone}: se quitó un 2x1 ofrecido a un servicio que no lo tiene`)
  return parts.filter(Boolean).join(SEPARATOR)
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
const ASKS_FOR_NAME = /\b(tu|su)\s+nombre\b|c[oó]mo te llamas|c[oó]mo se llama usted|a nombre de qui[eé]n|nombre completo\?/i

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Firma de sendWhatsAppText: se puede inyectar otra (p. ej. scripts/simulate-chat.ts) para probar sin llamar a Meta. */
export type SendFn = (to: string, body: string) => Promise<string | undefined>
export type SendImageFn = (to: string, link: string, caption: string) => Promise<string | undefined>

const WELCOME_GAP_MS = 1_500

/**
 * Cliente nuevo (nadie le ha escrito todavía): la bienvenida en bloques de lib/welcome.ts. La arma
 * el servidor, así que no gasta IA ni puede inventar precios. Devuelve 'none' si no corresponde,
 * 'answer' si además hay una pregunta que los bloques no responden (la contesta Gema) u 'only'.
 */
async function sendWelcome(chat: ChatSummary, send: SendFn, sendImage: SendImageFn, testConfig?: AppConfig): Promise<'none' | 'answer' | 'only'> {
  const { phone } = chat
  const history = await getHistory(phone, 20)
  if (!history.length || history.some((message) => message.sender !== 'user')) return 'none'
  // "No me interesa" como primer mensaje: no se le manda la bienvenida, Gema solo se despide.
  if (chat.optedOut) return 'none'
  // La bienvenida es para quien llega por primera vez. Un cliente que ya tiene (o tuvo) una cita, que ya
  // recibió algún mensaje automático nuestro o que llegó tocando el botón de una plantilla NO es nuevo:
  // el 21 oct un cliente agendado desde el panel respondió "Confirmo mi cita" al recordatorio y Gema le
  // mandó toda la bienvenida.
  if (chat.bookingId || Object.keys(chat.autoSent).some((kind) => !kind.endsWith(':error')) || history.some((message) => message.buttonPayload)) return 'none'
  if ((await bookingsOfPhone(phone, 1)).length) return 'none'
  const welcome = await buildWelcome(testConfig ?? await getConfig(), process.env.PUBLIC_APP_URL || 'https://premier-agente.vercel.app', { chat })
  if (!welcome) return 'none'
  // Llegó (o se procesó) tarde: primero una disculpa corta, después la bienvenida de siempre.
  const late = Date.now() - history[0].at > LATE_REPLY_MS
  try {
    await deliverWelcome(phone, welcome, send, sendImage, { late })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    await requestAgent(phone, `${WELCOME_FAILED} ${detail}`)
    return 'only'
  }
  const clientTexts = history.filter((message) => message.sender === 'user')
  return clientTexts.some((message) => message.media) || needsAnswerAfterWelcome(clientTexts.map((message) => message.text).join(' ')) ? 'answer' : 'only'
}

/** Motivo con el que un chat pasa a una persona si la bienvenida no salió (el panel ofrece reenviarla). */
export const WELCOME_FAILED = 'WhatsApp rechazó la bienvenida:'

/**
 * Envía la bienvenida (imagen con su pie + los demás bloques) y la deja registrada. La usa también
 * el botón "Enviar bienvenida" del panel cuando falló o hay que repetirla.
 */
export async function deliverWelcome(phone: string, welcome: Welcome, send: SendFn = sendWhatsAppText, sendImage: SendImageFn = sendWhatsAppImage, { late = false } = {}) {
  const record = (id: string | undefined, text: string) => recordOutbound(phone, { id: id ?? crypto.randomUUID(), sender: 'gem', text, at: Date.now(), auto: WELCOME_KIND })
  if (late) {
    const apology = 'perdona la demora en responderte 🙏 se nos cruzaron unos mensajes, ya te cuento todo'
    await record(await send(phone, apology), apology)
    await sleep(WELCOME_GAP_MS)
  }
  // Si la imagen falla (Meta no la pudo descargar), el texto sale igual sin ella.
  const imageId = await sendImage(phone, welcome.imageUrl, welcome.caption).catch(async (error) => {
    console.warn(`[autoreply] ${phone}: la imagen de bienvenida no salió, va solo el texto:`, error instanceof Error ? error.message : error)
    return send(phone, welcome.caption)
  })
  await record(imageId, welcome.caption)
  for (const message of welcome.messages) {
    await sleep(WELCOME_GAP_MS)
    await record(await send(phone, message), message)
  }
  await markChatAuto({ phone }, WELCOME_KIND)
}

/**
 * El cliente tocó "Confirmo mi cita" (o lo escribió) y tiene una cita confirmada: se marca la asistencia y se le
 * agradece con un mensaje corto. Devuelve true si ya se respondió.
 */
async function answerAttendanceButton(chat: ChatSummary, send: SendFn): Promise<boolean> {
  const [last] = await getHistory(chat.phone, 1)
  if (last?.sender !== 'user' || !CONFIRMS_ATTENDANCE.test(last.text)) return false
  const booking = await liveBookingOf(chat.phone)
  if (!booking || booking.status !== 'confirmed') return false
  if (!booking.attendanceConfirmedAt) await confirmAttendance(booking.id)
  const config = await getConfig()
  const address = config.addresses[booking.location]
  const name = booking.name.split(' ')[0]
  const text = `Listo${name ? `, ${name}` : ''}, quedó confirmada tu asistencia 🙌 te esperamos el ${dayLabel(booking.day)} a las ${clock12(booking.start)} en ${LOCATION_LABEL[booking.location]}${address ? ` (${address})` : ''}`
  try {
    const waId = await send(chat.phone, text)
    await recordOutbound(chat.phone, { id: waId ?? crypto.randomUUID(), sender: 'gem', text, at: Date.now() })
  } catch (error) {
    await requestAgent(chat.phone, `WhatsApp rechazó el envío: ${error instanceof Error ? error.message : String(error)}`)
  }
  return true
}

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
/** Cita en efectivo: queda agendada (no apartada) y se paga toda en la sede. */
function cashBookedText(config: AppConfig, booking: Booking): string {
  const firstName = booking.name.split(' ')[0]
  const address = config.addresses[booking.location]
  const total = amountOf(booking.price)
  return `Listo${firstName ? `, ${firstName}` : ''}: tu cita de *${serviceText(booking)}* queda agendada para el ${dayLabel(booking.day)} a las ${clock12(booking.start)}${pairTimes(booking)} en ${LOCATION_LABEL[booking.location]}${address ? ` (${address})` : ''}.\n\nEl pago${total ? ` de ${pesos(total)}` : ''} lo haces en la sede el día de tu cita, en efectivo o como prefieras. Te escribo por aquí antes de la cita para recordártela`
}

function bookedLine(booking: Booking): string {
  const firstName = booking.name.split(' ')[0]
  return `Listo${firstName ? `, ${firstName}` : ''}: tu cita de *${serviceText(booking)}* queda apartada para el ${dayLabel(booking.day)} a las ${clock12(booking.start)}${pairTimes(booking)} en ${LOCATION_LABEL[booking.location]}.`
}

/** Pareja en una sede de una sola cabina: " (una después de la otra: 3:00 p.m. y 4:00 p.m.)". */
export function pairTimes(booking: Pick<Booking, 'sequential' | 'people' | 'start' | 'durationMin'>): string {
  if (!booking.sequential || booking.people < 2) return ''
  const session = Math.round(booking.durationMin / booking.people)
  const times = Array.from({ length: booking.people }, (_, index) => clock12(toClock(toMinutes(booking.start) + index * session)))
  return ` (una después de la otra: ${times.slice(0, -1).join(', ')} y ${times.at(-1)})`
}

/** Nota de la cita con la cortesía por anticipo (la ve la cabina en la agenda). */
export function perkNote(config: AppConfig): string {
  return `Cortesía por agendar con anticipo: ${config.depositPerk.trim()} (si el anticipo queda pagado)`
}

/** " 🎁 Y como agendaste hoy, te regalamos …": se añade al cobro de una cita con anticipo. */
function perkLine(config: AppConfig, booking: Booking): string {
  const perk = config.depositPerk.trim()
  return perk && booking.paymentPlan !== 'cash' && booking.notes.includes('Cortesía') ? `\n\n🎁 Y como agendaste hoy, con tu anticipo te regalamos ${perk}` : ''
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
 * " de $65.000, que se descuenta del valor de tu limpieza ($65.000 ahora y $65.000 en la sede, total
 * $130.000)". El anticipo asustaba como si fuera un cobro aparte (VIRAND, 19 oct): se dice siempre
 * que es parte del precio, con la cuenta. Con pago completo, solo el monto.
 */
export function amountLine(booking: Pick<Booking, 'deposit' | 'price' | 'paymentPlan'>): string {
  if (!booking.deposit) return ''
  const paid = amountOf(booking.deposit)
  const total = amountOf(booking.price)
  if (booking.paymentPlan === 'full' || !paid || !total || paid >= total) return ` de ${booking.deposit}`
  return ` de ${booking.deposit}, que se descuenta del valor de tu limpieza (${pesos(paid)} ahora y ${pesos(total - paid)} en la sede, total ${pesos(total)})`
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
  const deposit = amountLine(booking)
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

/**
 * El 2x1 que el modelo olvidó mencionar. Con un historial largo el modelo imita sus respuestas
 * anteriores y deja de nombrar la promoción aunque el prompt lo exija (medido: 0 de 4). Si la
 * respuesta da el precio de un servicio con 2x1 vigente y no dice "2x1", el servidor lo añade.
 */
function missingPromo(config: AppConfig, text: string): { price: string; line: string } | null {
  const today = dayKey()
  // Mientras se cierra la reserva (anticipo, pago completo) no se interrumpe con la promoción.
  if (!promoLive(config, today) || PROMO_WORD.test(text) || /anticipo|completo/i.test(text)) return null
  const service = config.services.find((item) => {
    const amount = amountOf(item.price)
    return amount && twoForOneApplies(config, item.id, today) && text.includes(pesos(amount))
  })
  if (!service) return null
  const until = config.twoForOne[service.id]
  const [, month, day] = until ? until.split('-').map(Number) : []
  return {
    price: pesos(amountOf(service.price)),
    line: `y tiene 2x1 si vienes con alguien${until ? `, para citas hasta el ${day} de ${MONTH_NAME[month - 1]}` : ''}`,
  }
}

type PayMethod = 'transfer' | 'link'

/** Un nombre de verdad: con letras, no "-", "cliente", "nombre" ni similares. */
function isRealName(name: string): boolean {
  const clean = fold(name.trim())
  return /[a-z]{2,}/.test(clean) && !/^(cliente|nombre|nombre completo|usuario|prueba|n\/?a|sin nombre|-+)$/.test(clean)
}

/** Con qué se paga el link de Bold según el país: fuera de Colombia, solo tarjeta y en pesos. */
function linkMethods(phone: string): string {
  return regionOf(phone) === 'CO' ? 'con PSE, tarjeta débito o crédito, Nequi o Daviplata' : 'con tarjeta de crédito (se cobra en pesos colombianos; tu banco hace la conversión)'
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
/**
 * La última cita del cliente se canceló porque no pagó a tiempo y la sesión todavía no pasa: se vuelve
 * a crear igual (servicio, sede, día, hora, personas, forma de pago). Si el horario ya lo tomó otra
 * persona, se le ofrecen otras horas ese día.
 */
async function rebookExpired(config: AppConfig, phone: string): Promise<{ booking: Booking | null } | { applied: Applied }> {
  const [last] = await bookingsOfPhone(phone, 1)
  if (!last || last.status !== 'cancelled' || last.startTs <= Date.now() + config.leadTimeHours * 3_600_000) return { booking: null }
  const reason = await redis().hget<string>(keys.booking(last.id), 'cancelReason')
  if (reason !== 'Anticipo no pagado a tiempo') return { booking: null }
  const result = await createBooking(config, {
    phone, name: last.name, location: last.location, serviceId: last.serviceId, day: last.day, start: last.start,
    concern: last.concern, notes: last.notes, source: 'bot', people: last.people, payFull: last.paymentPlan === 'full', companion: last.companion,
  })
  if (result.ok) {
    await attachBooking(phone, result.booking.id, { name: last.name, serviceId: last.serviceId, location: last.location })
    return { booking: result.booking }
  }
  if (result.reason === 'taken') {
    const options = result.alternatives.slice(0, 4).map(clock12)
    return {
      applied: {
        append: '',
        replaceText: options.length
          ? `Tu horario del ${dayLabel(last.day)} a las ${clock12(last.start)} ya lo tomó otra persona. Ese día en ${LOCATION_LABEL[last.location]} me quedan: ${options.join(', ')}\n\ncuál te sirve?`
          : `Tu horario del ${dayLabel(last.day)} ya no está disponible y ese día no me queda espacio\n\nte busco otro día?`,
      },
    }
  }
  return { booking: null }
}

async function resendLink(config: AppConfig, phone: string, { implicit = false } = {}): Promise<Applied> {
  let booking = await liveBookingOf(phone)
  if (!booking && !implicit) {
    // El horario se liberó sin pago (la plantilla anticipo_pendiente ofrece "Enviar link"): se
    // vuelve a apartar el mismo horario, si sigue libre, y se manda un link nuevo.
    const rebooked = await rebookExpired(config, phone)
    if ('applied' in rebooked) return rebooked.applied
    booking = rebooked.booking
  }
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
  const deposit = amountLine(booking)
  const what = booking.paymentPlan === 'full' ? 'pagar la sesión completa' : 'pagar el anticipo'
  return { append: `\n\nAquí tienes el link para ${what}${deposit} ${linkMethods(phone)}:\n${url}\nTu horario sigue apartado ${holdMinutesLeft(booking)} minutos y apenas se confirme el pago te aviso por aquí` }
}

/** Pareja: `companion` es el nombre del acompañante ('' si no lo dio). null = cita individual. */
export async function applyReserva(
  config: AppConfig,
  phone: string,
  payload: string,
  { method = null as PayMethod | null, companion = null as string | null, payFull = false, cash = false } = {},
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
      // Gema ya puede mover la cita: no hace falta una asesora para cambiar el horario.
      replaceText: `Ya tienes una cita ${state}: *${serviceText(existing)}* el ${dayLabel(existing.day)} a las ${clock12(existing.start)} en ${LOCATION_LABEL[existing.location]}\n\nquieres que te la cambie a otro día u hora?`,
    }
  }

  // Sin nombre no se reserva: el modelo a veces pone "-" o "Cliente" antes de que el cliente lo dé
  // (salió "Listo, -: tu cita…"). Se le pide y la reserva se hace en el siguiente mensaje.
  if (!isRealName(parsed.name)) {
    return { append: '', replaceText: 'me das tu nombre completo para dejar la cita apartada?' }
  }
  // Premier agenda cada sesión con el nombre de quien se la hace: una pareja del 2x1 lleva los dos.
  if (companion !== null && !isRealName(companion)) {
    return { append: '', replaceText: 'me das el nombre completo de la persona que viene contigo? así quedan las dos en la cita' }
  }

  const chat = await getSummary(phone)
  const pair = companion !== null
  // Cortesía por agendar con anticipo (no aplica a quien paga todo en efectivo): queda en las notas
  // para que la cabina la vea. Se entrega si el anticipo queda pagado.
  const perk = !cash && config.depositPerk.trim() ? perkNote(config) : ''
  const result = await createBooking(config, {
    phone,
    name: parsed.name,
    location: parsed.sede,
    serviceId: service.id,
    day: parsed.day,
    start: parsed.start,
    concern: chat?.lead.concern ?? '',
    notes: [pair ? 'Pareja 2x1' : '', perk].filter(Boolean).join(' · '),
    source: 'bot',
    advisor: 'Gema',
    contactPhone: chat?.contactPhone ?? '',
    people: pair ? 2 : 1,
    payFull,
    cash,
    companion: pair ? companion : '',
  })

  if (!result.ok) {
    if (result.reason === 'cabins') {
      return {
        append: `\n\nEn ${LOCATION_LABEL[parsed.sede]} no podemos atender a dos personas a la misma hora; una asesora te ayuda a coordinarlo ${humanWhen()}`,
        escalate: `Pareja 2x1 pedida en ${LOCATION_LABEL[parsed.sede]}, que tiene una sola cabina configurada`,
      }
    }
    // La cita no se creó: el texto del modelo (que la daba por hecha, a veces con "te espero el lunes")
    // se reemplaza entero, no se le añade una corrección al final.
    if (result.reason === 'taken') {
      const options = result.alternatives.slice(0, 4).map(clock12)
      const who = pair ? 'para dos personas ' : ''
      return {
        append: '',
        replaceText: options.length
          ? `A las ${clock12(parsed.start)} ya no me queda espacio ${who}el ${dayLabel(parsed.day)} en ${LOCATION_LABEL[parsed.sede]}. Me quedan: ${options.join(', ')}\n\ncuál te sirve?`
          : `Ese día ya no me queda espacio ${who}en ${LOCATION_LABEL[parsed.sede]}\n\nte busco otro día?`,
      }
    }
    if (result.reason === 'closed') return { append: '', replaceText: 'Ese día la sede está cerrada\n\nte busco otra fecha?' }
    return { append: '', escalate: 'No se pudo crear la cita' }
  }

  const { booking } = result
  await attachBooking(phone, booking.id, { name: booking.name, serviceId: booking.serviceId, location: booking.location })
  // A Meta: cita agendada desde un anuncio (no espera el pago; el pago se reporta aparte como Purchase).
  await trackConversion({ name: 'LeadSubmitted', phone, eventId: `cita_${phone}_${booking.id}` })

  // Efectivo: no hay cobro previo ni link; los recordatorios los envía lib/automations.ts.
  // El mensaje "Cita agendada" del panel; si no se puede completar, el texto de siempre.
  if (booking.paymentPlan === 'cash') return { append: '', replaceText: (await renderPreset(config, 'bookingConfirmed', { booking })) ?? cashBookedText(config, booking) }

  // El cobro lo escribe el servidor, nunca el modelo: los datos salen de la config,
  // según el país del número (misma lógica por región que la consola original).
  // El cliente ya dijo que prefiere transferir: datos de transferencia en vez del link. El mensaje
  // lo compone el servidor entero, porque en este paso el modelo tiende a inventarse los datos.
  if (method === 'transfer') {
    const result = transferAppend(config, booking)
    return { ...result, replaceText: `${bookedLine(booking)}${result.append}${perkLine(config, booking)}` }
  }

  const payment = paymentFor(config, regionOf(phone))
  if (!payment.configured) {
    return { append: '', escalate: `Cita ${booking.id} apartada, pero los datos de cobro de ${regionOf(phone)} no están configurados` }
  }

  const deposit = amountLine(booking)

  // El cliente todavía no dijo cómo paga y hay dos caminos (link de Bold o transferencia directa):
  // se le ofrecen los dos y se espera su respuesta. El link no se genera hasta que lo elija, así no
  // quedan links de Bold abiertos que nadie va a usar (Bold no permite anularlos).
  // El texto del modelo se reemplaza: suele decir "aquí va el link", y el link todavía no va.
  if (!method && payment.bold && payment.instructions) {
    return {
      append: '',
      replaceText: `${bookedLine(booking)}\n\nPara dejarla reservada necesitamos ${chargeText(booking)}${deposit}. Lo puedes pagar de dos formas:\nCon el link de Bold, que acepta PSE, tarjeta débito o crédito, Nequi y Daviplata, y la cita se confirma sola apenas pagas.\nO por transferencia directa a Nequi, Daviplata o a la cuenta de ahorros Bancolombia, y me mandas el comprobante.\nTu horario queda apartado ${config.holdMinutes} minutos${perkLine(config, booking)}\n\ncómo prefieres pagar, con el link o por transferencia?`,
    }
  }

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
      append: `\n\nPara dejarla reservada necesitamos ${chargeText(booking)}${deposit}. Puedes pagarlo aquí ${linkMethods(phone)}:\n${boldUrl}\nTu horario queda apartado ${config.holdMinutes} minutos y apenas se confirme el pago te aviso por aquí${perkLine(config, booking)}`,
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
    append: `\n\nPara dejarla reservada necesitamos ${chargeText(booking)}${deposit}.\n${how}\nTu horario queda apartado ${config.holdMinutes} minutos. Cuando pagues, mándame el comprobante por aquí${perkLine(config, booking)}`,
  }
}

/** La cita está pagada (anticipo o completo): Bold la confirmó, un operador la validó o hay comprobante. */
function isPaid(booking: Booking): boolean {
  // En efectivo la cita está confirmada pero no pagada: si cancela, no hay nada que reembolsar.
  // De cortesía tampoco: no se cobró nada que reembolsar.
  return booking.paidAt > 0 || (booking.status === 'confirmed' && booking.paymentPlan !== 'cash' && booking.paymentPlan !== 'courtesy')
}

/**
 * [[REPROGRAMAR: sede · YYYY-MM-DD · HH:MM]]: mueve la cita viva conservando el pago (anticipo o sesión
 * completa) y el link de Bold, porque es la misma cita. Si el horario no está libre, ofrece otros.
 */
export async function applyReprogram(config: AppConfig, phone: string, payload: string): Promise<Applied> {
  // La cita del equipo primero, aunque ya haya pasado la hora: es la que el cliente quiere mover.
  const booking = (await teamBookingOf(phone)) ?? (await liveBookingOf(phone))
  if (!booking) return { append: '', replaceText: 'no encuentro una cita activa a tu nombre\n\nquieres que agendemos una?' }
  const [sedeRaw, day, start] = payload.split('·').map((part) => part.trim())
  const sede = (sedeRaw || booking.location).toLowerCase()
  if (!isLocation(sede) || !isDayKey(day) || !isClock(start)) {
    console.warn(`[autoreply] marca REPROGRAMAR ilegible para ${phone}: "${payload}"`)
    return { append: '', replaceText: 'para cambiarla, dime qué día y a qué hora te queda mejor' }
  }
  const result = booking.source === 'operator'
    ? await rescheduleTeamBooking(config, booking, day, start, sede)
    : await rescheduleBooking(config, booking.id, day, start, sede)
  if (!result) return { append: '', escalate: `No se encontró la cita ${booking.id} al reprogramar` }
  if (!result.ok) {
    if (result.reason === 'closed') return { append: '', replaceText: 'ese día la sede está cerrada\n\nte busco otra fecha?' }
    if (result.reason === 'cabins') return { append: '', replaceText: `en ${LOCATION_LABEL[sede]} no podemos atender a dos personas a la misma hora\n\nte sirve otra sede?` }
    const options = result.alternatives.slice(0, 4).map(clock12)
    return {
      append: '',
      replaceText: options.length
        ? `a las ${clock12(start)} no me queda espacio el ${dayLabel(day)} en ${LOCATION_LABEL[sede]}. Me quedan: ${options.join(', ')}\n\ncuál te sirve?`
        : `ese día ya no me queda espacio en ${LOCATION_LABEL[sede]}\n\nte busco otro día?`,
    }
  }
  const moved = result.booking
  // La hora de la anterior ya había pasado: la nueva es otra cita (la anterior queda para que el equipo
  // la marque) y queda enlazada al chat.
  const copied = moved.id !== booking.id
  if (copied) await attachBooking(phone, moved.id, { name: moved.name, serviceId: moved.serviceId, location: moved.location })
  // Cita del equipo: su asesor se entera por el panel y por la nota de la cita, sin pausar a Gema.
  if (moved.source === 'operator') {
    const before = `${dayLabel(booking.day)} ${clock12(booking.start)} en ${LOCATION_LABEL[booking.location]}`
    const after = `${dayLabel(moved.day)} ${clock12(moved.start)} en ${LOCATION_LABEL[moved.location]}`
    // Si la anterior decía "ya pagó", ese pago pudo usarse en la sesión anterior: que el equipo lo revise.
    const checkPayment = copied && moved.paidAt > 0 ? ` Revisar forma de pago: viene de la cita del ${before}.` : ''
    const note = copied
      ? `Agendada por el cliente por WhatsApp; viene de la cita del ${before} (esa queda para marcar asistió o no asistió).${checkPayment}`
      : `Reprogramada por el cliente por WhatsApp (antes: ${before}).`
    await annotateBooking(moved.id, `${note}${moved.notes ? `\n${moved.notes}` : ''}`)
    await noteForTeam(phone, copied
      ? `${moved.name || 'El cliente'} agendó otra cita${moved.advisor ? ` con ${moved.advisor}` : ''}: ${after} (la del ${before} queda para marcar).${checkPayment}`
      : `${moved.name || 'El cliente'} reprogramó su cita${moved.advisor ? ` con ${moved.advisor}` : ''}: ${before} → ${after}`)
  }
  const paid = isPaid(moved)
  // Cita del equipo: el pago lo maneja su asesor por fuera, Gema no lo menciona.
  const payment = moved.source === 'operator'
    ? ''
    : moved.paymentPlan === 'courtesy'
    ? 'Sigue siendo de cortesía.'
    : moved.paymentPlan === 'cash'
    ? 'El pago lo sigues haciendo en la sede el día de la cita.'
    : paid
    ? `Tu ${moved.paymentPlan === 'full' ? 'pago de la sesión completa' : 'anticipo'} queda para la nueva fecha.`
    : `Tu horario sigue apartado ${holdMinutesLeft(moved)} minutos mientras pagas.`
  return {
    append: '',
    replaceText: `Listo, ${copied ? 'te agendé tu cita' : 'cambié tu cita'} de *${serviceText(moved)}* para el ${dayLabel(moved.day)} a las ${clock12(moved.start)} en ${LOCATION_LABEL[moved.location]}.${payment ? ` ${payment}` : ''}`,
  }
}

/**
 * [[CANCELAR: motivo]]: cancela la cita viva y libera el cupo en la agenda. El dinero no lo toca Gema:
 * si la cita estaba pagada, una asesora gestiona el reembolso.
 */
export async function applyCancel(phone: string, reason: string): Promise<Applied> {
  const team = await teamBookingOf(phone)
  // Una cita que ya quedó como "no asistió" no se cancela.
  const booking = (team?.status === 'no_show' ? null : team) ?? (await liveBookingOf(phone))
  if (!booking) return { append: '', replaceText: 'no encuentro una cita activa a tu nombre' }
  const moved = await moveBooking(booking.id, 'cancelled')
  if (!moved || 'error' in moved) return { append: '', escalate: `No se pudo cancelar la cita ${booking.id}${moved && 'error' in moved ? `: ${moved.error}` : ''}` }
  await redis().hset(keys.booking(booking.id), { cancelReason: `Cancelada por la clienta${reason ? `: ${reason.slice(0, 160)}` : ''}` })
  // El chat deja de estar "agendado": ya no tiene cita.
  await redis().hdel(keys.chat(phone), 'bookingId')
  await bumpRev('chats')
  await updateChat(phone, { stage: 'open' })
  const line = `Listo, cancelé tu cita de *${serviceText(booking)}* del ${dayLabel(booking.day)} a las ${clock12(booking.start)} en ${LOCATION_LABEL[booking.location]}`
  // Cita del equipo: Gema no sabe qué se pagó por fuera; su asesor lo revisa.
  if (booking.source === 'operator') {
    return {
      append: '',
      replaceText: `${line}\n\nle aviso a tu asesor para que te escriba ${humanWhen()}`,
      escalate: `La clienta canceló la cita ${booking.id} (${booking.day} ${booking.start}) que agendó ${booking.advisor || 'un asesor'}: revisar si pagó algo por fuera`,
    }
  }
  if (!isPaid(booking)) return { append: '', replaceText: `${line}\n\nsi quieres la agendamos para otro día` }
  return {
    append: '',
    replaceText: `${line}\n\nComo ya habías pagado ${booking.deposit}, una asesora te contacta ${humanWhen()} para el reembolso`,
    escalate: `Reembolso: la clienta canceló la cita ${booking.id} (${booking.day} ${booking.start}) ya pagada (${booking.paymentPlan === 'full' ? 'sesión completa' : 'anticipo'} ${booking.deposit}${booking.paymentRef ? `, Bold ${booking.paymentRef}` : ''})`,
  }
}

/**
 * Un turno de IA para un chat. Exportada (no solo de uso interno) para que
 * scripts/simulate-chat.ts pueda correr la misma lógica inyectando un `send` falso.
 */
// `config`: solo para pruebas (probar un interruptor del panel sin encenderlo en producción).
export async function replyOnce(phone: string, { send = sendWhatsAppText, sendImage, config: testConfig }: { send?: SendFn; sendImage?: SendImageFn; config?: AppConfig } = {}) {
  const chat = await getSummary(phone)
  if (!chat) return

  // Botón "Confirmo mi cita" del recordatorio: se agradece en una línea y listo. Sin modelo (no puede
  // inventar nada ni soltar la bienvenida) y sin repetirle al cliente lo que ya sabe. Va aunque Gema esté
  // en pausa: el recordatorio sale igual y la confirmación quedaba sin respuesta ni registro (Lina María y
  // Xiomary, 22 oct, en chats que el equipo había atendido el día anterior).
  if (await answerAttendanceButton(chat, send)) return
  if (!chat.botActive) return

  // Con un envío simulado (pruebas) la imagen tampoco sale a Meta: va como texto por el mismo envío.
  const image = sendImage ?? (send === sendWhatsAppText ? sendWhatsAppImage : (to: string, _link: string, caption: string) => send(to, caption))
  const welcome = await sendWelcome(chat, send, image, testConfig)
  if (welcome === 'only') return

  // Protecciones contra gasto de cuota: si se superan, el chat pasa a una persona en vez de quedar sin respuesta.
  if (!(await rateLimit('ai-phone', phone, PER_PHONE_LIMIT, 600)).ok) {
    console.warn(`[autoreply] ${phone} superó ${PER_PHONE_LIMIT} respuestas/10 min`)
    return requestAgent(phone, 'Demasiados mensajes seguidos: Gema se pausó para cuidar la cuota')
  }
  // AI_RATE_BUCKET: las pruebas locales usan su propio contador, para no gastar el tope de producción
  // (que es compartido: una tanda de pruebas llegó a bloquear las respuestas a clientes reales).
  if (!(await rateLimit(process.env.AI_RATE_BUCKET || 'ai-global', 'all', GLOBAL_LIMIT, 3600)).ok) {
    console.warn(`[autoreply] tope global de ${GLOBAL_LIMIT} respuestas/hora alcanzado`)
    return requestAgent(phone, 'Se alcanzó el tope de respuestas de IA por hora')
  }

  const config = testConfig ?? await getConfig()
  // Cliente con número oculto: si en sus mensajes dio un celular, queda en el chat y en su cita.
  const hidden = isWhatsAppUserId(phone)
  let contactPhone = chat.contactPhone
  if (hidden && !contactPhone) {
    contactPhone = contactPhoneIn(await getHistory(phone, 12)) ?? ''
    if (contactPhone) {
      await saveContactPhone(phone, contactPhone)
      const live = await liveBookingOf(phone)
      if (live && !live.contactPhone) await updateBookingDetails(live.id, { contactPhone })
    }
  }
  // Lo que el cliente ya dijo (sede, día, franja; también en notas de voz) queda registrado y viaja al prompt.
  const recent = await getHistory(phone, 60)
  const preferences = preferencesFrom(recent, config.horizonDays)
  // Vuelve después de horas o días: Gema retoma la conversación anterior (y la lee más completa).
  const returning = welcome === 'none' ? returnNote(recent) : undefined
  const lead = { ...chat.lead, ...Object.fromEntries(Object.entries(preferences).filter(([, value]) => value)) }
  if (preferences.location !== chat.lead.location || preferences.day !== (chat.lead.day ?? '') || preferences.part !== (chat.lead.part ?? '')) {
    await saveLead(phone, preferences)
  }
  const prompt = buildSystemPrompt(config, phone, await buildPromptContext(config, phone, lead))
  // Cita que agendó un asesor: el cobro lo maneja el equipo por fuera y Gema no habla de anticipo ni de pagos.
  const teamBooking = await teamBookingOf(phone)
  let reply: string | null = null
  // La reserva salió de la lectura de respaldo: el texto del modelo no la acompaña (pedía otra cosa
  // o la daba por hecha a medias) y se reemplaza por la confirmación del servidor.
  let recoveredReserva = false
  let answeredUpTo = chat.lastInboundAt
  let history: Message[] = []
  for (let draft = 0; draft < 2; draft++) {
    history = await getHistory(phone, returning ? HISTORY_ON_RETURN : HISTORY_FOR_MODEL)
    // La bienvenida salió después del primer mensaje: para el modelo va antes, así la pregunta del
    // cliente queda al final y Gema la contesta (si no, ve su propio mensaje como el último y calla).
    if (welcome === 'answer') history = [...history.filter((message) => message.auto === WELCOME_KIND), ...history.filter((message) => message.auto !== WELCOME_KIND)]
    // Notas del servidor justo antes de responder: cuando la regla del prompt sola no bastó.
    const optOut = optOutNote(chat, history)
    const hint = (optOut ?? [
      welcome === 'answer' ? 'Nota del sistema: acabas de enviar la bienvenida automática (las promociones 2x1, precios, el ritual de 5 pasos, el anticipo, la cortesía y horarios libres). No repitas nada de eso: responde solo lo que preguntó y no está ahí, en una o dos frases, y termina preguntando cuál de esos horarios le separas.' : '',
      welcome === 'none' ? lateNote(history) : '',
      returning ?? '',
      teamBooking ? teamNote(teamBooking) : '',
      hidden && !contactPhone ? HIDDEN_NUMBER_NOTE : '',
      serviceHint(config, history),
      serviceChoiceNote(config, history),
      teamBooking ? '' : paymentNote(history, config.cashBooking, config.depositPerk.trim()),
      // La agenda real del día y la sede que pregunta (20 oct: dijo "no hay espacio" en Chipichape y sí había).
      await availabilityNote(config, history, chat.lead).catch((error) => {
        console.warn(`[autoreply] ${phone}: no se pudo verificar la agenda pedida:`, error instanceof Error ? error.message : error)
        return undefined
      }),
    ].filter(Boolean).join('\n')) || undefined
    if (hint && draft === 0) console.log(`[autoreply] ${phone}: nota del servidor → ${hint.slice(0, 160)}`)
    try {
      reply = await generateReply(prompt, history, hint).catch((error) => {
        console.warn(`[autoreply] reintentando ${phone}:`, error instanceof Error ? error.message : error)
        return generateReply(prompt, history, hint)
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
  // no se aparta nada. Pedirle la marca otra vez fallaba a menudo; en cambio, una lectura aparte de la
  // conversación con salida estructurada saca servicio, sede, día, hora y nombre. Si algo falta, no
  // reserva y actúa la red de abajo (mensaje honesto + asesora).
  // La cita VIVA del cliente (chat.bookingId queda apuntando a la última aunque se cancele o venza).
  const liveAtStart = await liveBookingOf(phone)
  const today = dayKey()
  const extractOptions = {
    services: config.services.map(({ id, label }) => ({ id, label })),
    locations: LOCATIONS.map((location) => ({ id: location, label: LOCATION_LABEL[location] })),
    today,
    todayLabel: dayLabel(today),
    calendar: Array.from({ length: config.horizonDays }, (_, index) => addDays(today, index)).map((day) => `${day} = ${dayLabel(day)}`),
  }
  // Cita del equipo: el cliente ya eligió día y hora y el modelo no reprogramó (le pedía el nombre como a
  // un cliente nuevo, o decía que no había espacio con la agenda libre; pruebas del 23 oct). La misma
  // lectura estructurada saca la hora elegida y el servidor reprograma: la respuesta la compone él.
  const lastClient = [...history].reverse().find((message) => message.sender === 'user')?.text ?? ''
  if (teamBooking && !/\[\[\s*(REPROGRAMAR|CANCELAR|ASESOR|PAGO)\b/i.test(reply) && PICKS_TIME.test(lastClient)) {
    // Sin el borrador del modelo (que pudo negar la hora) y con lo que ya se sabe de la cita.
    const known: Message = { id: 'cita', sender: 'user', text: `Soy ${teamBooking.name || 'el cliente'}, es para mi cita de ${teamBooking.serviceLabel} en ${LOCATION_LABEL[teamBooking.location]}`, at: 0 }
    const picked = await extractReserva([known, ...history], extractOptions).catch(() => null)
    if (picked && isLocation(picked.sede) && isDayKey(picked.fecha) && isClock(picked.hora) && history.some((message) => message.sender === 'user' && message.text.includes(String(Number(picked.hora.slice(0, 2)) % 12 || 12)))) {
      console.warn(`[autoreply] ${phone}: cita del equipo ${teamBooking.id}: el cliente eligió ${picked.fecha} ${picked.hora} y el modelo no reprogramó; se reprograma`)
      reply = `${reply}\n[[REPROGRAMAR: ${picked.sede} · ${picked.fecha} · ${picked.hora}]]`
    }
  }
  // El cliente pidió un día, hora y sede concretos, la agenda dice que están libres y el modelo dijo que
  // no había espacio (Nana, 23 oct: miércoles 28 a las 3 p.m. en Chipichape, con la agenda vacía, aunque la
  // nota del servidor decía "SÍ hay espacio"). El servidor lo comprueba y responde con la verdad.
  if (!teamBooking && DENIES_SPACE.test(reply)) {
    const clientSaid = history.filter((message) => message.sender === 'user').slice(-8).map((message) => message.text)
    const pair = latestOf(clientSaid, [[SAYS_PAIR, 'pair'], [SAYS_ALONE, 'alone']] as Array<[RegExp, 'pair' | 'alone']>) === 'pair'
    const slot = await askedSlot(config, history, lead, { people: pair ? 2 : 1 }).catch(() => null)
    if (slot?.free) {
      console.warn(`[autoreply] ${phone}: el modelo dijo que no había espacio el ${slot.day} a las ${slot.start} en ${slot.location} y sí hay; se corrige`)
      reply = `sí, el ${dayLabel(slot.day)} a las ${clock12(slot.start)} en ${LOCATION_LABEL[slot.location]} está libre ✨${SEPARATOR}te lo separo?`
    }
  }
  if (!teamBooking && forgotReserva(reply, liveAtStart?.id, config.cashBooking)) {
    const extracted = await extractReserva([...history, { id: 'draft', sender: 'gem', text: reply.replace(MARKERS, ''), at: Date.now() }], extractOptions).catch((error) => {
      console.warn(`[autoreply] ${phone}: no se pudo leer la reserva de la conversación:`, error instanceof Error ? error.message : error)
      return null
    })
    const grounded = extracted !== null && groundedInChat(extracted, history)
    console.warn(`[autoreply] ${phone}: el modelo dio la cita por hecha sin [[RESERVA]]; datos leídos: ${extracted ? JSON.stringify(extracted) : 'incompletos'}${extracted && !grounded ? ' (descartados: nombre u hora no los dio el cliente)' : ''}`)
    if (extracted && grounded) {
      const companion = extracted.acompanante && isRealName(extracted.acompanante) && fold(history.filter((message) => message.sender === 'user').map((message) => message.text).join(' ')).includes(fold(extracted.acompanante.split(/\s+/)[0]))
        ? `\n[[PAREJA: ${extracted.acompanante}]]`
        : ''
      reply = `${reply}\n[[RESERVA: ${extracted.servicio} · ${extracted.sede} · ${extracted.fecha} · ${extracted.hora} · ${extracted.nombre}]]${companion}`
      recoveredReserva = true
    }
  }

  const markers = [...reply.matchAll(MARKERS)].map((marker) => ({ kind: marker[1].toUpperCase(), payload: (marker[2] ?? '').trim() }))
  // Lo que viene del modelo pasa por la red de datos de pago; lo que añade el servidor después, no.
  // Después se parte en mensajes (|||) y se le da la puntuación de WhatsApp; los textos del servidor
  // se unen con el mismo separador y viajan enteros.
  // Con [[EFECTIVO]] el "lo confirmo con la sede y te escribo" es verdad: no se quita como relleno.
  const keepLater = markers.some((marker) => marker.kind === 'EFECTIVO')
  let text = stripWrongPromo(config, phone, styleModelText(stripInventedPaymentData(phone, reply.replace(MARKERS, '').trim()), { keepLater }))

  // FICHA es silenciosa: solo enriquece el panel y el prompt de la próxima vuelta.
  const ficha = markers.find((marker) => marker.kind === 'FICHA')
  if (ficha) {
    const parsed = parseFicha(ficha.payload)
    await saveLead(phone, { ...parsed, location: preferences.location || parsed.location })
  }

  // La reserva se intenta antes de enviar: el texto que sale ya refleja lo que de verdad pasó.
  const cash = markers.some((marker) => marker.kind === 'EFECTIVO')
  let escalation = markers.find((marker) => marker.kind === 'PAGO')
    ?? (cash && !config.cashBooking ? { kind: 'ASESOR', payload: CASH_REASON } : undefined)
    ?? markers.find((marker) => marker.kind === 'ASESOR')
  // Se mide cuántos clientes frenan por querer pagar en efectivo (la primera objeción queda en el chat).
  if (cash || history.filter((message) => message.sender === 'user').slice(-3).some((message) => saysCash(message.text))) {
    await setObjection(phone, 'efectivo')
  }
  const reserva = markers.find((marker) => marker.kind === 'RESERVA')
  const clientTexts = history.filter((message) => message.sender === 'user').slice(-8).map((message) => message.text)
  // Cómo quiere pagar y con quién viene, según lo que ESCRIBIÓ el cliente (gana lo último que dijo).
  // Las marcas del modelo solo cuentan si el cliente no dijo nada al respecto.
  const methodChoice = latestOf(clientTexts, [[WANTS_TRANSFER, 'transfer'], [SAYS_LINK, 'link']] as Array<[RegExp, 'transfer' | 'link']>)
  const planChoice = latestOf(clientTexts, [[SAYS_FULL, 'full'], [SAYS_DEPOSIT, 'deposit']] as Array<[RegExp, 'full' | 'deposit']>)
  const pairChoice = latestOf(clientTexts, [[SAYS_PAIR, 'pair'], [SAYS_ALONE, 'alone']] as Array<[RegExp, 'pair' | 'alone']>)
  // Con config.cashBooking, quien quiere pagar en efectivo se agenda sin anticipo. Gana lo último que
  // dijo el cliente: si después pidió el link, transferir o dejar el anticipo, ya no es efectivo.
  // "el resto lo pago allá" no cuenta como efectivo: acepta el anticipo y pregunta por el saldo.
  const cashTexts = clientTexts.map((text) => (CASH_REMAINDER.test(text) ? text.replace(new RegExp(SAYS_CASH.source, 'gi'), ' ') : text))
  const cashChoice = latestOf(cashTexts, [[SAYS_CASH, 'cash'], [INSISTS_CASH, 'cash'], [WANTS_TRANSFER, 'other'], [SAYS_LINK, 'other'], [SAYS_DEPOSIT, 'other']] as Array<[RegExp, 'cash' | 'other']>)
  const payCash = config.cashBooking && (cashChoice === 'cash' || (cash && !cashChoice))
  // El modelo a veces "entrega" los datos de pago él mismo (con un relleno entre corchetes) en vez de
  // usar la marca: se trata igual que [[TRANSFERENCIA]] y los datos reales los pega el servidor.
  const writesPaymentData = PROMISES_PAYMENT_DATA.test(text) || BRACKET_PLACEHOLDER.test(text)
  const transferMarker = markers.some((marker) => marker.kind === 'TRANSFERENCIA')
  // Al reservar basta con que el cliente haya pedido transferir; fuera de una reserva, además el
  // modelo tiene que estar entregando los datos (si no, solo está respondiendo "sí, aceptamos Nequi").
  // Si todavía está pidiendo el nombre ("me das tu nombre y te envío los datos"), no hay nada que
  // entregar aún: se deja seguir la conversación.
  //
  // Respuesta a "cómo prefieres pagar, con el link o por transferencia?": con una cita apartada, sin
  // pagar y sin medio entregado todavía, decide lo que dice el cliente en su ÚLTIMO mensaje.
  const lastClientText = clientTexts.at(-1) ?? ''
  const answerChoice = latestOf([lastClientText], [[WANTS_TRANSFER, 'transfer'], [SAYS_LINK, 'link']] as Array<[RegExp, PayMethod]>)
  const held = !reserva && answerChoice && !SAYS_PAID.test(lastClientText) ? await liveBookingOf(phone) : null
  const pendingHold = held && HOLD_STATUSES.includes(held.status) && !held.paidAt ? held : null
  const transferSentRecently = history.slice(-8).some((message) => message.sender !== 'user' && message.text.includes('Puedes transferir'))
  const transfer = reserva
    ? methodChoice === 'transfer'
    : ((transferMarker || writesPaymentData) && methodChoice === 'transfer' && !ASKS_FOR_NAME.test(text))
      || Boolean(pendingHold && answerChoice === 'transfer' && !transferSentRecently)
  const linkChosen = Boolean(pendingHold && answerChoice === 'link' && !pendingHold.paymentLink)
  if (reserva) text = stripModelAmounts(phone, text)
  else {
    const promo = missingPromo(config, text)
    if (promo) text = insertAfter(text, promo.price, promo.line)
  }
  const pareja = markers.find((marker) => marker.kind === 'PAREJA')
  const reprogramar = markers.find((marker) => marker.kind === 'REPROGRAMAR')
  const cancelar = markers.find((marker) => marker.kind === 'CANCELAR')
  const payFull = planChoice ? planChoice === 'full' : markers.some((marker) => marker.kind === 'COMPLETO')
  // Botón "Enviar link" de la plantilla anticipo_pendiente: no depende de que el modelo ponga la marca.
  const link = markers.some((marker) => marker.kind === 'LINK') || /^\s*(re)?enviar (el )?link\s*$/i.test(lastClientText)
  let applied: Applied | null = null
  // Cliente del equipo que no alcanzó a venir: la "nueva" cita es la suya en otra fecha, sin anticipo.
  const missedTeam = reserva && teamBooking && !liveAtStart ? parseReserva(reserva.payload) : null
  if (missedTeam) {
    console.warn(`[autoreply] ${phone}: [[RESERVA]] con una cita del equipo pendiente (${teamBooking!.id}); se reprograma esa`)
    applied = await applyReprogram(config, phone, `${missedTeam.sede} · ${missedTeam.day} · ${missedTeam.start}`)
  } else if (reserva) {
    // Acompañante: el de la marca; si el modelo la olvidó pero el cliente dijo que viene con alguien,
    // la cita es para dos y applyReserva pide el nombre que falta ('' = pareja sin nombre todavía).
    const companion = pareja && pairChoice !== 'alone'
      ? (pareja.payload === '-' ? '' : pareja.payload.slice(0, 80))
      : pairChoice === 'pair' ? '' : null
    if ((companion !== null) !== Boolean(pareja) || payFull !== markers.some((marker) => marker.kind === 'COMPLETO') || transfer !== transferMarker) {
      console.warn(`[autoreply] ${phone}: reserva ajustada a lo que dijo el cliente (pareja ${companion !== null}, completo ${payFull}, transferencia ${transfer})`)
    }
    applied = await applyReserva(config, phone, reserva.payload, { method: methodChoice, companion, payFull: payFull && !payCash, cash: payCash })
  } else if (reprogramar) {
    applied = await applyReprogram(config, phone, reprogramar.payload)
  } else if (cancelar) {
    applied = await applyCancel(phone, cancelar.payload)
  } else if (teamBooking && (transfer || link || linkChosen || writesPaymentData || PROMISES_LINK.test(text) || TALKS_PAYMENT.test(text))) {
    // Red de seguridad de las citas del equipo: ni link, ni datos de cuenta, ni anticipo. Lo ve su asesor.
    const advisor = teamBooking.advisor.split(' ')[0]
    applied = {
      append: '',
      replaceText: `lo del pago de tu cita lo ve directamente ${advisor || 'tu asesor'} contigo\n\nle aviso para que te escriba ${humanWhen()}`,
      escalate: `Cita agendada por ${teamBooking.advisor || 'un asesor'}: el cliente habla del pago y Gema no lo maneja`,
    }
  } else if (transfer) {
    // El mensaje lo compone entero el servidor: el texto del modelo en este paso es justo donde
    // tiende a inventarse números y titulares.
    const booking = await liveBookingOf(phone)
    if (booking && HOLD_STATUSES.includes(booking.status)) {
      const result = transferAppend(config, booking)
      applied = { ...result, replaceText: `Claro${result.append}` }
    } else {
      // Todavía no hay cita: lo que falta casi siempre es el nombre (la lectura de la conversación ya
      // lo intentó arriba). Se le pide en vez de pasar a una asesora; con el nombre se reserva.
      applied = { append: '', replaceText: 'claro, puedes pagar por transferencia\n\nme das tu nombre completo para dejar la cita apartada?' }
    }
  } else if (link || linkChosen || PROMISES_LINK.test(text)) {
    applied = await resendLink(config, phone, { implicit: !link && !linkChosen })
    // Si el cliente acaba de elegir el link, el servidor contesta solo: el texto del modelo repetía
    // lo mismo ("aquí va el link para pagar con...").
    if (linkChosen && applied.append) applied = { ...applied, replaceText: `Listo${applied.append}` }
  }
  if (applied) {
    // Lo del servidor (el link, las cuentas, los montos) va en su propio mensaje y nunca se parte:
    // los "\n\n" que separan sus bloques pasan a ser separadores de mensaje.
    const server = (value: string) => value.trim().replace(/\n\n/g, SEPARATOR)
    text = applied.replaceText !== undefined
      ? server(applied.replaceText)
      : [(recoveredReserva ? '' : text) || applied.summary || '', server(applied.append)].filter(Boolean).join(SEPARATOR)
    if (applied.escalate) escalation = { kind: 'ASESOR', payload: applied.escalate }
  }

  // Red de seguridad: el modelo a veces "confirma" una cita en el texto sin emitir [[RESERVA]].
  // Sin esto el cliente se queda creyendo que tiene un horario que el sistema nunca creó, y
  // nadie se entera. Mejor escalar a una persona que dejar pasar una confirmación fantasma.
  if (!reserva && !applied && !escalation && !liveAtStart && SOUNDS_BOOKED.test(text) && !ASKS_FOR_NAME.test(text)) {
    escalation = { kind: 'ASESOR', payload: 'Gema pareció confirmar una cita sin generar la marca de reserva' }
    // El texto del modelo daba la cita por hecha (y a veces traía "[datos de Nequi aquí]" de
    // relleno): se cambia por uno honesto, porque la cita todavía no existe.
    text = `Gracias, ya tengo tus datos${SEPARATOR}Una asesora termina de agendar tu cita y te comparte cómo pagar ${humanWhen()}`
  }
  // Igual con un cambio de horario: dice que la movió sin [[REPROGRAMAR]] y la cita sigue donde estaba.
  if (!applied && !escalation && liveAtStart && CLAIMS_RESCHEDULE.test(text)) {
    escalation = { kind: 'ASESOR', payload: `Gema dijo que cambió la cita ${liveAtStart.id} sin hacerlo` }
    text = `Para no equivocarme con el cambio, una asesora te lo confirma ${humanWhen()}`
  }
  // El cliente confirmó que asiste (botón "Confirmo mi cita" del recordatorio, o la marca de Gema).
  if ((markers.some((marker) => marker.kind === 'ASISTE') || CONFIRMS_ATTENDANCE.test(lastClientText)) && liveAtStart?.status === 'confirmed' && !liveAtStart.attendanceConfirmedAt) {
    await confirmAttendance(liveAtStart.id)
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
  if (escalation?.kind === 'PAGO' && liveAtStart) await markDepositClaimed(liveAtStart.id, config)

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
