import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadInfo, Settings, SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { LITTLE_BUBBLE } from '@shared/little-bubble'
import { t as tr } from '@shared/i18n'
import { Channel } from '@shared/ipc'
import { ipcMain } from 'electron'

// The window class imports Electron for its real windows and clipboard only: a test gives its own windows and drives the rest for real.
const showMessageBox = vi.hoisted(() => vi.fn(async () => ({ response: 0 })))
vi.mock('electron', () => ({ BrowserWindow: class {}, clipboard: {}, dialog: { showMessageBox }, ipcMain: { on: vi.fn() }, screen: {} }))

const { LittleArc } = await import('./little')
const { setLockService } = await import('../lock-service')

const HOUR = 3_600_000
let n = 0
const ctx = () => ({ now: Date.now(), newId: () => `id${++n}` })

function liveStore(settings: Partial<Settings> = {}) {
  let state: SidebarState = createInitialState(ctx())
  state = { ...state, settings: { ...state.settings, ...settings } }
  const listeners = new Set<(state: SidebarState) => void>()
  return {
    get: () => state,
    subscribe: (listener: (state: SidebarState) => void) => (listeners.add(listener), () => void listeners.delete(listener)),
    set(patch: Partial<Settings>) {
      state = reduce(state, { type: 'settings/update', patch }, ctx())
      for (const listener of [...listeners]) listener(state)
    },
    /** A change of the sidebar's state (a tab opened in the main window). */
    apply(action: Action) {
      state = reduce(state, action, ctx())
      for (const listener of [...listeners]) listener(state)
    }
  }
}

let webContentsIds = 100

class FakeWindow extends EventEmitter {
  destroyed = false
  webContents = { id: ++webContentsIds, send: vi.fn(), isDestroyed: () => this.destroyed, on: vi.fn(), once: vi.fn(), close: vi.fn() }
  contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
  setWindowButtonVisibility = vi.fn()
  show = vi.fn()
  getContentBounds = () => ({ x: 0, y: 0, width: 900, height: 650 })
  isDestroyed(): boolean {
    return this.destroyed
  }
  close(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

const fakeView = () => ({ webContents: { id: ++webContentsIds, send: vi.fn(), isDestroyed: () => false, on: vi.fn(), once: vi.fn(), close: vi.fn() }, setBounds: vi.fn() })

const fakePage = () => ({ loadURL: vi.fn(), show: vi.fn(), destroy: vi.fn(), focus: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), showsError: vi.fn(() => false) })

const download = (over: Partial<DownloadInfo> = {}): DownloadInfo => ({ id: 'd1', filename: 'rapport.pdf', url: 'https://x.example/rapport.pdf', path: '/tmp/rapport.pdf', state: 'completed', receivedBytes: 10, totalBytes: 10, startedAt: 1, ...over })

function setup(settings: Partial<Settings> = {}) {
  const store = liveStore(settings)
  const windows = new Map<string, unknown>()
  const trusted = new Set<number>()
  const dispatched: Action[] = []
  let onDownload: (download: DownloadInfo, sourcePageId: string | undefined) => void = () => {}
  const trays: Array<ReturnType<typeof fakeView>> = []
  const created: FakeWindow[] = []
  const pages: Array<ReturnType<typeof fakePage>> = []
  const events: Array<{ update: (patch: { url?: string; title?: string; loading?: boolean; visit?: boolean }) => void }> = []
  // What the pages of the windows leave in the history, with the profile and the space it was said for.
  const visits: Array<{ kind: 'record' | 'retitle'; profileId: string; spaceId: string | undefined; url: string; title: string }> = []
  const history = {
    of: (profileId: string, spaceId?: string) => ({
      record: (url: string, title: string) => void visits.push({ kind: 'record', profileId, spaceId, url, title }),
      retitle: (url: string, title: string) => (visits.push({ kind: 'retitle', profileId, spaceId, url, title }), true)
    })
  }
  const opened: Array<unknown> = []
  const focusMain = vi.fn()
  const engine = {
    createPage: vi.fn((_options: unknown, handlers: (typeof events)[number]) => {
      const page = fakePage()
      pages.push(page)
      events.push(handlers)
      return page
    }),
    onDownload: (listener: typeof onDownload) => {
      onDownload = listener
    }
  }
  const browser = { dispatch: (action: Action) => dispatched.push(action), hideAdsOn: vi.fn(), forgetBlockerCss: vi.fn(), openOverlay: (request: unknown) => opened.push(request) }
  const little = new LittleArc({
    engine: engine as never,
    store: store as never,
    browser: browser as never,
    history: history as never,
    windows: windows as never,
    trusted,
    createWindow: () => {
      const win = new FakeWindow()
      created.push(win)
      return win as never
    },
    createPicker: () => fakeView() as never,
    createTray: () => {
      const view = fakeView()
      trays.push(view)
      return view as never
    },
    focusMain
  })
  const download_ = (id: string, d: DownloadInfo) => onDownload(d, id)
  const engineCalls = () => engine.createPage.mock.calls.map((call) => call[0] as { profileId: string })
  return { store, little, dispatched, trays, created, trusted, download: download_, pages, events, opened, focusMain, browser, engineCalls, visits }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 24, 10, 0, 0))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a locked application', () => {
  afterEach(() => setLockService(null))

  it('opens no window of a page over the lock screen (an extension popup asked for after the lock started), and the bar neither', () => {
    const t = setup()
    let locked = true
    setLockService({ isAppLocked: () => locked } as never)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(t.little.open('https://extension.example/popup')).toBe('')
    expect(t.little.openBar()).toBe('')
    expect(t.created).toHaveLength(0)
    expect(t.pages).toHaveLength(0)
    expect(t.little.count()).toBe(0)
    // Unlocked, the next request opens its window as before.
    locked = false
    expect(t.little.open('https://extension.example/popup')).toBe('little-1')
    expect(t.created).toHaveLength(1)
  })
})

describe('forgotten mini windows', () => {
  it('closes and archives a window once it has been open for the delay, not before', () => {
    const t = setup({ littleArcArchiveHours: 12 })
    const id = t.little.open('https://forgotten.example/page')
    const opened = Date.now()
    expect(t.little.sweep(opened + 12 * HOUR - 1)).toBe(0)
    expect(t.little.count()).toBe(1)
    expect(t.little.sweep(opened + 12 * HOUR)).toBe(1)
    expect(t.little.count()).toBe(0)
    expect(t.dispatched.filter((a) => a.type === 'archive/add')).toEqual([expect.objectContaining({ type: 'archive/add', url: 'https://forgotten.example/page', source: 'little' })])
    expect(id).toBe('little-1')
  })

  it('never closes anything with a delay of 0', () => {
    const t = setup({ littleArcArchiveHours: 0 })
    t.little.open('https://forgotten.example/')
    expect(t.little.sweep(Date.now() + 1000 * HOUR)).toBe(0)
    expect(t.little.count()).toBe(1)
  })

  it('follows the delay of the settings as it is now', () => {
    const t = setup({ littleArcArchiveHours: 24 })
    t.little.open('https://forgotten.example/')
    const later = Date.now() + 2 * HOUR
    expect(t.little.sweep(later)).toBe(0)
    t.store.set({ littleArcArchiveHours: 1 })
    expect(t.little.sweep(later)).toBe(1)
  })

  it('runs by itself every minute while there is a delay, and not at all without one', () => {
    const t = setup({ littleArcArchiveHours: 2 })
    t.little.open('https://forgotten.example/')
    vi.advanceTimersByTime(2 * HOUR + 60_000)
    expect(t.little.count()).toBe(0)
    expect(t.dispatched.some((a) => a.type === 'archive/add')).toBe(true)
    t.little.stop()
    expect(vi.getTimerCount()).toBe(0)

    const off = setup({ littleArcArchiveHours: 0 })
    off.little.open('https://forgotten.example/')
    // The gate of the archiving owns no timer when the delay is "Jamais".
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(48 * HOUR)
    expect(off.little.count()).toBe(1)
  })

  it('leaves a window that is not a web page out of the archive', () => {
    const t = setup({ littleArcArchiveHours: 1 })
    t.little.open('about:blank')
    t.little.sweep(Date.now() + 2 * HOUR)
    expect(t.dispatched.filter((a) => a.type === 'archive/add')).toEqual([])
  })
})

describe('the pin "Garder ouvert" and the activity of a window', () => {
  it('leaves a kept window out of the archiving, however long it is forgotten, and brings it back under the archiving once the pin is off', () => {
    const t = setup({ littleArcArchiveHours: 12 })
    const id = t.little.open('https://kept.example/')
    t.little.command(id, 'keep:on')
    expect(t.little.states()[0]!.kept).toBe(true)
    expect(t.little.sweep(Date.now() + 1000 * HOUR)).toBe(0)
    expect(t.little.count()).toBe(1)
    t.little.command(id, 'keep:off')
    expect(t.little.states()[0]!.kept).toBe(false)
    expect(t.little.sweep(Date.now() + 1000 * HOUR)).toBe(1)
    expect(t.dispatched.filter((a) => a.type === 'archive/add')).toHaveLength(1)
  })

  it('keeps one window and archives the other', () => {
    const t = setup({ littleArcArchiveHours: 1 })
    const kept = t.little.open('https://kept.example/')
    t.little.open('https://forgotten.example/')
    t.little.command(kept, 'keep:on')
    expect(t.little.sweep(Date.now() + 2 * HOUR)).toBe(1)
    expect(t.little.states().map((s) => s.url)).toEqual(['https://kept.example/'])
  })

  it('tells the window that the pin is on, so that its banner and its button say so', () => {
    const t = setup({ littleArcArchiveHours: 12 })
    const id = t.little.open('https://kept.example/')
    expect(t.little.states()[0]!.kept).toBe(false)
    t.little.command(id, 'keep:on')
    const sent = t.created[0]!.webContents.send.mock.calls.at(-1)!
    expect(sent[0]).toBe('lucium:little-state')
    expect((sent[1] as { kept?: boolean }).kept).toBe(true)
  })

  // What the window sent as its page loaded may have come before the header listened: once it listens, it asks again.
  it('sends its state again to a view that says it listens now', () => {
    const t = setup()
    const id = t.little.open('https://late.example/')
    const send = t.created[0]!.webContents.send
    send.mockClear()
    t.little.command(id, 'ready')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).toBe(Channel.littleState)
    expect(send.mock.calls[0]![1]).toMatchObject({ id, url: 'https://late.example/' })
  })

  it('counts the delay from the last activity: bringing the window to the front starts it again', () => {
    const t = setup({ littleArcArchiveHours: 12 })
    t.little.open('https://used.example/')
    vi.setSystemTime(Date.now() + 11 * HOUR)
    t.created[0]!.emit('focus')
    // 12 h after it was opened, 1 h after it was used: not forgotten.
    expect(t.little.sweep(Date.now() + 1 * HOUR)).toBe(0)
    expect(t.little.sweep(Date.now() + 12 * HOUR - 1)).toBe(0)
    expect(t.little.sweep(Date.now() + 12 * HOUR)).toBe(1)
  })

  it('counts a move to another page as activity, and not a reload of the same address', () => {
    const t = setup({ littleArcArchiveHours: 12 })
    t.little.open('https://page.example/a')
    vi.setSystemTime(Date.now() + 11 * HOUR)
    t.events[0]!.update({ title: 'A title came late' })
    t.events[0]!.update({ url: 'https://page.example/a' })
    expect(t.little.sweep(Date.now() + 1 * HOUR)).toBe(1)

    const u = setup({ littleArcArchiveHours: 12 })
    u.little.open('https://page.example/a')
    vi.setSystemTime(Date.now() + 11 * HOUR)
    u.events[0]!.update({ url: 'https://page.example/b' })
    expect(u.little.sweep(Date.now() + 1 * HOUR)).toBe(0)
    expect(u.little.sweep(Date.now() + 12 * HOUR)).toBe(1)
  })
})

describe('the ads and banners of the page of a window', () => {
  it('are hidden as a tab hides them, for the page the window shows now, and forgotten before the page goes with the window', () => {
    const t = setup()
    const id = t.little.open('https://page.example/')
    const events = t.events[0] as unknown as { domReady: () => void }
    events.domReady()
    expect(t.browser.hideAdsOn).toHaveBeenCalledWith(id, t.pages[0], expect.any(Function), expect.any(Function))
    const [, , urlOf, isCurrent] = t.browser.hideAdsOn.mock.calls[0] as [string, unknown, () => string | undefined, () => boolean]
    expect(urlOf()).toBe('https://page.example/')
    expect(isCurrent()).toBe(true)
    t.created[0]!.close()
    expect(t.browser.forgetBlockerCss).toHaveBeenCalledWith(id)
    expect(t.browser.forgetBlockerCss.mock.invocationCallOrder[0]!).toBeLessThan(t.pages[0]!.destroy.mock.invocationCallOrder[0]!)
    expect(isCurrent()).toBe(false)
  })
})

describe('the header of the window', () => {
  it('starts the page under the 40 px header and the 28 px banner of the archiving delay', () => {
    const t = setup()
    t.little.open('https://page.example/')
    expect(t.pages[0]!.show).toHaveBeenCalledWith({ x: 0, y: 68, width: 900, height: 650 - 68 })
  })

  it('opens Réglages › Liens from the link of the banner: that is where the delay is', () => {
    const t = setup()
    const id = t.little.open('https://page.example/')
    t.little.command(id, 'archive-delay')
    expect(t.opened).toEqual([{ panel: 'settings', pane: 'navigation', anchor: 'links' }])
  })
})

describe('the space a window comes from', () => {
  /** Two spaces of two profiles; the main window shows the first. */
  const twoProfiles = () => {
    const t = setup()
    t.store.apply({ type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileId: 'travail' })
    const [home, work] = t.store.get().spaces
    t.store.apply({ type: 'space/select', id: home!.id })
    return { ...t, home: home!, work: work! }
  }

  it('makes its page with the profile of the space of the tab that opened it, not of the space the main window shows', () => {
    const t = twoProfiles()
    t.little.open('https://mail.example/', undefined, t.work.id)
    expect(t.events).toHaveLength(1)
    expect(t.engineCalls()[0]).toMatchObject({ profileId: 'travail' })
  })

  it('is archived in that space when it closes, and goes there as a tab', () => {
    const t = twoProfiles()
    const archived = t.little.open('https://mail.example/', undefined, t.work.id)
    t.events[0]!.update({ url: 'https://mail.example/inbox', title: 'Boîte' })
    t.little.close(archived)
    expect(t.dispatched.at(-1)).toMatchObject({ type: 'archive/add', url: 'https://mail.example/inbox', spaceId: t.work.id })
    const promoted = t.little.open('https://docs.example/', undefined, t.work.id)
    t.events[1]!.update({ url: 'https://docs.example/a', title: 'Doc' })
    t.little.command(promoted, 'open-in-main')
    expect(t.dispatched.at(-1)).toEqual({ type: 'tab/open', url: 'https://docs.example/a', spaceId: t.work.id })
  })

  it('takes the space the main window shows when it names none, or one that is gone', () => {
    const t = twoProfiles()
    t.store.apply({ type: 'space/select', id: t.work.id })
    t.little.open('https://a.example/')
    t.little.open('https://b.example/', undefined, 'gone')
    expect(t.engineCalls().map((options) => options.profileId)).toEqual(['travail', 'travail'])
  })
})

describe('the history of the pages of a window', () => {
  /** A second space, of a profile of its own, that the window can come from. */
  const withWork = () => {
    const t = setup()
    t.store.apply({ type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileId: 'travail' })
    return { ...t, work: t.store.get().spaces.at(-1)! }
  }
  /** The visits recorded, apart from the titles given afterwards. */
  const recorded = (t: Pick<ReturnType<typeof setup>, 'visits'>) => t.visits.filter((visit) => visit.kind === 'record')

  it('records a page once it has loaded, like a tab: in the history of the profile of the space the window comes from, tagged with that space', () => {
    const t = withWork()
    t.little.open('https://mail.example/', undefined, t.work.id)
    t.events[0]!.update({ url: 'https://mail.example/inbox', title: 'Boîte' })
    // Still loading: not a visit yet.
    expect(recorded(t)).toEqual([])
    t.events[0]!.update({ loading: false })
    expect(recorded(t)).toEqual([{ kind: 'record', profileId: 'travail', spaceId: t.work.id, url: 'https://mail.example/inbox', title: 'Boîte' }])
  })

  it('records nothing for a load that came to no page: a frame that loaded in the page, a download, one of our error pages', () => {
    const t = withWork()
    t.little.open('https://mail.example/', undefined, t.work.id)
    t.events[0]!.update({ url: 'https://mail.example/inbox', title: 'Boîte' })
    t.events[0]!.update({ loading: false, visit: false })
    t.pages[0]!.showsError.mockReturnValue(true)
    t.events[0]!.update({ loading: false })
    expect(recorded(t)).toEqual([])
    // Nor does the title such a load brings name the page of the history.
    t.pages[0]!.showsError.mockReturnValue(false)
    const before = t.visits.length
    t.events[0]!.update({ title: 'Cadre', loading: false, visit: false })
    expect(t.visits).toHaveLength(before)
  })

  it('gives the page the title it ended with, once it has loaded (not a second visit)', () => {
    const t = withWork()
    t.little.open('https://mail.example/', undefined, t.work.id)
    t.events[0]!.update({ url: 'https://mail.example/inbox', title: 'Boîte' })
    t.events[0]!.update({ loading: false })
    t.events[0]!.update({ title: 'Boîte (3)' })
    expect(recorded(t)).toHaveLength(1)
    expect(t.visits.at(-1)).toMatchObject({ kind: 'retitle', url: 'https://mail.example/inbox', title: 'Boîte (3)' })
    // The title of a page that is an error page of ours is not the page's.
    t.pages[0]!.showsError.mockReturnValue(true)
    const before = t.visits.length
    t.events[0]!.update({ title: 'Erreur' })
    expect(t.visits).toHaveLength(before)
  })

  it('records a window an extension opened in the profile of that extension, and says no space unless the profile is the space’s own', () => {
    const t = withWork()
    t.little.open('https://ext.example/', 'ext-profile')
    t.events[0]!.update({ url: 'https://ext.example/a', title: 'A', loading: false })
    t.little.open('https://ext.example/', 'travail', t.work.id)
    t.events[1]!.update({ url: 'https://ext.example/b', title: 'B', loading: false })
    expect(recorded(t).map((visit) => [visit.profileId, visit.spaceId])).toEqual([['ext-profile', undefined], ['travail', t.work.id]])
  })
})

describe('an address typed in the bar of the first state', () => {
  it('that cannot be read is told in a box on the window and loads nothing (the page would throw)', () => {
    const t = setup()
    showMessageBox.mockClear()
    const id = t.little.openBar()
    for (const input of ['http://exa mple.com', 'http://x.com:99999']) expect(() => t.little.command(id, `go:${input}`)).not.toThrow()
    expect(t.pages).toHaveLength(0)
    expect(showMessageBox).toHaveBeenCalledTimes(2)
    expect((showMessageBox.mock.calls[0] as unknown as [unknown, { message: string }])[1].message).toBe(tr('browser.adresse-invalide'))
    expect(t.little.count()).toBe(1)
  })
})

describe('an open tab chosen in the bar of the first state', () => {
  const withTabs = () => {
    const t = setup()
    t.store.apply({ type: 'tab/open', url: 'https://one.example/' })
    t.store.apply({ type: 'tab/open', url: 'https://two.example/' })
    t.store.apply({ type: 'tab/open', url: 'https://secret.example/', private: true })
    const [one, two, secret] = t.store.get().tabs
    return { ...t, one: one!, two: two!, secret: secret! }
  }

  it('brings the main window to that tab, closes the window, and archives nothing (it never had a page)', () => {
    const t = withTabs()
    const id = t.little.openBar()
    t.little.command(id, `goto-tab:${t.one.id}`)
    expect(t.dispatched).toEqual([{ type: 'tab/select', id: t.one.id }])
    expect(t.focusMain).toHaveBeenCalledTimes(1)
    expect(t.little.count()).toBe(0)
    expect(t.created[0]!.destroyed).toBe(true)
  })

  it('refuses a tab that does not exist, a private tab, and a window that already has a page', () => {
    const t = withTabs()
    // The fixture is what it says: the third tab is a private one.
    expect(t.secret).toMatchObject({ private: true, url: 'https://secret.example/' })
    const bar = t.little.openBar()
    t.little.command(bar, 'goto-tab:nope')
    t.little.command(bar, `goto-tab:${t.secret.id}`)
    expect(t.dispatched).toEqual([])
    expect(t.focusMain).not.toHaveBeenCalled()
    expect(t.little.count()).toBe(1)

    const page = t.little.open('https://page.example/')
    t.little.command(page, `goto-tab:${t.one.id}`)
    expect(t.dispatched).toEqual([])
    expect(t.little.count()).toBe(2)
  })
})

describe('the action bubble of the downloads tray', () => {
  const traySize = (t: ReturnType<typeof setup>) => t.trays.at(-1)!.setBounds.mock.calls.at(-1)![0] as { height: number }

  function withDownload(settings: Partial<Settings> = { littleDownloadBubble: true }) {
    const t = setup({ littleArcArchiveHours: 0, ...settings })
    const id = t.little.open('https://page.example/')
    const state = () => t.little.states().find((s) => s.id === id)!
    return { ...t, id, state }
  }

  it('rises when a download finishes, above the first row of the tray, and goes by itself after a few seconds', () => {
    const t = withDownload()
    t.download(t.id, download({ state: 'progressing', receivedBytes: 3 }))
    expect(t.state().bubble).toBeUndefined()
    expect(traySize(t).height).toBe(66)
    t.download(t.id, download())
    expect(t.state().bubble).toBe('d1')
    expect(traySize(t).height).toBe(66 + LITTLE_BUBBLE.height + LITTLE_BUBBLE.gap)
    expect(t.little.bubbleTimerCount()).toBe(1)
    vi.advanceTimersByTime(LITTLE_BUBBLE.shownMs - 1)
    expect(t.state().bubble).toBe('d1')
    vi.advanceTimersByTime(1)
    expect(t.state().bubble).toBeUndefined()
    expect(traySize(t).height).toBe(66)
    expect(t.little.bubbleTimerCount()).toBe(0)
  })

  it('does not rise while the setting is off, and owns no timer', () => {
    const t = withDownload({ littleDownloadBubble: false })
    t.download(t.id, download({ state: 'progressing' }))
    t.download(t.id, download())
    expect(t.state().bubble).toBeUndefined()
    expect(t.little.bubbleRunning()).toBe(false)
    expect(t.little.bubbleTimerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    // The tray itself works as it always did.
    expect(t.state().downloads).toHaveLength(1)
    expect(traySize(t).height).toBe(66)
  })

  it('does not rise for a file opened without being kept, a failed download or one no window owns', () => {
    const t = withDownload()
    t.download(t.id, download({ id: 'temp', temporary: true }))
    t.download(t.id, download({ id: 'bad', state: 'interrupted' }))
    t.download('some-other-page', download({ id: 'elsewhere' }))
    expect(t.state().bubble).toBeUndefined()
    expect(t.little.bubbleTimerCount()).toBe(0)
  })

  it('does not rise twice for the same end, even after it was closed', () => {
    const t = withDownload()
    t.download(t.id, download({ state: 'progressing' }))
    t.download(t.id, download())
    t.little.command(t.id, 'bubble-close')
    expect(t.state().bubble).toBeUndefined()
    t.download(t.id, download())
    expect(t.state().bubble).toBeUndefined()
  })

  it('waits while the pointer is on it, and stays a little longer once the pointer leaves', () => {
    const t = withDownload()
    t.download(t.id, download({ state: 'progressing' }))
    t.download(t.id, download())
    t.little.command(t.id, 'bubble-hold')
    expect(t.little.bubbleTimerCount()).toBe(0)
    vi.advanceTimersByTime(10 * LITTLE_BUBBLE.shownMs)
    expect(t.state().bubble).toBe('d1')
    t.little.command(t.id, 'bubble-release')
    vi.advanceTimersByTime(LITTLE_BUBBLE.leftMs - 1)
    expect(t.state().bubble).toBe('d1')
    vi.advanceTimersByTime(1)
    expect(t.state().bubble).toBeUndefined()
  })

  it('ignores a hold or a release when there is no bubble', () => {
    const t = withDownload()
    t.little.command(t.id, 'bubble-hold')
    t.little.command(t.id, 'bubble-release')
    expect(t.little.bubbleTimerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('goes with the row that is taken out of the tray', () => {
    const t = withDownload()
    t.download(t.id, download({ state: 'progressing' }))
    t.download(t.id, download())
    t.little.command(t.id, 'dismiss-download:d1')
    expect(t.state().bubble).toBeUndefined()
    expect(t.state().downloads).toEqual([])
    expect(t.little.bubbleTimerCount()).toBe(0)
  })

  it('goes to a newer download, with a fresh delay', () => {
    const t = withDownload()
    t.download(t.id, download({ state: 'progressing' }))
    t.download(t.id, download())
    vi.advanceTimersByTime(LITTLE_BUBBLE.shownMs - 1000)
    t.download(t.id, download({ id: 'd2', filename: 'autre.zip', startedAt: 2, state: 'progressing' }))
    t.download(t.id, download({ id: 'd2', filename: 'autre.zip', startedAt: 2 }))
    expect(t.state().bubble).toBe('d2')
    expect(t.little.bubbleTimerCount()).toBe(1)
    vi.advanceTimersByTime(LITTLE_BUBBLE.shownMs - 1)
    expect(t.state().bubble).toBe('d2')
  })

  it('is taken down, with its timer, when the setting is switched off, and when the window closes', () => {
    const t = withDownload()
    t.download(t.id, download({ state: 'progressing' }))
    t.download(t.id, download())
    expect(t.little.bubbleTimerCount()).toBe(1)
    t.store.set({ littleDownloadBubble: false })
    expect(t.state().bubble).toBeUndefined()
    expect(t.little.bubbleTimerCount()).toBe(0)
    expect(t.little.bubbleRunning()).toBe(false)

    t.store.set({ littleDownloadBubble: true })
    t.download(t.id, download({ id: 'd3', state: 'progressing' }))
    t.download(t.id, download({ id: 'd3' }))
    expect(t.little.bubbleTimerCount()).toBe(1)
    t.little.close(t.id)
    expect(t.little.bubbleTimerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is told to the tray’s own page as well as the window’s', () => {
    const t = withDownload()
    t.download(t.id, download({ state: 'progressing' }))
    t.download(t.id, download())
    const sent = t.trays.at(-1)!.webContents.send.mock.calls.at(-1)![1] as { bubble?: string }
    expect(sent.bubble).toBe('d1')
  })
})

describe('the commands of a mini window (little-action)', () => {
  /** A window with a page, and the listener the class put on the channel of its commands. */
  function withCommands() {
    const t = setup()
    const id = t.little.open('https://a.example/')
    const listener = vi.mocked(ipcMain.on).mock.calls.findLast(([channel]) => channel === Channel.littleAction)![1] as unknown as (event: unknown, id: unknown, command: unknown) => void
    const win = t.created.at(-1)!
    const mainFrame = {}
    /** A command from the web contents `from`, by its top frame or by a frame inside it. */
    const command = (from: number, name: unknown, subframe = false) => listener({ sender: { id: from, mainFrame }, senderFrame: subframe ? {} : mainFrame }, id, name)
    return { ...t, id, win, page: t.pages.at(-1)!, command }
  }

  it('are run for the window’s own interface', () => {
    const t = withCommands()
    t.command(t.win.webContents.id, 'reload')
    expect(t.page.reload).toHaveBeenCalledTimes(1)
    t.command(t.win.webContents.id, 'close')
    expect(t.win.destroyed).toBe(true)
  })

  it('are refused from a frame inside that interface: only its top frame speaks for it', () => {
    const t = withCommands()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    t.command(t.win.webContents.id, 'reload', true)
    t.command(t.win.webContents.id, 'close', true)
    expect(t.page.reload).not.toHaveBeenCalled()
    expect(t.win.destroyed).toBe(false)
    expect(warn).toHaveBeenCalledWith('[little] ignored a command from a subframe')
  })

  // The mini windows are closed when the application locks; one that is still there must not be driven behind the lock screen.
  it('are refused while the application is locked, with a line in the log, and run again once it is unlocked', () => {
    const t = withCommands()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let locked = true
    setLockService({ isAppLocked: () => locked } as never)
    try {
      t.command(t.win.webContents.id, 'reload')
      t.command(t.win.webContents.id, 'close')
      expect(t.page.reload).not.toHaveBeenCalled()
      expect(t.win.destroyed).toBe(false)
      expect(warn).toHaveBeenCalledWith(`[lock] ignored ${Channel.littleAction}: the application is locked`)
      locked = false
      t.command(t.win.webContents.id, 'reload')
      expect(t.page.reload).toHaveBeenCalledTimes(1)
    } finally {
      setLockService(null)
    }
  })

  it('are refused from any other web contents (a page, another window), and for a command that is not a word', () => {
    const t = withCommands()
    t.command(999_999, 'close')
    t.command(t.win.webContents.id, { toString: () => 'close' })
    expect(t.win.destroyed).toBe(false)
  })
})

describe('the icon of the page of a mini window', () => {
  const iconOf = (t: ReturnType<typeof setup>, id: string): string | undefined => (t.little as unknown as { windows: Map<string, { state: { faviconUrl?: string } }> }).windows.get(id)?.state.faviconUrl
  const tell = (t: ReturnType<typeof setup>, patch: Record<string, unknown>): void => (t.events[0]!.update as (patch: Record<string, unknown>) => void)(patch)

  it('follows what the page tells, and goes when the page tells an empty one: the icon of the page before does not stay over another site', () => {
    const t = setup()
    const id = t.little.open('https://a.example/')
    tell(t, { url: 'https://a.example/', faviconUrl: 'https://a.example/favicon.ico' })
    expect(iconOf(t, id)).toBe('https://a.example/favicon.ico')
    // A patch that says nothing of the icon keeps it.
    tell(t, { title: 'A' })
    expect(iconOf(t, id)).toBe('https://a.example/favicon.ico')
    tell(t, { url: 'https://b.example/', faviconUrl: '' })
    expect(iconOf(t, id)).toBeUndefined()
  })
})
