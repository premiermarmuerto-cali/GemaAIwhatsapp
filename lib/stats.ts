import { dayKey } from './calendar'
import { keys, redis, toHash } from './redis'
import type { DailyStats, Stats } from './types'

const STATS_TTL_SECONDS = 60 * 60 * 24 * 90

export type StatField = keyof DailyStats

type Chainable = { hincrby: (key: string, field: string, increment: number) => unknown; expire: (key: string, seconds: number) => unknown }

/** Encola el incremento dentro de un multi/pipeline existente para que sea atómico con el resto del cambio. */
export function queueStat(tx: Chainable, field: StatField, by = 1, at = Date.now()) {
  const key = keys.stats(dayKey(at))
  tx.hincrby(key, field, by)
  tx.expire(key, STATS_TTL_SECONDS)
}

export async function getStats(): Promise<Stats> {
  const [inbox, archived, raw] = await redis().pipeline()
    .zcard(keys.box('inbox'))
    .zcard(keys.box('archived'))
    .hgetall(keys.stats(dayKey()))
    .exec<[number, number, unknown]>()
  const hash = toHash(raw)
  const read = (field: StatField) => Number(hash?.[field] ?? 0)
  return {
    inbox,
    archived,
    today: { inbound: read('inbound'), aiReplies: read('aiReplies'), humanReplies: read('humanReplies'), booked: read('booked'), newChats: read('newChats') },
  }
}
