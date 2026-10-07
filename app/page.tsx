import { Console } from '@/components/console/Console'

// La bandeja se lee siempre fresca: el estado vive en Upstash, no en la caché de Next.
export const dynamic = 'force-dynamic'

export default function HomePage() {
  return <Console />
}
