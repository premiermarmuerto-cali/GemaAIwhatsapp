import { NextResponse } from 'next/server'
import { deleteChat, getChat, updateChat } from '@/lib/chats'
import { HttpError, jsonBody, phoneFrom, route, type PhoneParams } from '@/lib/http'
import type { ChatPatch, Stage } from '@/lib/types'

export const dynamic = 'force-dynamic'

/** Detalle del chat con sus últimos mensajes. Lo marca como leído al abrirlo. */
export const GET = route(async (_request: Request, context: PhoneParams) => {
  const phone = await phoneFrom(context)
  const chat = await getChat(phone)
  if (!chat) throw new HttpError(404, 'Conversación no encontrada.')
  return NextResponse.json(chat)
})

const STAGES: Stage[] = ['open', 'booked']

/** Pausar/reanudar a Gema, marcar agendado, archivar/desarchivar, o quitar la alerta de asesor. */
export const PATCH = route(async (request: Request, context: PhoneParams) => {
  const phone = await phoneFrom(context)
  const body = await jsonBody(request)

  const patch: ChatPatch = {}
  if (typeof body.botActive === 'boolean') patch.botActive = body.botActive
  if (typeof body.archived === 'boolean') patch.archived = body.archived
  if (typeof body.stage === 'string') {
    if (!STAGES.includes(body.stage as Stage)) throw new HttpError(400, 'Estado inválido.')
    patch.stage = body.stage as Stage
  }
  if (body.needsAgent === false) patch.needsAgent = false

  const updated = await updateChat(phone, patch)
  if (!updated) throw new HttpError(404, 'Conversación no encontrada.')
  return NextResponse.json(updated)
})

export const DELETE = route(async (_request: Request, context: PhoneParams) => {
  const phone = await phoneFrom(context)
  await deleteChat(phone)
  return NextResponse.json({ ok: true })
})
