import { NextResponse } from 'next/server'
import { annotateBooking, bookingsOfPhone, getBooking, moveBooking, rescheduleBooking } from '@/lib/booking'
import { isClock, isDayKey } from '@/lib/calendar'
import { isLocation } from '@/lib/clinic'
import { getConfig } from '@/lib/config'
import { HttpError, jsonBody, route } from '@/lib/http'
import { LIVE_STATUSES, type BookingStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

const STATUSES: BookingStatus[] = ['hold', 'pending_payment', 'confirmed', 'done', 'no_show', 'cancelled']

async function bookingId({ params }: Params) {
  const { id } = await params
  if (!/^[a-z0-9-]{4,40}$/i.test(id)) throw new HttpError(400, 'Id de cita inválido.')
  return id
}

/** Ficha completa de la cita, con el historial del cliente para que el operador tenga contexto. */
export const GET = route(async (_request: Request, context: Params) => {
  const booking = await getBooking(await bookingId(context))
  if (!booking) throw new HttpError(404, 'La cita no existe.')
  const history = booking.phone ? (await bookingsOfPhone(booking.phone, 10)).filter((item) => item.id !== booking.id) : []
  return NextResponse.json({ booking, history })
})

/**
 * Las tres acciones del panel: cambiar estado, anotar y reprogramar.
 * Reprogramar primero aparta el horario nuevo y solo entonces suelta el viejo.
 */
export const PATCH = route(async (request: Request, context: Params) => {
  const id = await bookingId(context)
  const body = await jsonBody(request)
  const config = await getConfig()

  if (typeof body.notes === 'string') {
    await annotateBooking(id, body.notes)
  }

  if (body.day !== undefined || body.start !== undefined) {
    const day = String(body.day ?? '')
    const start = String(body.start ?? '')
    if (!isDayKey(day) || !isClock(start)) throw new HttpError(400, 'Fecha u hora inválidas para reprogramar.')
    const location = body.location === undefined ? undefined : String(body.location)
    if (location !== undefined && !isLocation(location)) throw new HttpError(400, 'Sede inválida.')
    const moved = await rescheduleBooking(config, id, day, start, location)
    if (!moved) throw new HttpError(404, 'La cita no existe.')
    if (!moved.ok) {
      throw new HttpError(409, moved.alternatives.length ? `Ese horario está ocupado. Libres: ${moved.alternatives.join(', ')}.` : 'Ese horario no está disponible.')
    }
    return NextResponse.json(moved.booking)
  }

  if (body.status !== undefined) {
    const status = String(body.status) as BookingStatus
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Estado inválido.')
    const moved = await moveBooking(id, status)
    if (!moved) throw new HttpError(404, 'La cita no existe.')
    if ('error' in moved) throw new HttpError(409, moved.error)
    return NextResponse.json(moved)
  }

  const current = await getBooking(id)
  if (!current) throw new HttpError(404, 'La cita no existe.')
  return NextResponse.json(current)
})

/** Cancelar libera la cabina pero conserva la cita para auditoría. */
export const DELETE = route(async (_request: Request, context: Params) => {
  const id = await bookingId(context)
  const current = await getBooking(id)
  if (!current) throw new HttpError(404, 'La cita no existe.')
  if (!LIVE_STATUSES.includes(current.status)) return NextResponse.json(current)
  const moved = await moveBooking(id, 'cancelled')
  if (!moved || 'error' in moved) throw new HttpError(409, moved && 'error' in moved ? moved.error : 'No se pudo cancelar.')
  return NextResponse.json(moved)
})
