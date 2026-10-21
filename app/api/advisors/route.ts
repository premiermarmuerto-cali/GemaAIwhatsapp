import { NextResponse, type NextRequest } from 'next/server'
import { forgetAdvisor, listAdvisors } from '@/lib/advisors'
import { HttpError, route } from '@/lib/http'
import { bumpRev } from '@/lib/revision'

export const dynamic = 'force-dynamic'

/** Lista de asesores guardados (la agenda ya la trae; esto sirve para refrescarla). */
export const GET = route(async () => NextResponse.json({ advisors: await listAdvisors() }))

/** Quita un asesor de la lista (`?name=`). Las citas que ya tiene asignadas no cambian. */
export const DELETE = route(async (request: NextRequest) => {
  const name = request.nextUrl.searchParams.get('name')?.trim()
  if (!name) throw new HttpError(400, 'Falta el nombre del asesor.')
  await forgetAdvisor(name)
  await bumpRev('agenda')
  return NextResponse.json({ advisors: await listAdvisors() })
})
