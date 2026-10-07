import type { BookingStatus } from '@/lib/types'

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

/** Cuánto le queda al apartado antes de liberarse solo. */
export function holdCountdown(holdUntil: number, now = Date.now()): string {
  const minutes = Math.round((holdUntil - now) / 60_000)
  if (minutes <= 0) return 'vencido'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}
