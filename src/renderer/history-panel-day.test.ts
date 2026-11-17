// @vitest-environment happy-dom
// The history panel, mounted. It loads the newest pages only, so « Oublier ce jour » is asked of the main process, which forgets the day over the
// whole history of the profile (the rows on screen can be a part of it); during a search the day shows the pages found, and only those go. A
// list cut at its limit says so.

import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dayBounds, dayKey } from '@shared/history-days'
import { t } from '@shared/i18n'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import type { HistoryEntry } from '@shared/model'
import { activeProfileId } from '@shared/profiles'
import { createInitialState } from '@shared/sidebar'
import { HistoryPanel } from './ManagePanels'
import { button, click, mount, settle, type, type Mounted } from './dom.test-support'

const state = createInitialState({ now: 0, newId: () => 'x' })
const profileId = activeProfileId(state)
const NOW = Date.now()
const page = (name: string, lastVisitAt: number): HistoryEntry => ({ url: `https://${name}.example/`, title: name, visitCount: 1, lastVisitAt })
const TODAY = [page('alpha', NOW), page('beta', NOW)]
const EARLIER = page('gamma', NOW - 3 * 86_400_000)

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

let mounted: Mounted | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

async function panel(found: HistoryEntry[]) {
  const forgetHistory = vi.fn(async () => undefined)
  const forgetHistoryDay = vi.fn(async () => found.length)
  const searchHistory = vi.fn(async (query: string) => (query === '' ? found : found.filter((entry) => entry.title.includes(query))))
  const bridge: Partial<LuciumApi> = { getSnapshot: async () => ({ state }) as unknown as UiSnapshot, onSnapshot: () => () => undefined, searchHistory, forgetHistory, forgetHistoryDay, closeOverlay: () => undefined }
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = bridge
  mounted = mount(createElement(HistoryPanel))
  // The first state (the list is drawn once it has arrived), then the search the list starts a moment after it opens.
  await settle()
  await settle(() => wait(200))
  return { container: mounted.container, forgetHistory, forgetHistoryDay, searchHistory }
}

/** Leaving the panel makes what was waiting for its eight seconds. */
const leave = (): Promise<void> =>
  settle(() => {
    mounted?.unmount()
    mounted = null
  })

describe('« Oublier ce jour »', () => {
  it('asks the main process to forget the whole day, by its bounds and in the profile listed, not the rows on screen one by one', async () => {
    const { container, forgetHistory, forgetHistoryDay } = await panel([...TODAY, EARLIER])
    await click(button(container, t('history-days.oublier-ce-jour')))
    // The time to take it back has only started.
    expect(forgetHistoryDay).not.toHaveBeenCalled()
    await leave()
    const { from, to } = dayBounds(dayKey(NOW))!
    expect(forgetHistoryDay).toHaveBeenCalledTimes(1)
    expect(forgetHistoryDay).toHaveBeenCalledWith(from, to, profileId)
    expect(forgetHistory).not.toHaveBeenCalled()
  })

  it('reads the list again once the day is forgotten: what the main process still holds is what is shown', async () => {
    const { container, searchHistory } = await panel([...TODAY, EARLIER])
    const asked = searchHistory.mock.calls.length
    await click(button(container, t('history-days.oublier-ce-jour')))
    await leave()
    expect(searchHistory.mock.calls.length).toBe(asked + 1)
  })

  it('forgets only the pages found, one by one, while a search is under way', async () => {
    const { container, forgetHistory, forgetHistoryDay } = await panel([...TODAY, EARLIER])
    type(container.querySelector<HTMLInputElement>('input')!, 'alpha')
    await settle(() => wait(200))
    // A search lists every day; the day of the page found is picked.
    await click(container.querySelector('.hist-days button')!)
    await click(button(container, t('history-days.oublier-ce-jour')))
    await leave()
    expect(forgetHistoryDay).not.toHaveBeenCalled()
    expect(forgetHistory.mock.calls).toEqual([[TODAY[0]!.url, profileId]])
  })
})

describe('a history longer than the panel loads', () => {
  const many = (count: number): HistoryEntry[] => Array.from({ length: count }, (_, index) => page(`p${index}`, NOW - index))
  // Read once the panel is drawn: the panel sets the language of the interface.
  const notice = (): string => t('history-days.liste-coupee', { count: 500 })

  it('says that only the newest pages are shown', async () => {
    const { container } = await panel(many(500))
    expect([...container.querySelectorAll('.tk-status')].map((one) => one.textContent)).toContain(notice())
  })

  it('says nothing of the kind when everything is there', async () => {
    const { container } = await panel(many(499))
    expect([...container.querySelectorAll('.tk-status')].map((one) => one.textContent)).not.toContain(notice())
  })
})
