'use client'

import { useEffect, useState } from 'react'
import { ArchiveIcon, BackIcon, BoltIcon, CalendarIcon, InboxIcon, TrashIcon, UserIcon } from '@/components/icons'
import { formatPhone } from '@/lib/phone'
import type { ChatSummary, Stage } from '@/lib/types'
import { AGENT_LABEL, avatarLabel, leadSummary, regionLabel } from './labels'
import styles from './ChatView.module.css'

type Props = {
  chat: ChatSummary
  onBack: () => void
  onToggleBot: () => void
  onStageChange: (stage: Stage) => void
  onArchiveChange: (archived: boolean) => void
  onDelete: () => void
}

export function ChatHeader({ chat, onBack, onToggleBot, onStageChange, onArchiveChange, onDelete }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const booked = chat.stage === 'booked'
  const lead = leadSummary(chat)

  // La confirmación de borrado caduca sola para no dejar el botón "armado".
  useEffect(() => {
    if (!confirmDelete) return
    const timer = window.setTimeout(() => setConfirmDelete(false), 3500)
    return () => window.clearTimeout(timer)
  }, [confirmDelete])

  return (
    <header className={styles.header}>
      <button className={`btn btn-ghost btn-icon ${styles.back}`} onClick={onBack} aria-label="Volver a la lista"><BackIcon /></button>

      <div className={styles.person}>
        <span className={styles.avatar} data-booked={booked || undefined}>{avatarLabel(chat)}</span>
        <div className={styles.personCopy}>
          <h1>{chat.name || formatPhone(chat.phone)}</h1>
          <div className={styles.personMeta}>
            {chat.name && <span className="mono">{formatPhone(chat.phone)}</span>}
            {lead && <span>{lead}</span>}
            <span className="badge badge-region">{regionLabel(chat)}</span>
            {chat.needsAgent && <span className={`badge ${chat.agentKind === 'payment' ? 'badge-payment' : 'badge-agent'}`}>{AGENT_LABEL[chat.agentKind]}</span>}
            {booked && <span className="badge badge-booked">Agendado</span>}
            {chat.archived && <span className="badge badge-archived">Archivado</span>}
          </div>
        </div>
      </div>

      <div className={styles.actions}>
        <button
          className={styles.botSwitch}
          role="switch"
          aria-checked={chat.botActive}
          onClick={onToggleBot}
          title={chat.botActive ? 'Pausar a Gema y responder tú' : 'Devolver la conversación a Gema'}
        >
          <span className={styles.botIcon}>{chat.botActive ? <BoltIcon /> : <UserIcon />}</span>
          <span className={styles.botCopy}>
            <b>{chat.botActive ? 'Gema activa' : 'Control humano'}</b>
            <small>{chat.botActive ? 'Responde automáticamente' : 'Gema en pausa'}</small>
          </span>
          <span className={styles.track} aria-hidden="true"><span /></span>
        </button>

        <button className={`btn ${booked ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={booked} onClick={() => onStageChange(booked ? 'open' : 'booked')} title={booked ? 'Quitar la marca de agendado' : 'Marcar como agendado'}>
          <CalendarIcon /><span className={styles.actionLabel}>{booked ? 'Agendado' : 'Marcar agendado'}</span>
        </button>

        <button className="btn btn-secondary btn-icon" onClick={() => onArchiveChange(!chat.archived)} aria-label={chat.archived ? 'Devolver a la bandeja' : 'Archivar'} title={chat.archived ? 'Devolver a la bandeja' : 'Archivar'}>
          {chat.archived ? <InboxIcon /> : <ArchiveIcon />}
        </button>

        {confirmDelete ? (
          <button className="btn btn-danger" onClick={onDelete} autoFocus>Confirmar</button>
        ) : (
          <button className="btn btn-ghost btn-icon" onClick={() => setConfirmDelete(true)} aria-label="Eliminar conversación" title="Eliminar conversación"><TrashIcon /></button>
        )}
      </div>
    </header>
  )
}
