const locale = 'es-CO'
const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
const shortDate = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short' })
const longDate = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' })

function startOfDay(at: number) {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const DAY = 86_400_000

export function formatClock(at: number) {
  return clock.format(at)
}

/** Hora si es de hoy, "Ayer", o fecha corta. Para la lista de chats. */
export function formatListTime(at: number, now = Date.now()) {
  if (!at) return ''
  const diff = startOfDay(now) - startOfDay(at)
  if (diff <= 0) return clock.format(at)
  if (diff === DAY) return 'Ayer'
  return shortDate.format(at)
}

/** Separador de día dentro del hilo. */
export function formatDayLabel(at: number, now = Date.now()) {
  const diff = startOfDay(now) - startOfDay(at)
  if (diff <= 0) return 'Hoy'
  if (diff === DAY) return 'Ayer'
  return longDate.format(at)
}

export function isSameDay(a: number, b: number) {
  return startOfDay(a) === startOfDay(b)
}

export function formatDuration(ms: number) {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export function formatDate(at: number) {
  return at ? `${shortDate.format(at)} · ${clock.format(at)}` : '—'
}
