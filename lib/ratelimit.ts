import { hasRedis, keys, redis } from './redis'

export type RateResult = { ok: boolean; remaining: number; resetIn: number }

/**
 * Ventana fija sobre Redis (INCR + EXPIRE). Compatible con Edge, así que sirve también en el middleware.
 * Si Redis no está configurado deja pasar: la autenticación sigue protegiendo la app.
 */
export async function rateLimit(bucket: string, id: string, limit: number, windowSeconds: number): Promise<RateResult> {
  if (!hasRedis()) return { ok: true, remaining: limit, resetIn: 0 }
  const now = Math.floor(Date.now() / 1000)
  const window = Math.floor(now / windowSeconds)
  const key = keys.rate(bucket, id, window)
  const [count] = await redis().multi().incr(key).expire(key, windowSeconds).exec<[number, number]>()
  return { ok: count <= limit, remaining: Math.max(0, limit - count), resetIn: (window + 1) * windowSeconds - now }
}

export function clientIp(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'unknown'
}
