// @vitest-environment happy-dom
// « Effacer une période… » in the history panel, mounted: the span is named by a word (the main process works its bounds out), the pages of the span go
// from the list at once and come back together within the undo time, a failure is said, and the list is read again.

import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HISTORY_RANGES } from '@shared/history-range'
import { t } from '@shared/i18n'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import type { HistoryEntry } from '@shared/model'
import { activeProfileId } from '@shared/profiles'
import { createInitialState } from '@shared/sidebar'
import { HistoryPanel } from './ManagePanels'
import { click, mount, settle, type Mounted } from './dom.test-support'

const state = createInitialState({ now: 0, newId: () => 'x' })
const profileId = activeProfileId(state)
const NOW = Date.now()
const page = (name: string, lastVisitAt: number): HistoryEntry => ({ url: `https://${name}.example/`, title: name, visitCount: 1, lastVisitAt })
const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

let mounted: Mounted | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

async function panel(found: HistoryEntry[], forgetHistoryRange = vi.fn(async (..._args: unknown[]) => found.length)) {
  const searchHistory = vi.fn(async () => found)
  const bridge: Partial<LuciumApi> = { getSnapshot: async () => ({ state }) as unknown as UiSnapshot, onSnapshot: () => () => undefined, searchHistory, forgetHistoryRange: forgetHistoryRange as never, closeOverlay: () => undefined }
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = bridge
  mounted = mount(createElement(HistoryPanel))
  await settle()
  await settle(() => wait(200))
  const container = mounted.container
  const menu = container.querySelector<HTMLSelectElement>('select')!
  const pick = (range: string) =>
    settle(() => {
      menu.value = range
      menu.dispatchEvent(new Event('change', { bubbles: true }))
    })
  return { container, menu, pick, forgetHistoryRange, searchHistory }
}

const leave = (): Promise<void> =>
  settle(() => {
    mounted?.unmount()
    mounted = null
  })
const rows = (container: Element): string[] => [...container.querySelectorAll('.hist-pages .lp-main')].map((one) => one.textContent ?? '')

describe('« Effacer une période… »', () => {
  it('offers the five spans, named in words', async () => {
    const { menu } = await panel([page('alpha', NOW)])
    expect([...menu.options].map((option) => option.value)).toEqual(['', ...HISTORY_RANGES])
  })

  it('asks the main process by the word of the span, in the profile listed, once the undo time is over, and not before', async () => {
    const { pick, forgetHistoryRange } = await panel([page('alpha', NOW)])
    await pick('week')
    expect(forgetHistoryRange).not.toHaveBeenCalled()
    await leave()
    expect(forgetHistoryRange).toHaveBeenCalledTimes(1)
    expect(forgetHistoryRange).toHaveBeenCalledWith('week', profileId)
  })

  it('takes the pages of the span out of the list at once, and leaves the older ones', async () => {
    const { container, pick } = await panel([page('alpha', NOW), page('gamma', NOW - 10 * 86_400_000)])
    await click(container.querySelector('.hist-days button')!)
    expect(rows(container).join(' ')).toContain('alpha')
    await pick('week')
    expect(rows(container).join(' ')).not.toContain('alpha')
    await pick('all')
    expect(rows(container).join(' ')).not.toContain('gamma')
  })

  it('says so, logs it and reads the list again when the span could not be forgotten', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { container, pick, searchHistory } = await panel([page('alpha', NOW)], vi.fn(async () => Promise.reject(new Error('disk'))))
    const asked = searchHistory.mock.calls.length
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await pick('hour')
      expect(container.querySelector('[role="alert"]')).toBeNull()
      await settle(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })
    } finally {
      vi.useRealTimers()
    }
    await settle()
    expect(warn).toHaveBeenCalledWith('[history] the period could not be forgotten:', expect.any(Error))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(t('history-days.periode-echec'))
    expect(searchHistory.mock.calls.length).toBe(asked + 1)
    warn.mockRestore()
  })
})
