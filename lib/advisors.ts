/**
 * Asesores que agendan en el panel, guardados en Upstash para elegirlos de una lista en cualquier
 * computador (antes había que escribir el nombre en cada cita). Se ordenan por uso reciente. "Gema"
 * no se guarda: siempre está.
 */
import { keys, redis } from './redis'

const MAX_ADVISORS = 40

export async function listAdvisors(): Promise<string[]> {
  return redis().zrange<string[]>(keys.advisors, 0, MAX_ADVISORS - 1, { rev: true })
}

/** Lo guarda (o lo sube en la lista) cada vez que un asesor agenda o se le asigna una cita. */
export async function rememberAdvisor(name: string): Promise<void> {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60)
  if (!clean || clean.toLowerCase() === 'gema') return
  await redis().zadd(keys.advisors, { score: Date.now(), member: clean })
}

/**
 * Cambia el nombre de un asesor (le agregó el apellido, estaba mal escrito): en la lista y en TODAS
 * sus citas. Recorre los índices de citas por estado; es una acción rara y de pocas centenas de citas.
 */
export async function renameAdvisor(from: string, to: string): Promise<number> {
  const clean = to.trim().replace(/\s+/g, ' ').slice(0, 60)
  if (!clean || clean === from) return 0
  const db = redis()
  const statuses = ['hold', 'pending_payment', 'confirmed', 'done', 'no_show', 'cancelled'] as const
  const ids = [...new Set((await Promise.all(statuses.map((status) => db.zrange<string[]>(keys.byStatus(status), 0, -1)))).flat())]
  let updated = 0
  if (ids.length) {
    const pipe = db.pipeline()
    ids.forEach((id) => pipe.hget(keys.booking(id), 'advisor'))
    const advisors = await pipe.exec<Array<string | null>>()
    const tx = db.multi()
    ids.forEach((id, index) => { if (advisors[index] === from) { tx.hset(keys.booking(id), { advisor: clean }); updated++ } })
    tx.zrem(keys.advisors, from)
    tx.zadd(keys.advisors, { score: Date.now(), member: clean })
    tx.incr(keys.rev('agenda'))
    await tx.exec()
  } else {
    await db.multi().zrem(keys.advisors, from).zadd(keys.advisors, { score: Date.now(), member: clean }).exec()
  }
  return updated
}

/** Quita un nombre de la lista (mal escrito, o ya no trabaja ahí). Sus citas conservan el nombre. */
export async function forgetAdvisor(name: string): Promise<void> {
  await redis().zrem(keys.advisors, name)
}
