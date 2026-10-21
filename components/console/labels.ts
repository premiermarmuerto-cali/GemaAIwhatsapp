import { LOCATION_LABEL } from '@/lib/clinic'
import type { AgentKind, ChatSummary, Sender } from '@/lib/types'

/** Moneda en la que se le cotiza a este cliente, según su país. Con Bold, todos pagan en pesos. */
export function regionLabel(chat: Pick<ChatSummary, 'region'>) {
  return chat.region === 'CO' ? 'COP · Colombia' : 'COP · Internacional'
}

/** Métodos con los que puede pagar la reserva. Debe coincidir con lib/config.ts → paymentFor. */
export function paymentMethods(chat: Pick<ChatSummary, 'region'>) {
  return chat.region === 'CO' ? 'Bold (tarjeta · PSE · Nequi) · transferencia' : 'Bold (tarjeta de crédito internacional)'
}

/** Resumen de una línea de lo que Gema averiguó del prospecto. */
export function leadSummary(chat: Pick<ChatSummary, 'lead'>): string {
  const { concern, serviceId, location } = chat.lead
  const parts = [concern, serviceId, location && LOCATION_LABEL[location]].filter(Boolean)
  return parts.join(' · ')
}

export function avatarLabel(chat: Pick<ChatSummary, 'name' | 'phone'>) {
  const initial = chat.name.trim()[0]
  return (initial ?? chat.phone.slice(-2)).toUpperCase()
}

export const SENDER_LABEL: Record<Sender, string> = {
  user: 'Cliente',
  gem: 'Gema · IA',
  human: 'Tú · Operador',
}

export const PREVIEW_PREFIX: Record<Sender, string> = {
  user: '',
  gem: 'Gema: ',
  human: 'Tú: ',
}

/** Nombres de las automatizaciones (lib/automations.ts) tal como se muestran en el panel. */
export const AUTO_LABEL: Record<string, string> = {
  bienvenida: 'Bienvenida con el 2x1',
  seguimiento_pago: 'Aviso: el horario se libera',
  seguimiento_45m: 'Seguimiento 45 min: ritual y hora',
  seguimiento_3h: 'Seguimiento 3 h: cero invasiva y 2x1',
  seguimiento_22h: 'Seguimiento a las 22 h',
  efectivo_retoma: 'Gema retomó (pago en efectivo)',
  retomar_cita_limpieza: 'Plantilla: retomar cita',
  anticipo_pendiente: 'Plantilla: anticipo pendiente',
  ultimos_dias_bono: 'Plantilla: últimos días de la promo',
  recordatorio_cita: 'Recordatorio de la cita',
  recordatorio_hoy: 'Recordatorio del día',
}

export const OBJECTION_LABEL: Record<string, string> = {
  efectivo: 'Quiere pagar en efectivo',
}

/**
 * Evento de conversión a Meta, para auditarlo: "Cita (LeadSubmitted) enviada" o el motivo por el que
 * no salió. Sin clic de anuncio no hay evento posible.
 */
export function capiLabel(chat: Pick<ChatSummary, 'capiStatus' | 'ctwaClid'>): string {
  if (!chat.capiStatus) return chat.ctwaClid ? 'Sin eventos todavía (se envían al agendar y al pagar)' : 'No aplica: no llegó desde un anuncio'
  try {
    const status = JSON.parse(chat.capiStatus) as { event: string; ok: boolean; reason?: string; at: number }
    const name = status.event === 'Purchase' ? 'Pago (Purchase)' : status.event === 'LeadSubmitted' ? 'Cita (LeadSubmitted)' : status.event
    return status.ok ? `${name} enviado` : `${name} no enviado: ${status.reason ?? 'error'}`
  } catch {
    return chat.capiStatus
  }
}

export const AGENT_LABEL: Record<AgentKind, string> = {
  help: 'Requiere asesor',
  payment: 'Pago por validar',
}
