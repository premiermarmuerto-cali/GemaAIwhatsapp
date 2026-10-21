import { amountOf, pesos } from '@/lib/money'
import type { Booking, BookingStatus } from '@/lib/types'

export const STATUS_LABEL: Record<BookingStatus, string> = {
  hold: 'Apartada',
  pending_payment: 'Pendiente de pago',
  confirmed: 'Confirmada',
  done: 'Realizada',
  no_show: 'No asistió',
  cancelled: 'Cancelada',
}

/** Las acciones que el operador puede tomar desde cada estado, en el orden en que las necesita. */
export const NEXT_STATUSES: Record<BookingStatus, BookingStatus[]> = {
  hold: ['confirmed', 'cancelled'],
  pending_payment: ['confirmed', 'cancelled'],
  confirmed: ['done', 'no_show', 'cancelled'],
  done: [],
  no_show: ['done'],
  cancelled: [],
}

export const ACTION_LABEL: Record<BookingStatus, string> = {
  hold: 'Apartar',
  pending_payment: 'Pendiente de pago',
  confirmed: 'Confirmar anticipo',
  done: 'Marcar realizada',
  no_show: 'No asistió',
  cancelled: 'Cancelar',
}

/** Medios de pago de Bold, como los reporta su webhook. */
export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  PSE: 'PSE',
  CREDIT_CARD: 'Tarjeta',
  NEQUI: 'Nequi',
  BOTON_BANCOLOMBIA: 'Botón Bancolombia',
}

/** Cuánto le queda al apartado antes de liberarse solo. */
export function holdCountdown(holdUntil: number, now = Date.now()): string {
  const minutes = Math.round((holdUntil - now) / 60_000)
  if (minutes <= 0) return 'vencido'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** Cómo va el pago de una cita, para que la cabina sepa cuánto cobrar. */
export type PaymentState = 'courtesy' | 'onsite' | 'deposit-paid' | 'deposit-pending' | 'full-paid' | 'full-pending'

/** Lo que se registró como pago para agendar: la marca `paidAt` la ponen Bold, la asesora al confirmar o el alta manual. */
export function paymentState(booking: Pick<Booking, 'paymentPlan' | 'paidAt' | 'paymentRef'>): PaymentState {
  const paid = booking.paidAt > 0 || Boolean(booking.paymentRef)
  if (booking.paymentPlan === 'courtesy') return 'courtesy'
  if (booking.paymentPlan === 'cash') return 'onsite'
  if (booking.paymentPlan === 'full') return paid ? 'full-paid' : 'full-pending'
  return paid ? 'deposit-paid' : 'deposit-pending'
}

/** "Anticipo pagado $25.000 · faltan $105.000 en la sede", "Paga $130.000 en la sede", "Pagada completa". */
export function paymentSummary(booking: Pick<Booking, 'paymentPlan' | 'paidAt' | 'paymentRef' | 'price' | 'deposit'>): { short: string; long: string } {
  const total = amountOf(booking.price)
  const deposit = amountOf(booking.deposit)
  switch (paymentState(booking)) {
    case 'courtesy': return { short: 'Cortesía', long: 'Limpieza de cortesía (por compra de productos): no se cobra' }
    case 'onsite': return { short: 'Paga en sede', long: `No ha pagado nada: paga ${total ? pesos(total) : 'todo'} en la sede` }
    case 'deposit-paid': return { short: 'Anticipo pagado', long: `Anticipo pagado ${pesos(deposit)} · faltan ${pesos(Math.max(0, total - deposit))} en la sede` }
    case 'deposit-pending': return { short: 'Anticipo pendiente', long: `Anticipo de ${pesos(deposit)} sin pagar todavía` }
    case 'full-paid': return { short: 'Pagada completa', long: `Pagó la sesión completa (${pesos(total)}): no paga nada en la sede` }
    default: return { short: 'Pago pendiente', long: `Pago completo de ${pesos(total)} sin pagar todavía` }
  }
}
