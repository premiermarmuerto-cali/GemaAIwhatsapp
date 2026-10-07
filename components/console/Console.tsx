'use client'

import { useEffect, useRef, useState } from 'react'
import { ChatIcon } from '@/components/icons'
import { useChats } from '@/hooks/useChats'
import { useStats } from '@/hooks/useStats'
import { useToast } from '@/hooks/useToast'
import type { Box } from '@/lib/types'
import { ChatView } from './ChatView'
import { Inspector } from './Inspector'
import { SettingsModal } from './SettingsModal'
import { Sidebar } from './Sidebar'
import { Toasts } from './Toasts'
import styles from './Console.module.css'

export function Console() {
  const { toasts, show, dismiss } = useToast()
  const chats = useChats(show)
  const stats = useStats(chats.statsVersion)
  const [box, setBox] = useState<Box>('inbox')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const autoSelected = useRef(false)

  // En escritorio abre el chat más reciente al cargar; en móvil se queda en la lista.
  useEffect(() => {
    if (!chats.loaded || autoSelected.current) return
    autoSelected.current = true
    const first = chats.lists.inbox[0]
    if (first && !chats.activePhone && window.matchMedia('(min-width: 900px)').matches) chats.select(first.phone)
  }, [chats])

  // Los pendientes se ven en la pestaña del navegador aunque la consola esté de fondo.
  const payments = chats.lists.inbox.filter((item) => item.needsAgent && item.agentKind === 'payment').length
  const helps = chats.lists.inbox.filter((item) => item.needsAgent && item.agentKind === 'help').length
  useEffect(() => {
    const parts = [payments && `${payments} ${payments === 1 ? 'anticipo' : 'anticipos'}`, helps && `${helps} ${helps === 1 ? 'asesor' : 'asesores'}`].filter(Boolean)
    document.title = parts.length ? `(${parts.join(' · ')}) Premier Mar Muerto` : 'Premier Mar Muerto · Consola'
  }, [payments, helps])

  const chat = chats.activeChat

  return (
    <div className={styles.shell} data-view={chat ? 'chat' : 'list'}>
      <Sidebar
        lists={chats.lists}
        box={box}
        onBoxChange={setBox}
        activePhone={chats.activePhone}
        onSelect={chats.select}
        loaded={chats.loaded}
        loadError={chats.loadError}
        onRetry={chats.refresh}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className={styles.main}>
        {chat ? (
          <ChatView
            key={chat.phone}
            chat={chat}
            messages={chats.messages}
            onBack={() => chats.select(null)}
            onToggleBot={() => chats.toggleBot(chat.phone)}
            onStageChange={(stage) => chats.setStage(chat.phone, stage)}
            onArchiveChange={(archived) => chats.setArchived(chat.phone, archived)}
            onDelete={() => chats.remove(chat.phone)}
            onSend={(text) => chats.send(chat.phone, text)}
            onResolveAgent={() => chats.resolveAgent(chat.phone)}
            toast={show}
          />
        ) : (
          <div className={styles.empty}>
            <div className="gem-pattern" aria-hidden="true" />
            <div className={styles.emptyCopy}>
              <span className={styles.emptyIcon}><ChatIcon /></span>
              <h2>Selecciona una conversación</h2>
              <p>Quien escriba al WhatsApp de la clínica aparece aquí. Gema resuelve dudas y agenda sola hasta que tomes el control.</p>
            </div>
          </div>
        )}
      </main>

      <Inspector stats={stats} chat={chat} onOpenSettings={() => setSettingsOpen(true)} toast={show} />

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} toast={show} />}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}
