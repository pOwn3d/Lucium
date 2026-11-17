// "Ranger les onglets…" shows one notice for the whole job with one "Annuler", the panel is a modal panel of the overlay, and the panel's request is the
// one the main process validates. The rules themselves are tested in src/shared/tab-grouping.test.ts and src/shared/folder-sides.test.ts, the panel's
// markup in src/renderer/tidy-panel.test.ts.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { tidyNotice } from '@shared/tab-grouping'
import type { SidebarState } from '@shared/model'
import { fakeBrowser, methodsOf } from './shell/browser-fake.test-support'

// The shell reaches Electron only when a method runs: `Browser.dispatch` runs here on a stand-in (browser-fake.test-support.ts) over the real reducer.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./shell/browser')
const shell = methodsOf(Browser.prototype)

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

describe('the notice that follows "Ranger les onglets…"', () => {
  it('is shown once, from the states before and after, and its "Annuler" dispatches the undo the outcome carries', () => {
    let n = 0
    const ctx = { now: 0, newId: () => `id${++n}` }
    const base = createInitialState(ctx)
    const spaceId = base.activeSpaceId
    const tab = (id: string) => ({ id, spaceId, url: `https://github.com/${id}`, title: id, pinned: false, createdAt: 0, lastActiveAt: 0 })
    let state: SidebarState = { ...base, tabs: [tab('a'), tab('b')] }
    const toasts: Array<{ message: string; action?: { label: string; run: () => void } }> = []
    const own: Record<string, unknown> = {
      // One window: the store is its own root (main/store.ts).
      store: { get: () => state, dispatch: (action: Action) => void (state = reduce(state, action, ctx)), root() { return this } },
      pages: new Map(),
      showToast: (message: string, action?: { label: string; run: () => void }) => void toasts.push({ message, ...(action ? { action } : {}) })
    }
    const fake = fakeBrowser(own)
    own['dispatch'] = (action: Action) => shell['dispatch']!.call(fake.self, action)
    shell['dispatch']!.call(fake.self, { type: 'tabs/tidy', groups: [{ name: 'GitHub', tabIds: ['a', 'b'] }] })
    expect(state.folders).toHaveLength(1)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.message).toBe(tidyNotice({ created: 1, extended: 0 }))
    expect(toasts[0]!.action?.label).toBe(t('menu.annuler'))
    toasts[0]!.action!.run()
    expect(state.folders).toHaveLength(0)
    expect(state.tabs.filter((t) => t.pinned)).toEqual([])
    // The undo itself is not a tidy: no second notice.
    expect(toasts).toHaveLength(1)
  })
})

// Contract: the overlay host and the sidebar are React trees wired to the events of a real window (no DOM runs in the unit tests); these lines are
// what makes the panel modal and what opens it from the Today header.
describe('the panel in the overlay', () => {
  const host = read('../renderer/OverlayHost.tsx')

  it('is a modal panel (dimmed, closed by a click outside) and draws TidyPanel for its request', () => {
    expect(host).toMatch(/const MODAL = new Set<OverlayRequest\['panel'\]>\(\[[^\]]*'tidy'[^\]]*\]\)/)
    expect(host).toMatch(/case 'tidy':\s*return <TidyPanel key=\{version\} spaceId=\{request\.spaceId\} \/>/)
  })

  it('is opened from the Today header with the space on screen', () => {
    expect(read('../renderer/Sidebar.tsx')).toMatch(/act\.openOverlay\(\{ panel: 'tidy', spaceId: space\.id \}\)/)
  })
})
