import { NextResponse, type NextRequest } from 'next/server'
import { forgetAdvisor, listAdvisors, renameAdvisor } from '@/lib/advisors'
import { HttpError, jsonBody, route } from '@/lib/http'
import { bumpRev } from '@/lib/revision'

export const dynamic = 'force-dynamic'

/** Lista de asesores guardados (la agenda ya la trae; esto sirve para refrescarla). */
export const GET = route(async () => NextResponse.json({ advisors: await listAdvisors() }))

/** Cambia el nombre de un asesor en la lista y en todas sus citas: { from, to }. */
export const PATCH = route(async (request: Request) => {
  const body = await jsonBody(request)
  const from = String(body.from ?? '').trim()
  const to = String(body.to ?? '').trim()
  if (!from || !to) throw new HttpError(400, 'Falta el nombre actual o el nuevo.')
  if (to.toLowerCase() === 'gema') throw new HttpError(400, '"Gema" está reservado para las citas que agenda ella.')
  const updated = await renameAdvisor(from, to)
  return NextResponse.json({ advisors: await listAdvisors(), updated })
})

/** Quita un asesor de la lista (`?name=`). Las citas que ya tiene asignadas no cambian. */
export const DELETE = route(async (request: NextRequest) => {
  const name = request.nextUrl.searchParams.get('name')?.trim()
  if (!name) throw new HttpError(400, 'Falta el nombre del asesor.')
  await forgetAdvisor(name)
  await bumpRev('agenda')
  return NextResponse.json({ advisors: await listAdvisors() })
})
