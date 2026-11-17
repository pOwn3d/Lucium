// The delay before an automatic reload is shown, and the reload can be stopped without the right-click menu:
// the mark counts down by itself between two publications, and is the button that stops the reloading. Without a window: the hooks are stubbed so that the
// component can be called as a function, its effect run by hand, and its element tree read.

import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'

const hooks = vi.hoisted(() => ({ effect: null as null | (() => void | (() => void)), tick: vi.fn(), dispatch: vi.fn() }))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => [initial, hooks.tick],
  useEffect: (run: () => void | (() => void)) => {
    hooks.effect = run
  }
}))
vi.mock('./api', () => ({ api: () => ({ dispatch: hooks.dispatch }) }))
vi.mock('./auto-reload.css', () => ({}))

import { AutoReloadMark } from './AutoReloadMark'
import { frenchSpaces } from '@shared/french-typography'

const NOW = 1_000_000
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  hooks.effect = null
  hooks.tick.mockClear()
  hooks.dispatch.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
  setLanguage('fr')
})

const mark = (reloadAt?: number): ReactElement => AutoReloadMark({ tabId: 't1', autoReload: { seconds: 30 }, reloadAt })
const html = (reloadAt?: number): string => renderToStaticMarkup(mark(reloadAt))

describe('the mark of a tab that reloads itself', () => {
  it('shows the time left, and says it in the tooltip with the interval', () => {
    const markup = html(NOW + 12_000)
    expect(markup).toContain(frenchSpaces('<span class="auto-reload-left">12 s</span>'))
    expect(markup).toContain(frenchSpaces('title="Rechargement dans 12 s (toutes les 30 s)\nArrêter le rechargement automatique"'))
    expect(html(NOW + 65_000)).toContain('>1:05<')
  })

  it('shows no number when there is no countdown to count (page asleep) or when it has run out (a page that waits for its turn)', () => {
    for (const markup of [html(undefined), html(NOW - 1_000)]) {
      expect(markup).not.toContain('auto-reload-left')
      expect(markup).toContain(frenchSpaces('title="Recharge toutes les 30 s\nArrêter'))
    }
  })

  it('is the button that stops the reloading of its own tab, without clicking the row under it', () => {
    const element = mark(NOW + 5000)
    const stopPropagation = vi.fn()
    expect(element.type).toBe('button')
    expect((element.props as { 'aria-label': string })['aria-label']).toBe('Arrêter le rechargement automatique')
    ;(element.props as { onClick: (e: unknown) => void }).onClick({ stopPropagation })
    expect(hooks.dispatch).toHaveBeenCalledWith({ type: 'tab/auto-reload', id: 't1', seconds: null })
    expect(stopPropagation).toHaveBeenCalled()
  })

  it('has a timer only while a countdown runs: ticks on the second, stops with the countdown and with the mark, and none at all without a countdown', () => {
    mark(undefined)
    expect(hooks.effect?.()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)

    mark(NOW + 2500)
    const cleanup = hooks.effect?.() as () => void
    expect(vi.getTimerCount()).toBe(1)
    hooks.tick.mockClear()
    vi.advanceTimersByTime(500)
    expect(hooks.tick).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(hooks.tick).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1000)
    // The countdown has ended: the timer does not go on.
    expect(vi.getTimerCount()).toBe(0)

    mark(Date.now() + 60_000)
    const again = hooks.effect?.() as () => void
    expect(vi.getTimerCount()).toBe(1)
    again()
    expect(vi.getTimerCount()).toBe(0)
    cleanup()
  })
})
