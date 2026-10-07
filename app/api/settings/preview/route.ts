import { NextResponse, type NextRequest } from 'next/server'
import { getConfig } from '@/lib/config'
import { route } from '@/lib/http'
import { buildPromptContext, buildSystemPrompt } from '@/lib/prompt'

export const dynamic = 'force-dynamic'

// Números de ejemplo: solo sirven para resolver la región del prompt; no se les escribe nada.
const SAMPLE_PHONES = { CO: '573001234567', INTL: '14155550100' } as const

/** El prompt exacto que recibiría Gema ahora mismo, con la disponibilidad real de esta semana. */
export const GET = route(async (request: NextRequest) => {
  const asked = request.nextUrl.searchParams.get('region')
  const phone = asked === 'INTL' ? SAMPLE_PHONES.INTL : SAMPLE_PHONES.CO
  const config = await getConfig()
  const context = await buildPromptContext(config, phone, { concern: '', serviceId: '', location: '' })
  return NextResponse.json({ prompt: buildSystemPrompt(config, phone, context) })
})
