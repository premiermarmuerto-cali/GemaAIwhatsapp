'use client'

import { MoonIcon, SunIcon } from '@/components/icons'
import { parseTheme, THEME_COLOR, THEME_COOKIE } from '@/lib/theme'
import styles from './ThemeToggle.module.css'

// Sin estado de React: el tema vive en <html data-theme> y los íconos se muestran por CSS, así no hay desajuste de hidratación.
export function ThemeToggle() {
  function toggle() {
    const root = document.documentElement
    const next = parseTheme(root.dataset.theme) === 'light' ? 'dark' : 'light'
    root.dataset.theme = next
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[next])
  }

  return (
    <button type="button" className="btn btn-ghost btn-icon" onClick={toggle} aria-label="Cambiar tema claro u oscuro" title="Cambiar tema">
      <span className={styles.sun}><SunIcon /></span>
      <span className={styles.moon}><MoonIcon /></span>
    </button>
  )
}
