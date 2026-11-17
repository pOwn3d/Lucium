// The sweep of the folders of deleted containers at launch, as the window runs it (the real method of the class Browser on a stand-in): a folder
// that a copy of the state made before Help › Restore Data still names is left alone. The rule itself: shared/containers.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const DAY = 24 * 3_600_000

function windowWith(stored: string[], named: string[], idle: Record<string, number | null> = {}, failing: string[] = []) {
  const state = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), tabContainers: true, containers: [{ id: named[0]!, name: 'Travail', color: 'blue', permissions: {} }] } }
  const removed: string[][] = []
  const engine = { storedContainerIds: () => stored, storedContainerIdleMs: (id: string) => idle[id] ?? null, removeStoredContainers: (ids: string[]) => (removed.push(ids), failing) }
  const fake = fakeBrowser({ store: { get: () => state }, engine, isPrivate: () => false, isSecondary: () => false })
  return { removed, sweep: (...args: unknown[]) => shell['sweepStoredContainers']!.call(fake.self, ...args) }
}

describe('the sweep of the stored containers at launch', () => {
  it('removes the folder the state no longer names, and not the one a copy made before a restoration names', () => {
    const { removed, sweep } = windowWith(['travail-3fa9c', 'apres-export-11111', 'vieux-00000'], ['travail-3fa9c'])
    expect(sweep(true, () => new Set(['apres-export-11111']))).toEqual(['vieux-00000'])
    expect(removed).toEqual([['vieux-00000']])
  })

  it('removes nothing when the copies cannot be read', () => {
    const { removed, sweep } = windowWith(['travail-3fa9c', 'vieux-00000'], ['travail-3fa9c'])
    expect(sweep(true, () => null)).toEqual([])
    expect(removed).toEqual([])
  })

  describe('a folder kept for a copy of the state', () => {
    afterEach(() => void vi.restoreAllMocks())

    it('is removed once nothing was written in it for thirty days, with a line in the journal that names it and its age; a younger one stays', () => {
      const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      const { removed, sweep } = windowWith(['travail-3fa9c', 'apres-export-11111', 'recent-22222', 'vieux-00000'], ['travail-3fa9c'], { 'apres-export-11111': 45 * DAY, 'recent-22222': 29 * DAY, 'vieux-00000': 1 * DAY, 'travail-3fa9c': 400 * DAY })
      expect(sweep(true, () => new Set(['apres-export-11111', 'recent-22222']))).toEqual(['vieux-00000', 'apres-export-11111'])
      expect(removed).toEqual([['vieux-00000', 'apres-export-11111']])
      const lines = logged.mock.calls.map((call) => String(call[0]))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('apres-export-11111')
      expect(lines[0]).toContain('45 days')
    })

    it('is removed after thirty days when the copies cannot be read either, and kept when its age is unknown', () => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined)
      const { removed, sweep } = windowWith(['travail-3fa9c', 'vieux-00000', 'inconnu-33333'], ['travail-3fa9c'], { 'vieux-00000': 31 * DAY, 'inconnu-33333': null })
      expect(sweep(true, () => null)).toEqual(['vieux-00000'])
      expect(removed).toEqual([['vieux-00000']])
    })

    it('has no line in the journal when its folder could not be removed, and is not counted as removed', () => {
      const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      const { sweep } = windowWith(['travail-3fa9c', 'vieux-00000'], ['travail-3fa9c'], { 'vieux-00000': 31 * DAY }, ['vieux-00000'])
      expect(sweep(true, () => new Set(['vieux-00000']))).toEqual([])
      expect(logged).not.toHaveBeenCalled()
    })

    it('stays, whatever its age, while the state is not the one the user had', () => {
      const { removed, sweep } = windowWith(['travail-3fa9c', 'vieux-00000'], ['travail-3fa9c'], { 'vieux-00000': 400 * DAY })
      expect(sweep(false, () => new Set())).toEqual([])
      expect(removed).toEqual([])
    })
  })
})
