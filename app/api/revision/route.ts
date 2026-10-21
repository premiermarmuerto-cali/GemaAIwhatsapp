import { NextResponse } from 'next/server'
import { route } from '@/lib/http'
import { readRevisions } from '@/lib/revision'

export const dynamic = 'force-dynamic'

/** ¿Cambió algo en los chats o en la agenda? Un solo comando de Redis; el panel lo consulta seguido. */
export const GET = route(async () => NextResponse.json(await readRevisions()))
