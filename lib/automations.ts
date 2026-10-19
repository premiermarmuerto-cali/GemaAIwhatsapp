/**
 * Mensajes que Gema envía sola, sin que el cliente escriba: seguimientos y plantillas de WhatsApp.
 * Los dispara app/api/cron cada 10–15 minutos. Reglas acordadas con Premier (oct 2026):
 *
 * Texto libre (gratis, solo con la ventana de 24 h abierta):
 *   seguimiento_pago   ~30 min antes de que se libere un horario apartado sin pago
 *   seguimiento_22h    ~22 h después del último mensaje del cliente, si quedó sin responder y sin cita
 *   recordatorio_hoy   2–3 h antes de una cita con la asistencia confirmada
 *   recordatorio_cita  24 h antes de cada cita pagada (si la ventana está cerrada, va como plantilla)
 *
 * Plantillas (se cobran; solo con la ventana cerrada y si WHATSAPP_TEMPLATES=on):
 *   retomar_cita_limpieza  más de 24 h sin escribir, sin cita (marketing)
 *   anticipo_pendiente     el horario se liberó sin pago hace más de 24 h y la sesión aún no pasa (marketing)
 *   ultimos_dias_bono      2–3 días antes de que venza un 2x1, a quien escribió y no agendó (marketing)
 *   recordatorio_cita      24 h antes de la cita (utilidad)
 *
 * Nada se envía a chats que atiende una persona (Gema en pausa o pidiendo asesor), ni de noche, y
 * cada automatización queda registrada para no repetirse. Las de marketing respetan "Ahora no".
 */
import { bookingsOfPhone, getBookings, liveBookingOf, markBookingAuto, serviceText, sweepExpiredHolds } from './booking'
import { clock12, dayKey, dayLabel, fullDayLabel, minuteOfDay } from './calendar'
import { listChats, markChatAuto, recordOutbound } from './chats'
import { LOCATION_LABEL, MONTH_NAME } from './clinic'
import { getConfig } from './config'
import { keys, redis } from './redis'
import { SEPARATOR, toMessages } from './reply-style'
import { HOLD_STATUSES, type AppConfig, type Booking, type ChatSummary } from './types'
import { sendWhatsAppTemplate, sendWhatsAppText } from './whatsapp'
import { isWindowOpen, WHATSAPP_WINDOW_MS } from './window'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Solo se escribe entre 8:00 a.m. y 9:00 p.m. (hora de Colombia). */
const SEND_FROM_MIN = 8 * 60
const SEND_TO_MIN = 21 * 60
/** Tope de envíos por corrida: si algo se descontrola, no sale una avalancha de mensajes. */
const MAX_SENDS_PER_RUN = 25
const MESSAGE_GAP_MS = 1_200

/**
 * Plantillas aprobadas en Meta (WABA 1997545614294706), tal como están registradas el 18 oct 2026.
 * `language`: el idioma con el que se REGISTRARON, no el del texto. Tres quedaron como "English"
 * aunque están en español; si el código no coincide, Meta responde 132001.
 * `image`: archivo en public/plantillas/ para el encabezado de imagen.
 * Botones de cada una (llegan al webhook como mensaje de tipo "button" con su texto):
 *   recordatorio_cita      Confirmo mi cita / Reagendar / No podré asistir
 *   ultimos_dias_bono      Sí, agéndame / Tengo una duda / Ahora no
 *   anticipo_pendiente     Enviar link / Cambiar horario / Ahora no
 *   retomar_cita_limpieza  Sí, quiero agendar / Tengo una pregunta / Ahora no
 */
export const TEMPLATES = {
  retomar_cita_limpieza: { language: 'es_CO', image: 'plantilla_retomar_cita.jpg' },
  anticipo_pendiente: { language: 'en' },
  ultimos_dias_bono: { language: 'en', image: 'plantilla_ultimos_dias_bono.jpg' },
  recordatorio_cita: { language: 'en' },
} as const satisfies Record<string, { language: string; image?: string }>
type TemplateName = keyof typeof TEMPLATES
/** Plantillas de categoría Marketing (se cobran más y respetan "Ahora no"); recordatorio_cita es Utility. */
const MARKETING = new Set<TemplateName>(['retomar_cita_limpieza', 'anticipo_pendiente', 'ultimos_dias_bono'])
const MARKETING_GAP_MS = 3 * 24 * 60 * 60_000

const templatesOn = () => process.env.WHATSAPP_TEMPLATES === 'on'
const automationsOn = () => process.env.AUTOMATIONS !== 'off'
const publicUrl = () => (process.env.PUBLIC_APP_URL || 'https://premier-agente.vercel.app').replace(/\/$/, '')

export type Outcome = { kind: string; phone: string; how: 'texto' | 'plantilla' | 'simulado' | 'omitido' | 'error'; detail?: string }

/** Primer nombre con letras ("Ana 🌸 Pérez" → "Ana"). Vacío si no hay. */
export function firstName(name: string): string {
  const word = name.split(/\s+/).map((part) => part.replace(/[^\p{L}'-]/gu, '')).find((part) => /\p{L}{2,}/u.test(part))
  return word ? word[0].toUpperCase() + word.slice(1) : ''
}

/** "10:00 a. m.": formato de hora de las plantillas. */
const templateClock = (hhmm: string) => clock12(hhmm).replace('a.m.', 'a. m.').replace('p.m.', 'p. m.')

/** Una persona atiende el chat: Gema no le escribe sola. */
const humanHandling = (chat: ChatSummary) => !chat.botActive || chat.needsAgent

class Run {
  sends = 0
  outcomes: Outcome[] = []
  constructor(readonly config: AppConfig, readonly now: number, readonly dryRun: boolean) {}

  private full() { return this.sends >= MAX_SENDS_PER_RUN }

  /** Texto libre (ventana abierta). Varios mensajes separados por |||. */
  async text(chat: ChatSummary, kind: string, body: string, booking?: Booking): Promise<boolean> {
    if (this.full()) return false
    if (this.dryRun) { this.outcomes.push({ kind, phone: chat.phone, how: 'simulado', detail: body }); this.sends++; return true }
    try {
      for (const [index, message] of toMessages(body).entries()) {
        if (index) await new Promise((resolve) => setTimeout(resolve, MESSAGE_GAP_MS))
        const id = await sendWhatsAppText(chat.phone, message)
        await recordOutbound(chat.phone, { id: id ?? crypto.randomUUID(), sender: 'gem', text: message, at: Date.now(), auto: kind })
      }
      await (booking ? markBookingAuto(booking, kind) : markChatAuto(chat, kind))
      this.sends++
      this.outcomes.push({ kind, phone: chat.phone, how: 'texto' })
      return true
    } catch (error) {
      this.outcomes.push({ kind, phone: chat.phone, how: 'error', detail: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  /** Teléfonos que ya recibieron una plantilla de marketing en esta corrida. */
  private marketed = new Set<string>()

  /** Plantilla aprobada (ventana cerrada). Si las plantillas están apagadas, no envía nada. */
  async template(phone: string, chat: ChatSummary | null, kind: string, name: TemplateName, params: Record<string, string>, booking?: Booking): Promise<boolean> {
    if (this.full()) return false
    // Máximo una plantilla de marketing por persona cada 3 días: más que eso molesta y Meta baja la
    // calidad del número (y limita los envíos) cuando la gente bloquea o reporta.
    if (MARKETING.has(name)) {
      const lastMarketing = Math.max(0, ...Object.entries(chat?.autoSent ?? {}).filter(([key]) => MARKETING.has(key.split(':')[0] as TemplateName)).map(([, at]) => at))
      if (this.marketed.has(phone) || this.now - lastMarketing < MARKETING_GAP_MS) return false
    }
    if (!templatesOn()) { this.outcomes.push({ kind, phone, how: 'omitido', detail: 'plantillas apagadas (WHATSAPP_TEMPLATES)' }); return false }
    // Un error reciente (plantilla no aprobada, imagen caída) no se reintenta cada 15 minutos.
    const failedAt = (booking?.autoSent ?? chat?.autoSent ?? {})[`${kind}:error`] ?? 0
    if (this.now - failedAt < DAY) return false
    const { language, image } = TEMPLATES[name] as { language: string; image?: string }
    const imageUrl = image ? `${publicUrl()}/plantillas/${image}` : undefined
    // Sin la imagen publicada, Meta rechaza el envío: no se intenta (ni se cobra) hasta que esté.
    if (imageUrl && !this.dryRun && !(await imageAvailable(imageUrl))) {
      this.outcomes.push({ kind, phone, how: 'omitido', detail: `falta la imagen ${image} en public/plantillas/` })
      return false
    }
    const summary = `[Plantilla "${name}" enviada · ${Object.entries(params).map(([key, value]) => `${key}: ${value}`).join(' · ')}]`
    if (MARKETING.has(name)) this.marketed.add(phone)
    if (this.dryRun) { this.outcomes.push({ kind, phone, how: 'simulado', detail: summary }); this.sends++; return true }
    try {
      const id = await sendWhatsAppTemplate(phone, { name, language, params, ...(imageUrl ? { headerImageUrl: imageUrl } : {}) })
      if (chat) await recordOutbound(phone, { id: id ?? crypto.randomUUID(), sender: 'gem', text: summary, at: Date.now(), auto: kind })
      if (booking) await markBookingAuto(booking, kind)
      else if (chat) await markChatAuto(chat, kind)
      this.sends++
      this.outcomes.push({ kind, phone, how: 'plantilla' })
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (booking) await markBookingAuto(booking, `${kind}:error`)
      else if (chat) await markChatAuto(chat, `${kind}:error`)
      this.outcomes.push({ kind, phone, how: 'error', detail })
      return false
    }
  }
}

const imageChecks = new Map<string, boolean>()
/** La imagen del encabezado responde 200 en su URL pública (se revisa una vez por corrida del servidor). */
async function imageAvailable(url: string): Promise<boolean> {
  if (!imageChecks.has(url)) {
    const ok = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5_000) }).then((response) => response.ok).catch(() => false)
    imageChecks.set(url, ok)
  }
  return imageChecks.get(url)!
}

async function chatsByPhone(): Promise<Map<string, ChatSummary>> {
  const { inbox, archived } = await listChats()
  return new Map([...inbox, ...archived].map((chat) => [chat.phone, chat]))
}

/** Citas de un índice (holds por vencimiento, estado por fecha de inicio) en un rango de tiempo. */
async function bookingsBetween(key: string, from: number, to: number): Promise<Booking[]> {
  const ids = await redis().zrange<string[]>(key, from, to, { byScore: true })
  return getBookings(ids)
}

// ───────────────────────── Seguimiento del pago ─────────────────────────

/** ~30 min antes de que se libere un horario apartado sin pago: aviso y ayuda (ventana abierta). */
async function holdNudges(run: Run, chats: Map<string, ChatSummary>) {
  for (const booking of await bookingsBetween(keys.holds, run.now, run.now + 30 * MINUTE)) {
    if (!HOLD_STATUSES.includes(booking.status) || booking.paidAt || booking.autoSent.seguimiento_pago || !booking.phone) continue
    const chat = chats.get(booking.phone)
    if (!chat || humanHandling(chat) || !isWindowOpen(chat, run.now)) continue
    const minutes = Math.max(5, Math.round((booking.holdUntil - run.now) / MINUTE))
    const name = firstName(booking.name)
    await run.text(chat, 'seguimiento_pago',
      `Hola${name ? ` ${name}` : ''}, tu horario del ${dayLabel(booking.day)} a las ${clock12(booking.start)} en ${LOCATION_LABEL[booking.location]} sigue apartado ${minutes} minutos más y vi que el pago quedó pendiente${SEPARATOR}tuviste algún problema con el pago o prefieres que te ayude a cambiar el horario?`,
      booking)
  }
}

/** El horario se liberó sin pago hace más de 24 h y la sesión aún no pasa: plantilla anticipo_pendiente. */
async function expiredHoldTemplates(run: Run, chats: Map<string, ChatSummary>) {
  // Las citas canceladas están indexadas por fecha de la sesión: se miran las sesiones futuras.
  for (const booking of await bookingsBetween(keys.byStatus('cancelled'), run.now + 2 * HOUR, run.now + run.config.horizonDays * DAY)) {
    if (!booking.phone || booking.autoSent.anticipo_pendiente || booking.paidAt) continue
    const age = run.now - booking.createdAt
    if (age < DAY || age > 3 * DAY) continue
    const expired = await redis().hget<string>(keys.booking(booking.id), 'cancelReason')
    if (expired !== 'Anticipo no pagado a tiempo') continue
    const chat = chats.get(booking.phone)
    if (!chat || chat.noMarketing || humanHandling(chat) || isWindowOpen(chat, run.now)) continue
    if (await liveBookingOf(booking.phone)) continue
    await run.template(booking.phone, chat, 'anticipo_pendiente', 'anticipo_pendiente', { nombre_cliente: firstName(booking.name) || firstName(chat.name) || 'de nuevo' }, booking)
  }
}

// ───────────────────────── Recordatorios de la cita ─────────────────────────

/** 24 h antes de cada cita pagada: texto libre si la ventana está abierta, plantilla si no. */
async function dayBeforeReminders(run: Run, chats: Map<string, ChatSummary>) {
  for (const booking of await bookingsBetween(keys.byStatus('confirmed'), run.now + 3 * HOUR, run.now + DAY)) {
    if (!booking.phone || booking.kind === 'block' || booking.autoSent.recordatorio_cita) continue
    // Quien agenda con menos de 24 h de anticipación acaba de recibir la confirmación: no hace falta.
    if (booking.startTs - booking.createdAt < DAY) continue
    const chat = chats.get(booking.phone) ?? null
    if (chat && humanHandling(chat)) continue
    const name = firstName(booking.name) || firstName(chat?.name ?? '')
    if (chat && isWindowOpen(chat, run.now)) {
      await run.text(chat, 'recordatorio_cita',
        `Hola${name ? ` ${name}` : ''}, te recuerdo tu cita de ${serviceText(booking)} el ${fullDayLabel(booking.day)} a las ${clock12(booking.start)} en ${LOCATION_LABEL[booking.location]}${SEPARATOR}me confirmas que asistes?`,
        booking)
    } else {
      await run.template(booking.phone, chat, 'recordatorio_cita', 'recordatorio_cita', {
        nombre_cliente: name || 'de nuevo',
        fecha_cita: fullDayLabel(booking.day),
        hora_cita: templateClock(booking.start),
        sede: LOCATION_LABEL[booking.location],
      }, booking)
    }
  }
}

/** 2–3 h antes de una cita con la asistencia confirmada (solo con la ventana abierta). */
async function sameDayReminders(run: Run, chats: Map<string, ChatSummary>) {
  for (const booking of await bookingsBetween(keys.byStatus('confirmed'), run.now + 90 * MINUTE, run.now + 3 * HOUR)) {
    if (!booking.phone || !booking.attendanceConfirmedAt || booking.autoSent.recordatorio_hoy) continue
    const chat = chats.get(booking.phone)
    if (!chat || humanHandling(chat) || !isWindowOpen(chat, run.now)) continue
    const name = firstName(booking.name)
    const address = run.config.addresses[booking.location]
    await run.text(chat, 'recordatorio_hoy',
      `Hola${name ? ` ${name}` : ''}, hoy te esperamos a las ${clock12(booking.start)} en ${LOCATION_LABEL[booking.location]}${address ? ` (${address})` : ''}. Cualquier cambio me avisas por aquí`,
      booking)
  }
}

// ───────────────────────── Prospectos sin cita ─────────────────────────

/** ~22 h sin respuesta (la ventana sigue abierta): un último mensaje en texto libre. */
async function silentProspects(run: Run, chats: Map<string, ChatSummary>) {
  for (const chat of chats.values()) {
    const silence = run.now - chat.lastInboundAt
    if (!chat.lastInboundAt || silence < 22 * HOUR || silence > WHATSAPP_WINDOW_MS - 30 * MINUTE) continue
    if (chat.lastSender === 'user' || humanHandling(chat) || (chat.autoSent.seguimiento_22h ?? 0) > chat.lastInboundAt) continue
    if (await liveBookingOf(chat.phone)) continue
    const name = firstName(chat.name)
    await run.text(chat, 'seguimiento_22h',
      `Hola${name ? ` ${name}` : ''}, sigo por aquí. Si quieres, te dejo apartado un espacio en Chipichape o Unicentro para tu limpieza facial${SEPARATOR}cuál te queda mejor?`)
  }
}

/**
 * Entre 24 y 48 h sin escribir y sin cita: plantilla retomar_cita_limpieza (una vez por silencio).
 * Solo en ese rango porque el texto aprobado dice "Ayer hablamos de tu limpieza facial".
 */
async function reengageTemplates(run: Run, chats: Map<string, ChatSummary>) {
  for (const chat of chats.values()) {
    const silence = run.now - chat.lastInboundAt
    if (!chat.lastInboundAt || silence <= WHATSAPP_WINDOW_MS || silence > 2 * DAY) continue
    if (chat.noMarketing || humanHandling(chat) || (chat.autoSent.retomar_cita_limpieza ?? 0) > chat.lastInboundAt) continue
    // A quien se le venció un horario sin pagar le corresponde anticipo_pendiente, no esta.
    const [last] = await bookingsOfPhone(chat.phone, 1)
    if (last && (last.status !== 'cancelled' || last.createdAt > chat.lastInboundAt - DAY)) continue
    await run.template(chat.phone, chat, 'retomar_cita_limpieza', 'retomar_cita_limpieza', { nombre_cliente: firstName(chat.name) || 'de nuevo' })
  }
}

/**
 * Variable `oferta` de ultimos_dias_bono: es la FECHA de cierre en texto ("31 de octubre"), porque el
 * texto aprobado dice "el bono 2×1 para limpieza con Peeling Gel … está por terminar el {{oferta}}".
 */
export function offerText(until: string): string {
  const [, month, day] = until.split('-').map(Number)
  return `${day} de ${MONTH_NAME[month - 1]}`
}

/** El servicio de Peeling (el texto aprobado de ultimos_dias_bono habla solo de él). */
const PEELING_ID = 'peeling-hidratacion'

/**
 * 2–3 días antes de que venza el 2x1 del Peeling: plantilla ultimos_dias_bono a quien escribió y no
 * agendó. Solo para la fecha del Peeling: el texto aprobado nombra el Peeling Gel; si otro servicio
 * llegara a tener fecha de cierre, haría falta otra plantilla.
 */
async function lastDaysTemplates(run: Run, chats: Map<string, ChatSummary>) {
  const today = dayKey(run.now)
  const until = run.config.twoForOne[PEELING_ID]
  if (until) {
    const daysLeft = Math.round((Date.parse(`${until}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY)
    if (daysLeft < 2 || daysLeft > 3) return
    const oferta = offerText(until)
    const key = `ultimos_dias_bono:${until}`
    for (const chat of chats.values()) {
      if (!chat.lastInboundAt || run.now - chat.lastInboundAt > 30 * DAY || isWindowOpen(chat, run.now)) continue
      if (chat.noMarketing || humanHandling(chat) || chat.stage === 'booked' || chat.autoSent[key]) continue
      if (await liveBookingOf(chat.phone)) continue
      await run.template(chat.phone, chat, key, 'ultimos_dias_bono', { nombre_cliente: firstName(chat.name) || 'de nuevo', oferta })
    }
  }
}

/**
 * Una corrida del programador. `dryRun` decide a quién le tocaría qué, sin enviar ni marcar nada.
 * Un candado evita dos corridas a la vez (si el programador se solapa).
 */
export async function runAutomations({ now = Date.now(), dryRun = false } = {}): Promise<Outcome[]> {
  if (!automationsOn()) return [{ kind: 'todas', phone: '-', how: 'omitido', detail: 'automatizaciones apagadas (AUTOMATIONS=off)' }]
  const minute = minuteOfDay(now)
  if (minute < SEND_FROM_MIN || minute >= SEND_TO_MIN) return [{ kind: 'todas', phone: '-', how: 'omitido', detail: 'fuera del horario de envío (8:00 a 21:00)' }]
  if (!dryRun && !(await redis().set('pm:lock:automations', '1', { nx: true, ex: 300 }))) {
    return [{ kind: 'todas', phone: '-', how: 'omitido', detail: 'otra corrida en curso' }]
  }
  try {
    // Libera los apartados vencidos aunque nadie haya escrito (normalmente lo hace el tráfico).
    if (!dryRun) await sweepExpiredHolds(now, { force: true })
    const run = new Run(await getConfig(), now, dryRun)
    const chats = await chatsByPhone()
    // Primero lo más urgente (pagos y citas), al final el marketing: si se llega al tope, cae lo menos importante.
    await holdNudges(run, chats)
    await dayBeforeReminders(run, chats)
    await sameDayReminders(run, chats)
    await silentProspects(run, chats)
    await expiredHoldTemplates(run, chats)
    // Cerca del fin de una promo, el aviso de últimos días va antes que el genérico de retomar.
    await lastDaysTemplates(run, chats)
    await reengageTemplates(run, chats)
    return run.outcomes
  } finally {
    if (!dryRun) await redis().del('pm:lock:automations')
  }
}
