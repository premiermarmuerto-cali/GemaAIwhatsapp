import { NextResponse } from 'next/server'
import { getConfig } from '@/lib/config'
import { HttpError, jsonBody, route } from '@/lib/http'
import { PRESET_INFO, presetParts, renderPreset } from '@/lib/presets'
import type { ChatSummary, PresetId } from '@/lib/types'

export const dynamic = 'force-dynamic'

/** Cliente de ejemplo para la vista previa: solo da el nombre y la sede; no se le escribe nada. */
const SAMPLE_CHAT = { name: 'Laura Gómez', lead: { concern: '', serviceId: '', location: '' } } as unknown as ChatSummary

/**
 * Cómo saldría un mensaje prediseñado ahora mismo (con el texto que se está editando, aunque todavía
 * no esté guardado), con las promociones, el anticipo y los horarios reales de la agenda.
 */
export const POST = route(async (request: Request) => {
  const body = await jsonBody(request)
  const id = String(body.id ?? '') as PresetId
  if (!(id in PRESET_INFO)) throw new HttpError(400, 'Mensaje prediseñado desconocido.')
  const template = typeof body.text === 'string' ? body.text : undefined
  const config = await getConfig()
  // El aviso de anticipo pendiente necesita una cita: se simula una apartada que vence en 30 min.
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  const deposit = config.depositFixed ? `$${config.depositFixed.toLocaleString('es-CO')}` : ''
  const service = config.services[0]
  const booking = id === 'followUpPayment'
    ? { name: 'Laura Gómez', day: tomorrow, start: '15:00', location: 'chipichape', holdUntil: Date.now() + 30 * 60_000, deposit, price: '' }
    // "Cita agendada": una cita confirmada con el anticipo pagado.
    : id === 'bookingConfirmed'
      ? { name: 'Laura Gómez', day: tomorrow, start: '15:00', location: 'chipichape', status: 'confirmed', paymentPlan: 'deposit', paidAt: Date.now(), deposit, price: service?.price ?? '', serviceLabel: service?.label ?? 'Limpieza facial', people: 1, sequential: false, durationMin: service?.durationMin ?? 60, kind: 'appointment', source: 'bot' }
      : null
  const text = await renderPreset(config, id, { chat: SAMPLE_CHAT, booking: booking as never }, template)
  return NextResponse.json({ parts: text ? presetParts(text) : [], skipped: !text })
})
