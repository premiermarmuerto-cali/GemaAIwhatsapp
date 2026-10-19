import { after, NextResponse, type NextRequest } from 'next/server'
import { autoReply, markPendingReply } from '@/lib/autoreply'
import { recordInbound, requestAgent, setNoMarketing } from '@/lib/chats'
import { beginMediaJob, isStoredKind, processMedia, type StoredKind } from '@/lib/media'
import { isValidPhone, normalizePhone } from '@/lib/phone'
import { keys, redis } from '@/lib/redis'
import type { MediaKind, Message, MessageMedia } from '@/lib/types'
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
  // Respuesta rápida de una plantilla: el texto del botón y, si la plantilla lo define, su payload.
  button?: { text?: string; payload?: string }
  interactive?: { button_reply?: { title?: string; id?: string }; list_reply?: { title?: string } }
  // Anuncio de clic a WhatsApp: Meta lo adjunta al primer mensaje del cliente.
  referral?: { source_type?: string; source_id?: string; headline?: string; body?: string; ctwa_clid?: string }
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

/**
 * El anuncio del que llegó el cliente. El texto automático de la plantilla suele ser genérico
 * ("¿Puedo obtener más información sobre esto?"); el título del anuncio es lo que dice de qué
 * servicio se trata.
 */
function adOf(message: WaMessage): Message['ad'] | undefined {
  const headline = message.referral?.headline?.trim().slice(0, 200)
  const body = message.referral?.body?.trim().slice(0, 500)
  // Atribución: id del anuncio en Meta y del clic, para cruzar con el administrador de anuncios.
  const sourceId = message.referral?.source_id?.trim().slice(0, 80)
  const ctwaClid = message.referral?.ctwa_clid?.trim().slice(0, 200)
  const ad = { ...(headline ? { headline } : {}), ...(body ? { body } : {}), ...(sourceId ? { sourceId } : {}), ...(ctwaClid ? { ctwaClid } : {}) }
  return Object.keys(ad).length ? ad : undefined
}

/** "Ahora no" en una plantilla de marketing: la clienta no quiere más plantillas de marketing. */
const OPT_OUT = /^\s*ahora no\s*$/i

// Verificación del webhook al registrarlo en Meta.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const token = process.env.WHATSAPP_VERIFY_TOKEN
  if (params.get('hub.mode') !== 'subscribe' || !token || params.get('hub.verify_token') !== token) return new NextResponse('Forbidden', { status: 403 })
  return new NextResponse(params.get('hub.challenge') ?? '', { status: 200 })
}

/**
 * Deja constancia de una entrega de Meta que no se procesó (firma inválida, JSON roto, error al guardar).
 * Sirve para cruzar con las conversaciones que Meta cuenta y no llegan al panel sin depender de los
 * logs de Vercel. Guarda solo cuándo, por qué y cuántos mensajes traía, no su contenido.
 */
async function logRejected(reason: string, rawBody: string) {
  const messages = (rawBody.match(/"from"\s*:/g) ?? []).length
  console.error(`[webhook] entrega rechazada: ${reason} · ${messages} mensaje(s) · ${rawBody.length} bytes`)
  await redis().multi()
    .lpush(keys.webhookRejected, JSON.stringify({ at: Date.now(), reason, messages, bytes: rawBody.length }))
    .ltrim(keys.webhookRejected, 0, 199)
    .exec()
    .catch(() => null)
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  if (!verifyMetaSignature(rawBody, request.headers.get('x-hub-signature-256'))) {
    await logRejected('firma inválida', rawBody)
    return NextResponse.json({ error: 'Firma inválida.' }, { status: 401 })
  }

  let payload: WaPayload
  try { payload = JSON.parse(rawBody) } catch {
    await logRejected('JSON inválido', rawBody)
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }
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
        const ad = adOf(message)
        const buttonPayload = message.button?.payload ?? message.interactive?.button_reply?.id
        try {
          await recordInbound(phone, {
            id: message.id, sender: 'user', text, at,
            ...(media ? { media } : {}),
            ...(ad ? { ad } : {}),
            ...(buttonPayload ? { buttonPayload: buttonPayload.slice(0, 100) } : {}),
          }, names.get(phone) || undefined)
          if (message.type === 'button' && (OPT_OUT.test(text) || /ahora_no$/i.test(buttonPayload ?? ''))) await setNoMarketing(phone)
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
    await logRejected(`error al guardar: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200), rawBody)
    return NextResponse.json({ error: 'No se pudo procesar.' }, { status: 500 })
  }

  // Meta espera un 200 rápido; archivos e IA se procesan después de responder.
  if (mediaJobs.length || toReply.size) {
    after(() => Promise.all([...mediaJobs.map((job) => job()), ...[...toReply].map((phone) => autoReply(phone))]))
  }
  return NextResponse.json({ received: true })
}
