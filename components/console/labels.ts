import { LOCATION_LABEL } from '@/lib/clinic'
import type { AgentKind, ChatSummary, Sender } from '@/lib/types'

/** Moneda en la que se le cotiza a este cliente, según su país. */
export function regionLabel(chat: Pick<ChatSummary, 'region'>) {
  return chat.region === 'CO' ? 'COP · Colombia' : 'USD · Internacional'
}

/** Métodos con los que puede pagar el anticipo. Debe coincidir con lib/config.ts → paymentFor. */
export function paymentMethods(chat: Pick<ChatSummary, 'region'>) {
  return chat.region === 'CO' ? 'Nequi · Bancolombia · Daviplata' : 'Binance · PayPal · Wise · ACH (DolarApp)'
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

export const AGENT_LABEL: Record<AgentKind, string> = {
  help: 'Requiere asesor',
  payment: 'Anticipo por validar',
}
