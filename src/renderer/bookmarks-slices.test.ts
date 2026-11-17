// @vitest-environment happy-dom
// The Signets panel over a large library, mounted in a document: the list is drawn by slices. The library holds up to 5 000 bookmarks; drawn
// whole, the panel was slow to open and the search stuttered.

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import type { Bookmark } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { t } from '@shared/i18n'
import { BOOKMARKS_SHOWN_STEP, Bookmarks } from './Bookmarks'
import { click, mount, settle, type, type Mounted } from './dom.test-support'

let mounted: Mounted | null = null

const library = (count: number): Bookmark[] =>
  Array.from({ length: count }, (_, index) => ({ id: `b${index}`, url: `https://example.org/${index}`, title: index % 2 === 0 ? `Pair ${index}` : `Impair ${index}`, tags: [], addedAt: 1 }))

async function panel(count: number): Promise<HTMLElement> {
  const state = { ...createInitialState({ now: 1, newId: () => 'id' }), bookmarks: library(count) }
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = {
    getSnapshot: async () => ({ state, extensions: [], downloads: [] }) as unknown as UiSnapshot,
    onSnapshot: () => () => undefined,
    dispatch: vi.fn(async () => undefined) as never,
    closeOverlay: vi.fn() as never
  }
  mounted = mount(createElement(Bookmarks))
  await settle()
  return mounted.container
}
const rows = (container: Element): number => container.querySelectorAll('.bookmark-row').length
const more = (container: Element): HTMLButtonElement | null => container.querySelector('button[data-action="show-more"]')
const count = (container: Element): string | null => container.querySelector('[data-role="shown-count"]')?.textContent ?? null

beforeEach(() => {
  expect(BOOKMARKS_SHOWN_STEP).toBe(200)
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('the list of a large library of bookmarks', () => {
  it('draws the first slice only, says how many there are, and draws the next slice when asked', async () => {
    const container = await panel(450)
    expect(rows(container)).toBe(200)
    expect(count(container)).toBe(t('bookmarks.premiers-affiches', { shown: 200, total: 450 }))
    await click(more(container)!)
    expect(rows(container)).toBe(400)
    expect(count(container)).toBe(t('bookmarks.premiers-affiches', { shown: 400, total: 450 }))
    await click(more(container)!)
    expect(rows(container)).toBe(450)
    // Everything is drawn: nothing more to ask for, nothing more to say.
    expect(more(container)).toBeNull()
    expect(count(container)).toBeNull()
  })

  it('draws a library that fits in one slice whole, with nothing to ask for', async () => {
    const container = await panel(200)
    expect(rows(container)).toBe(200)
    expect(more(container)).toBeNull()
  })

  it('searches the whole library, not the slice drawn, and starts each search again from the first slice', async () => {
    const container = await panel(900)
    await click(more(container)!)
    expect(rows(container)).toBe(400)
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
    // The last bookmark is far beyond what is drawn.
    type(search, 'Impair 899')
    expect(rows(container)).toBe(1)
    expect(container.querySelector('.bookmark-title')!.textContent).toBe('Impair 899')
    // 450 bookmarks match: the first slice again, although two slices were drawn before the search.
    type(search, 'Impair')
    expect(rows(container)).toBe(200)
    expect(count(container)).toBe(t('bookmarks.premiers-affiches', { shown: 200, total: 450 }))
    expect(container.querySelector('.lp-count')!.textContent).toBe('450 / 900')
  })
})
