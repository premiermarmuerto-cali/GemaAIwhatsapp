import { after, NextResponse, type NextRequest } from 'next/server'
import { autoReply, markPendingReply } from '@/lib/autoreply'
import { recordInbound, requestAgent } from '@/lib/chats'
import { beginMediaJob, isStoredKind, processMedia, type StoredKind } from '@/lib/media'
import { isValidPhone, normalizePhone } from '@/lib/phone'
import { keys, redis } from '@/lib/redis'
import type { MediaKind, MessageMedia } from '@/lib/types'
import { verifyMetaSignature } from '@/lib/whatsapp'

export const runtime = 'nodejs'
// Tras el 200 corren el análisis de archivos y la respuesta de Gema (espera de ráfaga + modelo + envío).
// En el plan Hobby de Vercel esto se recorta silenciosamente a mucho menos de 60s (por eso
// lib/autoreply.ts acortó sus propios tiempos); este valor queda listo para cuando se suba de plan.
export const maxDuration = 60

const SEEN_TTL_SECONDS = 60 * 60 * 24
// Mensajes que Meta entrega con mucho retraso (caídas, reintentos) se guardan pero no reciben respuesta automática.
const MAX_AUTOREPLY_AGE_MS = 30 * 60 * 1000

const FILE_KINDS: MediaKind[] = ['image', 'audio', 'document', 'video']
const OTHER_LABEL: Record<string, string> = { sticker: 'Sticker', reaction: 'Reacción', location: 'Ubicación', contacts: 'Contacto' }
const MEDIA_FAILURE: Record<StoredKind, string> = {
  image: 'Envió una imagen que Gema no pudo analizar',
  audio: 'Envió una nota de voz que Gema no pudo transcribir',
}

type WaFile = { id?: string; mime_type?: string; caption?: string; filename?: string }
type WaMessage = {
  id: string
  from: string
  timestamp?: string
  type: string
  text?: { body?: string }
  button?: { text?: string }
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } }
} & Partial<Record<MediaKind, WaFile>>
type WaValue = { messages?: WaMessage[]; contacts?: Array<{ wa_id?: string; profile?: { name?: string } }> }
type WaPayload = { object?: string; entry?: Array<{ changes?: Array<{ field?: string; value?: WaValue }> }> }

/** Texto, archivo y si el mensaje merece respuesta. Stickers, reacciones y similares se guardan sin responder. */
function parseMessage(message: WaMessage): { text: string; media?: MessageMedia; conversational: boolean } {
  const text = message.text?.body ?? message.button?.text ?? message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title
  if (text) return { text, conversational: true }
  const kind = FILE_KINDS.find((item) => item === message.type)
  const file = kind && message[kind]
  if (kind && file?.id) {
    const mime = file.mime_type?.split(';')[0].trim().toLowerCase()
    return {
      text: file.caption?.trim() ?? '',
      media: { kind, id: file.id, ...(mime ? { mime } : {}), ...(file.filename ? { filename: file.filename } : {}) },
      conversational: true,
    }
  }
  return { text: `[${OTHER_LABEL[message.type] ?? message.type}]`, conversational: false }
}

// Verificación del webhook al registrarlo en Meta.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const token = process.env.WHATSAPP_VERIFY_TOKEN
  if (params.get('hub.mode') !== 'subscribe' || !token || params.get('hub.verify_token') !== token) return new NextResponse('Forbidden', { status: 403 })
  return new NextResponse(params.get('hub.challenge') ?? '', { status: 200 })
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  if (!verifyMetaSignature(rawBody, request.headers.get('x-hub-signature-256'))) {
    return NextResponse.json({ error: 'Firma inválida.' }, { status: 401 })
  }

  let payload: WaPayload
  try { payload = JSON.parse(rawBody) } catch { return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 }) }
  if (payload.object !== 'whatsapp_business_account') return NextResponse.json({ received: true })

  const toReply = new Set<string>()
  const mediaJobs: Array<() => Promise<void>> = []
  try {
    for (const change of payload.entry?.flatMap((entry) => entry.changes ?? []) ?? []) {
      if (change.field !== 'messages' || !change.value?.messages) continue
      const names = new Map(change.value.contacts?.map((contact) => [normalizePhone(contact.wa_id ?? ''), contact.profile?.name ?? '']))

      for (const message of change.value.messages) {
        const phone = normalizePhone(message.from)
        if (!message.id || !isValidPhone(phone)) continue

        // Meta reintenta entregas: cada wamid se procesa una sola vez.
        const seenKey = keys.seen(message.id)
        if (!(await redis().set(seenKey, '1', { nx: true, ex: SEEN_TTL_SECONDS }))) continue

        const at = Number(message.timestamp) * 1000 || Date.now()
        const { text, media, conversational } = parseMessage(message)
        try {
          await recordInbound(phone, { id: message.id, sender: 'user', text, at, ...(media ? { media } : {}) }, names.get(phone) || undefined)
        } catch (error) {
          await redis().del(seenKey) // permite que el reintento de Meta lo vuelva a intentar
          throw error
        }

        // Imágenes y notas de voz se guardan y se interpretan; Gema espera a que estén listas antes de responder.
        if (media && isStoredKind(media.kind)) {
          const stored = media as MessageMedia & { kind: StoredKind }
          await beginMediaJob(phone)
          mediaJobs.push(async () => {
            if (!(await processMedia(phone, stored))) await requestAgent(phone, MEDIA_FAILURE[stored.kind])
          })
        }
        if (conversational && Date.now() - at < MAX_AUTOREPLY_AGE_MS) {
          await markPendingReply(phone)
          toReply.add(phone)
        }
      }
    }
  } catch (error) {
    console.error('[webhook] error guardando mensajes:', error)
    return NextResponse.json({ error: 'No se pudo procesar.' }, { status: 500 })
  }

  // Meta espera un 200 rápido; archivos e IA se procesan después de responder.
  if (mediaJobs.length || toReply.size) {
    after(() => Promise.all([...mediaJobs.map((job) => job()), ...[...toReply].map((phone) => autoReply(phone))]))
  }
  return NextResponse.json({ received: true })
}
