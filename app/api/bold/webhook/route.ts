import { createHmac, timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { keys, redis } from '@/lib/redis'

export const runtime = 'nodejs'

/**
 * Notificaciones de pago de Bold (venta aprobada/rechazada, anulación aprobada/rechazada).
 *
 * FASE DE PRUEBA: este endpoint todavía no cambia el estado de ninguna cita. Guarda cada
 * notificación completa y anota si la firma cuadró, para confirmar con eventos reales el
 * formato exacto y el esquema de firma antes de automatizar nada. Antes de que un evento
 * confirme una cita sola, la firma inválida tiene que pasar a rechazarse (401).
 */

const SEEN_TTL_SECONDS = 60 * 60 * 24 * 7
const KEEP_EVENTS = 200

type Signature = 'valida' | 'invalida' | 'sin-firma' | 'sin-llave'

function sameHex(a: string, b: string) {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Bold firma con HMAC-SHA256 y la llave secreta. Como el esquema exacto aún no está confirmado
 * con un evento real, se aceptan las dos variantes conocidas: sobre el cuerpo en base64 y sobre
 * el cuerpo crudo. Cuando sepamos cuál usa, se deja solo esa.
 */
function checkSignature(rawBody: string, header: string | null): Signature {
  const secret = process.env.BOLD_WEBHOOK_SECRET
  if (secret === undefined) return 'sin-llave'
  if (!header) return 'sin-firma'
  const received = header.trim().toLowerCase()
  const candidates = [Buffer.from(rawBody, 'utf8').toString('base64'), rawBody]
    .map((payload) => createHmac('sha256', secret).update(payload).digest('hex'))
  return candidates.some((expected) => sameHex(expected, received)) ? 'valida' : 'invalida'
}

type BoldEvent = {
  id?: string
  type?: string
  data?: {
    payment_id?: string
    amount?: { total?: number }
    metadata?: { reference?: string }
    payment_method?: string
  }
}

// Bold y otros proveedores a veces validan la URL con un GET antes de registrarla.
export async function GET() {
  return NextResponse.json({ ok: true })
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  let event: BoldEvent
  try { event = JSON.parse(rawBody) } catch { return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 }) }

  const signatureHeader = request.headers.get('x-bold-signature')
  const signature = checkSignature(rawBody, signatureHeader)
  const eventId = event.id ?? event.data?.payment_id ?? crypto.randomUUID()

  try {
    const db = redis()
    // Bold reintenta entregas: cada evento se procesa una sola vez.
    if (!(await db.set(keys.boldSeen(eventId), '1', { nx: true, ex: SEEN_TTL_SECONDS }))) {
      return NextResponse.json({ received: true, duplicate: true })
    }
    const record = {
      receivedAt: Date.now(),
      id: eventId,
      type: event.type ?? 'desconocido',
      reference: event.data?.metadata?.reference ?? '',
      paymentId: event.data?.payment_id ?? '',
      amount: event.data?.amount?.total ?? null,
      paymentMethod: event.data?.payment_method ?? '',
      signature,
      // Se guarda la firma recibida y los nombres de los encabezados para confirmar el esquema
      // de firma de Bold con eventos reales; no contienen secretos.
      signatureHeader: signatureHeader?.slice(0, 200) ?? null,
      headerNames: [...request.headers.keys()],
      raw: rawBody.slice(0, 4000),
    }
    await db.multi()
      .lpush(keys.boldEvents, JSON.stringify(record))
      .ltrim(keys.boldEvents, 0, KEEP_EVENTS - 1)
      .exec()
    console.log(`[bold-webhook] ${record.type} · ref ${record.reference || '(sin ref)'} · firma ${signature}`)
  } catch (error) {
    console.error('[bold-webhook] no se pudo guardar el evento:', error)
    // Se libera la marca de "visto" para que el reintento no se descarte como duplicado.
    await redis().del(keys.boldSeen(eventId)).catch(() => null)
    // 500 para que Bold reintente: no queremos perder una notificación de pago.
    return NextResponse.json({ error: 'No se pudo procesar.' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}
