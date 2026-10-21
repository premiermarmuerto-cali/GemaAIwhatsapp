/**
 * Plantillas de Meta enviadas a mano desde el panel, cuando ya pasaron 24 h desde el último mensaje del
 * cliente y WhatsApp no deja escribirle libre. Son las mismas plantillas aprobadas que usa el
 * programador (lib/automations.ts), con sus variables completas desde el chat, la cita y el 2x1.
 *
 * Al enviar una: queda en el historial, se quita la alerta de asesor y Gema vuelve a atender el chat,
 * así cuando el cliente responda, ella le contesta (antes "Devolver a Gema" parecía no hacer nada: con
 * la ventana cerrada, Gema no puede escribir primero).
 */
import { bookingsOfPhone, liveBookingOf } from './booking'
import { dayKey, fullDayLabel, isQuietHours } from './calendar'
import { markChatAuto, recordOutbound, updateChat } from './chats'
import { LOCATION_LABEL } from './clinic'
import { getConfig } from './config'
import { keys, redis } from './redis'
import { firstName } from './presets'
import { offerText, PEELING_ID, templateClock, TEMPLATES, type TemplateName } from './automations'
import type { ChatSummary } from './types'
import { sendWhatsAppTemplate } from './whatsapp'

export type TemplateOption = {
  name: TemplateName
  label: string
  /** Para qué sirve, en una línea. */
  hint: string
  /** Se cobra como marketing (más caro) o como utilidad. */
  marketing: boolean
  /** null = se puede enviar; si no, por qué no. */
  unavailable: string | null
  /** La más lógica para este chat (se muestra primero y resaltada). */
  suggested: boolean
}

const publicUrl = () => (process.env.PUBLIC_APP_URL || 'https://premier-agente.vercel.app').replace(/\/$/, '')

/** Variables de cada plantilla para este chat, o el motivo por el que no aplica. */
async function paramsFor(name: TemplateName, chat: ChatSummary): Promise<{ params: Record<string, string> } | { error: string }> {
  const nombre = firstName(chat.name) || 'de nuevo'
  if (name === 'retomar_cita_limpieza') return { params: { nombre_cliente: nombre } }
  if (name === 'ultimos_dias_bono') {
    const until = (await getConfig()).twoForOne[PEELING_ID]
    if (!until || until < dayKey()) return { error: 'el 2x1 del Peeling no tiene fecha de cierre vigente' }
    return { params: { nombre_cliente: nombre, oferta: offerText(until) } }
  }
  if (name === 'recordatorio_cita') {
    const booking = await liveBookingOf(chat.phone)
    if (!booking || booking.status !== 'confirmed') return { error: 'no tiene una cita confirmada' }
    return { params: { nombre_cliente: firstName(booking.name) || nombre, fecha_cita: fullDayLabel(booking.day), hora_cita: templateClock(booking.start), sede: LOCATION_LABEL[booking.location] } }
  }
  // anticipo_pendiente: solo si su último horario se liberó por no pagar el anticipo.
  const [last] = await bookingsOfPhone(chat.phone, 1)
  const reason = last ? await redis().hget<string>(keys.booking(last.id), 'cancelReason') : null
  if (!last || last.status !== 'cancelled' || reason !== 'Anticipo no pagado a tiempo') return { error: 'no tiene un horario que se le haya liberado por no pagar el anticipo' }
  return { params: { nombre_cliente: firstName(last.name) || nombre } }
}

const INFO: Record<TemplateName, { label: string; hint: string }> = {
  retomar_cita_limpieza: { label: 'Retomar la conversación', hint: 'Para quien escribió y no agendó (o no recibió respuesta). Trae los botones "Sí, quiero agendar" / "Tengo una pregunta" / "Ahora no".' },
  ultimos_dias_bono: { label: 'Últimos días del 2x1', hint: 'Recuerda que el 2x1 del Peeling se termina, con la fecha.' },
  anticipo_pendiente: { label: 'Anticipo pendiente', hint: 'A quien se le liberó el horario por no pagar el anticipo. Trae el botón "Enviar link".' },
  recordatorio_cita: { label: 'Recordatorio de la cita', hint: 'Fecha, hora y sede de su cita confirmada, con "Confirmo mi cita".' },
}

const MARKETING_GAP_MS = 3 * 24 * 60 * 60_000

/**
 * Por qué no se le puede enviar ninguna plantilla ahora (o null). Para no hacer spam: una sola plantilla
 * hasta que el cliente responda (manual o automática), máximo una de marketing cada 3 días, y nada
 * entre 9 p.m. y 8 a.m.
 */
export function templateLock(chat: ChatSummary, now = Date.now()): string | null {
  if (chat.optedOut) return 'dijo que no le interesa'
  if (isQuietHours(now)) return 'entre 9 p.m. y 8 a.m. no se le escribe a nadie'
  const sent = Object.entries(chat.autoSent)
    .filter(([key]) => !key.endsWith(':error') && key.split(':')[0] in TEMPLATES)
    .map(([key, at]) => ({ name: key.split(':')[0], at }))
  const last = sent.sort((a, b) => b.at - a.at)[0]
  if (last && last.at > chat.lastInboundAt) return `ya se le envió una plantilla el ${new Date(last.at).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}: hay que esperar a que responda`
  const lastMarketing = sent.find((item) => item.name !== 'recordatorio_cita')
  if (lastMarketing && now - lastMarketing.at < MARKETING_GAP_MS) return 'ya recibió una plantilla de marketing en los últimos 3 días'
  return null
}

/** Las plantillas para este chat, con la más lógica primero. */
export async function templateOptions(chat: ChatSummary): Promise<TemplateOption[]> {
  const names = Object.keys(TEMPLATES) as TemplateName[]
  const checks = await Promise.all(names.map(async (name) => ({ name, result: await paramsFor(name, chat) })))
  const available = (name: TemplateName) => checks.find((check) => check.name === name && 'params' in check.result)
  // La sugerida: recordatorio si tiene cita; anticipo si se le cayó el horario; si no, retomar.
  const suggested: TemplateName = available('recordatorio_cita') ? 'recordatorio_cita' : available('anticipo_pendiente') ? 'anticipo_pendiente' : 'retomar_cita_limpieza'
  const options = checks.map(({ name, result }): TemplateOption => {
    const blocked = templateLock(chat) ?? ('error' in result ? result.error : null)
    return { name, ...INFO[name], marketing: name !== 'recordatorio_cita', unavailable: blocked, suggested: name === suggested }
  })
  return options.sort((a, b) => Number(b.suggested) - Number(a.suggested) || Number(Boolean(a.unavailable)) - Number(Boolean(b.unavailable)))
}

/** Envía una plantilla a este chat y deja a Gema atendiendo para cuando el cliente responda. */
export async function sendTemplate(chat: ChatSummary, name: TemplateName): Promise<{ error: string } | { ok: true }> {
  const lock = templateLock(chat)
  if (lock) return { error: `No se puede enviar: ${lock}.` }
  const result = await paramsFor(name, chat)
  if ('error' in result) return { error: `Esta plantilla no aplica: ${result.error}.` }
  const { language, image } = TEMPLATES[name] as { language: string; image?: string }
  const id = await sendWhatsAppTemplate(chat.phone, { name, language, params: result.params, ...(image ? { headerImageUrl: `${publicUrl()}/plantillas/${image}` } : {}) })
  const summary = `[Plantilla "${name}" enviada desde el panel · ${Object.entries(result.params).map(([key, value]) => `${key}: ${value}`).join(' · ')}]`
  await recordOutbound(chat.phone, { id: id ?? crypto.randomUUID(), sender: 'gem', text: summary, at: Date.now(), auto: name })
  await markChatAuto(chat, name)
  await updateChat(chat.phone, { needsAgent: false, botActive: true })
  return { ok: true }
}
