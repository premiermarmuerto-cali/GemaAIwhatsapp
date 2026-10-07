'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type ToastTone = 'info' | 'error'
export type Toast = { id: number; text: string; tone: ToastTone; action?: { label: string; run: () => void } }
export type ShowToast = (text: string, options?: { tone?: ToastTone; action?: Toast['action']; duration?: number }) => void

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<number, number>())
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const show = useCallback<ShowToast>((text, options = {}) => {
    const id = nextId.current++
    const tone = options.tone ?? 'info'
    setToasts((current) => [...current.slice(-2), { id, text, tone, action: options.action }])
    const duration = options.duration ?? (tone === 'error' ? 5000 : options.action ? 5000 : 2600)
    timers.current.set(id, window.setTimeout(() => dismiss(id), duration))
  }, [dismiss])

  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((timer) => window.clearTimeout(timer))
  }, [])

  return { toasts, show, dismiss }
}
