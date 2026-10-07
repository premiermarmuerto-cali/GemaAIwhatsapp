'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { SendIcon } from '@/components/icons'
import { formatDuration } from '@/lib/format'
import type { ChatSummary } from '@/lib/types'
import { windowRemainingMs } from '@/lib/window'
import styles from './ChatView.module.css'

const MAX_HEIGHT_PX = 160

export function Composer({ chat, onSend }: { chat: ChatSummary; onSend: (text: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState('')
  const [now, setNow] = useState(() => Date.now())
  // En pantallas táctiles Enter hace salto de línea, como en WhatsApp: se envía con el botón.
  const [touch, setTouch] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { setTouch(window.matchMedia('(pointer: coarse)').matches) }, [])

  // Refresca la cuenta regresiva de la ventana de 24 h.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [draft, touch])

  const remaining = windowRemainingMs(chat, now)
  const windowOpen = remaining > 0

  async function submit() {
    const text = draft.trim()
    if (!text || !windowOpen) return
    setDraft('')
    // Si el envío falla, el texto vuelve a la caja para no perderlo.
    if (!(await onSend(text))) setDraft((current) => current || text)
    input.current?.focus()
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !touch && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <div className={styles.composerWrap}>
      <div className={styles.composerMode}>
        <span className={`dot ${chat.botActive ? 'dot-ai' : 'dot-human'}`} />
        <span className={styles.modeText}>{chat.botActive ? 'Gema está atendiendo. Si escribes, tomas el control y Gema se pausa.' : 'Control humano · Gema en pausa'}</span>
        <span className={styles.window} data-closed={!windowOpen || undefined}>
          {windowOpen ? `Ventana WhatsApp · ${formatDuration(remaining)}` : 'Ventana de 24 h cerrada'}
        </span>
      </div>
      <div className={styles.composer} data-disabled={!windowOpen || undefined}>
        <textarea
          ref={input}
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={!windowOpen}
          maxLength={4096}
          placeholder={!windowOpen ? 'WhatsApp solo permite plantillas aprobadas fuera de la ventana de 24 h' : touch ? 'Escribe un mensaje' : 'Escribe un mensaje · Enter envía, Shift+Enter salto de línea'}
          aria-label="Mensaje"
        />
        <button className="btn btn-primary" onClick={submit} disabled={!draft.trim() || !windowOpen}>
          <SendIcon /><span className={styles.actionLabel}>Enviar</span>
        </button>
      </div>
    </div>
  )
}
