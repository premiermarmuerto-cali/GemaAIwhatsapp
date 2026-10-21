'use client'

import { useEffect, useState } from 'react'
import styles from './Agenda.module.css'

/**
 * Selector del asesor de una cita. La lista sale de Upstash (lib/advisors.ts), así que los nombres
 * se eligen igual desde cualquier computador; "Nuevo asesor…" deja escribir uno y queda guardado al
 * agendar. En este navegador se recuerda el último usado, para proponerlo en la siguiente cita.
 */
const LAST_KEY = 'pm_last_advisor'
const NEW = '__nuevo__'

/** El último asesor usado en este navegador. */
export function lastAdvisor(): string {
  try { return window.localStorage.getItem(LAST_KEY) ?? '' } catch { return '' }
}

export function rememberAdvisor(name: string) {
  const clean = name.trim()
  if (!clean) return
  try { window.localStorage.setItem(LAST_KEY, clean) } catch { /* sin almacenamiento: no pasa nada */ }
}

type Props = {
  value: string
  onChange: (name: string) => void
  /** Asesores guardados (los trae la agenda). */
  options: string[]
  /** Quitar de la lista el asesor elegido (no cambia sus citas). */
  onRemove?: (name: string) => void
}

export function AdvisorSelect({ value, onChange, options, onRemove }: Props) {
  const all = ['Gema', ...options.filter((name) => name.toLowerCase() !== 'gema')]
  const known = all.includes(value)
  // Escribiendo uno nuevo: también si la cita ya trae un nombre que no está en la lista.
  const [typing, setTyping] = useState(Boolean(value) && !known)
  useEffect(() => { if (value && !all.includes(value)) setTyping(true) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={styles.advisorSelect}>
      <select
        value={typing ? NEW : known ? value : ''}
        aria-label="Asesor"
        onChange={(event) => {
          if (event.target.value === NEW) { setTyping(true); onChange('') }
          else { setTyping(false); onChange(event.target.value) }
        }}
      >
        <option value="" disabled>Elige el asesor</option>
        {all.map((name) => <option key={name} value={name}>{name}</option>)}
        <option value={NEW}>+ Nuevo asesor…</option>
      </select>
      {typing && (
        <input value={value} maxLength={60} autoFocus placeholder="Nombre del asesor" aria-label="Nombre del nuevo asesor" onChange={(event) => onChange(event.target.value)} />
      )}
      {onRemove && !typing && known && value !== 'Gema' && (
        <button
          type="button"
          className={styles.advisorRemove}
          title="Quitar este nombre de la lista (sus citas no cambian)"
          onClick={() => { if (window.confirm(`¿Quitar a "${value}" de la lista de asesores? Sus citas conservan el nombre.`)) onRemove(value) }}
        >Quitar de la lista</button>
      )}
    </div>
  )
}
