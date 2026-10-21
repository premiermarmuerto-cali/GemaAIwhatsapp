'use client'

import { useState } from 'react'
import type { ShowToast } from '@/hooks/useToast'
import { api } from '@/lib/api-client'
import { DEFAULT_PRESETS, PRESET_INFO, PRESET_VARIABLES } from '@/lib/preset-defaults'
import type { PresetId, PresetMessages } from '@/lib/types'
import styles from './SettingsModal.module.css'

type Props = { messages: PresetMessages; onChange: (messages: PresetMessages) => void; toast: ShowToast }

/**
 * Mensajes prediseñados (bienvenida y seguimientos): los envía el servidor tal cual, con las
 * variables completadas con datos reales. Cada uno tiene vista previa con la agenda de ahora mismo.
 */
export function PresetEditor({ messages, onChange, toast }: Props) {
  const [open, setOpen] = useState<PresetId | null>('welcomeCaption')
  const [preview, setPreview] = useState<{ id: PresetId; parts: string[]; skipped: boolean } | null>(null)

  async function showPreview(id: PresetId) {
    try {
      const result = await api<{ parts: string[]; skipped: boolean }>('/api/settings/preset-preview', { method: 'POST', body: { id, text: messages[id] } })
      setPreview({ id, ...result })
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : 'No se pudo generar la vista previa.', { tone: 'error' })
    }
  }

  return (
    <fieldset className={styles.group}>
      <legend>Mensajes prediseñados</legend>
      <small className={styles.hint}>
        La bienvenida (imagen del 2x1 + dos mensajes) sale apenas escribe un cliente nuevo; los seguimientos, cuando deja de responder.
        Los envía el sistema tal cual, sin IA. Usa <code>|||</code> para partir en varios mensajes de WhatsApp. Si un mensaje no salió,
        se puede enviar a mano desde el panel de control del chat.
      </small>
      {(Object.keys(PRESET_INFO) as PresetId[]).map((id) => {
        const info = PRESET_INFO[id]
        const expanded = open === id
        return (
          <div key={id} className={styles.preset} data-open={expanded || undefined}>
            <button type="button" className={styles.presetHead} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : id)}>
              <b>{info.label}</b>
              <span>{info.when}</span>
            </button>
            {expanded && (
              <div className={styles.presetBody}>
                <textarea
                  rows={id.startsWith('welcome') ? 10 : 6}
                  value={messages[id]}
                  onChange={(event) => onChange({ ...messages, [id]: event.target.value })}
                  aria-label={info.label}
                />
                <div className={styles.presetActions}>
                  <button type="button" className="btn btn-secondary" onClick={() => showPreview(id)}>Vista previa</button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={messages[id] === DEFAULT_PRESETS[id]}
                    onClick={() => { onChange({ ...messages, [id]: DEFAULT_PRESETS[id] }); setPreview(null) }}
                  >Restaurar original</button>
                </div>
                {preview?.id === id && (
                  <div className={styles.presetPreview}>
                    {preview.skipped
                      ? <p>Ahora mismo este mensaje no saldría (le falta un dato, por ejemplo no hay horarios libres).</p>
                      : preview.parts.map((part, index) => <p key={index}>{part}</p>)}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
      <details className={styles.variables}>
        <summary>Variables disponibles</summary>
        <dl>
          {Object.entries(PRESET_VARIABLES).map(([name, hint]) => (
            <div key={name}><dt><code>{`{${name}}`}</code></dt><dd>{hint}</dd></div>
          ))}
        </dl>
      </details>
    </fieldset>
  )
}
