import type { Region } from './types'

// Prefijos más probables para la pauta. El de mayor longitud gana (p. ej. 593 antes que 59).
const COUNTRY_PREFIXES: Array<[prefix: string, iso: string]> = [
  ['593', 'EC'], ['591', 'BO'], ['595', 'PY'], ['598', 'UY'], ['502', 'GT'], ['503', 'SV'], ['504', 'HN'],
  ['505', 'NI'], ['506', 'CR'], ['507', 'PA'], ['57', 'CO'], ['52', 'MX'], ['51', 'PE'], ['56', 'CL'],
  ['54', 'AR'], ['58', 'VE'], ['55', 'BR'], ['34', 'ES'], ['44', 'GB'], ['1', 'US'],
]

/**
 * Identificador de WhatsApp de un cliente que usa nombre de usuario y oculta su número ("CO.1349…",
 * business-scoped user ID). Meta lo envía en `from_user_id` y entonces el mensaje llega SIN `from`.
 * En todo el sistema hace las veces del teléfono: es la llave del chat, de sus citas y del envío
 * (que va por `recipient` en vez de `to`, ver lib/whatsapp.ts).
 */
const USER_ID = /^[A-Z]{2}(\.[A-Z]{2,5})?\.[A-Za-z0-9]{4,64}$/

export function isWhatsAppUserId(value: string): boolean {
  return USER_ID.test(value)
}

/**
 * Única forma canónica de un teléfono en todo el sistema: solo dígitos, con indicativo. Un
 * identificador de usuario de WhatsApp (sin número) se conserva tal cual.
 */
export function normalizePhone(input: string): string {
  const trimmed = input.trim()
  return isWhatsAppUserId(trimmed) ? trimmed : trimmed.replace(/\D/g, '')
}

/** Teléfono con indicativo, o identificador de usuario de WhatsApp. */
export function isValidPhone(value: string): boolean {
  return /^\d{8,15}$/.test(value) || isWhatsAppUserId(value)
}

export function countryOf(value: string): string {
  // El identificador de usuario empieza con el país ("CO.…").
  if (isWhatsAppUserId(value)) return COUNTRY_PREFIXES.some(([, iso]) => iso === value.slice(0, 2)) ? value.slice(0, 2) : 'INTL'
  return COUNTRY_PREFIXES.find(([prefix]) => value.startsWith(prefix))?.[1] ?? 'INTL'
}

/** Colombia cobra en COP vía Nequi o transferencia; cualquier otro país se atiende en USD. */
export function regionOf(digits: string): Region {
  return countryOf(digits) === 'CO' ? 'CO' : 'INTL'
}

export function formatPhone(digits: string): string {
  if (isWhatsAppUserId(digits)) return 'Usuario de WhatsApp (número oculto)'
  if (digits.startsWith('57') && digits.length === 12) return `+57 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`
  if (digits.startsWith('1') && digits.length === 11) return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  return `+${digits}`
}
