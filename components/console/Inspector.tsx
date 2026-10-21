'use client'

import Link from 'next/link'
import { useState } from 'react'
import { ArrowIcon, CalendarIcon, ChatIcon, CloseIcon, CopyIcon, SendIcon, SettingsIcon } from '@/components/icons'
import type { ShowToast } from '@/hooks/useToast'
import { formatDate, formatDuration } from '@/lib/format'
import { formatPhone } from '@/lib/phone'
import type { ChatSummary, Stats } from '@/lib/types'
import { windowRemainingMs } from '@/lib/window'
import { AGENT_LABEL, AUTO_LABEL, capiLabel, leadSummary, OBJECTION_LABEL, paymentMethods, regionLabel } from './labels'
import styles from './Inspector.module.css'

type Props = {
  stats: Stats | null
  chat: ChatSummary | null
  onOpenSettings: () => void
  onClose: () => void
  onSendPreset: (phone: string, id: string, label: string) => Promise<boolean>
  onReactivate: (phone: string) => void
  toast: ShowToast
}

/** Mensajes prediseñados que el operador puede enviar a mano si el automático falló. */
const PRESET_BUTTONS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'welcome', label: 'Bienvenida completa', hint: 'Imagen del 2x1, el ritual de 5 pasos y el cierre con horarios' },
  { id: 'followUp45', label: 'Seguimiento 45 min', hint: 'Ritual de 5 pasos y una hora libre concreta' },
  { id: 'followUp3h', label: 'Seguimiento 3 h', hint: 'Limpieza cero invasiva y el 2x1 vigente' },
  { id: 'followUp22h', label: 'Seguimiento 22 h', hint: 'Última llamada antes de que se cierre la ventana' },
  { id: 'followUpPayment', label: 'Anticipo pendiente', hint: 'Para quien tiene un horario apartado sin pagar' },
]

export function Inspector({ stats, chat, onOpenSettings, onClose, onSendPreset, onReactivate, toast }: Props) {
  const [sending, setSending] = useState<string | null>(null)
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
        <button className="btn btn-ghost btn-icon only-narrow" onClick={onClose} aria-label="Cerrar el panel" title="Cerrar"><CloseIcon /></button>
      </div>

      <div className={styles.metrics}>
        <Metric label="Bandeja" value={stats?.inbox} hint={`${stats?.archived ?? '—'} archivados`} />
        <Metric label="Agendados hoy" value={today?.booked} hint={`${today?.newChats ?? '—'} leads nuevos`} accent />
        <Metric label="Mensajes hoy" value={today?.inbound} hint="recibidos" />
        <Metric label="Respuestas IA" value={aiShare === null ? undefined : `${aiShare}%`} hint={`${today?.aiReplies ?? 0} de ${replies}`} />
      </div>

      <section className={styles.section}>
        <div className="eyebrow">Cliente actual</div>
        {chat ? (
          <dl className={styles.facts}>
            <div><dt>Número</dt><dd className="mono">{formatPhone(chat.phone)}</dd></div>
            {chat.name && <div><dt>Nombre</dt><dd>{chat.name}</dd></div>}
            {chat.contactPhone && <div><dt>Celular de contacto</dt><dd className="mono">{formatPhone(chat.contactPhone)}</dd></div>}
            {leadSummary(chat) && <div data-stack><dt>Ficha de Gema</dt><dd>{leadSummary(chat)}</dd></div>}
            <div><dt>Cobro</dt><dd>{regionLabel(chat)}</dd></div>
            <div data-stack><dt>Métodos</dt><dd>{paymentMethods(chat)}</dd></div>
            <div><dt>Estado</dt><dd>{chat.stage === 'booked' ? <span className="badge badge-booked">Agendado</span> : 'En conversación'}</dd></div>
            <div><dt>Atiende</dt><dd><span className={`dot ${chat.needsAgent ? `dot-agent dot-${chat.agentKind}` : chat.botActive ? 'dot-ai' : 'dot-human'}`} />{chat.needsAgent ? AGENT_LABEL[chat.agentKind] : chat.botActive ? 'Gema (IA)' : 'Operador'}</dd></div>
            {chat.needsAgent && <div data-stack><dt>{chat.agentKind === 'payment' ? 'Anticipo' : 'Motivo'}</dt><dd>{chat.agentReason}</dd></div>}
            <div><dt>Ventana 24 h</dt><dd data-closed={!remaining || undefined}>{remaining ? `${formatDuration(remaining)} restantes` : 'Cerrada'}</dd></div>
            <div><dt>Primer contacto</dt><dd>{formatDate(chat.createdAt)}</dd></div>
            {(chat.adHeadline || chat.adSourceId) && (
              <div data-stack><dt>Anuncio</dt><dd>{chat.adHeadline || 'sin título'}{chat.adSourceId && <span className="mono"> · {chat.adSourceId}</span>}</dd></div>
            )}
            <div data-stack><dt>Conversión Meta</dt><dd>{capiLabel(chat)}</dd></div>
            {chat.objection && <div><dt>Objeción</dt><dd>{OBJECTION_LABEL[chat.objection] ?? chat.objection}</dd></div>}
            {chat.optedOut ? (
              <div data-stack data-alert>
                <dt>Mensajes automáticos</dt>
                <dd>
                  <span>Detenidos: dijo “{chat.optedOutText || 'no me interesa'}”{chat.optedOutAt ? ` (${formatDate(chat.optedOutAt)})` : ''}. No recibe seguimientos, recordatorios ni plantillas.</span>
                  <button type="button" className="btn btn-secondary" onClick={() => onReactivate(chat.phone)}>Reactivar</button>
                </dd>
              </div>
            ) : chat.noMarketing && <div data-stack><dt>Marketing</dt><dd>No enviar plantillas (tocó "Ahora no")</dd></div>}
            {Object.keys(chat.autoSent).some((kind) => !kind.endsWith(':error')) && (
              <div data-stack>
                <dt>Automáticos</dt>
                <dd>
                  <ul className={styles.autoList}>
                    {Object.entries(chat.autoSent).filter(([kind]) => !kind.endsWith(':error')).sort(([, a], [, b]) => a - b).map(([kind, at]) => (
                      <li key={kind}><span>{AUTO_LABEL[kind.split(':')[0]] ?? kind}</span><time>{formatDate(at)}</time></li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <p className={styles.muted}>Selecciona una conversación para ver sus datos.</p>
        )}
      </section>

      {chat && (
        <section className={styles.section}>
          <div className="eyebrow"><ChatIcon /> Mensajes prediseñados</div>
          <p className={styles.muted}>Si un mensaje automático no salió, envíalo desde aquí. Sale a nombre de Gema y no la pausa.{!remaining && ' La ventana de 24 h está cerrada: solo se pueden enviar plantillas de Meta.'}</p>
          <div className={styles.presets}>
            {PRESET_BUTTONS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={styles.preset}
                title={preset.hint}
                disabled={!remaining || sending !== null}
                onClick={async () => {
                  setSending(preset.id)
                  await onSendPreset(chat.phone, preset.id, preset.label)
                  setSending(null)
                }}
              >
                <span>{sending === preset.id ? 'Enviando…' : preset.label}</span>
                <SendIcon />
              </button>
            ))}
          </div>
        </section>
      )}

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
