import type { Region } from './types'

// Prefijos más probables para la pauta. El de mayor longitud gana (p. ej. 593 antes que 59).
const COUNTRY_PREFIXES: Array<[prefix: string, iso: string]> = [
  ['593', 'EC'], ['591', 'BO'], ['595', 'PY'], ['598', 'UY'], ['502', 'GT'], ['503', 'SV'], ['504', 'HN'],
  ['505', 'NI'], ['506', 'CR'], ['507', 'PA'], ['57', 'CO'], ['52', 'MX'], ['51', 'PE'], ['56', 'CL'],
  ['54', 'AR'], ['58', 'VE'], ['55', 'BR'], ['34', 'ES'], ['44', 'GB'], ['1', 'US'],
]

/** Única forma canónica de un teléfono en todo el sistema: solo dígitos, con indicativo. */
export function normalizePhone(input: string): string {
  return input.replace(/\D/g, '')
}

export function isValidPhone(digits: string): boolean {
  return /^\d{8,15}$/.test(digits)
}

export function countryOf(digits: string): string {
  return COUNTRY_PREFIXES.find(([prefix]) => digits.startsWith(prefix))?.[1] ?? 'INTL'
}

/** Colombia cobra en COP vía Nequi o transferencia; cualquier otro país se atiende en USD. */
export function regionOf(digits: string): Region {
  return countryOf(digits) === 'CO' ? 'CO' : 'INTL'
}

export function formatPhone(digits: string): string {
  if (digits.startsWith('57') && digits.length === 12) return `+57 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`
  if (digits.startsWith('1') && digits.length === 11) return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  return `+${digits}`
}
