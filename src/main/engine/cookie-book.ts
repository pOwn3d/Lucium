// The cookies of a session, for the "Cookies par site" view: listed without their values, removed one by one. Typed against the few methods
// of Electron's cookie jar it uses, so that the rules (a value never leaves, a failure is counted and reported) are testable without Electron.

import { siteOfCookie, type CookieEntry, type CookieRemoval } from '@shared/cookies'

/** What the jar reports of a cookie (the value is in it; this module is where it stops). */
export interface JarCookie {
  name: string
  value: string
  domain?: string
  hostOnly?: boolean
  path?: string
  secure?: boolean
  session?: boolean
}

export interface CookieJarSession {
  cookies: {
    get(filter: Record<string, never>): Promise<JarCookie[]>
    remove(url: string, name: string): Promise<void>
    flushStore(): Promise<void>
  }
}

/** Cookies listed at most: a jar past this is cut, the largest sites first being the ones a user cares about. */
export const COOKIE_LIST_MAX = 50_000

/** Every cookie of the session as the view may know it: name, place and size, never the value. */
export async function listCookies(ses: CookieJarSession): Promise<CookieEntry[]> {
  const jar = await ses.cookies.get({})
  return jar.slice(0, COOKIE_LIST_MAX).map((cookie) => ({
    domain: cookie.domain ?? '',
    name: cookie.name,
    path: cookie.path ?? '/',
    secure: cookie.secure === true,
    session: cookie.session === true,
    hostOnly: cookie.hostOnly === true,
    size: Buffer.byteLength(cookie.name) + Buffer.byteLength(cookie.value)
  }))
}

/** The address that removes a cookie: its own domain and path, over the scheme it is sent on. An IPv6 address needs its brackets. */
export function cookieUrl(cookie: Pick<CookieEntry, 'domain' | 'path' | 'secure'>): string {
  const host = siteOfCookie(cookie.domain)
  const authority = host.includes(':') ? `[${host}]` : host
  return `${cookie.secure ? 'https' : 'http'}://${authority}${cookie.path.startsWith('/') ? cookie.path : `/${cookie.path}`}`
}

/** Removes the cookies given, one by one: one that cannot be removed is counted and the others still go. The jar is flushed to disk once. */
export async function removeCookies(ses: CookieJarSession, cookies: readonly CookieEntry[]): Promise<CookieRemoval> {
  let removed = 0
  let failed = 0
  for (const cookie of cookies) {
    try {
      await ses.cookies.remove(cookieUrl(cookie), cookie.name)
      removed++
    } catch (error) {
      failed++
      console.error(`[cookies] cannot remove a cookie of ${siteOfCookie(cookie.domain)}:`, error instanceof Error ? error.message : error)
    }
  }
  if (removed > 0) {
    try {
      await ses.cookies.flushStore()
    } catch (error) {
      console.error('[cookies] cannot write the cookie jar to disk:', error instanceof Error ? error.message : error)
    }
  }
  return { removed, failed }
}
