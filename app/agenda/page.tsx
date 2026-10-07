import type { Metadata } from 'next'
import { Agenda } from '@/components/agenda/Agenda'

export const metadata: Metadata = { title: 'Agenda · Premier Mar Muerto' }

// La agenda se lee siempre fresca: dos operadores la miran a la vez.
export const dynamic = 'force-dynamic'

export default function AgendaPage() {
  return <Agenda />
}
