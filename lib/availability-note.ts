/**
 * Agenda verificada para lo que el cliente pregunta. El 20 oct una clienta pidió Chipichape "mañana
 * miércoles 21 en la tarde", había espacio y Gema dijo que no: con 15 días × 2 sedes en el prompt,
 * el modelo leyó la fila equivocada (o la de parejas). Ahora, cuando el cliente nombra un día, el
 * servidor calcula las horas libres de ESE día en CADA sede (individual y para dos personas) y se
 * las entrega a Gema como nota justo antes de responder. Es la misma cuenta con la que se reserva.
 */
import { occupancyOf, isClosed } from './booking'
import { addDays, clock12, dayKey, dayLabel, freeStarts, longestService, toMinutes, weekdayOf } from './calendar'
import { LOCATION_LABEL, LOCATIONS, MONTH_NAME } from './clinic'
import { serviceById } from './config'
import type { AppConfig, Lead, Location, Message } from './types'

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
const MONTHS = MONTH_NAME.map(fold)

export type DayPart = 'mañana' | 'tarde' | 'noche'

/** Rango de horas de inicio de cada parte del día, en minutos. */
const PART_RANGE: Record<DayPart, [number, number]> = { 'mañana': [0, 12 * 60 - 1], tarde: [12 * 60, 18 * 60 - 1], noche: [18 * 60, 24 * 60] }

/**
 * El día que pide el texto, dentro del horizonte. Gana el número de día ("el 21", "miércoles 21",
 * "21 de octubre"), después el día de la semana, después hoy / mañana / pasado mañana.
 */
export function askedDay(text: string, today: string, horizonDays: number): string | null {
  const clean = fold(text)
  const days = Array.from({ length: horizonDays + 1 }, (_, index) => addDays(today, index))

  const byNumber = /\b(?:el|dia|para el|este|(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo))\s+(\d{1,2})\b(?:\s+de\s+([a-z]+))?|\b(\d{1,2})\s+de\s+([a-z]+)/.exec(clean)
  if (byNumber) {
    const date = Number(byNumber[1] ?? byNumber[3])
    const month = MONTHS.indexOf(byNumber[2] ?? byNumber[4] ?? '') + 1
    // "3 de la tarde" es una hora, no un día: sin "el"/"día" delante, el número solo vale con un mes.
    const match = (byNumber[1] || month) && days.find((day) => Number(day.slice(8)) === date && (!month || Number(day.slice(5, 7)) === month))
    if (match) return match
  }

  const weekday = WEEKDAYS.findIndex((name) => new RegExp(`\\b${name}\\b`).test(clean))
  if (weekday >= 0) {
    const next = /\b(proximo|siguiente|la otra semana|la proxima semana)\b/.test(clean)
    const offset = (weekday - weekdayOf(today) + 7) % 7
    return addDays(today, offset === 0 && next ? 7 : offset)
  }

  if (/\bpasado manana\b/.test(clean)) return addDays(today, 2)
  // "mañana" es el día siguiente salvo "en la mañana", "por la mañana", "de la mañana".
  if (/\bmanana\b/.test(clean.replace(/\b((en|por|de|a) )?las? mananas?\b/g, ' '))) return addDays(today, 1)
  if (/\bhoy\b/.test(clean)) return today
  return null
}

export function askedLocations(text: string): Location[] {
  const clean = fold(text)
  return LOCATIONS.filter((location) => (location === 'chipichape' ? /chipi/.test(clean) : /unicentro|\buni\b/.test(clean)))
}

export function askedPart(text: string): DayPart | null {
  const clean = fold(text)
  if (/\b(en|por|de) la tarde\b|\btarde\b|\bdespues de almuerzo\b/.test(clean)) return 'tarde'
  if (/\b(en|por|de) la noche\b|\bnoche\b/.test(clean)) return 'noche'
  if (/\b(en|por|de) las? mananas?\b|\btemprano\b/.test(clean)) return 'mañana'
  return null
}

/**
 * La hora concreta que pide el texto, en HH:MM: "3pm", "3:30 p.m.", "a las 4", "15:00", "3 de la tarde".
 * Sin a.m./p.m., de 1 a 7 es de la tarde (las sedes atienden de 10 a.m. a 6:30 p.m.). null si no nombra una.
 */
export function askedHour(text: string): string | null {
  const clean = fold(text).replace(/\./g, '')
  const match = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a m|p m|de la manana|de la tarde|de la noche)\b/.exec(clean)
    ?? /\ba las (\d{1,2})(?::(\d{2}))?\b()/.exec(clean)
    ?? /\b(\d{1,2}):(\d{2})\b()/.exec(clean)
  if (!match) return null
  let hour = Number(match[1])
  const minutes = Number(match[2] ?? 0)
  const suffix = match[3] ?? ''
  if (hour > 23 || minutes > 59) return null
  if (/p ?m|tarde|noche/.test(suffix) && hour < 12) hour += 12
  else if (/a ?m|manana/.test(suffix) && hour === 12) hour = 0
  else if (!suffix && hour >= 1 && hour <= 7) hour += 12
  return `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/**
 * El horario concreto que pidió el cliente en sus últimos mensajes (día, hora y sede) y si está libre
 * de verdad. Sirve para corregir a Gema cuando dice que no hay espacio en una hora libre (Nana, 23 oct:
 * pidió el miércoles 28 a las 3 p.m. en Chipichape, la agenda estaba vacía y Gema dijo que no había).
 */
export async function askedSlot(config: AppConfig, history: Message[], lead: Lead, { people = 1, now = Date.now() } = {}): Promise<{ day: string; start: string; location: Location; free: boolean } | null> {
  if (history.at(-1)?.sender !== 'user') return null
  const today = dayKey(now)
  const recent = history.filter((message) => message.sender === 'user' && now - message.at < 90 * 60_000).slice(-3).reverse()
  let day: string | null = null
  let start: string | null = null
  let asked: Location[] = []
  for (const message of recent) {
    day ??= askedDay(message.text, today, config.horizonDays)
    start ??= askedHour(message.text)
    if (!asked.length) asked = askedLocations(message.text)
  }
  const location = asked.length === 1 ? asked[0] : !asked.length && lead.location ? lead.location : null
  if (!day || !start || !location) return null
  if (await isClosed(day)) return { day, start, location, free: false }
  const service = lead.serviceId ? serviceById(config, lead.serviceId) : undefined
  const duration = service?.durationMin ?? longestService(config)
  const free = freeStarts(config, location, day, duration, await occupancyOf(location, day), { now, people }).includes(start)
  return { day, start, location, free }
}

/** "10:00 a.m. a 1:30 p.m. y 3:00 p.m. a 6:30 p.m.": inicios seguidos agrupados en rangos. */
function rangesText(starts: string[], step: number): string {
  const groups: Array<[string, string]> = []
  for (const start of starts) {
    const last = groups.at(-1)
    if (last && toMinutes(start) - toMinutes(last[1]) === step) last[1] = start
    else groups.push([start, start])
  }
  return groups.map(([from, to]) => (from === to ? clock12(from) : `${clock12(from)} a ${clock12(to)}`)).join(', ')
}

const inPart = (part: DayPart | null) => (start: string) => !part || (toMinutes(start) >= PART_RANGE[part][0] && toMinutes(start) <= PART_RANGE[part][1])

/**
 * Nota para el modelo con la disponibilidad real del día que pidió el cliente, o undefined si no
 * pidió ningún día. Mira sus últimos mensajes (el día puede venir en uno y la sede en el siguiente).
 */
export async function availabilityNote(config: AppConfig, history: Message[], lead: Lead, now = Date.now()): Promise<string | undefined> {
  if (history.at(-1)?.sender !== 'user') return undefined
  const today = dayKey(now)
  // Los mensajes del cliente desde la última respuesta, más los dos anteriores (última hora y media).
  const recent = history.filter((message) => message.sender === 'user' && now - message.at < 90 * 60_000).slice(-3).reverse()
  if (!recent.length) return undefined
  let day: string | null = null
  let part: DayPart | null = null
  let asked: Location[] = []
  for (const message of recent) {
    day ??= askedDay(message.text, today, config.horizonDays)
    part ??= askedPart(message.text)
    if (!asked.length) asked = askedLocations(message.text)
  }
  if (!day) return undefined

  const service = lead.serviceId ? serviceById(config, lead.serviceId) : undefined
  const duration = service?.durationMin ?? longestService(config)
  const preferred = asked.length ? asked : lead.location ? [lead.location] : []
  const order = [...preferred, ...LOCATIONS.filter((location) => !preferred.includes(location))]
  const closed = await isClosed(day)
  const label = `${dayLabel(day)}${day === today ? ' (hoy)' : day === addDays(today, 1) ? ' (mañana)' : ''}${part ? `, en la ${part}` : ''}`

  const lines: string[] = []
  for (const location of order) {
    const name = `${LOCATION_LABEL[location]}${preferred.includes(location) ? ' (la que pidió)' : ''}`
    if (closed) { lines.push(`- ${name}: cerrado ese día (${closed}).`); continue }
    const occupancy = await occupancyOf(location, day)
    const all = freeStarts(config, location, day, duration, occupancy, { now })
    const single = all.filter(inPart(part))
    const twoCabins = (config.cabins[location] ?? 1) >= 2
    // Con una sola cabina, la pareja va seguida: son horas en que caben las dos sesiones una tras otra.
    const pairs = freeStarts(config, location, day, duration, occupancy, { now, people: 2 }).filter(inPart(part))
    if (!single.length) {
      lines.push(`- ${name}: SIN espacio${part ? ` en la ${part}` : ''}${part && all.length ? `; ese día sí hay a otras horas: ${rangesText(all, config.slotMinutes)}` : ''}`)
      continue
    }
    const pairText = pairs.length
      ? `${rangesText(pairs, config.slotMinutes)}${twoCabins ? ' (a la misma hora, cada una en su cabina)' : ` (una sola cabina: la primera a esa hora y la segunda al terminar, ${duration} min después)`}`
      : 'no hay ese día'
    lines.push(`- ${name}: SÍ hay espacio. Horas de inicio libres para una persona: ${rangesText(single, config.slotMinutes)} · Para dos personas (2x1): ${pairText}`)
  }
  const outside = day > addDays(today, config.horizonDays - 1)
  return [
    `Nota del sistema: agenda verificada AHORA para lo que pregunta el cliente (${label}${service ? `, ${service.label}` : ''}):`,
    ...lines,
    outside ? `- Ojo: esa fecha está más allá de los ${config.horizonDays} días en que se puede agendar.` : '',
    'Responde con ESTOS datos, que son los reales (mandan sobre la lista de disponibilidad del prompt). Si la sede que pidió tiene horas libres, la respuesta es SÍ: ofrécele dos o tres horas concretas de esa sede en esa parte del día. Solo di que no hay espacio si aquí dice "SIN espacio", y entonces ofrece la otra sede u otra hora. Si viene sola, usa las horas para una persona; si vienen dos (2x1), las de dos personas.',
  ].filter(Boolean).join('\n')
}
