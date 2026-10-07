'use client'

import { useEffect, useRef } from 'react'

/** Ejecuta `task` cada `intervalMs` mientras la pestaña esté visible, y de inmediato al volver a ella. */
export function usePolling(task: () => unknown, intervalMs: number, enabled = true) {
  const latest = useRef(task)
  useEffect(() => { latest.current = task })

  useEffect(() => {
    if (!enabled) return
    const tick = () => { if (document.visibilityState === 'visible') latest.current() }
    const timer = window.setInterval(tick, intervalMs)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [intervalMs, enabled])
}
