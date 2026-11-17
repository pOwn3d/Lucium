import { afterEach, describe, expect, it, vi } from 'vitest'
import { cookiesToClean, type CookieEntry } from '@shared/cookies'
import { cookieUrl, listCookies, removeCookies, type CookieJarSession, type JarCookie } from './cookie-book'

afterEach(() => vi.restoreAllMocks())

function jar(cookies: JarCookie[], options: { failOn?: string; failFlush?: boolean } = {}) {
  const removed: string[] = []
  const ses: CookieJarSession = {
    cookies: {
      get: async () => cookies,
      remove: async (url, name) => {
        if (name === options.failOn) throw new Error('refus')
        removed.push(`${url}#${name}`)
      },
      flushStore: async () => {
        if (options.failFlush) throw new Error('disque plein')
      }
    }
  }
  return { ses, removed }
}

const cookies: JarCookie[] = [
  { name: 'sid', value: 'SECRET-VALUE-1', domain: '.exemple.org', hostOnly: false, path: '/', secure: true, session: false },
  { name: 'pref', value: 'é', domain: 'exemple.org', hostOnly: true, path: '/app', secure: false, session: true },
  { name: 'v6', value: 'x', domain: '::1', hostOnly: true, path: '/', secure: false }
]

describe('listing the cookies', () => {
  it('reports names, places and sizes, and never a value', async () => {
    const list = await listCookies(jar(cookies).ses)
    expect(list).toHaveLength(3)
    expect(JSON.stringify(list)).not.toContain('SECRET-VALUE-1')
    expect(list.every((c) => !('value' in c))).toBe(true)
    expect(list[0]).toEqual({ domain: '.exemple.org', name: 'sid', path: '/', secure: true, session: false, hostOnly: false, size: 3 + 14 })
    // Bytes, not characters: the value "é" is two bytes.
    expect(list[1]!.size).toBe(4 + 2)
    expect(list[2]).toMatchObject({ path: '/', secure: false, session: false })
  })
})

describe('the address that removes a cookie', () => {
  it('is its own domain and path over the scheme it is sent on', () => {
    expect(cookieUrl({ domain: '.exemple.org', path: '/', secure: true })).toBe('https://exemple.org/')
    expect(cookieUrl({ domain: 'exemple.org', path: '/app', secure: false })).toBe('http://exemple.org/app')
    expect(cookieUrl({ domain: '::1', path: '/', secure: false })).toBe('http://[::1]/')
    expect(cookieUrl({ domain: 'a.example', path: 'chemin', secure: true })).toBe('https://a.example/chemin')
  })
})

describe('removing cookies', () => {
  const entries = (): Promise<CookieEntry[]> => listCookies(jar(cookies).ses)

  it('removes each cookie by its own address and flushes the jar once', async () => {
    const { ses, removed } = jar(cookies)
    const flush = vi.spyOn(ses.cookies, 'flushStore')
    expect(await removeCookies(ses, await entries())).toEqual({ removed: 3, failed: 0 })
    expect(removed).toEqual(['https://exemple.org/#sid', 'http://exemple.org/app#pref', 'http://[::1]/#v6'])
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('counts a cookie that cannot be removed, logs it with its site, and removes the others', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ses, removed } = jar(cookies, { failOn: 'pref' })
    expect(await removeCookies(ses, await entries())).toEqual({ removed: 2, failed: 1 })
    expect(removed).toHaveLength(2)
    expect(error).toHaveBeenCalledWith('[cookies] cannot remove a cookie of exemple.org:', 'refus')
  })

  it('reports a jar that cannot be written, without losing the count of what was removed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await removeCookies(jar(cookies, { failFlush: true }).ses, await entries())).toEqual({ removed: 3, failed: 0 })
    expect(error).toHaveBeenCalledWith('[cookies] cannot write the cookie jar to disk:', 'disque plein')
  })

  it('does nothing and does not touch the disk for nothing to remove', async () => {
    const { ses } = jar(cookies)
    const flush = vi.spyOn(ses.cookies, 'flushStore')
    expect(await removeCookies(ses, [])).toEqual({ removed: 0, failed: 0 })
    expect(flush).not.toHaveBeenCalled()
  })

  it('the clean-up removes what the list does not keep, from the real jar format', async () => {
    const { ses, removed } = jar(cookies)
    const toRemove = cookiesToClean(await listCookies(ses), ['exemple.org'])
    await removeCookies(ses, toRemove)
    expect(removed).toEqual(['http://[::1]/#v6'])
  })
})
