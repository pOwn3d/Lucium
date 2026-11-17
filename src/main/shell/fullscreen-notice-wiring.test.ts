// The layout of a window (browser-layout.ts) with a page in HTML full screen, on a stand-in of the class Browser (browser-fake.test-support.ts): the
// notice is asked for the tab that holds the window and its address, and goes above everything, the page in full screen included. Without a page
// that fills the window, no notice is asked for.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

function windowInFullScreen(options: { pageGone?: boolean } = {}) {
  const base = createInitialState({ now: 0, newId: () => 'x' })
  const tab = { ...base.tabs[0]!, id: 'video', url: 'https://video.example/watch' }
  const state = { ...base, tabs: [tab, ...base.tabs.slice(1)], settings: { ...defaultSettings(), sidebarVisible: true } }
  const page = { show: vi.fn(), raise: vi.fn(), hide: vi.fn() }
  const noticeView = { setBounds: vi.fn() }
  const noticeBounds = { x: 600, y: 4, width: 400, height: 80 }
  // As the notice answers: a view and its place for a tab in full screen, nothing for none.
  const follow = vi.fn((tab: string | null) => (tab === null ? null : { view: noticeView, bounds: noticeBounds }))
  const stacked: unknown[][] = []
  const content = { x: 0, y: 0, width: 1600, height: 1000 }
  const own: Record<string, unknown> = {
    store: { get: () => state },
    fullscreenTab: 'video',
    pages: new Map(options.pageGone ? [] : [['video', page]]),
    fullscreenNotice: { follow },
    frame: () => ({ stage: { x: 300, y: 50, width: 1200, height: 900 }, panel: null }),
    k: () => 1,
    floatVisible: false,
    overlayRequest: null,
    peek: null,
    sidePanel: null,
    webPanel: null,
    floating: { want: () => undefined, current: () => undefined },
    win: { getContentBounds: () => content, contentView: { children: [] } },
    stackOnTop: (views: unknown[]) => void stacked.push(views),
    activePage: () => undefined
  }
  const fake = fakeBrowser(own)
  const layout = () => shell['layout']!.call(fake.self)
  return { layout, follow, noticeView, noticeBounds, stacked, page, content }
}

describe('the layout of a window whose page is in full screen', () => {
  it('asks the notice for the tab that holds the window and its address, and puts it above everything, the page in full screen included', () => {
    const { layout, follow, noticeView, noticeBounds, stacked, page, content } = windowInFullScreen()
    layout()
    expect(page.show).toHaveBeenCalledWith({ x: 0, y: 0, width: content.width, height: content.height }, 0)
    expect(follow).toHaveBeenCalledWith('video', 'https://video.example/watch', content)
    expect(noticeView.setBounds).toHaveBeenCalledWith(noticeBounds)
    expect(stacked.at(-1)?.at(-1)).toBe(noticeView)
  })

  it('asks for no notice when no page fills the window', () => {
    const { layout, follow, stacked, noticeView } = windowInFullScreen({ pageGone: true })
    layout()
    expect(follow).toHaveBeenCalledWith(null, 'https://video.example/watch', expect.anything())
    expect(stacked.flat()).not.toContain(noticeView)
  })
})
