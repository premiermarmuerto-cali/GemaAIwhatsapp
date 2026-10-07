'use client'

import Link from 'next/link'
import type { ShowToast } from '@/hooks/useToast'
import type { ChatSummary, Message, Stage } from '@/lib/types'
import { ChatHeader } from './ChatHeader'
import { Composer } from './Composer'
import { AGENT_LABEL } from './labels'
import { MessageThread } from './MessageThread'
import styles from './ChatView.module.css'

type Props = {
  chat: ChatSummary
  messages: Message[] | null
  onBack: () => void
  onToggleBot: () => void
  onStageChange: (stage: Stage) => void
  onArchiveChange: (archived: boolean) => void
  onDelete: () => void
  onSend: (text: string) => Promise<boolean>
  onResolveAgent: () => void
  toast: ShowToast
}

export function ChatView({ chat, messages, onBack, onToggleBot, onStageChange, onArchiveChange, onDelete, onSend, onResolveAgent }: Props) {
  const payment = chat.agentKind === 'payment'

  return (
    <section className={styles.view}>
      <ChatHeader chat={chat} onBack={onBack} onToggleBot={onToggleBot} onStageChange={onStageChange} onArchiveChange={onArchiveChange} onDelete={onDelete} />
      <MessageThread chat={chat} messages={messages} />
      {chat.needsAgent && (
        <div className={styles.agentBanner} data-kind={chat.agentKind} role="status">
          <span className={`dot dot-agent dot-${chat.agentKind}`} />
          <p>
            <b>{AGENT_LABEL[chat.agentKind]}</b>
            <strong>{chat.agentReason}</strong>
            {payment ? ' · Valida el comprobante y confirma la cita desde la agenda.' : ' · Gema está en pausa: responde tú o devuélvele el chat.'}
          </p>
          <div className={styles.agentActions}>
            {payment ? (
              <>
                <Link className="btn btn-primary" href="/agenda" title="Abre la agenda para confirmar la cita">Ir a la agenda</Link>
                <button className="btn btn-secondary" onClick={() => onStageChange('booked')} title="Marca el chat como agendado y quita la alerta">Marcar agendado</button>
              </>
            ) : (
              <button className="btn btn-secondary" onClick={onToggleBot} title="Gema retoma la conversación y la alerta desaparece">Devolver a Gema</button>
            )}
            <button className="btn btn-ghost" onClick={onResolveAgent} title="Quita la marca sin responder. Gema sigue en pausa hasta que se la devuelvas.">Quitar alerta</button>
          </div>
        </div>
      )}
      <Composer chat={chat} onSend={onSend} />
    </section>
  )
}
