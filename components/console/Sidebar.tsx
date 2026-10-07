'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArchiveIcon, CalendarIcon, InboxIcon, LogoutIcon, SearchIcon, SettingsIcon } from '@/components/icons'
import { formatListTime } from '@/lib/format'
import { formatPhone } from '@/lib/phone'
import type { AgentKind, Box, ChatLists, ChatSummary } from '@/lib/types'
import { ThemeToggle } from '@/components/ThemeToggle'
import { AGENT_LABEL, avatarLabel, PREVIEW_PREFIX } from './labels'
import styles from './Sidebar.module.css'

type Filter = 'all' | AgentKind | 'ai' | 'human' | 'booked'
type Test = (chat: ChatSummary) => boolean

const FILTERS: Array<{ id: Filter; label: string; test: Test }> = [
  { id: 'all', label: 'Todas', test: () => true },
  { id: 'ai', label: 'IA', test: (chat) => chat.botActive },
  { id: 'human', label: 'Humano', test: (chat) => !chat.botActive },
  { id: 'booked', label: 'Agendados', test: (chat) => chat.stage === 'booked' },
]
const alertOf = (kind: AgentKind): Test => (chat) => chat.needsAgent && chat.agentKind === kind
// Los anticipos por validar van primero: son citas esperando confirmación.
const STRIPS: Array<{ kind: AgentKind; one: string; many: (count: number) => string }> = [
  { kind: 'payment', one: '1 anticipo por validar', many: (count) => `${count} anticipos por validar` },
  { kind: 'help', one: '1 chat requiere asesor', many: (count) => `${count} chats requieren asesor` },
]

type Props = {
  lists: ChatLists
  box: Box
  onBoxChange: (box: Box) => void
  activePhone: string | null
  onSelect: (phone: string) => void
  loaded: boolean
  loadError: string | null
  onRetry: () => void
  onOpenSettings: () => void
}

export function Sidebar({ lists, box, onBoxChange, activePhone, onSelect, loaded, loadError, onRetry, onOpenSettings }: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const alertCounts: Record<AgentKind, number> = {
    payment: lists[box].filter(alertOf('payment')).length,
    help: lists[box].filter(alertOf('help')).length,
  }
  // Un filtro de alerta se apaga solo cuando ya no queda ningún chat pendiente de ese tipo.
  const activeFilter: Filter = (filter === 'payment' || filter === 'help') && !alertCounts[filter] ? 'all' : filter

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const digits = needle.replace(/\D/g, '')
    const test = activeFilter === 'payment' || activeFilter === 'help' ? alertOf(activeFilter) : FILTERS.find((item) => item.id === activeFilter)!.test
    return lists[box].filter((chat) => test(chat) && (!needle
      || (digits && chat.phone.includes(digits))
      || chat.name.toLowerCase().includes(needle)
      || chat.lastMessage.toLowerCase().includes(needle)))
  }, [lists, box, query, activeFilter])

  const unreadInbox = lists.inbox.reduce((total, chat) => total + (chat.unread > 0 ? 1 : 0), 0)

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null)
    window.location.assign('/login')
  }

  return (
    <aside className={styles.sidebar}>
      <header className={styles.brand}>
        <span className={`brand-mark ${styles.brandMark}`} aria-hidden="true" />
        <div>
          <div className={styles.brandName}>Premier Mar Muerto</div>
          <div className="eyebrow">Conversaciones</div>
        </div>
        <Link className="btn btn-ghost btn-icon" href="/agenda" aria-label="Abrir la agenda" title="Abrir la agenda"><CalendarIcon /></Link>
        <ThemeToggle />
        <button className="btn btn-ghost btn-icon" onClick={onOpenSettings} aria-label="Gema y la agenda" title="Gema y la agenda"><SettingsIcon /></button>
      </header>

      <div className={styles.tabs} role="tablist" aria-label="Bandejas">
        <button role="tab" aria-selected={box === 'inbox'} className={styles.tab} onClick={() => onBoxChange('inbox')}>
          <InboxIcon /> Bandeja <span className={styles.count}>{lists.inbox.length}</span>
          {unreadInbox > 0 && <span className={styles.unreadDot} aria-label={`${unreadInbox} con mensajes nuevos`} />}
        </button>
        <button role="tab" aria-selected={box === 'archived'} className={styles.tab} onClick={() => onBoxChange('archived')}>
          <ArchiveIcon /> Archivados <span className={styles.count}>{lists.archived.length}</span>
        </button>
      </div>

      <label className={styles.search}>
        <SearchIcon />
        <span className="sr-only">Buscar</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar número o mensaje" type="search" />
      </label>

      <div className={styles.filters} role="group" aria-label="Filtros">
        {FILTERS.map((item) => (
          <button key={item.id} className={styles.filter} aria-pressed={activeFilter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>
        ))}
      </div>

      {STRIPS.filter((strip) => alertCounts[strip.kind] > 0).map((strip) => (
        <button key={strip.kind} className={styles.agentStrip} data-kind={strip.kind} aria-pressed={activeFilter === strip.kind} onClick={() => setFilter(activeFilter === strip.kind ? 'all' : strip.kind)}>
          <span className={`dot dot-agent dot-${strip.kind}`} />
          <span>{alertCounts[strip.kind] === 1 ? strip.one : strip.many(alertCounts[strip.kind])}</span>
          <b>{activeFilter === strip.kind ? 'Ver todos' : 'Ver'}</b>
        </button>
      ))}

      <div className={styles.list}>
        {!loaded && <div className={styles.notice}>Cargando conversaciones…</div>}
        {loaded && loadError && (
          <div className={styles.notice}>
            <p>{loadError}</p>
            <button className="btn btn-secondary" onClick={onRetry}>Reintentar</button>
          </div>
        )}
        {loaded && !loadError && !visible.length && (
          <div className={styles.notice}>
            {lists[box].length ? 'Ninguna conversación coincide con el filtro.' : box === 'inbox' ? 'La bandeja está vacía. Los nuevos leads aparecerán aquí.' : 'No hay conversaciones archivadas.'}
          </div>
        )}
        {visible.map((chat) => <ChatRow key={chat.phone} chat={chat} active={chat.phone === activePhone} onSelect={onSelect} />)}
      </div>

      <footer className={styles.footer}>
        <span className={styles.operator}>OP</span>
        <div className={styles.operatorCopy}>
          <strong>Operador</strong>
          <span className="eyebrow">Sesión activa</span>
        </div>
        <button className="btn btn-ghost btn-icon" onClick={logout} aria-label="Cerrar sesión" title="Cerrar sesión"><LogoutIcon /></button>
      </footer>
    </aside>
  )
}

function ChatRow({ chat, active, onSelect }: { chat: ChatSummary; active: boolean; onSelect: (phone: string) => void }) {
  return (
    <button className={styles.row} aria-current={active || undefined} data-agent={chat.needsAgent ? chat.agentKind : undefined} onClick={() => onSelect(chat.phone)}>
      <span className={styles.avatar} data-booked={chat.stage === 'booked' || undefined}>{avatarLabel(chat)}</span>
      <span className={styles.rowBody}>
        <span className={styles.rowTop}>
          <strong>{chat.name || formatPhone(chat.phone)}</strong>
          <time>{formatListTime(chat.lastAt)}</time>
        </span>
        <span className={styles.rowPreview} data-unread={chat.unread > 0 || undefined}>
          <span>{PREVIEW_PREFIX[chat.lastSender]}{chat.lastMessage}</span>
          {chat.unread > 0 && <em>{chat.unread}</em>}
        </span>
        <span className={styles.rowMeta}>
          <span className={`dot ${chat.needsAgent ? `dot-agent dot-${chat.agentKind}` : chat.botActive ? 'dot-ai' : 'dot-human'}`} />
          {chat.needsAgent ? <span className={styles.agentLabel} data-kind={chat.agentKind}>{AGENT_LABEL[chat.agentKind]}</span> : chat.botActive ? 'Gema' : 'Humano'}
          {chat.lead.concern && <span className={styles.rowName}>· {chat.lead.concern}</span>}
          {chat.stage === 'booked' && <span className="badge badge-booked">Agendado</span>}
        </span>
      </span>
    </button>
  )
}
