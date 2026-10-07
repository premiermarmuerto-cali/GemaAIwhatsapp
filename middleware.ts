import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySession } from '@/lib/auth'
import { clientIp, rateLimit } from '@/lib/ratelimit'

// Rutas accesibles sin sesión. El webhook se protege con la firma de Meta, no con cookie.
const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/webhook']
const API_LIMIT_PER_MINUTE = 120

function isPublic(pathname: string) {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const isApi = pathname.startsWith('/api/')
  const authed = await verifySession(request.cookies.get(SESSION_COOKIE)?.value)

  if (isPublic(pathname)) {
    if (pathname === '/login' && authed) return NextResponse.redirect(new URL('/', request.url))
    return NextResponse.next()
  }

  if (!authed) {
    if (isApi) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 })
    const login = new URL('/login', request.url)
    if (pathname !== '/') login.searchParams.set('next', pathname + search)
    return NextResponse.redirect(login)
  }

  if (isApi) {
    // Las mutaciones solo se aceptan desde el propio panel.
    const origin = request.headers.get('origin')
    if (request.method !== 'GET' && origin && origin !== request.nextUrl.origin) {
      return NextResponse.json({ error: 'Origen no permitido.' }, { status: 403 })
    }
    const limit = await rateLimit('api', clientIp(request.headers), API_LIMIT_PER_MINUTE, 60).catch(() => null)
    if (limit && !limit.ok) {
      return NextResponse.json({ error: 'Demasiadas peticiones.' }, { status: 429, headers: { 'Retry-After': String(limit.resetIn) } })
    }
  }

  return NextResponse.next()
}

export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!_next/static|_next/image|brand/|favicon.ico|robots.txt).*)'],
}
