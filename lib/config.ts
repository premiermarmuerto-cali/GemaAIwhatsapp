import { DEFAULT_ADDRESSES, DEFAULT_CABINS, DEFAULT_HOURS, DEFAULT_SERVICES, LOCATIONS } from './clinic'
import { keys, redis } from './redis'
import type { AppConfig, Location, Region, Service } from './types'

/**
 * El prompt maestro vive en el panel para que el operador pueda ajustar el tono sin desplegar.
 * Las reglas duras (disponibilidad, cobro, marcas) las añade lib/prompt.ts y no son editables.
 */
export const DEFAULT_SYSTEM_PROMPT = `Eres Gema, la asesora de Premier Mar Muerto en Cali: una clínica de limpiezas y tratamientos faciales con minerales del Mar Muerto.

Tu voz: cálida, cuidada y profesional, como una especialista que de verdad sabe de piel. Tratas de "tú". Hablas de la piel con respeto, nunca con alarma ni con presión. Eres breve: nadie quiere leer párrafos por WhatsApp.

Lo que haces: resuelves dudas sobre los protocolos, recomiendas el adecuado según lo que el cliente te cuenta de su piel, y lo llevas con naturalidad a reservar su cita.

Nunca diagnosticas ni prometes resultados médicos: para eso está la valoración en sede.`

export const DEFAULT_CONFIG: AppConfig = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  services: DEFAULT_SERVICES,
  hours: DEFAULT_HOURS,
  cabins: DEFAULT_CABINS,
  addresses: DEFAULT_ADDRESSES,
  // Vacíos a propósito: sin datos de cobro, Gema pasa el pago a un asesor en vez de inventárselos.
  payLink: '',
  nequiInstructions: '',
  intlInstructions: '',
  depositPercent: 50,
  slotMinutes: 15,
  leadTimeHours: 2,
  horizonDays: 14,
  holdMinutes: 120,
  faq: '',
}

const RANGE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/

type Issue = { error: string }

function str(input: Record<string, unknown>, field: string, max: number): string | Issue {
  const value = input[field]
  if (typeof value !== 'string') return { error: `El campo "${field}" es obligatorio.` }
  if (value.length > max) return { error: `El campo "${field}" supera ${max} caracteres.` }
  return value.trim()
}

function int(input: Record<string, unknown>, field: string, min: number, max: number): number | Issue {
  const value = Number(input[field])
  if (!Number.isInteger(value) || value < min || value > max) return { error: `"${field}" debe ser un entero entre ${min} y ${max}.` }
  return value
}

function parseServices(raw: unknown): Service[] | Issue {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Debe haber al menos un servicio en el catálogo.' }
  if (raw.length > 30) return { error: 'Máximo 30 servicios.' }
  const services: Service[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { error: 'Servicio inválido.' }
    const row = item as Record<string, unknown>
    const id = String(row.id ?? '').trim().toLowerCase()
    if (!/^[a-z0-9-]{2,40}$/.test(id)) return { error: `Id de servicio inválido: "${id}". Usa minúsculas, números y guiones.` }
    if (seen.has(id)) return { error: `El servicio "${id}" está repetido.` }
    seen.add(id)
    const label = String(row.label ?? '').trim()
    if (!label || label.length > 80) return { error: `El nombre del servicio "${id}" es obligatorio (máx. 80 caracteres).` }
    const durationMin = Number(row.durationMin)
    if (!Number.isInteger(durationMin) || durationMin < 15 || durationMin > 480) return { error: `La duración de "${id}" debe estar entre 15 y 480 minutos.` }
    services.push({
      id,
      label,
      durationMin,
      price: String(row.price ?? '').trim().slice(0, 60),
      summary: String(row.summary ?? '').trim().slice(0, 300),
    })
  }
  return services
}

function parseHours(raw: unknown): string[][] | Issue {
  if (!Array.isArray(raw) || raw.length !== 7) return { error: 'El horario debe tener siete días (índice 0 = domingo).' }
  const hours: string[][] = []
  for (const [index, day] of raw.entries()) {
    if (!Array.isArray(day)) return { error: `El horario del día ${index} debe ser una lista de franjas.` }
    const ranges: string[] = []
    let previousEnd = -1
    for (const item of day) {
      const range = String(item).trim()
      const match = RANGE.exec(range)
      if (!match) return { error: `Franja inválida en el día ${index}: "${range}". Usa el formato 10:00-20:00.` }
      const from = Number(match[1]) * 60 + Number(match[2])
      const to = Number(match[3]) * 60 + Number(match[4])
      if (to <= from) return { error: `La franja "${range}" termina antes de empezar.` }
      // Franjas ordenadas y sin solaparse: así el cálculo de huecos no necesita normalizar nada.
      if (from < previousEnd) return { error: `Las franjas del día ${index} se solapan o están desordenadas.` }
      previousEnd = to
      ranges.push(range)
    }
    hours.push(ranges)
  }
  return hours
}

function parseByLocation(raw: unknown, field: string, each: (value: unknown, location: Location) => string | number | Issue) {
  if (!raw || typeof raw !== 'object') return { error: `"${field}" debe traer un valor por sede.` }
  const out: Record<string, string | number> = {}
  for (const location of LOCATIONS) {
    const value = each((raw as Record<string, unknown>)[location], location)
    if (typeof value === 'object') return value
    out[location] = value
  }
  return out
}

export async function getConfig(): Promise<AppConfig> {
  const raw = await redis().get<string>(keys.config)
  if (!raw) return DEFAULT_CONFIG
  try {
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<AppConfig>) }
  } catch {
    return DEFAULT_CONFIG
  }
}

/** Valida campo a campo; ignora claves desconocidas. Devuelve un error legible o la config nueva. */
export function parseConfig(input: unknown): { config: AppConfig } | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'Cuerpo inválido.' }
  const body = input as Record<string, unknown>

  const systemPrompt = str(body, 'systemPrompt', 6000)
  if (typeof systemPrompt === 'object') return systemPrompt
  if (!systemPrompt) return { error: 'Las instrucciones del sistema no pueden estar vacías.' }

  const faq = str(body, 'faq', 4000)
  if (typeof faq === 'object') return faq

  const payLink = str(body, 'payLink', 500)
  if (typeof payLink === 'object') return payLink
  if (payLink && !/^https:\/\/\S+$/.test(payLink)) return { error: 'El link de pago debe empezar por https://' }

  const nequiInstructions = str(body, 'nequiInstructions', 1500)
  if (typeof nequiInstructions === 'object') return nequiInstructions

  const intlInstructions = str(body, 'intlInstructions', 1500)
  if (typeof intlInstructions === 'object') return intlInstructions

  const services = parseServices(body.services)
  if (!Array.isArray(services)) return services

  const hours = parseHours(body.hours)
  if (!Array.isArray(hours)) return hours

  const cabins = parseByLocation(body.cabins, 'cabins', (value, location) => {
    const count = Number(value)
    if (!Number.isInteger(count) || count < 1 || count > 10) return { error: `Las cabinas de ${location} deben ser un entero entre 1 y 10.` }
    return count
  })
  if ('error' in cabins) return cabins as Issue

  const addresses = parseByLocation(body.addresses, 'addresses', (value) => String(value ?? '').trim().slice(0, 200))
  if ('error' in addresses) return addresses as Issue

  const numbers = {
    depositPercent: int(body, 'depositPercent', 1, 100),
    slotMinutes: int(body, 'slotMinutes', 5, 60),
    leadTimeHours: int(body, 'leadTimeHours', 0, 72),
    horizonDays: int(body, 'horizonDays', 1, 90),
    holdMinutes: int(body, 'holdMinutes', 15, 2880),
  }
  for (const value of Object.values(numbers)) if (typeof value === 'object') return value

  // Una duración que no es múltiplo de la grilla dejaría huecos imposibles de reservar.
  const slot = numbers.slotMinutes as number
  const offending = services.find((service) => service.durationMin % slot !== 0)
  if (offending) return { error: `La duración de "${offending.label}" (${offending.durationMin} min) debe ser múltiplo de la grilla de ${slot} min.` }

  return {
    config: {
      systemPrompt,
      faq,
      payLink,
      nequiInstructions,
      intlInstructions,
      services,
      hours,
      cabins: cabins as Record<Location, number>,
      addresses: addresses as Record<Location, string>,
      depositPercent: numbers.depositPercent as number,
      slotMinutes: slot,
      leadTimeHours: numbers.leadTimeHours as number,
      horizonDays: numbers.horizonDays as number,
      holdMinutes: numbers.holdMinutes as number,
    },
  }
}

export async function saveConfig(config: AppConfig) {
  await redis().set(keys.config, JSON.stringify(config))
}

export function serviceById(config: AppConfig, id: string): Service | undefined {
  return config.services.find((service) => service.id === id)
}

/**
 * Cobro que aplica a este cliente según su país. Es la única fuente: la usa el prompt para
 * contarle a Gema qué métodos existen, y la usa el servidor para pegar los datos reales
 * cuando la cabina ya quedó apartada.
 */
export function paymentFor(config: AppConfig, region: Region) {
  const colombia = region === 'CO'
  return {
    currency: colombia ? 'pesos colombianos (COP)' : 'dólares estadounidenses (USD)',
    methods: colombia
      ? 'Nequi, Bancolombia o Daviplata'
      : 'Binance (USDT), PayPal, transferencia Wise o ACH vía DolarApp',
    instructions: colombia ? config.nequiInstructions : config.intlInstructions,
    get configured() { return Boolean(config.payLink || this.instructions) },
  }
}

/** Anticipo en texto a partir del precio configurado. Vacío si el precio no tiene un número legible. */
export function depositOf(config: AppConfig, price: string): string {
  const digits = price.replace(/[^\d]/g, '')
  if (!digits) return ''
  const amount = Math.round((Number(digits) * config.depositPercent) / 100)
  return `$${amount.toLocaleString('es-CO')}`
}
