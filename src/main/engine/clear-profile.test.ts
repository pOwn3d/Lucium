import { describe, expect, it, vi } from 'vitest'
import { clearProfileSession, type ClearableSession } from './clear-profile'
import type { JarCookie } from './cookie-book'

const jarCookie = (domain: string, name = 'sid'): JarCookie => ({ name, value: 'secret', domain, hostOnly: !domain.startsWith('.'), path: '/', secure: true, session: false })

function fakeSession(jar: JarCookie[], failing: string[] = []) {
  const clearData = vi.fn(async (_options: Record<string, unknown>) => undefined)
  const remove = vi.fn(async (url: string, _name: string) => {
    if (failing.some((host) => url.includes(host))) throw new Error('locked')
    return undefined
  })
  const session: ClearableSession = { clearData, cookies: { get: async () => jar, remove, flushStore: async () => undefined } }
  return { session, clearData, remove }
}

describe('erasing a profile session', () => {
  it('wipes everything in one call, as before, when no site is spared', async () => {
    const { session, clearData, remove } = fakeSession([jarCookie('exemple.org')])
    await clearProfileSession(session, { extensionOrigins: [], keepHosts: [] })
    expect(clearData).toHaveBeenCalledTimes(1)
    expect(clearData).toHaveBeenCalledWith({})
    expect(remove).not.toHaveBeenCalled()
  })

  it('still spares the origins of the extensions when no site is spared', async () => {
    const { session, clearData } = fakeSession([])
    await clearProfileSession(session, { extensionOrigins: ['chrome-extension://abc'], keepHosts: [] })
    expect(clearData).toHaveBeenCalledWith({ excludeOrigins: ['chrome-extension://abc'] })
  })

  it('spares the storage of the listed sites: their origins are excluded, and the cookies are not wiped by origin', async () => {
    const { session, clearData } = fakeSession([])
    await clearProfileSession(session, { extensionOrigins: ['chrome-extension://abc'], keepHosts: ['exemple.org'] })
    const options = clearData.mock.calls[0]![0] as { excludeOrigins: string[]; dataTypes: string[] }
    expect(options.excludeOrigins).toEqual(['chrome-extension://abc', 'https://exemple.org', 'http://exemple.org', 'https://www.exemple.org', 'http://www.exemple.org'])
    expect(options.dataTypes).not.toContain('cookies')
    expect(options.dataTypes).toContain('localStorage')
  })

  it('removes the cookies of every site but the listed ones (subdomains of a listed site included)', async () => {
    const { session, remove } = fakeSession([jarCookie('.exemple.org'), jarCookie('app.exemple.org', 'a'), jarCookie('.autre.net', 'b'), jarCookie('banque.fr', 'c')])
    await clearProfileSession(session, { extensionOrigins: [], keepHosts: ['exemple.org'] })
    expect(remove.mock.calls.map((call) => call[1])).toEqual(['b', 'c'])
  })

  it('says so when a cookie could not be removed, instead of reporting an erasure that did not happen', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { session } = fakeSession([jarCookie('.autre.net')], ['autre.net'])
      await expect(clearProfileSession(session, { extensionOrigins: [], keepHosts: ['exemple.org'] })).rejects.toThrow(/1/)
    } finally {
      error.mockRestore()
    }
  })
})
