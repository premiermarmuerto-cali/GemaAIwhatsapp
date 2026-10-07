'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { ArrowIcon } from '@/components/icons'
import styles from './login.module.css'

export function LoginForm({ next }: { next: string }) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!password || loading) return
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null
        setError(data?.error ?? 'No se pudo iniciar sesión.')
        setLoading(false)
        return
      }
      router.replace(next)
      router.refresh()
    } catch {
      setError('Sin conexión con el servidor.')
      setLoading(false)
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <label className={styles.label} htmlFor="password">Contraseña de operador</label>
      <input
        id="password"
        className={styles.input}
        type="password"
        autoComplete="current-password"
        autoFocus
        placeholder="••••••••••••"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? 'login-error' : undefined}
      />
      <button className={`btn btn-primary ${styles.submit}`} type="submit" disabled={loading}>
        <span>{loading ? 'Verificando…' : 'Entrar a la consola'}</span>
        <ArrowIcon />
      </button>
      <p id="login-error" className={styles.error} role="alert">{error}</p>
    </form>
  )
}
