export type Theme = 'dark' | 'light'

export const THEME_COOKIE = 'pm_theme'

export const THEME_COLOR: Record<Theme, string> = { dark: '#14170b', light: '#f9faf7' }

/** El sitio oficial es light-first, así que el panel arranca en claro. */
export function parseTheme(value: string | undefined): Theme {
  return value === 'dark' ? 'dark' : 'light'
}
