import { NextResponse } from 'next/server'
import { isValidPhone, normalizePhone } from './phone'
import { ConfigError } from './redis'
import { WhatsAppError } from './whatsapp'

export type PhoneParams = { params: Promise<{ phone: string }> }

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

/** Envuelve un handler: traduce errores conocidos a respuestas JSON con el status correcto. */
export function route<A extends unknown[]>(handler: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args)
    } catch (error) {
      if (error instanceof HttpError) return fail(error.status, error.message)
      if (error instanceof ConfigError) return fail(503, error.message)
      if (error instanceof WhatsAppError) return fail(502, error.message)
      console.error('[api]', error)
      return fail(500, 'Error interno del servidor.')
    }
  }
}

export async function phoneFrom({ params }: PhoneParams): Promise<string> {
  const phone = normalizePhone(decodeURIComponent((await params).phone))
  if (!isValidPhone(phone)) throw new HttpError(400, 'Número de teléfono inválido.')
  return phone
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON inválido.')
  return body as Record<string, unknown>
}
