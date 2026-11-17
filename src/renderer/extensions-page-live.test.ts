// @vitest-environment happy-dom
// The Extensions page mounted in a document: what a static render cannot show. The sentence shown when a request of the page fails, and the
// journal of an extension following its last line without moving anything but its own list.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JournalEntry } from '@shared/extension-journal'
import { setLanguage, t } from '@shared/i18n'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { ExtensionsPage, JournalLines } from './ExtensionsPage'
import { JOURNAL_END_SLACK, followJournal, journalAtEnd } from './journal-scroll'
import { mount, settle, type Mounted } from './dom.test-support'

let mounted: Mounted | null = null

beforeEach(() => setLanguage('fr'))
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('a request of the page that fails', () => {
  async function page(failure: Error): Promise<HTMLElement> {
    // One extension: the page asks for the details of the manifests when the list it is given changes.
    const snapshot = { state: createInitialState({ now: 1, newId: () => 'id' }), extensions: [{ id: 'a'.repeat(32), name: 'Sonde', version: '1.0.0', profileId: 'default', source: 'store', enabled: true }] } as unknown as UiSnapshot
    ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = {
      getSnapshot: async () => snapshot,
      onSnapshot: () => () => undefined,
      extensionsPage: () => Promise.reject(failure)
    }
    mounted = mount(createElement(ExtensionsPage))
    await settle()
    await settle()
    // The snapshot comes, then the details are asked for, then their failure is drawn: as many turns as it takes.
    for (let turn = 0; turn < 10 && !mounted.container.querySelector('.xp-notice'); turn++) await settle(() => new Promise((resolve) => setTimeout(resolve, 0)))
    return mounted.container
  }

  it('is told with the sentence of the main process, without the name of the channel, and written to the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const container = await page(new Error("Error invoking remote method 'lucium:extensions-page': Error: The application is locked"))
    expect(container.querySelector('.xp-notice.failed[role="alert"] span')?.textContent).toBe(t('extpage.l-action-a-echoue-message', { message: 'The application is locked' }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[extensions] the request'), expect.any(Error))
  })

  it('is told with a sentence of the catalogue when the error says nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const container = await page(new Error(''))
    expect(container.querySelector('.xp-notice.failed[role="alert"] span')?.textContent).toBe(t('extpage.l-action-a-echoue-message', { message: t('errors.erreur-inattendue') }))
  })
})

describe('the requests the page makes by itself', () => {
  /** The page over a list of extensions that has come; `answer` is what the main process says to each request. */
  async function page(extensions: unknown[], answer: (request: { op: string }) => Promise<unknown>) {
    const asked: string[] = []
    const snapshot = { state: createInitialState({ now: 1, newId: () => 'id' }), extensions } as unknown as UiSnapshot
    ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = {
      getSnapshot: async () => snapshot,
      onSnapshot: () => () => undefined,
      extensionsPage: ((request: { op: string }) => {
        asked.push(request.op)
        return answer(request)
      }) as never
    }
    mounted = mount(createElement(ExtensionsPage))
    for (let turn = 0; turn < 6; turn++) await settle(() => new Promise((resolve) => setTimeout(resolve, 0)))
    return asked
  }

  it('asks for the details of the manifests once the list has come, even when it holds no extension', async () => {
    const asked = await page([], async () => ({ ok: true, details: {}, journal: [] }))
    expect(asked.filter((op) => op === 'details')).toHaveLength(1)
  })

  it('writes a journal that cannot be read to the console when it stops answering, not at every turn; and again when it fails after it came back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let readable = false
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const asked = await page([], async (request) => {
        if (request.op === 'journal' && !readable) throw new Error('unreadable')
        return { ok: true, details: {}, journal: [] }
      })
      const turn = async (): Promise<void> => {
        vi.advanceTimersByTime(1500)
        for (let n = 0; n < 4; n++) await settle(() => new Promise((resolve) => setTimeout(resolve, 0)))
      }
      const logged = (): number => warn.mock.calls.filter((call) => String(call[0]).includes('the request journal failed')).length
      await turn()
      await turn()
      expect(asked.filter((op) => op === 'journal').length).toBeGreaterThanOrEqual(3)
      expect(logged()).toBe(1)
      readable = true
      await turn()
      readable = false
      await turn()
      await turn()
      expect(logged()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the journal of an extension', () => {
  const line = (id: number): JournalEntry => ({ id, at: 1, level: 'error', source: 'page', message: `line ${id}` })
  const lines = (count: number): JournalEntry[] => Array.from({ length: count }, (_, index) => line(index + 1))

  it('shows a message said many times as one line with its count, and a message said once without one', () => {
    const same = Array.from({ length: 12 }, (_, index): JournalEntry => ({ id: index + 1, at: 1, level: 'error', source: 'worker', message: 'Receiving end does not exist' }))
    mounted = mount(createElement(JournalLines, { entries: [...same, line(13)] }))
    const rows = [...mounted.container.querySelectorAll('.xp-journal li')]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('×12')
    expect(rows[1]!.querySelector('.times')).toBeNull()
  })

  it('counts as at its end within a few pixels of it', () => {
    expect(journalAtEnd({ scrollTop: 740, scrollHeight: 1000, clientHeight: 260 })).toBe(true)
    expect(journalAtEnd({ scrollTop: 740 - JOURNAL_END_SLACK, scrollHeight: 1000, clientHeight: 260 })).toBe(true)
    expect(journalAtEnd({ scrollTop: 300, scrollHeight: 1000, clientHeight: 260 })).toBe(false)
    const box = { scrollTop: 300, scrollHeight: 1000, clientHeight: 260 }
    followJournal(box, false)
    expect(box.scrollTop).toBe(300)
    followJournal(box, true)
    expect(box.scrollTop).toBe(1000)
  })

  it('follows its last line by scrolling its own list, never by asking a line to come into view (that moves the page too)', () => {
    const intoView = vi.fn()
    Element.prototype.scrollIntoView = intoView
    mounted = mount(createElement(JournalLines, { entries: lines(3) }))
    const list = mounted.container.querySelector<HTMLUListElement>('.xp-journal')!
    // The list is as tall as a real one would be with more lines than it shows.
    let height = 1000
    Object.defineProperty(list, 'scrollHeight', { get: () => height })
    Object.defineProperty(list, 'clientHeight', { get: () => 260 })
    height = 1040
    mounted.rerender(createElement(JournalLines, { entries: lines(4) }))
    expect(list.scrollTop).toBe(1040)
    expect(intoView).not.toHaveBeenCalled()
    // Every line is a line of the journal: no empty one is left at the end to scroll to.
    expect(list.children).toHaveLength(4)
  })

  it('stays where the reader put it when older lines are being read', () => {
    mounted = mount(createElement(JournalLines, { entries: lines(3) }))
    const list = mounted.container.querySelector<HTMLUListElement>('.xp-journal')!
    Object.defineProperty(list, 'scrollHeight', { get: () => 1000 })
    Object.defineProperty(list, 'clientHeight', { get: () => 260 })
    list.scrollTop = 120
    list.dispatchEvent(new Event('scroll', { bubbles: true }))
    mounted.rerender(createElement(JournalLines, { entries: lines(4) }))
    expect(list.scrollTop).toBe(120)
    // Back at the end, the next lines are followed again.
    list.scrollTop = 740
    list.dispatchEvent(new Event('scroll', { bubbles: true }))
    mounted.rerender(createElement(JournalLines, { entries: lines(5) }))
    expect(list.scrollTop).toBe(1000)
  })
})

describe('the page in a tab', () => {
  const A = 'a'.repeat(32)
  const extensions = [{ id: A, name: 'Sonde', version: '1.0.0', profileId: 'default', source: 'store', enabled: true }]

  /** The page mounted at an address of the tab (`path` and `search` after lucium-ui://extensions). */
  async function pageAt(path: string) {
    history.replaceState(null, '', path)
    const snapshot = { state: createInitialState({ now: 1, newId: () => 'id' }), extensions } as unknown as UiSnapshot
    ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = {
      getSnapshot: async () => snapshot,
      onSnapshot: () => () => undefined,
      extensionsPage: (async () => ({ ok: true, details: [], journal: [] })) as never
    }
    mounted = mount(createElement(ExtensionsPage))
    for (let turn = 0; turn < 6; turn++) await settle(() => new Promise((resolve) => setTimeout(resolve, 0)))
    return mounted.container
  }
  const heading = (container: HTMLElement): string => container.querySelector('.xp-title')?.textContent ?? ''
  const button = (container: HTMLElement, label: string): HTMLButtonElement => [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!

  it('opens at the view its address asks for: the list, the shortcuts, one extension', async () => {
    expect(heading(await pageAt('/'))).toBe(t('extpage.extensions'))
    mounted?.unmount()
    expect(heading(await pageAt('/shortcuts'))).toBe(t('extpage.raccourcis-clavier'))
    mounted?.unmount()
    expect(heading(await pageAt(`/?id=${A}&profile=default`))).toBe('Sonde')
  })

  it('moves between its views by the address of the tab, with nothing reloaded and nothing written to the hash', async () => {
    const container = await pageAt('/')
    await settle(() => button(container, t('extpage.details')).click())
    expect(location.pathname + location.search).toBe(`/?id=${A}&profile=default`)
    expect(location.hash).toBe('')
    expect(heading(container)).toBe('Sonde')
    // Back is the tab's own: the address goes back, and the page follows what it says.
    await settle(() => {
      history.back()
    })
    await settle(() => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(location.pathname + location.search).toBe('/')
    expect(heading(container)).toBe(t('extpage.extensions'))
  })

  it('goes to the shortcuts and back to the list from its menu, at the addresses chrome://extensions has', async () => {
    const container = await pageAt('/')
    await settle(() => button(container, t('extpage.menu-principal'))?.click())
    const open = [...container.querySelectorAll('.xp-item')]
    await settle(() => (open.find((item) => item.textContent === t('extpage.raccourcis-clavier')) as HTMLElement).click())
    expect(location.pathname).toBe('/shortcuts')
    expect(heading(container)).toBe(t('extpage.raccourcis-clavier'))
    await settle(() => (container.querySelector('.xp-item') as HTMLElement).click())
    expect(location.pathname).toBe('/')
    expect(heading(container)).toBe(t('extpage.extensions'))
  })

  it('is named Extensions, in the language of the interface, for the tab that shows it', async () => {
    document.title = ''
    await pageAt('/')
    expect(document.title).toBe(t('extpage.extensions'))
  })
})
