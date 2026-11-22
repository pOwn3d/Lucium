// @vitest-environment happy-dom
// The command bar mounted, narrowed to bookmarks or history by `*`, `^` and the words `@bookmarks` and `@history`: the lines drawn, the limits, and what
// Enter does when the genre finds nothing. An ordinary search that merely starts with `*` or `^` is not a genre.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import type { HistoryEntry } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { CommandBar } from './CommandBar'
import { mount, settle, type, type Mounted } from './dom.test-support'
import { act } from 'react'

const MARKS = Array.from({ length: 13 }, (_, i) => ({ id: `b${i}`, url: `https://m${i}.test/`, title: `Signet ${i}`, tags: [], addedAt: i }))
const PAGES: HistoryEntry[] = Array.from({ length: 10 }, (_, i) => ({ url: `https://h${i}.test/`, title: `Page ${i}`, lastVisitAt: 100 - i, visitCount: 1 }))

let mounted: Mounted | null = null
let submitUrl: ReturnType<typeof vi.fn>

function snapshot(siteSearches: Array<{ keyword: string; name: string; url: string }> = []): UiSnapshot {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  const shown = { ...state, bookmarks: MARKS, settings: { ...state.settings, bookmarkManager: true, siteSearches: [...state.settings.siteSearches, ...siteSearches] } }
  return { state: shown, runtime: { tabs: {} }, extensions: [], downloads: [], windows: [], platform: 'darwin' } as unknown as UiSnapshot
}

async function bar(shown: UiSnapshot = snapshot()): Promise<HTMLElement> {
  const own: Partial<LuciumApi> = { getSnapshot: async () => shown, searchHistory: (async () => PAGES) as never, submitUrl: submitUrl as never, suggest: async () => [] }
  ;(window as unknown as { lucium: unknown }).lucium = new Proxy(own, { get: (target, name: string) => (target as Record<string, unknown>)[name] ?? (name.startsWith('on') ? () => () => undefined : () => Promise.resolve(undefined)) })
  mounted = mount(createElement(CommandBar, { mode: 'current', initial: '' }))
  await settle()
  return mounted.container
}

const field = (c: Element): HTMLInputElement => c.querySelector<HTMLInputElement>('input[role="combobox"]')!
const rows = (c: Element): Element[] => [...c.querySelectorAll('li[role="option"]')]
const said = async (c: Element, text: string): Promise<void> => {
  type(field(c), text)
  await settle(() => new Promise((resolve) => setTimeout(resolve, 250)))
}
const enter = async (c: Element): Promise<void> => {
  await settle(() => void act(() => void field(c).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))))
}

beforeEach(() => {
  setLanguage('fr')
  submitUrl = vi.fn()
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('`*` and `^` narrow the bar to a genre', () => {
  it('lists 12 of the 13 bookmarks for `*` alone, not the four of the mixed list', async () => {
    const c = await bar()
    await said(c, '*')
    expect(rows(c)).toHaveLength(12)
  })

  it('lists only bookmarks for `* mot`, even when a page of the history answers too', async () => {
    const c = await bar()
    await said(c, '* Signet 3')
    const list = rows(c)
    expect(list.length).toBeGreaterThan(0)
    expect(list.every((row) => row.textContent?.includes('Signet'))).toBe(true)
    expect(c.textContent).not.toContain('Page 0')
  })

  it('lists the 8 recent pages for `^` alone', async () => {
    const c = await bar()
    await said(c, '^')
    expect(rows(c)).toHaveLength(8)
  })

  it('names the bookmarks button for a screen reader without its `*` mark', async () => {
    const c = await bar()
    const mark = [...c.querySelectorAll('.cb-genres button')].find((b) => b.textContent?.includes(t('cmd.filtre-signets')))!
    expect(mark.querySelector('kbd')?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('an ordinary search that starts with `*` or `^` stays a search', () => {
  it.each([
    ['*.example.com', 'https://*.example.com'],
    ['^2', 'https://duckduckgo.com/?q=%5E2'],
    ['*foo', 'https://duckduckgo.com/?q=*foo']
  ])('opens %s as before (%s) with Enter', async (typed, opened) => {
    const c = await bar()
    await said(c, typed)
    expect(c.querySelector('.cb-genres [aria-pressed="true"]')).toBeNull()
    await enter(c)
    expect(submitUrl).toHaveBeenCalledWith(opened, 'current')
  })

  it('lets a site search keyword `^` come before the genre', async () => {
    const c = await bar(snapshot([{ keyword: '^', name: 'Caret', url: 'https://caret.test/?q=%s' }]))
    await said(c, '^ mot')
    expect(c.querySelector('.cb-genres [aria-pressed="true"]')).toBeNull()
  })

  it('searches as typed with Enter when the genre finds nothing', async () => {
    const c = await bar()
    await said(c, '* zzzzqx')
    expect(rows(c)).toHaveLength(0)
    await enter(c)
    expect(submitUrl).toHaveBeenCalledWith('* zzzzqx', 'current')
  })
})
