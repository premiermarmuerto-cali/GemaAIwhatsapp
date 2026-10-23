'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { formatClock, formatDayLabel, isSameDay } from '@/lib/format'
import { MEDIA_LABEL } from '@/lib/media-text'
import { isTemplateName, PARAM_LABEL, parseTemplateSummary, TEMPLATES } from '@/lib/template-catalog'
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
    <div className={styles.threadWrap}>
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
                {message.ad && <p className={styles.mediaNote}><b>Desde anuncio</b>{message.ad.headline || message.ad.body}</p>}
                {message.media ? <MediaBubble message={message} /> : <TextBubble message={message} />}
              </div>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

/** Texto normal, o la tarjeta de una plantilla de Meta: cuál salió, con su imagen, el texto y los botones. */
function TextBubble({ message }: { message: Message }) {
  const legacy = message.template ? null : parseTemplateSummary(message.text)
  const sent = message.template ?? legacy
  if (!sent || !isTemplateName(sent.name)) return <div className={styles.bubble}>{message.text}</div>
  const template: { label: string; image?: string; buttons: readonly string[] } = TEMPLATES[sent.name]
  // Sin el texto aprobado (mensajes viejos, o Meta no lo entregó): las variables con que salió.
  const body = legacy || message.text.startsWith('[Plantilla ') ? null : message.text
  const params = Object.entries(sent.params)
  return (
    <div className={`${styles.bubble} ${styles.templateBubble}`}>
      <p className={styles.templateHead}>
        <b>Plantilla de Meta</b>
        {template.label} · {sent.manual ? 'enviada desde el panel' : 'enviada automáticamente'}
      </p>
      {template.image && (
        <a href={`/plantillas/${template.image}`} target="_blank" rel="noopener noreferrer" className={styles.mediaImage}>
          {/* eslint-disable-next-line @next/next/no-img-element -- imagen pública del encabezado de la plantilla */}
          <img src={`/plantillas/${template.image}`} alt={`Imagen de la plantilla ${template.label}`} loading="lazy" />
        </a>
      )}
      {body
        ? <p className={styles.mediaCaption}>{body}</p>
        : params.length > 0 && (
          <dl className={styles.templateParams}>
            {params.map(([key, value]) => (
              <Fragment key={key}><dt>{PARAM_LABEL[key] ?? key}</dt><dd>{value}</dd></Fragment>
            ))}
          </dl>
        )}
      <div className={styles.templateButtons}>
        {template.buttons.map((text) => <span key={text}>{text}</span>)}
      </div>
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
