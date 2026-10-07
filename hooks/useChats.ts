'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, chatPath } from '@/lib/api-client'
import { formatPhone } from '@/lib/phone'
import type { ChatDetail, ChatLists, ChatSummary, Message, Stage } from '@/lib/types'
import { usePolling } from './usePolling'
import type { ShowToast } from './useToast'

const LIST_POLL_MS = 5000
const DETAIL_POLL_MS = 3000

const byRecent = (a: ChatSummary, b: ChatSummary) => b.lastAt - a.lastAt

/** Aplica un cambio a un chat y lo recoloca en la bandeja que le corresponde según `archived`. */
function patchLists(lists: ChatLists, phone: string, update: (chat: ChatSummary) => ChatSummary): ChatLists {
  const target = lists.inbox.find((chat) => chat.phone === phone) ?? lists.archived.find((chat) => chat.phone === phone)
  if (!target) return lists
  const next = update(target)
  const inbox = lists.inbox.filter((chat) => chat.phone !== phone)
  const archived = lists.archived.filter((chat) => chat.phone !== phone)
  ;(next.archived ? archived : inbox).push(next)
  return { inbox: inbox.sort(byRecent), archived: archived.sort(byRecent) }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Error desconocido'
}

/**
 * Estado del panel con UI optimista: cada acción cambia la pantalla al instante, llama a la API
 * y, si falla, restaura el estado anterior. Mientras hay mutaciones en curso se descartan los
 * resultados del polling para que no pisen los cambios optimistas.
 */
export function useChats(toast: ShowToast) {
  const [lists, setLists] = useState<ChatLists>({ inbox: [], archived: [] })
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activePhone, setActivePhone] = useState<string | null>(null)
  const [detail, setDetail] = useState<ChatDetail | null>(null)
  const [statsVersion, setStatsVersion] = useState(0)

  const listsRef = useRef(lists)
  const detailRef = useRef(detail)
  const activeRef = useRef<string | null>(null)
  const busy = useRef(0)
  const epoch = useRef(0)
  const seen = useRef<Map<string, { needsAgent: boolean; agentKind: string; lastImageAt: number }> | null>(null)
  useEffect(() => { listsRef.current = lists }, [lists])
  useEffect(() => { detailRef.current = detail }, [detail])

  const isStale = (startedAt: number) => busy.current > 0 || startedAt !== epoch.current

  const refreshLists = useCallback(async () => {
    const startedAt = epoch.current
    try {
      const data = await api<ChatLists>('/api/chats')
      if (isStale(startedAt)) return
      setLists(data)
      setLoadError(null)
      announce(data)
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) setLoadError(errorText(error))
    } finally {
      setLoaded(true)
    }
  }, [])

  /** Avisa de cada chat que pasa a "Requiere asesor" y de cada imagen nueva (posible comprobante). No avisa en la carga inicial. */
  const announce = useCallback((data: ChatLists) => {
    const chats = [...data.inbox, ...data.archived]
    const known = seen.current
    seen.current = new Map(chats.map((chat) => [chat.phone, { needsAgent: chat.needsAgent, agentKind: chat.agentKind, lastImageAt: chat.lastImageAt }]))
    if (!known) return
    const open = (phone: string) => ({ label: 'Abrir', run: () => selectRef.current(phone) })
    for (const chat of chats) {
      const before = known.get(chat.phone)
      if (chat.needsAgent && (!before?.needsAgent || before.agentKind !== chat.agentKind)) {
        const label = chat.agentKind === 'payment' ? 'Anticipo por validar' : 'Requiere asesor'
        toast(`${label} · ${formatPhone(chat.phone)}: ${chat.agentReason}`, { duration: 12_000, action: open(chat.phone) })
      } else if (chat.lastImageAt > (before?.lastImageAt ?? 0)) {
        toast(`${formatPhone(chat.phone)} mandó una imagen`, { duration: 8000, action: open(chat.phone) })
      }
    }
  }, [toast])

  const refreshDetail = useCallback(async (phone = activeRef.current, initial = false) => {
    if (!phone) return
    const startedAt = epoch.current
    try {
      const data = await api<ChatDetail>(chatPath(phone))
      if (activeRef.current !== phone || (!initial && isStale(startedAt))) return
      setDetail(data)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && activeRef.current === phone) {
        activeRef.current = null
        setActivePhone(null)
        setDetail(null)
      }
    }
  }, [])

  useEffect(() => { void refreshLists() }, [refreshLists])
  usePolling(refreshLists, LIST_POLL_MS)
  usePolling(() => refreshDetail(), DETAIL_POLL_MS, Boolean(activePhone))

  const selectRef = useRef<(phone: string | null) => void>(() => {})

  const select = useCallback((phone: string | null) => {
    activeRef.current = phone
    setActivePhone(phone)
    setDetail((current) => (current?.phone === phone ? current : null))
    if (!phone) return
    setLists((current) => patchLists(current, phone, (chat) => ({ ...chat, unread: 0 })))
    void refreshDetail(phone, true)
  }, [refreshDetail])
  useEffect(() => { selectRef.current = select }, [select])

  const applySummary = useCallback((summary: ChatSummary) => {
    setLists((current) => patchLists(current, summary.phone, () => summary))
    setDetail((current) => (current?.phone === summary.phone ? { ...current, ...summary, unread: 0 } : current))
  }, [])

  const optimisticChat = useCallback((phone: string, update: (chat: ChatSummary) => ChatSummary) => {
    setLists((current) => patchLists(current, phone, update))
    setDetail((current) => (current?.phone === phone ? { ...current, ...update(current) } : current))
  }, [])

  /** Núcleo de la UI optimista: aplica, llama a la API y revierte si falla. */
  const run = useCallback(async <T,>(options: { optimistic: () => void; request: () => Promise<T>; onSuccess: (result: T) => void; failure: string }) => {
    const snapshot = { lists: listsRef.current, detail: detailRef.current }
    busy.current++
    epoch.current++
    options.optimistic()
    try {
      options.onSuccess(await options.request())
      return true
    } catch (error) {
      setLists(snapshot.lists)
      setDetail(snapshot.detail)
      if (!(error instanceof ApiError && error.status === 401)) toast(`${options.failure}: ${errorText(error)}`, { tone: 'error' })
      return false
    } finally {
      busy.current--
      epoch.current++
    }
  }, [toast])

  const find = useCallback((phone: string) => (
    listsRef.current.inbox.find((chat) => chat.phone === phone) ?? listsRef.current.archived.find((chat) => chat.phone === phone)
  ), [])

  const patchChat = (phone: string, body: Record<string, unknown>) => api<ChatSummary>(chatPath(phone), { method: 'PATCH', body })

  const toggleBot = useCallback(async (phone: string) => {
    const chat = find(phone)
    if (!chat) return
    const botActive = !chat.botActive
    const ok = await run({
      optimistic: () => optimisticChat(phone, (current) => ({ ...current, botActive, needsAgent: botActive ? false : current.needsAgent })),
      request: () => patchChat(phone, { botActive }),
      onSuccess: applySummary,
      failure: 'No se pudo cambiar el modo',
    })
    if (ok) toast(botActive ? 'Gema retomó la conversación' : 'Control humano activado · Gema en pausa')
  }, [find, run, optimisticChat, applySummary, toast])

  const setStage = useCallback(async (phone: string, stage: Stage) => {
    const ok = await run({
      optimistic: () => optimisticChat(phone, (current) => ({ ...current, stage, needsAgent: stage === 'booked' ? false : current.needsAgent })),
      request: () => patchChat(phone, { stage }),
      onSuccess: applySummary,
      failure: 'No se pudo actualizar el estado',
    })
    if (ok) {
      setStatsVersion((version) => version + 1)
      toast(stage === 'booked' ? 'Chat marcado como agendado' : 'Marca de agendado quitada')
    }
  }, [run, optimisticChat, applySummary, toast])

  const resolveAgent = useCallback(async (phone: string) => {
    const ok = await run({
      optimistic: () => optimisticChat(phone, (current) => ({ ...current, needsAgent: false })),
      request: () => patchChat(phone, { needsAgent: false }),
      onSuccess: applySummary,
      failure: 'No se pudo quitar la alerta',
    })
    if (ok) toast('Alerta quitada · Gema sigue en pausa')
  }, [run, optimisticChat, applySummary, toast])

  const setArchived: (phone: string, archived: boolean) => Promise<void> = useCallback(async (phone: string, archived: boolean) => {
    const ok = await run({
      optimistic: () => optimisticChat(phone, (current) => ({ ...current, archived })),
      request: () => patchChat(phone, { archived }),
      onSuccess: applySummary,
      failure: archived ? 'No se pudo archivar' : 'No se pudo restaurar',
    })
    if (!ok) return
    setStatsVersion((version) => version + 1)
    toast(archived ? 'Conversación archivada' : 'Conversación devuelta a la bandeja', {
      action: { label: 'Deshacer', run: () => void setArchived(phone, !archived) },
    })
  }, [run, optimisticChat, applySummary, toast])

  const remove = useCallback(async (phone: string) => {
    const wasActive = activeRef.current === phone
    const ok = await run({
      optimistic: () => {
        setLists((current) => ({ inbox: current.inbox.filter((chat) => chat.phone !== phone), archived: current.archived.filter((chat) => chat.phone !== phone) }))
        if (activeRef.current === phone) select(null)
      },
      request: () => api(chatPath(phone), { method: 'DELETE' }),
      onSuccess: () => setStatsVersion((version) => version + 1),
      failure: 'No se pudo eliminar',
    })
    if (ok) toast('Conversación eliminada')
    else if (wasActive && !activeRef.current) select(phone)
  }, [run, select, toast])

  const send = useCallback(async (phone: string, text: string) => {
    const temp: Message = { id: `tmp-${Date.now()}`, sender: 'human', text, at: Date.now(), pending: 'sending' }
    const ok = await run({
      optimistic: () => {
        optimisticChat(phone, (current) => ({ ...current, botActive: false, needsAgent: false, lastMessage: text, lastSender: 'human', lastAt: temp.at }))
        setDetail((current) => (current?.phone === phone ? { ...current, messages: [...current.messages, temp] } : current))
      },
      request: () => api<{ message: Message; chat: ChatSummary }>(`${chatPath(phone)}/messages`, { method: 'POST', body: { text } }),
      onSuccess: ({ message, chat }) => {
        applySummary(chat)
        setDetail((current) => (current?.phone === phone ? { ...current, messages: current.messages.map((item) => (item.id === temp.id ? message : item)) } : current))
        setStatsVersion((version) => version + 1)
      },
      failure: 'Mensaje no enviado',
    })
    return ok
  }, [run, optimisticChat, applySummary])

  const activeChat: ChatDetail | ChatSummary | null = useMemo(() => {
    if (!activePhone) return null
    if (detail?.phone === activePhone) return detail
    return lists.inbox.find((chat) => chat.phone === activePhone) ?? lists.archived.find((chat) => chat.phone === activePhone) ?? null
  }, [activePhone, detail, lists])

  return {
    lists,
    loaded,
    loadError,
    activePhone,
    activeChat,
    messages: detail?.phone === activePhone ? detail.messages : null,
    statsVersion,
    select,
    toggleBot,
    setStage,
    resolveAgent,
    setArchived,
    remove,
    send,
    refresh: refreshLists,
  }
}

export type ChatsController = ReturnType<typeof useChats>
