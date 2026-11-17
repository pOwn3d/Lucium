// Affichage › the sidebar of this window: « Replier la barre dans cette fenêtre » (⌃⌘S) and « Barre à droite dans cette fenêtre », ticked as the window is,
// and « Pour les nouvelles fenêtres », the setting. The menu is the real one, with Electron's `Menu` replaced by a function that hands the template back.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import type { WindowSidebar } from '@shared/window-sidebar'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

// The menu of macOS on any machine, and of another system when a test asks (the shortcuts differ: shared/platform.ts, NON_MAC_DEFAULTS).
vi.mock('../platform', async (original) => (await import('../platform/platform.test-support')).playedPlatform(await original()))

import { buildMenu } from './menu'
import { played, resetPlayedPlatform } from '../platform/platform.test-support'

afterEach(resetPlayedPlatform)

interface Item {
  label?: string
  type?: string
  checked?: boolean
  accelerator?: string
  click?: () => void
  submenu?: Item[]
}

const ctx = { now: 1_000, newId: ((n) => () => `id${++n}`)(0) }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** The View menu of a window whose own choice is `own`, the setting patched with `patch`; what its entries ask of the browser is recorded. */
function view(own: WindowSidebar, patch: Partial<SidebarState['settings']> = {}) {
  const state = run(createInitialState(ctx), { type: 'settings/update', patch })
  const dispatched: Action[] = []
  const changes: unknown[] = []
  const browser = new Proxy(
    {
      dispatch: (action: Action) => void dispatched.push(action),
      windowSidebar: () => own,
      changeWindowSidebar: (change: unknown) => void changes.push(change),
      menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false, sound: 'silent' })
    } as Record<string, unknown>,
    { get: (target, prop: string) => (prop in target ? target[prop] : () => false) }
  )
  const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
  const store = { get: () => state } as unknown as Parameters<typeof buildMenu>[1]
  const menus = buildMenu(browser as never, store, actions as never) as unknown as Item[]
  const items = menus.find((m) => m.label === 'Affichage')!.submenu!
  const entry = (label: string): Item => {
    const found = items.find((item) => item.label === label)
    if (!found) throw new Error(`no entry « ${label} » in View: ${items.map((i) => i.label).join(' | ')}`)
    return found
  }
  return { items, entry, dispatched, changes }
}

describe('View › the sidebar of this window', () => {
  it('comes right after « Masquer la barre latérale », with ⌃⌘S on « Replier la barre dans cette fenêtre »', () => {
    const { items } = view({})
    const at = items.findIndex((item) => item.label === 'Masquer la barre latérale')
    expect(items.slice(at, at + 4).map((item) => item.label)).toEqual(['Masquer la barre latérale', 'Replier la barre dans cette fenêtre', 'Barre à droite dans cette fenêtre', 'Pour les nouvelles fenêtres'])
    expect(view({}).entry('Replier la barre dans cette fenêtre')).toMatchObject({ type: 'checkbox', accelerator: 'Ctrl+CmdOrCtrl+S' })
  })

  it('keeps the entry without a shortcut where ⌃⌘S would be Ctrl+S twice over (Linux, Windows)', () => {
    for (const id of ['linux', 'win32'] as const) {
      played.id = id
      const docked = view({}).entry('Replier la barre dans cette fenêtre')
      expect(docked.type, id).toBe('checkbox')
      expect(docked.accelerator, id).toBeUndefined()
    }
  })

  it('ticks the two entries as the window is: docked (and shown), at the right by its own choice or by the setting', () => {
    const ticks = (own: WindowSidebar, patch: Partial<SidebarState['settings']> = {}) => {
      const { entry } = view(own, patch)
      return [entry('Replier la barre dans cette fenêtre').checked, entry('Barre à droite dans cette fenêtre').checked]
    }
    expect(ticks({})).toEqual([false, false])
    expect(ticks({ docked: true })).toEqual([true, false])
    expect(ticks({ docked: true }, { sidebarVisible: false })).toEqual([false, false])
    expect(ticks({}, { sidebarRight: true })).toEqual([false, true])
    expect(ticks({ side: 'left' }, { sidebarRight: true })).toEqual([false, false])
    expect(ticks({ side: 'right', docked: true })).toEqual([true, true])
  })

  it('changes this window only: the entries ask the browser of the window, and what is on screen decides when they are clicked', () => {
    const { entry, changes, dispatched } = view({})
    entry('Replier la barre dans cette fenêtre').click!()
    entry('Barre à droite dans cette fenêtre').click!()
    expect(changes).toEqual([{ op: 'toggle-dock' }, { op: 'toggle-side' }])
    expect(dispatched).toEqual([])
  })

  it('offers the side of the new windows (the setting), ticked as it is', () => {
    const left = view({ side: 'right' }).entry('Pour les nouvelles fenêtres').submenu!
    expect(left.map((item) => [item.label, item.type, item.checked])).toEqual([['Barre à gauche', 'radio', true], ['Barre à droite', 'radio', false]])
    const { entry, dispatched, changes } = view({}, { sidebarRight: true })
    const submenu = entry('Pour les nouvelles fenêtres').submenu!
    expect(submenu.map((item) => item.checked)).toEqual([false, true])
    submenu[0]!.click!()
    expect(dispatched).toEqual([{ type: 'settings/update', patch: { sidebarRight: false } }])
    expect(changes).toEqual([])
  })
})
