// Affichage › « Toujours au premier plan »: a checkbox for the window the menu acts on, ticked as the window is, and a click that keeps it in front or lets it go.
// The menu is the real one, with Electron's `Menu` replaced by a function that hands the template back.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

// The menu of macOS on any machine, and of another system when a test asks (the shortcuts differ: shared/platform.ts, NON_MAC_DEFAULTS).
vi.mock('../platform', async (original) => (await import('../platform/platform.test-support')).playedPlatform(await original()))

import { buildMenu } from './menu'
import { resetPlayedPlatform } from '../platform/platform.test-support'

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

/** The View menu of a window that is kept in front (or not); what the entry asks of the window is counted. */
function view(kept: boolean) {
  const state = createInitialState(ctx)
  const asked = { toggles: 0 }
  const browser = new Proxy(
    { menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false, sound: 'silent' }) } as Record<string, unknown>,
    { get: (target, prop: string) => (prop in target ? target[prop] : () => false) }
  )
  const actions = new Proxy(
    { windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}), isKeptOnTop: () => kept, keepOnTop: () => void (asked.toggles += 1) } as Record<string, unknown>,
    { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) }
  )
  const store = { get: () => state } as unknown as Parameters<typeof buildMenu>[1]
  const menus = buildMenu(browser as never, store, actions as never) as unknown as Item[]
  const items = menus.find((m) => m.label === 'Affichage')!.submenu!
  return { items, asked }
}

describe('View › Toujours au premier plan', () => {
  it('is a checkbox after « Activer le mode plein écran », with no shortcut of its own', () => {
    const { items } = view(false)
    const at = items.findIndex((item) => item.label === 'Activer le mode plein écran')
    expect(items[at + 1]).toMatchObject({ label: 'Toujours au premier plan', type: 'checkbox', checked: false })
    expect(items[at + 1]!.accelerator).toBeUndefined()
  })

  it('is ticked while the window is kept in front', () => {
    expect(view(true).items.find((item) => item.label === 'Toujours au premier plan')!.checked).toBe(true)
  })

  it('asks the window to be kept in front, or let go, when it is clicked', () => {
    const { items, asked } = view(false)
    items.find((item) => item.label === 'Toujours au premier plan')!.click!()
    expect(asked.toggles).toBe(1)
  })
})
