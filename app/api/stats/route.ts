import { NextResponse } from 'next/server'
import { route } from '@/lib/http'
import { getStats } from '@/lib/stats'

export const dynamic = 'force-dynamic'

export const GET = route(async () => NextResponse.json(await getStats()))
