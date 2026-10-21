/**
 * Mensajes prediseñados: la bienvenida y los seguimientos que envía el servidor tal cual, sin IA.
 * El texto lo edita el operador en el panel (config.messages); aquí se completan sus variables con
 * datos reales (catálogo, 2x1 vigente, anticipo, horarios libres de la agenda), así nunca dicen un
 * precio, una fecha o un horario que no existe.
 *
 * Formato (ver lib/preset-defaults.ts):
 *   {variable}  se reemplaza por su valor
 *   |||         parte el texto en varios mensajes de WhatsApp
 *   párrafo     si una variable de bloque queda vacía (no hay horarios, no hay cortesía…), se quita
 *               el párrafo entero (o el mensaje, si no tiene párrafos), para no dejar frases a medias
 */
import { suggestStarts } from './booking'
import { addDays, clock12, dayKey, dayLabel } from './calendar'
import { LOCATION_LABEL, LOCATIONS, MONTH_NAME } from './clinic'
import { amountOf, depositOf, pesos, serviceById, twoForOneApplies } from './config'
import { SEPARATOR } from './reply-style'
import { PRESET_INFO, PRESET_VARIABLES } from './preset-defaults'
import type { AppConfig, Booking, ChatSummary, Location, PresetId, Service } from './types'

export { PRESET_INFO, PRESET_VARIABLES }

/** Si quedan vacías, se quita el párrafo (o el mensaje) que las contiene. */
const BLOCK_VARIABLES = new Set(['promos', 'tratamientos', 'horarios', 'cortesia', 'sedes', 'promo_recordatorio'])
/** Sin estas, el mensaje no tiene sentido y no se envía. */
const REQUIRED: Partial<Record<PresetId, string[]>> = { followUp45: ['hora_sugerida'], followUpPayment: ['cita'] }

/**
 * Una línea por servicio para {tratamientos}, desde la base de conocimiento de Premier. Si el
 * catálogo trae un servicio que no está aquí, se usa la primera frase de su resumen.
 */
const PITCH: Record<string, string> = {
  'peeling-hidratacion': 'para el brillo, los poros abiertos y los puntos negros. El Peeling Gel se enrolla sobre tu piel y se lleva la grasa y las células muertas sin raspar',
  pigmentacion: 'para manchas del sol y piel apagada, con el barro negro Milagro Negro del Mar Muerto que absorbe impurezas y ayuda a unificar el tono',
  'lineas-expresion': 'efecto tensor sin agujas, con la terapia termal Biox o la mascarilla de colágeno y algas, más un sérum con cápsulas de vitaminas',
  'hidratacion-profunda': 'nuestra experiencia más completa: colágeno, beta-caroteno y algas con el dispositivo ENEO TOTALE de luz, calor y vibración',
}

/** "Limpieza Peeling y Hidratación" → "Peeling y Hidratación": cómo se nombra en una lista corta. */
export const shortName = (service: Service) => service.label.replace(/^limpieza\s+(y\s+|e\s+)?/i, '')

function pitchOf(service: Service): string {
  if (PITCH[service.id]) return PITCH[service.id]
  const first = service.summary.split(/(?<=\.)\s+/)[0]?.trim().replace(/\.$/, '') ?? ''
  return first ? first[0].toLowerCase() + first.slice(1) : ''
}

/** Primer nombre con letras ("💛VICKY💛" → "Vicky", "ana maría" → "Ana"). Vacío si no hay. */
export function firstName(name: string): string {
  const word = name.split(/\s+/).map((part) => part.replace(/[^\p{L}'-]/gu, '')).find((part) => /\p{L}{2,}/u.test(part))
  if (!word) return ''
  const lower = word === word.toUpperCase() ? word.toLowerCase() : word
  return lower[0].toUpperCase() + lower.slice(1)
}

/** "31 de octubre". */
export function dateText(day: string): string {
  const [, month, date] = day.split('-').map(Number)
  return `${date} de ${MONTH_NAME[month - 1]}`
}

/** "quedan 11 días", "mañana es el último día", "hoy es el último día". */
function countdown(today: string, until: string): string {
  const days = Math.round((Date.parse(`${until}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000)
  if (days <= 0) return 'hoy es el último día'
  if (days === 1) return 'mañana es el último día'
  return `quedan ${days} días`
}

/** "hoy a las 4:00 p.m.", "mañana a las 10:00 a.m.", "el jueves 23 oct a las 11:00 a.m.". */
export function whenText(now: number, { day, start }: { day: string; start: string }): string {
  const today = dayKey(now)
  const label = day === today ? 'hoy' : day === addDays(today, 1) ? 'mañana' : `el ${dayLabel(day)}`
  return `${label} a las ${clock12(start)}`
}

/** "hoy 12:30 p.m. o 3:30 p.m.", "hoy 5:00 p.m. o mañana 10:00 a.m.": el día se dice una vez. */
function whenList(today: string, options: Array<{ day: string; start: string }>): string {
  const label = (day: string) => (day === today ? 'hoy' : day === addDays(today, 1) ? 'mañana' : dayLabel(day))
  return options.map((option, index) => (index && options[index - 1].day === option.day ? clock12(option.start) : `${label(option.day)} ${clock12(option.start)}`)).join(' o ')
}

/** Servicios con 2x1 vigente hoy y precio, primero el que vence (la urgencia real). */
export function livePromos(config: AppConfig, today: string): Service[] {
  return config.services
    .filter((service) => twoForOneApplies(config, service.id, today) && amountOf(service.price))
    .sort((a, b) => (config.twoForOne[a.id] || '9999').localeCompare(config.twoForOne[b.id] || '9999'))
}

/** El 2x1 que más le sirve a este cliente: el del servicio que le interesa o, si no, el que vence primero. */
function promoFor(config: AppConfig, chat: ChatSummary | null | undefined, today: string): Service | undefined {
  const live = livePromos(config, today)
  const interest = chat?.lead.serviceId ? serviceById(config, chat.lead.serviceId) : undefined
  return live.find((item) => item.id === interest?.id) ?? live[0]
}

export type PresetContext = {
  chat?: ChatSummary | null
  booking?: Booking | null
  now?: number
}

type Resolver = (config: AppConfig, context: Required<PresetContext>) => string | Promise<string>

const RESOLVERS: Record<string, Resolver> = {
  nombre: (_config, { chat, booking }) => firstName(booking?.name || chat?.name || ''),
  promos_titulo: (config, { now }) => {
    const count = livePromos(config, dayKey(now)).length
    return count > 1 ? `HOY tenemos activas ${count === 2 ? 'dos' : count} promociones 2×1` : 'HOY tenemos activa una promoción 2×1'
  },
  promos: (config, { now }) => {
    const today = dayKey(now)
    return livePromos(config, today).map((service) => {
      const total = amountOf(service.price)
      const until = config.twoForOne[service.id]
      return `✨ *${service.label}*: 2 personas por *${pesos(total)}* (${pesos(Math.round(total / 2))} cada una).${until ? ` Solo hasta el ${dateText(until)}: ${countdown(today, until)}.` : ''}`
    }).join('\n')
  },
  tratamientos: (config, { now }) => livePromos(config, dayKey(now))
    .map((service) => [service, pitchOf(service)] as const)
    .filter(([, pitch]) => pitch)
    .map(([service, pitch]) => `▪️ *${shortName(service)}*: ${pitch}.`)
    .join('\n'),
  anticipo: (config) => (config.depositFixed > 0 ? pesos(config.depositFixed) : `el ${config.depositPercent}% de la sesión`),
  cortesia: (config) => config.depositPerk.trim(),
  cortesia_frase: (config) => (config.depositPerk.trim() ? `Y con tu anticipo te llevas de cortesía ${config.depositPerk.trim()} 🎁` : ''),
  sedes: (config) => LOCATIONS.filter((location) => config.addresses[location]).map((location) => `${LOCATION_LABEL[location]} (${config.addresses[location]})`).join(' o '),
  horarios: async (config, { now }) => {
    // Horas libres para DOS personas (el gancho es el 2x1), dos por sede. Con una sola cabina, son
    // horas en que caben las dos sesiones seguidas.
    const today = dayKey(now)
    const lines: string[] = []
    for (const location of LOCATIONS) {
      const options = await suggestStarts(config, location, { now, people: 2 })
      if (options.length) lines.push(`▪️ ${LOCATION_LABEL[location]}: ${whenList(today, options)}`)
    }
    return lines.join('\n')
  },
  pregunta_cierre: async (config, context) => ((await RESOLVERS.horarios(config, context)) ? 'Cuál te separo?' : 'En qué sede te queda mejor, Unicentro o Chipichape?'),
  hora_sugerida: async (config, { chat, now }) => {
    const location: Location = chat?.lead.location || LOCATIONS[0]
    const [first] = await suggestStarts(config, location, { now, count: 1 })
    return first ? `${whenText(now, first)} en ${LOCATION_LABEL[location]}` : ''
  },
  vigencia: (config, { chat, now }) => {
    const service = promoFor(config, chat, dayKey(now))
    if (!service) return ''
    const until = config.twoForOne[service.id]
    return `Y con el 2x1 la segunda sesión va de cortesía${until ? `, solo hasta el ${dateText(until)}` : ''}`
  },
  promo_recordatorio: (config, { chat, now }) => {
    const service = promoFor(config, chat, dayKey(now))
    if (!service) return ''
    const until = config.twoForOne[service.id]
    return `te recuerdo que el 2x1 de la ${service.label} ${until ? `va hasta el ${dateText(until)}` : 'sigue vigente'}: vienes con alguien y pagan una sola sesión de ${pesos(amountOf(service.price))}`
  },
  promo_corta: (config, { now }) => (livePromos(config, dayKey(now)).length ? 'asegurar tu 2x1: pagas una limpieza y la segunda va de cortesía' : 'separar tu espacio'),
  pregunta_sede: (_config, { chat }) => (chat?.lead.location ? `te separo un espacio en ${LOCATION_LABEL[chat.lead.location]}?` : 'te reviso disponibilidad en Chipichape o te queda mejor Unicentro?'),
  cita: (_config, { booking }) => (booking ? `${dayLabel(booking.day)} a las ${clock12(booking.start)} en ${LOCATION_LABEL[booking.location]}` : ''),
  minutos: (_config, { booking, now }) => (booking?.holdUntil ? String(Math.max(5, Math.round((booking.holdUntil - now) / 60_000))) : ''),
}

// `anticipo` de una cita concreta: el que le corresponde a ESA cita (pareja, pago completo).
const bookingDeposit = (config: AppConfig, booking: Booking | null) => (booking?.deposit || (booking ? depositOf(config, booking.price) : ''))

const PLACEHOLDER = /\{([a-z_]+)\}/g

/** Arregla lo que deja una variable vacía: "Hola ," → "Hola,", espacios dobles, comas al inicio. */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?:])/g, '$1').replace(/^[\s,.:]+(?=\S)/, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Completa un mensaje prediseñado. Devuelve null si le falta un dato sin el que no tiene sentido
 * (un seguimiento con horario cuando no queda ninguno libre). Mensajes separados por |||.
 */
export async function renderPreset(config: AppConfig, id: PresetId, context: PresetContext = {}, template = config.messages[id]): Promise<string | null> {
  const full: Required<PresetContext> = { chat: context.chat ?? null, booking: context.booking ?? null, now: context.now ?? Date.now() }
  const names = [...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1]))]
  const values: Record<string, string> = {}
  for (const name of names) {
    if (name === 'anticipo' && full.booking) values[name] = bookingDeposit(config, full.booking)
    else values[name] = RESOLVERS[name] ? (await RESOLVERS[name](config, full)).trim() : ''
  }
  if ((REQUIRED[id] ?? []).some((name) => names.includes(name) && !values[name])) return null

  const fill = (text: string) => text.replace(PLACEHOLDER, (match, name: string) => (name in values ? values[name] : match))
  const emptyBlock = (text: string) => [...text.matchAll(PLACEHOLDER)].some((match) => BLOCK_VARIABLES.has(match[1]) && !values[match[1]])
  const messages = template.split(SEPARATOR)
    .filter((message) => !emptyBlock(message) || /\n\s*\n/.test(message))
    .map((message) => tidy(fill(message.split(/\n\s*\n/).filter((paragraph) => !emptyBlock(paragraph)).join('\n\n'))))
    .filter(Boolean)
  return messages.length ? messages.join(SEPARATOR) : null
}

/** El texto ya completo de un mensaje, en partes de WhatsApp. Sirve para el panel (vista previa). */
export const presetParts = (text: string) => text.split(SEPARATOR).map((part) => part.trim()).filter(Boolean)

