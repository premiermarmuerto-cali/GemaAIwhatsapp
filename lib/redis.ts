import { Redis } from '@upstash/redis'
import type { BookingStatus, Location } from './types'

let client: Redis | null = null

export class ConfigError extends Error {}

/**
 * Cliente único de Upstash. La deserialización automática está desactivada a propósito:
 * con ella, un mensaje como "123" volvería como número. Todo se guarda y se lee como string.
 */
export function redis(): Redis {
  if (client) return client
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new ConfigError('Upstash Redis no está configurado (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).')
  client = new Redis({ url, token, automaticDeserialization: false })
  return client
}

/**
 * Sin deserialización automática, HGETALL llega como lista plana [campo, valor, campo, valor…].
 * Devuelve null si el hash no existe.
 */
export function toHash(raw: unknown): Record<string, string> | null {
  if (Array.isArray(raw)) {
    if (!raw.length) return null
    const hash: Record<string, string> = {}
    for (let i = 0; i < raw.length; i += 2) hash[String(raw[i])] = String(raw[i + 1])
    return hash
  }
  return raw && typeof raw === 'object' && Object.keys(raw).length ? raw as Record<string, string> : null
}

export function hasRedis(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

/**
 * Todo el estado del sistema vive en Upstash. Prefijo `pm:` (Premier Mar Muerto).
 *
 * Conversación
 *   chat          Hash   ficha del chat: nombre, estado del bot, lead extraído, cita viva…
 *   messages      List   historial completo (la memoria que recibe el modelo), recortado a 500
 *   box           ZSet   bandeja ordenada por última actividad; el miembro es el teléfono
 *   config        String JSON con el prompt, el catálogo, el horario y el link de pago
 *   stats         Hash   contadores del día contable
 *
 * Agenda — la ocupación de cabina vive en UN solo sitio: `slots`.
 *   slots         Hash   "HH:MM#<cabina>" -> bookingId. Reservar es escribir campos que no existan.
 *   booking       Hash   datos completos de una cita
 *   day           ZSet   bookingIds del día (todas las sedes) ordenados por minuto de inicio
 *   byStatus      ZSet   bookingIds por estado, ordenados por epoch de inicio (colas del panel)
 *   byPhone       List   historial de citas de un cliente
 *   holds         ZSet   bookingIds con horario apartado sin pagar, ordenados por holdUntil
 *   closed        String día cerrado manualmente; el valor es el motivo
 */
/**
 * Prefijo de todas las llaves. En producción es `pm:`. Las pruebas locales usan otro
 * (REDIS_KEY_PREFIX=pmtest:) para que sus chats, citas y agenda no aparezcan en el panel ni ocupen
 * cabinas reales: un chat de prueba borrado mientras alguien lo miraba dejó la consola en blanco
 * (20 oct). Se lee en cada uso, así una prueba puede cambiarlo después de cargar el .env.
 */
const prefix = () => process.env.REDIS_KEY_PREFIX || 'pm:'

export const keys = {
  chat: (phone: string) => `${prefix()}chat:${phone}`,
  messages: (phone: string) => `${prefix()}chat:${phone}:msgs`,
  box: (box: 'inbox' | 'archived') => `${prefix()}box:${box}`,
  get config() { return `${prefix()}config` },
  stats: (day: string) => `${prefix()}stats:${day}`,
  seen: (waMessageId: string) => `${prefix()}wa:seen:${waMessageId}`,
  replyLock: (phone: string) => `${prefix()}lock:reply:${phone}`,
  replyPending: (phone: string) => `${prefix()}pending:reply:${phone}`,
  mediaInfo: (mediaId: string) => `${prefix()}media:${mediaId}`,
  mediaBin: (mediaId: string) => `${prefix()}media:${mediaId}:bin`,
  mediaBusy: (phone: string) => `${prefix()}media:busy:${phone}`,
  rate: (bucket: string, id: string, window: number) => `${prefix()}rl:${bucket}:${id}:${window}`,

  slots: (location: Location, day: string) => `${prefix()}slots:${location}:${day}`,
  booking: (id: string) => `${prefix()}booking:${id}`,
  day: (day: string) => `${prefix()}day:${day}`,
  byStatus: (status: BookingStatus) => `${prefix()}bookings:status:${status}`,
  byPhone: (phone: string) => `${prefix()}bookings:phone:${phone}`,
  get holds() { return `${prefix()}holds` },
  closed: (day: string) => `${prefix()}closed:${day}`,

  /** Candado de una corrida de lib/automations.ts (no corren dos a la vez). */
  get automationsLock() { return `${prefix()}lock:automations` },
  // Bold: notificaciones de pago recibidas (las últimas 200) y deduplicación por id de evento.
  get boldEvents() { return `${prefix()}bold:events` },
  /** Entregas del webhook de WhatsApp que no se procesaron (últimas 200). */
  get webhookRejected() { return `${prefix()}wa:rejected` },
  /** Eventos enviados a la API de conversiones de Meta: evita duplicados por event_id. */
  capiSent: (eventId: string) => `${prefix()}capi:sent:${eventId}`,
  /** Registro de envíos a la API de conversiones (últimos 200), con la respuesta de Meta. */
  get capiLog() { return `${prefix()}capi:log` },
  boldSeen: (eventId: string) => `${prefix()}bold:seen:${eventId}`,
}
