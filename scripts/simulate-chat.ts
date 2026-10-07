#!/usr/bin/env -S npx tsx
/**
 * Simula una conversación de WhatsApp con Gema sin pasar por Meta: inyecta el mensaje
 * directo en Redis (lo mismo que haría el webhook) y corre el mismo turno de IA
 * (lib/autoreply.ts → replyOnce), pero con el envío real sustituido por un `console.log`.
 * Todo lo demás —el prompt, la disponibilidad real, las marcas [[RESERVA]]/[[PAGO]]/
 * [[ASESOR]]/[[FICHA]], la reserva atómica de la cabina— es el código de producción tal cual.
 *
 * Uso:
 *   npm run simulate -- 573001112233 "Hola, quiero una limpieza facial"   (un solo mensaje)
 *   npm run simulate -- 573001112233                                      (modo conversación)
 *   npm run simulate -- 573001112233 --name "Laura Gómez" "Hola"          (le da el nombre de una vez)
 *
 * Requiere UPSTASH_REDIS_REST_URL/TOKEN y OPENAI_API_KEY en .env.local.
 * Si además corriste `npm run seed:agenda`, Gema ya tiene precios y datos de pago
 * de ejemplo para poder completar una reserva de principio a fin.
 */
import { createInterface } from 'node:readline/promises'
import { loadEnvLocal } from './load-env'
loadEnvLocal()

import { replyOnce } from '../lib/autoreply'
import { getBooking } from '../lib/booking'
import { getSummary, recordInbound } from '../lib/chats'
import { isValidPhone, normalizePhone } from '../lib/phone'
import { hasRedis } from '../lib/redis'
import type { Message } from '../lib/types'

if (!hasRedis()) {
  console.error('❌ Falta configurar Upstash. Pon UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN en .env.local.')
  process.exit(1)
}
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ Falta OPENAI_API_KEY en .env.local: sin eso Gema no puede generar respuestas.')
  process.exit(1)
}

function parseArgs(argv: string[]) {
  const args = [...argv]
  let name: string | undefined
  const nameFlag = args.indexOf('--name')
  if (nameFlag !== -1) { name = args[nameFlag + 1]; args.splice(nameFlag, 2) }
  const [rawPhone, ...rest] = args
  return { phone: normalizePhone(rawPhone ?? ''), message: rest.join(' ').trim(), name }
}

const { phone, message: firstMessage, name } = parseArgs(process.argv.slice(2))
if (!isValidPhone(phone)) {
  console.error('❌ Dame un teléfono válido como primer argumento, p. ej.: npm run simulate -- 573001112233')
  process.exit(1)
}

/** Reemplaza sendWhatsAppText: solo imprime lo que Gema habría enviado. */
async function fakeSend(to: string, body: string) {
  console.log(`\n🤖 Gema ›\n${body}\n`)
  return crypto.randomUUID()
}

/** Un turno completo: guarda el mensaje del cliente, corre a Gema y resume lo que cambió. */
async function turn(text: string) {
  const message: Message = { id: crypto.randomUUID(), sender: 'user', text, at: Date.now() }
  await recordInbound(phone, message, name)
  await replyOnce(phone, { send: fakeSend })
  await recap()
}

async function recap() {
  const chat = await getSummary(phone)
  if (!chat) return
  const bits = [
    chat.lead.concern && `motivo: ${chat.lead.concern}`,
    chat.lead.serviceId && `servicio: ${chat.lead.serviceId}`,
    chat.lead.location && `sede: ${chat.lead.location}`,
  ].filter(Boolean)
  if (bits.length) console.log(`   📋 ficha — ${bits.join(' · ')}`)
  if (chat.needsAgent) console.log(`   ⚠️  pasó a un asesor (${chat.agentKind}) — ${chat.agentReason}`)
  if (chat.bookingId) {
    const booking = await getBooking(chat.bookingId)
    if (booking) console.log(`   📅 cita ${booking.id} — ${booking.day} ${booking.start} · ${booking.location} · ${booking.serviceLabel} · estado: ${booking.status}`)
  }
}

async function main() {
  console.log(`Simulando conversación con ${phone}${name ? ` (${name})` : ''}. Ctrl+C para salir.\n`)

  if (firstMessage) {
    console.log(`👤 Cliente › ${firstMessage}`)
    await turn(firstMessage)
    return
  }

  console.log('Modo conversación: escribe como si fueras el cliente. "salir" para terminar.\n')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  for (;;) {
    const line = (await rl.question('👤 Cliente › ')).trim()
    if (!line) continue
    if (['salir', 'exit', 'quit'].includes(line.toLowerCase())) break
    await turn(line)
  }
  rl.close()
}

main().catch((error) => {
  console.error('\n❌ Error en la simulación:', error instanceof Error ? error.message : error)
  process.exit(1)
})
