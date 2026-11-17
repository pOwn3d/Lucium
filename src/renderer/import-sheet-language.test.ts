// The words of the import sheet that were still written in French in the code: the names of the two
// file sources, the categories and the buttons. French is unchanged to the character; English is the catalogue's.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { CATEGORY_LABELS, importSource, type ImportReport, type ImportSourceInfo } from '@shared/import-sources'

// The states of the sheet, seeded in the order it asks for them (the sources, the one chosen, its profile, the categories ticked, the work under way, the
// report, the scripts of the Tweaks), so that a render to markup shows the buttons of a step the sheet only reaches after an answer. Unseeded, React answers.
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

describe('the names of the sources and of the categories', () => {
  it('stay the French ones in French', () => {
    expect(importSource('html')?.name).toBe('Fichier de signets (HTML)')
    expect(importSource('other')?.name).toBe('Autre navigateur')
    expect([CATEGORY_LABELS.bookmarks, CATEGORY_LABELS.history]).toEqual(['Signets', 'Historique'])
  })

  it('are English in English, read when they are shown (not when the module loads)', () => {
    setLanguage('en')
    expect(importSource('html')?.name).toBe('Bookmarks file (HTML)')
    expect(importSource('other')?.name).toBe('Other browser')
    expect([CATEGORY_LABELS.sidebar, CATEGORY_LABELS.bookmarks, CATEGORY_LABELS.history]).toEqual(['Spaces, tabs, folders, favorites and split views', 'Bookmarks', 'History'])
  })
})

describe('the buttons of the sheet', () => {
  it('read « Annuler » and « Importer » in French, « Cancel » and « Import » in English', () => {
    const french = renderToStaticMarkup(createElement(ImportSheet))
    expect(french).toContain('>Annuler</button>')
    expect(french).toContain('>Importer</button>')
    setLanguage('en')
    const english = renderToStaticMarkup(createElement(ImportSheet))
    expect(english).toContain('>Cancel</button>')
    expect(english).toContain('>Import</button>')
    expect(english).not.toMatch(/>(Annuler|Importer)</)
  })

  /** The sheet drawn at a step: a browser chosen, its bookmarks ticked, and this report on screen. */
  const sheetWith = (report: ImportReport): string => {
    const chrome: ImportSourceInfo = { id: 'chrome', name: 'Chrome', blurb: '', categories: ['bookmarks'], profiles: [], found: true }
    hooks.seeds = [[chrome], 'chrome', undefined, ['bookmarks'], '', report, false]
    hooks.cursor = 0
    return renderToStaticMarkup(createElement(ImportSheet))
  }
  const buttonsOf = (markup: string): string[] => [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]!)
  const report = (patch: Partial<ImportReport>): ImportReport => ({ ok: true, message: 'x', bookmarks: 1, folders: 0, history: 0, skipped: 0, ...patch })

  it('hold no French text of their own any more: at every step, every button reads the catalogue', () => {
    // A preview that waits for the answer, with macOS refusing the data: every button of the waiting step is there.
    const waiting = report({ token: 'preview', needsDiskAccess: true, canPick: true })
    // An import done that can be taken back.
    const done = report({ undoToken: 'undo' })
    expect(buttonsOf(sheetWith(waiting))).toEqual(['Ouvrir Réglages Système', 'Choisir le fichier…', 'Retour', 'Annuler', 'Confirmer l’import'])
    expect(buttonsOf(sheetWith(done))).toEqual(['Annuler l’import', 'Régler en quelques questions…', 'Terminé'])
    setLanguage('en')
    expect(buttonsOf(sheetWith(waiting))).toEqual(['Open System Settings', 'Choose File…', 'Back', 'Cancel', 'Confirm Import'])
    expect(buttonsOf(sheetWith(done))).toEqual(['Undo the import', 'Set Up in a Few Questions…', 'Done'])
  })
})
