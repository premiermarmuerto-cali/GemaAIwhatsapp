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

/**
 * Contexto de la marca, de la tienda oficial de Premier en España (premiercosmeticos.es, oct 2026):
 * por qué es premium y qué cuestan allá los productos de cada limpieza. Se dejaron fuera las
 * afirmaciones de salud de la web ("cura", "alivia molestias reumáticas"): en un chat de limpiezas
 * faciales serían promesas de resultado. Editable en el panel.
 */
export const DEFAULT_BRAND_INFO = `Premier Dead Sea es una marca de cosmética de lujo hecha con minerales del Mar Muerto. Se presenta como el mayor fabricante de cosméticos del Mar Muerto y vende en Europa (tienda oficial de España: premiercosmeticos.es).

Por qué es premium:
- Usa minerales del Mar Muerto: magnesio, calcio, potasio, bromuro, sodio y sílice. El agua del Mar Muerto tiene cerca de diez veces más sales que el mar común.
- Combina esos minerales con extractos de plantas y liposomas, que ayudan a que los activos penetren en la piel.
- Sus productos son de gama alta en Europa. Los que usamos en las limpiezas de Cali cuestan allá, por frasco, en la tienda oficial:
  - Limpieza Peeling y Hidratación: Mascarilla Refinadora Peeling (Refining Facial Peeling Mask, línea Prestige; es la Mascarilla Peeling Gel del catálogo y el frasco azul y dorado del anuncio del 2x1), 190 €. Exfoliación suave y limpieza profunda que ayuda a cerrar los poros.
  - Limpieza e Hidratación y Pigmentación: Milagro Negro (Miracle Noir), la mascarilla clásica que hizo famosa a Premier, 286 €. Barro negro del Mar Muerto con aceite de rosa mosqueta, eucalipto y ginkgo biloba.
  - Limpieza y Disminución de Líneas de Expresión: línea Biox (Age Treatment Biox Ultra), con acción termal. Mascarilla Thermal Experience (calor instantáneo) 235 €, sérum Age Defying 245 € y crema Age Defying 225 €.
  - Limpieza e Hidratación Profunda: mascarilla de colágeno, betacaroteno y algas marinas, 235 €.

Cómo usarlo:
- Cuando pregunten por qué vale eso, duden del precio, comparen con otra limpieza o pregunten qué productos usan, dilo en una o dos frases. Por ejemplo: en una sola sesión se usan productos que en la tienda de Premier en Europa cuestan cerca de 190 € el frasco.
- No conviertas euros a pesos. No digas que se lleva el producto a casa.
- Nunca digas que cura, que trata enfermedades o dolores, ni prometas resultados. Habla de cómo se siente y se ve la piel ("más limpia", "más fresca"), no de curar.`

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
  depositFixed: 0,
  cashBooking: false,
  slotMinutes: 15,
  leadTimeHours: 2,
  horizonDays: 14,
  holdMinutes: 120,
  faq: '',
  brandInfo: DEFAULT_BRAND_INFO,
  promo: '',
  twoForOne: {},
}

/**
 * Acepta también la primera forma que se guardó ({ services, until }: una sola fecha para todos)
 * y la convierte a servicio → fecha. Descarta servicios que ya no existen.
 */
function normalizeTwoForOne(raw: unknown, serviceIds: string[]): { value: Record<string, string> } | Issue {
  if (!raw || typeof raw !== 'object') return { value: {} }
  const value = raw as Record<string, unknown>
  const entries: Array<[string, string]> = Array.isArray(value.services)
    ? value.services.map((id) => [String(id), String(value.until ?? '')])
    : Object.entries(value).map(([id, until]) => [id, String(until ?? '')])
  const out: Record<string, string> = {}
  for (const [id, until] of entries) {
    if (!serviceIds.includes(id)) continue
    const date = until.trim()
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: `La fecha del 2x1 de "${id}" debe tener el formato AAAA-MM-DD.` }
    out[id] = date
  }
  return { value: out }
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
    const config = { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<AppConfig>) }
    const twoForOne = normalizeTwoForOne(config.twoForOne, config.services.map((service) => service.id))
    return { ...config, twoForOne: 'value' in twoForOne ? twoForOne.value : {} }
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

  // Un panel abierto antes de que existiera el campo no lo envía: se conserva el texto de la marca.
  const brandInfo = body.brandInfo === undefined ? DEFAULT_BRAND_INFO : str(body, 'brandInfo', 4000)
  if (typeof brandInfo === 'object') return brandInfo

  // Opcional: un panel abierto antes de que existiera el campo no lo envía, y eso no es un error.
  const promo = body.promo === undefined ? '' : str(body, 'promo', 1000)
  if (typeof promo === 'object') return promo

  const payLink = str(body, 'payLink', 500)
  if (typeof payLink === 'object') return payLink
  if (payLink && !/^https:\/\/\S+$/.test(payLink)) return { error: 'El link de pago debe empezar por https://' }

  const nequiInstructions = str(body, 'nequiInstructions', 1500)
  if (typeof nequiInstructions === 'object') return nequiInstructions

  const intlInstructions = str(body, 'intlInstructions', 1500)
  if (typeof intlInstructions === 'object') return intlInstructions

  const services = parseServices(body.services)
  if (!Array.isArray(services)) return services

  // Opcional, como promo. Solo servicios que existen; la fecha es la última sesión incluida.
  const twoForOne = normalizeTwoForOne(body.twoForOne, services.map((service) => service.id))
  if (!('value' in twoForOne)) return twoForOne

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
  // Opcional: un panel abierto antes de que existiera el campo no lo envía (queda apagado).
  const cashBooking = body.cashBooking === true
  // Opcional: un panel abierto antes de que existiera el campo no lo envía (queda en 0, el porcentaje).
  const depositFixed = body.depositFixed === undefined || body.depositFixed === '' ? 0 : int(body, 'depositFixed', 0, 5_000_000)
  if (typeof depositFixed === 'object') return depositFixed

  // Una duración que no es múltiplo de la grilla dejaría huecos imposibles de reservar.
  const slot = numbers.slotMinutes as number
  const offending = services.find((service) => service.durationMin % slot !== 0)
  if (offending) return { error: `La duración de "${offending.label}" (${offending.durationMin} min) debe ser múltiplo de la grilla de ${slot} min.` }

  return {
    config: {
      systemPrompt,
      faq,
      brandInfo,
      promo,
      twoForOne: twoForOne.value,
      payLink,
      nequiInstructions,
      intlInstructions,
      services,
      hours,
      cabins: cabins as Record<Location, number>,
      addresses: addresses as Record<Location, string>,
      depositPercent: numbers.depositPercent as number,
      depositFixed,
      cashBooking,
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

/**
 * Códigos que tenían los servicios de Premier antes de llamarse como el servicio (17 oct 2026). No
 * coincidían con los nombres (`valoracion` era el Peeling, `limpieza-basica` era Pigmentación) y el
 * modelo se equivocaba de servicio al reservar. Siguen valiendo para citas y fichas ya guardadas.
 */
export const LEGACY_SERVICE_IDS: Record<string, string> = {
  valoracion: 'peeling-hidratacion',
  'limpieza-basica': 'pigmentacion',
  'limpieza-profunda': 'lineas-expresion',
  'hidratacion-mineral': 'hidratacion-profunda',
}

export function serviceById(config: AppConfig, id: string): Service | undefined {
  return config.services.find((service) => service.id === id)
    ?? (LEGACY_SERVICE_IDS[id] ? config.services.find((service) => service.id === LEGACY_SERVICE_IDS[id]) : undefined)
}

const slug = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/**
 * El servicio que pidió Gema en [[RESERVA]]: por id y, si no existe, por nombre. Los ids son
 * y el modelo a veces escribe el nombre
 * convertido en id (`limpieza-peeling-gel`). Si el nombre no coincide exacto (la voz del panel y
 * el catálogo pueden nombrarlo distinto: "Peeling Gel" / "Peeling y Hidratación"), acepta el
 * servicio cuyo nombre comparte más palabras iniciales, solo si son 2 o más y no hay empate.
 */
export function resolveService(config: AppConfig, raw: string): Service | undefined {
  const wanted = slug(raw)
  const exact = serviceById(config, raw) ?? config.services.find((service) => slug(service.label) === wanted)
  if (exact) return exact
  const words = wanted.split('-')
  const shared = (label: string) => {
    const other = slug(label).split('-')
    let count = 0
    while (count < words.length && words[count] === other[count]) count++
    return count
  }
  const scored = config.services.map((service) => ({ service, score: shared(service.label) })).sort((a, b) => b.score - a.score)
  const [best, second] = scored
  return best && best.score >= 2 && best.score !== second?.score ? best.service : undefined
}

/**
 * Cobro que aplica a este cliente según su país. Es la única fuente: la usa el prompt para
 * contarle a Gema qué métodos existen, y la usa el servidor para pegar los datos reales
 * cuando la cabina ya quedó apartada.
 */
export function paymentFor(config: AppConfig, region: Region) {
  const colombia = region === 'CO'
  /**
   * Con Bold configurado, cada reserva genera su propio link (ver lib/bold.ts), también para
   * clientes de fuera: Bold acepta tarjetas de crédito internacionales y cobra en pesos.
   */
  const bold = Boolean(process.env.BOLD_API_KEY)
  const instructions = colombia ? config.nequiInstructions : config.intlInstructions
  return {
    currency: colombia || bold ? 'pesos colombianos (COP)' : 'dólares estadounidenses (USD)',
    methods: bold
      ? colombia
        ? `link de pago de Bold (PSE, tarjeta débito o crédito, Nequi o Daviplata)${instructions ? ' o transferencia directa a Premier (Nequi, Daviplata o cuenta de ahorros Bancolombia) con envío del comprobante' : ''}`
        : `link de pago de Bold con tarjeta de crédito internacional (se cobra en pesos colombianos y su banco hace la conversión)${instructions ? ' o, si lo prefiere, los medios internacionales de Premier' : ''}`
      : colombia
        ? 'Nequi, Bancolombia o Daviplata'
        : 'Binance (USDT), PayPal, transferencia Wise o ACH vía DolarApp',
    instructions,
    bold,
    get configured() { return Boolean(config.payLink || this.instructions || this.bold) },
  }
}

/** Número a partir de un precio escrito ("$130.000", "130000"). 0 si no tiene un número legible. */
export function amountOf(price: string): number {
  const digits = price.replace(/[^\d]/g, '')
  return digits ? Number(digits) : 0
}

export function pesos(amount: number): string {
  return `$${amount.toLocaleString('es-CO')}`
}

/**
 * Anticipo como número a partir del precio de la cita (una sesión o la pareja). 0 si el precio no
 * tiene un número legible. Con anticipo fijo es ese valor por cita, sin pasar del precio.
 */
export function depositAmount(config: AppConfig, price: string): number {
  const amount = amountOf(price)
  if (config.depositFixed > 0) return Math.min(config.depositFixed, amount)
  return Math.round((amount * config.depositPercent) / 100)
}

/** Anticipo en texto a partir del precio configurado. Vacío si el precio no tiene un número legible. */
export function depositOf(config: AppConfig, price: string): string {
  const amount = depositAmount(config, price)
  return amount ? pesos(amount) : ''
}

/** Algún servicio tiene el 2x1 vigente para sesiones de hoy (o sin fecha de fin). */
export function twoForOneLive(config: AppConfig, today: string): boolean {
  return Object.keys(config.twoForOne).some((id) => twoForOneApplies(config, id, today))
}

/** Dos personas a la misma hora pagan una sola sesión: el servicio entra en el 2x1 y la sesión es antes de su fecha de fin. */
export function twoForOneApplies(config: AppConfig, serviceId: string, day: string): boolean {
  if (!(serviceId in config.twoForOne)) return false
  const until = config.twoForOne[serviceId]
  return !until || day <= until
}

/**
 * Valor total de una cita: una sesión por persona, salvo pareja con 2x1 (una sola sesión).
 * Lo calcula el servidor, nunca el modelo.
 */
export function bookingPrice(config: AppConfig, service: Service, people: number, day: string): string {
  const sessions = people > 1 && !twoForOneApplies(config, service.id, day) ? people : 1
  if (sessions === 1) return service.price
  const amount = amountOf(service.price)
  return amount ? String(amount * sessions) : ''
}
