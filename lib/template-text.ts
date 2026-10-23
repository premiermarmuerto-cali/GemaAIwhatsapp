/**
 * El texto que de verdad le llegó al cliente con una plantilla: el cuerpo aprobado en Meta con sus
 * variables completas. Queda en el historial para que el operador vea qué se envió (antes solo veía
 * "[Plantilla "recordatorio_cita" enviada · …]") y para que Gema sepa qué le dijimos cuando conteste.
 */
import { keys, redis } from './redis'
import { TEMPLATES, type TemplateName } from './template-catalog'
import type { Message } from './types'

const version = process.env.WHATSAPP_API_VERSION || 'v26.0'
const DEFAULT_WABA_ID = '1997545614294706'
/** El texto aprobado casi nunca cambia: se pide a Meta una vez al día como mucho. */
const CACHE_SECONDS = 24 * 3600

/** Cuerpo aprobado de la plantilla, con {{variables}} sin completar. null si Meta no lo entrega. */
async function approvedBody(name: TemplateName): Promise<string | null> {
  const cacheKey = keys.templateText(name)
  const cached = await redis().get<string>(cacheKey).catch(() => null)
  if (cached) return cached
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  if (!token) return null
  const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || DEFAULT_WABA_ID
  try {
    const url = `https://graph.facebook.com/${version}/${waba}/message_templates?name=${encodeURIComponent(name)}&fields=name,language,components&limit=20`
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) })
    const data = await response.json().catch(() => null) as { data?: Array<{ name: string; language: string; components?: Array<{ type: string; text?: string }> }> } | null
    const template = data?.data?.find((item) => item.name === name && item.language === TEMPLATES[name].language)
    const body = template?.components?.find((component) => component.type === 'BODY')?.text
    if (!body) return null
    await redis().set(cacheKey, body, { ex: CACHE_SECONDS }).catch(() => null)
    return body
  } catch (error) {
    console.warn(`[plantillas] no se pudo leer el texto aprobado de ${name}:`, error instanceof Error ? error.message : error)
    return null
  }
}

/**
 * Mensaje del historial para una plantilla enviada. Si Meta no entrega el texto aprobado, queda el
 * resumen de siempre con las variables (el panel lo muestra igual como tarjeta de plantilla).
 */
export async function templateMessage(name: TemplateName, params: Record<string, string>, { id, auto, manual = false }: { id: string; auto: string; manual?: boolean }): Promise<Message> {
  const body = await approvedBody(name)
  const text = body
    ? body.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => params[key] ?? whole)
    : `[Plantilla "${name}" enviada${manual ? ' desde el panel' : ''} · ${Object.entries(params).map(([key, value]) => `${key}: ${value}`).join(' · ')}]`
  return { id, sender: 'gem', text, at: Date.now(), auto, template: { name, params, manual } }
}
