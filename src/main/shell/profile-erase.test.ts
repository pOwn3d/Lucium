import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { eraseBrowsingHistory, eraseProfile, eraseProfiles, type BrowsingHistoryDeps, type ProfileEraseDeps } from './profile-erase'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'
import { sessionTranslations } from '../translate/memory'

// The shell reaches Electron only when a method runs: Browser.eraseHistory runs here on a stand-in (browser-fake.test-support.ts).
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

afterEach(() => vi.restoreAllMocks())

const deps = (over: Partial<ProfileEraseDeps> = {}): ProfileEraseDeps & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    clearEngine: async (id) => void calls.push(`engine:${id}`),
    eraseHistory: (id) => (calls.push(`history:${id}`), true),
    reloadTabs: (id) => void calls.push(`reload:${id}`),
    ...over
  }
}

describe('the translations of the session', () => {
  const kept = (): void => sessionTranslations.set('https://journal.example\u0001bergamot:fr-en@1', 'Bonjour', 'Hello')

  it('go when a profile is erased, even when its session cannot be cleared', async () => {
    kept()
    await eraseProfile(deps(), 'travail')
    expect(sessionTranslations.size).toBe(0)
    kept()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(eraseProfile(deps({ clearEngine: () => Promise.reject(new Error('session busy')) }), 'travail')).rejects.toThrow()
    expect(sessionTranslations.size).toBe(0)
  })

  it('go when the browsing history is erased, even when the erasure throws', () => {
    const history = (eraseHistory: () => boolean): BrowsingHistoryDeps => ({ eraseHistory, recentSites: () => [], forgetRecentSites: () => undefined, offeredSearchSites: () => [], forgetOfferedSearchSites: () => undefined })
    kept()
    eraseBrowsingHistory(history(() => true), 'travail')
    expect(sessionTranslations.size).toBe(0)
    kept()
    expect(() => eraseBrowsingHistory(history(() => {
      throw new Error('disk')
    }), 'travail')).toThrow('disk')
    expect(sessionTranslations.size).toBe(0)
  })
})

describe('erasing a profile', () => {
  it('clears the session and the history of that profile, then reloads its tabs', async () => {
    const d = deps()
    await eraseProfile(d, 'travail')
    expect(d.calls).toEqual(['engine:travail', 'history:travail', 'reload:travail'])
  })

  it('still erases the history when the session cannot be cleared, says so, logs it, and leaves the tabs alone', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = deps({ clearEngine: () => Promise.reject(new Error('session busy')) })
    await expect(eraseProfile(d, 'travail')).rejects.toThrow('Impossible d’effacer les cookies et le stockage (session busy) de ce profil.')
    expect(d.calls).toEqual(['history:travail'])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('travail'), expect.any(Error))
  })

  it('still clears the session and reloads when the history cannot be erased, and names the history in the error', async () => {
    const d = deps({ eraseHistory: (id) => (d.calls.push(`history:${id}`), false) })
    await expect(eraseProfile(d, 'travail')).rejects.toThrow('Impossible d’effacer l’historique de ce profil.')
    expect(d.calls).toEqual(['engine:travail', 'history:travail', 'reload:travail'])
  })

  it('names both when neither could be erased', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const d = deps({ clearEngine: () => Promise.reject('refus'), eraseHistory: () => false })
    await expect(eraseProfile(d, 'x')).rejects.toThrow('Impossible d’effacer les cookies et le stockage (refus) et l’historique de ce profil.')
  })

  it('says it in one sentence of the language of the interface, not in French pieces joined', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      setLanguage('en')
      await expect(eraseProfile(deps({ clearEngine: () => Promise.reject('refused'), eraseHistory: () => false }), 'x')).rejects.toThrow('Couldn’t erase the cookies and storage (refused) or the history of this profile.')
      await expect(eraseProfiles(async () => Promise.reject(new Error('x')), ['a', 'b'])).rejects.toThrow('Couldn’t clean the profiles a, b.')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('Browser.clearProfile', () => {
  it('reloads the tabs of the profile in every window of the group, not only in the one that erases', async () => {
    const reloaded: string[] = []
    const page = (name: string) => ({ reload: () => void reloaded.push(name) })
    const state = { spaces: [{ id: 'work-space', profileId: 'travail' }, { id: 'home-space', profileId: 'default' }], tabs: [{ id: 'a', spaceId: 'work-space' }, { id: 'b', spaceId: 'work-space' }, { id: 'c', spaceId: 'home-space' }] }
    const here = { pages: new Map([['a', page('a here')], ['c', page('c here')]]) }
    const second = { pages: new Map([['b', page('b in the second window')], ['c', page('c in the second window')]]) }
    const fake = fakeBrowser({ ...here, store: { get: () => state }, group: new Set([here, second]), engine: { clearProfileData: () => Promise.resolve() }, eraseProfileHistory: () => true })
    await shell['clearProfile']!.call(fake.self, 'travail')
    expect(reloaded).toEqual(['a here', 'b in the second window'])
  })
})

describe('cleaning the unused profiles', () => {
  it('erases each one and counts them', async () => {
    const seen: string[] = []
    expect(await eraseProfiles(async (id) => void seen.push(id), ['a', 'b', 'c'])).toBe(3)
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(await eraseProfiles(async () => {}, [])).toBe(0)
  })

  it('goes on after one that fails, logs it, and names the ones that kept something', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    const erase = async (id: string) => {
      seen.push(id)
      if (id === 'b' || id === 'd') throw new Error('nope')
    }
    await expect(eraseProfiles(erase, ['a', 'b', 'c', 'd'])).rejects.toThrow('Impossible de nettoyer les profils b, d.')
    expect(seen).toEqual(['a', 'b', 'c', 'd'])
    expect(error).toHaveBeenCalledTimes(2)
    await expect(eraseProfiles(async () => Promise.reject(new Error('x')), ['solo'])).rejects.toThrow('Impossible de nettoyer le profil solo.')
  })
})

describe('erasing the browsing history (Archive › Effacer l’historique de navigation…)', () => {
  const history = (over: Partial<BrowsingHistoryDeps> & { recents?: string[]; offered?: string[] } = {}): BrowsingHistoryDeps & { calls: string[]; recents: string[]; offered: string[] } => {
    const calls: string[] = []
    const recents = over.recents ?? ['bank.example', 'mail.example']
    const offered = over.offered ?? []
    return {
      calls,
      recents,
      offered,
      eraseHistory: (id) => (calls.push(`history:${id}`), true),
      recentSites: () => recents,
      forgetRecentSites: () => void (calls.push('forget-recents'), (recents.length = 0)),
      offeredSearchSites: () => offered,
      forgetOfferedSearchSites: () => void (calls.push('forget-offered'), (offered.length = 0)),
      ...over
    }
  }

  it('forgets the sites already offered their search too: they are hosts of visited pages, and nothing else empties them', () => {
    const d = history({ recents: [], offered: ['bank.example', 'clinic.example'] })
    expect(eraseBrowsingHistory(d, 'travail')).toBe(true)
    expect(d.calls).toEqual(['history:travail', 'forget-offered'])
    expect(d.offered).toEqual([])
    // Even when the history could not be erased, as for the “Récents” list.
    const failed = history({ offered: ['bank.example'], eraseHistory: () => false })
    expect(eraseBrowsingHistory(failed, 'travail')).toBe(false)
    expect(failed.calls).toEqual(['forget-recents', 'forget-offered'])
  })

  it('erases the history of the profile, then forgets the sites of the “Récents” list of the site-data panel', () => {
    const d = history()
    expect(eraseBrowsingHistory(d, 'travail')).toBe(true)
    expect(d.calls).toEqual(['history:travail', 'forget-recents'])
    expect(d.recents).toEqual([])
  })

  it('touches no setting when the list is already empty', () => {
    const d = history({ recents: [] })
    eraseBrowsingHistory(d, 'default')
    expect(d.calls).toEqual(['history:default'])
  })

  it('forgets the sites even when part of the history could not be erased, and still answers that it could not', () => {
    const d = history({ eraseHistory: () => false })
    expect(eraseBrowsingHistory(d, 'travail')).toBe(false)
    expect(d.calls).toEqual(['forget-recents'])
  })

  it('forgets the sites even when the erasure throws, and lets the error through', () => {
    const d = history({
      eraseHistory: () => {
        throw new Error('Invalid profile id: ../x')
      }
    })
    expect(() => eraseBrowsingHistory(d, '../x')).toThrow('Invalid profile id')
    expect(d.calls).toEqual(['forget-recents'])
  })

  it('is what Browser.eraseHistory runs, the one the menu entry calls: the history of the profile, then the “Récents” list', () => {
    const erase = vi.fn(() => true)
    const dispatch = vi.fn()
    const fake = fakeBrowser({ history: { erase }, store: { get: () => ({ settings: { siteDataRecents: ['bank.example'], searchDiscoverySeen: ['clinic.example'] } }) }, dispatch })
    // The shell's own `eraseProfileHistory`, which takes the Back lists of the profile's closed tabs with the history (closed-pages-wiring.test.ts has its rules).
    fake.self['eraseProfileHistory'] = (id: string) => shell['eraseProfileHistory']!.call(fake.self, id)
    expect(shell['eraseHistory']!.call(fake.self, 'travail')).toBe(true)
    expect(erase).toHaveBeenCalledWith('travail')
    expect(dispatch).toHaveBeenCalledWith({ type: 'settings/update', patch: { siteDataRecents: [] } })
    expect(dispatch).toHaveBeenCalledWith({ type: 'settings/update', patch: { searchDiscoverySeen: [] } })
    expect(fake.calls.filter((call) => call.name === 'forgetClosedPages').map((call) => call.args)).toEqual([['travail']])
  })
})
