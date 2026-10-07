import type { ChatSummary } from './types'

/** WhatsApp solo permite mensajes libres durante 24 h desde el último mensaje del cliente. */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000

export function windowRemainingMs(chat: Pick<ChatSummary, 'lastInboundAt'>, now = Date.now()): number {
  return chat.lastInboundAt > 0 ? Math.max(0, chat.lastInboundAt + WHATSAPP_WINDOW_MS - now) : 0
}

export function isWindowOpen(chat: Pick<ChatSummary, 'lastInboundAt'>, now = Date.now()): boolean {
  return windowRemainingMs(chat, now) > 0
}
