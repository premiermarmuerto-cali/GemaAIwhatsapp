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
  seguimiento_pago: 'Aviso: el horario se libera',
  seguimiento_22h: 'Seguimiento a las 22 h',
  retomar_cita_limpieza: 'Plantilla: retomar cita',
  anticipo_pendiente: 'Plantilla: anticipo pendiente',
  ultimos_dias_bono: 'Plantilla: últimos días de la promo',
  recordatorio_cita: 'Recordatorio de la cita',
  recordatorio_hoy: 'Recordatorio del día',
}

export const AGENT_LABEL: Record<AgentKind, string> = {
  help: 'Requiere asesor',
  payment: 'Pago por validar',
}
