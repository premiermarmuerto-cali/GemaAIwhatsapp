/**
 * API de conversiones de Meta para mensajería (dataset de WhatsApp). Le dice a Meta qué anuncio generó
 * cada cita y cada pago, para medir la campaña por ventas y no solo por conversaciones.
 *
 * Solo aplica a conversaciones que llegaron desde un anuncio (traen `ctwa_clid` en el primer mensaje,
 * que el webhook guarda en el chat) y dentro de los 7 días siguientes al clic.
 *
 *   Purchase  pago confirmado: por Bold al llegar su confirmación, por transferencia cuando la asesora
 *             confirma la cita en la consola. `value` = lo que se pagó (anticipo o sesión completa).
 *   LeadSubmitted  cita agendada por Gema (sin esperar el pago). Meta no acepta "Schedule" con
 *             action_source business_messaging (error 2804066): solo Purchase, LeadSubmitted y similares.
 *
 * Sin META_CAPI_TOKEN no envía nada. Cada evento se envía una sola vez (event_id) y queda registrado
 * con la respuesta de Meta en pm:capi:log. Un error nunca interrumpe la reserva ni el pago.
 */
import { getSummary } from './chats'
import { keys, redis } from './redis'

const ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60_000
// Dataset vinculado al WhatsApp de Premier (POST /{WABA}/dataset, 20 oct). El 38756680020642307, creado
// desde el Administrador de eventos, no estaba vinculado: Meta rechazaba los eventos (2804132).
const DEFAULT_DATASET_ID = '1636157554637715'
const DEFAULT_WABA_ID = '1997545614294706'

export type ConversionEvent = {
  name: 'Purchase' | 'LeadSubmitted'
  phone: string
  /** Único por pago o por cita: así Meta no cuenta dos veces si Bold reintenta su aviso. */
  eventId: string
  /** Momento del pago o de la cita, en ms. */
  at?: number
  /** Pesos pagados (solo Purchase). */
  value?: number
}

export type ConversionResult = { sent: boolean; reason?: string; response?: unknown }

export async function sendConversion(event: ConversionEvent): Promise<ConversionResult> {
  const token = process.env.META_CAPI_TOKEN
  if (!token) return { sent: false, reason: 'sin META_CAPI_TOKEN' }

  const chat = await getSummary(event.phone)
  // Sin clic de anuncio no hay a qué atribuirlo: Meta lo descartaría.
  if (!chat?.ctwaClid) return { sent: false, reason: 'la conversación no vino de un anuncio' }
  const at = event.at ?? Date.now()
  // Los chats anteriores a guardar ctwaAt usan su creación: fue con el primer mensaje, que traía el clic.
  const clickAt = chat.ctwaAt || chat.createdAt
  if (at - clickAt > ATTRIBUTION_WINDOW_MS) return { sent: false, reason: 'pasaron más de 7 días desde el clic' }

  // Una sola vez por event_id (se marca antes de enviar para que dos avisos simultáneos no lo dupliquen).
  if (!(await redis().set(keys.capiSent(event.eventId), '1', { nx: true, ex: 60 * 60 * 24 * 30 }))) {
    return { sent: false, reason: 'ya enviado' }
  }

  const version = process.env.WHATSAPP_API_VERSION || 'v26.0'
  const dataset = process.env.META_CAPI_DATASET_ID || DEFAULT_DATASET_ID
  const body = {
    data: [{
      event_name: event.name,
      event_time: Math.floor(at / 1000),
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      event_id: event.eventId,
      user_data: {
        whatsapp_business_account_id: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || DEFAULT_WABA_ID,
        ctwa_clid: chat.ctwaClid,
      },
      ...(event.name === 'Purchase' && event.value ? { custom_data: { currency: 'COP', value: event.value } } : {}),
    }],
    // Solo durante las pruebas (Administrador de eventos → Probar eventos); quitarlo en producción.
    ...(process.env.META_CAPI_TEST_CODE ? { test_event_code: process.env.META_CAPI_TEST_CODE } : {}),
  }

  try {
    const response = await fetch(`https://graph.facebook.com/${version}/${dataset}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    })
    const data = await response.json().catch(() => null) as { events_received?: number; error?: { message?: string } } | null
    await logConversion(event, response.ok, data)
    if (!response.ok) {
      // Falló: se libera el event_id para poder reintentarlo (por ejemplo, después de arreglar el token).
      await redis().del(keys.capiSent(event.eventId))
      console.error(`[capi] ${event.name} ${event.eventId} rechazado: ${data?.error?.message ?? response.status}`)
      return { sent: false, reason: data?.error?.message ?? `HTTP ${response.status}`, response: data }
    }
    return { sent: true, response: data }
  } catch (error) {
    await redis().del(keys.capiSent(event.eventId))
    await logConversion(event, false, { error: error instanceof Error ? error.message : String(error) })
    console.error(`[capi] ${event.name} ${event.eventId} no se pudo enviar:`, error)
    return { sent: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function logConversion(event: ConversionEvent, ok: boolean, response: unknown) {
  await redis().multi()
    .lpush(keys.capiLog, JSON.stringify({ at: Date.now(), ok, event: event.name, eventId: event.eventId, value: event.value ?? null, response }))
    .ltrim(keys.capiLog, 0, 199)
    .exec()
    .catch(() => null)
}

/** Envía sin hacer esperar ni fallar al que llama: la reserva o el pago nunca dependen de Meta. */
export async function trackConversion(event: ConversionEvent): Promise<void> {
  try {
    const result = await sendConversion(event)
    if (!result.sent && result.reason !== 'sin META_CAPI_TOKEN' && result.reason !== 'la conversación no vino de un anuncio' && result.reason !== 'ya enviado') {
      console.warn(`[capi] ${event.name} ${event.eventId} no enviado: ${result.reason}`)
    }
  } catch (error) {
    console.error('[capi] error inesperado:', error)
  }
}
