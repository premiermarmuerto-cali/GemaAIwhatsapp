#!/usr/bin/env -S npx tsx
/**
 * Llena la agenda y la bandeja con datos de ejemplo para poder ver el panel en uso.
 * Usa las mismas funciones que usa el sistema en producción (createBooking, moveBooking,
 * recordInbound…), así que todo lo que crea pasa por las mismas validaciones y queda
 * exactamente en la forma que el resto del código espera.
 *
 * Uso:
 *   npm run seed:agenda
 *
 * Requiere UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN en .env.local.
 * No necesita OPENAI_API_KEY: no se le pide nada a Gema, solo se escribe en Redis.
 *
 * Es seguro correrlo más de una vez: los horarios de la corrida anterior ya están
 * ocupados, así que las citas que choquen simplemente se reportan como "ya existía"
 * en vez de duplicarse o fallar el script entero.
 */
import { loadEnvLocal } from './load-env'
loadEnvLocal()

import { attachBooking, deleteChat, getSummary, recordInbound, requestAgent, saveLead } from '../lib/chats'
import { bookingsOfPhone, createBooking, markDepositClaimed, moveBooking } from '../lib/booking'
import { addDays, dayKey } from '../lib/calendar'
import { DEFAULT_SERVICES } from '../lib/clinic'
import { DEFAULT_CONFIG, getConfig, saveConfig } from '../lib/config'
import { hasRedis } from '../lib/redis'
import { LIVE_STATUSES, type AppConfig, type BookingStatus, type Location, type Service } from '../lib/types'

if (!hasRedis()) {
  console.error('❌ Falta configurar Upstash. Pon UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN en .env.local')
  console.error('   (gratis en https://console.upstash.com → Create Database → pestaña REST API).')
  process.exit(1)
}

// ─────────────────────────── Config de ejemplo ───────────────────────────

/** Precios de muestra en COP. Mismos ids que lib/clinic.ts: un servicio sin precio aquí se deja igual. */
const DEMO_PRICES: Record<string, string> = {
  valoracion: '$0 (cortesía)',
  'limpieza-basica': '$120.000',
  'limpieza-profunda': '$180.000',
  'hidratacion-mineral': '$160.000',
  'anti-acne': '$220.000',
}

/** Solo se aplica si la config nunca se tocó: nunca pisa precios o datos reales ya configurados. */
function isUntouched(config: AppConfig): boolean {
  return !config.payLink && !config.nequiInstructions && !config.intlInstructions && config.services.every((service) => !service.price)
}

async function seedDemoConfig(): Promise<AppConfig> {
  const current = await getConfig()
  if (!isUntouched(current)) {
    console.log('ℹ️  La configuración ya fue personalizada: no se toca. Se siembran las citas con lo que ya hay.')
    return current
  }

  const services: Service[] = DEFAULT_SERVICES.map((service) => ({ ...service, price: DEMO_PRICES[service.id] ?? service.price }))
  const demo: AppConfig = {
    ...DEFAULT_CONFIG,
    services,
    payLink: 'https://pago.ejemplo.com/anticipo-premier', // ⚠️ placeholder: cámbialo por el link real antes de usar esto con clientes.
    nequiInstructions: 'Nequi 311 464 4721 a nombre de Premier Mar Muerto. Envía el comprobante con la hora exacta de la transacción.',
    intlInstructions: 'Binance Pay ID: premier-demo · PayPal: pagos@ejemplo.com · Wise: solicítalo por este chat.',
  }
  await saveConfig(demo)
  console.log('✅ Se cargó una configuración de ejemplo (precios, Nequi y link de pago de prueba).')
  console.log('   ⚠️  Son datos ficticios. Cámbialos en el panel → Configuración antes de atender clientes reales.')
  return demo
}

// ─────────────────────────── Citas de ejemplo ───────────────────────────

type Seed = {
  phone: string
  name: string
  location: Location
  serviceId: string
  dayOffset: number // días desde hoy
  start: string
  concern: string
  finalStatus: BookingStatus
  /** Simula que el cliente ya mandó el comprobante (aparece en la cola de "esperando validación"). */ claimedPayment?: boolean
  /** Sin chat de WhatsApp detrás: representa una cita agendada a mano por el operador. */ skipChat?: boolean
  source?: 'bot' | 'operator'
}

const SEEDS: Seed[] = [
  { phone: '573000000011', name: 'Valentina Rojas', location: 'unicentro', serviceId: 'limpieza-basica', dayOffset: 1, start: '10:00', concern: 'poros abiertos y puntos negros', finalStatus: 'confirmed' },
  { phone: '573000000012', name: 'Camila Torres', location: 'unicentro', serviceId: 'limpieza-profunda', dayOffset: 1, start: '11:00', concern: 'piel grasa y brillo excesivo', finalStatus: 'pending_payment', claimedPayment: true },
  { phone: '573000000013', name: 'Mariana Gómez', location: 'unicentro', serviceId: 'anti-acne', dayOffset: 1, start: '15:00', concern: 'acné en la zona de la mandíbula', finalStatus: 'done' },
  { phone: '573000000014', name: 'Daniela Ríos', location: 'chipichape', serviceId: 'hidratacion-mineral', dayOffset: 2, start: '10:30', concern: 'resequedad y piel apagada', finalStatus: 'hold' },
  { phone: '573000000015', name: 'Laura Jiménez', location: 'chipichape', serviceId: 'valoracion', dayOffset: 2, start: '12:00', concern: 'primera vez, quiere que la evalúen', finalStatus: 'confirmed' },
  { phone: '573000000016', name: 'Isabella Martínez', location: 'chipichape', serviceId: 'limpieza-basica', dayOffset: 2, start: '16:00', concern: 'mantenimiento mensual', finalStatus: 'no_show' },
  { phone: '573000000017', name: 'Sofía Castro', location: 'unicentro', serviceId: 'limpieza-profunda', dayOffset: 3, start: '11:00', concern: 'manchas y textura irregular', finalStatus: 'pending_payment' },
  { phone: '573000000018', name: 'Gabriela Ortiz', location: 'chipichape', serviceId: 'anti-acne', dayOffset: 4, start: '14:00', concern: 'la agendó el equipo por teléfono', finalStatus: 'confirmed', skipChat: true, source: 'operator' },
]

/** Camino de transiciones hasta el estado final (ver TRANSITIONS en lib/booking.ts): sin atajos directos. */
function pathTo(status: BookingStatus): BookingStatus[] {
  if (status === 'confirmed') return ['confirmed']
  if (status === 'done') return ['confirmed', 'done']
  if (status === 'no_show') return ['confirmed', 'no_show']
  return [] // pending_payment y hold ya quedan bien desde la creación, no transicionan.
}

async function seedOne(config: AppConfig, seed: Seed) {
  const day = addDays(dayKey(), seed.dayOffset)
  const label = `${seed.name} · ${day} ${seed.start} · ${seed.location}`

  // Idempotencia: si este teléfono demo ya tiene una cita de una corrida anterior…
  const [existing] = await bookingsOfPhone(seed.phone, 1)
  if (existing) {
    if (existing.status === seed.finalStatus) {
      console.log(`  ✓  ${label} — ya estaba en "${seed.finalStatus}", no se toca`)
      return
    }
    // …y quedó mal (p. ej. una transición que falló), se libera el horario y se recrea bien.
    // Si ya estaba en un estado terminal (done/no_show) no se puede deshacer: queda huérfana para auditoría.
    if (LIVE_STATUSES.includes(existing.status)) await moveBooking(existing.id, 'cancelled')
    if (await getSummary(seed.phone)) await deleteChat(seed.phone)
  }

  if (!seed.skipChat) {
    await recordInbound(seed.phone, { id: crypto.randomUUID(), sender: 'user', text: `Hola, quisiera agendar por lo de ${seed.concern}`, at: Date.now() }, seed.name)
    await saveLead(seed.phone, { concern: seed.concern, serviceId: seed.serviceId, location: seed.location })
  }

  const result = await createBooking(config, {
    phone: seed.phone,
    name: seed.name,
    location: seed.location,
    serviceId: seed.serviceId,
    day,
    start: seed.start,
    concern: seed.concern,
    source: seed.source ?? 'bot',
    // "hold" se crea directo en ese estado; todo lo demás arranca en pending_payment y transiciona abajo.
    status: seed.finalStatus === 'hold' ? 'hold' : 'pending_payment',
  })

  if (!result.ok) {
    console.log(`  ⏭️  ${label} — ${result.reason === 'taken' ? 'ese horario ya está ocupado' : result.reason}`)
    return
  }

  const { booking } = result
  if (!seed.skipChat) await attachBooking(seed.phone, booking.id, { name: seed.name, serviceId: seed.serviceId, location: seed.location })

  if (seed.claimedPayment) {
    await markDepositClaimed(booking.id, config)
    if (!seed.skipChat) await requestAgent(seed.phone, 'Comprobante recibido (dato de ejemplo)', 'payment')
  }

  for (const status of pathTo(seed.finalStatus)) {
    const moved = await moveBooking(booking.id, status)
    if (moved && 'error' in moved) console.warn(`     ⚠️  no se pudo pasar a "${status}": ${moved.error}`)
  }

  console.log(`  ✅ ${label} — ${seed.finalStatus}${booking.price ? ` · ${booking.price}` : ''}`)
}

async function main() {
  console.log('🌱 Sembrando datos de ejemplo…\n')
  const config = await seedDemoConfig()
  console.log('\n📅 Creando citas de muestra:')
  for (const seed of SEEDS) await seedOne(config, seed)
  console.log('\nListo. Abre /agenda — el rango queda entre mañana y los próximos días, en las dos sedes.')
}

main().catch((error) => {
  console.error('\n❌ Falló la siembra:', error instanceof Error ? error.message : error)
  process.exit(1)
})
