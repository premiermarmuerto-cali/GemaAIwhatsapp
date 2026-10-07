// Cliente HTTP del panel. Una sesión expirada devuelve 401: se manda al login.

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  })
  if (response.status === 401) {
    window.location.assign('/login')
    throw new ApiError(401, 'Sesión expirada.')
  }
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(response.status, (data as { error?: string } | null)?.error ?? `Error ${response.status}`)
  return data as T
}

export const chatPath = (phone: string) => `/api/chats/${encodeURIComponent(phone)}`
