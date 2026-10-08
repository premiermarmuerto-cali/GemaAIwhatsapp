import { generateReply } from './ai'
import { createBooking, markDepositClaimed } from './booking'
import { dayLabel, isClock, isDayKey } from './calendar'
import { isLocation, LOCATION_LABEL } from './clinic'
import { attachBooking, getHistory, getSummary, recordOutbound, requestAgent, saveLead } from './chats'
import { getConfig, paymentFor, serviceById } from './config'
import { mediaBusy } from './media'
import { regionOf } from './phone'
import { buildPromptContext, buildSystemPrompt } from './prompt'
import { rateLimit } from './ratelimit'
import { keys, redis } from './redis'
import { sendWhatsAppText } from './whatsapp'
import type { AppConfig, Location } from './types'

const HISTORY_FOR_MODEL = 30
// Espera a que el cliente termine de escribir: varios mensajes seguidos reciben una sola respuesta (cada envío se cobra).
const DEBOUNCE_MS = 4000
const MEDIA_WAIT_MS = 30_000
const LOCK_SECONDS = 90
const MAX_TURNS = 3
const PENDING_SECONDS = 600
const PER_PHONE_LIMIT = Number(process.env.AI_MAX_REPLIES_PER_PHONE) || 15 // por cada 10 min
const GLOBAL_LIMIT = Number(process.env.AI_MAX_REPLIES_PER_HOUR) || 300

/**
 * Marcas con las que Gema actúa sobre el sistema; el cliente nunca las ve.
 *   FICHA   datos del prospecto (no interrumpe la conversación)
 *   RESERVA aparta la cabina y dispara el cobro del anticipo
 *   PAGO    llegó el comprobante → una persona lo valida
 *   ASESOR  todo lo demás que necesita una persona
 */
const MARKERS = /\[\[\s*(ASESOR|PAGO|RESERVA|FICHA)\s*(?::([^\]]*))?\]\]/gi

// Frases con las que el modelo a veces da una cita por hecha sin haber emitido [[RESERVA]].
const SOUNDS_BOOKED = /\b(te agend[eoé]|qued[oóa]s?\s+agendad|cita\s+qued[oó]|confirmo\s+tu\s+cita|ya\s+(est[aá]s?|qued[oó])\s+reservad)/i

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
async function applyReserva(config: AppConfig, phone: string, payload: string): Promise<{ append: string; escalate?: string }> {
  const parsed = parseReserva(payload)
  if (!parsed) {
    console.warn(`[autoreply] marca RESERVA ilegible para ${phone}: "${payload}"`)
    return { append: '', escalate: 'Gema intentó agendar con datos incompletos' }
  }

  const service = serviceById(config, parsed.servicio)
  if (!service) return { append: '', escalate: `Gema pidió un servicio que no existe: "${parsed.servicio}"` }
  if (!isLocation(parsed.sede)) return { append: '', escalate: `Gema pidió una sede que no existe: "${parsed.sede}"` }
  if (!service.price) return { append: '', escalate: `El precio de ${service.label} no está configurado` }

  const chat = await getSummary(phone)
  const result = await createBooking(config, {
    phone,
    name: parsed.name || chat?.name || '',
    location: parsed.sede,
    serviceId: service.id,
    day: parsed.day,
    start: parsed.start,
    concern: chat?.lead.concern ?? '',
    source: 'bot',
  })

  if (!result.ok) {
    if (result.reason === 'taken') {
      const options = result.alternatives.slice(0, 4)
      return {
        append: options.length
          ? `\n\nEse horario se acaba de ocupar 😔 Para ${dayLabel(parsed.day)} en ${LOCATION_LABEL[parsed.sede]} me quedan: ${options.join(', ')}. ¿Cuál te sirve?`
          : '\n\nEse horario se acaba de ocupar y ese día ya no me queda espacio. ¿Te busco otro día?',
      }
    }
    if (result.reason === 'closed') return { append: `\n\nEse día la sede está cerrada. ¿Te busco otra fecha?` }
    return { append: '', escalate: 'No se pudo crear la cita' }
  }

  const { booking } = result
  await attachBooking(phone, booking.id, { name: booking.name, serviceId: booking.serviceId, location: booking.location })

  // El cobro lo escribe el servidor, nunca el modelo: los datos salen de la config,
  // según el país del número (misma lógica por región que la consola original).
  const payment = paymentFor(config, regionOf(phone))
  if (!payment.configured) {
    return { append: '', escalate: `Cita ${booking.id} apartada, pero los datos de cobro de ${regionOf(phone)} no están configurados` }
  }

  const deposit = booking.deposit ? ` de ${booking.deposit}` : ''
  const how = [
    config.payLink && `Link de pago: ${config.payLink}`,
    payment.instructions,
  ].filter(Boolean).join('\n')
  return {
    append: `\n\nPara dejarla reservada necesitamos el anticipo${deposit}.\n${how}\nTu horario queda apartado ${config.holdMinutes} minutos. Cuando pagues, envíame el comprobante por aquí 💛`,
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
  for (let draft = 0; draft < 2; draft++) {
    const history = await getHistory(phone, HISTORY_FOR_MODEL)
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

  const markers = [...reply.matchAll(MARKERS)].map((marker) => ({ kind: marker[1].toUpperCase(), payload: (marker[2] ?? '').trim() }))
  let text = reply.replace(MARKERS, '').trim()

  // FICHA es silenciosa: solo enriquece el panel y el prompt de la próxima vuelta.
  const ficha = markers.find((marker) => marker.kind === 'FICHA')
  if (ficha) await saveLead(phone, parseFicha(ficha.payload))

  // La reserva se intenta antes de enviar: el texto que sale ya refleja lo que de verdad pasó.
  let escalation = markers.find((marker) => marker.kind === 'PAGO') ?? markers.find((marker) => marker.kind === 'ASESOR')
  const reserva = markers.find((marker) => marker.kind === 'RESERVA')
  if (reserva) {
    const applied = await applyReserva(config, phone, reserva.payload)
    text += applied.append
    if (applied.escalate) escalation = { kind: 'ASESOR', payload: applied.escalate }
  }

  // Red de seguridad: el modelo a veces "confirma" una cita en el texto sin emitir [[RESERVA]].
  // Sin esto el cliente se queda creyendo que tiene un horario que el sistema nunca creó, y
  // nadie se entera. Mejor escalar a una persona que dejar pasar una confirmación fantasma.
  if (!reserva && !escalation && !chat.bookingId && SOUNDS_BOOKED.test(text)) {
    escalation = { kind: 'ASESOR', payload: 'Gema pareció confirmar una cita sin generar la marca de reserva' }
  }

  // El cliente dice que pagó: el horario no se puede caer mientras el operador revisa.
  if (escalation?.kind === 'PAGO' && chat.bookingId) await markDepositClaimed(chat.bookingId, config)

  if (text) {
    try {
      const waId = await send(phone, text)
      await recordOutbound(phone, { id: waId ?? crypto.randomUUID(), sender: 'gem', text, at: Date.now() })
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
