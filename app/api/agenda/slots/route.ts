import { NextResponse, type NextRequest } from 'next/server'
import { isClosed, occupancyOf, setClosed } from '@/lib/booking'
import { dayKey, freeStarts, isDayKey, startWindows } from '@/lib/calendar'
import { isLocation } from '@/lib/clinic'
import { getConfig, serviceById } from '@/lib/config'
import { HttpError, jsonBody, route } from '@/lib/http'

export const dynamic = 'force-dynamic'

/**
 * Huecos libres de una sede en un día. Con `service` devuelve los inicios exactos en los que
 * ese protocolo cabe; siempre, los rangos de horas de inicio libres (lo mismo que ve Gema).
 */
export const GET = route(async (request: NextRequest) => {
  const params = request.nextUrl.searchParams
  const location = params.get('location') ?? ''
  const day = params.get('day') ?? dayKey()
  if (!isLocation(location)) throw new HttpError(400, 'Sede inválida.')
  if (!isDayKey(day)) throw new HttpError(400, 'Fecha inválida.')

  const config = await getConfig()
  const closed = await isClosed(day)
  if (closed) return NextResponse.json({ day, location, closed, starts: [], windows: [] })

  const raw = await occupancyOf(location, day)
  // Al editar una cita, sus propias casillas cuentan como libres (si no, no podría moverse 15 minutos).
  const exclude = params.get('exclude')
  const occupancy = exclude ? Object.fromEntries(Object.entries(raw).filter(([, id]) => id !== exclude)) : raw
  const serviceId = params.get('service')
  const service = serviceId ? serviceById(config, serviceId) : undefined
  if (serviceId && !service) throw new HttpError(400, 'Ese servicio no existe.')
  const people = params.get('people') === '2' ? 2 : 1

  return NextResponse.json({
    day,
    location,
    closed: null,
    starts: service ? freeStarts(config, location, day, service.durationMin, occupancy, { people }) : [],
    windows: startWindows(config, location, day, occupancy, { people }),
  })
})

/** Cierra o reabre un día completo (festivo, inventario, viaje). No toca las citas ya creadas. */
export const PUT = route(async (request: Request) => {
  const body = await jsonBody(request)
  const day = String(body.day ?? '')
  if (!isDayKey(day)) throw new HttpError(400, 'Fecha inválida.')
  const reason = body.closed === false ? null : String(body.reason ?? 'Cerrado').slice(0, 120)
  await setClosed(day, reason)
  return NextResponse.json({ day, closed: reason })
})
