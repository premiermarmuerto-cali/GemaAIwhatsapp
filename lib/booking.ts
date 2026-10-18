/**
 * Citas en Upstash. La ocupación de cabina vive solo en el hash `pm:slots:<sede>:<día>`,
 * donde cada campo es "HH:MM#<cabina>" y su valor el id de la cita. Reservar es escribir
 * esos campos solo si ninguno existe, y eso se hace con un script Lua para que sea atómico:
 * dos clientes que aceptan el mismo horario a la vez no pueden quedar los dos.
 */
import { freeStarts, slotsOf, timestampOf, toMinutes, type Occupancy } from './calendar'
import { amountOf, bookingPrice, depositOf, pesos, serviceById } from './config'
import { keys, redis, toHash } from './redis'
import { HOLD_STATUSES, LIVE_STATUSES, type AppConfig, type Booking, type BookingStatus, type Location } from './types'

const PHONE_HISTORY = 50

/**
 * Toma las primeras `people` cabinas seguidas en las que TODOS los slots pedidos están libres y
 * los marca. Devuelve la primera de ellas, o 0 si no hay. Seguidas para que la pareja se pinte
 * como un solo bloque en la grilla; con las 1–2 cabinas por sede de Premier no cambia nada.
 */
const CLAIM = `
local cabins = tonumber(ARGV[2])
local people = tonumber(ARGV[3])
local slots = #ARGV - 3
local function free(cabin)
  for i = 1, slots do
    if redis.call('HEXISTS', KEYS[1], ARGV[3 + i] .. '#' .. cabin) == 1 then return false end
  end
  return true
end
for first = 1, cabins - people + 1 do
  local ok = true
  for cabin = first, first + people - 1 do
    if not free(cabin) then ok = false break end
  end
  if ok then
    for cabin = first, first + people - 1 do
      for i = 1, slots do
        redis.call('HSET', KEYS[1], ARGV[3 + i] .. '#' .. cabin, ARGV[1])
      end
    end
    return first
  end
end
return 0
`

/** Borra solo los campos que siguen apuntando a esta cita: es idempotente y no pisa reservas ajenas. */
const RELEASE = `
local all = redis.call('HGETALL', KEYS[1])
local removed = 0
for i = 1, #all, 2 do
  if all[i + 1] == ARGV[1] then
    redis.call('HDEL', KEYS[1], all[i])
    removed = removed + 1
  end
end
return removed
`

function toBooking(id: string, raw: Record<string, string>): Booking {
  return {
    id,
    kind: raw.kind === 'block' ? 'block' : 'appointment',
    phone: raw.phone ?? '',
    name: raw.name ?? '',
    location: (raw.location as Location) ?? 'unicentro',
    cabin: Number(raw.cabin ?? 1),
    people: Number(raw.people ?? 1) || 1,
    paymentPlan: raw.paymentPlan === 'full' ? 'full' : 'deposit',
    serviceId: raw.serviceId ?? '',
    serviceLabel: raw.serviceLabel ?? '',
    durationMin: Number(raw.durationMin ?? 0),
    day: raw.day ?? '',
    start: raw.start ?? '',
    startMin: Number(raw.startMin ?? 0),
    startTs: Number(raw.startTs ?? 0),
    status: (raw.status as BookingStatus) ?? 'cancelled',
    price: raw.price ?? '',
    deposit: raw.deposit ?? '',
    concern: raw.concern ?? '',
    notes: raw.notes ?? '',
    source: raw.source === 'operator' ? 'operator' : 'bot',
    createdAt: Number(raw.createdAt ?? 0),
    holdUntil: Number(raw.holdUntil ?? 0),
    paidAt: Number(raw.paidAt ?? 0),
    confirmedAt: Number(raw.confirmedAt ?? 0),
    paymentMethod: raw.paymentMethod ?? '',
    paymentRef: raw.paymentRef ?? '',
    paymentLink: raw.paymentLink ?? '',
    companion: raw.companion ?? '',
    attendanceConfirmedAt: Number(raw.attendanceConfirmedAt ?? 0),
    autoSent: parseAutoSent(raw.autoSent),
  }
}

/** Registro de automatizaciones enviadas, guardado como JSON en un campo del hash. */
export function parseAutoSent(raw: string | undefined): Record<string, number> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' ? value as Record<string, number> : {}
  } catch {
    return {}
  }
}

/** Los campos de una cita tal como se guardan en Redis (todo texto; autoSent como JSON). */
function toFields(booking: Partial<Booking>): Record<string, string> {
  return Object.fromEntries(Object.entries(booking).map(([field, value]) => [field, typeof value === 'object' ? JSON.stringify(value) : String(value)]))
}

/** "el anticipo" o "el pago completo": cómo se nombra al cliente lo que paga para reservar. */
export function chargeText(booking: Pick<Booking, 'paymentPlan'>): string {
  return booking.paymentPlan === 'full' ? 'el pago completo de la sesión' : 'el anticipo'
}

/** "Limpieza Peeling Gel" o "Limpieza Peeling Gel para 2 personas": así se nombra la cita al cliente. */
export function serviceText(booking: Pick<Booking, 'serviceLabel' | 'people'>): string {
  return booking.people > 1 ? `${booking.serviceLabel} para ${booking.people} personas` : booking.serviceLabel
}

export async function getBooking(id: string): Promise<Booking | null> {
  const hash = toHash(await redis().hgetall(keys.booking(id)))
  return hash ? toBooking(id, hash) : null
}

export async function getBookings(ids: string[]): Promise<Booking[]> {
  if (!ids.length) return []
  const pipe = redis().pipeline()
  ids.forEach((id) => pipe.hgetall(keys.booking(id)))
  const rows = await pipe.exec<unknown[]>()
  return ids.flatMap((id, index) => {
    const hash = toHash(rows[index])
    return hash ? [toBooking(id, hash)] : []
  })
}

async function releaseSlots(booking: Pick<Booking, 'id' | 'location' | 'day'>) {
  await redis().eval(RELEASE, [keys.slots(booking.location, booking.day)], [booking.id])
}

/** Construir un prompt consulta la disponibilidad de 10 (sede, día): no tiene sentido barrer en cada una. */
const SWEEP_EVERY_MS = 10_000
let lastSweep = 0

/**
 * Libera los horarios que se apartaron y nunca se pagaron. Se llama antes de leer
 * disponibilidad, así que no hace falta ningún cron: el propio tráfico limpia.
 */
export async function sweepExpiredHolds(now = Date.now(), { force = false } = {}): Promise<number> {
  if (!force && now - lastSweep < SWEEP_EVERY_MS) return 0
  lastSweep = now
  const db = redis()
  const expired = await db.zrange<string[]>(keys.holds, 0, now, { byScore: true })
  if (!expired.length) return 0

  const bookings = await getBookings(expired)
  let released = 0
  for (const booking of bookings) {
    // Si ya se confirmó o canceló, solo sobra del índice.
    if (!HOLD_STATUSES.includes(booking.status)) {
      await db.zrem(keys.holds, booking.id)
      continue
    }
    await releaseSlots(booking)
    await db.multi()
      .hset(keys.booking(booking.id), { status: 'cancelled', holdUntil: '0', cancelReason: 'Anticipo no pagado a tiempo' })
      .zrem(keys.byStatus(booking.status), booking.id)
      .zadd(keys.byStatus('cancelled'), { score: booking.startTs, member: booking.id })
      .zrem(keys.day(booking.day), booking.id)
      .zrem(keys.holds, booking.id)
      .exec()
    released++
  }
  // Ids huérfanos (la cita ya no existe) salen del índice para no revisarlos cada vez.
  const alive = new Set(bookings.map((booking) => booking.id))
  const orphans = expired.filter((id) => !alive.has(id))
  if (orphans.length) await db.zrem(keys.holds, ...orphans)
  return released
}

/**
 * Ocupación cruda de una sede en un día, ya sin holds vencidos.
 * `force` salta el acelerador del barrido: hay que usarlo antes de reservar, porque un hold
 * vencido sin barrer todavía ocupa el campo del hash y haría fallar la reserva sin motivo.
 */
export async function occupancyOf(location: Location, day: string, { force = false } = {}): Promise<Occupancy> {
  await sweepExpiredHolds(Date.now(), { force })
  return toHash(await redis().hgetall(keys.slots(location, day))) ?? {}
}

export async function isClosed(day: string): Promise<string | null> {
  return (await redis().get<string>(keys.closed(day))) ?? null
}

export async function setClosed(day: string, reason: string | null) {
  if (reason === null) await redis().del(keys.closed(day))
  else await redis().set(keys.closed(day), reason || 'Cerrado')
}

export type NewBooking = {
  phone: string
  name: string
  location: Location
  serviceId: string
  day: string
  start: string
  concern?: string
  notes?: string
  source?: Booking['source']
  kind?: Booking['kind']
  /** Por defecto pending_payment: el horario queda apartado hasta que el operador valide el anticipo. */
  status?: BookingStatus
  /** 2 = pareja del 2x1: una cabina por persona, a la misma hora. Por defecto 1. */
  people?: number
  /** El cliente prefiere pagar la sesión completa en vez del anticipo. */
  payFull?: boolean
  /** Nombre completo de la segunda persona (pareja del 2x1). */
  companion?: string
}

export type BookingResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: 'service' | 'closed' | 'taken' | 'cabins'; alternatives: string[] }

/**
 * Crea la cita apartando la cabina de forma atómica. Si el horario se ocupó entre que
 * se ofreció y que el cliente aceptó, devuelve `taken` con los inicios que sí quedan libres.
 */
export async function createBooking(config: AppConfig, input: NewBooking): Promise<BookingResult> {
  const db = redis()
  const service = serviceById(config, input.serviceId)
  const durationMin = service?.durationMin ?? (input.kind === 'block' ? config.slotMinutes : 0)
  if (!durationMin) return { ok: false, reason: 'service', alternatives: [] }
  const people = input.kind === 'block' ? 1 : Math.max(1, Math.floor(input.people ?? 1))
  const cabins = config.cabins[input.location] ?? 1
  if (people > cabins) return { ok: false, reason: 'cabins', alternatives: [] }

  const occupancy = await occupancyOf(input.location, input.day, { force: true })
  const free = freeStarts(config, input.location, input.day, durationMin, occupancy, { people })

  if (input.kind !== 'block') {
    if (await isClosed(input.day)) return { ok: false, reason: 'closed', alternatives: [] }
    if (!free.includes(input.start)) return { ok: false, reason: 'taken', alternatives: free }
  }

  const id = crypto.randomUUID().slice(0, 8)
  const startMin = toMinutes(input.start)
  const slots = slotsOf(config, startMin, durationMin)
  const cabin = Number(await db.eval(CLAIM, [keys.slots(input.location, input.day)], [id, String(cabins), String(people), ...slots]))
  // La carrera real se pierde aquí, no en la comprobación de arriba.
  if (!cabin) return { ok: false, reason: 'taken', alternatives: freeStarts(config, input.location, input.day, durationMin, await occupancyOf(input.location, input.day), { people }) }

  const now = Date.now()
  const status = input.status ?? 'pending_payment'
  const price = service ? bookingPrice(config, service, people, input.day) : ''
  // `deposit` es lo que se cobra para reservar: el anticipo, o el total si el cliente paga completo.
  const paymentPlan = input.payFull && amountOf(price) ? 'full' : 'deposit'
  const booking: Booking = {
    id,
    kind: input.kind ?? 'appointment',
    phone: input.phone,
    name: input.name,
    location: input.location,
    cabin,
    people,
    serviceId: input.serviceId,
    serviceLabel: service?.label ?? 'Bloqueo',
    durationMin,
    day: input.day,
    start: input.start,
    startMin,
    startTs: timestampOf(input.day, input.start),
    status,
    price,
    deposit: paymentPlan === 'full' ? pesos(amountOf(price)) : depositOf(config, price),
    paymentPlan,
    concern: input.concern ?? '',
    notes: input.notes ?? '',
    source: input.source ?? 'bot',
    createdAt: now,
    holdUntil: HOLD_STATUSES.includes(status) ? now + config.holdMinutes * 60_000 : 0,
    paidAt: 0,
    confirmedAt: status === 'confirmed' ? now : 0,
    paymentMethod: '',
    paymentRef: '',
    paymentLink: '',
    companion: input.companion ?? '',
    attendanceConfirmedAt: 0,
    autoSent: {},
  }

  const tx = db.multi()
  tx.hset(keys.booking(id), toFields(booking))
  tx.zadd(keys.day(booking.day), { score: booking.startMin, member: id })
  tx.zadd(keys.byStatus(status), { score: booking.startTs, member: id })
  if (booking.holdUntil) tx.zadd(keys.holds, { score: booking.holdUntil, member: id })
  if (booking.phone) {
    tx.lpush(keys.byPhone(booking.phone), id)
    tx.ltrim(keys.byPhone(booking.phone), 0, PHONE_HISTORY - 1)
  }
  await tx.exec()

  return { ok: true, booking }
}

const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  hold: ['pending_payment', 'confirmed', 'cancelled'],
  pending_payment: ['confirmed', 'cancelled'],
  confirmed: ['done', 'no_show', 'cancelled'],
  done: [],
  no_show: ['done'],
  cancelled: [],
}

/** Cambia el estado de una cita y mueve los índices. Libera la cabina si deja de estar viva. */
export async function moveBooking(id: string, status: BookingStatus): Promise<Booking | null | { error: string }> {
  const db = redis()
  const booking = await getBooking(id)
  if (!booking) return null
  if (booking.status === status) return booking
  if (!TRANSITIONS[booking.status].includes(status)) {
    return { error: `Una cita en "${booking.status}" no puede pasar a "${status}".` }
  }

  const now = Date.now()
  const wasLive = LIVE_STATUSES.includes(booking.status)
  const isLive = LIVE_STATUSES.includes(status)
  if (wasLive && !isLive) await releaseSlots(booking)

  const patch: Record<string, string> = { status }
  if (status === 'confirmed') { patch.confirmedAt = String(now); patch.paidAt = String(booking.paidAt || now); patch.holdUntil = '0' }
  if (!HOLD_STATUSES.includes(status)) patch.holdUntil = '0'

  const tx = db.multi()
  tx.hset(keys.booking(id), patch)
  tx.zrem(keys.byStatus(booking.status), id)
  tx.zadd(keys.byStatus(status), { score: booking.startTs, member: id })
  if (patch.holdUntil === '0') tx.zrem(keys.holds, id)
  // Una cita cancelada sale de la grilla del día, pero sigue existiendo para auditoría.
  if (status === 'cancelled') tx.zrem(keys.day(booking.day), id)
  await tx.exec()

  return {
    ...booking,
    status,
    holdUntil: patch.holdUntil === undefined ? booking.holdUntil : Number(patch.holdUntil),
    paidAt: patch.paidAt ? Number(patch.paidAt) : booking.paidAt,
    confirmedAt: patch.confirmedAt ? Number(patch.confirmedAt) : booking.confirmedAt,
  }
}

export async function annotateBooking(id: string, notes: string): Promise<void> {
  await redis().hset(keys.booking(id), { notes: notes.slice(0, 1000) })
}

/**
 * Reprograma MOVIENDO la misma cita (mismo id): conserva el pago, sea anticipo o sesión completa, el
 * link de Bold (que referencia el id) y el acompañante. Suelta las cabinas viejas, aparta las nuevas
 * y, si el horario nuevo no está libre, vuelve a apartar las viejas. Lo usan el panel y Gema.
 */
export async function rescheduleBooking(config: AppConfig, id: string, day: string, start: string, location?: Location): Promise<BookingResult | null> {
  const db = redis()
  const booking = await getBooking(id)
  if (!booking) return null
  if (!LIVE_STATUSES.includes(booking.status)) return { ok: false, reason: 'taken', alternatives: [] }
  const target = location ?? booking.location
  const cabins = config.cabins[target] ?? 1
  if (booking.people > cabins) return { ok: false, reason: 'cabins', alternatives: [] }
  if (booking.kind !== 'block' && await isClosed(day)) return { ok: false, reason: 'closed', alternatives: [] }

  const oldSlots = slotsOf(config, booking.startMin, booking.durationMin)
  const reclaimOld = async () => {
    const cabin = Number(await db.eval(CLAIM, [keys.slots(booking.location, booking.day)], [id, String(config.cabins[booking.location] ?? 1), String(booking.people), ...oldSlots]))
    if (!cabin) console.error(`[booking] no se pudo volver a apartar el horario original de ${id} (${booking.day} ${booking.start}) tras una reprogramación fallida`)
  }

  // Se suelta primero el horario viejo: así una cita puede moverse 15 minutos sin chocar consigo misma.
  await releaseSlots(booking)
  const occupancy = await occupancyOf(target, day, { force: true })
  const free = freeStarts(config, target, day, booking.durationMin, occupancy, { people: booking.people })
  if (booking.kind !== 'block' && !free.includes(start)) {
    await reclaimOld()
    return { ok: false, reason: 'taken', alternatives: free }
  }
  const startMin = toMinutes(start)
  const cabin = Number(await db.eval(CLAIM, [keys.slots(target, day)], [id, String(cabins), String(booking.people), ...slotsOf(config, startMin, booking.durationMin)]))
  if (!cabin) {
    await reclaimOld()
    return { ok: false, reason: 'taken', alternatives: freeStarts(config, target, day, booking.durationMin, await occupancyOf(target, day), { people: booking.people }) }
  }

  const startTs = timestampOf(day, start)
  // Recordatorios ya enviados eran para la fecha vieja: se olvidan, y la asistencia se vuelve a confirmar.
  const moved: Booking = { ...booking, location: target, day, start, startMin, startTs, cabin, autoSent: {}, attendanceConfirmedAt: 0 }
  const tx = db.multi()
  tx.hset(keys.booking(id), toFields({ location: target, day, start, startMin, startTs, cabin, autoSent: {}, attendanceConfirmedAt: 0 }))
  tx.zrem(keys.day(booking.day), id)
  tx.zadd(keys.day(day), { score: startMin, member: id })
  tx.zadd(keys.byStatus(booking.status), { score: startTs, member: id })
  await tx.exec()
  return { ok: true, booking: moved }
}

/** El cliente confirmó que asiste (botón de la plantilla de recordatorio o mensaje). */
export async function confirmAttendance(id: string): Promise<void> {
  await redis().hset(keys.booking(id), { attendanceConfirmedAt: String(Date.now()) })
}

/** Deja constancia de que una automatización ya se envió por esta cita (no se repite). */
export async function markBookingAuto(booking: Pick<Booking, 'id' | 'autoSent'>, kind: string): Promise<void> {
  await redis().hset(keys.booking(booking.id), { autoSent: JSON.stringify({ ...booking.autoSent, [kind]: Date.now() }) })
}

/** Citas de un día, ordenadas por hora de inicio. Incluye bloqueos del operador. */
export async function bookingsOfDay(day: string): Promise<Booking[]> {
  const ids = await redis().zrange<string[]>(keys.day(day), 0, -1)
  return getBookings(ids)
}

export async function bookingsOfDays(days: string[]): Promise<Booking[]> {
  await sweepExpiredHolds(Date.now(), { force: true })
  const pipe = redis().pipeline()
  days.forEach((day) => pipe.zrange(keys.day(day), 0, -1))
  const rows = await pipe.exec<string[][]>()
  return getBookings(rows.flat())
}

export async function bookingsOfPhone(phone: string, count = 10): Promise<Booking[]> {
  const ids = await redis().lrange<string>(keys.byPhone(phone), 0, count - 1)
  return getBookings(ids)
}

/**
 * La cita viva de un cliente, si tiene una. Sirve para que Gema no agende dos veces.
 * Un apartado ya vencido no cuenta aunque el barrido todavía no lo haya liberado: si no, el
 * cliente quedaría bloqueado para reservar de nuevo hasta la siguiente lectura de agenda.
 */
export async function liveBookingOf(phone: string): Promise<Booking | null> {
  const now = Date.now()
  const recent = await bookingsOfPhone(phone, 5)
  return recent.find((booking) => LIVE_STATUSES.includes(booking.status)
    && booking.startTs > now
    && !(HOLD_STATUSES.includes(booking.status) && booking.holdUntil > 0 && booking.holdUntil <= now)) ?? null
}

export async function setPaymentLink(id: string, url: string): Promise<void> {
  await redis().hset(keys.booking(id), { paymentLink: url })
}

/**
 * Bold confirmó el pago del anticipo: la cita pasa a confirmada sin operador y queda registrado
 * cómo se pagó. Idempotente: si ya no está apartada (confirmada, cancelada…), no hace nada.
 */
export async function confirmPaidByBold(id: string, payment: { method: string; paymentRef: string }): Promise<Booking | null> {
  const booking = await getBooking(id)
  if (!booking || !HOLD_STATUSES.includes(booking.status)) return null
  const moved = await moveBooking(id, 'confirmed')
  if (!moved || 'error' in moved) return null
  await redis().hset(keys.booking(id), { paymentMethod: payment.method, paymentRef: payment.paymentRef })
  return { ...moved, paymentMethod: payment.method, paymentRef: payment.paymentRef }
}

/** Marca que el cliente dice haber pagado. No confirma nada: eso lo hace el operador. */
export async function markDepositClaimed(id: string, config: AppConfig): Promise<void> {
  const booking = await getBooking(id)
  if (!booking || !HOLD_STATUSES.includes(booking.status)) return
  // Se amplía el apartado para que el horario no se caiga mientras el operador revisa el comprobante.
  const holdUntil = Math.max(booking.holdUntil, Date.now() + config.holdMinutes * 60_000)
  await redis().multi()
    .hset(keys.booking(id), { paidAt: String(Date.now()), holdUntil: String(holdUntil) })
    .zadd(keys.holds, { score: holdUntil, member: id })
    .exec()
}
