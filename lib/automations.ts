/**
 * Mensajes que Gema envía sola, sin que el cliente escriba: seguimientos y plantillas de WhatsApp.
 * Los dispara app/api/cron cada 10–15 minutos. Reglas acordadas con Premier (oct 2026):
 *
 * Texto libre (gratis, solo con la ventana de 24 h abierta):
 *   seguimiento_pago   ~4 h antes de que se libere una reserva sin anticipo (antes de las 9 p.m. si cae de noche)
 *   reserva_liberada   al liberarse una reserva sin anticipo (venció, o otro cliente tomó el horario renovado)
 *   seguimiento_45m    ~45 min sin respuesta tras la respuesta de Gema, sin cita: dos horas concretas
 *   seguimiento_3h     ~3 h sin respuesta, sin cita: el 2x1 vigente y la pregunta de sede
 *   seguimiento_22h    ~22 h después del último mensaje del cliente, si quedó sin responder y sin cita
 *   efectivo_retoma    30 min (en horario de asesoras) después de pasar a Johanna a quien quería pagar
 *                      todo en efectivo, si nadie del equipo le escribió: Gema retoma con el anticipo
 *                      y un horario concreto, y vuelve a atender el chat
 *   recordatorio_hoy   2–3 h antes de una cita con la asistencia confirmada, o de TODA cita en efectivo
 *                      (no pagó nada antes: es la que más riesgo tiene de no llegar). A las citas en
 *                      efectivo los dos recordatorios (día antes y 2 h) les llegan SIEMPRE con la
 *                      plantilla aprobada recordatorio_cita, con sus botones, aunque la ventana esté abierta
 *   recordatorio_cita  24 h antes de cada cita pagada (si la ventana está cerrada, va como plantilla)
 *
 * Plantillas (se cobran; solo con la ventana cerrada y si WHATSAPP_TEMPLATES=on):
 *   retomar_cita_limpieza  más de 24 h sin escribir, sin cita (marketing)
 *   anticipo_pendiente     el horario se liberó sin pago hace más de 24 h, el cliente ya había elegido cómo
 *                          pagar (link o transferencia) y la sesión aún no pasa (marketing). Nunca en efectivo
 *   ultimos_dias_bono      a los 5 días de silencio y en los 4 últimos días del 2x1, a quien escribió y no agendó (marketing)
 *   recordatorio_cita      24 h antes de la cita (utilidad)
 *
 * Nada se envía a chats que atiende una persona (Gema en pausa o pidiendo asesor), ni de noche, y
 * cada automatización queda registrada para no repetirse. Quien dijo "no me interesa", "ahora no" o
 * similar (lib/optout.ts) no recibe NADA automático hasta que agende o el operador lo reactive.
 *
 * Los textos de los seguimientos son los mensajes prediseñados del panel (lib/presets.ts).
 *
 * Además, a cualquier hora: mensajes de clientes que quedaron sin respuesta más de 5 min (una entrega
 * tardía de Meta, una caída del servidor) se vuelven a responder; si ya pasaron 24 h, pasan a una
 * persona. 20 oct: cinco chats del 18 y 19 recibieron la primera respuesta más de un día después.
 */
import { autoReply, markPendingReply, SAYS_WILL_CONFIRM } from './autoreply'
import { bookingsOfPhone, getBookings, HOLD_EXPIRED_REASON, HOLD_TAKEN_REASON, liveBookingOf, markBookingAuto, releaseHold, serviceText, suggestStarts, sweepExpiredHolds, teamBookingOf } from './booking'
import { beforeQuiet, clock12, dayKey, fullDayLabel, isQuietHours, NIGHT_REPLY_MAX_AGE_MS, nextHumanWindow } from './calendar'
import { ensureChatForBooking, getHistory, getSummary, listChats, markChatAuto, recordOutbound, requestAgent, updateChat } from './chats'
import { ESCALATION_HOURS, LOCATION_LABEL, LOCATIONS, MONTH_NAME } from './clinic'
import { depositOf, getConfig, pesos, serviceById } from './config'
import { firstName, renderPreset, whenText } from './presets'
import { keys, redis } from './redis'
import { SEPARATOR, toMessages } from './reply-style'
import { TEMPLATES, type TemplateName } from './template-catalog'
import { templateMessage } from './template-text'
import { HOLD_STATUSES, type AppConfig, type Booking, type ChatSummary, type Location } from './types'
import { sendWhatsAppTemplate, sendWhatsAppText } from './whatsapp'
import { isWindowOpen, WHATSAPP_WINDOW_MS } from './window'

export { firstName }

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Tope de envíos por corrida: si algo se descontrola, no sale una avalancha de mensajes. */
const MAX_SENDS_PER_RUN = 25
const MESSAGE_GAP_MS = 1_200

// Las plantillas aprobadas (idioma, imagen, botones) están en lib/template-catalog.ts.
export { TEMPLATES, type TemplateName }
/** Plantillas de categoría Marketing (se cobran más y respetan "Ahora no"); recordatorio_cita es Utility. */
const MARKETING = new Set<TemplateName>(['retomar_cita_limpieza', 'anticipo_pendiente', 'ultimos_dias_bono'])
const MARKETING_GAP_MS = 3 * 24 * 60 * 60_000

const templatesOn = () => process.env.WHATSAPP_TEMPLATES === 'on'
const automationsOn = () => process.env.AUTOMATIONS !== 'off'
const publicUrl = () => (process.env.PUBLIC_APP_URL || 'https://premier-agente.vercel.app').replace(/\/$/, '')

export type Outcome = { kind: string; phone: string; how: 'texto' | 'plantilla' | 'simulado' | 'omitido' | 'error'; detail?: string }

/** "10:00 a. m.": formato de hora de las plantillas. */
export const templateClock = (hhmm: string) => clock12(hhmm).replace('a.m.', 'a. m.').replace('p.m.', 'p. m.')

/**
 * Gema no le escribe sola: una persona atiende el chat, o el cliente dijo que no le interesa
 * (entonces no recibe ningún mensaje automático, para que no nos reporte como spam).
 */
const humanHandling = (chat: ChatSummary) => !chat.botActive || chat.needsAgent || chat.optedOut

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
      // Un cliente agendado desde el panel no tiene chat: se crea para que el recordatorio quede registrado
      // y visible, y para que su respuesta no se tome por la de un cliente nuevo.
      if (!chat && booking?.phone) await ensureChatForBooking(phone, booking)
      if (chat || booking?.phone) await recordOutbound(phone, await templateMessage(name, params, { id: id ?? crypto.randomUUID(), auto: kind }))
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

/** Citas de un índice (holds por vencimiento, estado por fecha de inicio) en un rango de tiempo. */
async function bookingsBetween(key: string, from: number, to: number): Promise<Booking[]> {
  const ids = await redis().zrange<string[]>(key, from, to, { byScore: true })
  return getBookings(ids)
}

// ───────────────────────── Seguimiento del pago ─────────────────────────

/** ~30 min antes de que se libere un horario apartado sin pago: aviso y ayuda (ventana abierta). */
async function holdNudges(run: Run, chats: Map<string, ChatSummary>) {
  // Las reservas que vencen en las próximas ~17 h: el aviso de una que vence a las 9 a.m. sale la noche anterior.
  for (const booking of await bookingsBetween(keys.holds, run.now, run.now + 17 * HOUR)) {
    if (!HOLD_STATUSES.includes(booking.status) || booking.paidAt || !booking.phone || booking.source !== 'bot') continue
    // Unas 4 h antes de que se libere (Premier, 23 oct); si eso cae de noche, antes de las 9 p.m.
    if (run.now < beforeQuiet(booking.holdUntil - REMINDER_BEFORE_MS) || booking.holdUntil - run.now < RELEASE_AHEAD_MS) continue
    const chat = chats.get(booking.phone)
    // Uno solo por cada plazo: si el cliente volvió a escribir (y la reserva se renovó), puede salir otro.
    if (!chat || (booking.autoSent.seguimiento_pago ?? 0) > chat.lastInboundAt) continue
    if (humanHandling(chat) || !isWindowOpen(chat, run.now)) continue
    // Un asesor ya le agendó la cita (y el cobro lo maneja el equipo): un apartado viejo de Gema no se cobra.
    if (await teamBookingOf(booking.phone)) continue
    const body = await renderPreset(run.config, 'followUpPayment', { chat, booking, now: run.now })
    if (body) await run.text(chat, 'seguimiento_pago', body, booking)
  }
}

/** El aviso del anticipo sale unas 4 h antes de que se libere la reserva. */
const REMINDER_BEFORE_MS = 4 * HOUR
/**
 * Una reserva se libera hasta 15 min antes de su plazo: el programador corre cada 10–15 min y el plazo es
 * 5 min antes de que se cierre la ventana de WhatsApp; así siempre alcanza a salir el aviso de liberación.
 */
const RELEASE_AHEAD_MS = 15 * MINUTE

/** Reservas sin anticipo que vencen antes de la próxima corrida: se liberan ya (el aviso lo manda releaseNotices). */
async function releaseDueHolds(run: Run) {
  if (run.dryRun) return
  for (const booking of await bookingsBetween(keys.holds, 0, run.now + RELEASE_AHEAD_MS)) {
    if (!HOLD_STATUSES.includes(booking.status) || booking.paidAt) continue
    await releaseHold(booking, HOLD_EXPIRED_REASON)
  }
}

/**
 * "Reserva liberada" (mensaje prediseñado): a quien se le liberó la reserva sin anticipo, porque venció o
 * porque otro cliente tomó el horario mientras estaba renovada. Una vez por reserva, con la ventana abierta.
 */
async function releaseNotices(run: Run, chats: Map<string, ChatSummary>) {
  // Las canceladas están indexadas por fecha de la sesión: se miran las sesiones futuras.
  const cancelled = await bookingsBetween(keys.byStatus('cancelled'), run.now, run.now + run.config.horizonDays * DAY)
  if (!cancelled.length) return
  const pipe = redis().pipeline()
  cancelled.forEach((booking) => pipe.hmget(keys.booking(booking.id), 'cancelReason', 'releasedAt'))
  // En un pipeline, Upstash devuelve hmget como lista ([motivo, momento]), no como objeto.
  const rows = await pipe.exec<Array<Array<string | null> | Record<string, string | null> | null>>()
  for (const [index, booking] of cancelled.entries()) {
    const row = rows[index]
    const [reason, released] = Array.isArray(row) ? row : [row?.cancelReason, row?.releasedAt]
    const releasedAt = Number(released ?? 0)
    if (reason !== HOLD_EXPIRED_REASON && reason !== HOLD_TAKEN_REASON) continue
    if (!releasedAt || run.now - releasedAt > DAY || booking.autoSent.reserva_liberada || booking.source !== 'bot' || !booking.phone) continue
    const chat = chats.get(booking.phone)
    if (!chat || chat.optedOut || !chat.botActive || !isWindowOpen(chat, run.now)) continue
    // Ya agendó otra cita (o pagó y se la recrearon): no hay nada que avisar.
    if (await liveBookingOf(booking.phone)) continue
    const body = await renderPreset(run.config, 'holdReleased', { chat, booking, now: run.now })
    if (body) await run.text(chat, 'reserva_liberada', body, booking)
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
    // En efectivo nunca llega aquí (esas citas no quedan apartadas). Y solo a quien ya eligió cómo pagar
    // el anticipo (pidió el link o recibió los datos para transferir): quien se quedó callado al
    // preguntarle cómo paga no dijo que lo iba a hacer, y para él está la plantilla de retomar.
    if (booking.paymentPlan === 'cash' || !(await choseHowToPay(booking))) continue
    const chat = chats.get(booking.phone)
    if (!chat || chat.noMarketing || humanHandling(chat) || isWindowOpen(chat, run.now)) continue
    if (await liveBookingOf(booking.phone)) continue
    await run.template(booking.phone, chat, 'anticipo_pendiente', 'anticipo_pendiente', { nombre_cliente: firstName(booking.name) || firstName(chat.name) || 'de nuevo' }, booking)
  }
}

/** El cliente eligió cómo pagar la cita: se le generó el link de Bold o se le enviaron los datos para transferir. */
async function choseHowToPay(booking: Booking): Promise<boolean> {
  if (booking.paymentLink) return true
  const history = await getHistory(booking.phone, 60)
  return history.some((message) => message.sender !== 'user' && message.at >= booking.createdAt && message.text.includes('Puedes transferir'))
}

// ───────────────────────── Recordatorios de la cita ─────────────────────────

/** 24 h antes de cada cita pagada: texto libre si la ventana está abierta, plantilla si no. */
async function dayBeforeReminders(run: Run, chats: Map<string, ChatSummary>) {
  for (const booking of await bookingsBetween(keys.byStatus('confirmed'), run.now + 3 * HOUR, run.now + DAY)) {
    if (!booking.phone || booking.kind === 'block' || booking.autoSent.recordatorio_cita) continue
    // Quien agenda con menos de 24 h de anticipación acaba de recibir la confirmación: no hace falta.
    if (booking.startTs - booking.createdAt < DAY) continue
    const chat = chats.get(booking.phone) ?? null
    if (chat && humanHandling(chat) && booking.source !== 'operator') continue
    const name = firstName(booking.name) || firstName(chat?.name ?? '')
    // En efectivo y en las citas que agendó un asesor siempre va la plantilla aprobada (con sus botones).
    if (chat && isWindowOpen(chat, run.now) && booking.paymentPlan !== 'cash' && booking.source !== 'operator') {
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
    // Efectivo y citas que agendó un asesor en el panel: no hay conversación previa con Gema (o no hay
    // ventana abierta), así que el recordatorio va siempre con la plantilla aprobada.
    const templated = booking.paymentPlan === 'cash' || booking.source === 'operator'
    if (!booking.phone || booking.autoSent.recordatorio_hoy || (!booking.attendanceConfirmedAt && !templated)) continue
    const chat = chats.get(booking.phone) ?? null
    // Un asesor que atiende el chat no frena el recordatorio de una cita que él mismo agendó.
    if (chat && humanHandling(chat) && booking.source !== 'operator') continue
    const name = firstName(booking.name)
    if (templated) {
      // Siempre la plantilla aprobada recordatorio_cita (utilidad, ≈ COP 3), con fecha "hoy".
      await run.template(booking.phone, chat, 'recordatorio_hoy', 'recordatorio_cita', {
        nombre_cliente: name || 'de nuevo',
        fecha_cita: 'hoy',
        hora_cita: templateClock(booking.start),
        sede: LOCATION_LABEL[booking.location],
      }, booking)
    } else if (chat && isWindowOpen(chat, run.now)) {
      const address = run.config.addresses[booking.location]
      await run.text(chat, 'recordatorio_hoy',
        `Hola${name ? ` ${name}` : ''}, hoy te esperamos a las ${clock12(booking.start)} en ${LOCATION_LABEL[booking.location]}${address ? ` (${address})` : ''}. Cualquier cambio me avisas por aquí`,
        booking)
    }
  }
}

// ───────────────────────── Prospectos sin cita ─────────────────────────

/** ~22 h sin respuesta (la ventana sigue abierta): un último mensaje en texto libre. */
async function silentProspects(run: Run, chats: Map<string, ChatSummary>) {
  for (const chat of chats.values()) {
    const silence = run.now - chat.lastInboundAt
    if (!chat.lastInboundAt || silence < 22 * HOUR || silence > WHATSAPP_WINDOW_MS - 30 * MINUTE) continue
    if (chat.lastSender === 'user' || humanHandling(chat) || (chat.autoSent.seguimiento_22h ?? 0) > chat.lastInboundAt) continue
    if ((await liveBookingOf(chat.phone)) || (await teamBookingOf(chat.phone))) continue
    const body = await renderPreset(run.config, 'followUp22h', { chat, now: run.now })
    if (body) await run.text(chat, 'seguimiento_22h', body)
  }
}

/**
 * Horas concretas libres de verdad: dos en la sede que eligió el cliente o, si todavía no la dijo, la
 * primera de cada sede. Texto vacío si no hay ninguna (entonces el seguimiento no se envía).
 */
async function hoursOffer(run: Run, location: Location | ''): Promise<{ text: string; location: Location | '' }> {
  if (location) {
    const options = await suggestStarts(run.config, location, { now: run.now })
    return { text: options.length ? `en ${LOCATION_LABEL[location]} tengo ${options.map((option) => whenText(run.now, option)).join(' o ')}` : '', location }
  }
  const firsts: Array<{ sede: Location; when: string }> = []
  for (const sede of LOCATIONS) {
    const [first] = await suggestStarts(run.config, sede, { now: run.now, count: 1 })
    if (first) firsts.push({ sede, when: whenText(run.now, first) })
  }
  if (!firsts.length) return { text: '', location: '' }
  // La misma hora en las dos sedes se dice una vez: "hoy a las 5:00 p.m. en Unicentro o en Chipichape".
  if (firsts.length > 1 && firsts.every((item) => item.when === firsts[0].when)) {
    return { text: `tengo espacio ${firsts[0].when} en ${firsts.map((item) => LOCATION_LABEL[item.sede]).join(' o en ')}`, location: '' }
  }
  return { text: `tengo espacio ${firsts.map((item) => `en ${LOCATION_LABEL[item.sede]} ${item.when}`).join(' y ')}`, location: '' }
}

/** El cliente no contestó desde la última respuesta de Gema y no tiene cita: candidato a seguimiento. */
/** Tiempo mínimo entre dos envíos del mismo seguimiento al mismo cliente. */
const FOLLOW_UP_REPEAT_MS = 20 * HOUR

async function waitingProspect(chat: ChatSummary, run: Run, kind: string, fromMs: number, toMs: number): Promise<boolean> {
  const silence = run.now - chat.lastInboundAt
  if (!chat.lastInboundAt || silence < fromMs || silence >= toMs || !isWindowOpen(chat, run.now)) return false
  if (chat.lastSender !== 'gem' || humanHandling(chat) || (chat.autoSent[kind] ?? 0) > chat.lastInboundAt) return false
  // Cada seguimiento, máximo una vez cada 20 h: en una conversación de ida y vuelta le llegaba el mismo
  // mensaje después de cada respuesta (a Luz Mina, el de 45 min tres veces el 21 oct).
  if (run.now - (chat.autoSent[kind] ?? 0) < FOLLOW_UP_REPEAT_MS) return false
  // Un cliente del equipo no es prospecto aunque ya haya pasado la hora de su cita (ver teamBookingOf).
  return !(await liveBookingOf(chat.phone)) && !(await teamBookingOf(chat.phone))
}

/**
 * Seguimientos dentro de la ventana de 24 h (gratis). La mitad de los chats dejaba de responder
 * después de la primera respuesta (VIRAND, 19 oct). Cada uno trae algo nuevo, con los textos del
 * panel: a los 45 min el ritual de 5 pasos y una hora concreta; a las 3 h la limpieza cero invasiva
 * y el 2x1 vigente con la pregunta de sede.
 */
async function earlyFollowUps(run: Run, chats: Map<string, ChatSummary>) {
  for (const chat of chats.values()) {
    const due45 = await waitingProspect(chat, run, 'seguimiento_45m', 40 * MINUTE, 3 * HOUR)
    const due3h = !due45 && await waitingProspect(chat, run, 'seguimiento_3h', 3 * HOUR, 22 * HOUR)
    if (!due45 && !due3h) continue
    // Dijo que consulta y avisa ("le pregunto a mi acompañante y te aviso", "deme unos minutos"): solo le
    // queda el de 22 h (Premier, 23 oct; a Marina le llegó el de 45 min a los 49 minutos de decirlo).
    const [lastClient] = (await getHistory(chat.phone, 12)).filter((message) => message.sender === 'user').slice(-1)
    if (lastClient && SAYS_WILL_CONFIRM.test(lastClient.text)) continue
    if (due45) {
      // Sin ninguna hora libre que ofrecer, este seguimiento no sale (renderPreset devuelve null).
      const body = await renderPreset(run.config, 'followUp45', { chat, now: run.now })
      if (body) await run.text(chat, 'seguimiento_45m', body)
      continue
    }
    const body = await renderPreset(run.config, 'followUp3h', { chat, now: run.now })
    if (body) await run.text(chat, 'seguimiento_3h', body)
  }
}

/** Minutos de horario de asesoras transcurridos entre dos momentos (de 5 en 5). */
function humanMinutesBetween(from: number, to: number): number {
  let minutes = 0
  for (let at = from; at < to && minutes < 24 * 60; at += 5 * MINUTE) if (nextHumanWindow(ESCALATION_HOURS, at) === 'ahora') minutes += 5
  return minutes
}

/**
 * Quien quería pagar todo en efectivo se pasó a Johanna ([[EFECTIVO]] en lib/autoreply.ts). Si en 30
 * minutos de horario de asesoras nadie del equipo le escribió, Gema retoma con la opción estándar y
 * un horario concreto, y vuelve a atender el chat (decisión de Premier, 20 oct).
 */
async function cashRetakes(run: Run, chats: Map<string, ChatSummary>) {
  for (const chat of chats.values()) {
    if (!chat.needsAgent || !/^pago en efectivo/i.test(chat.agentReason) || !chat.agentAt) continue
    if ((chat.autoSent.efectivo_retoma ?? 0) > chat.agentAt || !isWindowOpen(chat, run.now)) continue
    if (chat.lastSender === 'human' && chat.lastAt > chat.agentAt) continue // Johanna ya le escribió
    if (humanMinutesBetween(chat.agentAt, run.now) < 30) continue
    if ((await liveBookingOf(chat.phone)) || (await teamBookingOf(chat.phone))) continue
    const offer = await hoursOffer(run, chat.lead.location)
    if (!offer.text) continue
    const service = chat.lead.serviceId ? serviceById(run.config, chat.lead.serviceId) : undefined
    const deposit = service ? depositOf(run.config, service.price) : run.config.depositFixed ? pesos(run.config.depositFixed) : ''
    const name = firstName(chat.name)
    const sent = await run.text(chat, 'efectivo_retoma', [
      `${name ? `${name}, ` : ''}todavía no me confirman lo del pago sin anticipo`,
      `para que no pierdas el cupo, ${offer.text}, y se separa con el anticipo${deposit ? ` de ${deposit}` : ''}, que se descuenta del valor de tu limpieza. El resto lo pagas en la sede en efectivo o como prefieras`,
      offer.location ? 'te lo separo?' : 'cuál te queda mejor?',
    ].join(SEPARATOR))
    // Gema vuelve a atender el chat: la respuesta del cliente la contesta ella.
    if (sent && !run.dryRun) await updateChat(chat.phone, { botActive: true })
  }
}

/** La plantilla de retomar sale al menos 20 h después del último seguimiento automático. */
const TEMPLATE_AFTER_FOLLOW_UP_MS = 20 * HOUR

/** Alertas que puso el propio sistema por un mensaje sin responder: la plantilla las resuelve, no hay que esperar a una persona. */
const UNANSWERED_REASON = /^Mensaje (sin responder|que llegó con más de 24 h)/

/**
 * Más de 24 h sin escribir y sin cita: plantilla retomar_cita_limpieza (una vez por silencio).
 * Hasta 48 h si Gema ya conversó con el cliente (el texto aprobado dice "Ayer hablamos de tu limpieza
 * facial"). Hasta 7 días si NADIE le respondió su último mensaje (entrega tardía, caída): es la única
 * forma de escribirle y, sin esto, quedaría sin respuesta para siempre. Esos chats se atienden aunque
 * el sistema los haya marcado "Requiere asesor" por la demora; el cliente que dijo "no me interesa" no.
 */
async function reengageTemplates(run: Run, chats: Map<string, ChatSummary>) {
  for (const chat of chats.values()) {
    const silence = run.now - chat.lastInboundAt
    const unanswered = chat.lastSender === 'user'
    if (!chat.lastInboundAt || silence <= WHATSAPP_WINDOW_MS || silence > (unanswered ? 7 : 2) * DAY) continue
    const systemFlag = chat.needsAgent && UNANSWERED_REASON.test(chat.agentReason)
    // Una alerta del propio sistema pausa a Gema (requestAgent): eso no debe frenar esta plantilla, que es
    // justo lo que la alerta pide. Una pausa que puso una persona, sí.
    if (chat.noMarketing || chat.optedOut || (!chat.botActive && !systemFlag) || (chat.needsAgent && !systemFlag) || (chat.autoSent.retomar_cita_limpieza ?? 0) > chat.lastInboundAt) continue
    // Al menos 20 h después del último seguimiento: a L. Ruiz le llegaron el de 22 h y esta plantilla con
    // dos horas de diferencia (23 oct), tres mensajes sin respuesta en menos de un día.
    const lastFollowUp = Math.max(0, ...Object.entries(chat.autoSent).filter(([kind]) => kind.startsWith('seguimiento_')).map(([, at]) => at))
    if (run.now - lastFollowUp < TEMPLATE_AFTER_FOLLOW_UP_MS) continue
    // A quien se le venció un horario sin pagar le corresponde anticipo_pendiente, no esta.
    const [last] = await bookingsOfPhone(chat.phone, 1)
    if (last && (last.status !== 'cancelled' || last.createdAt > chat.lastInboundAt - DAY)) continue
    const sent = await run.template(chat.phone, chat, 'retomar_cita_limpieza', 'retomar_cita_limpieza', { nombre_cliente: firstName(chat.name) || 'de nuevo' })
    // Ya se le escribió: la alerta automática de "sin responder" deja de hacer falta.
    // Ya se le escribió: se quita la alerta y Gema vuelve a atender, para responder cuando el cliente conteste.
    if (sent && systemFlag && !run.dryRun) await updateChat(chat.phone, { needsAgent: false, botActive: true })
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
export const PEELING_ID = 'peeling-hidratacion'

/** Días de silencio después de los que se recuerda que el 2x1 del Peeling tiene fecha de cierre. */
const BONUS_AFTER_SILENCE_DAYS = 5
/** Días finales del 2x1 en que se le recuerda a todos los que preguntaron (del 27 al 31 si cierra el 31). */
const BONUS_FINAL_DAYS = 4

/**
 * Plantilla ultimos_dias_bono, mientras el 2x1 del Peeling siga vigente, a quien preguntó y no agendó
 * (decisión de Premier, 20 oct 2026):
 *   - a los 5 días de su último mensaje, una vez por promoción;
 *   - en los últimos días (del 27 al 31 de octubre con cierre el 31), una vez más, a todos los que
 *     escribieron en los últimos 30 días.
 * El tope de una plantilla de marketing cada 3 días por persona sigue valiendo. Solo para la fecha del
 * Peeling: el texto aprobado nombra el Peeling Gel; otro servicio con fecha necesitaría otra plantilla.
 */
async function lastDaysTemplates(run: Run, chats: Map<string, ChatSummary>) {
  const today = dayKey(run.now)
  const until = run.config.twoForOne[PEELING_ID]
  if (!until || until < today) return
  const daysLeft = Math.round((Date.parse(`${until}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY)
  const finalDays = daysLeft <= BONUS_FINAL_DAYS
  const oferta = offerText(until)
  const silenceKey = `ultimos_dias_bono:5d:${until}`
  const finalKey = `ultimos_dias_bono:${until}`
  for (const chat of chats.values()) {
    const silence = run.now - chat.lastInboundAt
    if (!chat.lastInboundAt || silence > 30 * DAY || isWindowOpen(chat, run.now)) continue
    if (chat.noMarketing || humanHandling(chat) || chat.stage === 'booked') continue
    // En los días finales va el aviso final; antes, el de los 5 días de silencio.
    const key = finalDays ? finalKey : silenceKey
    if (chat.autoSent[key] || (!finalDays && silence < BONUS_AFTER_SILENCE_DAYS * DAY)) continue
    if ((await liveBookingOf(chat.phone)) || (await teamBookingOf(chat.phone))) continue
    await run.template(chat.phone, chat, key, 'ultimos_dias_bono', { nombre_cliente: firstName(chat.name) || 'de nuevo', oferta })
  }
}

// ───────────────────────── Mensajes sin respuesta ─────────────────────────

/** Un mensaje del cliente que sigue sin respuesta pasado este tiempo se vuelve a atender. */
const UNANSWERED_AFTER_MS = 5 * MINUTE
/** Cuántos chats se reprocesan por corrida (cada uno es un turno de IA dentro del límite de 60 s). */
const MAX_REANSWERS = 3

/**
 * Chats cuyo último mensaje es del cliente, con Gema activa, y que nadie respondió en 5 min: una
 * entrega tardía de Meta, un corte del servidor a mitad de la respuesta o un error pasajero. Con la
 * ventana abierta Gema responde ahora (y se disculpa por la demora); con la ventana cerrada ya solo
 * cabe una plantilla, así que el chat pasa a una persona. Corre a cualquier hora: Gema atiende 24/7.
 *
 * Lee el índice `awaiting` (lib/chats.ts), no la bandeja entera: lo normal es que esté vacío y la
 * revisión cueste un solo comando de Upstash por corrida.
 */
async function answerPending(now: number, dryRun: boolean): Promise<Outcome[]> {
  const db = redis()
  // La primera vez se llena con los chats que ya esperaban respuesta antes de que existiera el índice.
  if (!dryRun && !(await db.exists(keys.awaitingSeeded))) {
    const { inbox } = await listChats()
    const waiting = inbox.filter((chat) => chat.lastSender === 'user' && chat.lastInboundAt > 0)
    const tx = db.multi()
    for (const chat of waiting) tx.zadd(keys.awaiting, { score: chat.lastInboundAt, member: chat.phone })
    tx.set(keys.awaitingSeeded, String(now))
    await tx.exec()
  }
  // De noche solo se atiende lo reciente: un mensaje viejo sin responder espera a las 8 a.m.
  const quiet = isQuietHours(now)
  const phones = await db.zrange<string[]>(keys.awaiting, quiet ? now - NIGHT_REPLY_MAX_AGE_MS : 0, now - UNANSWERED_AFTER_MS, { byScore: true })
  const outcomes: Outcome[] = []
  const toAnswer: string[] = []
  // Sale del índice lo que no le toca a Gema: si el cliente vuelve a escribir, entra de nuevo.
  const drop = (phone: string) => (dryRun ? null : db.zrem(keys.awaiting, phone))
  for (const phone of phones) {
    if (toAnswer.length >= MAX_REANSWERS) break
    const chat = await getSummary(phone)
    if (!chat || chat.lastSender !== 'user' || now - chat.lastInboundAt > 7 * DAY) { await drop(phone); continue }
    // Lo atiende una persona (Gema en pausa o con alerta): ya está a la vista en el panel.
    if (!chat.botActive || chat.needsAgent) { await drop(phone); continue }
    // Stickers, reacciones o ubicaciones sueltas no se responden: no es un olvido.
    const [last] = await getHistory(phone, 1)
    if (!last || last.sender !== 'user' || (!last.media && /^\[[^\]]+\]$/.test(last.text.trim()))) { await drop(phone); continue }
    // Gema está respondiendo ese chat en este momento.
    if (await db.exists(keys.replyLock(phone))) continue
    if (!isWindowOpen(chat, now)) {
      // Ventana cerrada: solo cabe una plantilla y la envía reengageTemplates en esta misma corrida. Solo
      // se avisa a una persona si esa plantilla no va a salir (apagadas, o dijo "ahora no").
      const templateWillGo = templatesOn() && !chat.noMarketing && !chat.optedOut
      if (!dryRun) {
        if (!templateWillGo && !chat.optedOut) await requestAgent(phone, 'Mensaje sin responder y ya pasaron 24 h: solo se le puede escribir con una plantilla')
        await drop(phone)
      }
      outcomes.push({ kind: 'sin_respuesta', phone, how: 'omitido', detail: templateWillGo ? 'ventana cerrada: le sale la plantilla de retomar' : 'ventana cerrada: pasa a una asesora' })
      continue
    }
    toAnswer.push(phone)
  }
  if (dryRun) return [...outcomes, ...toAnswer.map((phone): Outcome => ({ kind: 'sin_respuesta', phone, how: 'simulado', detail: 'Gema respondería ahora' }))]
  // En paralelo: cada turno de IA tarda varios segundos y la corrida tiene 60 s en total.
  const results = await Promise.all(toAnswer.map(async (phone): Promise<Outcome> => {
    try {
      console.warn(`[cron] ${phone}: mensaje sin respuesta hace más de 5 min; Gema lo atiende ahora`)
      await markPendingReply(phone)
      await autoReply(phone)
      return { kind: 'sin_respuesta', phone, how: 'texto', detail: 'respuesta tardía' }
    } catch (error) {
      return { kind: 'sin_respuesta', phone, how: 'error', detail: error instanceof Error ? error.message : String(error) }
    }
  }))
  return [...outcomes, ...results]
}

/**
 * Una corrida del programador. `dryRun` decide a quién le tocaría qué, sin enviar ni marcar nada.
 * Un candado evita dos corridas a la vez (si el programador se solapa).
 */
export async function runAutomations({ now = Date.now(), dryRun = false } = {}): Promise<Outcome[]> {
  if (!automationsOn()) return [{ kind: 'todas', phone: '-', how: 'omitido', detail: 'automatizaciones apagadas (AUTOMATIONS=off)' }]
  // Responder a quien escribió no es un mensaje automático: va a cualquier hora, antes que todo.
  const pending = await answerPending(now, dryRun).catch((error): Outcome[] => [{ kind: 'sin_respuesta', phone: '-', how: 'error', detail: error instanceof Error ? error.message : String(error) }])
  // Franja de silencio (9 p.m. a 8 a.m.): nada automático. Ver isQuietHours en lib/calendar.ts.
  if (isQuietHours(now)) return [...pending, { kind: 'todas', phone: '-', how: 'omitido', detail: 'fuera del horario de envío (8:00 a 21:00)' }]
  if (!dryRun && !(await redis().set(keys.automationsLock, '1', { nx: true, ex: 300 }))) {
    return [...pending, { kind: 'todas', phone: '-', how: 'omitido', detail: 'otra corrida en curso' }]
  }
  try {
    // Libera los apartados vencidos aunque nadie haya escrito (normalmente lo hace el tráfico).
    const run = new Run(await getConfig(), now, dryRun)
    // Las reservas sin anticipo que vencen antes de la próxima corrida se liberan ya, con la ventana todavía
    // abierta para avisarle al cliente (releaseNotices, más abajo).
    await releaseDueHolds(run)
    if (!dryRun) await sweepExpiredHolds(now, { force: true })
    // La bandeja se lee UNA vez por corrida (~40 comandos) y la usan todas las automatizaciones.
    const lists = await listChats()
    const chats = new Map([...lists.inbox, ...lists.archived].map((chat) => [chat.phone, chat]))
    // Primero lo más urgente (pagos y citas), al final el marketing: si se llega al tope, cae lo menos importante.
    await releaseNotices(run, chats)
    await holdNudges(run, chats)
    await cashRetakes(run, chats)
    await dayBeforeReminders(run, chats)
    await sameDayReminders(run, chats)
    await earlyFollowUps(run, chats)
    await silentProspects(run, chats)
    await expiredHoldTemplates(run, chats)
    // Cerca del fin de una promo, el aviso de últimos días va antes que el genérico de retomar.
    await lastDaysTemplates(run, chats)
    await reengageTemplates(run, chats)
    return [...pending, ...run.outcomes]
  } finally {
    if (!dryRun) await redis().del(keys.automationsLock)
  }
}
