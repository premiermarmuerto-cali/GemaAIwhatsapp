/**
 * Textos por defecto de los mensajes prediseñados (lib/presets.ts). Salen de la base de conocimiento
 * de Premier (training mds, 20 oct 2026): el ritual de 5 pasos, la limpieza cero invasiva, el dolor
 * de cada piel y la urgencia real del 2x1. Se editan en el panel (Configuración → Mensajes
 * prediseñados); este archivo es el punto de partida y el botón "Restaurar".
 *
 * Reglas del formato:
 *   {variable}  la completa el servidor (ver PRESET_VARIABLES en lib/presets.ts)
 *   |||         parte el texto en varios mensajes de WhatsApp
 *   párrafo     si una variable de bloque ({horarios}, {cortesia}…) queda vacía, se quita su párrafo
 */
import type { PresetId, PresetMessages } from './types'

export const DEFAULT_PRESETS: PresetMessages = {
  welcomeCaption: [
    'Hola {nombre}, qué bueno que nos escribes 💛 Soy Gema, de Premier Mar Muerto · Cali.',
    '',
    '*{promos_titulo}* 👇',
    '',
    '{promos}',
  ].join('\n'),

  welcomeValue: [
    'Y ojo, que esto no es una limpieza básica de spa ✨ Cada sesión es un *ritual de 5 pasos en cabina* con productos Premier del Mar Muerto, de gama alta en Europa:',
    '',
    '1️⃣ Diagnóstico de tu piel y limpieza con pH 5.5',
    '2️⃣ Mascarilla estrella del Mar Muerto',
    '3️⃣ Contorno de ojos Prestige para ojeras y bolsas',
    '4️⃣ Sueros en rostro y cuello con drenaje linfático que desinflama y esculpe',
    '5️⃣ Sellado con la crema ideal para tu edad',
    '',
    'Y es *cero invasiva*: no espichamos tu cara ni te dejamos roja. Las mascarillas sacan la grasa y los puntos negros sin maltratar tu piel 🌿',
    '',
    '{tratamientos}',
  ].join('\n'),

  welcomeClose: [
    'Para separar tu espacio dejas un anticipo de solo *{anticipo}*, que *se descuenta del valor* de tu limpieza (pago seguro por link o transferencia). El resto lo pagas en la sede: {sedes}.',
    '',
    '🎁 Si agendas hoy, te regalamos {cortesia}.',
    '',
    'Para venir con tu acompañante tengo libre:',
    '{horarios}',
    '',
    '{pregunta_cierre}',
  ].join('\n'),

  // Sin plazos ni minutos (Premier, 23 oct): solo un recordatorio amable.
  followUpPayment: [
    'Hola {nombre} 🌿 te escribo para recordarte el anticipo de {anticipo} de tu cita del {cita}, así te la dejamos agendada',
    'es un pago seguro y se descuenta del valor de tu limpieza. {cortesia_frase}',
    'tuviste algún inconveniente con el link o prefieres que te mueva el cupo a otro día?',
  ].join('|||'),

  followUp45: [
    'Hola {nombre} ✨ me quedé pensando en lo que hablamos. No dejes que el calor de Cali, el brillo o el cansancio en la mirada sigan apagando tu piel. {vigencia}',
    'tu sesión trae el ritual completo de 5 pasos: contorno de ojos, sueros de vitaminas hasta el cuello y drenaje linfático para desinflamar tu rostro',
    'te puedo separar {hora_sugerida}, te lo aparto?',
  ].join('|||'),

  followUp3h: [
    '{nombre}, te cuento algo que casi nadie sabe: nuestra limpieza es *cero invasiva*. No espichamos la cara ni te dejamos roja, las mascarillas del Mar Muerto sacan la grasa y los puntos negros sin maltratar tu piel',
    '{promo_recordatorio}',
    '{pregunta_sede}',
  ].join('|||'),

  followUp22h: [
    'Hola {nombre}, paso por aquí una última vez antes de que se cierre nuestro chat ⏳ Si quieres darle un respiro real a tu rostro, con contorno de ojos y drenaje linfático incluidos, todavía estás a tiempo de {promo_corta}',
    '{cierre_sede}',
  ].join('|||'),

  bookingConfirmed: [
    '¡Listo, {nombre}! Tu cita quedó agendada 💛 Gracias por confiar en Premier Mar Muerto',
    [
      '📅 {fecha} a las {hora} {pareja}',
      '✨ {servicio}',
      '📍 {sede}: {direccion}',
      '{pago}',
    ].join('\n'),
    [
      'Para que aproveches al máximo tu sesión:',
      '▪️ Llega 10 minutos antes',
      '▪️ Ven con el rostro limpio, sin maquillaje',
      '▪️ Los 2 días antes evita exfoliantes, ácidos o retinol',
      'Cualquier cambio me escribes por aquí 🌿',
    ].join('\n'),
  ].join('|||'),

  holdReleased: [
    'Hola {nombre} 🌿 como todavía no nos llegó el anticipo, por políticas internas liberamos el espacio que tenías reservado el {cita}',
    'nos encantará atenderte: cuando quieras agendar tu sesión, escríbeme por aquí y con gusto te busco un espacio ✨',
  ].join('|||'),
}

/** Texto de la v1.9 del aviso de anticipo sin pagar (decía los minutos que quedaban). Se reemplaza si nadie lo editó. */
export const LEGACY_FOLLOW_UP_PAYMENT = [
  'Hola {nombre} 🌿 tu horario del {cita} sigue apartado {minutos} minutos más, pero todavía no me aparece el anticipo de {anticipo}',
  'es un pago seguro y se descuenta del valor de tu limpieza. {cortesia_frase}',
  'tuviste algún inconveniente con el link o prefieres que te mueva el cupo a otro día?',
].join('|||')

/**
 * Textos de la v1.4 de los seguimientos de 45 min y 22 h. La migración de la configuración (lib/config.ts)
 * los reemplaza por los nuevos SOLO si siguen idénticos: si el operador los editó, no se tocan.
 */
export const LEGACY_FOLLOW_UP_45 = [
  'Hola {nombre} ✨ me quedé pensando en lo que hablamos. No dejes que el calor de Cali, el brillo o el cansancio en la mirada sigan apagando tu piel',
  'tu sesión trae el ritual completo de 5 pasos: contorno de ojos, sueros de vitaminas hasta el cuello y drenaje linfático para desinflamar tu rostro. {vigencia}',
  'te puedo separar {hora_sugerida}, te lo aparto?',
].join('|||')
export const LEGACY_FOLLOW_UP_22H = [
  'Hola {nombre}, paso por aquí una última vez antes de que se cierre nuestro chat ⏳ Si quieres darle un respiro real a tu rostro, con contorno de ojos y drenaje linfático incluidos, todavía estás a tiempo de {promo_corta}',
  'escríbeme *SEDE* y te guardo uno de los espacios de esta semana en Unicentro o Chipichape',
].join('|||')

/** Lo que el panel muestra de cada mensaje: nombre, cuándo sale y qué variables usa de verdad. */
export const PRESET_INFO: Record<PresetId, { label: string; when: string }> = {
  welcomeCaption: { label: 'Bienvenida 1 · imagen del 2x1', when: 'Apenas escribe un cliente nuevo, con la imagen del bono. Máx. 1024 caracteres ya completo.' },
  welcomeValue: { label: 'Bienvenida 2 · el valor', when: 'Justo después de la imagen.' },
  welcomeClose: { label: 'Bienvenida 3 · cierre con horarios', when: 'Después del valor. Termina con una sola pregunta.' },
  followUpPayment: { label: 'Anticipo sin pagar', when: 'Unas 4 h antes de que se libere una reserva sin anticipo (si cae de noche, antes de las 9 p.m.). No menciona plazos.' },
  followUp45: { label: 'Seguimiento 45 min', when: '~45 min sin respuesta, sin cita. No sale si no hay ningún horario libre.' },
  followUp3h: { label: 'Seguimiento 3 h', when: '~3 h sin respuesta, sin cita.' },
  followUp22h: { label: 'Seguimiento 22 h', when: '~22 h sin respuesta: el último antes de que se cierre la ventana de 24 h.' },
  holdReleased: { label: 'Reserva liberada', when: 'Cuando se libera una reserva sin anticipo: unos minutos antes de que se cierre la ventana de WhatsApp (o al terminar su renovación), o si otro cliente tomó el horario mientras estaba renovada.' },
  bookingConfirmed: { label: 'Cita agendada', when: 'Cuando queda confirmada una cita de Gema: anticipo validado en el panel, pago por Bold o cita en efectivo. No sale en las citas que agenda el equipo.' },
}

/** Variables disponibles, con su explicación (se listan en el panel). */
export const PRESET_VARIABLES: Record<string, string> = {
  nombre: 'primer nombre del cliente (vacío si no se sabe)',
  promos_titulo: '"HOY tenemos activas dos promociones 2×1"',
  promos: 'una línea por cada 2x1 vigente, con precio y días que quedan',
  tratamientos: 'qué resuelve cada limpieza en promoción',
  anticipo: 'el anticipo para separar ($25.000)',
  cortesia: 'la cortesía por agendar con anticipo',
  cortesia_frase: '"Y con tu anticipo te llevas de cortesía …"',
  sedes: 'las dos sedes con su dirección',
  horarios: 'horas libres para dos personas (con una cabina, sesiones seguidas), por sede',
  pregunta_cierre: '"Cuál te separo?" (o la sede, si no hay horarios)',
  hora_sugerida: 'una hora libre concreta ("mañana a las 10:00 a.m. en Chipichape")',
  vigencia: '"Y con el 2x1 la segunda sesión va de cortesía, solo hasta el 31 de octubre"',
  promo_recordatorio: 'recordatorio del 2x1 del servicio que le interesa',
  promo_corta: '"asegurar tu 2x1: pagas una limpieza y la segunda va de cortesía"',
  pregunta_sede: 'la pregunta de sede (o de horario, si ya la eligió)',
  cierre_sede: '"escríbeme SEDE…" si no sabemos su sede; si ya la dijo, "escríbeme SÍ y te guardo un espacio en <su sede>"',
  cita: 'la cita apartada ("miércoles 22 oct a las 3:00 p.m. en Chipichape")',
  minutos: 'minutos que le quedan al apartado',
  fecha: 'día de la cita ("martes 27 oct")',
  hora: 'hora de la cita ("10:00 a.m.")',
  pareja: 'en el 2x1 con una cabina, las dos horas: "(una después de la otra: 10:00 a.m. y 11:00 a.m.)"',
  servicio: 'la limpieza agendada (con "· 2 personas" en el 2x1)',
  sede: 'la sede de la cita',
  direccion: 'la dirección de esa sede',
  pago: 'lo que ya pagó y lo que falta ("Tu anticipo de $25.000 ya quedó abonado: en la sede pagas $105.000")',
}
