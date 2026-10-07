import { NextResponse } from 'next/server'
import { getConfig, parseConfig, saveConfig } from '@/lib/config'
import { HttpError, jsonBody, route } from '@/lib/http'

export const dynamic = 'force-dynamic'

export const GET = route(async () => NextResponse.json(await getConfig()))

export const PUT = route(async (request: Request) => {
  const parsed = parseConfig(await jsonBody(request))
  if ('error' in parsed) throw new HttpError(400, parsed.error)
  await saveConfig(parsed.config)
  return NextResponse.json(parsed.config)
})
