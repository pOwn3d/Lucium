// @vitest-environment happy-dom
// The command bar mounted in a document, with a history that answers later: ⇧⌫ on a page of the history and its « Annuler », what the bar says when
// the history cannot be read or a page cannot be forgotten or put back, and the space of a tab as a screen reader gets it.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import type { HistoryEntry } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { barNoticeText } from './BarClipboard'
import { ACTION_NOTICE_MS } from '@shared/toast'
import { CommandBar } from './CommandBar'
import { button, click, mount, pointerOut, pointerOver, settle, type, type Mounted } from './dom.test-support'

const PAGES: HistoryEntry[] = [
  { url: 'https://exemple.org/alpha', title: 'Exemple alpha', lastVisitAt: 30, visitCount: 3 },
  { url: 'https://exemple.org/beta', title: 'Exemple beta', lastVisitAt: 20, visitCount: 2 }
]

let mounted: Mounted | null = null
let searchHistory: ReturnType<typeof vi.fn<(query: string) => Promise<HistoryEntry[]>>>
let forgetHistory: ReturnType<typeof vi.fn<(url: string, profileId?: string, undoable?: boolean) => Promise<void>>>
let putBackHistory: ReturnType<typeof vi.fn<(url: string, profileId: string) => Promise<boolean>>>
let warn: ReturnType<typeof vi.spyOn>

function snapshot(patch: (state: ReturnType<typeof createInitialState>) => ReturnType<typeof createInitialState> = (state) => state): UiSnapshot {
  return { state: patch(createInitialState({ now: 1, newId: () => 'id' })), runtime: { tabs: {} }, extensions: [], downloads: [], windows: [], platform: 'darwin' } as unknown as UiSnapshot
}

/** The bar, mounted, its first state come. */
async function bar(shown: UiSnapshot = snapshot(), little = false): Promise<HTMLElement> {
  const own: Partial<LuciumApi> = { getSnapshot: async () => shown, searchHistory: searchHistory as never, forgetHistory: forgetHistory as never, putBackHistory: putBackHistory as never, suggest: async () => [] }
  ;(window as unknown as { lucium: unknown }).lucium = new Proxy(own, { get: (target, name: string) => (target as Record<string, unknown>)[name] ?? (name.startsWith('on') ? () => () => undefined : () => Promise.resolve(undefined)) })
  mounted = mount(createElement(CommandBar, { mode: 'current', initial: '', ...(little ? { little: { id: 'w1' } } : {}) }))
  await settle()
  return mounted.container
}

/** Lets the bar ask for the history of what is typed, and draw the answer. */
const answered = (): Promise<void> => settle(() => new Promise((resolve) => setTimeout(resolve, 120)))
const field = (container: Element): HTMLInputElement => container.querySelector<HTMLInputElement>('input[role="combobox"]')!
const key = (target: Element, name: string, shiftKey = false, metaKey = false): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: name, shiftKey, metaKey, bubbles: true, cancelable: true })
  act(() => void target.dispatchEvent(event))
  return event
}
const said = (container: Element): string => container.querySelector('.cb-clip-note')?.textContent ?? ''
/** The row that offers « Annuler » after a page was forgotten: its sentence and its button, or nothing. */
const undoRow = (container: Element): Element | null => container.querySelector('.cb-undo')
const selected = (container: Element): string => container.querySelector('li[role="option"].selected .label')?.textContent ?? ''

/** The bar narrowed to the history, with « exemple » typed: every line is a page of the history, and the first one is highlighted. */
async function historyLines(): Promise<HTMLElement> {
  const container = await bar()
  await click(button(container, `^${t('cmd.filtre-historique')}`))
  type(field(container), 'exemple')
  await answered()
  expect(selected(container)).toBe('Exemple alpha')
  return container
}

beforeEach(() => {
  setLanguage('fr')
  searchHistory = vi.fn(async () => PAGES)
  forgetHistory = vi.fn(async () => undefined)
  putBackHistory = vi.fn(async () => true)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('⇧⌫ in the field', () => {
  it('is the field’s key while typing: the page of the history the first line happens to be is not forgotten', async () => {
    const container = await historyLines()
    // The preview of the line lists the keys that do something on it: not this one, yet.
    expect(container.textContent).not.toContain(t('cmd.retirer-de-l-historique'))
    const event = key(field(container), 'Backspace', true)
    await settle()
    expect(forgetHistory).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('forgets the page of the history chosen with the arrows, says so, and reads the list again', async () => {
    const container = await historyLines()
    key(field(container), 'ArrowDown')
    expect(selected(container)).toBe('Exemple beta')
    expect(container.textContent).toContain(t('cmd.retirer-de-l-historique'))
    searchHistory.mockClear()
    const event = key(field(container), 'Backspace', true)
    await settle()
    expect(event.defaultPrevented).toBe(true)
    // In the history of the profile of the space on screen, named, and with a way back.
    expect(forgetHistory.mock.calls).toEqual([['https://exemple.org/beta', 'default', true]])
    expect(undoRow(container)?.getAttribute('role')).toBe('status')
    expect(undoRow(container)?.querySelector('b')?.textContent).toBe(t('cmd.page-oubliee'))
    expect(searchHistory).toHaveBeenCalledWith('exemple')
  })

  it('is the field’s key again once a letter is typed after the arrows', async () => {
    const container = await historyLines()
    key(field(container), 'ArrowDown')
    type(field(container), 'exempl')
    await answered()
    key(field(container), 'Delete', true)
    await settle()
    expect(forgetHistory).not.toHaveBeenCalled()
  })

  it('says that the page could not be forgotten when the request fails, and writes the name of the error only', async () => {
    forgetHistory.mockRejectedValue(new TypeError('https://exemple.org/beta could not be removed'))
    const container = await historyLines()
    key(field(container), 'ArrowDown')
    key(field(container), 'Backspace', true)
    await settle()
    expect(said(container)).toBe(t('cmd.oubli-impossible'))
    expect(container.querySelector('.cb-clip-note')?.className).toContain('problem')
    expect(warn).toHaveBeenCalledWith('[command bar] the page could not be forgotten:', 'TypeError')
  })
})

describe('« Annuler » after ⇧⌫', () => {
  /** A page of the history forgotten with ⇧⌫: the row that offers the way back is on screen. */
  async function forgotten(shown?: UiSnapshot): Promise<HTMLElement> {
    const container = await bar(shown)
    await click(button(container, `^${t('cmd.filtre-historique')}`))
    type(field(container), 'exemple')
    await answered()
    key(field(container), 'ArrowDown')
    key(field(container), 'Backspace', true)
    await settle()
    expect(undoRow(container)).not.toBeNull()
    searchHistory.mockClear()
    return container
  }

  it('is a button that puts the page back in the history of the profile it was forgotten in, says so, and reads the list again', async () => {
    const work = snapshot((state) => ({ ...state, spaces: [{ ...state.spaces[0]!, profileId: 'work' }] }))
    const container = await forgotten(work)
    expect(forgetHistory.mock.calls).toEqual([['https://exemple.org/beta', 'work', true]])
    await click(button(undoRow(container)!, t('cmd.annuler')))
    await settle()
    expect(putBackHistory.mock.calls).toEqual([['https://exemple.org/beta', 'work']])
    expect(undoRow(container)).toBeNull()
    expect(said(container)).toBe(t('cmd.page-remise-dans-l-historique'))
    expect(searchHistory).toHaveBeenCalledWith('exemple')
  })

  it('is ⌘Z too while it is offered; before and after, ⌘Z is the field’s key', async () => {
    const container = await historyLines()
    // Nothing was forgotten: the key is left to the field (it undoes what was typed).
    expect(key(field(container), 'z', false, true).defaultPrevented).toBe(false)
    key(field(container), 'ArrowDown')
    key(field(container), 'Backspace', true)
    await settle()
    const event = key(field(container), 'z', false, true)
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(putBackHistory.mock.calls).toEqual([['https://exemple.org/beta', 'default']])
    // Once taken back there is nothing left to undo: the key is the field's again, and the page is not put back twice.
    expect(key(field(container), 'z', false, true).defaultPrevented).toBe(false)
    await settle()
    expect(putBackHistory).toHaveBeenCalledTimes(1)
  })

  it('is offered for a few seconds only: afterwards the row is gone and ⌘Z puts nothing back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const container = await bar()
      await click(button(container, `^${t('cmd.filtre-historique')}`))
      type(field(container), 'exemple')
      await act(async () => void (await vi.advanceTimersByTimeAsync(200)))
      key(field(container), 'ArrowDown')
      key(field(container), 'Backspace', true)
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
      expect(undoRow(container)).not.toBeNull()
      await act(async () => void (await vi.advanceTimersByTimeAsync(ACTION_NOTICE_MS - 1)))
      expect(undoRow(container)).not.toBeNull()
      await act(async () => void (await vi.advanceTimersByTimeAsync(1)))
      expect(undoRow(container)).toBeNull()
      expect(key(field(container), 'z', false, true).defaultPrevented).toBe(false)
      expect(putBackHistory).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits while the pointer is on the row, then goes with the time it had left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const container = await bar()
      await click(button(container, `^${t('cmd.filtre-historique')}`))
      type(field(container), 'exemple')
      await act(async () => void (await vi.advanceTimersByTimeAsync(200)))
      key(field(container), 'ArrowDown')
      key(field(container), 'Backspace', true)
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
      await act(async () => void (await vi.advanceTimersByTimeAsync(2000)))
      pointerOver(undoRow(container)!)
      await act(async () => void (await vi.advanceTimersByTimeAsync(ACTION_NOTICE_MS * 3)))
      expect(undoRow(container)).not.toBeNull()
      pointerOut(undoRow(container)!)
      await act(async () => void (await vi.advanceTimersByTimeAsync(ACTION_NOTICE_MS - 2000 - 1)))
      expect(undoRow(container)).not.toBeNull()
      await act(async () => void (await vi.advanceTimersByTimeAsync(1)))
      expect(undoRow(container)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says that the page could not be put back when the history no longer has it, and writes it to the console', async () => {
    putBackHistory.mockResolvedValue(false)
    const container = await forgotten()
    await click(button(undoRow(container)!, t('cmd.annuler')))
    await settle()
    expect(said(container)).toBe(t('cmd.remise-impossible'))
    expect(container.querySelector('.cb-clip-note')?.className).toContain('problem')
    expect(warn).toHaveBeenCalledWith('[command bar] the page could not be put back in the history:', 'refused')
    // The list is not read again as if the page were back.
    expect(searchHistory).not.toHaveBeenCalled()
  })

  it('says so too when the request fails, and writes the name of the error only', async () => {
    putBackHistory.mockRejectedValue(new TypeError('https://exemple.org/beta could not be put back'))
    const container = await forgotten()
    key(field(container), 'z', false, true)
    await settle()
    expect(said(container)).toBe(t('cmd.remise-impossible'))
    expect(warn).toHaveBeenCalledWith('[command bar] the page could not be put back in the history:', 'TypeError')
  })

  it('is offered in the mini window too', async () => {
    const container = await bar(snapshot(), true)
    type(field(container), 'exemple')
    await answered()
    const lines = [...container.querySelectorAll('li[role="option"]')]
    const at = lines.findIndex((line) => line.querySelector('.label')?.textContent === 'Exemple beta')
    expect(at).toBeGreaterThanOrEqual(0)
    for (let i = 0; i < at; i++) key(field(container), 'ArrowDown')
    if (at === 0) {
      key(field(container), 'ArrowDown')
      key(field(container), 'ArrowUp')
    }
    key(field(container), 'Backspace', true)
    await settle()
    expect(forgetHistory.mock.calls).toEqual([['https://exemple.org/beta', 'default', true]])
    await click(button(undoRow(container)!, t('cmd.annuler')))
    expect(putBackHistory.mock.calls).toEqual([['https://exemple.org/beta', 'default']])
  })
})

describe('a history that cannot be read', () => {
  it('is said in the bar and in the console, and leaves no line of another text', async () => {
    const container = await historyLines()
    searchHistory.mockRejectedValue(new RangeError('exempl: the database is closed'))
    type(field(container), 'exempl')
    await answered()
    expect(said(container)).toBe(t('cmd.historique-illisible'))
    expect(container.querySelectorAll('li[role="option"]')).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith('[command bar] the history could not be read:', 'RangeError')
  })

  it('is said in the mini window too, which has no buttons of the clipboard to say it', async () => {
    searchHistory.mockRejectedValue(new Error('closed'))
    const container = await bar(snapshot(), true)
    type(field(container), 'exemple')
    await answered()
    expect([...container.querySelectorAll('[role="status"]')].map((one) => one.textContent)).toContain(t('cmd.historique-illisible'))
  })
})

describe('suggestions that cannot be asked for', () => {
  it('are written to the console, by the name of the error only', async () => {
    const container = await bar()
    ;(window as unknown as { lucium: LuciumApi }).lucium.suggest = () => Promise.reject(new SyntaxError('recette de tarte: no answer'))
    type(field(container), 'recette de tarte')
    await settle(() => new Promise((resolve) => setTimeout(resolve, 220)))
    expect(warn).toHaveBeenCalledWith('[command bar] the suggestions could not be asked for:', 'SyntaxError')
  })
})

describe('the notices of the bar', () => {
  it('are a sentence for a problem and for what was done, a word for a copy or a paste', () => {
    expect(barNoticeText(null)).toBe('')
    expect(barNoticeText({ kind: 'told', message: 'Page oubliée.' })).toBe('Page oubliée.')
    expect(barNoticeText({ kind: 'problem', message: 'Impossible.' })).toBe('Impossible.')
    expect(barNoticeText({ kind: 'copied' })).toBe(t('cmd.copie'))
  })
})

describe('the space of a tab in the list', () => {
  it('is named by the space the tab lives in, even when two spaces wear the same emoji, and the name is read (not the emoji alone)', async () => {
    const shown = snapshot((state) => {
      const first = state.spaces[0]!
      const second = { ...first, id: 'second', name: 'Travail', emoji: first.emoji }
      const tab = { id: 't1', spaceId: 'second', url: 'https://exemple.org/alpha', title: 'Exemple alpha', pinned: false, createdAt: 1, lastActiveAt: 1 } as never
      return { ...state, spaces: [{ ...first, name: 'Perso' }, second], tabs: [tab] }
    })
    searchHistory.mockResolvedValue([])
    const container = await bar(shown)
    type(field(container), 'exemple')
    await answered()
    const where = container.querySelector('li[role="option"] .where')
    expect(where?.getAttribute('title')).toBe('Travail')
    expect(where?.querySelector('[aria-hidden="true"]')?.textContent).toBe(shown.state.spaces[0]!.emoji)
    expect(where?.querySelector('.cb-count')?.textContent).toBe('Travail')
  })
})
