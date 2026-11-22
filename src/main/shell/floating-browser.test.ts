// « Image dans l'image » asked from Lucium, as a window of the browser runs it (browser-media.ts, `floatTabVideo`), on a stand-in of the class Browser
// (browser-fake.test-support.ts): Lucium's floating window first; the system's window for the video of a frame (the user is told) or for a page
// Lucium's window cannot take; nothing for a tab of a private window. And what the floating window is given of the tab's window: its sound (the
// sidebar's speaker), the mark of its row.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'
import { syncHost } from './sync-host.test-support'
import type { FloatOutcome } from './floating-video'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

function windowWith(outcome: FloatOutcome | null, options: { private?: boolean; frame?: { ok: boolean } } = {}) {
  const page = {
    floatMainVideo: vi.fn(async () => ({ ok: true })),
    floatFrameVideo: vi.fn(async () => (options.frame?.ok === false ? { ok: false, reason: 'no-video' } : { ok: true }))
  }
  const toasts: string[] = []
  const autoPip = { floatedByHand: vi.fn() }
  const floating = outcome ? { float: vi.fn(async () => outcome) } : null
  const own: Record<string, unknown> = {
    pages: new Map([['tab', page]]),
    autoPip,
    floatingVideo: floating,
    isPrivate: () => options.private === true,
    ownerOf: () => undefined,
    showToast: (message: string) => void toasts.push(message),
    floatTabVideo: shell['floatTabVideo'],
    floatingOwner: () => ({ owner: true })
  }
  const fake = fakeBrowser(own)
  own['leader'] = fake.self
  const float = () => shell['floatTabVideo']!.call(fake.self, 'tab') as Promise<boolean>
  return { float, page, toasts, autoPip, floating }
}

describe('« Image dans l’image » asked from Lucium', () => {
  it('floats the video in Lucium’s window, and counts it as floated by hand', async () => {
    const { float, page, autoPip, floating } = windowWith({ ok: true })
    expect(await float()).toBe(true)
    expect(floating!.float).toHaveBeenCalledWith({ owner: true }, 'tab', page)
    expect(autoPip.floatedByHand).toHaveBeenCalled()
    expect(page.floatMainVideo).not.toHaveBeenCalled()
  })

  it('floats the video of a frame in the system’s window, and says so', async () => {
    const { float, page, toasts } = windowWith({ ok: false, reason: 'frame' })
    expect(await float()).toBe(true)
    expect(page.floatFrameVideo).toHaveBeenCalled()
    expect(toasts).toEqual([t('browser.video-d-un-cadre-fenetre-du-systeme')])
  })

  it('says there is no video when the frame’s has gone too', async () => {
    const { float, toasts } = windowWith({ ok: false, reason: 'frame' }, { frame: { ok: false } })
    expect(await float()).toBe(false)
    expect(toasts).toEqual([t('browser.aucune-video-a-faire-flotter')])
  })

  it('says there is no video to float, without trying the system’s window', async () => {
    const { float, page, toasts } = windowWith({ ok: false, reason: 'no-video' })
    expect(await float()).toBe(false)
    expect(page.floatMainVideo).not.toHaveBeenCalled()
    expect(toasts).toEqual([t('browser.aucune-video-a-faire-flotter')])
  })

  it('floats the video in the system’s window when Lucium’s cannot take the page, or does not exist', async () => {
    for (const outcome of [{ ok: false, reason: 'refused' } as const, null]) {
      const { float, page } = windowWith(outcome)
      expect(await float()).toBe(true)
      expect(page.floatMainVideo).toHaveBeenCalled()
    }
  })

  it('does nothing for a tab of a private window', async () => {
    const { float, page, floating } = windowWith({ ok: true }, { private: true })
    expect(await float()).toBe(false)
    expect(floating!.float).not.toHaveBeenCalled()
    expect(page.floatMainVideo).not.toHaveBeenCalled()
  })
})

function siteButton(options: { setting?: boolean; private?: boolean; floatingTab?: string | null; floatOutcome?: FloatOutcome } = {}) {
  const calls: string[] = []
  const page = {
    setPictureInPicture: vi.fn(async (on: boolean) => (calls.push(`system-${on ? 'in' : 'out'}`), true)),
    floatMainVideo: vi.fn(async () => (calls.push('system-float'), { ok: true }))
  }
  const floating = {
    floatingTab: () => options.floatingTab ?? null,
    float: vi.fn(async () => (calls.push('lucium'), options.floatOutcome ?? { ok: true }))
  }
  const own: Record<string, unknown> = {
    pages: new Map([['tab', page]]),
    autoPip: { floatedByHand: vi.fn() },
    floatingVideo: floating,
    store: { get: () => ({ settings: { sitePictureInPictureInLucium: options.setting !== false } }) },
    isPrivate: () => options.private === true,
    ownerOf: () => undefined,
    showToast: vi.fn(),
    floatTabVideo: shell['floatTabVideo'],
    floatingOwner: () => ({ owner: true })
  }
  const fake = fakeBrowser(own)
  own['leader'] = fake.self
  return { take: () => shell['takeSitePictureInPicture']!.call(fake.self, 'tab') as Promise<void>, page, floating, calls }
}

describe('the site’s own Picture in Picture button', () => {
  it('leaves the system’s window, then floats the video in Lucium’s', async () => {
    const { take, calls, page } = siteButton()
    await take()
    expect(calls).toEqual(['system-out', 'lucium'])
    expect(page.floatMainVideo).not.toHaveBeenCalled()
  })

  it('is left to the system when the setting is off, in a private window, or when the tab already floats in Lucium’s window', async () => {
    for (const options of [{ setting: false }, { private: true }, { floatingTab: 'tab' }]) {
      const { take, calls } = siteButton(options)
      await take()
      expect(calls).toEqual([])
    }
  })

  it('gives the system’s window back when Lucium’s refuses and nothing floats', async () => {
    const { take, calls } = siteButton({ floatOutcome: { ok: false, reason: 'busy' } })
    await take()
    expect(calls).toEqual(['system-out', 'lucium', 'system-float'])
  })

  it('floats a protected video the same way: the page is lent, not copied (the window takes the page as it is)', async () => {
    // The lent view keeps the page's own player and its protection; what is asked of the window is the same call whatever the video.
    const { take, floating } = siteButton()
    await take()
    expect(floating.float).toHaveBeenCalledWith({ owner: true }, 'tab', expect.anything())
  })
})

describe('the automatic picture when a tab with a watched video is left', () => {
  function left(options: { can?: boolean; outcome?: FloatOutcome; private?: boolean; noFloating?: boolean } = {}) {
    const calls: string[] = []
    const page = {
      watchedVideoCanFloat: vi.fn(async () => options.can !== false),
      setPictureInPicture: vi.fn(async () => (calls.push('system'), true))
    }
    const floating = { float: vi.fn(async () => (calls.push('lucium'), options.outcome ?? { ok: true })) }
    const own: Record<string, unknown> = { pages: new Map([['tab', page]]), floatingVideo: options.noFloating ? null : floating, isPrivate: () => options.private === true, ownerOf: () => undefined, floatingOwner: () => ({ owner: true }) }
    const fake = fakeBrowser(own)
    own['leader'] = fake.self
    return { run: () => shell['floatWatchedVideo']!.call(fake.self, 'tab', page) as Promise<boolean>, calls, page }
  }

  it('floats it in Lucium’s window', async () => {
    const { run, calls } = left()
    expect(await run()).toBe(true)
    expect(calls).toEqual(['lucium'])
  })

  it('floats nothing when no video is being watched', async () => {
    const { run, calls } = left({ can: false })
    expect(await run()).toBe(false)
    expect(calls).toEqual([])
  })

  it('uses the system’s window when Lucium’s cannot take the page, in a private window, or does not exist', async () => {
    for (const options of [{ outcome: { ok: false, reason: 'refused' } as const }, { private: true }, { noFloating: true }]) {
      const { run, calls } = left(options)
      expect(await run()).toBe(true)
      expect(calls.at(-1)).toBe('system')
    }
  })
})

describe('what the floating window is given of the tab’s window', () => {
  function owner(muted: boolean) {
    const own: Record<string, unknown> = {
      runtime: { tabs: { tab: { loading: false, audible: true, muted, awake: true } } },
      win: { isDestroyed: () => false, getBounds: () => ({ x: 1, y: 2, width: 3, height: 4 }) },
      store: { get: () => ({ tabs: [{ id: 'tab', url: 'https://www.twitch.tv/lucium' }] }) },
      toggleMute: vi.fn(),
      layout: vi.fn(),
      publish: vi.fn(),
      markFloating: shell['markFloating']
    }
    const fake = fakeBrowser(own)
    return { own, given: shell['floatingOwner']!.call(fake.self) as import('./floating-video').FloatingOwner }
  }

  it('cuts or gives back the sound of the tab as the speaker of its row does, only when it changes', () => {
    const { own, given } = owner(false)
    expect(given.tabMuted('tab')).toBe(false)
    given.setTabMuted('tab', false)
    expect(own['toggleMute']).not.toHaveBeenCalled()
    given.setTabMuted('tab', true)
    expect(own['toggleMute']).toHaveBeenCalledWith('tab')
  })

  it('marks the row of the tab while it floats, and lays the window out again as the page leaves or comes back', () => {
    const { own, given } = owner(false)
    given.floatingChanged('tab', true)
    expect((own['runtime'] as { tabs: Record<string, { floating?: true }> }).tabs['tab']!.floating).toBe(true)
    expect(own['layout']).toHaveBeenCalledTimes(1)
    expect(own['publish']).toHaveBeenCalledTimes(1)
    given.floatingChanged('tab', false)
    expect((own['runtime'] as { tabs: Record<string, { floating?: true }> }).tabs['tab']).not.toHaveProperty('floating')
  })

  it('names the site of the tab', () => {
    expect(owner(false).given.siteOf('tab')).toBe('twitch.tv')
  })
})

// Taking the live page of a tab to another window (`adoptPage`) and the sync of a window run on stand-ins: what matters here is the order of what they ask of the
// floating window and of the page.
describe('a floating tab taken to another window', () => {
  it('has its video given back to it before its page moves: a lent page refuses to move (page-lend.test.ts) and would be loaded again in the other window', async () => {
    const { pageRelays } = await import('./browser-base')
    const order: string[] = []
    const page = { moveToWindow: () => (order.push('move'), true), watchKeys: () => undefined }
    pageRelays.set(page as never, () => undefined)
    const mine = fakeBrowser({
      store: { root: () => ({ get: () => ({ tabs: [{ id: 'tab', spaceId: 's', url: 'https://www.twitch.tv/lucium' }] }) }) },
      pages: new Map(),
      creating: new Set(),
      engine: 'the engine',
      isPrivate: () => false,
      sessionKeyOf: () => 'profile:default',
      leader: { floatingVideo: { release: (id: string) => void order.push(`release ${id}`) } },
      options: { windowId: 2 },
      runtime: { tabs: {} }
    })
    const owner = fakeBrowser({ pages: new Map([['tab', page]]), creating: new Set(), fullscreenTab: null, engine: 'the engine', isPrivate: () => false, pageSession: new Map([['tab', 'profile:default']]), runtime: { tabs: {} } })
    expect(shell['adoptPage']!.call(mine.self, owner.self, 'tab')).toBe(true)
    expect(order).toEqual(['release tab', 'move'])
    expect((mine.self['pages'] as Map<string, unknown>).get('tab')).toBe(page)
  })
})

describe('a tab left while its video floats in Lucium’s window', () => {
  /** A window that shows `t2` after `t1`, with the page of `t1` left (it made sound, and was committed), and the tab whose video floats in Lucium's window. */
  function leaving(floats: 'left' | 'arrived' | null, autoSite: string | null = null) {
    const left = { hide: vi.fn(), setPictureInPicture: vi.fn(async () => true), focus: vi.fn() }
    const arrived = { hide: vi.fn(), setPictureInPicture: vi.fn(async () => false), focus: vi.fn() }
    const opened: string[] = []
    const closed = vi.fn()
    const host = syncHost(['https://www.twitch.tv/lucium', 'https://journal.example/'], (tab, pages) => void pages.set(tab.id, tab.url.includes('twitch') ? left : arrived))
    const [first, second] = host.state().tabs.map((tab) => tab.id) as [string, string]
    host.pages.set(first, left)
    host.pages.set(second, arrived)
    const base = host.state()
    const floating = floats === 'left' ? first : floats === 'arrived' ? second : null
    host.fake.self['store'] = { get: () => ({ ...base, settings: { ...base.settings, mediaPlayer: true, autoPictureInPicture: true } }) }
    Object.assign(host.fake.self, {
      shownTabId: first,
      visible: new Set([first]),
      committed: new Set([first]),
      runtime: { tabs: { [first]: { loading: false, audible: true, muted: false, awake: true } } },
      leader: { releasePrivateContext: () => undefined, floatingVideo: { floatingTab: () => floating, show: () => void opened.push('show'), release: (id: string) => void opened.push(`release ${id}`) }, autoPip: { allows: () => true, floated: vi.fn(), returning: () => autoSite, closed } },
      floatWatchedVideo: (_id: string, page: { setPictureInPicture(on: boolean, by: string): Promise<boolean> }) => page.setPictureInPicture(true, 'tab-switch'),
      openMediaPlayer: (id: string) => void opened.push(`player ${id}`),
      engine: { activatePage: (id: string) => void opened.push(`activate ${id}`) }
    })
    return { host, first, second, left, arrived, opened, closed }
  }

  it('opens neither the system’s picture nor the media player for it', () => {
    const away = leaving('left')
    shell['sync']!.call(away.host.fake.self)
    expect(away.left.setPictureInPicture).not.toHaveBeenCalledWith(true, 'tab-switch')
    expect(away.opened.filter((what) => what.startsWith('player'))).toEqual([])
    // A tab whose video does not float in Lucium's window is left as before: its picture is asked for.
    const other = leaving(null)
    shell['sync']!.call(other.host.fake.self)
    expect(other.left.setPictureInPicture).toHaveBeenCalledWith(true, 'tab-switch')
  })

  it('brings Lucium’s floating window back in front when the floating tab is chosen in the sidebar, before the extensions are told of the tab', () => {
    const chosen = leaving('arrived')
    shell['sync']!.call(chosen.host.fake.self)
    expect(chosen.opened.filter((what) => what === 'show' || what.startsWith('activate'))).toEqual(['show', `activate ${chosen.second}`])
    // The window of a tab chosen whose video does not float there is left where it is.
    const other = leaving(null)
    shell['sync']!.call(other.host.fake.self)
    expect(other.opened).not.toContain('show')
  })

  it('gives the video back to its tab when the automatic picture opened the window, without counting a closing', async () => {
    const chosen = leaving('arrived', 'twitch.tv')
    shell['sync']!.call(chosen.host.fake.self)
    await Promise.resolve()
    expect(chosen.opened.filter((what) => what === 'show' || what.startsWith('release'))).toEqual([`release ${chosen.second}`])
    expect(chosen.closed).not.toHaveBeenCalled()
  })

  it('counts a closing when the window the automatic picture opened was closed while the tab was away', async () => {
    const chosen = leaving(null, 'twitch.tv')
    ;(chosen.host.fake.self['committed'] as Set<string>).add(chosen.second)
    shell['sync']!.call(chosen.host.fake.self)
    await Promise.resolve()
    await Promise.resolve()
    expect(chosen.closed).toHaveBeenCalledWith('twitch.tv')
  })
})
