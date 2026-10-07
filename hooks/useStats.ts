'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api-client'
import type { Stats } from '@/lib/types'
import { usePolling } from './usePolling'

/** Métricas del día. `version` cambia tras cada acción que las afecta y fuerza una recarga. */
export function useStats(version: number) {
  const [stats, setStats] = useState<Stats | null>(null)

  const load = useCallback(async () => {
    try { setStats(await api<Stats>('/api/stats')) } catch { /* el polling reintentará */ }
  }, [])

  useEffect(() => { void load() }, [load, version])
  usePolling(load, 15_000)

  return stats
}
