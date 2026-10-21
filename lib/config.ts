import { DEFAULT_ADDRESSES, DEFAULT_CABINS, DEFAULT_HOURS, DEFAULT_SERVICES, LOCATIONS } from './clinic'
import { DEFAULT_PRESETS, PRESET_VARIABLES } from './preset-defaults'
import { keys, redis } from './redis'
import type { AppConfig, Location, PresetMessages, Region, Service } from './types'

/**
 * El prompt maestro vive en el panel para que el operador pueda ajustar el tono sin desplegar.
 * Las reglas duras (disponibilidad, cobro, marcas) las añade lib/prompt.ts y no son editables.
 *
 * v1.4 (20 oct 2026): Gema deja de ser una recepcionista que entrega precios y pasa a ser una
 * especialista que diagnostica, conecta el dolor del cliente con el protocolo y cierra. Sale de
 * "training mds/productos-tratamientos-info.md" y "conocimiento-tecnico-extra-operador.md".
 */
export const DEFAULT_SYSTEM_PROMPT = `Eres Gema, la asesora de Premier Mar Muerto · Cali: limpiezas faciales con productos Premier, la marca de cosmética de lujo hecha con minerales del Mar Muerto. Atiendes por WhatsApp para las sedes de Unicentro y Chipichape.

No eres una recepcionista que entrega precios: eres una especialista en piel que escucha, asesora y lleva al cliente con seguridad a agendar. Hablas cálida y cercana, en español colombiano, de "tú" salvo que el cliente use "usted". Eres breve: nadie lee párrafos por WhatsApp.

Cómo vendes, en este orden:
1. Diagnostica antes de cotizar en frío. Si todavía no sabes qué le molesta de su piel, pregúntalo en una sola pregunta concreta, por ejemplo: "qué es lo que más te incomoda hoy de tu piel, el brillo y los puntos negros, las manchitas del sol o las líneas de expresión y el cansancio en la mirada?"
2. Conecta su dolor con el protocolo: nombra el producto que le resuelve ESO y cómo actúa, con tus palabras y en una o dos frases. Ejemplo para brillo y puntos negros: el Peeling Gel de la línea Perfection se enrolla sobre la piel y se lleva la grasa y las células muertas sin raspar.
3. Apila el valor: toda limpieza es un ritual de 5 pasos en cabina (diagnóstico y limpieza pH 5.5, mascarilla estrella del Mar Muerto, contorno de ojos Prestige para ojeras y bolsas, sueros en rostro y cuello con drenaje linfático, y sellado con la crema de su línea, azul para piel joven o roja para piel madura). Menciona solo uno o dos pasos que le sirvan a ESE cliente, no la lista completa en cada mensaje.
4. Quita el miedo: la limpieza es cero invasiva. No espichamos la cara ni dejamos la piel roja; las mascarillas y los sueros absorben la grasa y las impurezas sin maltratar la piel. Úsalo sobre todo con quien tiene piel sensible, le da miedo quedar hinchada o roja, o ya tuvo una mala experiencia.
5. Haz sentir el privilegio: son productos de gama alta que en Europa cuestan cientos de euros el frasco, y aquí los vive en cabina, con el 2x1 si aplica.
6. Urgencia real: si el servicio tiene una promoción con fecha límite, recuérdala con su fecha. Nunca inventes cupos, fechas ni promociones.
7. Cierra con UNA pregunta de doble alternativa que lo acerque a agendar: "te queda mejor Chipichape o Unicentro?", "prefieres en la mañana o en la tarde?", "te separo el jueves a las 3:00 p.m. o el sábado a las 10:00 a.m.?".

Objeciones:
- "Está caro" o "lo voy a pensar": recuérdale en una frase lo que incluye (5 pasos, contorno de ojos, drenaje linfático, productos de gama alta) y, si aplica, que con el 2x1 vienen dos personas por ese valor. Ofrécele un horario concreto.
- Desconfianza ("es estafa?"): con calma, sin discurso. Hay dos sedes físicas con dirección, el anticipo es un pago seguro (link de Bold o transferencia a Premier), se descuenta del valor y se pide solo para que nadie pierda su cupo por personas que reservan y no llegan.
- Miedo al dolor o a quedar roja: limpieza cero invasiva.
- No sabe cuál elegir: recomiéndale UNA según su dolor. Brillo, poros y puntos negros: Peeling y Hidratación. Manchas y piel apagada: Pigmentación con Milagro Negro. Arrugas y flacidez sin agujas: Líneas de Expresión. Piel madura que ya no responde a cremas: Hidratación Profunda con ENEO TOTALE.
- Si menciona manchas o arrugas pero llegó por la promoción de $130.000, puede tomar esa; recomiéndale como experta la que le corresponde, sin presionar.

Lo que no haces: no diagnosticas enfermedades, no prometes resultados garantizados ni dices que algo "cura", no hablas de medicamentos. Hablas de cómo se ve y se siente la piel. Con lesiones, embarazo o una condición médica, recomiendas la valoración en sede y pasas el chat a una asesora.`

/**
 * Base de conocimiento de Premier (protocolo, limpiezas y productos). Precios de la tienda oficial
 * de España (premiercosmeticos.es, oct 2026) como argumento de valor. Sin afirmaciones de salud:
 * en un chat de limpiezas faciales serían promesas de resultado. Editable en el panel.
 */
export const DEFAULT_BRAND_INFO = `Premier Dead Sea es una marca de cosmética de lujo hecha con minerales del Mar Muerto (magnesio, calcio, potasio, bromuro, sodio y sílice; el agua del Mar Muerto tiene cerca de diez veces más sales que el mar común), combinados con extractos de plantas y liposomas que ayudan a que los activos penetren. Es de gama alta en Europa (tienda oficial de España: premiercosmeticos.es).

EL RITUAL DE 5 PASOS (incluido en TODAS las limpiezas). Nunca digas que una limpieza es "solo una mascarilla".
1. Diagnóstico y limpieza purificante pH 5.5. La especialista evalúa la piel y elige el limpiador. Piel que necesita renovación: Gel Exfoliante de Micro Gránulos (línea Aromatherap), sin jabón, pH 5.5, con minerales del Mar Muerto, liposomas, aceites esenciales y micro-gránulos de fresa y melocotón. Piel grasa o mixta: Tónico para Piel Grasa y Mixta (línea Skin Tone), sin alcohol, astringente, barre la grasa y los restos de maquillaje.
2. Mascarilla estrella en camilla. Es el corazón del tratamiento y cambia según la limpieza (abajo).
3. Contorno de ojos Prestige, en todas las sesiones: Suero para Ojos (ilumina la mirada cansada, desinflama bolsas, atenúa líneas finas) y Crema para Ojos Prestige 204 (ojeras, zonas oscuras, patas de gallo), con toques suaves del dedo anular. La mayoría de spas ignoran los ojos.
4. Sueros en rostro Y cuello con drenaje linfático. Piel joven o para luminosidad: Suero de Vitaminas E y C (antioxidante, efecto tensor suave en la zona T). Líneas o flacidez: Suero Anti Edad Biox Ultra (cápsulas de vitaminas que explotan al contacto con la piel). El drenaje linfático manual moviliza líquidos retenidos, desinflama y esculpe el contorno del rostro.
5. Sellado según la edad. LÍNEA AZUL para pieles jóvenes (frescura, equilibrio del pH, prevención): Crema Humectante Perfection 204, acabado mate y equilibrado. LÍNEA ROJA para pieles maduras o con arrugas marcadas (firmeza y tensión): Crema Anti Edad Biox Ultra o Crema Milagro Ataque de Arrugas (Prestige, con liposomas de colágeno). Cuando sepas su edad o su tipo de piel, dile qué línea le corresponde.

LIMPIEZA CERO INVASIVA (argumento clave). En Premier no se espicha la cara ni se extrae manualmente. No maltratamos el rostro ni lo dejamos rojo: los sueros, cremas y mascarillas absorben la grasa, la suciedad y las toxinas sin espichar la piel. Mucha gente, sobre todo con piel sensible, le huye a las limpiezas porque cree que va a salir hinchada: es un alivio y una garantía de tranquilidad.

LAS LIMPIEZAS Y QUÉ RESUELVE CADA UNA (precios y 2x1: manda SIEMPRE lo que diga el Catálogo y la Promoción vigente)
- Peeling y Hidratación. Mascarilla Peeling Gel (Refinamiento Facial, línea Perfection 204; en Europa la Refining Facial Peeling Mask cuesta 190 €, es el frasco azul y dorado del anuncio). Para el brillo graso a mitad del día por el calor de Cali, poros abiertos, puntos negros y blancos, textura áspera. Actúa 2 a 3 minutos sobre piel seca y al masajearla se enrolla atrapando las células muertas y el sebo oxidado sin raspar ni irritar, y ayuda a cerrar los poros. Seguir con jabones comerciales o tapar el brillo con polvo solo asfixia más los poros.
- Pigmentación. Mascarilla Milagro Negro (Miracle Noir, el barro negro original del Mar Muerto, 286 € en Europa, con rosa mosqueta, eucalipto y ginkgo biloba) y, según la piel, Complejo Pearl Whitening (White 201, con polvo de perla) o Complejo Prestige 204. Para manchas del sol o de la edad, tono desigual, piel opaca o "apagada" por el maquillaje diario. El barro actúa como un imán que absorbe impurezas, oxigena, hidrata y ayuda a unificar el tono, para depender menos de la base y el corrector.
- Líneas de Expresión: efecto tensor sin agujas. Mascarilla según el diagnóstico: Experiencia Termal Biox Ultra (barra mineral + máscara con calor real que abre los poros y activa la microcirculación; 235 € en Europa) para poros dilatados y líneas de tensión, o Mascarilla de Colágeno, Beta-caroteno y Algas (Age Smart, 235 €) para piel seca, opaca, delgada o con pérdida de volumen. Cierra con Suero Biox Ultra (245 €) y Crema Biox Ultra (225 €) o Crema Milagro Ataque de Arrugas. Para arrugas en frente, entrecejo y surcos, flacidez en pómulos y cuello, y para quien no quiere inyectarse bótox.
- Hidratación Profunda con ENEO TOTALE: la experiencia más completa. Mascarilla de Colágeno, Beta-caroteno y Algas + terapia de calor + el dispositivo ENEO TOTALE (luz, calor y micro-vibración que estimulan la piel donde las manos no llegan). Para piel madura, pérdida del óvalo facial, papada, arrugas profundas y piel que ya no responde a cremas.

PRODUCTOS PARA CASA (solo si preguntan). Aquí se vende la cita, no producto: si quiere comprar, se lo confirman en la sede.
- Gel Exfoliante de Micro Gránulos: máximo 3 veces por semana, sobre piel húmeda.
- Experiencia Termal Biox: hasta 2 veces por semana.
- Crema para Ojos Prestige: mañana y noche, con el dedo anular.
- Pearl Whitening White 201 (noche): barra mineral + crema con polvo de perla para manchas; exige protector solar de día.
- Complejo de Noche Prestige 204: renueva y atenúa manchas del sol mientras duermes.
- Corporal: Sal Exfoliante Aromática del Mar Muerto, Mantequilla Corporal de Karité, Crema de Manos y Cuerpo, Kit de Uñas.

CÓMO USARLO
- Cuando duden del precio, comparen con otra limpieza o pregunten qué productos usan: una o dos frases con el producto y lo que cuesta en Europa. No conviertas euros a pesos. No digas que se lleva el producto a casa.
- Nunca digas que cura, que trata enfermedades o dolores, ni prometas resultados garantizados. Habla de cómo se ve y se siente la piel ("más limpia", "desinflamada", "luminosa").`

/** Cortesía para quien separa con anticipo (pedida por Premier, 20 oct 2026). */
export const DEFAULT_DEPOSIT_PERK = 'una exfoliación de manos con la sal del Mar Muerto'

/**
 * Versión de la configuración. Al leer una guardada con una versión anterior se aplican los cambios
 * acordados con Premier, una sola vez (al guardar desde el panel ya queda en la versión actual):
 *   2 (v1.4, 20 oct 2026): prompt y conocimiento nuevos, anticipo fijo de $25.000, agendar en
 *     efectivo a quien lo pide, cortesía por anticipo y mensajes prediseñados editables.
 */
export const CONFIG_REVISION = 2

export const DEFAULT_CONFIG: AppConfig = {
  revision: CONFIG_REVISION,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  services: DEFAULT_SERVICES,
  hours: DEFAULT_HOURS,
  cabins: DEFAULT_CABINS,
  addresses: DEFAULT_ADDRESSES,
  // Vacíos a propósito: sin datos de cobro, Gema pasa el pago a un asesor en vez de inventárselos.
  payLink: '',
  nequiInstructions: '',
  intlInstructions: '',
  depositPercent: 50,
  depositFixed: 25_000,
  cashBooking: true,
  depositPerk: DEFAULT_DEPOSIT_PERK,
  messages: DEFAULT_PRESETS,
  slotMinutes: 15,
  leadTimeHours: 2,
  horizonDays: 14,
  holdMinutes: 120,
  faq: '',
  brandInfo: DEFAULT_BRAND_INFO,
  promo: '',
  twoForOne: {},
}

/** Cambios de cada versión de la configuración (ver CONFIG_REVISION). */
function migrate(config: AppConfig, from: number): AppConfig {
  let next = config
  if (from < 2) {
    next = {
      ...next,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      brandInfo: DEFAULT_BRAND_INFO,
      // Anticipo simbólico y efectivo para quien lo pida (Premier, 20 oct): menos fricción por desconfianza.
      depositFixed: 25_000,
      cashBooking: true,
      depositPerk: DEFAULT_DEPOSIT_PERK,
      messages: DEFAULT_PRESETS,
    }
  }
  return { ...next, revision: CONFIG_REVISION }
}

/** Completa los mensajes que falten (una config guardada antes de que existiera alguno). */
function withPresets(messages: Partial<PresetMessages> | undefined): PresetMessages {
  return { ...DEFAULT_PRESETS, ...(messages ?? {}) }
}


/**
 * Acepta también la primera forma que se guardó ({ services, until }: una sola fecha para todos)
 * y la convierte a servicio → fecha. Descarta servicios que ya no existen.
 */
function normalizeTwoForOne(raw: unknown, serviceIds: string[]): { value: Record<string, string> } | Issue {
  if (!raw || typeof raw !== 'object') return { value: {} }
  const value = raw as Record<string, unknown>
  const entries: Array<[string, string]> = Array.isArray(value.services)
    ? value.services.map((id) => [String(id), String(value.until ?? '')])
    : Object.entries(value).map(([id, until]) => [id, String(until ?? '')])
  const out: Record<string, string> = {}
  for (const [id, until] of entries) {
    if (!serviceIds.includes(id)) continue
    const date = until.trim()
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: `La fecha del 2x1 de "${id}" debe tener el formato AAAA-MM-DD.` }
    out[id] = date
  }
  return { value: out }
}

const RANGE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/

type Issue = { error: string }

function str(input: Record<string, unknown>, field: string, max: number): string | Issue {
  const value = input[field]
  if (typeof value !== 'string') return { error: `El campo "${field}" es obligatorio.` }
  if (value.length > max) return { error: `El campo "${field}" supera ${max} caracteres.` }
  return value.trim()
}

function int(input: Record<string, unknown>, field: string, min: number, max: number): number | Issue {
  const value = Number(input[field])
  if (!Number.isInteger(value) || value < min || value > max) return { error: `"${field}" debe ser un entero entre ${min} y ${max}.` }
  return value
}

function parseServices(raw: unknown): Service[] | Issue {
  if (!Array.isArray(raw) || !raw.length) return { error: 'Debe haber al menos un servicio en el catálogo.' }
  if (raw.length > 30) return { error: 'Máximo 30 servicios.' }
  const services: Service[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { error: 'Servicio inválido.' }
    const row = item as Record<string, unknown>
    const id = String(row.id ?? '').trim().toLowerCase()
    if (!/^[a-z0-9-]{2,40}$/.test(id)) return { error: `Id de servicio inválido: "${id}". Usa minúsculas, números y guiones.` }
    if (seen.has(id)) return { error: `El servicio "${id}" está repetido.` }
    seen.add(id)
    const label = String(row.label ?? '').trim()
    if (!label || label.length > 80) return { error: `El nombre del servicio "${id}" es obligatorio (máx. 80 caracteres).` }
    const durationMin = Number(row.durationMin)
    if (!Number.isInteger(durationMin) || durationMin < 15 || durationMin > 480) return { error: `La duración de "${id}" debe estar entre 15 y 480 minutos.` }
    services.push({
      id,
      label,
      durationMin,
      price: String(row.price ?? '').trim().slice(0, 60),
      summary: String(row.summary ?? '').trim().slice(0, 300),
    })
  }
  return services
}

function parseHours(raw: unknown): string[][] | Issue {
  if (!Array.isArray(raw) || raw.length !== 7) return { error: 'El horario debe tener siete días (índice 0 = domingo).' }
  const hours: string[][] = []
  for (const [index, day] of raw.entries()) {
    if (!Array.isArray(day)) return { error: `El horario del día ${index} debe ser una lista de franjas.` }
    const ranges: string[] = []
    let previousEnd = -1
    for (const item of day) {
      const range = String(item).trim()
      const match = RANGE.exec(range)
      if (!match) return { error: `Franja inválida en el día ${index}: "${range}". Usa el formato 10:00-20:00.` }
      const from = Number(match[1]) * 60 + Number(match[2])
      const to = Number(match[3]) * 60 + Number(match[4])
      if (to <= from) return { error: `La franja "${range}" termina antes de empezar.` }
      // Franjas ordenadas y sin solaparse: así el cálculo de huecos no necesita normalizar nada.
      if (from < previousEnd) return { error: `Las franjas del día ${index} se solapan o están desordenadas.` }
      previousEnd = to
      ranges.push(range)
    }
    hours.push(ranges)
  }
  return hours
}

function parseByLocation(raw: unknown, field: string, each: (value: unknown, location: Location) => string | number | Issue) {
  if (!raw || typeof raw !== 'object') return { error: `"${field}" debe traer un valor por sede.` }
  const out: Record<string, string | number> = {}
  for (const location of LOCATIONS) {
    const value = each((raw as Record<string, unknown>)[location], location)
    if (typeof value === 'object') return value
    out[location] = value
  }
  return out
}

export async function getConfig(): Promise<AppConfig> {
  const raw = await redis().get<string>(keys.config)
  if (!raw) return DEFAULT_CONFIG
  try {
    const stored = JSON.parse(raw) as Partial<AppConfig>
    const merged = { ...DEFAULT_CONFIG, ...stored, messages: withPresets(stored.messages) }
    // Una config guardada antes de una versión recibe sus cambios al leerla (ver CONFIG_REVISION).
    const config = migrate(merged, Number(stored.revision) || 1)
    const twoForOne = normalizeTwoForOne(config.twoForOne, config.services.map((service) => service.id))
    return { ...config, twoForOne: 'value' in twoForOne ? twoForOne.value : {} }
  } catch {
    return DEFAULT_CONFIG
  }
}

/** Variables que admiten los mensajes prediseñados; una mal escrita saldría tal cual al cliente. */
const PRESET_VARIABLE_NAMES = new Set(Object.keys(PRESET_VARIABLES))

const PRESET_LIMITS: Record<keyof PresetMessages, number> = {
  // El pie de una imagen de WhatsApp admite 1024 caracteres ya con las promociones completas.
  welcomeCaption: 700,
  welcomeValue: 2500,
  welcomeClose: 1500,
  followUpPayment: 1000,
  followUp45: 1000,
  followUp3h: 1000,
  followUp22h: 1000,
}

function parsePresets(raw: unknown): PresetMessages | Issue {
  // Un panel abierto antes de que existieran no los envía: se conservan los de por defecto.
  if (!raw || typeof raw !== 'object') return DEFAULT_PRESETS
  const input = raw as Record<string, unknown>
  const out = { ...DEFAULT_PRESETS }
  for (const id of Object.keys(PRESET_LIMITS) as Array<keyof PresetMessages>) {
    if (input[id] === undefined) continue
    const value = String(input[id]).replace(/\r\n/g, '\n').trim()
    if (!value) return { error: 'Ningún mensaje prediseñado puede quedar vacío (usa "Restaurar" para volver al original).' }
    if (value.length > PRESET_LIMITS[id]) return { error: `Un mensaje prediseñado supera ${PRESET_LIMITS[id]} caracteres.` }
    const unknown = [...value.matchAll(/\{([^{}\s]+)\}/g)].map((match) => match[1]).find((name) => !PRESET_VARIABLE_NAMES.has(name))
    if (unknown) return { error: `La variable {${unknown}} no existe. Revisa la lista de variables debajo de cada mensaje.` }
    out[id] = value
  }
  return out
}

/** Valida campo a campo; ignora claves desconocidas. Devuelve un error legible o la config nueva. */
export function parseConfig(input: unknown): { config: AppConfig } | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'Cuerpo inválido.' }
  const body = input as Record<string, unknown>

  const systemPrompt = str(body, 'systemPrompt', 12000)
  if (typeof systemPrompt === 'object') return systemPrompt
  if (!systemPrompt) return { error: 'Las instrucciones del sistema no pueden estar vacías.' }

  const faq = str(body, 'faq', 4000)
  if (typeof faq === 'object') return faq

  // Un panel abierto antes de que existiera el campo no lo envía: se conserva el texto de la marca.
  const brandInfo = body.brandInfo === undefined ? DEFAULT_BRAND_INFO : str(body, 'brandInfo', 16000)
  if (typeof brandInfo === 'object') return brandInfo

  // Opcional: un panel abierto antes de que existiera el campo no lo envía, y eso no es un error.
  const promo = body.promo === undefined ? '' : str(body, 'promo', 1000)
  if (typeof promo === 'object') return promo

  const payLink = str(body, 'payLink', 500)
  if (typeof payLink === 'object') return payLink
  if (payLink && !/^https:\/\/\S+$/.test(payLink)) return { error: 'El link de pago debe empezar por https://' }

  const nequiInstructions = str(body, 'nequiInstructions', 1500)
  if (typeof nequiInstructions === 'object') return nequiInstructions

  const intlInstructions = str(body, 'intlInstructions', 1500)
  if (typeof intlInstructions === 'object') return intlInstructions

  const services = parseServices(body.services)
  if (!Array.isArray(services)) return services

  // Opcional, como promo. Solo servicios que existen; la fecha es la última sesión incluida.
  const twoForOne = normalizeTwoForOne(body.twoForOne, services.map((service) => service.id))
  if (!('value' in twoForOne)) return twoForOne

  const hours = parseHours(body.hours)
  if (!Array.isArray(hours)) return hours

  const cabins = parseByLocation(body.cabins, 'cabins', (value, location) => {
    const count = Number(value)
    if (!Number.isInteger(count) || count < 1 || count > 10) return { error: `Las cabinas de ${location} deben ser un entero entre 1 y 10.` }
    return count
  })
  if ('error' in cabins) return cabins as Issue

  const addresses = parseByLocation(body.addresses, 'addresses', (value) => String(value ?? '').trim().slice(0, 200))
  if ('error' in addresses) return addresses as Issue

  const numbers = {
    depositPercent: int(body, 'depositPercent', 1, 100),
    slotMinutes: int(body, 'slotMinutes', 5, 60),
    leadTimeHours: int(body, 'leadTimeHours', 0, 72),
    horizonDays: int(body, 'horizonDays', 1, 90),
    holdMinutes: int(body, 'holdMinutes', 15, 2880),
  }
  for (const value of Object.values(numbers)) if (typeof value === 'object') return value
  // Opcional: un panel abierto antes de que existiera el campo no lo envía (queda apagado).
  const cashBooking = body.cashBooking === true
  // Opcional: un panel abierto antes de que existiera el campo no lo envía (queda en 0, el porcentaje).
  const depositFixed = body.depositFixed === undefined || body.depositFixed === '' ? 0 : int(body, 'depositFixed', 0, 5_000_000)
  if (typeof depositFixed === 'object') return depositFixed
  const depositPerk = body.depositPerk === undefined ? DEFAULT_DEPOSIT_PERK : str(body, 'depositPerk', 200)
  if (typeof depositPerk === 'object') return depositPerk
  const messages = parsePresets(body.messages)
  if ('error' in messages) return messages as Issue

  // Una duración que no es múltiplo de la grilla dejaría huecos imposibles de reservar.
  const slot = numbers.slotMinutes as number
  const offending = services.find((service) => service.durationMin % slot !== 0)
  if (offending) return { error: `La duración de "${offending.label}" (${offending.durationMin} min) debe ser múltiplo de la grilla de ${slot} min.` }

  return {
    config: {
      revision: CONFIG_REVISION,
      systemPrompt,
      faq,
      brandInfo,
      promo,
      twoForOne: twoForOne.value,
      payLink,
      nequiInstructions,
      intlInstructions,
      services,
      hours,
      cabins: cabins as Record<Location, number>,
      addresses: addresses as Record<Location, string>,
      depositPercent: numbers.depositPercent as number,
      depositFixed,
      cashBooking,
      depositPerk,
      messages,
      slotMinutes: slot,
      leadTimeHours: numbers.leadTimeHours as number,
      horizonDays: numbers.horizonDays as number,
      holdMinutes: numbers.holdMinutes as number,
    },
  }
}

export async function saveConfig(config: AppConfig) {
  await redis().set(keys.config, JSON.stringify(config))
}

/**
 * Códigos que tenían los servicios de Premier antes de llamarse como el servicio (17 oct 2026). No
 * coincidían con los nombres (`valoracion` era el Peeling, `limpieza-basica` era Pigmentación) y el
 * modelo se equivocaba de servicio al reservar. Siguen valiendo para citas y fichas ya guardadas.
 */
export const LEGACY_SERVICE_IDS: Record<string, string> = {
  valoracion: 'peeling-hidratacion',
  'limpieza-basica': 'pigmentacion',
  'limpieza-profunda': 'lineas-expresion',
  'hidratacion-mineral': 'hidratacion-profunda',
}

export function serviceById(config: AppConfig, id: string): Service | undefined {
  return config.services.find((service) => service.id === id)
    ?? (LEGACY_SERVICE_IDS[id] ? config.services.find((service) => service.id === LEGACY_SERVICE_IDS[id]) : undefined)
}

const slug = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/**
 * El servicio que pidió Gema en [[RESERVA]]: por id y, si no existe, por nombre. Los ids son
 * y el modelo a veces escribe el nombre
 * convertido en id (`limpieza-peeling-gel`). Si el nombre no coincide exacto (la voz del panel y
 * el catálogo pueden nombrarlo distinto: "Peeling Gel" / "Peeling y Hidratación"), acepta el
 * servicio cuyo nombre comparte más palabras iniciales, solo si son 2 o más y no hay empate.
 */
export function resolveService(config: AppConfig, raw: string): Service | undefined {
  const wanted = slug(raw)
  const exact = serviceById(config, raw) ?? config.services.find((service) => slug(service.label) === wanted)
  if (exact) return exact
  const words = wanted.split('-')
  const shared = (label: string) => {
    const other = slug(label).split('-')
    let count = 0
    while (count < words.length && words[count] === other[count]) count++
    return count
  }
  const scored = config.services.map((service) => ({ service, score: shared(service.label) })).sort((a, b) => b.score - a.score)
  const [best, second] = scored
  return best && best.score >= 2 && best.score !== second?.score ? best.service : undefined
}

/**
 * Cobro que aplica a este cliente según su país. Es la única fuente: la usa el prompt para
 * contarle a Gema qué métodos existen, y la usa el servidor para pegar los datos reales
 * cuando la cabina ya quedó apartada.
 */
export function paymentFor(config: AppConfig, region: Region) {
  const colombia = region === 'CO'
  /**
   * Con Bold configurado, cada reserva genera su propio link (ver lib/bold.ts), también para
   * clientes de fuera: Bold acepta tarjetas de crédito internacionales y cobra en pesos.
   */
  const bold = Boolean(process.env.BOLD_API_KEY)
  const instructions = colombia ? config.nequiInstructions : config.intlInstructions
  return {
    currency: colombia || bold ? 'pesos colombianos (COP)' : 'dólares estadounidenses (USD)',
    methods: bold
      ? colombia
        ? `link de pago de Bold (PSE, tarjeta débito o crédito, Nequi o Daviplata)${instructions ? ' o transferencia directa a Premier (Nequi, Daviplata o cuenta de ahorros Bancolombia) con envío del comprobante' : ''}`
        : `link de pago de Bold con tarjeta de crédito internacional (se cobra en pesos colombianos y su banco hace la conversión)${instructions ? ' o, si lo prefiere, los medios internacionales de Premier' : ''}`
      : colombia
        ? 'Nequi, Bancolombia o Daviplata'
        : 'Binance (USDT), PayPal, transferencia Wise o ACH vía DolarApp',
    instructions,
    bold,
    get configured() { return Boolean(config.payLink || this.instructions || this.bold) },
  }
}

/** Número a partir de un precio escrito ("$130.000", "130000"). 0 si no tiene un número legible. */
export function amountOf(price: string): number {
  const digits = price.replace(/[^\d]/g, '')
  return digits ? Number(digits) : 0
}

export function pesos(amount: number): string {
  return `$${amount.toLocaleString('es-CO')}`
}

/**
 * Anticipo como número a partir del precio de la cita (una sesión o la pareja). 0 si el precio no
 * tiene un número legible. Con anticipo fijo es ese valor por cita, sin pasar del precio.
 */
export function depositAmount(config: AppConfig, price: string): number {
  const amount = amountOf(price)
  if (config.depositFixed > 0) return Math.min(config.depositFixed, amount)
  return Math.round((amount * config.depositPercent) / 100)
}

/** Anticipo en texto a partir del precio configurado. Vacío si el precio no tiene un número legible. */
export function depositOf(config: AppConfig, price: string): string {
  const amount = depositAmount(config, price)
  return amount ? pesos(amount) : ''
}

/** Algún servicio tiene el 2x1 vigente para sesiones de hoy (o sin fecha de fin). */
export function twoForOneLive(config: AppConfig, today: string): boolean {
  return Object.keys(config.twoForOne).some((id) => twoForOneApplies(config, id, today))
}

/** Dos personas a la misma hora pagan una sola sesión: el servicio entra en el 2x1 y la sesión es antes de su fecha de fin. */
export function twoForOneApplies(config: AppConfig, serviceId: string, day: string): boolean {
  if (!(serviceId in config.twoForOne)) return false
  const until = config.twoForOne[serviceId]
  return !until || day <= until
}

/**
 * Valor total de una cita: una sesión por persona, salvo pareja con 2x1 (una sola sesión).
 * Lo calcula el servidor, nunca el modelo.
 */
export function bookingPrice(config: AppConfig, service: Service, people: number, day: string): string {
  const sessions = people > 1 && !twoForOneApplies(config, service.id, day) ? people : 1
  if (sessions === 1) return service.price
  const amount = amountOf(service.price)
  return amount ? String(amount * sessions) : ''
}
