/**
 * Carga .env.local a mano para los scripts sueltos de esta carpeta.
 * Next.js lo hace solo para `next dev`/`next build`, pero un script ejecutado
 * con `tsx` corre fuera de ese proceso y no lo ve. No añade una dependencia
 * (dotenv) para algo tan simple: KEY=VALUE por línea, sin interpolación.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function loadEnvLocal() {
  let raw: string
  try {
    raw = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
  } catch {
    return // Sin .env.local: los scripts fallarán más abajo con un mensaje claro (ConfigError de lib/redis.ts).
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    // No pisa variables que ya vengan del entorno real (CI, shell, etc.).
    if (!(key in process.env)) process.env[key] = value
  }
}
