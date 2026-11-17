// The import sheet while it reads the other browser: the choices (the browser, its profile, what to bring, the scripts of the Tweaks) cannot be changed.
// The preview that comes back was read for the choices as they were when « Importer » was pressed; a choice changed meanwhile would leave on screen a
// preview that no longer says what is ticked, and « Confirmer l'import » would bring in something else than what the sheet shows.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { ImportSourceInfo } from '@shared/import-sources'

// The states of the sheet, seeded in the order it asks for them: the sources, the one chosen, its profile, the categories ticked, the work under way, the
// report, the scripts of the Tweaks (as import-sheet-language.test.ts does).
const hooks = vi.hoisted(() => ({ seeds: null as unknown[] | null, cursor: 0 }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const useState = <T>(initial: T): [T, (next: T) => void] => {
    if (hooks.seeds === null) return actual.useState(initial) as [T, (next: T) => void]
    const at = hooks.cursor++
    return [(at in hooks.seeds ? hooks.seeds[at] : initial) as T, () => undefined]
  }
  return { ...actual, useState }
})
vi.mock('./api', () => ({ api: () => ({ importSources: () => new Promise(() => undefined) }) }))

import { ImportSheet } from './ImportSheet'

afterEach(() => {
  setLanguage('fr')
  hooks.seeds = null
})

const SOURCES: ImportSourceInfo[] = [
  { id: 'arc', name: 'Arc', blurb: '', categories: ['bookmarks', 'history'], profiles: [{ id: 'Default', name: 'Perso' }, { id: 'Profile 1', name: 'Travail' }], found: true },
  { id: 'chrome', name: 'Chrome', blurb: '', categories: ['bookmarks'], profiles: [], found: true }
]

/** The controls of the choices (every radio, tick box and list of the sheet), drawn while `working` is under way. */
function choices(working: string): string[] {
  hooks.seeds = [SOURCES, 'arc', 'Default', ['bookmarks'], working, null, false]
  hooks.cursor = 0
  return [...renderToStaticMarkup(createElement(ImportSheet)).matchAll(/<(?:input|select)\b[^>]*>/g)].map((match) => match[0])
}

describe('the choices of the import sheet', () => {
  it('are all there and can be changed while nothing is under way', () => {
    const idle = choices('')
    // Two browsers, the list of profiles, two categories.
    expect(idle).toHaveLength(5)
    for (const control of idle) expect(control).not.toContain('disabled')
  })

  it('cannot be changed while the sheet reads, imports or takes an import back', () => {
    const busy = choices('Lecture…')
    expect(busy).toHaveLength(5)
    for (const control of busy) expect(control, control).toContain('disabled=""')
  })
})
