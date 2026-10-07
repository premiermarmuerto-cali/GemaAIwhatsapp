import { isLocation } from './clinic'
import { attachMediaInfo } from './media'
import { previewOf } from './media-text'
import { countryOf, regionOf } from './phone'
import { keys, redis, toHash } from './redis'
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
  tx.hincrby(chatKey, 'unread', 1)
  tx.rpush(keys.messages(phone), JSON.stringify(message))
  tx.ltrim(keys.messages(phone), -HISTORY_LIMIT, -1)
  tx.zrem(keys.box('archived'), phone)
  tx.zadd(keys.box('inbox'), { score: message.at, member: phone })
  queueStat(tx, 'inbound')
  if (isNew) queueStat(tx, 'newChats')
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
  await tx.exec()
}

/** Guarda lo que Gema averiguó del prospecto. Solo escribe los campos que traen valor nuevo. */
export async function saveLead(phone: string, lead: Partial<Lead>) {
  const patch: Record<string, string> = {}
  if (lead.concern) patch.leadConcern = lead.concern.slice(0, 300)
  if (lead.serviceId) patch.leadService = lead.serviceId.slice(0, 40)
  if (lead.location && isLocation(lead.location)) patch.leadLocation = lead.location
  if (Object.keys(patch).length) await redis().hset(keys.chat(phone), patch)
}

/** El chat produjo una cita: queda enlazada y el chat pasa a "agendado" (cuenta en las métricas). */
export async function attachBooking(phone: string, bookingId: string, lead: Partial<Lead> & { name?: string }) {
  const db = redis()
  const current = await getSummary(phone)
  const tx = db.multi()
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
  // Devolver el chat a Gema o dar la cita por hecha también da por atendida la solicitud de asesor.
  const agentResolved = current.needsAgent && (patch.needsAgent === false || (botChanged && patch.botActive) || (stageChanged && patch.stage === 'booked'))
  // Las acciones son idempotentes: repetir "agendado" no vuelve a sumar en las métricas.
  if (!botChanged && !stageChanged && !archiveChanged && !agentResolved) return current

  const tx = db.multi()

  if (botChanged) tx.hset(chatKey, { botActive: patch.botActive ? '1' : '0' })
  if (agentResolved) tx.hset(chatKey, { needsAgent: '0' })

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

  await tx.exec()
  return getSummary(phone)
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
}

export async function deleteChat(phone: string) {
  await redis().multi()
    .del(keys.chat(phone), keys.messages(phone))
    .zrem(keys.box('inbox'), phone)
    .zrem(keys.box('archived'), phone)
    .exec()
}
