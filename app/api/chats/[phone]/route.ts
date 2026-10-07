import { NextResponse } from 'next/server'
import { getSummary, recordOutbound } from '@/lib/chats'
import { HttpError, jsonBody, phoneFrom, route, type PhoneParams } from '@/lib/http'
import type { Message } from '@/lib/types'
import { isWindowOpen } from '@/lib/window'
import { sendWhatsAppText } from '@/lib/whatsapp'

export const runtime = 'nodejs'

const MAX_LENGTH = 4096

/** Envío manual del operador: sale por WhatsApp y pausa la IA del chat. */
export const POST = route(async (request: Request, context: PhoneParams) => {
  const phone = await phoneFrom(context)
  const body = await jsonBody(request)
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) throw new HttpError(400, 'El mensaje está vacío.')
  if (text.length > MAX_LENGTH) throw new HttpError(400, `El mensaje supera ${MAX_LENGTH} caracteres.`)

  const chat = await getSummary(phone)
  if (!chat) throw new HttpError(404, 'Conversación no encontrada.')
  if (!isWindowOpen(chat)) throw new HttpError(409, 'Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo permite plantillas aprobadas.')

  const waId = await sendWhatsAppText(phone, text)
  const message: Message = { id: waId ?? crypto.randomUUID(), sender: 'human', text, at: Date.now() }
  await recordOutbound(phone, message)
  return NextResponse.json({ message, chat: await getSummary(phone) })
})
