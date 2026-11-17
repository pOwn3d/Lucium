import { describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import type { OverlayRequest } from '@shared/ipc'
import { NEW_NOTE_REQUEST, NOTES_LIST_REQUEST } from '@shared/notes'

// File › Notes… and File › Nouvelle note, played for real: what a click asks the browser for. File › Notes… must stay the request without a scope (the panel
// then opens on the page's notes when there are some, and the key closes it when it is on screen); the toolbar's « Toutes les notes » is the one that forces
// « Toutes » (menu-greying.test.ts holds the same harness: the menu is the real one, Electron's `Menu` hands the template back).
vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})
vi.mock('../platform', async (original) => (await import('../platform/platform.test-support')).playedPlatform(await original()))

import { buildMenu } from './menu'

interface Item {
  label?: string
  submenu?: Item[]
  click?: () => void
}

function leaves(items: Item[]): Item[] {
  return items.flatMap((item) => (item.submenu ? leaves(item.submenu) : [item]))
}

/** The browser of the menu: it records what is opened and closed, and says which panel is on screen. */
function playedMenu(onScreen: OverlayRequest | null) {
  const opened: OverlayRequest[] = []
  let closed = 0
  const own: Record<string, unknown> = {
    menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }),
    openOverlay: (request: OverlayRequest) => void opened.push(request),
    closeOverlay: () => void closed++,
    currentOverlay: () => onScreen
  }
  const browser = new Proxy(own, { get: (target, prop: string) => (prop in target ? target[prop] : () => false) })
  const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
  const state = createInitialState({ now: 1, newId: () => 'home' })
  const store = { get: () => state } as unknown as Parameters<typeof buildMenu>[1]
  const entry = (label: string): Item => leaves(buildMenu(browser as never, store, actions as never) as unknown as Item[]).find((item) => item.label === label)!
  return { entry, opened, closed: () => closed }
}

describe('File › Notes…', () => {
  it('asks for the panel without a scope: it opens on the page’s notes when there are some, not always on « Toutes »', () => {
    const menu = playedMenu(null)
    menu.entry('Notes…').click!()
    expect(menu.opened).toEqual([{ panel: 'notes' }])
    expect(menu.opened[0]).not.toHaveProperty('scope')
    expect(menu.opened[0]).not.toBe(NOTES_LIST_REQUEST)
  })

  it('closes the panel when it is the one on screen, whatever scope it was opened with', () => {
    for (const onScreen of [{ panel: 'notes' }, NOTES_LIST_REQUEST] satisfies OverlayRequest[]) {
      const menu = playedMenu(onScreen)
      menu.entry('Notes…').click!()
      expect(menu.closed()).toBe(1)
      expect(menu.opened).toEqual([])
    }
  })
})

describe('File › Nouvelle note', () => {
  it('asks for the panel on a new note, without a scope', () => {
    const menu = playedMenu(null)
    menu.entry('Nouvelle note').click!()
    expect(menu.opened).toEqual([{ panel: 'notes', compose: true }])
    expect(menu.opened[0]).toBe(NEW_NOTE_REQUEST)
  })
})
