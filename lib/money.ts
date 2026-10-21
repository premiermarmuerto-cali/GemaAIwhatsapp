/** Montos en pesos: sin dependencias, se usa también en el navegador (panel). */

/** Número a partir de un precio escrito ("$130.000", "130000"). 0 si no tiene un número legible. */
export function amountOf(price: string): number {
  const digits = price.replace(/[^0-9]/g, '')
  return digits ? Number(digits) : 0
}

export function pesos(amount: number): string {
  return `$${amount.toLocaleString('es-CO')}`
}
