import { HttpError, route } from '@/lib/http'
import { readStoredMedia } from '@/lib/media'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Sirve la copia guardada de una imagen o nota de voz. La sesión la exige el middleware, como el resto de /api. */
export const GET = route(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params
  if (!/^\d{1,32}$/.test(id)) throw new HttpError(400, 'Archivo inválido.')
  const media = await readStoredMedia(id)
  if (!media) throw new HttpError(404, 'El archivo ya no está disponible.')
  return new Response(new Uint8Array(media.bytes), {
    headers: {
      'Content-Type': media.mime,
      'Content-Length': String(media.bytes.length),
      'Cache-Control': 'private, max-age=86400, immutable',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  })
})
