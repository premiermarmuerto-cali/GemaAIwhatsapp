'use client'

import { useState } from 'react'
import { CloseIcon } from '@/components/icons'
import styles from './Agenda.module.css'

type Props = {
  advisors: string[]
  busy: boolean
  onClose: () => void
  /** Cambia el nombre en la lista y en todas las citas de ese asesor. */
  onRename: (from: string, to: string) => void
  /** Lo quita de la lista; sus citas conservan el nombre. */
  onRemove: (name: string) => void
}

/** Asesores guardados: corregir o completar un nombre (p. ej. agregar el apellido) o quitarlo de la lista. */
export function AdvisorManager({ advisors, busy, onClose, onRename, onRemove }: Props) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  return (
    <aside className={styles.panel} aria-label="Asesores">
      <header className={styles.panelHead}>
        <div>
          <span className="eyebrow">Agenda</span>
          <h2 className={styles.panelTitle}>Asesores</h2>
        </div>
        <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Cerrar"><CloseIcon /></button>
      </header>
      <p className={styles.dim}>
        Son los nombres que aparecen al elegir el asesor de una cita. Si cambias un nombre (por ejemplo, para agregar el apellido),
        se actualiza también en todas sus citas. Quitar un nombre solo lo saca de esta lista: sus citas lo conservan.
      </p>
      {!advisors.length && <p className={styles.dim}>Todavía no hay asesores guardados. Se agregan solos al agendar una cita con "+ Nuevo asesor…".</p>}
      <ul className={styles.advisorList}>
        {advisors.map((name) => (
          <li key={name}>
            {editing === name ? (
              <form
                className={styles.advisorEdit}
                onSubmit={(event) => {
                  event.preventDefault()
                  if (draft.trim() && draft.trim() !== name) onRename(name, draft.trim())
                  setEditing(null)
                }}
              >
                <input value={draft} maxLength={60} autoFocus aria-label={`Nuevo nombre de ${name}`} onChange={(event) => setDraft(event.target.value)} />
                <button type="submit" className="btn btn-primary" disabled={busy || !draft.trim() || draft.trim() === name}>Guardar</button>
                <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>Cancelar</button>
              </form>
            ) : (
              <>
                <span>{name}</span>
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setEditing(name); setDraft(name) }}>Editar nombre</button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  title="Lo saca de la lista de asesores; sus citas conservan el nombre"
                  onClick={() => { if (window.confirm(`¿Quitar a "${name}" de la lista de asesores? Sus citas conservan el nombre.`)) onRemove(name) }}
                >Quitar</button>
              </>
            )}
          </li>
        ))}
      </ul>
    </aside>
  )
}
