import { parseAutoSent } from './booking'
import { isLocation } from './clinic'
import { attachMediaInfo } from './media'
import { previewOf } from './media-text'
import { countryOf, regionOf } from './phone'
import { keys, redis, toHash } from './redis'
import { bumpRev, queueRev } from './revision'
import { queueStat } from './stats'
import type { AgentKind, Box, ChatDetail, ChatLists, ChatPatch, ChatSummary, Lead, Location, Message, Sender } from './types'

const HISTORY_LIMIT = 500
const DETAIL_MESSAGES = 200
const LIST_LIMIT = 200

function toSummary(phone: string, raw: Record<string, string>): ChatSummary {
  return {
    phone,
    name: raw.name ?? '',
    country: countryOf(phone),
    region: regionOf(phone),
    stage: raw.stage === 'booked' ? 'booked' : 'open',
    archived: raw.archived === '1',
    botActive: raw.botActive !== '0',
    needsAgent: raw.needsAgent === '1',
    agentKind: raw.agentKind === 'payment' ? 'payment' : 'help',
    agentReason: raw.agentReason ?? '',
    agentAt: Number(raw.agentAt ?? 0),
    unread: Number(raw.unread ?? 0),
    lastMessage: raw.lastMessage ?? '',
    lastSender: (raw.lastSender as Sender) ?? 'user',
    lastAt: Number(raw.lastAt ?? 0),
    lastInboundAt: Number(raw.lastInboundAt ?? 0),
    lastImageAt: Number(raw.lastImageAt ?? 0),
    createdAt: Number(raw.createdAt ?? 0),
    lead: {
      concern: raw.leadConcern ?? '',
      serviceId: raw.leadService ?? '',
      location: isLocation(raw.leadLocation) ? raw.leadLocation : '',
    },
    bookingId: raw.bookingId ?? '',
    paymentNotice: raw.paymentNotice ?? '',
    paymentNoticeAt: Number(raw.paymentNoticeAt ?? 0),
    noMarketing: raw.noMarketing === '1',
    contactPhone: raw.contactPhone ?? '',
    optedOut: raw.optedOut === '1',
    optedOutAt: Number(raw.optedOutAt ?? 0),
    optedOutText: raw.optedOutText ?? '',
    adSourceId: raw.adSourceId ?? '',
    adHeadline: raw.adHeadline ?? '',
    ctwaClid: raw.ctwaClid ?? '',
    ctwaAt: Number(raw.ctwaAt ?? 0),
    autoSent: parseAutoSent(raw.autoSent),
    objection: raw.objection ?? '',
    capiStatus: raw.capiStatus ?? '',
  }
}

function parseMessages(items: string[]): Message[] {
  return items.flatMap((item) => {
    try { return [JSON.parse(item) as Message] } catch { return [] }
  })
}

export async function getSummary(phone: string): Promise<ChatSummary | null> {
  const hash = toHash(await redis().hgetall(keys.chat(phone)))
  return hash ? toSummary(phone, hash) : null
}

export async function listChats(): Promise<ChatLists> {
  const db = redis()
  const [inbox, archived] = await Promise.all((['inbox', 'archived'] as Box[]).map(async (box) => {
    const phones = await db.zrange<string[]>(keys.box(box), 0, LIST_LIMIT - 1, { rev: true })
    if (!phones.length) return []
    const pipe = db.pipeline()
    phones.forEach((phone) => pipe.hgetall(keys.chat(phone)))
    const rows = await pipe.exec<unknown[]>()
    return phones.flatMap((phone, index) => {
      const hash = toHash(rows[index])
      return hash ? [toSummary(phone, hash)] : []
    })
  }))
  return { inbox, archived }
}

/** Devuelve el chat con sus últimos mensajes y lo marca como leído. */
export async function getChat(phone: string): Promise<ChatDetail | null> {
  const db = redis()
  const summary = await getSummary(phone)
  if (!summary) return null
  const [items] = await Promise.all([
    db.lrange<string>(keys.messages(phone), -DETAIL_MESSAGES, -1),
    summary.unread ? db.hset(keys.chat(phone), { unread: '0' }) : null,
  ])
  return { ...summary, unread: 0, messages: await attachMediaInfo(parseMessages(items)) }
}

export async function getHistory(phone: string, count: number): Promise<Message[]> {
  return attachMediaInfo(parseMessages(await redis().lrange<string>(keys.messages(phone), -count, -1)))
}

/** Mensaje entrante de WhatsApp. Crea el chat si no existe y lo devuelve a la bandeja si estaba archivado. */
export async function recordInbound(phone: string, message: Message, name?: string) {
  const db = redis()
  const chatKey = keys.chat(phone)
  const isNew = !(await db.exists(chatKey))
  const tx = db.multi()
  tx.hsetnx(chatKey, 'createdAt', String(message.at))
  tx.hsetnx(chatKey, 'botActive', '1')
  tx.hsetnx(chatKey, 'stage', 'open')
  tx.hset(chatKey, {
    ...(name ? { name } : {}),
    archived: '0',
    lastMessage: previewOf(message),
    lastSender: 'user',
    lastAt: String(message.at),
    lastInboundAt: String(message.at),
    ...(message.media?.kind === 'image' ? { lastImageAt: String(message.at) } : {}),
  })
  // Atribución: el anuncio con el que llegó por primera vez (no se pisa si vuelve desde otro).
  if (message.ad?.sourceId) tx.hsetnx(chatKey, 'adSourceId', message.ad.sourceId)
  if (message.ad?.headline) tx.hsetnx(chatKey, 'adHeadline', message.ad.headline)
  if (message.ad?.ctwaClid) {
    tx.hsetnx(chatKey, 'ctwaClid', message.ad.ctwaClid)
    tx.hsetnx(chatKey, 'ctwaAt', String(message.at))
  }
  tx.hincrby(chatKey, 'unread', 1)
  tx.rpush(keys.messages(phone), JSON.stringify(message))
  tx.ltrim(keys.messages(phone), -HISTORY_LIMIT, -1)
  tx.zrem(keys.box('archived'), phone)
  tx.zadd(keys.box('inbox'), { score: message.at, member: phone })
  queueStat(tx, 'inbound')
  if (isNew) queueStat(tx, 'newChats')
  queueRev(tx, 'chats')
  // Queda esperando respuesta hasta que Gema o una persona le escriba (vigilante de lib/automations.ts).
  tx.zadd(keys.awaiting, { score: message.at, member: phone })
  await tx.exec()
}

/** Mensaje saliente (IA o humano). Un envío humano pausa la IA y da por atendida la solicitud de asesor. */
export async function recordOutbound(phone: string, message: Message) {
  const db = redis()
  const chatKey = keys.chat(phone)
  const tx = db.multi()
  tx.hset(chatKey, {
    lastMessage: message.text,
    lastSender: message.sender,
    lastAt: String(message.at),
    ...(message.sender === 'human' ? { botActive: '0', needsAgent: '0' } : {}),
  })
  tx.rpush(keys.messages(phone), JSON.stringify(message))
  tx.ltrim(keys.messages(phone), -HISTORY_LIMIT, -1)
  tx.zadd(keys.box('inbox'), { xx: true }, { score: message.at, member: phone })
  tx.zadd(keys.box('archived'), { xx: true }, { score: message.at, member: phone })
  queueStat(tx, message.sender === 'gem' ? 'aiReplies' : 'humanReplies')
  queueRev(tx, 'chats')
  tx.zrem(keys.awaiting, phone)
  await tx.exec()
}

/** Tocó "Ahora no" en una plantilla de marketing: no se le vuelven a enviar plantillas de marketing. */
export async function setNoMarketing(phone: string): Promise<void> {
  await redis().hset(keys.chat(phone), { noMarketing: '1' })
  await bumpRev('chats')
}

/** Celular que dio un cliente con número oculto: queda en el chat y en su cita viva. */
export async function saveContactPhone(phone: string, contact: string): Promise<void> {
  await redis().hset(keys.chat(phone), { contactPhone: contact })
  await bumpRev('chats')
}

/**
 * Dijo "no me interesa", "ahora no" o similar: se detienen TODOS sus mensajes automáticos (también las
 * plantillas de marketing). Vuelven solo si agenda (attachBooking) o si el operador lo reactiva.
 */
export async function setOptOut(phone: string, text: string): Promise<void> {
  await redis().hset(keys.chat(phone), { optedOut: '1', optedOutAt: String(Date.now()), optedOutText: text.trim().slice(0, 120), noMarketing: '1' })
  await bumpRev('chats')
}

/** La primera objeción que frenó la venta queda en el chat ("efectivo"), para medir cuántos caen ahí. */
export async function setObjection(phone: string, objection: string): Promise<void> {
  if (await redis().hsetnx(keys.chat(phone), 'objection', objection)) await bumpRev('chats')
}

/** Estado del último evento de conversión enviado a Meta, para auditarlo desde el panel. */
export async function setCapiStatus(phone: string, status: { event: string; ok: boolean; reason?: string; at: number }): Promise<void> {
  if (await redis().exists(keys.chat(phone))) {
    await redis().hset(keys.chat(phone), { capiStatus: JSON.stringify(status) })
    await bumpRev('chats')
  }
}

/** Deja constancia de que una automatización ya se envió a este chat (no se repite). */
export async function markChatAuto(chat: Pick<ChatSummary, 'phone'>, kind: string): Promise<void> {
  // Se lee el registro actual (no el de la corrida) para no pisar otra marca hecha en la misma corrida.
  const current = parseAutoSent(await redis().hget<string>(keys.chat(chat.phone), 'autoSent') ?? undefined)
  await redis().hset(keys.chat(chat.phone), { autoSent: JSON.stringify({ ...current, [kind]: Date.now() }) })
  await bumpRev('chats')
}

/** Guarda lo que Gema averiguó del prospecto. Solo escribe los campos que traen valor nuevo. */
export async function saveLead(phone: string, lead: Partial<Lead>) {
  const patch: Record<string, string> = {}
  if (lead.concern) patch.leadConcern = lead.concern.slice(0, 300)
  if (lead.serviceId) patch.leadService = lead.serviceId.slice(0, 40)
  if (lead.location && isLocation(lead.location)) patch.leadLocation = lead.location
  if (!Object.keys(patch).length) return
  await redis().hset(keys.chat(phone), patch)
  await bumpRev('chats')
}

/** El chat produjo una cita: queda enlazada y el chat pasa a "agendado" (cuenta en las métricas). */
export async function attachBooking(phone: string, bookingId: string, lead: Partial<Lead> & { name?: string }) {
  const db = redis()
  const current = await getSummary(phone)
  const tx = db.multi()
  // Agendó: vuelve a recibir lo automático de su cita (recordatorios), aunque antes dijera "ahora no".
  if (current?.optedOut) tx.hdel(keys.chat(phone), 'optedOut', 'optedOutAt', 'optedOutText')
  tx.hset(keys.chat(phone), {
    bookingId,
    ...(lead.name ? { name: lead.name } : {}),
    ...(lead.serviceId ? { leadService: lead.serviceId } : {}),
    ...(lead.location && isLocation(lead.location) ? { leadLocation: lead.location as Location } : {}),
  })
  if (current?.stage !== 'booked') {
    const bookedAt = Date.now()
    tx.hset(keys.chat(phone), { stage: 'booked', bookedAt: String(bookedAt) })
    queueStat(tx, 'booked', 1, bookedAt)
  }
  queueRev(tx, 'chats')
  await tx.exec()
}

export async function updateChat(phone: string, patch: ChatPatch): Promise<ChatSummary | null> {
  const db = redis()
  const chatKey = keys.chat(phone)
  const current = await getSummary(phone)
  if (!current) return null

  const botChanged = patch.botActive !== undefined && patch.botActive !== current.botActive
  const stageChanged = patch.stage !== undefined && patch.stage !== current.stage
  const archiveChanged = patch.archived !== undefined && patch.archived !== current.archived
  const optInChanged = patch.optedOut === false && current.optedOut
  // Devolver el chat a Gema o dar la cita por hecha también da por atendida la solicitud de asesor.
  const agentResolved = current.needsAgent && (patch.needsAgent === false || (botChanged && patch.botActive) || (stageChanged && patch.stage === 'booked'))
  // Las acciones son idempotentes: repetir "agendado" no vuelve a sumar en las métricas.
  if (!botChanged && !stageChanged && !archiveChanged && !agentResolved && !optInChanged) return current

  const tx = db.multi()

  if (botChanged) tx.hset(chatKey, { botActive: patch.botActive ? '1' : '0' })
  if (agentResolved) tx.hset(chatKey, { needsAgent: '0' })
  // El operador lo reactiva: vuelve a recibir seguimientos y plantillas.
  if (optInChanged) tx.hdel(chatKey, 'optedOut', 'optedOutAt', 'optedOutText', 'noMarketing')

  if (stageChanged) {
    if (patch.stage === 'booked') {
      const bookedAt = Date.now()
      tx.hset(chatKey, { stage: 'booked', bookedAt: String(bookedAt) })
      queueStat(tx, 'booked', 1, bookedAt)
    } else {
      // Revierte el agendamiento en el día en que se contó, no en el de hoy.
      const bookedAt = Number(await db.hget<string>(chatKey, 'bookedAt')) || Date.now()
      tx.hset(chatKey, { stage: 'open' })
      tx.hdel(chatKey, 'bookedAt')
      queueStat(tx, 'booked', -1, bookedAt)
    }
  }

  if (archiveChanged) {
    const [from, to]: Box[] = patch.archived ? ['inbox', 'archived'] : ['archived', 'inbox']
    tx.hset(chatKey, { archived: patch.archived ? '1' : '0' })
    tx.zrem(keys.box(from), phone)
    tx.zadd(keys.box(to), { score: current.lastAt || Date.now(), member: phone })
  }

  queueRev(tx, 'chats')
  await tx.exec()
  return getSummary(phone)
}

/**
 * Bold confirmó un pago de este chat: deja el aviso para el panel y, si el chat esperaba que
 * alguien validara un comprobante, da esa alerta por atendida (Bold ya lo validó).
 */
export async function notePayment(phone: string, notice: string) {
  const current = await getSummary(phone)
  if (!current) return
  await redis().hset(keys.chat(phone), {
    paymentNotice: notice.slice(0, 200),
    paymentNoticeAt: String(Date.now()),
    ...(current.needsAgent && current.agentKind === 'payment' ? { needsAgent: '0' } : {}),
  })
  await bumpRev('chats')
}

/** Pausa a Gema y marca el chat para que una persona lo atienda. */
export async function requestAgent(phone: string, reason: string, kind: AgentKind = 'help') {
  const clean = reason.trim().slice(0, 200)
  await redis().hset(keys.chat(phone), {
    botActive: '0',
    needsAgent: '1',
    agentKind: kind,
    agentReason: clean ? clean[0].toUpperCase() + clean.slice(1) : kind === 'payment' ? 'Comprobante recibido' : 'Gema pidió ayuda de un asesor',
    agentAt: String(Date.now()),
  })
  await bumpRev('chats')
}

export async function deleteChat(phone: string) {
  await redis().multi()
    .del(keys.chat(phone), keys.messages(phone))
    .zrem(keys.box('inbox'), phone)
    .zrem(keys.box('archived'), phone)
    .zrem(keys.awaiting, phone)
    .incr(keys.rev('chats'))
    .exec()
}
