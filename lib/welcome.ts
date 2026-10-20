/**
 * Bienvenida en bloques: el primer mensaje de cada cliente nuevo lo arma el servidor, no el modelo.
 *
 * La gente que llega del anuncio pregunta a medias ("info"), Gema contestaba solo eso y la mitad no
 * volvía a escribir (12 de 26 chats, oct 2026). Ahora la primera respuesta trae todo y busca el
 * cierre de una vez:
 *   1. imagen del bono + las promociones 2x1 vigentes HOY, con el valor por persona y los días que
 *      quedan (solo si la promoción tiene fecha: la urgencia es la real)
 *   2. qué es cada limpieza, con los productos del Mar Muerto (sale del catálogo del panel)
 *   3. cómo se separa (anticipo que se descuenta, sedes) y horas libres de verdad para dos personas,
 *      con una sola pregunta: cuál le separo
 * Después Gema atiende las preguntas y el agendamiento. Todo sale de la configuración y de la agenda,
 * así que cambia solo cuando cambian los precios, el 2x1 o el anticipo.
 */
import { suggestStarts } from './booking'
import { addDays, clock12, dayKey, dayLabel } from './calendar'
import { LOCATION_LABEL, LOCATIONS, MONTH_NAME } from './clinic'
import { amountOf, depositOf, pesos, twoForOneApplies } from './config'
import type { AppConfig, Message, Service } from './types'

export const WELCOME_KIND = 'bienvenida'
/** Arte del bono 2×1 (public/plantillas): el mismo encabezado de la plantilla ultimos_dias_bono. */
export const WELCOME_IMAGE = 'plantilla_ultimos_dias_bono.jpg'

export type Welcome = { imageUrl: string; caption: string; messages: string[] }

/** "Limpieza Peeling y Hidratación" → "Peeling y Hidratación": cómo se nombra en una lista corta. */
const shortName = (service: Service) => service.label.replace(/^limpieza\s+(y\s+|e\s+)?/i, '')

/** Primera frase del resumen del catálogo y su producto estrella, si lo nombra. */
function describe(service: Service): string {
  const sentences = service.summary.split(/(?<=\.)\s+/).map((sentence) => sentence.trim()).filter(Boolean)
  const first = sentences[0] ?? ''
  const star = sentences.find((sentence) => /^productos?\s+estrella/i.test(sentence))?.replace(/^productos?\s+estrella:\s*/i, '').replace(/\.$/, '')
  const lead = first ? first[0].toLowerCase() + first.slice(1).replace(/\.$/, '') : ''
  return [lead, star && `con ${star}`].filter(Boolean).join(', ')
}

/** "quedan 11 días", "mañana es el último día", "hoy es el último día". */
function countdown(today: string, until: string): string {
  const days = Math.round((Date.parse(`${until}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000)
  if (days <= 0) return 'hoy es el último día'
  if (days === 1) return 'mañana es el último día'
  return `quedan ${days} días`
}

const dateText = (day: string) => {
  const [, month, date] = day.split('-').map(Number)
  return `${date} de ${MONTH_NAME[month - 1]}`
}

/** "hoy 12:30 p.m. o 3:30 p.m.", "hoy 5:00 p.m. o mañana 10:00 a.m.": el día se dice una vez. */
function whenList(today: string, options: Array<{ day: string; start: string }>): string {
  const label = (day: string) => (day === today ? 'hoy' : day === addDays(today, 1) ? 'mañana' : dayLabel(day))
  return options.map((option, index) => (index && options[index - 1].day === option.day ? clock12(option.start) : `${label(option.day)} ${clock12(option.start)}`)).join(' o ')
}

/**
 * Los bloques para este momento, o null si no hay ningún 2x1 vigente con precio (entonces responde
 * Gema como siempre). `publicUrl` es de donde Meta descarga la imagen.
 */
export async function buildWelcome(config: AppConfig, publicUrl: string, now = Date.now()): Promise<Welcome | null> {
  const today = dayKey(now)
  const promos = config.services
    .filter((service) => twoForOneApplies(config, service.id, today) && amountOf(service.price))
    // Primero la que vence (la urgencia real), después las que no tienen fecha.
    .sort((a, b) => (config.twoForOne[a.id] || '9999').localeCompare(config.twoForOne[b.id] || '9999'))
  if (!promos.length) return null

  const lines = promos.map((service) => {
    const total = amountOf(service.price)
    const until = config.twoForOne[service.id]
    return `✨ *${service.label}*: 2 personas por *${pesos(total)}* (${pesos(Math.round(total / 2))} cada una).${until ? ` Solo hasta el ${dateText(until)}: ${countdown(today, until)}.` : ''}`
  })
  const caption = [
    'Hola, qué bueno que nos escribes 💛 Soy Gema, de Premier Mar Muerto · Cali.',
    '',
    `*HOY tenemos activa${promos.length > 1 ? 's' : ''} ${promos.length > 1 ? `${promos.length === 2 ? 'dos' : promos.length} promociones` : 'una promoción'} 2×1* 👇`,
    '',
    ...lines,
  ].join('\n')

  const products = [
    `${promos.length > 1 ? 'Las dos son' : 'Es'} limpiezas faciales completas con productos Premier, hechos con minerales del Mar Muerto 🌊`,
    ...promos.map((service) => `▪️ *${shortName(service)}* (${service.durationMin} min): ${describe(service)}.`),
  ].join('\n')

  // Anticipo: con anticipo fijo es el mismo en todas; con porcentaje se dice cuál.
  const deposits = [...new Set(promos.map((service) => depositOf(config, service.price)))]
  const depositText = deposits.length === 1 ? `un anticipo de *${deposits[0]}*` : `un anticipo del ${config.depositPercent}%`
  const sedes = LOCATIONS.filter((location) => config.addresses[location]).map((location) => `${LOCATION_LABEL[location]} (${config.addresses[location]})`)

  // Horas libres para DOS personas a la vez (el gancho es el 2x1), dos por sede.
  const slotLines: string[] = []
  for (const location of LOCATIONS) {
    if ((config.cabins[location] ?? 1) < 2) continue
    const options = await suggestStarts(config, location, { now, people: 2 })
    if (options.length) slotLines.push(`▪️ ${LOCATION_LABEL[location]}: ${whenList(today, options)}`)
  }
  const close = [
    `Para separar dejas ${depositText} que *se descuenta del valor*, y el resto lo pagas en la sede${sedes.length ? `: ${sedes.join(' o ')}` : ''}.`,
    ...(slotLines.length ? ['', 'Para venir con tu acompañante a la misma hora tengo libre:', ...slotLines, '', 'Cuál te separo?'] : ['', 'En qué sede te queda mejor?']),
  ].join('\n')

  return { imageUrl: `${publicUrl.replace(/\/$/, '')}/plantillas/${WELCOME_IMAGE}`, caption, messages: [products, close] }
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
