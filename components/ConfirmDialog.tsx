'use client'

import { useEffect, useRef } from 'react'
import styles from './ConfirmDialog.module.css'

type Props = {
  title: string
  /** Párrafos del cuerpo. */
  body: string[]
  confirmLabel: string
  /** Acción delicada (borrar, quitar): el botón principal va en rojo. */
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Confirmación con la estética del panel, en lugar del cuadro del navegador. Esc cancela. */
export function ConfirmDialog({ title, body, confirmLabel, danger, busy, onConfirm, onCancel }: Props) {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancel.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <div className={styles.dialog} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{title}</h2>
        {body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        <div className={styles.actions}>
          <button ref={cancel} type="button" className="btn btn-secondary" onClick={onCancel}>Cancelar</button>
          <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={onConfirm}>{busy ? 'Enviando…' : confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
