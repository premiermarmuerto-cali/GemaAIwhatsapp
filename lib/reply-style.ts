/**
 * Estilo de WhatsApp de Gema. El prompt le pide escribir como una persona (mensajes cortos, sin ¿ ¡,
 * sin guion largo), pero el modelo se desvía con frecuencia, así que lo que es mecánico se impone
 * aquí, sobre lo que escribe el modelo. Lo que compone el servidor (links, cuentas, montos) no pasa
 * por estas funciones: va entero y nunca se parte.
 */

/** Separador que el modelo pone entre mensajes. El cliente nunca lo ve. */
export const SEPARATOR = '|||'

/** Más de tres mensajes seguidos abruman. */
export const MAX_MESSAGES = 3

/**
 * Relleno que delata a un bot (lo mismo que prohíbe el prompt). Si el modelo lo escribe igual:
 * - una frase corta que es solo relleno se elimina ("Entiendo tus dudas.", "Quedo atenta.");
 * - si el relleno es el arranque de una frase con contenido, se recorta solo el arranque
 *   ("Además, hay 2x1" → "hay 2x1"). Nunca se borra una frase con información.
 */
const FILLER_SENTENCE = /^(entiendo (perfectamente|tus dudas|tu duda|tu inquietud|tu preocupaci[oó]n)|es completamente normal|tienes toda la raz[oó]n|excelente pregunta|qu[eé] buena elecci[oó]n|con gusto te ayudo|gracias por tu inter[eé]s)\b|\b(hay algo m[aá]s en lo que (pueda|te pueda) ayudar|quedo atent[ao]|no dudes en escribirme|espero que esto te ayude|av[ií]same si tienes m[aá]s dudas)\b/i
const FILLER_OPENER = /^(adem[aá]s|recuerda que|ten en cuenta que|por supuesto|excelente pregunta|qu[eé] buena elecci[oó]n|con gusto te ayudo)\b[,:!]?\s*/i
const SHORT_SENTENCE_WORDS = 7
// Frases que anuncian que va a hacer algo después ("Voy a reservar tu cita y te cuento enseguida"):
// el sistema ya lo hizo en ese mismo turno, así que no dicen nada. Se quitan aunque sean largas.
const ANNOUNCES_LATER = /^(voy a (reservar|agendar|revisar|verificar|confirmar)|d[eé]jame (revisar|verificar|confirmar)|(dame|un) momento|ya te (confirmo|cuento)|te cuento enseguida|enseguida te)/i

/**
 * Texto con ||| → lista de mensajes, máximo MAX_MESSAGES. Los saltos de párrafo también separan
 * mensajes: el modelo a veces escribe párrafos en vez de usar |||. Si hay más de tres, se deja el
 * primero, el último (que es la pregunta, si la hay) y se unen los del medio.
 */
export function splitMessages(text: string): string[] {
  const parts = text.split(/\|\|\||\n{2,}/).map((part) => part.trim()).filter(Boolean)
  if (parts.length <= MAX_MESSAGES) return parts
  const middle = parts.slice(1, -1).map((part) => part.replace(/[.!?]$/, '')).join('. ')
  return [parts[0], middle, parts[parts.length - 1]]
}

/** Quita frases de relleno de un mensaje; si no queda nada, lo deja como estaba. */
function withoutFiller(part: string): string {
  const sentences = part.split(/(?<=[.!?])\s+/)
  const isFiller = (sentence: string) => ANNOUNCES_LATER.test(sentence.trim())
    || (FILLER_SENTENCE.test(sentence) && sentence.split(/\s+/).length <= SHORT_SENTENCE_WORDS)
  const kept = sentences.filter((sentence) => !isFiller(sentence))
  // Un mensaje que solo anuncia algo para después se elimina entero; uno que solo es cortesía se deja.
  if (!kept.length && sentences.every((sentence) => ANNOUNCES_LATER.test(sentence.trim()))) return ''
  return (kept.length ? kept : sentences).map((sentence) => sentence.replace(FILLER_OPENER, '')).join(' ')
}

const LIST_ITEM = /^\s*(?:\d{1,2}[.)]|[-•*])\s+/

/**
 * Una lista (numerada o con viñetas) → una frase: "tengo:\n1. 10:00 a.m.\n2. 4:00 p.m." →
 * "tengo: 10:00 a.m. y 4:00 p.m.". El prompt prohíbe listas, pero el modelo a veces las escribe.
 */
function flattenLists(part: string): string {
  const lines = part.split('\n')
  if (lines.filter((line) => LIST_ITEM.test(line)).length < 2) return part.replace(new RegExp(LIST_ITEM.source, 'gm'), '')
  const out: string[] = []
  let items: string[] = []
  const flush = () => {
    if (!items.length) return
    const joined = items.length > 1 ? `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}` : items[0]
    out.push(out.length && /:$/.test(out[out.length - 1]) ? `${out.pop()} ${joined}` : joined)
    items = []
  }
  for (const line of lines) {
    if (LIST_ITEM.test(line)) items.push(line.replace(LIST_ITEM, '').trim().replace(/(?<![ap]\.m)[.,;]$/i, ''))
    else { flush(); if (line.trim()) out.push(line.trim()) }
  }
  flush()
  return out.join('\n')
}

/**
 * Horas de 24 h que el modelo copia de la agenda ("18:30") → "6:30 p.m.". Solo de 13 a 23, que no
 * son ambiguas: "6:30" a secas ya es como habla la gente y queda igual.
 */
function twelveHour(part: string): string {
  return part.replace(/\b(1[3-9]|2[0-3]):([0-5]\d)\b(?:\s*(?:p\.?\s?m\.?|hrs?\b|h\b))?/gi, (_, hour: string, minute: string) => `${Number(hour) - 12}:${minute} p.m.`)
}

/** Reglas mecánicas de puntuación sobre un mensaje del modelo. */
function casual(part: string, isLast: boolean): string {
  // Las listas van primero: withoutFiller une las frases con espacios y se pierden los saltos de línea.
  let out = twelveHour(withoutFiller(flattenLists(part)))
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*') // Markdown **negrita** → *negrita* de WhatsApp
    .replace(/(\$\s?[\d.]+\*?)\s*COP\b/g, '$1') // "$130.000 COP" → "$130.000"
    .replace(/\[(?!\[)[^\]\n]{2,60}\]/g, '') // relleno tipo "[datos de la cuenta]"
    .replace(/[¿¡]/g, '')
    .replace(/\s*—\s*/g, ', ')
    .replace(/;\s*/g, ', ')
    .replace(/ {2,}/g, ' ')
    .replace(/([:,;])\s*([:,;.])/g, '$2') // restos de puntuación al quitar relleno ("Nequi:.")
    .trim()
  // El último mensaje no lleva punto final (pero sí los puntos suspensivos y el de "p.m.").
  if (isLast) out = out.replace(/(?<!\.|[ap]\.m)\.$/i, '')
  return out
}

/**
 * Lo que escribió el modelo, ya en su forma final: partido en mensajes y con la puntuación de
 * WhatsApp. Devuelve los mensajes unidos por ||| para poder seguir tratándolo como un solo texto.
 */
export function styleModelText(text: string): string {
  const parts = splitMessages(text)
  const styled = parts.map((part, index) => casual(part, index === parts.length - 1)).filter(Boolean)
  // Nunca se deja una respuesta vacía por limpiar de más.
  return styled.length ? styled.join(SEPARATOR) : parts.join(SEPARATOR)
}

/**
 * Mete un mensaje del servidor justo después del mensaje que contiene `anchor` (p. ej. el precio).
 * Si ese mensaje termina en pregunta, la separa para que la pregunta siga siendo lo último:
 * "está en $130.000. Te gustaría agendar?" → "está en $130.000." | mensaje | "Te gustaría agendar?".
 */
export function insertAfter(text: string, anchor: string, message: string): string {
  const parts = toMessages(text)
  const index = parts.findIndex((part) => part.includes(anchor))
  if (index === -1) return [...parts, message].join(SEPARATOR)
  const part = parts[index]
  const split = /\?$/.test(part) ? part.match(/^([\s\S]*?[.!])\s+([^.!]*\?)$/) : null
  if (split) parts.splice(index, 1, split[1], message, split[2])
  else parts.splice(index + 1, 0, message)
  return parts.join(SEPARATOR)
}

/** Texto final (modelo + servidor, unidos por |||) → mensajes que se envían uno por uno. */
export function toMessages(text: string): string[] {
  return text.split(SEPARATOR).map((part) => part.trim()).filter(Boolean)
}
