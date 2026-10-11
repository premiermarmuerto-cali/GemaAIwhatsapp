import { createHmac, timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { handleBoldPayment } from '@/lib/payments'
import { keys, redis } from '@/lib/redis'

export const runtime = 'nodejs'
// Confirmar la cita y avisar por WhatsApp (hasta ~15 s si Meta tarda) corre antes del 200.
export const maxDuration = 30

/**
 * Notificaciones de pago de Bold (venta aprobada/rechazada, anulación aprobada/rechazada).
 *
 * Guarda cada notificación verificada y, si la firma es válida, la aplica (lib/payments.ts):
 * un SALE_APPROVED confirma la cita del link y le avisa al cliente. Formato y firma confirmados
 * con eventos reales de Bold (sandbox, octubre 2026). Una firma inválida se rechaza con 401.
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
 * x-bold-signature = HMAC-SHA256, en hex, del cuerpo crudo codificado en base64, con la llave
 * secreta de Botón de pagos. Confirmado con un evento real: en sandbox Bold firma con la llave
 * vacía, así que con la secreta de producción los eventos de prueba no pasan (es lo esperado).
 */
function checkSignature(rawBody: string, header: string | null): Signature {
  const secret = process.env.BOLD_WEBHOOK_SECRET
  if (secret === undefined) return 'sin-llave'
  if (!header) return 'sin-firma'
  const expected = createHmac('sha256', secret).update(Buffer.from(rawBody, 'utf8').toString('base64')).digest('hex')
  return sameHex(expected, header.trim().toLowerCase()) ? 'valida' : 'invalida'
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

  const signature = checkSignature(rawBody, request.headers.get('x-bold-signature'))
  // Firma falsa o ausente: no viene de Bold. Sin llave configurada se acepta pero queda marcada,
  // para no perder pagos reales por un error de configuración; nada debe actuar sobre esos eventos.
  if (signature === 'invalida' || signature === 'sin-firma') {
    console.warn(`[bold-webhook] notificación rechazada: firma ${signature}`)
    return NextResponse.json({ error: 'Firma inválida.' }, { status: 401 })
  }
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
      raw: rawBody.slice(0, 4000),
    }
    await db.multi()
      .lpush(keys.boldEvents, JSON.stringify(record))
      .ltrim(keys.boldEvents, 0, KEEP_EVENTS - 1)
      .exec()
    // Solo una firma verificada puede confirmar una cita; "sin-llave" se guarda pero no actúa.
    const outcome = signature === 'valida' ? await handleBoldPayment(record) : 'no aplicado (firma sin verificar)'
    console.log(`[bold-webhook] ${record.type} · ref ${record.reference || '(sin ref)'} · firma ${signature} · ${outcome}`)
  } catch (error) {
    // Si falla a mitad, reprocesar es seguro: handleBoldPayment no toca citas ya confirmadas.
    console.error('[bold-webhook] no se pudo procesar el evento:', error)
    // Se libera la marca de "visto" para que el reintento no se descarte como duplicado.
    await redis().del(keys.boldSeen(eventId)).catch(() => null)
    // 500 para que Bold reintente: no queremos perder una notificación de pago.
    return NextResponse.json({ error: 'No se pudo procesar.' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}
