import { NextResponse } from 'next/server'
import { deliverWelcome } from '@/lib/autoreply'
import { liveBookingOf } from '@/lib/booking'
import { getSummary, recordOutbound } from '@/lib/chats'
import { getConfig } from '@/lib/config'
import { HttpError, jsonBody, phoneFrom, route, type PhoneParams } from '@/lib/http'
import { PRESET_INFO, renderPreset } from '@/lib/presets'
import { toMessages } from '@/lib/reply-style'
import type { PresetId } from '@/lib/types'
import { buildWelcome } from '@/lib/welcome'
import { sendWhatsAppText } from '@/lib/whatsapp'
import { isWindowOpen } from '@/lib/window'

export const runtime = 'nodejs'
export const maxDuration = 60

/** Etiqueta con la que queda registrado cada envío manual (la misma que usan las automatizaciones). */
const KIND: Partial<Record<PresetId, string>> = { followUpPayment: 'seguimiento_pago', followUp45: 'seguimiento_45m', followUp3h: 'seguimiento_3h', followUp22h: 'seguimiento_22h' }

/**
 * Envío a mano de un mensaje prediseñado desde el panel, por si el automático falló o hay que
 * repetirlo. `id` es "welcome" (los tres bloques de bienvenida con la imagen) o uno de los
 * seguimientos. Sale a nombre de Gema y NO la pausa: es su mensaje, no el del operador.
 */
export const POST = route(async (request: Request, context: PhoneParams) => {
  const phone = await phoneFrom(context)
  const body = await jsonBody(request)
  const id = String(body.id ?? '')
  const chat = await getSummary(phone)
  if (!chat) throw new HttpError(404, 'Conversación no encontrada.')
  if (!isWindowOpen(chat)) throw new HttpError(409, 'Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo permite plantillas aprobadas.')
  const config = await getConfig()

  if (id === 'welcome') {
    const welcome = await buildWelcome(config, process.env.PUBLIC_APP_URL || 'https://premier-agente.vercel.app', { chat })
    if (!welcome) throw new HttpError(409, 'No hay ninguna promoción 2x1 vigente con precio: la bienvenida no tiene qué anunciar.')
    await deliverWelcome(phone, welcome)
    return NextResponse.json({ chat: await getSummary(phone) })
  }

  if (!(id in PRESET_INFO) || id.startsWith('welcome')) throw new HttpError(400, 'Mensaje prediseñado desconocido.')
  const presetId = id as PresetId
  const booking = presetId === 'followUpPayment' ? await liveBookingOf(phone) : null
  if (presetId === 'followUpPayment' && !booking?.holdUntil) throw new HttpError(409, 'Este cliente no tiene un horario apartado esperando el anticipo.')
  const text = await renderPreset(config, presetId, { chat, booking })
  if (!text) throw new HttpError(409, 'No se pudo armar el mensaje: falta un dato (por ejemplo, no queda ningún horario libre para ofrecer).')
  for (const [index, message] of toMessages(text).entries()) {
    if (index) await new Promise((resolve) => setTimeout(resolve, 1_200))
    const waId = await sendWhatsAppText(phone, message)
    await recordOutbound(phone, { id: waId ?? crypto.randomUUID(), sender: 'gem', text: message, at: Date.now(), auto: KIND[presetId] ?? presetId })
  }
  return NextResponse.json({ chat: await getSummary(phone) })
})
