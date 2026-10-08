import type { Metadata, Viewport } from 'next'
import { Montserrat } from 'next/font/google'
import { cookies } from 'next/headers'
import { parseTheme, THEME_COLOR, THEME_COOKIE } from '@/lib/theme'
import './globals.css'

// Una sola familia, igual que premier-deadsea.com: alli --heading-font-family y
// --text-font-family son ambas Montserrat. Solo los 4 pesos que el CSS usa de verdad
// (300/400/500/600): cada peso de más es otro archivo de fuente que descargar.
const montserrat = Montserrat({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-montserrat',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Premier Mar Muerto · Panel',
  description: 'Agenda y atención por WhatsApp de Premier Mar Muerto Cali',
  icons: { icon: '/brand/favicon.svg' },
  robots: { index: false, follow: false },
}

async function currentTheme() {
  return parseTheme((await cookies()).get(THEME_COOKIE)?.value)
}

export async function generateViewport(): Promise<Viewport> {
  return { themeColor: THEME_COLOR[await currentTheme()] }
}

// El tema se resuelve en el servidor desde la cookie: la primera pintura ya sale con el tema correcto.
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es" data-theme={await currentTheme()} className={montserrat.variable} suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  )
}
