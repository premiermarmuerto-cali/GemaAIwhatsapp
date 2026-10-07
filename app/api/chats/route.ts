import { NextResponse } from 'next/server'
import { listChats } from '@/lib/chats'
import { route } from '@/lib/http'

export const dynamic = 'force-dynamic'

/** Bandeja y archivo. El envío manual vive en /api/chats/[phone]/messages. */
export const GET = route(async () => NextResponse.json(await listChats()))
