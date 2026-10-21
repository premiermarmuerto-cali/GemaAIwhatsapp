'use client'

import { useEffect, useState } from 'react'

/**
 * Asesores que ya se escribieron en este navegador, para sugerirlos en el campo "Asesor" de la cita.
 * Es una comodidad local: el dato que vale es el que se guarda en cada cita.
 */
const KEY = 'pm_advisors'

function read(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? '[]') as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** El último asesor usado aquí (para rellenar el formulario de una cita nueva). */
export function lastAdvisor(): string {
  return read()[0] ?? ''
}

export function rememberAdvisor(name: string) {
  const clean = name.trim()
  if (!clean) return
  try {
    window.localStorage.setItem(KEY, JSON.stringify([clean, ...read().filter((item) => item.toLowerCase() !== clean.toLowerCase())].slice(0, 12)))
  } catch { /* sin almacenamiento: no pasa nada */ }
}

/** Lista de sugerencias para los campos con list="advisor-options". "Gema" siempre está. */
export function AdvisorOptions() {
  const [names, setNames] = useState<string[]>([])
  useEffect(() => { setNames(read()) }, [])
  return (
    <datalist id="advisor-options">
      {[...names, ...(names.includes('Gema') ? [] : ['Gema'])].map((name) => <option key={name} value={name} />)}
    </datalist>
  )
}
