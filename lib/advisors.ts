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

/** Quita un nombre de la lista (mal escrito, o ya no trabaja ahí). Sus citas conservan el nombre. */
export async function forgetAdvisor(name: string): Promise<void> {
  await redis().zrem(keys.advisors, name)
}
