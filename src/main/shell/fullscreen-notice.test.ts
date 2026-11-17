// The notice over a page in full screen, as the window draws it (fullscreen-notice.ts), over a fake of Electron's views: made when a page takes the
// window, put on it once its page has measured itself, never given the keyboard, gone after its time or with the full screen, and said in the log
// when it cannot be drawn. The rules of when it shows are tested in shared/fullscreen-notice.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeContents {
  loaded: string[]
  closed: boolean
  focused: number
  measure: () => Promise<unknown>
  load: (url: string) => Promise<void>
}

const made = vi.hoisted(() => [] as Array<{ webContents: FakeContents; bounds: unknown }>)
/** What the next page of a notice does when it loads: fail with this error (null: it loads). */
const nextLoad = vi.hoisted(() => ({ error: null as Error | null }))
vi.mock('electron', () => {
  class FakeView {
    bounds: unknown = null
    readonly webContents: FakeContents & Record<string, unknown>
    constructor() {
      const contents: FakeContents & Record<string, unknown> = {
        loaded: [],
        closed: false,
        focused: 0,
        measure: async () => [300, 44],
        load: async () => {
          if (nextLoad.error) throw nextLoad.error
        },
        setWindowOpenHandler: () => undefined,
        on: () => undefined,
        loadURL: async (url: string) => {
          contents.loaded.push(url)
          await contents.load(url)
        },
        executeJavaScript: async () => contents.measure(),
        isDestroyed: () => contents.closed,
        close: () => {
          contents.closed = true
        },
        focus: () => {
          contents.focused++
        }
      }
      this.webContents = contents
      made.push(this)
    }
    setBackgroundColor = (): void => undefined
    setBounds = (bounds: unknown): void => {
      this.bounds = bounds
    }
  }
  return { WebContentsView: FakeView }
})

const { FullscreenNotice, fullscreenNoticePage, noticeBounds, NOTICE_SHADOW, NOTICE_TOP } = await import('./fullscreen-notice')
const { FULLSCREEN_NOTICE_MS } = await import('@shared/fullscreen-notice')
const { escapeHtml } = await import('@shared/html-escape')
const { default: tokensCss } = await import('../../renderer/tokens.css?raw')

const CONTENT = { width: 1600, height: 1000 }

function fakeWindow() {
  const children: unknown[] = []
  const onClosed: Array<() => void> = []
  let destroyed = false
  return {
    children,
    destroy: () => {
      destroyed = true
      for (const listener of onClosed) listener()
    },
    win: {
      isDestroyed: () => destroyed,
      once: (event: string, listener: () => void) => {
        if (event === 'closed') onClosed.push(listener)
      },
      contentView: {
        children,
        removeChildView: (view: unknown) => {
          const at = children.indexOf(view)
          if (at >= 0) children.splice(at, 1)
        }
      }
    }
  }
}

function setup() {
  let now = 1_000
  const window = fakeWindow()
  const relayout = vi.fn()
  const notice = new FullscreenNotice(window.win as never, relayout, () => now)
  return {
    notice,
    relayout,
    window,
    advance: (ms: number) => {
      now += ms
      vi.advanceTimersByTime(ms)
    },
    follow: (tab: string | null, url = 'https://video.example/watch') => notice.follow(tab, url, CONTENT)
  }
}

/** Lets the load and the measure of the notice's page answer. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  made.length = 0
  nextLoad.error = null
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the notice over a page that takes the window in full screen', () => {
  it('makes nothing while no page holds the window', () => {
    const { follow } = setup()
    expect(follow(null)).toBeNull()
    expect(made).toHaveLength(0)
  })

  it('is put above the page once its page has measured itself, centred near the top edge, and the window is laid out again for it', async () => {
    const { follow, relayout } = setup()
    // Before its page is measured, an empty view would hide a corner of the page: nothing is put on the window yet.
    expect(follow('a')).toBeNull()
    expect(made).toHaveLength(1)
    await settle()
    expect(relayout).toHaveBeenCalledTimes(1)
    const shown = follow('a')
    expect(shown?.view).toBe(made[0])
    expect(shown?.bounds).toEqual({ x: Math.round((1600 - (300 + NOTICE_SHADOW * 2)) / 2), y: NOTICE_TOP - NOTICE_SHADOW, width: 300 + NOTICE_SHADOW * 2, height: 44 + NOTICE_SHADOW * 2 })
  })

  it('names the site of the page in full screen, and never takes the keyboard from it', async () => {
    const { follow } = setup()
    follow('a', 'https://www.video.example/watch?v=1')
    await settle()
    const html = Buffer.from(made[0]!.webContents.loaded[0]!.split(',')[1]!, 'base64').toString('utf8')
    expect(html).toContain('video.example')
    expect(made[0]!.webContents.focused).toBe(0)
  })

  it('goes by itself after its time: the window is laid out again, and its page and its process are closed', async () => {
    const { follow, relayout, advance } = setup()
    follow('a')
    await settle()
    relayout.mockClear()
    advance(FULLSCREEN_NOTICE_MS - 1)
    expect(relayout).not.toHaveBeenCalled()
    advance(1)
    expect(relayout).toHaveBeenCalledTimes(1)
    expect(follow('a')).toBeNull()
    expect(made[0]!.webContents.closed).toBe(true)
    expect(made).toHaveLength(1)
  })

  it('stays one notice while the same page keeps the window: the layout asks at every change', async () => {
    const { follow } = setup()
    follow('a')
    await settle()
    follow('a')
    follow('a')
    expect(made).toHaveLength(1)
    expect(made[0]!.webContents.closed).toBe(false)
  })

  it('goes with the full screen, off the window, and comes again when the page takes the window again', async () => {
    const { follow, window } = setup()
    follow('a')
    await settle()
    window.children.push(made[0])
    expect(follow(null)).toBeNull()
    expect(made[0]!.webContents.closed).toBe(true)
    expect(window.children).toEqual([])
    follow('a')
    expect(made).toHaveLength(2)
  })

  it('is not drawn when the page left full screen while it was measured', async () => {
    const { follow, relayout } = setup()
    follow('a')
    follow(null)
    await settle()
    expect(relayout).not.toHaveBeenCalled()
    expect(follow(null)).toBeNull()
  })

  it('is not drawn when the page left full screen while it was loading, and its closing is no failure to report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { follow, relayout } = setup()
    nextLoad.error = new Error('ERR_ABORTED (-3)')
    follow('a')
    follow(null)
    await settle()
    expect(relayout).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('says in the log why it could not be drawn, and leaves nothing on the window: a page that does not load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { follow } = setup()
    nextLoad.error = new Error('ERR_FAILED (-2)')
    follow('a')
    await settle()
    expect(warn).toHaveBeenCalledWith('[fullscreen] the notice over a page in full screen could not be drawn: ERR_FAILED (-2)')
    expect(made[0]!.webContents.closed).toBe(true)
    expect(follow('a')).toBeNull()
  })

  it('says in the log why it could not be drawn: a page that does not give its size', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { follow } = setup()
    follow('a')
    made[0]!.webContents.measure = async () => 'not a size'
    await settle()
    expect(warn).toHaveBeenCalledWith('[fullscreen] the notice over a page in full screen could not be drawn: its page measured "not a size"')
    expect(made[0]!.webContents.closed).toBe(true)
    expect(follow('a')).toBeNull()
  })

  it('closes its page with the window', async () => {
    const { follow, window } = setup()
    follow('a')
    await settle()
    window.destroy()
    expect(made[0]!.webContents.closed).toBe(true)
  })
})

describe('the page of the notice', () => {
  it('writes the lines as text, never as markup', () => {
    const html = fullscreenNoticePage({ site: '<img src=x onerror=alert(1)> est en plein écran', exit: 'Échap & co' })
    expect(html).not.toContain('<img')
    expect(html).toContain(escapeHtml('<img src=x onerror=alert(1)> est en plein écran'))
    expect(html).toContain('Échap &amp; co')
  })

  it('lets no script run and nothing load', () => {
    const html = fullscreenNoticePage({ site: 'a', exit: 'b' })
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`)
    expect(html).not.toMatch(/<script/i)
  })

  it('draws with the roles of tokens.css only: every var() it uses is declared in the page, and no colour is written outside them', () => {
    const html = fullscreenNoticePage({ site: 'a', exit: 'b' }, tokensCss)
    const style = /<style>([\s\S]*)<\/style>/.exec(html)![1]!
    const declared = new Set([...style.matchAll(/(--[\w-]+):/g)].map((m) => m[1]))
    const used = [...style.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(5)
    for (const name of used) expect(declared, name).toContain(name)
    // The colours are those of the tokens copied into :root; the rules of the notice write none of their own.
    const rules = style.replace(/:root \{[^}]*\}/, '')
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i)
  })
})

describe('the place of the notice', () => {
  it('is never wider or taller than the window', () => {
    expect(noticeBounds({ width: 200, height: 40 }, { width: 600, height: 80 })).toEqual({ x: 0, y: NOTICE_TOP - NOTICE_SHADOW, width: 200, height: 40 })
  })
})
