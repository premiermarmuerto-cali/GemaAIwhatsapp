'use client'

import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { SendIcon } from '@/components/icons'
import { api, chatPath } from '@/lib/api-client'
import type { ChatSummary } from '@/lib/types'
import styles from './Inspector.module.css'

type Option = { name: string; label: string; hint: string; marketing: boolean; unavailable: string | null; suggested: boolean }

/**
 * Plantillas de Meta para enviar a mano, en el panel de control y plegadas: es solo para emergencias.
 * Las plantillas salen solas (lib/automations.ts); esto sirve para adelantar una en un chat que llegó
 * tarde. El servidor bloquea el envío si ya se le mandó una y no ha respondido, si recibió una de
 * marketing en los últimos 3 días o si es de noche (9 p.m. a 8 a.m.).
 */
export function TemplatePanel({ chat, onSend }: { chat: ChatSummary; onSend: (name: string, label: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<Option[] | null>(null)
  const [confirm, setConfirm] = useState<Option | null>(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!open) return
    let active = true
    setOptions(null)
    api<{ options: Option[] }>(`${chatPath(chat.phone)}/template`)
      .then((data) => { if (active) setOptions(data.options) })
      .catch(() => { if (active) setOptions([]) })
    return () => { active = false }
  }, [open, chat.phone, chat.lastAt])

  // Si todas están bloqueadas por la misma razón (ya se envió una, es de noche…), se dice una vez.
  const sharedLock = options?.length && options.every((option) => option.unavailable && option.unavailable === options[0].unavailable) ? options[0].unavailable : null

  return (
    <details className={styles.templates} open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary>Plantillas de Meta · solo emergencias</summary>
      <p className={styles.muted}>Salen solas entre 8 a.m. y 9 p.m. Úsalas solo para adelantar una en un chat que llegó tarde. Se permite una por cliente hasta que responda.</p>
      {options === null && <p className={styles.muted}>Cargando…</p>}
      {sharedLock && <p className={styles.templateLock}>No se puede enviar: {sharedLock}.</p>}
      {!sharedLock && options?.map((option) => (
        <button
          key={option.name}
          type="button"
          className={styles.templateOption}
          data-suggested={option.suggested && !option.unavailable ? true : undefined}
          disabled={Boolean(option.unavailable) || sending}
          title={option.unavailable ? `No aplica: ${option.unavailable}` : option.hint}
          onClick={() => setConfirm(option)}
        >
          <span>
            <b>{option.label}{option.suggested && !option.unavailable && <em> · sugerida</em>}</b>
            {option.unavailable && <small>No aplica: {option.unavailable}</small>}
          </span>
          <SendIcon />
        </button>
      ))}
      {confirm && (
        <ConfirmDialog
          title={`¿Enviar "${confirm.label}"?`}
          body={[
            confirm.hint,
            `${confirm.marketing ? 'Es de marketing: Meta la cobra (≈ COP 50)' : 'Es de utilidad: Meta la cobra (≈ COP 3)'}. Después de enviarla no se le puede mandar otra hasta que responda.`,
          ]}
          confirmLabel="Enviar plantilla"
          busy={sending}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            setSending(true)
            const ok = await onSend(confirm.name, confirm.label)
            setSending(false)
            setConfirm(null)
            if (ok) setOpen(false)
          }}
        />
      )}
    </details>
  )
}
