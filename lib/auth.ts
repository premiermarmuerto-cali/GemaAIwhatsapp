// Sesión firmada con HMAC usando Web Crypto: funciona igual en Edge (middleware) y en Node (rutas).

export const SESSION_COOKIE = 'hg_session'
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

const encoder = new TextEncoder()

function sessionSecret(): string | null {
  return process.env.AUTH_SECRET || process.env.ADMIN_PASSWORD || null
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Comparación en tiempo constante para strings de igual longitud (los HMAC hex siempre lo son). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function createSession(): Promise<string> {
  const secret = sessionSecret()
  if (!secret) throw new Error('ADMIN_PASSWORD no está configurada.')
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  return `${expires}.${await hmacHex(secret, `session:${expires}`)}`
}

export async function verifySession(token: string | undefined): Promise<boolean> {
  const secret = sessionSecret()
  if (!secret || !token) return false
  const [expires, signature] = token.split('.')
  if (!expires || !signature || Number(expires) < Date.now() / 1000) return false
  return safeEqual(signature, await hmacHex(secret, `session:${expires}`))
}

/** Compara la contraseña pasando ambas por HMAC para no filtrar su longitud por tiempos. */
export async function checkPassword(candidate: string): Promise<boolean> {
  const password = process.env.ADMIN_PASSWORD
  if (!password) return false
  const pepper = 'hg-password-check'
  return safeEqual(await hmacHex(pepper, candidate), await hmacHex(pepper, password))
}
