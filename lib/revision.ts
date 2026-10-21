/**
 * Contadores de cambios para que el panel no relea todo en cada consulta (oct 2026: el panel abierto
 * consumía la mayor parte de los comandos de Upstash). Cada escritura de un chat o de la agenda suma
 * 1; el panel pregunta los dos contadores (un solo MGET) cada pocos segundos y solo recarga la
 * bandeja, el chat abierto o la semana cuando cambian. Un contador que no se suba por error solo
 * retrasa la pantalla hasta la recarga de respaldo (cada 2–5 minutos), nunca pierde datos.
 */
import { keys, redis } from './redis'

export type RevName = 'chats' | 'agenda'
export type Revisions = Record<RevName, string>

type Incrementer = { incr: (key: string) => unknown }

/** Encola el aviso de cambio dentro de un multi/pipeline que ya existe (no cuesta un viaje más). */
export function queueRev(tx: Incrementer, name: RevName) {
  tx.incr(keys.rev(name))
}

/** Avisa de un cambio fuera de una transacción. Un fallo aquí no rompe la escritura que ya se hizo. */
export async function bumpRev(name: RevName): Promise<void> {
  await redis().incr(keys.rev(name)).catch(() => null)
}

export async function readRevisions(): Promise<Revisions> {
  const [chats, agenda] = await redis().mget<(string | null)[]>(keys.rev('chats'), keys.rev('agenda'))
  return { chats: String(chats ?? '0'), agenda: String(agenda ?? '0') }
}
