/**
 * Lo que el cliente ya dijo para agendar: sede, día y franja (mañana, tarde, noche). Sale de SUS
 * mensajes, incluidas las notas de voz transcritas, y cada dato queda con la última vez que lo dijo:
 * solo cambia si el cliente cambia de parecer. Lo usan Gema (en el prompt) y los mensajes automáticos.
 *
 * 21 oct 2026: Luz Mina dijo "Unicentro" y, en una nota de voz, "¿para el sábado no tiene disponible?";
 * el seguimiento automático igual le ofreció "hoy a las 3:00 p.m." y le volvió a preguntar la sede.
 */
import { askedDay, askedLocations, askedPart, type DayPart } from './availability-note'
import { dayKey } from './calendar'
import type { Location, Message } from './types'

export type Preferences = { location: Location | ''; day: string; part: DayPart | '' }

/** Texto de un mensaje del cliente: lo que escribió más la transcripción de su nota de voz. */
const spoken = (message: Message) => [message.text, message.media?.kind === 'audio' ? message.media.note ?? '' : ''].filter(Boolean).join(' ')

/** "no puedo el sábado", "el sábado no me sirve": descarta un día, no lo elige. */
const REJECTS_DAY = /\bno\b[^.?!]{0,25}\b(puedo|sirve|queda|alcanzo)\b|\b(puedo|sirve|queda)\b[^.?!]{0,10}\bno\b/i

export function preferencesFrom(history: Message[], horizonDays: number, now = Date.now()): Preferences {
  const out: Preferences = { location: '', day: '', part: '' }
  for (const message of history) {
    if (message.sender !== 'user') continue
    const text = spoken(message)
    if (!text.trim()) continue
    const locations = askedLocations(text)
    if (locations.length === 1) out.location = locations[0]
    // El día se calcula desde la fecha del mensaje ("el sábado" dicho el martes es ese sábado).
    const day = askedDay(text, dayKey(message.at), horizonDays)
    if (day && !REJECTS_DAY.test(text)) out.day = day
    const part = askedPart(text)
    if (part) out.part = part
  }
  // Un día que ya pasó deja de ser una preferencia.
  if (out.day && out.day < dayKey(now)) out.day = ''
  return out
}
