'use client'

import { useEffect, useState } from 'react'
import { SendIcon } from '@/components/icons'
import { api, chatPath } from '@/lib/api-client'
import type { ChatSummary } from '@/lib/types'
import styles from './ChatView.module.css'

type Option = { name: string; label: string; hint: string; marketing: boolean; unavailable: string | null; suggested: boolean }

/**
 * Con la ventana de 24 h cerrada solo se le puede escribir con una plantilla aprobada por Meta. Esta
 * barra las ofrece, con la más lógica para el chat primero, y las envía. Al enviar, Gema vuelve a
 * atender el chat para cuando el cliente responda.
 */
export function TemplateBar({ chat, onSend }: { chat: ChatSummary; onSend: (name: string, label: string) => Promise<boolean> }) {
  const [options, setOptions] = useState<Option[] | null>(null)
  const [sending, setSending] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setOptions(null)
    api<{ options: Option[] }>(`${chatPath(chat.phone)}/template`)
      .then((data) => { if (active) setOptions(data.options) })
      .catch(() => { if (active) setOptions([]) })
    return () => { active = false }
  }, [chat.phone, chat.lastAt])

  if (!options?.length) return null

  return (
    <div className={styles.templateBar}>
      <p>
        <b>Ventana de 24 h cerrada</b> · Solo se le puede escribir con una plantilla de Meta. Cuando responda, Gema le contesta.
      </p>
      <div className={styles.templateOptions}>
        {options.map((option) => (
          <button
            key={option.name}
            type="button"
            className={styles.templateOption}
            data-suggested={option.suggested && !option.unavailable ? true : undefined}
            disabled={Boolean(option.unavailable) || sending !== null}
            title={option.unavailable ? `No aplica: ${option.unavailable}` : option.hint}
            onClick={async () => {
              const cost = option.marketing ? 'Es de marketing: Meta la cobra (≈ COP 50).' : 'Es de utilidad: Meta la cobra (≈ COP 3).'
              if (!window.confirm(`¿Enviar la plantilla "${option.label}"?\n\n${option.hint}\n${cost}`)) return
              setSending(option.name)
              await onSend(option.name, option.label)
              setSending(null)
            }}
          >
            <span>
              {option.suggested && !option.unavailable && <em>Sugerida</em>}
              <b>{sending === option.name ? 'Enviando…' : option.label}</b>
              <small>{option.unavailable ? `No aplica: ${option.unavailable}` : option.hint}</small>
            </span>
            <SendIcon />
          </button>
        ))}
      </div>
    </div>
  )
}
