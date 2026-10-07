import { createHmac, timingSafeEqual } from 'node:crypto'

const version = process.env.WHATSAPP_API_VERSION || 'v26.0'

export class WhatsAppError extends Error {}

const MAX_MEDIA_BYTES = 16 * 1024 * 1024

function accessToken(): string {
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  if (!token) throw new WhatsAppError('WhatsApp no está configurado (WHATSAPP_ACCESS_TOKEN).')
  return token
}

/** Descarga un archivo que envió un cliente. Meta lo conserva 7 días y su URL caduca a los 5 minutos. */
export async function downloadMedia(mediaId: string): Promise<{ bytes: Buffer; mime: string }> {
  const headers = { Authorization: `Bearer ${accessToken()}`, 'User-Agent': 'HiddenGem/1.0' }
  const infoResponse = await fetch(`https://graph.facebook.com/${version}/${mediaId}`, { headers, signal: AbortSignal.timeout(10_000) })
  const info = await infoResponse.json().catch(() => null) as { url?: string; mime_type?: string; file_size?: number; error?: { message?: string } } | null
  if (!infoResponse.ok || !info?.url) throw new WhatsAppError(info?.error?.message ?? `Meta respondió ${infoResponse.status} al pedir el archivo`)
  if ((info.file_size ?? 0) > MAX_MEDIA_BYTES) throw new WhatsAppError('El archivo supera 16 MB.')

  const fileResponse = await fetch(info.url, { headers, signal: AbortSignal.timeout(20_000) })
  if (!fileResponse.ok) throw new WhatsAppError(`Meta respondió ${fileResponse.status} al descargar el archivo`)
  const bytes = Buffer.from(await fileResponse.arrayBuffer())
  if (bytes.length > MAX_MEDIA_BYTES) throw new WhatsAppError('El archivo supera 16 MB.')
  const mime = (info.mime_type ?? fileResponse.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  return { bytes, mime }
}

export async function sendWhatsAppText(to: string, body: string): Promise<string | undefined> {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const token = accessToken()
  if (!phoneId) throw new WhatsAppError('WhatsApp no está configurado (WHATSAPP_PHONE_NUMBER_ID).')
  const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body } }),
    signal: AbortSignal.timeout(15_000),
  })
  const data = await response.json().catch(() => null) as { messages?: Array<{ id: string }>; error?: { message?: string } } | null
  if (!response.ok) throw new WhatsAppError(data?.error?.message ?? `WhatsApp respondió ${response.status}`)
  return data?.messages?.[0]?.id
}

/** Verifica X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, cuerpo crudo). */
export function verifyMetaSignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET
  if (!secret || !header?.startsWith('sha256=')) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex'), 'utf8')
  const received = Buffer.from(header.slice('sha256='.length), 'utf8')
  return expected.length === received.length && timingSafeEqual(expected, received)
}
