import { NextResponse, type NextRequest } from 'next/server'
import { runAutomations } from '@/lib/automations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Programador de automatizaciones (lib/automations.ts). Lo llama cada 10–15 minutos un programador
 * externo (Vercel Cron en el plan Pro, o cron-job.org) con el encabezado
 * `Authorization: Bearer <CRON_SECRET>`. Sin CRON_SECRET configurado no hace nada.
 * `?dry=1` muestra a quién le tocaría qué, sin enviar.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET no está configurado.' }, { status: 503 })
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })

  const dryRun = request.nextUrl.searchParams.get('dry') === '1'
  const outcomes = await runAutomations({ dryRun })
  const sent = outcomes.filter((outcome) => outcome.how === 'texto' || outcome.how === 'plantilla').length
  const errors = outcomes.filter((outcome) => outcome.how === 'error')
  if (errors.length) console.error('[cron] automatizaciones con error:', JSON.stringify(errors))
  return NextResponse.json({ dryRun, sent, outcomes })
}
