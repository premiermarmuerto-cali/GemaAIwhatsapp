/**
 * Qué hace el sistema con una notificación de Bold ya verificada (firma válida).
 *
 * La referencia de cada link es `<id de la cita>-<timestamp>` (ver generarLinkPagoBold), así
 * que de ahí sale qué cita confirmar. Todo es idempotente: Bold reintenta, y una cita que ya no
 * está apartada no se vuelve a tocar.
 */
import { confirmPaidByBold, getBooking, serviceText } from './booking'
import { clock12, dayLabel } from './calendar'
import { LOCATION_LABEL } from './clinic'
import { getSummary, notePayment, recordOutbound, requestAgent } from './chats'
import { sendWhatsAppText } from './whatsapp'
import { HOLD_STATUSES } from './types'

export type BoldPayment = { type: string; reference: string; paymentId: string; amount: number | null; paymentMethod: string }

const METHOD_LABEL: Record<string, string> = { PSE: 'PSE', CREDIT_CARD: 'tarjeta', NEQUI: 'Nequi', BOTON_BANCOLOMBIA: 'Botón Bancolombia' }

const pesos = (value: number) => `$${value.toLocaleString('es-CO')}`

/** Devuelve qué se hizo, para el log del webhook. */
export async function handleBoldPayment(event: BoldPayment): Promise<string> {
  const cut = event.reference.lastIndexOf('-')
  const bookingId = cut > 0 ? event.reference.slice(0, cut) : event.reference
  const booking = bookingId ? await getBooking(bookingId) : null
  if (!booking) {
    // Normal para links creados a mano en el portal; pero un cobro real aprobado sin cita merece rastro.
    if (event.type === 'SALE_APPROVED') console.warn(`[bold-webhook] venta aprobada sin cita asociada: ref "${event.reference}", $${event.amount}, pago ${event.paymentId}`)
    return 'sin cita asociada'
  }

  // Una anulación no se deshace sola: la decide una persona.
  if (event.type === 'VOID_APPROVED') {
    if (booking.phone) await requestAgent(booking.phone, `Bold anuló el pago del anticipo de la cita ${booking.id}`, 'payment')
    return 'anulación: pasa a un asesor'
  }
  // Un pago rechazado no cambia nada: el link sigue activo para que el cliente reintente.
  if (event.type !== 'SALE_APPROVED') return 'sin acción'
  // Bold reintenta y a veces manda el mismo pago dos veces: una cita ya confirmada no se toca.
  if (booking.status === 'confirmed') return 'ya estaba confirmada'

  const paid = event.amount ?? 0
  if (!HOLD_STATUSES.includes(booking.status)) {
    // Dinero cobrado por una cita que ya no está apartada (se liberó o se canceló): sin esta
    // alerta Bold cobra y nadie se entera. Una persona decide: reagendar o reembolsar.
    const detail = `Bold cobró ${pesos(paid)} (${event.paymentMethod}) de una cita ${booking.status === 'cancelled' ? 'cancelada' : `en estado ${booking.status}`}: reagendar o reembolsar. Cita ${booking.id}, pago ${event.paymentId}`
    if (booking.phone && await getSummary(booking.phone)) await requestAgent(booking.phone, detail, 'payment')
    console.error(`[bold-webhook] ${detail}`)
    return `pago sobre cita ${booking.status}: pasa a un asesor`
  }

  const expected = Number(booking.deposit.replace(/[^\d]/g, '')) || 0
  if (expected && paid < expected) {
    if (booking.phone) await requestAgent(booking.phone, `Bold reporta un pago de ${pesos(paid)}, menor al anticipo de ${booking.deposit}`, 'payment')
    return 'monto menor al anticipo: pasa a un asesor'
  }

  const confirmed = await confirmPaidByBold(booking.id, { method: event.paymentMethod, paymentRef: event.paymentId })
  if (!confirmed) return 'no se pudo confirmar'
  if (!booking.phone) return 'confirmada (sin chat)'

  const method = METHOD_LABEL[event.paymentMethod] ?? event.paymentMethod
  await notePayment(booking.phone, `Pago recibido · ${booking.name || booking.phone} · ${pesos(paid)} · ${method}`)

  const text = `¡Recibimos tu anticipo de ${pesos(paid)}! 💛 Tu cita de *${serviceText(booking)}* quedó confirmada para el ${dayLabel(booking.day)} a las ${clock12(booking.start)} en ${LOCATION_LABEL[booking.location]}. Te esperamos.`
  try {
    const waId = await sendWhatsAppText(booking.phone, text)
    await recordOutbound(booking.phone, { id: waId ?? crypto.randomUUID(), sender: 'gem', text, at: Date.now() })
  } catch (error) {
    // La cita ya quedó confirmada; lo que falló es avisarle (p. ej. pasaron más de 24 h).
    const detail = error instanceof Error ? error.message : String(error)
    await requestAgent(booking.phone, `Cita confirmada por Bold, pero no se pudo avisar al cliente: ${detail}`, 'payment')
    return 'confirmada; el aviso por WhatsApp falló'
  }
  return 'confirmada y avisada'
}
