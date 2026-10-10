/**
 * Links de pago de Bold, producto "API Link de pagos".
 * Docs: https://developers.bold.co/pagos-en-linea/api-link-de-pagos
 *
 * Ojo, no confundir con "API Integrations" (POST /payments/app-checkout): ese endpoint le
 * ordena a un datáfono físico que inicie el cobro —por eso exige terminal_model y
 * terminal_serial— y solo responde un integration_id, sin ninguna URL. Para mandarle un link
 * al cliente por WhatsApp el producto correcto es este, que devuelve la URL de checkout.
 */

const API = 'https://integrations.api.bold.co'
const REQUEST_TIMEOUT_MS = 10_000

type LinkResponse = {
  payload?: { payment_link?: string; url?: string }
  // Formato observado en una respuesta real: [{ errors: "The sale amount...", code: "PL_001" }].
  errors?: Array<{ message?: string; errors?: string; code?: string } | string>
  // El gateway de Bold responde los rechazos de autenticación con su propio formato.
  Message?: string
  message?: string
}

/** Bold acepta solo letras, números, "_" y "-", máximo 60 caracteres, y la referencia debe ser única. */
function boldReference(referenciaCliente: string | number): string {
  const base = String(referenciaCliente).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'premier'
  // El timestamp la hace única aunque el mismo cliente pida dos links (40 + 1 + 13 = 54 caracteres).
  return `${base}-${Date.now()}`
}

/** El motivo real del rechazo: Bold no siempre usa errors[], así que si no hay mensaje conocido va el cuerpo crudo. */
function errorText(data: LinkResponse | null, status: number): string {
  const first = data?.errors?.[0]
  if (typeof first === 'string') return first
  const detail = first?.errors ?? first?.message
  if (detail) return first?.code ? `[${first.code}] ${detail}` : detail
  const known = data?.Message ?? data?.message
  if (known) return known
  return data ? JSON.stringify(data).slice(0, 300) : `Bold respondió ${status} sin cuerpo`
}

/**
 * Crea un link de pago de monto cerrado en COP y devuelve la URL para mandarle al cliente.
 *
 * Nunca lanza: si algo falla (llave inválida, Bold caído, datos rechazados) registra el motivo
 * y devuelve null, para que el bot pase la conversación a un asesor en vez de romperse.
 *
 * No envía expiration_date: la documentación dice que va en nanosegundos, pero su propio
 * ejemplo trae milisegundos. Hasta confirmar la unidad con Bold, el link usa la vigencia por defecto.
 */
export async function generarLinkPagoBold(monto: number, descripcion: string, referenciaCliente: string | number): Promise<string | null> {
  const apiKey = process.env.BOLD_API_KEY
  if (!apiKey) {
    console.error('[bold] Falta BOLD_API_KEY: no se puede generar el link de pago.')
    return null
  }
  if (!Number.isFinite(monto) || monto <= 0) {
    console.error(`[bold] Monto inválido: ${monto}`)
    return null
  }
  // Bold exige una descripción de 2 a 100 caracteres.
  const description = descripcion.trim().slice(0, 100)
  if (description.length < 2) {
    console.error('[bold] La descripción debe tener al menos 2 caracteres.')
    return null
  }

  try {
    const response = await fetch(`${API}/online/link/v1`, {
      method: 'POST',
      headers: { Authorization: `x-api-key ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_type: 'CLOSE',
        // Sin IVA discriminado: si Premier factura servicios con IVA, se agrega aquí como { type: 'VAT', base, value }.
        amount: { currency: 'COP', taxes: [], tip_amount: 0, total_amount: Math.round(monto) },
        reference: boldReference(referenciaCliente),
        description,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const data = await response.json().catch(() => null) as LinkResponse | null

    if (!response.ok) {
      console.error(`[bold] No se pudo crear el link (${response.status}): ${errorText(data, response.status)}`)
      return null
    }
    const url = data?.payload?.url
    if (!url?.startsWith('https://')) {
      console.error('[bold] Bold respondió sin URL de pago:', JSON.stringify(data).slice(0, 300))
      return null
    }
    return url
  } catch (error) {
    // Errores de transporte (timeout, DNS, red caída), no respuestas de Bold.
    console.error('[bold] Error de red al llamar a Bold:', error instanceof Error ? error.message : error)
    return null
  }
}
