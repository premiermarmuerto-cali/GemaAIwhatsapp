import { NextResponse } from 'next/server'
import { getSummary } from '@/lib/chats'
import { HttpError, jsonBody, phoneFrom, route, type PhoneParams } from '@/lib/http'
import { sendTemplate, templateOptions } from '@/lib/manual-templates'
import { TEMPLATES, type TemplateName } from '@/lib/automations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Plantillas de Meta que se le pueden enviar a este chat, con la más lógica primero. */
export const GET = route(async (_request: Request, context: PhoneParams) => {
  const chat = await getSummary(await phoneFrom(context))
  if (!chat) throw new HttpError(404, 'Conversación no encontrada.')
  return NextResponse.json({ options: await templateOptions(chat) })
})

/** Envía una plantilla aprobada ({ name }). Funciona con la ventana de 24 h cerrada. */
export const POST = route(async (request: Request, context: PhoneParams) => {
  const phone = await phoneFrom(context)
  const name = String((await jsonBody(request)).name ?? '')
  if (!(name in TEMPLATES)) throw new HttpError(400, 'Plantilla desconocida.')
  const chat = await getSummary(phone)
  if (!chat) throw new HttpError(404, 'Conversación no encontrada.')
  const result = await sendTemplate(chat, name as TemplateName)
  if ('error' in result) throw new HttpError(409, result.error)
  return NextResponse.json({ chat: await getSummary(phone) })
})
