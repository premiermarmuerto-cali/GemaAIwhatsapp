import type { Metadata } from 'next'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LoginForm } from './LoginForm'
import styles from './login.module.css'

export const metadata: Metadata = { title: 'Acceder · Premier Mar Muerto' }

function safeNext(next: string | undefined) {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams
  return (
    <main className={styles.screen}>
      <div className={styles.pattern} aria-hidden="true"><div className="gem-pattern" /><div className="gem-shine" /></div>
      <div className={styles.topbar}>
        <span className="eyebrow">Panel interno</span>
        <div className={styles.topbarEnd}>
          <span className="eyebrow">Cali</span>
          <ThemeToggle />
        </div>
      </div>

      <section className={styles.panel}>
        <span className={`brand-mark ${styles.logo}`} aria-hidden="true" />
        <h1 className={styles.wordmark}>Premier Mar Muerto</h1>
        <p className={styles.tagline}><span>Especialistas en el</span> <b>cuidado de la piel</b></p>
        <LoginForm next={safeNext(next)} />
      </section>

      <nav className={styles.footer} aria-label="Sedes y servicios">
        <span>Unicentro</span><span>Chipichape</span><span>Limpiezas</span><span>Minerales</span>
      </nav>
    </main>
  )
}
