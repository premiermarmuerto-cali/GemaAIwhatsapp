/**
 * Datos fijos del negocio: sedes, zona horaria y catálogo por defecto.
 * Todo lo que el operador puede cambiar vive en `pm:config` (ver lib/config.ts);
 * aquí solo están las constantes que el código necesita para existir.
 */
import type { Location, Service } from './types'

/** Colombia no tiene horario de verano: el offset es fijo y se puede usar para construir fechas. */
export const CLINIC_TZ = process.env.CLINIC_TIMEZONE || 'America/Bogota'
export const CLINIC_UTC_OFFSET = process.env.CLINIC_UTC_OFFSET || '-05:00'

export const LOCATIONS: Location[] = ['unicentro', 'chipichape']

export const LOCATION_LABEL: Record<Location, string> = {
  unicentro: 'Unicentro',
  chipichape: 'Chipichape',
}

export const DEFAULT_ADDRESSES: Record<Location, string> = {
  unicentro: 'C.C. Unicentro, local 222',
  chipichape: 'C.C. Chipichape, local 9-111',
}

/** Una cabina por sede mientras no se configure otra cosa. */
export const DEFAULT_CABINS: Record<Location, number> = { unicentro: 1, chipichape: 1 }

export function isLocation(value: unknown): value is Location {
  return typeof value === 'string' && (LOCATIONS as string[]).includes(value)
}

export const WEEKDAY_LABEL = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
export const WEEKDAY_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
export const MONTH_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/**
 * Horario por índice de día (0 = domingo). Cada franja es "HH:MM-HH:MM".
 * Por defecto, horario de centro comercial en Cali: lunes a sábado 10:00–20:00, domingo cerrado.
 */
export const DEFAULT_HOURS: string[][] = [
  [],
  ['10:00-20:00'],
  ['10:00-20:00'],
  ['10:00-20:00'],
  ['10:00-20:00'],
  ['10:00-20:00'],
  ['10:00-20:00'],
]

/**
 * Catálogo inicial. Los precios arrancan vacíos a propósito: la IA nunca debe cotizar
 * un valor inventado (mismo criterio que ya usaba la consola de ventas).
 */
export const DEFAULT_SERVICES: Service[] = [
  {
    id: 'valoracion',
    label: 'Valoración de piel',
    durationMin: 30,
    price: '',
    summary: 'Diagnóstico de la piel con una especialista y recomendación del protocolo adecuado.',
  },
  {
    id: 'limpieza-basica',
    label: 'Limpieza facial básica',
    durationMin: 45,
    price: '',
    summary: 'Desincrustación, extracción suave e hidratación con minerales del Mar Muerto.',
  },
  {
    id: 'limpieza-profunda',
    label: 'Limpieza facial profunda',
    durationMin: 60,
    price: '',
    summary: 'Limpieza completa con vapor, extracción, alta frecuencia y mascarilla mineral.',
  },
  {
    id: 'hidratacion-mineral',
    label: 'Hidratación mineral',
    durationMin: 60,
    price: '',
    summary: 'Protocolo de hidratación intensiva con sales y lodos del Mar Muerto.',
  },
  {
    id: 'anti-acne',
    label: 'Tratamiento anti-acné',
    durationMin: 75,
    price: '',
    summary: 'Limpieza profunda más activos seborreguladores; se trabaja en sesiones.',
  },
]
