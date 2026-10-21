/**
 * Bienvenida en bloques: el primer mensaje de cada cliente nuevo lo arma el servidor, no el modelo.
 *
 * La gente que llega del anuncio pregunta a medias ("info") y, si recibe solo un precio, deja de
 * contestar. La primera respuesta trae todo y busca el cierre de una vez (textos editables en el
 * panel, ver lib/preset-defaults.ts):
 *   1. imagen del bono + las promociones 2x1 vigentes HOY, con los días que quedan
 *   2. el valor: ritual de 5 pasos, limpieza cero invasiva y qué resuelve cada limpieza
 *   3. cómo se separa (anticipo que se descuenta, cortesía, sedes) y horas libres de verdad, con una
 *      sola pregunta
 * Después Gema atiende las preguntas y el agendamiento con sus propias respuestas.
 */
import { dayKey } from './calendar'
import { livePromos, renderPreset, type PresetContext } from './presets'
import type { AppConfig, Message } from './types'

export const WELCOME_KIND = 'bienvenida'
/** Arte del bono 2×1 (public/plantillas): el mismo encabezado de la plantilla ultimos_dias_bono. */
export const WELCOME_IMAGE = 'plantilla_ultimos_dias_bono.jpg'
/** Límite de WhatsApp para el texto al pie de una imagen. */
const CAPTION_MAX = 1024

export type Welcome = { imageUrl: string; caption: string; messages: string[] }

/**
 * Los bloques para este momento, o null si no hay ningún 2x1 vigente con precio (entonces responde
 * Gema como siempre). `publicUrl` es de donde Meta descarga la imagen.
 */
export async function buildWelcome(config: AppConfig, publicUrl: string, context: PresetContext = {}): Promise<Welcome | null> {
  const now = context.now ?? Date.now()
  if (!livePromos(config, dayKey(now)).length) return null
  const full = { ...context, now }
  const [caption, value, close] = await Promise.all([
    renderPreset(config, 'welcomeCaption', full),
    renderPreset(config, 'welcomeValue', full),
    renderPreset(config, 'welcomeClose', full),
  ])
  // El pie de la imagen es un solo mensaje: lo que venga partido con ||| va como texto aparte.
  const [first = '', ...restCaption] = (caption ?? '').split('|||').map((part) => part.trim()).filter(Boolean)
  let imageCaption = first
  const extra: string[] = [...restCaption]
  if (imageCaption.length > CAPTION_MAX) {
    // Demasiado largo para el pie: la primera parte acompaña la imagen y el resto sale como texto.
    const [head, ...tail] = imageCaption.split(/\n\s*\n/)
    imageCaption = head.slice(0, CAPTION_MAX)
    extra.unshift(tail.join('\n\n'))
  }
  const messages = [...extra, ...[value, close].flatMap((text) => (text ?? '').split('|||'))].map((part) => part.trim()).filter(Boolean)
  return { imageUrl: `${publicUrl.replace(/\/$/, '')}/plantillas/${WELCOME_IMAGE}`, caption: imageCaption, messages }
}

/** Palabras de un primer mensaje que solo pide información (lo que la bienvenida ya responde). */
const INFO_WORDS = new Set(('hola buenas buenos buen dia dias tarde tardes noche noches info informacion quiero quisiera me te nos interesa interesada '
  + 'interesado mas sobre esto eso este esta el la los las lo de del por favor porfa precio precios cuanto cuesta cuestan vale valor valores '
  + 'bono promo promocion promociones oferta 2x1 2×1 anuncio video vi visto salsa puedo podria obtener saber limpieza limpiezas facial faciales y que '
  + 'es son en una un unas unos gracias si hay tienen tienes para como con mas pregunta preguntar detalles consultar a mi')
  .split(' '))

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * El primer mensaje pregunta algo que la bienvenida no responde ("hacen depilación?", "atienden
 * hombres?"): después de los bloques, Gema contesta eso. Si solo saluda o pide información, no.
 */
export function needsAnswerAfterWelcome(text: string): boolean {
  const words = fold(text).split(/[^a-z0-9×]+/).filter(Boolean)
  if (!words.length) return false
  const other = words.filter((word) => !INFO_WORDS.has(word))
  return other.length >= 2 || (other.length === 1 && words.length <= 4 && /\?/.test(text))
}

/** La bienvenida ya se envió en este chat (está en el historial). */
export const welcomed = (history: Message[]) => history.some((message) => message.auto === WELCOME_KIND)

