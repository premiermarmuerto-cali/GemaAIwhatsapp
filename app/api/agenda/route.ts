import { NextResponse, type NextRequest } from 'next/server'
import { bookingsOfDays, createBooking, isClosed } from '@/lib/booking'
import { dayKey, isClock, isDayKey, weekOf } from '@/lib/calendar'
import { isLocation } from '@/lib/clinic'
import { getConfig } from '@/lib/config'
import { HttpError, jsonBody, route } from '@/lib/http'
import { isValidPhone, normalizePhone } from '@/lib/phone'
import type { AgendaWeek } from '@/lib/types'

export const dynamic = 'force-dynamic'

/** Semana de agenda: citas, bloqueos, días cerrados y la configuración que el panel necesita para pintar. */
export const GET = route(async (request: NextRequest) => {
  const asked = request.nextUrl.searchParams.get('week')
  const days = weekOf(isDayKey(asked) ? asked : dayKey())
  const config = await getConfig()
  const [bookings, ...closedFlags] = await Promise.all([
    bookingsOfDays(days),
    ...days.map((day) => isClosed(day)),
  ])

  const closed: Record<string, string> = {}
  days.forEach((day, index) => {
    const reason = closedFlags[index]
    if (reason) closed[day] = reason
  })

  const payload: AgendaWeek = {
    days,
    bookings: bookings.filter((booking) => booking.status !== 'cancelled').sort((a, b) => a.startTs - b.startTs),
    closed,
    hours: config.hours,
    slotMinutes: config.slotMinutes,
    cabins: config.cabins,
    addresses: config.addresses,
    services: config.services.map(({ id, label, durationMin, price }) => ({ id, label, durationMin, price })),
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

  const phone = normalizePhone(String(body.phone ?? ''))
  if (kind === 'appointment' && !isValidPhone(phone)) throw new HttpError(400, 'Teléfono inválido.')

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
    kind,
    // Lo que agenda el operador no espera anticipo: ya habló con el cliente.
    status: 'confirmed',
  })

  if (!result.ok) {
    const message = {
      service: 'Ese servicio no existe en el catálogo.',
      closed: 'Ese día está cerrado. Ábrelo antes de agendar.',
      taken: result.alternatives.length ? `Ese horario ya está ocupado. Libres: ${result.alternatives.join(', ')}.` : 'Ese horario ya está ocupado y ese día no queda espacio.',
    }[result.reason]
    throw new HttpError(409, message)
  }
  return NextResponse.json(result.booking, { status: 201 })
})
