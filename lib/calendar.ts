/**
 * Aritmética de la agenda. No toca Redis: recibe la ocupación ya leída y devuelve huecos.
 * Así se puede probar en frío y se usa igual desde el bot, desde el panel y desde las rutas.
 *
 * Toda fecha "del negocio" es un string YYYY-MM-DD en la zona de la clínica, y toda hora
 * un string HH:MM. Colombia no tiene horario de verano, así que el offset es fijo.
 */
import { CLINIC_TZ, CLINIC_UTC_OFFSET, MONTH_SHORT, WEEKDAY_LABEL, WEEKDAY_SHORT } from './clinic'
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

export function toMinutes(hhmm: string): number {
  const [hour, minute] = hhmm.split(':')
  return Number(hour) * 60 + Number(minute)
}

export function toClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
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

/** Los siete días de la semana que contiene `day`, empezando en lunes. */
export function weekOf(day: string): string[] {
  const offset = (weekdayOf(day) + 6) % 7
  const monday = addDays(day, -offset)
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index))
}

/** Franjas de atención del día, en minutos. Vacío = cerrado. Recibe `hours` suelto para que el panel también pueda usarlo. */
export function openRanges(hours: string[][], day: string): Range[] {
  return (hours[weekdayOf(day)] ?? []).map((range) => {
    const [from, to] = range.split('-')
    return { from: toMinutes(from), to: toMinutes(to) }
  })
}

/** Los inicios de slot de la grilla que caben dentro de las franjas de atención. */
export function gridStarts(config: AppConfig, day: string): number[] {
  const starts: number[] = []
  for (const range of openRanges(config.hours, day)) {
    for (let at = range.from; at + config.slotMinutes <= range.to; at += config.slotMinutes) starts.push(at)
  }
  return starts
}

/** Los campos de slot que ocupa un servicio que empieza en `startMin`. */
export function slotsOf(config: AppConfig, startMin: number, durationMin: number): string[] {
  const count = Math.ceil(durationMin / config.slotMinutes)
  return Array.from({ length: count }, (_, index) => toClock(startMin + index * config.slotMinutes))
}

export type Occupancy = Record<string, string>

/** Cuántas cabinas están tomadas en ese minuto de inicio. */
function takenAt(occupancy: Occupancy, cabins: number, startMin: number): number {
  const clock = toClock(startMin)
  let taken = 0
  for (let cabin = 1; cabin <= cabins; cabin++) if (occupancy[`${clock}#${cabin}`]) taken++
  return taken
}

/**
 * Inicios en los que el servicio cabe completo en UNA cabina libre.
 * Es la verdad exacta: el panel pinta esto y la reserva lo vuelve a comprobar de forma atómica.
 */
export function freeStarts(
  config: AppConfig,
  location: Location,
  day: string,
  durationMin: number,
  occupancy: Occupancy,
  { now = Date.now() } = {},
): string[] {
  const cabins = config.cabins[location] ?? 1
  const earliest = now + config.leadTimeHours * 3_600_000
  const open = openRanges(config.hours, day)
  const out: string[] = []

  for (const startMin of gridStarts(config, day)) {
    // La sesión tiene que terminar dentro de la misma franja de atención.
    if (!open.some((range) => startMin >= range.from && startMin + durationMin <= range.to)) continue
    if (timestampOf(day, toClock(startMin)) < earliest) continue
    const needed = slotsOf(config, startMin, durationMin)
    const fits = Array.from({ length: cabins }, (_, index) => index + 1)
      .some((cabin) => needed.every((clock) => !occupancy[`${clock}#${cabin}`]))
    if (fits) out.push(toClock(startMin))
  }
  return out
}

/**
 * Huecos continuos de cabina libre, para contárselos al cliente ("mañana tengo de 10 a 13").
 * Con varias cabinas la ventana es la unión, así que puede ser algo más optimista que
 * `freeStarts`; no importa: reservar vuelve a validar y, si se cayó, se ofrecen alternativas.
 */
export function freeWindows(
  config: AppConfig,
  location: Location,
  day: string,
  occupancy: Occupancy,
  { now = Date.now(), minMinutes = 0 } = {},
): FreeWindow[] {
  const cabins = config.cabins[location] ?? 1
  const earliest = now + config.leadTimeHours * 3_600_000
  const slot = config.slotMinutes
  const windows: FreeWindow[] = []

  for (const range of openRanges(config.hours, day)) {
    let open: number | null = null
    for (let at = range.from; at + slot <= range.to; at += slot) {
      const usable = takenAt(occupancy, cabins, at) < cabins && timestampOf(day, toClock(at)) >= earliest
      if (usable) {
        if (open === null) open = at
        continue
      }
      if (open !== null) windows.push({ day, from: toClock(open), to: toClock(at), minutes: at - open })
      open = null
    }
    if (open !== null) windows.push({ day, from: toClock(open), to: toClock(range.to), minutes: range.to - open })
  }
  return windows.filter((window) => window.minutes >= minMinutes)
}

/** La duración más corta del catálogo: por debajo de eso un hueco no sirve para nada. */
export function shortestService(config: AppConfig): number {
  return Math.min(...config.services.map((service) => service.durationMin))
}
