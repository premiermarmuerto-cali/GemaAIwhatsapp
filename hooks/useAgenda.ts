'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api-client'
import { dayKey, monthGrid, weekOf } from '@/lib/calendar'
import type { Revisions } from '@/lib/revision'
import { usePolling } from './usePolling'
import type { ShowToast } from './useToast'
import type { AgendaWeek, Booking, BookingStatus, Location } from '@/lib/types'

// Cada 15 s se pregunta si cambió la agenda (un comando, lib/revision.ts) y solo entonces se relee
// la semana o el mes (un mes son ~100 comandos). La recarga de respaldo libera en pantalla los
// apartados que vencen sin que nadie toque la agenda.
const REVISION_POLL_MS = 15_000
const FALLBACK_REFRESH_MS = 5 * 60_000

export type NewAppointment = {
  phone: string
  name: string
  location: Location
  serviceId: string
  day: string
  start: string
  concern?: string
  notes?: string
  kind?: 'appointment' | 'block'
  /** 2 = pareja: una cabina por persona, a la misma hora. */
  people?: number
  /** Quién agenda la cita y a quién le corresponde. */
  advisor?: string
}

/** Semana (grilla por horas) o mes (seis semanas, citas en lista por día). */
export type AgendaView = 'week' | 'month'

const VIEW_KEY = 'pm_agenda_view'

/**
 * Estado de la agenda del panel. Relee la semana completa tras cada acción en vez de
 * parchear en memoria: es una pantalla que dos operadores miran a la vez y lo que importa
 * es que lo que se ve sea lo que hay en Upstash.
 */
export function useAgenda(toast: ShowToast) {
  const [anchor, setAnchor] = useState(() => dayKey())
  const [view, setViewState] = useState<AgendaView>('week')
  const [week, setWeek] = useState<AgendaWeek | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Solo cuenta la respuesta del último pedido: al cambiar rápido de semana o de vista, una respuesta
  // vieja no pisa la nueva.
  const latest = useRef(0)

  // La vista elegida se recuerda en este navegador (es una comodidad, no un dato del negocio).
  useEffect(() => {
    try { if (window.localStorage.getItem(VIEW_KEY) === 'month') setViewState('month') } catch { /* sin almacenamiento */ }
  }, [])
  const setView = useCallback((next: AgendaView) => {
    setViewState(next)
    try { window.localStorage.setItem(VIEW_KEY, next) } catch { /* sin almacenamiento */ }
  }, [])

  const load = useCallback(async (at: string, mode: AgendaView) => {
    const request = ++latest.current
    try {
      const data = await api<AgendaWeek>(`/api/agenda?${mode === 'month' ? 'month' : 'week'}=${at}`)
      if (request !== latest.current) return
      setWeek(data)
      setLoadError(null)
    } catch (error) {
      if (request !== latest.current) return
      setLoadError(error instanceof ApiError ? error.message : 'No se pudo cargar la agenda.')
    }
  }, [])

  useEffect(() => { void load(anchor, view) }, [anchor, view, load])
  const lastRevision = useRef<string | null>(null)
  usePolling(async () => {
    try {
      const { agenda } = await api<Revisions>('/api/revision')
      const changed = lastRevision.current !== null && agenda !== lastRevision.current
      lastRevision.current = agenda
      if (changed) await load(anchor, view)
    } catch { /* la recarga de respaldo lo corrige */ }
  }, REVISION_POLL_MS, true, 60_000)
  usePolling(() => void load(anchor, view), FALLBACK_REFRESH_MS, true, 30 * 60_000)

  const act = useCallback(async <T,>(task: () => Promise<T>, ok: string): Promise<T | null> => {
    setBusy(true)
    try {
      const result = await task()
      await load(anchor, view)
      toast(ok)
      return result
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'La acción falló.', { tone: 'error' })
      return null
    } finally {
      setBusy(false)
    }
  }, [anchor, view, load, toast])

  return {
    week,
    days: week?.days ?? (view === 'month' ? monthGrid(anchor) : weekOf(anchor)),
    anchor,
    view,
    setView,
    loadError,
    busy,
    refresh: () => load(anchor, view),
    goTo: setAnchor,
    setStatus: (id: string, status: BookingStatus) =>
      act(() => api<Booking>(`/api/agenda/${id}`, { method: 'PATCH', body: { status } }), 'Estado actualizado'),
    annotate: (id: string, notes: string) =>
      act(() => api<Booking>(`/api/agenda/${id}`, { method: 'PATCH', body: { notes } }), 'Nota guardada'),
    setAdvisor: (id: string, advisor: string) =>
      act(() => api<Booking>(`/api/agenda/${id}`, { method: 'PATCH', body: { advisor } }), 'Asesor actualizado'),
    reschedule: (id: string, day: string, start: string, location?: Location) =>
      act(() => api<Booking>(`/api/agenda/${id}`, { method: 'PATCH', body: { day, start, location } }), 'Cita reprogramada'),
    cancel: (id: string) =>
      act(() => api<Booking>(`/api/agenda/${id}`, { method: 'DELETE' }), 'Cita cancelada'),
    create: (input: NewAppointment) =>
      act(() => api<Booking>('/api/agenda', { method: 'POST', body: input }), input.kind === 'block' ? 'Horario bloqueado' : 'Cita creada'),
    closeDay: (day: string, reason: string | null) =>
      act(() => api<unknown>('/api/agenda/slots', { method: 'PUT', body: reason === null ? { day, closed: false } : { day, reason } }), reason === null ? 'Día reabierto' : 'Día cerrado'),
  }
}
