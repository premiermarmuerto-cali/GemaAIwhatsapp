/**
 * Aritmética de la agenda. No toca Redis: recibe la ocupación ya leída y devuelve huecos.
 * Así se puede probar en frío y se usa igual desde el bot, desde el panel y desde las rutas.
 *
 * Toda fecha "del negocio" es un string YYYY-MM-DD en la zona de la clínica, y toda hora
 * un string HH:MM. Colombia no tiene horario de verano, así que el offset es fijo.
 */
import { CLINIC_TZ, CLINIC_UTC_OFFSET, ESCALATION_HOURS, MONTH_NAME, MONTH_SHORT, WEEKDAY_LABEL, WEEKDAY_SHORT } from './clinic'
import type { AppConfig, FreeWindow, Location } from './types'

export type Range = { from: number; to: number }

/** Día contable en la zona de la clínica, formato YYYY-MM-DD. */
export function dayKey(at: number | Date = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/** Minutos desde medianoche en la zona de la clínica. */
export function minuteOfDay(at: number = Date.now()): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: CLINIC_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
  return toMinutes(parts)
}

/**
 * Franja de silencio (hora de Colombia): de 9:00 p.m. a 8:00 a.m. no sale NADA automático (seguimientos,
 * recordatorios, plantillas). Gema solo responde a quien le escribe en ese momento.
 */
export const QUIET_FROM_MIN = 21 * 60
export const QUIET_TO_MIN = 8 * 60
export function isQuietHours(now = Date.now()): boolean {
  const minute = minuteOfDay(now)
  return minute >= QUIET_FROM_MIN || minute < QUIET_TO_MIN
}
/**
 * Un momento que cae en la franja de silencio se adelanta a las 8:45 p.m. de esa noche (o de la anterior,
 * si es de madrugada): lo que debe enviarse "a esa hora" (aviso o liberación de una reserva) sale antes
 * de que empiece el silencio. Fuera de la franja, se devuelve igual.
 */
export function beforeQuiet(at: number): number {
  const minute = minuteOfDay(at)
  const target = QUIET_FROM_MIN - 15
  if (minute >= QUIET_FROM_MIN) return at - (minute - target) * 60_000
  if (minute < QUIET_TO_MIN) return at - (minute + 24 * 60 - target) * 60_000
  return at
}
/** De noche Gema solo contesta mensajes recientes: uno que se quedó sin responder (o que Meta entregó tarde) espera a las 8 a.m. */
export const NIGHT_REPLY_MAX_AGE_MS = 60 * 60_000

export function toMinutes(hhmm: string): number {
  const [hour, minute] = hhmm.split(':')
  return Number(hour) * 60 + Number(minute)
}

export function toClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** "16:00" → "4:00 p.m.": al cliente nunca se le habla en formato militar. */
export function clock12(hhmm: string): string {
  const [hour, minute] = hhmm.split(':').map(Number)
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'a.m.' : 'p.m.'}`
}

/**
 * Cuándo atiende una persona, según el mismo horario de agendamiento (config.hours).
 * Devuelve "ahora" si la clínica está abierta, o cuándo vuelve a abrir.
 */
export function nextHumanWindow(hours: string[][] = ESCALATION_HOURS, now = Date.now()): string {
  const [sign, hh, mm] = CLINIC_UTC_OFFSET.match(/^([+-])(\d{2}):(\d{2})$/)!.slice(1)
  const offsetMs = (sign === '-' ? -1 : 1) * (Number(hh) * 60 + Number(mm)) * 60_000
  const local = new Date(now + offsetMs)
  const today = local.getUTCDay()
  const minutesNow = local.getUTCHours() * 60 + local.getUTCMinutes()
  const openNow = hours[today]?.some((range) => {
    const [from, to] = range.split('-').map(toMinutes)
    return minutesNow >= from && minutesNow < to
  })
  if (openNow) return 'ahora'

  for (let offset = 0; offset <= 7; offset++) {
    const day = (today + offset) % 7
    const ranges = hours[day] ?? []
    const upcoming = ranges.map((range) => toMinutes(range.split('-')[0])).find((from) => offset > 0 || from > minutesNow)
    if (upcoming !== undefined) {
      const when = offset === 0 ? 'hoy' : offset === 1 ? 'mañana' : WEEKDAY_LABEL[day]
      return `${when} a las ${clock12(toClock(upcoming))}`
    }
  }
  return 'en el próximo horario de atención'
}

export function isDayKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)
}

export function isClock(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

/** Epoch ms del instante <day> <hhmm> en la zona de la clínica. */
export function timestampOf(day: string, hhmm: string): number {
  return Date.parse(`${day}T${hhmm}:00${CLINIC_UTC_OFFSET}`)
}

export function addDays(day: string, amount: number): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date + amount)).toISOString().slice(0, 10)
}

/** 0 = domingo … 6 = sábado. Mediodía UTC evita cualquier salto por zona. */
export function weekdayOf(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay()
}

export function dayLabel(day: string, { short = false } = {}): string {
  const [, month, date] = day.split('-').map(Number)
  const names = short ? WEEKDAY_SHORT : WEEKDAY_LABEL
  return `${names[weekdayOf(day)]} ${date} ${MONTH_SHORT[month - 1]}`
}

/** "sábado 25 de octubre": como se escribe una fecha en las plantillas de WhatsApp. */
export function fullDayLabel(day: string): string {
  const [, month, date] = day.split('-').map(Number)
  return `${WEEKDAY_LABEL[weekdayOf(day)]} ${date} de ${MONTH_NAME[month - 1]}`
}

/** Los siete días de la semana que contiene `day`, empezando en lunes. */
export function weekOf(day: string): string[] {
  const offset = (weekdayOf(day) + 6) % 7
  const monday = addDays(day, -offset)
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index))
}

/** Las seis semanas (lunes a domingo) que cubren el mes de `day`: la grilla de la vista mensual. */
export function monthGrid(day: string): string[] {
  const first = `${day.slice(0, 7)}-01`
  const monday = addDays(first, -((weekdayOf(first) + 6) % 7))
  return Array.from({ length: 42 }, (_, index) => addDays(monday, index))
}

/** "octubre 2026". */
export function monthLabel(day: string): string {
  return `${MONTH_NAME[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`
}

/** El mismo día del mes siguiente (o anterior), pegado al último día si no existe: 31 ene → 28 feb. */
export function addMonths(day: string, amount: number): string {
  const [year, month] = day.split('-').map(Number)
  const target = new Date(Date.UTC(year, month - 1 + amount, 1))
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  return `${target.toISOString().slice(0, 8)}${String(Math.min(Number(day.slice(8)), last)).padStart(2, '0')}`
}

/**
 * Franjas de agendamiento del día, en minutos: `from` = primera hora de inicio, `to` = última hora
 * de inicio (la sesión puede terminar después). Vacío = cerrado. Recibe `hours` suelto para que el
 * panel también pueda usarlo.
 */
export function openRanges(hours: string[][], day: string): Range[] {
  return (hours[weekdayOf(day)] ?? []).map((range) => {
    const [from, to] = range.split('-')
    return { from: toMinutes(from), to: toMinutes(to) }
  })
}

/** Los inicios de la grilla dentro de las franjas de agendamiento, incluida la última hora de inicio. */
export function gridStarts(config: AppConfig, day: string): number[] {
  const starts: number[] = []
  for (const range of openRanges(config.hours, day)) {
    for (let at = range.from; at <= range.to; at += config.slotMinutes) starts.push(at)
  }
  return starts
}

/** Los campos de slot que ocupa un servicio que empieza en `startMin`. */
export function slotsOf(config: AppConfig, startMin: number, durationMin: number): string[] {
  const count = Math.ceil(durationMin / config.slotMinutes)
  return Array.from({ length: count }, (_, index) => toClock(startMin + index * config.slotMinutes))
}

export type Occupancy = Record<string, string>

/**
 * Cómo ocupa la sede una cita de `people` personas. Con cabinas suficientes, cada persona en su
 * cabina a la misma hora (`lanes` = personas). Con menos cabinas que personas (Premier tiene UNA por
 * sede, oct 2026), las sesiones van una después de la otra en la misma cabina: un solo carril durante
 * la duración de todas las sesiones seguidas. La hora de la cita es la de la primera sesión.
 */
export function cabinPlan(cabins: number, people: number, sessionMin: number): { lanes: number; minutes: number; sequential: boolean } {
  const persons = Math.max(1, people)
  if (persons <= Math.max(1, cabins)) return { lanes: persons, minutes: sessionMin, sequential: false }
  return { lanes: 1, minutes: sessionMin * persons, sequential: true }
}

/**
 * Inicios en los que el servicio cabe completo en UNA cabina libre (o en `people` cabinas seguidas,
 * para una pareja). Es la verdad exacta: el panel pinta esto y la reserva lo vuelve a comprobar
 * de forma atómica, con el mismo criterio de cabinas seguidas.
 */
export function freeStarts(
  config: AppConfig,
  location: Location,
  day: string,
  durationMin: number,
  occupancy: Occupancy,
  { now = Date.now(), people = 1 } = {},
): string[] {
  const cabins = config.cabins[location] ?? 1
  const earliest = now + config.leadTimeHours * 3_600_000
  const out: string[] = []
  // `durationMin` es la de UNA sesión; con una sola cabina, una pareja ocupa las dos seguidas.
  const plan = cabinPlan(cabins, people, durationMin)

  // gridStarts ya respeta la primera y la última hora de inicio; la sesión puede terminar después.
  for (const startMin of gridStarts(config, day)) {
    if (timestampOf(day, toClock(startMin)) < earliest) continue
    const needed = slotsOf(config, startMin, plan.minutes)
    const freeCabin = (cabin: number) => needed.every((clock) => !occupancy[`${clock}#${cabin}`])
    const fits = Array.from({ length: Math.max(0, cabins - plan.lanes + 1) }, (_, index) => index + 1)
      .some((first) => Array.from({ length: plan.lanes }, (_, offset) => first + offset).every(freeCabin))
    if (fits) out.push(toClock(startMin))
  }
  return out
}

/**
 * Horas de INICIO libres agrupadas en rangos, para contárselas al cliente ("el sábado de 10:00 a
 * 13:30"). Se calculan con la duración más larga del catálogo, así cualquier hora dentro de un rango
 * sirve para cualquier servicio: el modelo no tiene que restar duraciones. Es exacto (sale de
 * `freeStarts`); para un servicio más corto puede haber algún inicio extra que no se muestra.
 */
export function startWindows(
  config: AppConfig,
  location: Location,
  day: string,
  occupancy: Occupancy,
  { now = Date.now(), people = 1, durationMin = longestService(config) } = {},
): FreeWindow[] {
  const starts = freeStarts(config, location, day, durationMin, occupancy, { now, people }).map(toMinutes)
  const windows: FreeWindow[] = []
  for (const start of starts) {
    const last = windows.at(-1)
    if (last && start - toMinutes(last.to) === config.slotMinutes) {
      last.to = toClock(start)
      last.minutes = start - toMinutes(last.from)
    } else {
      windows.push({ day, from: toClock(start), to: toClock(start), minutes: 0 })
    }
  }
  return windows
}

/** La duración más corta del catálogo: por debajo de eso un hueco no sirve para nada. */
export function shortestService(config: AppConfig): number {
  return Math.min(...config.services.map((service) => service.durationMin))
}

export function longestService(config: AppConfig): number {
  return Math.max(...config.services.map((service) => service.durationMin))
}
