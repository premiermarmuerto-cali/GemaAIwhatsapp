import { NextResponse } from 'next/server'
import { checkPassword, createSession, SESSION_COOKIE, SESSION_TTL_SECONDS } from '@/lib/auth'
import { fail } from '@/lib/http'
import { clientIp, rateLimit } from '@/lib/ratelimit'

const MAX_ATTEMPTS = 5
const WINDOW_SECONDS = 15 * 60

export async function POST(request: Request) {
  if (!process.env.ADMIN_PASSWORD) return fail(503, 'ADMIN_PASSWORD no está configurada en el servidor.')

  const limit = await rateLimit('login', clientIp(request.headers), MAX_ATTEMPTS, WINDOW_SECONDS)
  if (!limit.ok) return fail(429, `Demasiados intentos. Prueba de nuevo en ${Math.ceil(limit.resetIn / 60)} min.`)

  const body = await request.json().catch(() => null) as { password?: unknown } | null
  if (typeof body?.password !== 'string' || !(await checkPassword(body.password))) return fail(401, 'Contraseña incorrecta.')

  const response = NextResponse.json({ ok: true })
  response.cookies.set(SESSION_COOKIE, await createSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
  return response
}
