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
export const keys = {
  chat: (phone: string) => `pm:chat:${phone}`,
  messages: (phone: string) => `pm:chat:${phone}:msgs`,
  box: (box: 'inbox' | 'archived') => `pm:box:${box}`,
  config: 'pm:config',
  stats: (day: string) => `pm:stats:${day}`,
  seen: (waMessageId: string) => `pm:wa:seen:${waMessageId}`,
  replyLock: (phone: string) => `pm:lock:reply:${phone}`,
  replyPending: (phone: string) => `pm:pending:reply:${phone}`,
  mediaInfo: (mediaId: string) => `pm:media:${mediaId}`,
  mediaBin: (mediaId: string) => `pm:media:${mediaId}:bin`,
  mediaBusy: (phone: string) => `pm:media:busy:${phone}`,
  rate: (bucket: string, id: string, window: number) => `pm:rl:${bucket}:${id}:${window}`,

  slots: (location: Location, day: string) => `pm:slots:${location}:${day}`,
  booking: (id: string) => `pm:booking:${id}`,
  day: (day: string) => `pm:day:${day}`,
  byStatus: (status: BookingStatus) => `pm:bookings:status:${status}`,
  byPhone: (phone: string) => `pm:bookings:phone:${phone}`,
  holds: 'pm:holds',
  closed: (day: string) => `pm:closed:${day}`,
}
