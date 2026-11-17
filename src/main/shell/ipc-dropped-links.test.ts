// A link another application dropped on a window, at the door of the main process (ipc.ts, `openDroppedLinks`): the interface sends the text of the drop and
// is not trusted, so what opens is decided here, by the rules of shared/dropped-links.ts, run for real over a fake Electron. Whatever it sends, no tab opens that
// the rules would not open; a refusal is counted and said; and the tab is a new one in the window that got the drop, with no opener.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel, type LuciumApi } from '@shared/ipc'
import { DROPPED_LINKS_MAX, DROPPED_LINKS_TEXT_MAX } from '@shared/dropped-links'
import { setLanguage } from '@shared/i18n'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser } from './browser-fake.test-support'
import { ipcHost, sendFrom } from './ipc-fake.test-support'

vi.mock('electron', async () => (await import('./ipc-fake.test-support')).fakeElectron())
vi.mock('electron-chrome-extensions/browser-action', () => ({ injectBrowserAction: () => {} }))
const { registerIpc } = await import('./ipc')

const UI = 1
const STRANGER = 99
const state = createInitialState({ now: 0, newId: () => 'x' })
const store = { get: () => state, subscribe: () => () => {} } as never
const mode = { privateWindow: false }
const browser = fakeBrowser({ isPrivate: () => mode.privateWindow })
registerIpc(browser.self as never, store, {} as never, new Set([UI]))

const drop = (text: unknown, from = UI): void => sendFrom(from, Channel.openDroppedLinks, text)
const opened = (): unknown[] => browser.calls.filter((call) => call.name === 'dispatch').map((call) => call.args[0])
const toasts = (): string[] => browser.calls.filter((call) => call.name === 'showToast').map((call) => String(call.args[0]))

beforeEach(() => {
  setLanguage('fr')
  browser.calls.length = 0
  mode.privateWindow = false
})

describe('a link dropped on a window', () => {
  it('opens in a new tab of the window: in front, with no opener, no parent and no space of its own, so that it opens in the space on show', () => {
    drop('https://example.com/page?q=1#top')
    expect(opened()).toEqual([{ type: 'tab/open', url: 'https://example.com/page?q=1#top', background: false }])
    expect(toasts()).toEqual([])
  })

  it('opens each address of a list in a tab of its own, the first in front, and tells nothing when none was left out', () => {
    drop('# a list of links\r\nhttps://a.example/\r\nhttp://b.example/x\r\n')
    expect(opened()).toEqual([
      { type: 'tab/open', url: 'https://a.example/', background: false },
      { type: 'tab/open', url: 'http://b.example/x', background: true }
    ])
    expect(toasts()).toEqual([])
  })

  it('opens in a private tab when the window is a private one', () => {
    mode.privateWindow = true
    drop('https://example.com/')
    expect(opened()).toEqual([{ type: 'tab/open', url: 'https://example.com/', background: false, private: true }])
  })

  it('opens nothing for what is not a web address, and says how many it refused', () => {
    drop(['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'blob:https://a.example/id', 'lucium://open?url=https://a.example/', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/p.html', 'https://user:pass@a.example/', 'ftp://a.example/'].join('\n'))
    expect(opened()).toEqual([])
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]).toContain('8 liens déposés n’ont pas été ouverts')
  })

  it('opens the ceiling of the addresses and says how many it left aside', () => {
    drop(Array.from({ length: DROPPED_LINKS_MAX + 2 }, (_, i) => `https://a.example/${i}`).join('\n'))
    expect(opened()).toHaveLength(DROPPED_LINKS_MAX)
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]).toContain('2 liens déposés n’ont pas été ouverts')
  })

  it('opens an address once, however many times the drop repeats it, and does not count the repeats as refused', () => {
    drop('https://a.example/\nhttps://a.example/\nhttps://a.example')
    expect(opened()).toHaveLength(1)
    expect(toasts()).toEqual([])
  })

  it('opens nothing and says one refusal for a text longer than 16 KB, even when it starts with a link', () => {
    drop(`https://a.example/\n${'x'.repeat(DROPPED_LINKS_TEXT_MAX)}`)
    expect(opened()).toEqual([])
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]).toContain('1 lien déposé n’a pas été ouvert')
  })

  it('says it in English in an English interface', () => {
    setLanguage('en')
    drop('javascript:alert(1)\nhttps://a.example/')
    expect(toasts()).toEqual(['1 dropped link wasn’t opened: Lucium only opens http and https web addresses with no user name or password, 10 at most at a time.'])
  })

  it('opens nothing for text that has no address in it, and says nothing: a paragraph dragged along is not a refused link', () => {
    drop('Some text selected in another application.\nNote: it is not a link.')
    expect(opened()).toEqual([])
    expect(toasts()).toEqual([])
  })

  // The interface sends what it is given by the page it shows or by an application: the main process does not take its word for the type.
  it.each([[undefined], [null], [7], [true], [{}], [{ toString: () => 'https://a.example/' }], [['https://a.example/']]])('opens nothing for %j, which is not a text', (value) => {
    drop(value)
    expect(opened()).toEqual([])
    expect(toasts()).toEqual([])
  })

  it('is not answered for a page that is not a surface of the window', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    drop('https://a.example/', STRANGER)
    expect(opened()).toEqual([])
    vi.restoreAllMocks()
  })
})

// The bridge of the interface (the preload script) sends the text as it is, on its own channel, and nothing else.
describe('the wiring of the dropped link in the bridge of the interface', () => {
  it('sends the text on its own channel', async () => {
    vi.stubGlobal('location', { search: '' })
    try {
      await import('../../preload/index')
      const api = ipcHost.exposed.get('lucium') as LuciumApi
      ipcHost.sent.length = 0
      api.openDroppedLinks('https://a.example/')
      expect(ipcHost.sent).toEqual([{ kind: 'send', channel: Channel.openDroppedLinks, args: ['https://a.example/'] }])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
