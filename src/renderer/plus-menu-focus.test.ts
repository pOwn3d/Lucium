// The menu of the « + »: the row the arrows choose is the one a screen reader must read. The choice is a real focus (the chosen row is the one
// tab stop of the menu, the others are out of the tab order), not a class alone.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce } from '@shared/sidebar'
import plusMenuCss from './plus-menu.css?raw'
import { t } from '@shared/i18n'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => new Proxy({}, { get: () => () => undefined }), useSnapshot: () => holder.snapshot }))

import { PlusMenu } from './PlusMenu'

/** The rows of the menu as drawn: their entry, whether they are chosen, and their place in the tab order. */
function rows(url: string, locked = false): Array<{ entry: string; selected: boolean; tabIndex: string | null; disabled: boolean; title: string | null }> {
  const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
  let state = createInitialState(ctx)
  state = reduce(state, { type: 'tab/open', url, spaceId: state.spaces[0]!.id }, ctx)
  const lock = { active: true, appLocked: false, lockedSpaces: [state.activeSpaceId], guardedSpaces: [state.activeSpaceId], touchId: false, retryInMs: 0 }
  holder.snapshot = { state, ...(locked ? { lock } : {}) }
  const markup = renderToStaticMarkup(createElement(PlusMenu, { anchor: { x: 300, y: 700, width: 30, height: 30 } as never }))
  return [...markup.matchAll(/<button\b([^>]*)>/g)].map(([, attrs]) => ({
    entry: /data-entry="([^"]*)"/.exec(attrs!)?.[1] ?? '',
    selected: /class="[^"]*\bselected\b/.test(attrs!),
    tabIndex: /tabindex="([^"]*)"/.exec(attrs!)?.[1] ?? null,
    disabled: /aria-disabled="true"/.test(attrs!),
    title: /title="([^"]*)"/.exec(attrs!)?.[1] ?? null
  }))
}

beforeEach(() => vi.stubGlobal('window', { innerHeight: 800, innerWidth: 1200, addEventListener: () => undefined, removeEventListener: () => undefined }))
afterEach(() => vi.unstubAllGlobals())

describe('the menu of the « + »', () => {
  it('has one tab stop, the chosen row; the other rows are reached with the arrows', () => {
    const drawn = rows('https://exemple.fr/')
    expect(drawn.length).toBeGreaterThan(1)
    expect(drawn.filter((row) => row.selected)).toHaveLength(1)
    for (const row of drawn) expect(row.tabIndex, row.entry).toBe(row.selected ? '0' : '-1')
  })

  it('never makes a greyed row the tab stop', () => {
    // A page with no site (about:blank): the rows that need one are greyed.
    const drawn = rows('about:blank')
    expect(drawn.some((row) => row.disabled)).toBe(true)
    for (const row of drawn.filter((one) => one.disabled)) expect(row.tabIndex, row.entry).toBe('-1')
    expect(drawn.filter((row) => row.tabIndex === '0')).toHaveLength(1)
  })

  it('greys out « Nouveau dossier » while the space on screen is locked, and says why under the pointer', () => {
    const folder = (drawn: ReturnType<typeof rows>) => drawn.find((row) => row.entry === 'folder')!
    expect(folder(rows('https://exemple.fr/'))).toMatchObject({ disabled: false, title: null })
    expect(folder(rows('https://exemple.fr/', true))).toMatchObject({ disabled: true, title: t('lock.deverrouillez-l-espace-d-abord'), tabIndex: '-1' })
    // A new space lands in no space: the lock of the one on screen leaves it alone.
    expect(rows('https://exemple.fr/', true).find((row) => row.entry === 'space')).toMatchObject({ disabled: false, title: null })
  })

  it('shows the ring of the focus on the row the keyboard reached', () => {
    expect(plusMenuCss.replace(/\/\*[\s\S]*?\*\//g, '')).toMatch(/\.plus-row:focus-visible\s*\{[^}]*outline:\s*var\(--focus-width\) solid var\(--focus\)/)
  })
})
