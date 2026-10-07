'use client'

import Link from 'next/link'
import { ArrowIcon, CalendarIcon, CopyIcon, SettingsIcon } from '@/components/icons'
import type { ShowToast } from '@/hooks/useToast'
import { formatDate, formatDuration } from '@/lib/format'
import { formatPhone } from '@/lib/phone'
import type { ChatSummary, Stats } from '@/lib/types'
import { windowRemainingMs } from '@/lib/window'
import { AGENT_LABEL, leadSummary, paymentMethods, regionLabel } from './labels'
import styles from './Inspector.module.css'

type Props = { stats: Stats | null; chat: ChatSummary | null; onOpenSettings: () => void; toast: ShowToast }

export function Inspector({ stats, chat, onOpenSettings, toast }: Props) {
  const today = stats?.today
  const replies = today ? today.aiReplies + today.humanReplies : 0
  const aiShare = today && replies ? Math.round((today.aiReplies / replies) * 100) : null
  const remaining = chat ? windowRemainingMs(chat) : 0

  async function copyPhone() {
    if (!chat) return
    try {
      await navigator.clipboard.writeText(`+${chat.phone}`)
      toast('Número copiado')
    } catch {
      toast('No se pudo copiar el número', { tone: 'error' })
    }
  }

  return (
    <aside className={styles.inspector}>
      <div className={styles.head}>
        <div>
          <span className="eyebrow">Vista en tiempo real</span>
          <h2>Panel de control</h2>
        </div>
        <span className={styles.live}><i />En vivo</span>
      </div>

      <div className={styles.metrics}>
        <Metric label="Bandeja" value={stats?.inbox} hint={`${stats?.archived ?? '—'} archivados`} />
        <Metric label="Citas hoy" value={today?.booked} hint={`${today?.newChats ?? '—'} leads nuevos`} accent />
        <Metric label="Mensajes hoy" value={today?.inbound} hint="recibidos" />
        <Metric label="Respuestas IA" value={aiShare === null ? undefined : `${aiShare}%`} hint={`${today?.aiReplies ?? 0} de ${replies}`} />
      </div>

      <section className={styles.section}>
        <div className="eyebrow">Cliente actual</div>
        {chat ? (
          <dl className={styles.facts}>
            <div><dt>Número</dt><dd className="mono">{formatPhone(chat.phone)}</dd></div>
            {chat.name && <div><dt>Nombre</dt><dd>{chat.name}</dd></div>}
            {leadSummary(chat) && <div><dt>Ficha de Gema</dt><dd>{leadSummary(chat)}</dd></div>}
            <div><dt>Cobro</dt><dd>{regionLabel(chat)}</dd></div>
            <div><dt>Métodos</dt><dd>{paymentMethods(chat)}</dd></div>
            <div><dt>Estado</dt><dd>{chat.stage === 'booked' ? <span className="badge badge-booked">Agendado</span> : 'En conversación'}</dd></div>
            <div><dt>Atiende</dt><dd><span className={`dot ${chat.needsAgent ? `dot-agent dot-${chat.agentKind}` : chat.botActive ? 'dot-ai' : 'dot-human'}`} />{chat.needsAgent ? AGENT_LABEL[chat.agentKind] : chat.botActive ? 'Gema (IA)' : 'Operador'}</dd></div>
            {chat.needsAgent && <div><dt>{chat.agentKind === 'payment' ? 'Anticipo' : 'Motivo'}</dt><dd>{chat.agentReason}</dd></div>}
            <div><dt>Ventana 24 h</dt><dd data-closed={!remaining || undefined}>{remaining ? `${formatDuration(remaining)} restantes` : 'Cerrada'}</dd></div>
            <div><dt>Primer contacto</dt><dd>{formatDate(chat.createdAt)}</dd></div>
          </dl>
        ) : (
          <p className={styles.muted}>Selecciona una conversación para ver sus datos.</p>
        )}
      </section>

      <section className={styles.section}>
        <div className="eyebrow">Acciones rápidas</div>
        <Link className={styles.action} href="/agenda"><span><CalendarIcon /></span>Abrir la agenda<ArrowIcon /></Link>
        <button className={styles.action} onClick={onOpenSettings}><span><SettingsIcon /></span>Gema y la agenda<ArrowIcon /></button>
        <button className={styles.action} onClick={copyPhone} disabled={!chat}><span><CopyIcon /></span>Copiar número<ArrowIcon /></button>
      </section>

      <div className={styles.signature}>
        <div className="gem-pattern" aria-hidden="true" />
        <div className="gem-shine" aria-hidden="true" />
        <p>Minerales exclusivos<br />del Mar Muerto.</p>
        <i />
      </div>
    </aside>
  )
}

function Metric({ label, value, hint, accent }: { label: string; value: number | string | undefined; hint: string; accent?: boolean }) {
  return (
    <div className={styles.metric} data-accent={accent || undefined}>
      <span>{label}</span>
      <strong>{value ?? '—'}</strong>
      <small>{hint}</small>
    </div>
  )
}
