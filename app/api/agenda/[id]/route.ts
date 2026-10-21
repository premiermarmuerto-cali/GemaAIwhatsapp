import { NextResponse } from 'next/server'
import { annotateBooking, bookingsOfPhone, getBooking, moveBooking, rescheduleBooking, setBookingAdvisor, setBookingPayment, updateBookingDetails } from '@/lib/booking'
import { canonicalPhone, isValidPhone } from '@/lib/phone'
import { isClock, isDayKey } from '@/lib/calendar'
import { isLocation } from '@/lib/clinic'
import { amountOf, getConfig } from '@/lib/config'
import { rememberAdvisor } from '@/lib/advisors'
import { trackConversion } from '@/lib/conversions'
import { HttpError, jsonBody, route } from '@/lib/http'
import { HOLD_STATUSES, LIVE_STATUSES, type BookingStatus } from '@/lib/types'

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
  if (typeof body.advisor === 'string') {
    await setBookingAdvisor(id, body.advisor)
    await rememberAdvisor(body.advisor)
  }

  // Editar la cita (panel): datos de la persona.
  const details: { name?: string; companion?: string; phone?: string; contactPhone?: string } = {}
  if (typeof body.name === 'string') {
    if (!body.name.trim()) throw new HttpError(400, 'El nombre no puede quedar vacío.')
    details.name = body.name
  }
  if (typeof body.companion === 'string') details.companion = body.companion
  if (typeof body.phone === 'string') {
    // Escrito a mano: un celular colombiano de 10 dígitos se completa con 57.
    const phone = canonicalPhone(body.phone)
    if (!isValidPhone(phone)) throw new HttpError(400, 'Teléfono inválido.')
    details.phone = phone
  }
  if (typeof body.contactPhone === 'string') details.contactPhone = body.contactPhone ? canonicalPhone(body.contactPhone) : ''
  if (Object.keys(details).length && !(await updateBookingDetails(id, details))) throw new HttpError(404, 'La cita no existe.')
  if (body.payment === 'onsite' || body.payment === 'deposit' || body.payment === 'full' || body.payment === 'courtesy') await setBookingPayment(config, id, body.payment)

  if (body.day !== undefined || body.start !== undefined) {
    const day = String(body.day ?? '')
    const start = String(body.start ?? '')
    if (!isDayKey(day) || !isClock(start)) throw new HttpError(400, 'Fecha u hora inválidas para reprogramar.')
    const location = body.location === undefined ? undefined : String(body.location)
    if (location !== undefined && !isLocation(location)) throw new HttpError(400, 'Sede inválida.')
    const serviceId = typeof body.serviceId === 'string' ? body.serviceId : undefined
    const moved = await rescheduleBooking(config, id, day, start, location, serviceId)
    if (!moved) throw new HttpError(404, 'La cita no existe.')
    if (!moved.ok) {
      if (moved.reason === 'service') throw new HttpError(400, 'Ese servicio no existe en el catálogo.')
      if (moved.reason === 'closed') throw new HttpError(409, 'Ese día está cerrado.')
      if (moved.reason === 'cabins') throw new HttpError(409, 'Esa sede no tiene cabinas suficientes para dos personas a la vez.')
      throw new HttpError(409, moved.alternatives.length ? `Ese horario está ocupado. Libres: ${moved.alternatives.join(', ')}.` : 'Ese horario no está disponible.')
    }
    return NextResponse.json(moved.booking)
  }

  if (body.status !== undefined) {
    const status = String(body.status) as BookingStatus
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Estado inválido.')
    const before = await getBooking(id)
    const moved = await moveBooking(id, status)
    if (!moved) throw new HttpError(404, 'La cita no existe.')
    if ('error' in moved) throw new HttpError(409, moved.error)
    // La asesora confirmó un pago por transferencia: se avisa a Meta (si la clienta llegó por un anuncio).
    // Las que confirma Bold ya se reportan solas; las creadas a mano por el operador no tienen pago.
    if (status === 'confirmed' && before && HOLD_STATUSES.includes(before.status) && before.phone && !before.paymentRef) {
      await trackConversion({ name: 'Purchase', phone: before.phone, eventId: `pago_${before.phone}_${before.id}`, value: amountOf(before.deposit) })
    }
    // La sesión se realizó: quien pagó todo en la sede (efectivo, o cita creada a mano) también es una
    // venta del anuncio. Mismo event_id que el anticipo: si ese ya se reportó, Meta no lo cuenta dos veces.
    // Una limpieza de cortesía no es una venta del anuncio: no se reporta a Meta.
    if (status === 'done' && before && before.kind !== 'block' && before.phone && before.paymentPlan !== 'courtesy') {
      await trackConversion({ name: 'Purchase', phone: before.phone, eventId: `pago_${before.phone}_${before.id}`, value: amountOf(before.price) })
    }
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
