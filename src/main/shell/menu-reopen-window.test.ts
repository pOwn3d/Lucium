// Fichier › « Rouvrir la dernière fenêtre fermée »: greyed out while no closed window can come back and in a private window, and a click that brings the last one back.
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
  enabled?: boolean
  accelerator?: string
  click?: () => void
  submenu?: Item[]
}

const ctx = { now: 1_000, newId: ((n) => () => `id${++n}`)(0) }

/** The File menu, with or without a closed window to bring back; what the entry asks is counted. */
function file(canReopen: boolean, options: { private?: boolean } = {}) {
  const state = createInitialState(ctx)
  const asked = { reopened: 0 }
  const browser = new Proxy(
    { menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false, sound: 'silent' }) } as Record<string, unknown>,
    { get: (target, prop: string) => (prop in target ? target[prop] : () => false) }
  )
  const actions = new Proxy(
    { windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}), canReopenWindow: () => canReopen, reopenWindow: () => void (asked.reopened += 1) } as Record<string, unknown>,
    { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) }
  )
  const store = { get: () => state } as unknown as Parameters<typeof buildMenu>[1]
  const menus = buildMenu(browser as never, store, actions as never, options as never) as unknown as Item[]
  const items = menus.find((m) => m.label === 'Fichier')!.submenu!
  return { items, asked, entry: items.find((item) => item.label === 'Rouvrir la dernière fenêtre fermée')! }
}

describe('File › Rouvrir la dernière fenêtre fermée', () => {
  it('comes after « Nouvelle fenêtre privée », with no shortcut by default', () => {
    const { items, entry } = file(true)
    const at = items.findIndex((item) => item.label === 'Nouvelle fenêtre privée')
    expect(items[at + 1]).toBe(entry)
    expect(entry.accelerator).toBeUndefined()
  })

  it('is enabled only while a closed window can come back, and never in a private window', () => {
    expect(file(true).entry.enabled).toBe(true)
    expect(file(false).entry.enabled).toBe(false)
    expect(file(true, { private: true }).entry.enabled).toBe(false)
  })

  it('brings the last closed window back when it is clicked', () => {
    const { entry, asked } = file(true)
    entry.click!()
    expect(asked.reopened).toBe(1)
  })
})
