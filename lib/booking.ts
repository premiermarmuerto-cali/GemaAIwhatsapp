/**
 * Citas en Upstash. La ocupación de cabina vive solo en el hash `pm:slots:<sede>:<día>`,
 * donde cada campo es "HH:MM#<cabina>" y su valor el id de la cita. Reservar es escribir
 * esos campos solo si ninguno existe, y eso se hace con un script Lua para que sea atómico:
 * dos clientes que aceptan el mismo horario a la vez no pueden quedar los dos.
 */
import { addDays, beforeQuiet, cabinPlan, dayKey, freeStarts, longestService, slotsOf, timestampOf, toMinutes, type Occupancy } from './calendar'
import { amountOf, bookingPrice, depositOf, pesos, serviceById } from './config'
import { keys, redis, toHash } from './redis'
import { bumpRev, queueRev } from './revision'
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
    sequential: raw.sequential === 'true',
    paymentPlan: raw.paymentPlan === 'full' || raw.paymentPlan === 'cash' || raw.paymentPlan === 'courtesy' ? raw.paymentPlan : 'deposit',
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
    // Citas de antes de que existiera el campo: las de Gema llevan su nombre; las manuales, vacío.
    advisor: raw.advisor ?? (raw.source === 'operator' ? '' : 'Gema'),
    createdAt: Number(raw.createdAt ?? 0),
    holdUntil: Number(raw.holdUntil ?? 0),
    holdSoftFrom: Number(raw.holdSoftFrom ?? 0),
    nameProvisional: raw.nameProvisional === '1' || raw.nameProvisional === 'true',
    paidAt: Number(raw.paidAt ?? 0),
    confirmedAt: Number(raw.confirmedAt ?? 0),
    paymentMethod: raw.paymentMethod ?? '',
    paymentRef: raw.paymentRef ?? '',
    paymentLink: raw.paymentLink ?? '',
    companion: raw.companion ?? '',
    contactPhone: raw.contactPhone ?? '',
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
  if (booking.paymentPlan === 'cash') return 'el pago en la sede'
  if (booking.paymentPlan === 'courtesy') return 'nada (es de cortesía)'
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
    await releaseHold(booking, HOLD_EXPIRED_REASON, { bump: false })
    released++
  }
  // Ids huérfanos (la cita ya no existe) salen del índice para no revisarlos cada vez.
  const alive = new Set(bookings.map((booking) => booking.id))
  const orphans = expired.filter((id) => !alive.has(id))
  if (orphans.length) await db.zrem(keys.holds, ...orphans)
  if (released) await bumpRev('agenda')
  return released
}

/** Motivo con el que se cancela una reserva que venció sin anticipo (lo leen las plantillas de lib/automations.ts). */
export const HOLD_EXPIRED_REASON = 'Anticipo no pagado a tiempo'
/** Motivo con el que se cancela una reserva renovada cuando otro cliente toma su horario. */
export const HOLD_TAKEN_REASON = 'Liberada: otro cliente tomó el horario'

/** Cancela una reserva sin pago y suelta su cabina. */
export async function releaseHold(booking: Booking, reason: string, { bump = true } = {}): Promise<void> {
  await releaseSlots(booking)
  await redis().multi()
    // releasedAt: el programador (lib/automations.ts) le avisa al cliente con el mensaje "Reserva liberada".
    .hset(keys.booking(booking.id), { status: 'cancelled', holdUntil: '0', cancelReason: reason, releasedAt: String(Date.now()) })
    .zrem(keys.byStatus(booking.status), booking.id)
    .zadd(keys.byStatus('cancelled'), { score: booking.startTs, member: booking.id })
    .zrem(keys.day(booking.day), booking.id)
    .zrem(keys.holds, booking.id)
    .zrem(keys.softHolds, booking.id)
    .exec()
  if (bump) await bumpRev('agenda')
}

/**
 * Reservas renovadas que ya puede tomar otro cliente (ver renewReservation). Su cabina sigue marcada
 * en el hash de slots, pero para ofrecer horarios cuentan como libres.
 */
export async function softHoldIds(now = Date.now()): Promise<Set<string>> {
  return new Set(await redis().zrange<string[]>(keys.softHolds, 0, now, { byScore: true }))
}

/** La ocupación sin las reservas renovadas que otro cliente puede tomar. */
export function withoutSoftHolds(occupancy: Occupancy, soft: Set<string>): Occupancy {
  if (!soft.size) return occupancy
  return Object.fromEntries(Object.entries(occupancy).filter(([, id]) => !soft.has(String(id))))
}

/**
 * Ocupación de una sede en un día, ya sin holds vencidos y sin las reservas renovadas que otro cliente
 * puede tomar (`includeSoft` las deja: es la ocupación real del hash).
 * `force` salta el acelerador del barrido: hay que usarlo antes de reservar, porque un hold
 * vencido sin barrer todavía ocupa el campo del hash y haría fallar la reserva sin motivo.
 */
export async function occupancyOf(location: Location, day: string, { force = false, includeSoft = false } = {}): Promise<Occupancy> {
  await sweepExpiredHolds(Date.now(), { force })
  const occupancy = toHash(await redis().hgetall(keys.slots(location, day))) ?? {}
  return includeSoft ? occupancy : withoutSoftHolds(occupancy, await softHoldIds())
}

// ───────────────────────── Reservas sin anticipo ─────────────────────────
//
// Acordado con Premier (23 oct 2026). Una reserva de Gema sin anticipo dura lo que la ventana de 24 h
// de WhatsApp (se libera 5 min antes de que se cierre, para poder avisarle). En ese tiempo el horario
// está ocupado para todos. Si el cliente vuelve a escribir antes de que venza, se renueva 12 h desde
// ese mensaje, hasta 32 h en total; en esa renovación el horario se ofrece a otros clientes y, si otro
// lo reserva, se queda con él. Nada de esto aplica a efectivo ni a las citas del equipo (confirmadas).

const HOUR_MS = 3_600_000
/** La ventana de WhatsApp menos 5 minutos: a tiempo para enviarle el aviso de liberación. */
const RESERVATION_MS = 24 * HOUR_MS - 5 * 60_000
const RENEWAL_MS = 12 * HOUR_MS
const RESERVATION_MAX_MS = 32 * HOUR_MS

/** Hasta cuándo dura una reserva hecha con el último mensaje del cliente en `lastInboundAt`. */
export function reservationDeadline(lastInboundAt: number): number {
  return beforeQuiet(lastInboundAt + RESERVATION_MS)
}

/**
 * El cliente volvió a escribir: su reserva sin pagar se renueva 12 h desde este mensaje (hasta 32 h desde
 * que se creó) y pasa a ser "tomable" por otro cliente desde donde vencía antes. Si la renovación no
 * alarga el plazo (escribió poco después de reservar), no cambia nada.
 */
export async function renewReservation(phone: string, at: number): Promise<void> {
  for (const booking of await bookingsOfPhone(phone, 3)) {
    if (!HOLD_STATUSES.includes(booking.status) || booking.source !== 'bot' || booking.paidAt || booking.holdUntil <= at) continue
    await applyReservationTerms(booking, at)
  }
}

/**
 * Plazo de una reserva sin anticipo hecha en `createdAt`, si el último mensaje del cliente fue en
 * `lastMessageAt`: la ventana de 24 h desde que reservó o, si escribió después, 12 h desde ese mensaje
 * (hasta 32 h en total), lo que sea MÁS TARDE. La renovación nunca acorta: el 23 oct, una renovación de
 * 12 h que caía de madrugada (adelantada a las 8:45 p.m.) dejó a Marie con menos plazo que su ventana
 * inicial, y su horario ya se ofrecía a otros. `softFrom` > 0 solo si la renovación alarga la ventana:
 * desde ahí otro cliente puede tomar el horario.
 */
export function reservationTerms(createdAt: number, lastMessageAt: number): { holdUntil: number; softFrom: number } {
  const initial = reservationDeadline(createdAt)
  const renewed = lastMessageAt > createdAt ? beforeQuiet(Math.min(lastMessageAt + RENEWAL_MS, createdAt + RESERVATION_MAX_MS)) : 0
  return renewed > initial ? { holdUntil: renewed, softFrom: initial } : { holdUntil: initial, softFrom: 0 }
}

/** Aplica a una reserva el plazo que le corresponde (ver reservationTerms). Nunca la acorta. */
export async function applyReservationTerms(booking: Booking, lastMessageAt: number): Promise<{ holdUntil: number; softFrom: number } | null> {
  const terms = reservationTerms(booking.createdAt, lastMessageAt)
  const holdUntil = Math.max(booking.holdUntil, terms.holdUntil)
  const softFrom = terms.softFrom ? booking.holdSoftFrom || terms.softFrom : 0
  if (holdUntil === booking.holdUntil && softFrom === booking.holdSoftFrom) return null
  const tx = redis().multi()
    .hset(keys.booking(booking.id), { holdUntil: String(holdUntil), holdSoftFrom: String(softFrom) })
    .zadd(keys.holds, { score: holdUntil, member: booking.id })
  if (softFrom) tx.zadd(keys.softHolds, { score: softFrom, member: booking.id })
  else tx.zrem(keys.softHolds, booking.id)
  await tx.incr(keys.rev('agenda')).exec()
  return { holdUntil, softFrom }
}

/**
 * Horas concretas para ofrecer sin que el cliente las pida (seguimientos): la primera libre y otra
 * al menos 3 h después, o la primera del día siguiente. Con la duración más larga del catálogo, así
 * sirven para cualquier servicio. Es la misma disponibilidad que ve Gema y que comprueba la reserva.
 * `people: 2`: horas en que caben dos personas a la vez (2x1).
 */
export async function suggestStarts(
  config: AppConfig,
  location: Location,
  { now = Date.now(), count = 2, people = 1, day: onlyDay = '', part = '' }: { now?: number; count?: number; people?: number; day?: string; part?: string } = {},
): Promise<Array<{ day: string; start: string }>> {
  const out: Array<{ day: string; start: string }> = []
  const today = dayKey(now)
  // El día y la franja que pidió el cliente (lib/preferences.ts): solo se ofrece lo que encaja.
  const inPart = (start: string) => !part || (part === 'mañana' ? toMinutes(start) < 12 * 60 : part === 'tarde' ? toMinutes(start) >= 12 * 60 && toMinutes(start) < 18 * 60 : toMinutes(start) >= 18 * 60)
  const days = onlyDay ? [onlyDay] : Array.from({ length: Math.min(7, config.horizonDays) }, (_, offset) => addDays(today, offset))
  for (const day of days) {
    if (out.length >= count) break
    if (day < today || await isClosed(day)) continue
    for (const start of freeStarts(config, location, day, longestService(config), await occupancyOf(location, day), { now, people }).filter(inPart)) {
      const last = out.at(-1)
      if (!last || last.day !== day || toMinutes(start) - toMinutes(last.start) >= 180) out.push({ day, start })
      if (out.length >= count) break
    }
  }
  return out
}

export async function isClosed(day: string): Promise<string | null> {
  return (await redis().get<string>(keys.closed(day))) ?? null
}

/** Días cerrados de una lista (vista mensual: 42 días en una sola petición a Upstash). */
export async function closedDays(days: string[]): Promise<Record<string, string>> {
  if (!days.length) return {}
  const pipe = redis().pipeline()
  days.forEach((day) => pipe.get(keys.closed(day)))
  const rows = await pipe.exec<Array<string | null>>()
  const out: Record<string, string> = {}
  days.forEach((day, index) => { if (rows[index]) out[day] = String(rows[index]) })
  return out
}

export async function setClosed(day: string, reason: string | null) {
  if (reason === null) await redis().del(keys.closed(day))
  else await redis().set(keys.closed(day), reason || 'Cerrado')
  await bumpRev('agenda')
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
  /** Celular de contacto de un cliente con número oculto. */
  contactPhone?: string
  /** Nombre completo de la segunda persona (pareja del 2x1). */
  companion?: string
  /** Paga todo en la sede, sin anticipo: la cita queda confirmada (no apartada) y sin link. */
  cash?: boolean
  /** Quién la agenda: "Gema" o el nombre del asesor que la creó en el panel. */
  advisor?: string
  /** Limpieza de cortesía (por compra de productos en la sede): no se cobra nada. */
  courtesy?: boolean
  /** Ya pagó lo que dice `paymentPlan` (cita creada a mano por un asesor que recibió el anticipo o el total). */
  paid?: boolean
  /** Hasta cuándo dura la reserva sin anticipo. Por defecto, la ventana de WhatsApp desde ahora. */
  holdUntil?: number
  /** El cliente todavía no dio su nombre completo: la reserva lleva uno provisional. */
  nameProvisional?: boolean
}

export type BookingResult =
  | { ok: true; booking: Booking; bumped?: Booking[] }
  | { ok: false; reason: 'service' | 'closed' | 'taken' | 'cabins'; alternatives: string[] }

/**
 * Crea la cita apartando la cabina de forma atómica. Si el horario se ocupó entre que
 * se ofreció y que el cliente aceptó, devuelve `taken` con los inicios que sí quedan libres.
 */
export async function createBooking(config: AppConfig, input: NewBooking): Promise<BookingResult> {
  const db = redis()
  const service = serviceById(config, input.serviceId)
  const sessionMin = service?.durationMin ?? (input.kind === 'block' ? config.slotMinutes : 0)
  if (!sessionMin) return { ok: false, reason: 'service', alternatives: [] }
  const people = input.kind === 'block' ? 1 : Math.max(1, Math.floor(input.people ?? 1))
  const cabins = config.cabins[input.location] ?? 1
  // Con una sola cabina, una pareja ocupa las dos sesiones seguidas (ver cabinPlan).
  const plan = cabinPlan(cabins, people, sessionMin)
  const durationMin = plan.minutes

  const occupancy = await occupancyOf(input.location, input.day, { force: true })
  const free = freeStarts(config, input.location, input.day, sessionMin, occupancy, { people })

  if (input.kind !== 'block') {
    if (await isClosed(input.day)) return { ok: false, reason: 'closed', alternatives: [] }
    if (!free.includes(input.start)) return { ok: false, reason: 'taken', alternatives: free }
  }

  const id = crypto.randomUUID().slice(0, 8)
  const startMin = toMinutes(input.start)
  const slots = slotsOf(config, startMin, durationMin)
  const claim = () => db.eval(CLAIM, [keys.slots(input.location, input.day)], [id, String(cabins), String(plan.lanes), ...slots]).then(Number)
  let cabin = await claim()
  // El horario estaba libre salvo por reservas renovadas de otros clientes: este se queda con él y a
  // ellos se les libera (acordado con Premier: prima quien reserva durante la renovación).
  const bumped: Booking[] = []
  if (!cabin && input.kind !== 'block') {
    const soft = await softHoldIds()
    const raw = await occupancyOf(input.location, input.day, { includeSoft: true })
    const wanted = new Set(slots)
    const holders = [...new Set(Object.entries(raw).filter(([field, holder]) => wanted.has(field.split('#')[0]) && soft.has(String(holder))).map(([, holder]) => String(holder)))]
    for (const holder of await getBookings(holders)) {
      if (!HOLD_STATUSES.includes(holder.status) || holder.paidAt) continue
      await releaseHold(holder, HOLD_TAKEN_REASON)
      bumped.push(holder)
    }
    if (bumped.length) cabin = await claim()
  }
  // La carrera real se pierde aquí, no en la comprobación de arriba.
  if (!cabin) return { ok: false, reason: 'taken', alternatives: freeStarts(config, input.location, input.day, sessionMin, await occupancyOf(input.location, input.day), { people }) }

  const now = Date.now()
  // Efectivo: confirmada desde ya, sin apartado que venza (no hay pago que esperar).
  const status = input.status ?? (input.cash ? 'confirmed' : 'pending_payment')
  const price = service ? bookingPrice(config, service, people, input.day) : ''
  // `deposit` es lo que se cobra para reservar: el anticipo, el total si paga completo, nada en efectivo.
  const paymentPlan = input.courtesy ? 'courtesy' : input.cash ? 'cash' : input.payFull && amountOf(price) ? 'full' : 'deposit'
  const booking: Booking = {
    id,
    kind: input.kind ?? 'appointment',
    phone: input.phone,
    name: input.name,
    location: input.location,
    cabin,
    people,
    sequential: plan.sequential,
    serviceId: input.serviceId,
    serviceLabel: service?.label ?? 'Bloqueo',
    durationMin,
    day: input.day,
    start: input.start,
    startMin,
    startTs: timestampOf(input.day, input.start),
    status,
    price,
    deposit: paymentPlan === 'cash' || paymentPlan === 'courtesy' ? '' : paymentPlan === 'full' ? pesos(amountOf(price)) : depositOf(config, price),
    paymentPlan,
    concern: input.concern ?? '',
    notes: input.notes ?? '',
    source: input.source ?? 'bot',
    advisor: (input.advisor ?? (input.source === 'operator' ? '' : 'Gema')).trim().slice(0, 60),
    createdAt: now,
    holdUntil: HOLD_STATUSES.includes(status) ? input.holdUntil ?? reservationDeadline(now) : 0,
    holdSoftFrom: 0,
    nameProvisional: Boolean(input.nameProvisional),
    paidAt: input.paid && paymentPlan !== 'cash' && paymentPlan !== 'courtesy' ? now : 0,
    confirmedAt: status === 'confirmed' ? now : 0,
    paymentMethod: '',
    paymentRef: '',
    paymentLink: '',
    companion: input.companion ?? '',
    contactPhone: input.contactPhone ?? '',
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
  queueRev(tx, 'agenda')
  await tx.exec()

  return { ok: true, booking, ...(bumped.length ? { bumped } : {}) }
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
  if (patch.holdUntil === '0') tx.zrem(keys.holds, id).zrem(keys.softHolds, id)
  // Una cita cancelada sale de la grilla del día, pero sigue existiendo para auditoría.
  if (status === 'cancelled') tx.zrem(keys.day(booking.day), id)
  queueRev(tx, 'agenda')
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
  await bumpRev('agenda')
}

/** Cambia el asesor responsable de la cita (el panel lo permite para reasignar sesiones). */
export async function setBookingAdvisor(id: string, advisor: string): Promise<void> {
  await redis().hset(keys.booking(id), { advisor: advisor.trim().slice(0, 60) })
  await bumpRev('agenda')
}

/**
 * Reprograma MOVIENDO la misma cita (mismo id): conserva el pago, sea anticipo o sesión completa, el
 * link de Bold (que referencia el id) y el acompañante. Suelta las cabinas viejas, aparta las nuevas
 * y, si el horario nuevo no está libre, vuelve a apartar las viejas. Lo usan el panel y Gema.
 */
export async function rescheduleBooking(config: AppConfig, id: string, day: string, start: string, location?: Location, serviceId?: string): Promise<BookingResult | null> {
  const db = redis()
  const current = await getBooking(id)
  if (!current) return null
  // Cambio de servicio (desde el panel): otra duración, otro precio. El anticipo se recalcula solo si
  // todavía no se pagó; lo ya pagado se conserva tal cual.
  const service = serviceId && serviceId !== current.serviceId ? serviceById(config, serviceId) : undefined
  if (serviceId && serviceId !== current.serviceId && !service) return { ok: false, reason: 'service', alternatives: [] }
  const booking = current
  // Duración de UNA sesión: la del catálogo; si el servicio ya no existe, la guardada (por persona si iban seguidas).
  const sessionMin = service?.durationMin ?? serviceById(config, booking.serviceId)?.durationMin
    ?? (booking.sequential ? Math.round(booking.durationMin / booking.people) : booking.durationMin)
  if (!LIVE_STATUSES.includes(booking.status)) return { ok: false, reason: 'taken', alternatives: [] }
  const target = location ?? booking.location
  const cabins = config.cabins[target] ?? 1
  const plan = cabinPlan(cabins, booking.people, sessionMin)
  const durationMin = plan.minutes
  if (booking.kind !== 'block' && await isClosed(day)) return { ok: false, reason: 'closed', alternatives: [] }

  const oldSlots = slotsOf(config, booking.startMin, booking.durationMin)
  const reclaimOld = async () => {
    const cabin = Number(await db.eval(CLAIM, [keys.slots(booking.location, booking.day)], [id, String(config.cabins[booking.location] ?? 1), String(booking.sequential ? 1 : booking.people), ...oldSlots]))
    if (!cabin) console.error(`[booking] no se pudo volver a apartar el horario original de ${id} (${booking.day} ${booking.start}) tras una reprogramación fallida`)
  }

  // Se suelta primero el horario viejo: así una cita puede moverse 15 minutos sin chocar consigo misma.
  await releaseSlots(booking)
  const occupancy = await occupancyOf(target, day, { force: true })
  const free = freeStarts(config, target, day, sessionMin, occupancy, { people: booking.people })
  if (booking.kind !== 'block' && !free.includes(start)) {
    await reclaimOld()
    return { ok: false, reason: 'taken', alternatives: free }
  }
  const startMin = toMinutes(start)
  const cabin = Number(await db.eval(CLAIM, [keys.slots(target, day)], [id, String(cabins), String(plan.lanes), ...slotsOf(config, startMin, durationMin)]))
  if (!cabin) {
    await reclaimOld()
    return { ok: false, reason: 'taken', alternatives: freeStarts(config, target, day, sessionMin, await occupancyOf(target, day), { people: booking.people }) }
  }
  const unpaid = !booking.paidAt && booking.status !== 'confirmed'
  const price = service ? bookingPrice(config, service, booking.people, day) : booking.price
  const serviceFields = {
    durationMin,
    sequential: plan.sequential,
    ...(service ? {
    serviceId: service.id,
    serviceLabel: service.label,
    price,
    ...(booking.paymentPlan === 'cash' || booking.paymentPlan === 'courtesy' || !unpaid ? {} : { deposit: booking.paymentPlan === 'full' ? pesos(amountOf(price)) : depositOf(config, price) }),
    } : {}),
  }

  const startTs = timestampOf(day, start)
  // Recordatorios ya enviados eran para la fecha vieja: se olvidan, y la asistencia se vuelve a confirmar.
  const moved: Booking = { ...booking, ...serviceFields, location: target, day, start, startMin, startTs, cabin, autoSent: {}, attendanceConfirmedAt: 0 }
  const tx = db.multi()
  tx.hset(keys.booking(id), toFields({ ...serviceFields, location: target, day, start, startMin, startTs, cabin, autoSent: {}, attendanceConfirmedAt: 0 }))
  tx.zrem(keys.day(booking.day), id)
  tx.zadd(keys.day(day), { score: startMin, member: id })
  tx.zadd(keys.byStatus(booking.status), { score: startTs, member: id })
  queueRev(tx, 'agenda')
  await tx.exec()
  return { ok: true, booking: moved }
}

/**
 * Corrige los datos de la persona en una cita (panel): nombre, acompañante, teléfono y celular de
 * contacto. Si cambia el teléfono, la cita pasa al historial del número nuevo.
 */
export async function updateBookingDetails(id: string, patch: { name?: string; companion?: string; phone?: string; contactPhone?: string }): Promise<Booking | null> {
  const booking = await getBooking(id)
  if (!booking) return null
  const fields: Record<string, string> = {}
  if (patch.name !== undefined) {
    fields.name = patch.name.trim().slice(0, 80)
    fields.nameProvisional = '0'
  }
  if (patch.companion !== undefined) fields.companion = patch.companion.trim().slice(0, 80)
  if (patch.contactPhone !== undefined) fields.contactPhone = patch.contactPhone.trim().slice(0, 20)
  const tx = redis().multi()
  if (patch.phone !== undefined && patch.phone !== booking.phone) {
    fields.phone = patch.phone
    if (booking.phone) tx.lrem(keys.byPhone(booking.phone), 0, id)
    if (patch.phone) tx.lpush(keys.byPhone(patch.phone), id)
  }
  if (!Object.keys(fields).length) return booking
  tx.hset(keys.booking(id), fields)
  queueRev(tx, 'agenda')
  await tx.exec()
  return { ...booking, ...fields, nameProvisional: patch.name !== undefined ? false : booking.nameProvisional } as Booking
}

/** Cómo paga una cita creada o editada en el panel. */
export type ManualPayment = 'onsite' | 'deposit' | 'full' | 'courtesy'

/**
 * El asesor registra cómo paga la cita: todo en la sede, ya pagó el anticipo o ya pagó completo.
 * Antes las citas manuales mostraban el anticipo por defecto como si se hubiera cobrado.
 */
export async function setBookingPayment(config: AppConfig, id: string, payment: ManualPayment): Promise<Booking | null> {
  const booking = await getBooking(id)
  if (!booking) return null
  const now = Date.now()
  const fields = payment === 'onsite' || payment === 'courtesy'
    ? { paymentPlan: payment === 'courtesy' ? 'courtesy' : 'cash', deposit: '', paidAt: '0' }
    : payment === 'full'
      ? { paymentPlan: 'full', deposit: pesos(amountOf(booking.price)), paidAt: String(booking.paidAt || now) }
      : { paymentPlan: 'deposit', deposit: booking.paymentPlan === 'deposit' && booking.deposit ? booking.deposit : depositOf(config, booking.price), paidAt: String(booking.paidAt || now) }
  await redis().multi().hset(keys.booking(id), fields).incr(keys.rev('agenda')).exec()
  return getBooking(id)
}

/** El cliente confirmó que asiste (botón de la plantilla de recordatorio o mensaje). */
export async function confirmAttendance(id: string): Promise<void> {
  await redis().hset(keys.booking(id), { attendanceConfirmedAt: String(Date.now()) })
  await bumpRev('agenda')
}

/** Deja constancia de que una automatización ya se envió por esta cita (no se repite). */
export async function markBookingAuto(booking: Pick<Booking, 'id'>, kind: string): Promise<void> {
  // Se lee el registro actual para no pisar otra marca hecha en la misma corrida.
  const current = parseAutoSent(await redis().hget<string>(keys.booking(booking.id), 'autoSent') ?? undefined)
  await redis().hset(keys.booking(booking.id), { autoSent: JSON.stringify({ ...current, [kind]: Date.now() }) })
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

/**
 * Cita que agendó un asesor en el panel: por venir, recién pasada (la hora pasó hace menos de 6 h y nadie
 * la marcó) o marcada "no asistió" en los últimos 3 días. A ese cliente lo atiende el equipo por fuera de
 * Gema y el cobro también: Gema nunca le pide anticipo, link ni comprobante, no le manda seguimientos de
 * venta, y si quiere otra fecha se le reprograma. 22 oct: Shereek tocó "Reagendar" 20 min antes de su
 * cita; al pasar la hora el sistema la tomó por prospecto nuevo, le llegó el seguimiento de 45 min y Gema
 * le agendó otra cita cobrándole el anticipo.
 *
 * Una cita "confirmada" ya pasada cuenta solo unas horas: el equipo no marca "asistió", y quien sí vino y
 * escribe días después para otra cita no es alguien que "no alcanzó a venir".
 */
export async function teamBookingOf(phone: string): Promise<Booking | null> {
  const now = Date.now()
  const recent = await bookingsOfPhone(phone, 5)
  return recent.find((booking) => booking.source === 'operator' && booking.kind !== 'block' && (
    (LIVE_STATUSES.includes(booking.status) && booking.startTs > now - TEAM_PASSED_HOURS * 3_600_000)
    || (booking.status === 'no_show' && booking.startTs > now - TEAM_NO_SHOW_DAYS * 24 * 3_600_000)
  )) ?? null
}

/** Horas después de la hora de una cita del equipo (sin marcar) en que se le sigue tratando como cliente del equipo. */
const TEAM_PASSED_HOURS = 6
/** Días después de una cita del equipo marcada "no asistió" en que se le sigue tratando como cliente del equipo. */
const TEAM_NO_SHOW_DAYS = 3

/**
 * Otra fecha para una cita del equipo. Si todavía no llega su hora, se mueve la misma cita
 * (rescheduleBooking). Si la hora ya pasó (no asistió, o nadie la marcó y no se sabe si vino), esa cita
 * NO se toca, para que el equipo la marque, y se crea una nueva igual: mismo asesor, misma forma de
 * pago, confirmada. Moverla borraba de la agenda una sesión que quizá sí se hizo.
 */
export async function rescheduleTeamBooking(config: AppConfig, booking: Booking, day: string, start: string, location: Location): Promise<BookingResult | null> {
  if (booking.status !== 'no_show' && booking.startTs > Date.now()) return rescheduleBooking(config, booking.id, day, start, location)
  return createBooking(config, {
    phone: booking.phone, name: booking.name, location, serviceId: booking.serviceId, day, start,
    concern: booking.concern, notes: booking.notes, source: 'operator', advisor: booking.advisor, status: 'confirmed',
    people: booking.people, companion: booking.companion, contactPhone: booking.contactPhone,
    cash: booking.paymentPlan === 'cash', courtesy: booking.paymentPlan === 'courtesy',
    payFull: booking.paymentPlan === 'full', paid: booking.paidAt > 0,
  })
}

export async function setPaymentLink(id: string, url: string): Promise<void> {
  await redis().hset(keys.booking(id), { paymentLink: url })
  await bumpRev('agenda')
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
  await bumpRev('agenda')
  return { ...moved, paymentMethod: payment.method, paymentRef: payment.paymentRef }
}

/**
 * Marca que el cliente dice haber pagado (mandó el comprobante). No confirma nada: eso lo hace el
 * operador. Mientras tanto la reserva no se libera sola ni la puede tomar otro cliente: solo vence a la
 * hora de la sesión, si nadie la validó.
 */
export async function markDepositClaimed(id: string): Promise<void> {
  const booking = await getBooking(id)
  if (!booking || !HOLD_STATUSES.includes(booking.status)) return
  const holdUntil = Math.max(booking.holdUntil, booking.startTs)
  await redis().multi()
    .hset(keys.booking(id), { paidAt: String(booking.paidAt || Date.now()), holdUntil: String(holdUntil) })
    .zadd(keys.holds, { score: holdUntil, member: id })
    .zrem(keys.softHolds, id)
    .incr(keys.rev('agenda'))
    .exec()
}
