// « Arrêter la capture du son » in the menu of a tab an extension captures the sound of (context-menu-tab.ts): there for that tab only, and it stops the capture.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { createInitialState, reduce } from '@shared/sidebar'
import { fakeBrowser } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  // `has`: the module mock refuses a name it is not given unless it says it has it (the menu icons ask for `nativeImage`).
  return new Proxy({} as Record<string, unknown>, { has: (_t, prop) => !inert(prop), get: (_t, prop: string) => (inert(prop) ? undefined : stub) })
})

const { captureMenuItems, tabMenuItems } = await import('./context-menu-tab')

beforeEach(() => {
  setLanguage('fr')
  // The icons of the entries are made of the real `nativeImage`, which this stand-in has not: each entry then says so in the console and goes without.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  setLanguage('fr')
  vi.restoreAllMocks()
})

describe('the entry of the menu', () => {
  it('is there for a tab an extension captures the sound of, and a click stops the capture', () => {
    const stop = vi.fn()
    const items = captureMenuItems('Captions', stop)
    expect(items.map((item) => item.label)).toEqual(['Arrêter la capture du son'])
    items[0]!.click!({} as never, undefined, {} as never)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('is not there for any other tab', () => {
    expect(captureMenuItems(undefined, vi.fn())).toEqual([])
  })

  it('is written in English when the language is English', () => {
    setLanguage('en')
    expect(captureMenuItems('Captions', vi.fn()).map((item) => item.label)).toEqual(['Stop capturing the sound'])
  })
})

describe('the menu of a tab of the sidebar', () => {
  const state = reduce(createInitialState({ now: 1, newId: () => 'x' }), { type: 'tab/open', url: 'https://meet.example.com/abc' }, { now: 1, newId: () => 'tab-1' })
  const tab = state.tabs[0]!

  function menuOf(info: Record<string, unknown>) {
    const stopped: string[] = []
    const browser = fakeBrowser({
      snapshot: () => ({ runtime: { tabs: { [tab.id]: { loading: false, audible: true, muted: false, awake: true, ...info } } } }),
      livePageIds: () => [tab.id],
      sleepStateOf: () => 'awake',
      isShown: () => false,
      isPrivate: () => false,
      windowMoveChoices: () => [],
      stopTabCapture: (id: string) => void stopped.push(id)
    })
    const items = tabMenuItems({ kind: 'tab', id: tab.id } as never, browser.self as never, { get: () => state } as never, {} as never, { headers: false })
    return { labels: items.map((item) => item.label), items, stopped }
  }

  it('offers « Arrêter la capture du son » next to « Couper le son » while an extension captures the tab, and stops that tab', () => {
    const { items, labels, stopped } = menuOf({ capturedBy: 'Captions' })
    const at = labels.indexOf('Arrêter la capture du son')
    expect(at).toBeGreaterThan(-1)
    expect(labels[at - 1]).toBe('Couper le son')
    items[at]!.click!({} as never, undefined, {} as never)
    expect(stopped).toEqual([tab.id])
  })

  it('does not offer it for a tab nobody captures', () => {
    expect(menuOf({}).labels).not.toContain('Arrêter la capture du son')
  })
})
