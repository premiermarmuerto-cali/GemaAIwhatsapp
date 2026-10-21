import { after, NextResponse, type NextRequest } from 'next/server'
import { autoReply, markPendingReply } from '@/lib/autoreply'
import { recordInbound, requestAgent, setNoMarketing, setOptOut } from '@/lib/chats'
import { beginMediaJob, isStoredKind, processMedia, type StoredKind } from '@/lib/media'
import { isOptOut } from '@/lib/optout'
import { WHATSAPP_WINDOW_MS } from '@/lib/window'
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
// Antes, un mensaje que Meta entregaba con más de 30 min de retraso se guardaba sin respuesta y sin
// avisar a nadie: así quedaron cinco chats del 18 y 19 oct (los reintentos de Meta llegaron el 20, tras
// corregir los clientes con número oculto). Ahora, mientras la ventana de 24 h siga abierta, Gema
// responde (disculpándose por la demora); si ya se cerró, el chat pasa a una persona.
const MAX_AUTOREPLY_AGE_MS = WHATSAPP_WINDOW_MS

const FILE_KINDS: MediaKind[] = ['image', 'audio', 'document', 'video']
const OTHER_LABEL: Record<string, string> = { sticker: 'Sticker', reaction: 'Reacción', location: 'Ubicación', contacts: 'Contacto' }
const MEDIA_FAILURE: Record<StoredKind, string> = {
  image: 'Envió una imagen que Gema no pudo analizar',
  audio: 'Envió una nota de voz que Gema no pudo transcribir',
}

type WaFile = { id?: string; mime_type?: string; caption?: string; filename?: string }
type WaMessage = {
  id: string
  // Sin `from` cuando el cliente usa nombre de usuario y oculta su número: llega `from_user_id`.
  from?: string
  from_user_id?: string
  timestamp?: string
  type: string
  text?: { body?: string }
  // Respuesta rápida de una plantilla: el texto del botón y, si la plantilla lo define, su payload.
  button?: { text?: string; payload?: string }
  interactive?: { button_reply?: { title?: string; id?: string }; list_reply?: { title?: string } }
  // Anuncio de clic a WhatsApp: Meta lo adjunta al primer mensaje del cliente.
  referral?: { source_type?: string; source_id?: string; headline?: string; body?: string; ctwa_clid?: string }
} & Partial<Record<MediaKind, WaFile>>
type WaValue = { messages?: WaMessage[]; contacts?: Array<{ wa_id?: string; user_id?: string; profile?: { name?: string; username?: string } }> }
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

/** Todo lo que se saca de un mensaje de Meta. Si su forma no es la esperada, lanza y el webhook lo maneja. */
function readMessage(message: WaMessage) {
  const { text, media, conversational } = parseMessage(message)
  const buttonPayload = message.button?.payload ?? message.interactive?.button_reply?.id
  return { text: String(text ?? ''), media, conversational, ad: adOf(message), buttonPayload: buttonPayload ? String(buttonPayload) : undefined }
}

/**
 * Un mensaje que no se pudo guardar como corresponde (sin remitente, forma desconocida). Solo cuándo,
 * por qué, el tipo y los nombres de sus campos, nunca el contenido. Va al mismo registro que las
 * entregas rechazadas (pm:wa:rejected), que se revisa cuando Meta cuenta más chats que el panel.
 */
async function logSkipped(reason: string, message: WaMessage) {
  await redis().multi()
    .lpush(keys.webhookRejected, JSON.stringify({ at: Date.now(), reason, messages: 1, type: message.type, fields: Object.keys(message).join(','), id: message.id }))
    .ltrim(keys.webhookRejected, 0, 199)
    .exec()
    .catch(() => null)
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
  // Cuántos mensajes traía y qué campos (nombres, nunca valores): así se detecta un cambio de formato de
  // Meta como el de los clientes con número oculto, que llegaban sin `from`.
  let messages = 0
  let fields = ''
  try {
    const parsed = JSON.parse(rawBody) as WaPayload
    const all = parsed.entry?.flatMap((entry) => entry.changes ?? []).flatMap((change) => change.value?.messages ?? []) ?? []
    messages = all.length
    fields = [...new Set(all.flatMap((message) => Object.keys(message)))].join(',')
  } catch { /* JSON roto: no hay campos que contar */ }
  console.error(`[webhook] entrega rechazada: ${reason} · ${messages} mensaje(s) · ${rawBody.length} bytes${fields ? ` · campos: ${fields}` : ''}`)
  await redis().multi()
    .lpush(keys.webhookRejected, JSON.stringify({ at: Date.now(), reason, messages, fields, bytes: rawBody.length }))
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
      const names = new Map(change.value.contacts?.map((contact) => [
        normalizePhone(contact.wa_id || contact.user_id || ''),
        contact.profile?.name || contact.profile?.username || '',
      ]))

      for (const message of change.value.messages) {
        // El número, o el identificador de WhatsApp si el cliente lo oculta (llega sin `from`). Antes de
        // esto, esos mensajes rompían la entrega completa (19 oct: 150 rechazos) y nunca llegaban al panel.
        const phone = normalizePhone(String(message.from || message.from_user_id || ''))
        if (!message.id || !isValidPhone(phone)) {
          // Sin remitente no se puede crear el chat: queda registrado para detectar otro cambio de formato de Meta.
          console.warn(`[webhook] mensaje sin remitente reconocible (${message.type}); campos: ${Object.keys(message).join(', ')}`)
          await logSkipped('mensaje sin remitente reconocible', message)
          continue
        }

        // Meta reintenta entregas: cada wamid se procesa una sola vez.
        const seenKey = keys.seen(message.id)
        if (!(await redis().set(seenKey, '1', { nx: true, ex: SEEN_TTL_SECONDS }))) continue

        const at = Number(message.timestamp) * 1000 || Date.now()
        // Un mensaje con una forma que no esperamos ya no rompe la entrega completa (eso dejó sin
        // respuesta a los clientes con número oculto del 18 al 20 oct): se guarda como "no se pudo
        // leer", el chat pasa a una asesora y la entrega sigue con los demás mensajes.
        let unreadable = false
        let read: ReturnType<typeof readMessage>
        try {
          read = readMessage(message)
        } catch (error) {
          unreadable = true
          console.error(`[webhook] ${phone}: no se pudo leer un mensaje de tipo ${message.type}:`, error)
          await logSkipped(`no se pudo leer: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160), message)
          read = { text: `[Mensaje de tipo "${message.type}" que el sistema no pudo leer: revísalo en WhatsApp]`, conversational: false, media: undefined, ad: undefined, buttonPayload: undefined }
        }
        const { text, media, conversational, ad, buttonPayload } = read
        try {
          await recordInbound(phone, {
            id: message.id, sender: 'user', text, at,
            ...(media ? { media } : {}),
            ...(ad ? { ad } : {}),
            ...(buttonPayload ? { buttonPayload: buttonPayload.slice(0, 100) } : {}),
          }, names.get(phone) || undefined)
          // "Ahora no", "no me interesa"…: se detienen todos sus mensajes automáticos (lib/optout.ts).
          if (conversational && (isOptOut(text) || /ahora_no$/i.test(buttonPayload ?? ''))) await setOptOut(phone, text)
          else if (message.type === 'button' && OPT_OUT.test(text)) await setNoMarketing(phone)
          if (unreadable) await requestAgent(phone, 'Llegó un mensaje que el sistema no pudo leer: revísalo en WhatsApp y respóndele')
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
        } else if (conversational) {
          // Llegó cuando ya no se le puede escribir libre: que lo vea una persona y le escriba con plantilla.
          console.warn(`[webhook] ${phone}: mensaje entregado con ${Math.round((Date.now() - at) / 3_600_000)} h de retraso`)
          await requestAgent(phone, 'Mensaje que llegó con más de 24 h de retraso: escríbele con una plantilla')
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
