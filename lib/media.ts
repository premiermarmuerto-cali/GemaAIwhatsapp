import { describeImage, transcribeAudio } from './ai'
import { keys, redis } from './redis'
import type { Message, MessageMedia } from './types'
import { downloadMedia } from './whatsapp'

const DAY = 24 * 60 * 60
// Meta borra los archivos a los 7 días: la consola guarda su propia copia durante 30, tiempo de sobra para verificar pagos.
const TTL_SECONDS = { image: 30 * DAY, audio: 30 * DAY } as const
const ALLOWED_MIME = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  audio: ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr'],
} as const
const BUSY_SECONDS = 120
const PROCESSING_GRACE_MS = 2 * 60 * 1000

export type StoredKind = keyof typeof TTL_SECONDS
type MediaInfo = { status: 'ready' | 'failed'; mime?: string; note?: string }

export const isStoredKind = (kind: string): kind is StoredKind => kind in TTL_SECONDS

/** Marca que hay un archivo en proceso: Gema espera a entenderlo antes de responder. Se llama antes del 200 del webhook. */
export async function beginMediaJob(phone: string) {
  const key = keys.mediaBusy(phone)
  await redis().multi().incr(key).expire(key, BUSY_SECONDS).exec()
}

/** Descarga, guarda y entiende una imagen (análisis) o una nota de voz (transcripción). Devuelve false si no se pudo. */
export async function processMedia(phone: string, media: MessageMedia & { kind: StoredKind }): Promise<boolean> {
  const db = redis()
  const ttl = TTL_SECONDS[media.kind]
  let mime: string | undefined
  try {
    const file = await downloadMedia(media.id)
    mime = file.mime
    if (!(ALLOWED_MIME[media.kind] as readonly string[]).includes(mime)) throw new Error(`Tipo de archivo no admitido: ${mime}`)
    await db.set(keys.mediaBin(media.id), file.bytes.toString('base64'), { ex: ttl })
    const note = media.kind === 'image' ? await describeImage(file.bytes, mime) : await transcribeAudio(file.bytes, mime)
    await db.set(keys.mediaInfo(media.id), JSON.stringify({ status: 'ready', mime, note } satisfies MediaInfo), { ex: ttl })
    return true
  } catch (error) {
    console.error(`[media] no se pudo procesar ${media.kind} ${media.id} de ${phone}:`, error)
    await db.set(keys.mediaInfo(media.id), JSON.stringify({ status: 'failed', mime } satisfies MediaInfo), { ex: ttl })
    return false
  } finally {
    await db.decr(keys.mediaBusy(phone))
  }
}

export async function mediaBusy(phone: string): Promise<boolean> {
  return Number(await redis().get<string>(keys.mediaBusy(phone)) ?? 0) > 0
}

/** Completa estado y nota de los mensajes con imagen o audio. */
export async function attachMediaInfo(messages: Message[]): Promise<Message[]> {
  const stored = messages.filter((message) => message.media && isStoredKind(message.media.kind))
  if (!stored.length) return messages
  const raw = await redis().mget<(string | null)[]>(...stored.map((message) => keys.mediaInfo(message.media!.id)))
  const infos = new Map(stored.map((message, index) => [message.id, parseInfo(raw[index])]))
  const now = Date.now()
  return messages.map((message) => {
    if (!infos.has(message.id)) return message
    const info = infos.get(message.id)
    const status = info?.status ?? (now - message.at < PROCESSING_GRACE_MS ? 'processing' : 'expired')
    return { ...message, media: { ...message.media!, status, note: info?.note, mime: info?.mime ?? message.media!.mime } }
  })
}

function parseInfo(raw: string | null | undefined): MediaInfo | null {
  if (!raw) return null
  try { return JSON.parse(raw) as MediaInfo } catch { return null }
}

/** Copia guardada de un archivo para mostrarla en la consola. */
export async function readStoredMedia(mediaId: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const [bin, info] = await redis().mget<(string | null)[]>(keys.mediaBin(mediaId), keys.mediaInfo(mediaId))
  const mime = parseInfo(info)?.mime
  if (!bin || !mime) return null
  const allowed = [...ALLOWED_MIME.image, ...ALLOWED_MIME.audio] as readonly string[]
  return allowed.includes(mime) ? { bytes: Buffer.from(bin, 'base64'), mime } : null
}
