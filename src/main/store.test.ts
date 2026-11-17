import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STATE_REVISION } from '@shared/model'
import { activeTab } from '@shared/sidebar'
import { blankSelection, selectionOf } from '@shared/window-selection'
import { takePersistenceNotices } from './persistence-notices'
import { SAVE_MAX_WAIT_MS, StateStore, WindowView, loadState, readState } from './store'
import { tempDir } from './temp-dir'

const dir = () => tempDir('lucium-store-')
/** The timed writes made synchronously: what the delay's arithmetic is checked with (the application's store writes them asynchronously). */
const SYNC = { asyncWrites: false } as const

afterEach(() => vi.restoreAllMocks())

describe('the state read at start-up', () => {
  it('says the state was read when the file is a valid one', () => {
    const path = join(dir(), 'state.json')
    new StateStore(loadState(path), path).flush()
    expect(readState(path).readable).toBe(true)
  })

  it('says no state was read when the file is absent', () => {
    expect(readState(join(dir(), 'state.json')).readable).toBe(false)
  })

  it('calls the profile new only when no state file existed: not one that was read, not one that was damaged', () => {
    const path = join(dir(), 'state.json')
    expect(readState(path).fresh).toBe(true)
    const store = new StateStore(loadState(path), path)
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    store.flush()
    expect(readState(path).fresh).toBe(false)
    writeFileSync(path, '{ not json')
    expect(readState(path).fresh).toBe(false)
  })

  it('says no state was read when the file is damaged, and keeps it aside', () => {
    const path = join(dir(), 'state.json')
    writeFileSync(path, '{ not json')
    const loaded = readState(path)
    expect(loaded.readable).toBe(false)
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(join(path, '..')).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true)
  })
})

// A new profile starts at the protection « Renforcée »; a profile that already has a state file keeps the protection it had, written or not.
describe('the protection of a new profile and of an existing one', () => {
  const PROTECTION = ['blockCookieBanners', 'sendGpc', 'stripTrackingParams', 'stripCopiedLinks'] as const
  const protectionOf = (path: string) => Object.fromEntries(PROTECTION.map((key) => [key, readState(path).state.settings[key]]))
  /** A state file of an existing profile whose settings are rewritten by `edit` (a key deleted is one a build of its time did not know). */
  const existing = (edit: (settings: Record<string, unknown>) => void): string => {
    const path = join(dir(), 'state.json')
    new StateStore(loadState(path), path).flush()
    const file = JSON.parse(readFileSync(path, 'utf8')) as { settings: Record<string, unknown> }
    edit(file.settings)
    writeFileSync(path, JSON.stringify(file))
    return path
  }

  it('gives a new profile the four settings of « Renforcée », kept after it is written and read again', () => {
    const path = join(dir(), 'state.json')
    const loaded = readState(path)
    expect(loaded.fresh).toBe(true)
    expect(Object.fromEntries(PROTECTION.map((key) => [key, loaded.state.settings[key]]))).toEqual({ blockCookieBanners: true, sendGpc: true, stripTrackingParams: true, stripCopiedLinks: true })
    new StateStore(loadState(path), path).flush()
    expect(protectionOf(path)).toEqual({ blockCookieBanners: true, sendGpc: true, stripTrackingParams: true, stripCopiedLinks: true })
  })

  it('keeps the values a state file holds, the earlier defaults as much as a choice, through a write and a read', () => {
    const path = existing((settings) => Object.assign(settings, { blockCookieBanners: false, sendGpc: false, stripTrackingParams: true, stripCopiedLinks: false }))
    expect(readState(path).fresh).toBe(false)
    expect(protectionOf(path)).toEqual({ blockCookieBanners: false, sendGpc: false, stripTrackingParams: true, stripCopiedLinks: false })
    const store = new StateStore(loadState(path), path)
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    store.flush()
    expect(protectionOf(path)).toEqual({ blockCookieBanners: false, sendGpc: false, stripTrackingParams: true, stripCopiedLinks: false })
  })

  it('gives a state file written before those settings existed the defaults of its time, not the new ones', () => {
    const path = existing((settings) => PROTECTION.forEach((key) => delete settings[key]))
    expect(protectionOf(path)).toEqual({ blockCookieBanners: false, sendGpc: false, stripTrackingParams: false, stripCopiedLinks: false })
  })

  // What the Settings compare the protection with (« modified », « Rétablir »): the protection the profile began with, set once and never moved after.
  const baselineOf = (path: string) => readState(path).state.settings.protectionBaseline
  const writeAgain = (path: string): void => {
    const store = new StateStore(loadState(path), path)
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    store.flush()
  }

  it('begins a new profile at the baseline « Renforcée », kept through a write and a read', () => {
    const path = join(dir(), 'state.json')
    expect(readState(path).state.settings.protectionBaseline).toBe('renforcee')
    writeAgain(path)
    expect(baselineOf(path)).toBe('renforcee')
    writeAgain(path)
    expect(baselineOf(path)).toBe('renforcee')
  })

  it('gives a profile made before « Renforcée » the baseline Standard, and it does not become new by being written and read again', () => {
    // The file of 1.0.1 holds the protection it had and does not name the baseline.
    const path = existing((settings) => {
      Object.assign(settings, { blockCookieBanners: false, sendGpc: false, stripTrackingParams: false, stripCopiedLinks: false })
      delete settings['protectionBaseline']
    })
    expect(readState(path).fresh).toBe(false)
    expect(baselineOf(path)).toBe('standard')
    writeAgain(path)
    expect(JSON.parse(readFileSync(path, 'utf8')).settings.protectionBaseline).toBe('standard')
    expect(baselineOf(path)).toBe('standard')
    writeAgain(path)
    expect(baselineOf(path)).toBe('standard')
    // Its protection is the one it had, so nothing of it differs from its baseline.
    expect(protectionOf(path)).toEqual({ blockCookieBanners: false, sendGpc: false, stripTrackingParams: false, stripCopiedLinks: false })
  })

  it('reads the baseline a file names, and takes any other word, or none that is a word, for the earlier profile', () => {
    expect(baselineOf(existing((settings) => Object.assign(settings, { protectionBaseline: 'renforcee' })))).toBe('renforcee')
    expect(baselineOf(existing((settings) => Object.assign(settings, { protectionBaseline: 'standard' })))).toBe('standard')
    for (const damaged of ['stricte', '', 7, true, null, [], {}]) {
      expect(baselineOf(existing((settings) => Object.assign(settings, { protectionBaseline: damaged }))), JSON.stringify(damaged)).toBe('standard')
    }
  })

  it('gives a state file whose settings are gone or unreadable the protection of an existing profile, as it does one whose settings are empty', () => {
    const STANDARD = { blockCookieBanners: false, sendGpc: false, stripTrackingParams: false, stripCopiedLinks: false }
    const withSettings = (edit: (file: Record<string, unknown>) => void): string => {
      const path = join(dir(), 'state.json')
      new StateStore(loadState(path), path).flush()
      const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      edit(file)
      writeFileSync(path, JSON.stringify(file))
      return path
    }
    for (const [name, edit] of [
      ['no settings', (file: Record<string, unknown>) => delete file['settings']],
      ['settings null', (file: Record<string, unknown>) => (file['settings'] = null)],
      ['settings that are a list', (file: Record<string, unknown>) => (file['settings'] = [])],
      ['empty settings', (file: Record<string, unknown>) => (file['settings'] = {})]
    ] as const) {
      const path = withSettings(edit)
      const loaded = readState(path)
      expect(loaded.fresh, name).toBe(false)
      expect(protectionOf(path), name).toEqual(STANDARD)
    }
  })
})

describe('state persistence', () => {
  it('round-trips the state through flush and load', () => {
    const path = join(dir(), 'state.json')
    const store = new StateStore(loadState(path), path)
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    store.flush()
    expect(loadState(path).tabs.map((t) => t.url)).toEqual(['https://a.fr/'])
  })

  it('never writes a private tab: the file holds the other tabs only, and a restart finds nothing of it', () => {
    const path = join(dir(), 'state.json')
    const store = new StateStore(loadState(path), path)
    store.dispatch({ type: 'tab/open', url: 'https://normal.example/' })
    store.dispatch({ type: 'tab/open', url: 'https://secret.example/page', private: true })
    expect(store.get().tabs.some((t) => t.private)).toBe(true)
    store.flush()
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain('secret.example')
    expect(text).not.toContain('"private":true')
    expect(loadState(path).tabs.map((t) => t.url)).toEqual(['https://normal.example/'])
    // The tab is still in memory for the window that shows it.
    expect(store.get().tabs.map((t) => t.url)).toEqual(['https://normal.example/', 'https://secret.example/page'])
  })

  it('moves a corrupt file aside, logs it, and starts fresh instead of crashing', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    writeFileSync(path, '{ not json')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const state = loadState(path)

    expect(state.spaces).toHaveLength(1)
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(folder).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unreadable'))
  })

  it('treats a schema version that is not one as corrupt rather than guessing', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    writeFileSync(path, JSON.stringify({ version: 0 }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    loadState(path)
    expect(readdirSync(folder).some((f) => f.includes('.corrupt-'))).toBe(true)
    expect(readdirSync(folder).some((f) => f.includes('.future-'))).toBe(false)
  })

  it('keeps the state of a more recent version as it is, under its own name, and says so', () => {
    const folder = dir()
    const path = join(folder, 'state.json')
    const text = JSON.stringify({ version: 999, spaces: [{ id: 'x' }], marker: 'données de la version suivante' })
    writeFileSync(path, text)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    takePersistenceNotices()

    const state = loadState(path)

    expect(state.spaces).toHaveLength(1)
    const [future, ...others] = readdirSync(folder)
    expect(others).toEqual([])
    expect(future).toMatch(/^state\.json\.future-\d+$/)
    expect(readFileSync(join(folder, future!), 'utf8')).toBe(text)
    expect(takePersistenceNotices()).toEqual([expect.objectContaining({ kind: 'newer-version', file: 'state.json', backup: join(folder, future!) })])
  })

  it('notifies subscribers only when the state actually changes', () => {
    const path = join(dir(), 'state.json')
    const store = new StateStore(loadState(path), path)
    const listener = vi.fn()
    store.subscribe(listener)
    store.dispatch({ type: 'tab/select', id: 'does-not-exist' })
    expect(listener).not.toHaveBeenCalled()
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('the delay before the state is written', () => {
  it('is cut short by the cap: a title that changes faster than the delay does not hold the write back for good', () => {
    vi.useFakeTimers()
    try {
      const path = join(dir(), 'state.json')
      const store = new StateStore(loadState(path), path, undefined, SYNC)
      store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
      const id = store.get().tabs[0]!.id
      // A new title every 100 ms: the 300 ms of quiet the delay waits for never comes.
      let step = 0
      const retitle = () => store.dispatch({ type: 'tab/update', id, patch: { title: `Titre ${step++}` } })
      for (let elapsed = 0; elapsed < SAVE_MAX_WAIT_MS - 200; elapsed += 100) {
        vi.advanceTimersByTime(100)
        retitle()
      }
      expect(existsSync(path)).toBe(false)
      for (let elapsed = 0; elapsed < 400; elapsed += 100) {
        vi.advanceTimersByTime(100)
        retitle()
      }
      expect(existsSync(path)).toBe(true)
      expect(loadState(path).tabs[0]!.title).toMatch(/^Titre \d+$/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still waits for a quiet moment when the changes are further apart than the delay', () => {
    vi.useFakeTimers()
    try {
      const path = join(dir(), 'state.json')
      const store = new StateStore(loadState(path), path, undefined, SYNC)
      store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
      vi.advanceTimersByTime(200)
      store.dispatch({ type: 'tab/open', url: 'https://b.fr/' })
      vi.advanceTimersByTime(299)
      expect(existsSync(path)).toBe(false)
      vi.advanceTimersByTime(1)
      expect(loadState(path).tabs).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts the cap from the first change that is not on disk, not from the last write', () => {
    vi.useFakeTimers()
    try {
      const path = join(dir(), 'state.json')
      const store = new StateStore(loadState(path), path, undefined, SYNC)
      store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
      store.flush()
      vi.advanceTimersByTime(SAVE_MAX_WAIT_MS * 5)
      // Long after the last write: a change now waits the usual delay, not zero.
      store.dispatch({ type: 'tab/open', url: 'https://b.fr/' })
      vi.advanceTimersByTime(299)
      expect(loadState(path).tabs).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(loadState(path).tabs).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a memory-only store (the private window)', () => {
  it('never writes a file, even when asked to flush', () => {
    const folder = dir()
    vi.useFakeTimers()
    try {
      const store = new StateStore(loadState(join(folder, 'none.json')), null)
      store.dispatch({ type: 'tab/open', url: 'https://secret.example/' })
      store.flush()
      vi.advanceTimersByTime(5000)
      expect(readdirSync(folder)).toEqual([])
      expect(store.get().tabs.map((t) => t.url)).toEqual(['https://secret.example/'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('scrubs every new state before subscribers see it, and ignores a change the scrub cancels out', () => {
    const store = new StateStore(loadState(join(dir(), 'none.json')), null, (state) => (state.archive.length === 0 ? state : { ...state, archive: [] }))
    const seen: number[] = []
    store.subscribe((state) => seen.push(state.archive.length))
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    const [tab] = store.get().tabs
    store.dispatch({ type: 'tab/archive', id: tab!.id })
    expect(store.get().tabs).toEqual([])
    expect(store.get().archive).toEqual([])
    expect(seen).toEqual([0, 0])
  })
})

describe('a state bigger than the next launch reads', () => {
  const picture = `data:image/png;base64,${'A'.repeat(6000)}`
  const withIcons = (path: string, maxBytes: number) => {
    const store = new StateStore(loadState(path), path, undefined, { ...SYNC, maxBytes })
    for (let i = 0; i < 4; i++) store.dispatch({ type: 'tab/open', url: `https://site${i}.example/` })
    store.replace({ ...store.get(), tabs: store.get().tabs.map((tab, i) => ({ ...tab, faviconUrl: i === 0 ? 'https://site0.example/favicon.ico' : picture })) })
    return store
  }

  it('is written without the data: pictures of its icons, so that the next launch reads it instead of setting it aside', () => {
    const path = join(dir(), 'state.json')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = withIcons(path, 20_000)
    expect(store.flush()).toBe(true)
    expect(readFileSync(path, 'utf8').length).toBeLessThanOrEqual(20_000)
    const read = readState(path)
    expect(read.readable).toBe(true)
    expect(read.state.tabs.map((tab) => tab.faviconUrl)).toEqual(['https://site0.example/favicon.ico', undefined, undefined, undefined])
    // The state in memory keeps them.
    expect(store.get().tabs.filter((tab) => tab.faviconUrl === picture)).toHaveLength(3)
  })

  it('leaves the last good file in place, and says so, when even that is too big', () => {
    const path = join(dir(), 'state.json')
    const small = new StateStore(loadState(path), path, undefined, SYNC)
    small.flush()
    const before = readFileSync(path, 'utf8')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    takePersistenceNotices()
    const store = withIcons(path, 200)
    expect(store.flush()).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(takePersistenceNotices().map((notice) => notice.kind)).toEqual(['save-failed'])
  })
})

describe('the listeners of the state', () => {
  it('tells every listener even when one throws: the change is made, the caller goes on, and the failure is written', () => {
    const store = new StateStore(loadState(join(dir(), 'none.json')), null)
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const heard: string[] = []
    store.subscribe(() => heard.push('first'))
    store.subscribe(() => {
      throw new Error('a sync that failed')
    })
    store.subscribe((state) => heard.push(`third:${state.tabs.length}`))
    expect(() => store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })).not.toThrow()
    expect(store.get().tabs).toHaveLength(1)
    expect(heard).toEqual(['first', 'third:1'])
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).toContain('[store]')
    expect(String(log.mock.calls[0]![1])).toContain('a sync that failed')
  })

  it('hands no listener an older state after a newer one when a listener dispatches again', () => {
    const store = new StateStore(loadState(join(dir(), 'none.json')), null)
    let again = true
    store.subscribe(() => {
      if (!again) return
      again = false
      store.dispatch({ type: 'tab/open', url: 'https://b.fr/' })
    })
    const seen: number[] = []
    store.subscribe((state) => seen.push(state.tabs.length))
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    // The second listener hears the newer state first (from the inner dispatch), and only that one afterwards.
    expect(seen).toEqual([2, 2])
  })
})

describe('a window view of the shared store', () => {
  const setup = () => {
    const shared = new StateStore(loadState(join(dir(), 'none.json')), null)
    const siblings = new Set<WindowView>()
    const first = new WindowView(shared, selectionOf(shared.get()), siblings, true)
    const second = new WindowView(shared, blankSelection(shared.get(), shared.get().activeSpaceId), siblings)
    return { shared, siblings, first, second }
  }

  it('is the shared store itself when it is the only window', () => {
    const shared = new StateStore(loadState(join(dir(), 'none.json')), null)
    const only = new WindowView(shared, selectionOf(shared.get()), new Set(), true)
    only.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    only.dispatch({ type: 'settings/update', patch: { sidebarVisible: false } })
    expect(only.get()).toBe(shared.get())
    expect(shared.get().tabs.map((t) => t.url)).toEqual(['https://a.fr/'])
    expect(shared.get().settings.sidebarVisible).toBe(false)
  })

  it('lets two windows select different tabs of the same tabs', () => {
    const { first, second } = setup()
    first.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    second.dispatch({ type: 'tab/open', url: 'https://b.fr/' })
    expect(first.get().tabs).toHaveLength(2)
    expect(activeTab(first.get())?.url).toBe('https://a.fr/')
    expect(activeTab(second.get())?.url).toBe('https://b.fr/')
  })

  it('takes a tab away from the window that showed it when another window selects it', () => {
    const { first, second } = setup()
    first.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    expect(activeTab(first.get())).toBeDefined()
    second.dispatch({ type: 'tab/select', id: first.get().tabs[0]!.id })
    expect(activeTab(second.get())?.url).toBe('https://a.fr/')
    expect(activeTab(first.get())).toBeUndefined()
  })

  it('tells the subscribers of every window about a change made in one of them', () => {
    const { first, second } = setup()
    const heard: number[] = []
    first.subscribe((state) => heard.push(state.tabs.length))
    second.dispatch({ type: 'tab/open', url: 'https://b.fr/' })
    expect(heard).toEqual([1])
  })

  it('keeps the layout of a second window to itself, and saves only the first window’s', () => {
    const { shared, first, second } = setup()
    second.dispatch({ type: 'settings/update', patch: { sidebarVisible: false, blockAds: true } })
    expect(second.get().settings.sidebarVisible).toBe(false)
    expect(first.get().settings.sidebarVisible).toBe(true)
    expect(shared.get().settings.sidebarVisible).toBe(true)
    expect(first.get().settings.blockAds).toBe(true)
    first.dispatch({ type: 'settings/update', patch: { sidebarWidth: 300 } })
    expect(shared.get().settings.sidebarWidth).toBe(300)
    expect(second.get().settings.sidebarWidth).not.toBe(300)
  })

  it('treats “the full address in the toolbar” as the layout of a window: Settings changes the first window, the others keep theirs, and a new window starts from the first', () => {
    const { shared, first, second } = setup()
    // Settings is a surface of the first window: its switch is a `settings/update` dispatched there.
    first.dispatch({ type: 'settings/update', patch: { fullUrlInToolbar: true } })
    expect(first.get().settings.fullUrlInToolbar).toBe(true)
    expect(shared.get().settings.fullUrlInToolbar).toBe(true)
    expect(second.get().settings.fullUrlInToolbar).toBe(false)
    // A window of its own choosing is not written to the shared (saved) state.
    second.dispatch({ type: 'settings/update', patch: { fullUrlInToolbar: false, blockAds: true } })
    first.dispatch({ type: 'settings/update', patch: { fullUrlInToolbar: false } })
    second.dispatch({ type: 'settings/update', patch: { fullUrlInToolbar: true } })
    expect(second.get().settings.fullUrlInToolbar).toBe(true)
    expect(first.get().settings.fullUrlInToolbar).toBe(false)
    expect(shared.get().settings.fullUrlInToolbar).toBe(false)
    // A window opened now takes the first window's choice at that moment.
    first.dispatch({ type: 'settings/update', patch: { fullUrlInToolbar: true } })
    const third = new WindowView(shared, blankSelection(shared.get(), shared.get().activeSpaceId), new Set<WindowView>())
    expect(third.get().settings.fullUrlInToolbar).toBe(true)
  })

  it('forgets a window that closed', () => {
    const { siblings, first, second } = setup()
    second.dispose()
    first.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    expect(siblings.size).toBe(1)
  })
})

describe('windows with tabs of their own', () => {
  /** Three windows over one shared store (the first, then `window-1` and `window-2`), with the setting on. */
  const setup = () => {
    const shared = new StateStore(loadState(join(dir(), 'none.json')), null)
    const siblings = new Set<WindowView>()
    const main = new WindowView(shared, selectionOf(shared.get()), siblings, true)
    main.dispatch({ type: 'settings/update', patch: { independentWindows: true } })
    const w1 = new WindowView(shared, blankSelection(shared.get(), shared.get().activeSpaceId), siblings, false, 'window-1')
    const w2 = new WindowView(shared, blankSelection(shared.get(), shared.get().activeSpaceId), siblings, false, 'window-2')
    return { shared, siblings, main, w1, w2 }
  }
  const urls = (view: WindowView): string[] => view.get().tabs.map((t) => t.url)

  it('shows each window its own tabs, and the shared store all of them', () => {
    const { shared, main, w1, w2 } = setup()
    main.dispatch({ type: 'tab/open', url: 'https://main.example/' })
    w1.dispatch({ type: 'tab/open', url: 'https://one.example/' })
    w2.dispatch({ type: 'tab/open', url: 'https://two.example/' })
    expect(urls(main)).toEqual(['https://main.example/'])
    expect(urls(w1)).toEqual(['https://one.example/'])
    expect(urls(w2)).toEqual(['https://two.example/'])
    expect(shared.get().tabs.map((t) => t.url)).toEqual(['https://main.example/', 'https://one.example/', 'https://two.example/'])
    expect(activeTab(w1.get())?.url).toBe('https://one.example/')
  })

  it('a window opened with the setting on starts with no tab but the pinned ones', () => {
    const shared = new StateStore(loadState(join(dir(), 'none.json')), null)
    const siblings = new Set<WindowView>()
    const main = new WindowView(shared, selectionOf(shared.get()), siblings, true)
    main.dispatch({ type: 'tab/open', url: 'https://a.example/' })
    main.dispatch({ type: 'tab/open', url: 'https://b.example/' })
    main.dispatch({ type: 'tab/pin', id: main.get().tabs[1]!.id })
    main.dispatch({ type: 'settings/update', patch: { independentWindows: true } })
    const fresh = new WindowView(shared, blankSelection(shared.get(), shared.get().activeSpaceId), siblings, false, 'window-1')
    expect(urls(fresh)).toEqual(['https://b.example/'])
    expect(activeTab(fresh.get())).toBeUndefined()
  })

  it('leaves a window’s tabs alone when another window closes, archives or clears its own', () => {
    const { main, w1 } = setup()
    for (const url of ['https://a.example/', 'https://b.example/']) main.dispatch({ type: 'tab/open', url })
    for (const url of ['https://c.example/', 'https://d.example/']) w1.dispatch({ type: 'tab/open', url })
    const before = w1.get().tabs
    main.dispatch({ type: 'tab/archive', id: main.get().tabs[0]!.id })
    main.dispatch({ type: 'today/clear' })
    main.dispatch({ type: 'tab/open', url: 'https://e.example/' })
    main.dispatch({ type: 'tab/close', id: main.get().tabs[0]!.id })
    expect(w1.get().tabs).toEqual(before)
    expect(urls(w1)).toEqual(['https://c.example/', 'https://d.example/'])
  })

  it('shares the pinned tabs: pinned in one window, listed in the others, and shown by one at a time', () => {
    const { main, w1 } = setup()
    main.dispatch({ type: 'tab/open', url: 'https://a.example/' })
    const id = main.get().tabs[0]!.id
    main.dispatch({ type: 'tab/pin', id })
    expect(urls(w1)).toEqual(['https://a.example/'])
    w1.dispatch({ type: 'tab/select', id })
    expect(activeTab(w1.get())?.id).toBe(id)
    expect(activeTab(main.get())).toBeUndefined()
  })

  it('puts a space aside with the tabs every window has in it, and brings them all back', () => {
    const { shared, main, w1 } = setup()
    main.dispatch({ type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 })
    const work = main.get().activeSpaceId
    main.dispatch({ type: 'tab/open', url: 'https://main.example/', spaceId: work })
    w1.dispatch({ type: 'tab/open', url: 'https://one.example/', spaceId: work })
    expect(shared.get().tabs.filter((t) => t.spaceId === work)).toHaveLength(2)

    main.dispatch({ type: 'space/aside', id: work })
    expect(shared.get().spaces.some((s) => s.id === work)).toBe(false)
    expect(shared.get().tabs).toEqual([])
    const session = shared.get().sessions[0]!
    // The tab of the other window is kept in the session too, and the session names no window.
    expect(session.space!.tabs.map((t) => t.url).sort()).toEqual(['https://main.example/', 'https://one.example/'])
    expect(session.space!.tabs.every((t) => t.windowKey === undefined)).toBe(true)

    main.dispatch({ type: 'space/reopen', id: session.id })
    expect(shared.get().tabs.map((t) => t.url).sort()).toEqual(['https://main.example/', 'https://one.example/'])
  })

  it('deletes a container with the tabs every window has in it: none is left behind to load with the cookies of the profile', () => {
    const { shared, main, w1 } = setup()
    main.dispatch({ type: 'settings/update', patch: { tabContainers: true } })
    main.dispatch({ type: 'container/create', name: 'Banque' })
    const id = shared.get().settings.containers[0]!.id
    main.dispatch({ type: 'tab/open', url: 'https://main.example/', container: id })
    w1.dispatch({ type: 'tab/open', url: 'https://one.example/', container: id })
    expect(shared.get().tabs.filter((t) => t.container === id)).toHaveLength(2)

    main.dispatch({ type: 'container/delete', id })
    expect(shared.get().settings.containers).toEqual([])
    expect(shared.get().tabs.filter((t) => t.container === id)).toEqual([])
  })

  it('merges an import against every tab of the state: a tab of another window is known, and stays as it is, where it is', () => {
    const { shared, main, w1 } = setup()
    w1.dispatch({ type: 'tab/open', url: 'https://one.example/' })
    const tab = shared.get().tabs[0]!
    expect(tab.windowKey).toBe('window-1')
    // A file that holds that tab (an export made earlier, renamed since) is merged from the first window, which does not list it.
    main.dispatch({ type: 'import/merge', spaces: [], tabs: [{ ...tab, windowKey: undefined, customTitle: 'From the file' }], folders: [], favorites: [] })
    const kept = shared.get().tabs.filter((t) => t.id === tab.id)
    expect(kept).toEqual([tab])
  })

  it('hands the tabs of a window that closes to the first window, and forgets its key', () => {
    const { shared, siblings, main, w1 } = setup()
    w1.dispatch({ type: 'tab/open', url: 'https://one.example/' })
    expect(urls(main)).toEqual([])
    w1.dispose()
    expect(urls(main)).toEqual(['https://one.example/'])
    expect(shared.get().tabs.every((t) => t.windowKey === undefined)).toBe(true)
    expect(siblings.has(w1)).toBe(false)
  })

  it('shows every window all the tabs again when the setting is turned off, and gives them back when it is turned on', () => {
    const { main, w1 } = setup()
    main.dispatch({ type: 'tab/open', url: 'https://a.example/' })
    w1.dispatch({ type: 'tab/open', url: 'https://b.example/' })
    main.dispatch({ type: 'settings/update', patch: { independentWindows: false } })
    expect(urls(main)).toEqual(['https://a.example/', 'https://b.example/'])
    expect(urls(w1)).toEqual(['https://a.example/', 'https://b.example/'])
    main.dispatch({ type: 'settings/update', patch: { independentWindows: true } })
    expect(urls(main)).toEqual(['https://a.example/'])
    expect(urls(w1)).toEqual(['https://b.example/'])
  })

  it('a window does not redraw for a change to another window’s tabs', () => {
    const { main, w1 } = setup()
    main.dispatch({ type: 'tab/open', url: 'https://a.example/' })
    w1.dispatch({ type: 'tab/open', url: 'https://b.example/' })
    const seen = w1.get()
    main.dispatch({ type: 'tab/update', id: main.get().tabs[0]!.id, patch: { title: 'Autre titre' } })
    expect(w1.get()).toBe(seen)
  })

  it('writes no window key to the file, and a restart finds every tab in the first window', () => {
    const path = join(dir(), 'state.json')
    const shared = new StateStore(loadState(path), path)
    const siblings = new Set<WindowView>()
    const main = new WindowView(shared, selectionOf(shared.get()), siblings, true)
    main.dispatch({ type: 'settings/update', patch: { independentWindows: true } })
    const w1 = new WindowView(shared, blankSelection(shared.get(), shared.get().activeSpaceId), siblings, false, 'window-1')
    main.dispatch({ type: 'tab/open', url: 'https://a.example/' })
    w1.dispatch({ type: 'tab/open', url: 'https://b.example/' })
    shared.flush()
    expect(readFileSync(path, 'utf8')).not.toContain('windowKey')
    const reloaded = loadState(path)
    expect(reloaded.tabs.map((t) => t.url)).toEqual(['https://a.example/', 'https://b.example/'])
    expect(reloaded.tabs.every((t) => t.windowKey === undefined)).toBe(true)
    // Both tabs are in memory still, one in each window.
    expect(shared.get().tabs.map((t) => t.windowKey)).toEqual([undefined, 'window-1'])
  })

  it('keeps every invariant of the state through a long run of actions in three windows', () => {
    const { shared, main, w1, w2 } = setup()
    const windows = [main, w1, w2]
    // A fixed pseudo-random sequence: the same run every time.
    let seed = 20_261_024
    const random = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % n
    }
    for (let step = 0; step < 600; step++) {
      const view = windows[random(3)]!
      const tabs = view.get().tabs
      const pick = tabs[random(Math.max(tabs.length, 1))]
      const others = windows.filter((w) => w !== view).map((w) => w.get().tabs.filter((t) => !t.pinned))
      const beforeOthers = others.map((list) => list.map((t) => t.id))
      const kind = random(9)
      if (kind <= 2 || !pick) view.dispatch({ type: 'tab/open', url: `https://site${step}.example/` })
      else if (kind === 3) view.dispatch({ type: 'tab/close', id: pick.id })
      else if (kind === 4) view.dispatch({ type: 'tab/archive', id: pick.id })
      else if (kind === 5) view.dispatch({ type: 'tab/select', id: pick.id })
      else if (kind === 6) view.dispatch({ type: pick.pinned ? 'tab/unpin' : 'tab/pin', id: pick.id })
      else if (kind === 7) view.dispatch({ type: 'tab/duplicate', id: pick.id })
      else view.dispatch({ type: 'archive/restore-last' })
      const all = shared.get().tabs
      expect(new Set(all.map((t) => t.id)).size, `step ${step}: duplicate ids`).toBe(all.length)
      // The tabs the other windows list (their own, not the pinned ones) are the very same after any action of this window that does not pin or unpin.
      if (kind !== 6) {
        const afterOthers = windows.filter((w) => w !== view).map((w) => w.get().tabs.filter((t) => !t.pinned).map((t) => t.id))
        expect(afterOthers, `step ${step}: another window’s tabs changed (action ${kind})`).toEqual(beforeOthers)
      }
      // A window lists its own tabs and the pinned ones, nothing else; and every tab is listed by the window it belongs to.
      for (const [index, w] of windows.entries()) {
        const key = index === 0 ? undefined : `window-${index}`
        expect(w.get().tabs.every((t) => t.pinned || t.windowKey === key), `step ${step}: window ${index} lists a foreign tab`).toBe(true)
      }
      expect(all.every((t) => shared.get().spaces.some((s) => s.id === t.spaceId))).toBe(true)
    }
    // At the end, the union of what the windows list is every tab.
    const listed = new Set(windows.flatMap((w) => w.get().tabs.map((t) => t.id)))
    expect(listed.size).toBe(shared.get().tabs.length)
  })
})

describe('the root of a store', () => {
  it('is the shared store for the view of a window, and the store itself otherwise: what holds the tabs every window lists', () => {
    const shared = new StateStore(loadState(join(dir(), 'state.json')), null)
    const view = new WindowView(shared, selectionOf(shared.get()), new Set(), true)
    expect(view.root()).toBe(shared)
    expect(shared.root()).toBe(shared)
  })
})

describe('replacing the state through the view of a window', () => {
  it('replaces the shared state, the one every window and the file read, not a copy nobody reads', () => {
    const shared = new StateStore(loadState(join(dir(), 'none.json')), null)
    const view = new WindowView(shared, selectionOf(shared.get()), new Set(), true)
    const seen = vi.fn()
    shared.subscribe(seen)
    const next = { ...shared.get(), settings: { ...shared.get().settings, warnBeforeQuitting: false } }
    view.replace(next)
    expect(shared.get()).toBe(next)
    expect(view.get().settings.warnBeforeQuitting).toBe(false)
    expect(seen).toHaveBeenCalledTimes(1)
  })
})

describe('the fields of a later version', () => {
  /** A file of today with what a later build added: a field at the top, a setting, and names that must never be kept. */
  const laterFile = (path: string): void => {
    new StateStore(loadState(path), path).flush()
    const today = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { settings: Record<string, unknown> }
    const text = JSON.stringify({ ...today, notes: [{ id: 'n1', text: 'à garder' }], settings: { ...today.settings, laterSetting: { on: true, level: 3 }, sidebarWidth: 300 } })
    // Written by hand, so that the names a careless reader would turn into a prototype are there too.
    writeFileSync(path, text.replace('"settings":{', '"settings":{"__proto__":{"polluted":"POLLUTED"},"constructor":"POLLUTED",').replace('{"version":1,', '{"version":1,"__proto__":{"polluted":"POLLUTED"},'))
  }

  it('keeps them through a load and a write, as the file had them, though the state in memory never holds them', () => {
    const path = join(dir(), 'state.json')
    laterFile(path)
    const store = new StateStore(loadState(path), path)
    expect('notes' in store.get()).toBe(false)
    expect('laterSetting' in store.get().settings).toBe(false)
    store.dispatch({ type: 'tab/open', url: 'https://a.fr/' })
    expect(store.flush()).toBe(true)
    const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { settings: Record<string, unknown> }
    expect(written['notes']).toEqual([{ id: 'n1', text: 'à garder' }])
    expect(written.settings['laterSetting']).toEqual({ on: true, level: 3 })
    expect(loadState(path).tabs.map((tab) => tab.url)).toEqual(['https://a.fr/'])
    // And again at the next run: they are not lost by a second write either.
    new StateStore(loadState(path), path).flush()
    expect((JSON.parse(readFileSync(path, 'utf8')) as { settings: Record<string, unknown> }).settings['laterSetting']).toEqual({ on: true, level: 3 })
  })

  it('lets what this version knows win, and never keeps a name that would set a prototype', () => {
    const path = join(dir(), 'state.json')
    laterFile(path)
    const store = new StateStore(loadState(path), path)
    store.dispatch({ type: 'settings/update', patch: { sidebarWidth: 280 } })
    store.flush()
    const text = readFileSync(path, 'utf8')
    expect((JSON.parse(text) as { settings: { sidebarWidth: number } }).settings.sidebarWidth).toBe(280)
    expect(text).not.toContain('POLLUTED')
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('does not keep the fields this version migrates on purpose', () => {
    const path = join(dir(), 'state.json')
    new StateStore(loadState(path), path).flush()
    const today = JSON.parse(readFileSync(path, 'utf8')) as { settings: Record<string, unknown> }
    writeFileSync(path, JSON.stringify({ ...today, settings: { ...today.settings, autoArchiveHoursByProfile: { work: 3 } } }))
    const store = new StateStore(loadState(path), path)
    expect(store.get().settings.profiles).toMatchObject({ work: { autoArchiveHours: 3 } })
    store.flush()
    expect(readFileSync(path, 'utf8')).not.toContain('autoArchiveHoursByProfile')
  })

  it('carries the forced dark mode of an older file over to the readable mode, once, and does not write the old settings back', () => {
    const path = join(dir(), 'state.json')
    new StateStore(loadState(path), path).flush()
    const today = JSON.parse(readFileSync(path, 'utf8')) as { revision?: number; settings: Record<string, unknown> }
    const { readableMode: _mode, siteReadableMode: _sites, ...settings } = today.settings
    writeFileSync(path, JSON.stringify({ ...today, revision: 1, settings: { ...settings, forceDarkSites: true, forceDarkOnlyWhenSystemDark: true, forceDarkExceptions: ['banque.example'] } }))
    const store = new StateStore(loadState(path), path)
    expect([store.get().settings.readableMode, store.get().settings.siteReadableMode]).toEqual(['auto', { 'banque.example': 'original' }])
    store.flush()
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { revision: number; settings: Record<string, unknown> }
    expect(readFileSync(path, 'utf8')).not.toContain('forceDark')
    expect([saved.settings['readableMode'], saved.settings['siteReadableMode'], saved.revision]).toEqual(['auto', { 'banque.example': 'original' }, STATE_REVISION])
    // Loaded again, the file is not migrated a second time.
    const again = new StateStore(loadState(path), path)
    expect([again.get().settings.readableMode, again.get().settings.siteReadableMode]).toEqual(['auto', { 'banque.example': 'original' }])
  })

  it('drops them, and says so, when they weigh more than a later version could need', () => {
    const path = join(dir(), 'state.json')
    new StateStore(loadState(path), path).flush()
    const today = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({ ...today, huge: 'x'.repeat(300 * 1024) }))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new StateStore(loadState(path), path)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('does not know'))
    store.flush()
    expect(readFileSync(path, 'utf8')).not.toContain('huge')
  })

  it('are never written by a store that has no file, nor by a store made from another state', () => {
    const path = join(dir(), 'state.json')
    laterFile(path)
    const loaded = loadState(path)
    const other = join(dir(), 'state.json')
    // A state computed from the loaded one is a new object: what the file held stays the file's.
    new StateStore({ ...loaded }, other).flush()
    expect(readFileSync(other, 'utf8')).not.toContain('laterSetting')
  })
})
