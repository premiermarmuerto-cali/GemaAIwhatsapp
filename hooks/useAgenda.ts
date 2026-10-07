'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '@/lib/api-client'
import { dayKey, weekOf } from '@/lib/calendar'
import { usePolling } from './usePolling'
import type { ShowToast } from './useToast'
import type { AgendaWeek, Booking, BookingStatus, Location } from '@/lib/types'

const REFRESH_MS = 30_000

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
}

/**
 * Estado de la agenda del panel. Relee la semana completa tras cada acción en vez de
 * parchear en memoria: es una pantalla que dos operadores miran a la vez y lo que importa
 * es que lo que se ve sea lo que hay en Upstash.
 */
export function useAgenda(toast: ShowToast) {
  const [anchor, setAnchor] = useState(() => dayKey())
  const [week, setWeek] = useState<AgendaWeek | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (at: string) => {
    try {
      setWeek(await api<AgendaWeek>(`/api/agenda?week=${at}`))
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof ApiError ? error.message : 'No se pudo cargar la agenda.')
    }
  }, [])

  useEffect(() => { void load(anchor) }, [anchor, load])
  usePolling(() => void load(anchor), REFRESH_MS)

  const act = useCallback(async <T,>(task: () => Promise<T>, ok: string): Promise<T | null> => {
    setBusy(true)
    try {
      const result = await task()
      await load(anchor)
      toast(ok)
      return result
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'La acción falló.', { tone: 'error' })
      return null
    } finally {
      setBusy(false)
    }
  }, [anchor, load, toast])

  return {
    week,
    days: week?.days ?? weekOf(anchor),
    anchor,
    loadError,
    busy,
    refresh: () => load(anchor),
    goTo: setAnchor,
    setStatus: (id: string, status: BookingStatus) =>
      act(() => api<Booking>(`/api/agenda/${id}`, { method: 'PATCH', body: { status } }), 'Estado actualizado'),
    annotate: (id: string, notes: string) =>
      act(() => api<Booking>(`/api/agenda/${id}`, { method: 'PATCH', body: { notes } }), 'Nota guardada'),
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
