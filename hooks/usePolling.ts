'use client'

import { useEffect, useRef } from 'react'

/** Sin mouse, teclado ni toques en este tiempo, el panel se considera desatendido. */
const IDLE_AFTER_MS = 3 * 60_000
let lastActivity = Date.now()
let listening = false

/** Registra la actividad del operador una sola vez para toda la página. */
function trackActivity() {
  if (listening || typeof window === 'undefined') return
  listening = true
  const touch = () => { lastActivity = Date.now() }
  for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focus']) window.addEventListener(event, touch, { passive: true })
}

/**
 * Ejecuta `task` cada `intervalMs` mientras la pestaña esté visible, y de inmediato al volver a ella.
 * Con `idleIntervalMs`, si nadie usa el panel hace más de 3 minutos (una pantalla abierta en la
 * recepción), consulta con esa frecuencia más lenta: cada consulta cuesta comandos de Upstash.
 * Al volver a mover el mouse o tocar una tecla, recupera el ritmo normal en el siguiente ciclo.
 */
export function usePolling(task: () => unknown, intervalMs: number, enabled = true, idleIntervalMs = intervalMs) {
  const latest = useRef(task)
  useEffect(() => { latest.current = task })

  useEffect(() => {
    if (!enabled) return
    trackActivity()
    let lastRun = Date.now()
    const run = () => { lastRun = Date.now(); latest.current() }
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      const idle = Date.now() - lastActivity > IDLE_AFTER_MS
      if (!idle || Date.now() - lastRun >= idleIntervalMs - 500) run()
    }
    const onVisible = () => { if (document.visibilityState === 'visible') { lastActivity = Date.now(); run() } }
    const timer = window.setInterval(tick, intervalMs)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [intervalMs, idleIntervalMs, enabled])
}
