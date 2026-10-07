'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { formatClock, formatDayLabel, isSameDay } from '@/lib/format'
import { MEDIA_LABEL } from '@/lib/media-text'
import type { ChatSummary, Message } from '@/lib/types'
import { SENDER_LABEL } from './labels'
import styles from './ChatView.module.css'

const STICK_THRESHOLD_PX = 120

export function MessageThread({ chat, messages }: { chat: ChatSummary; messages: Message[] | null }) {
  const scroller = useRef<HTMLDivElement>(null)
  const firstPaint = useRef(true)
  const count = messages?.length ?? 0

  // Baja al último mensaje al abrir el chat, y luego solo si el operador ya estaba abajo.
  useEffect(() => {
    const element = scroller.current
    if (!element || !count) return
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD_PX
    if (firstPaint.current || nearBottom) element.scrollTop = element.scrollHeight
    firstPaint.current = false
  }, [count])

  return (
    <div className={styles.thread} ref={scroller}>
      {messages === null && <div className={styles.threadNotice}>Cargando mensajes…</div>}
      {messages?.length === 0 && <div className={styles.threadNotice}>Sin mensajes todavía.</div>}
      {messages?.map((message, index) => {
        const previous = messages[index - 1]
        const newDay = !previous || !isSameDay(previous.at, message.at)
        return (
          <Fragment key={message.id}>
            {newDay && <div className={styles.day}><span>{formatDayLabel(message.at)}</span></div>}
            <div className={styles.message} data-sender={message.sender} data-pending={message.pending}>
              <div className={styles.messageMeta}>
                {message.sender === 'user' && chat.name ? chat.name : SENDER_LABEL[message.sender]}
                <time>{message.pending === 'sending' ? 'Enviando…' : formatClock(message.at)}</time>
              </div>
              {message.media ? <MediaBubble message={message} /> : <div className={styles.bubble}>{message.text}</div>}
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}

const NOTE_LABEL = { image: 'Gema leyó', audio: 'Transcripción' } as const

function MediaBubble({ message }: { message: Message }) {
  const media = message.media!
  const [broken, setBroken] = useState(false)
  const src = `/api/media/${encodeURIComponent(media.id)}`
  const stored = media.kind === 'image' || media.kind === 'audio'
  const processing = stored && media.status === 'processing'
  // Un análisis fallido puede tener la copia guardada igual: se intenta mostrar y, si no carga, se avisa.
  const available = stored && !broken && (media.status === 'ready' || media.status === 'failed')
  const unavailable = !stored ? 'No se abre en la consola por seguridad' : media.status === 'expired' ? 'Ya no está disponible' : 'No se pudo descargar'

  return (
    <div className={`${styles.bubble} ${styles.mediaBubble}`}>
      {media.kind === 'image' && available && (
        <a href={src} target="_blank" rel="noopener noreferrer" className={styles.mediaImage}>
          {/* eslint-disable-next-line @next/next/no-img-element -- la copia es privada y se sirve tras la sesión */}
          <img src={src} alt="Imagen enviada por el cliente" loading="lazy" onError={() => setBroken(true)} />
        </a>
      )}
      {media.kind === 'audio' && available && <audio className={styles.mediaAudio} controls preload="none" src={src} onError={() => setBroken(true)} />}
      {!available && (
        <div className={styles.mediaFile}>
          <b>{MEDIA_LABEL[media.kind]}{media.filename ? ` · ${media.filename}` : ''}</b>
          <span>{processing ? 'Gema lo está analizando…' : unavailable}</span>
        </div>
      )}
      {message.text && <p className={styles.mediaCaption}>{message.text}</p>}
      {stored && media.note &&<p className={styles.mediaNote}><b>{NOTE_LABEL[media.kind as keyof typeof NOTE_LABEL]}</b>{media.note}</p>}
    </div>
  )
}
