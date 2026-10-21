import { NextResponse, type NextRequest } from 'next/server'
import { listAdvisors, rememberAdvisor } from '@/lib/advisors'
import { bookingsOfDays, closedDays, createBooking } from '@/lib/booking'
import { dayKey, isClock, isDayKey, monthGrid, weekOf } from '@/lib/calendar'
import { isLocation } from '@/lib/clinic'
import { getConfig } from '@/lib/config'
import { HttpError, jsonBody, route } from '@/lib/http'
import { canonicalPhone, isValidPhone } from '@/lib/phone'
import type { AgendaWeek } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * Semana de agenda (`?week=YYYY-MM-DD`) o mes (`?month=YYYY-MM-DD`, seis semanas de lunes a domingo):
 * citas, bloqueos, días cerrados y la configuración que el panel necesita para pintar.
 */
export const GET = route(async (request: NextRequest) => {
  const params = request.nextUrl.searchParams
  const month = params.get('month')
  const asked = params.get('week')
  const days = isDayKey(month) ? monthGrid(month) : weekOf(isDayKey(asked) ? asked : dayKey())
  const config = await getConfig()
  const [bookings, closed, advisors] = await Promise.all([bookingsOfDays(days), closedDays(days), listAdvisors()])

  const payload: AgendaWeek = {
    days,
    ...(isDayKey(month) ? { month: month.slice(0, 7) } : {}),
    bookings: bookings.filter((booking) => booking.status !== 'cancelled').sort((a, b) => a.startTs - b.startTs),
    closed,
    hours: config.hours,
    slotMinutes: config.slotMinutes,
    cabins: config.cabins,
    addresses: config.addresses,
    services: config.services.map(({ id, label, durationMin, price }) => ({ id, label, durationMin, price })),
    advisors,
  }
  return NextResponse.json(payload)
})

/** El operador agenda a mano o bloquea un rato de cabina. */
export const POST = route(async (request: Request) => {
  const body = await jsonBody(request)
  const config = await getConfig()

  const kind = body.kind === 'block' ? 'block' : 'appointment'
  const location = String(body.location ?? '')
  const day = String(body.day ?? '')
  const start = String(body.start ?? '')
  if (!isLocation(location)) throw new HttpError(400, 'Sede inválida.')
  if (!isDayKey(day)) throw new HttpError(400, 'Fecha inválida.')
  if (!isClock(start)) throw new HttpError(400, 'Hora inválida.')

  const phone = canonicalPhone(String(body.phone ?? ''))
  if (kind === 'appointment' && !isValidPhone(phone)) throw new HttpError(400, 'Teléfono inválido.')
  if (kind === 'appointment' && !String(body.advisor ?? '').trim()) throw new HttpError(400, 'Escribe el asesor que agenda la cita.')

  const result = await createBooking(config, {
    phone: kind === 'block' ? '' : phone,
    name: String(body.name ?? '').slice(0, 80),
    location,
    serviceId: String(body.serviceId ?? ''),
    day,
    start,
    notes: String(body.notes ?? '').slice(0, 1000),
    concern: String(body.concern ?? '').slice(0, 300),
    source: 'operator',
    // Quién la agenda y a quién le corresponde la sesión (los operadores también agendan aquí).
    advisor: kind === 'block' ? '' : String(body.advisor ?? '').trim().slice(0, 60),
    kind,
    // Lo que agenda el operador no espera anticipo: ya habló con el cliente.
    status: 'confirmed',
    // Cómo paga: todo en la sede (por defecto), ya pagó el anticipo o ya pagó completo.
    cash: kind === 'appointment' && body.payment !== 'deposit' && body.payment !== 'full',
    payFull: body.payment === 'full',
    paid: body.payment === 'deposit' || body.payment === 'full',
    people: body.people === 2 ? 2 : 1,
  })

  if (!result.ok) {
    const message = {
      cabins: 'Esa sede no tiene cabinas suficientes para atender a dos personas a la vez.',
      service: 'Ese servicio no existe en el catálogo.',
      closed: 'Ese día está cerrado. Ábrelo antes de agendar.',
      taken: result.alternatives.length ? `Ese horario ya está ocupado. Libres: ${result.alternatives.join(', ')}.` : 'Ese horario ya está ocupado y ese día no queda espacio.',
    }[result.reason]
    throw new HttpError(409, message)
  }
  if (result.booking.advisor) await rememberAdvisor(result.booking.advisor)
  return NextResponse.json(result.booking, { status: 201 })
})
