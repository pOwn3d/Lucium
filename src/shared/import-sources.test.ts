import { describe, expect, it } from 'vitest'
import { IMPORT_SOURCES, MAX_IMPORTED_LINKS, canRunImport, canUndoImport, defaultCategories, diskAccessMessage, importSource, importSummary, isImportPreview, noReport, parseImportRequest, parseImportToken, previewSummary } from './import-sources'
import { setLanguage } from './i18n'
import { frenchSpaces } from './french-typography'

describe('import sources', () => {
  it('have one id each and give every browser at least one thing to import', () => {
    expect(new Set(IMPORT_SOURCES.map((s) => s.id)).size).toBe(IMPORT_SOURCES.length)
    expect(IMPORT_SOURCES.every((s) => s.categories.length > 0)).toBe(true)
    expect(importSource('safari')?.categories).toEqual(['bookmarks', 'history'])
    // The sidebar browser keeps no file of its Tweaks on the Mac: there is no such part to import.
    expect(importSource('arc')?.categories).toEqual(['sidebar', 'history'])
    expect(importSource('netscape')).toBeUndefined()
  })
})

describe('parseImportRequest', () => {
  it('takes a browser, a profile, known categories and the file-chooser flag', () => {
    expect(parseImportRequest({ source: 'chrome', profile: 'Profile 1', categories: ['bookmarks', 'history'], pick: true })).toEqual({ source: 'chrome', profile: 'Profile 1', categories: ['bookmarks', 'history'], pick: true })
    expect(parseImportRequest({ source: 'safari', categories: [], pick: 'yes' })).toEqual({ source: 'safari', categories: [] })
  })

  it('keeps nothing of a flag it does not know', () => {
    expect(parseImportRequest({ source: 'arc', categories: ['sidebar'], boostScripts: true })).toEqual({ source: 'arc', categories: ['sidebar'] })
  })

  it('refuses a request that names a path, an unknown category or the wrong type', () => {
    for (const bad of [null, 'chrome', {}, { source: 'chrome' }, { source: 5, categories: [] }, { source: 'chrome', categories: ['passwords'] }, { source: 'chrome', categories: 'bookmarks' }, { source: 'chrome', categories: [], profile: 7 }, { source: 'x'.repeat(41), categories: [] }, { source: 'chrome', categories: ['bookmarks', 'bookmarks', 'history', 'sidebar'] }, { source: 'arc', categories: ['boosts'] }]) {
      expect(parseImportRequest(bad), JSON.stringify(bad)).toBeNull()
    }
    // The name of a profile folder is bounded like the browser's id.
    expect(parseImportRequest({ source: 'chrome', categories: [], profile: 'p'.repeat(101) })).toBeNull()
    expect(parseImportRequest({ source: 'chrome', categories: [], profile: 'p'.repeat(100) })).toEqual({ source: 'chrome', categories: [], profile: 'p'.repeat(100) })
  })
})

describe('importSummary', () => {
  it('counts with the right plural and says what was left out', () => {
    expect(importSummary('Safari', { bookmarks: 1, folders: 0, history: 1, skipped: 1 }, ['bookmarks', 'history'])).toBe(frenchSpaces('Importé depuis Safari : 1 onglet épinglé et 0 dossier, 1 page d’historique. 1 élément ignoré (ce n’est pas une page web, ou l’import ne sait pas le reprendre).'))
    expect(importSummary('Firefox', { bookmarks: 12, folders: 3, history: 0, skipped: 0 }, ['bookmarks'])).toBe(frenchSpaces('Importé depuis Firefox : 12 onglets épinglés et 3 dossiers.'))
  })

  it('says that links above the limit were not imported because of the limit, not because they are not web pages', () => {
    const message = importSummary('Chrome', { bookmarks: MAX_IMPORTED_LINKS, folders: 4, history: 0, skipped: 0, overLimit: 130 }, ['bookmarks'])
    expect(message).toMatch(/130 éléments non importés\u00a0: limite de 2\s000 atteinte\.$/)
    expect(message).not.toContain('ignoré')
    expect(importSummary('Chrome', { bookmarks: 1, folders: 0, history: 0, skipped: 0, overLimit: 1 }, ['bookmarks'])).toContain(frenchSpaces('1 élément non importé :'))
    expect(importSummary('Chrome', { bookmarks: 1, folders: 0, history: 0, skipped: 0, overLimit: 0 }, ['bookmarks'])).not.toContain('limite')
  })

  it('keeps both counts when some entries were refused and others were over the limit', () => {
    const message = importSummary('Chrome', { bookmarks: 5, folders: 0, history: 0, skipped: 2, overLimit: 3 }, ['bookmarks'])
    expect(message).toContain('2 éléments ignorés')
    expect(message).toContain('3 éléments non importés')
  })
})

describe('canRunImport', () => {
  const chrome = { categories: ['bookmarks', 'history'] as const }

  it('needs a browser, something ticked that it can give, and nothing already running', () => {
    expect(canRunImport({ categories: [...chrome.categories] }, ['history'], false)).toBe(true)
    expect(canRunImport(undefined, ['history'], false)).toBe(false)
    expect(canRunImport({ categories: [...chrome.categories] }, [], false)).toBe(false)
    expect(canRunImport({ categories: [...chrome.categories] }, ['sidebar'], false)).toBe(false)
    expect(canRunImport({ categories: [...chrome.categories] }, ['history'], true)).toBe(false)
  })

  it('starts with everything a browser can give ticked, except what it has no file for (the user points at that file)', () => {
    expect(defaultCategories({ categories: ['sidebar'] })).toEqual(['sidebar'])
    expect(defaultCategories({ categories: ['sidebar', 'history'], missing: ['history'] })).toEqual(['sidebar'])
  })
})

describe('the other browsers it can import from', () => {
  it('lists the pre-release channels and the forks of the engines it reads, each with a folder of its own under Application Support', () => {
    for (const id of ['chrome-beta', 'chrome-canary', 'brave-beta', 'brave-nightly', 'edge-beta', 'edge-dev', 'edge-canary']) {
      const def = importSource(id)
      expect(def, id).toMatchObject({ kind: 'chromium', categories: ['bookmarks', 'history'] })
      expect(def!.support, id).toBeTruthy()
    }
    for (const id of ['zen', 'librewolf', 'waterfox', 'floorp']) expect(importSource(id), id).toMatchObject({ kind: 'firefox', support: expect.stringMatching(/\/Profiles$/) })
    const folders = IMPORT_SOURCES.filter((s) => s.support).map((s) => s.support)
    expect(new Set(folders).size).toBe(folders.length)
  })

  it('has two sources whose file is always chosen by the user: the bookmarks file (HTML) and another browser', () => {
    expect(IMPORT_SOURCES.filter((s) => s.pickOnly).map((s) => s.id)).toEqual(['html', 'other'])
    expect(importSource('other')).toMatchObject({ kind: 'other', categories: ['bookmarks', 'history'] })
    expect(importSource('other')!.support).toBeUndefined()
  })

  it('never asks for passwords or cookies: no source offers a category other than sidebar, bookmarks or history', () => {
    for (const def of IMPORT_SOURCES) expect(def.categories.every((c) => ['sidebar', 'bookmarks', 'history'].includes(c)), def.id).toBe(true)
  })
})

describe('previewSummary', () => {
  it('asks the question in the future tense, with the counts of the import and what it leaves out', () => {
    expect(previewSummary('Firefox', { bookmarks: 12, folders: 3, history: 400, skipped: 0 }, ['bookmarks', 'history'])).toBe(frenchSpaces('Prêt à importer depuis Firefox : 12 signets (onglets épinglés) dans 3 dossiers, 400 pages d’historique.'))
    expect(previewSummary('Safari', { bookmarks: 1, folders: 0, history: 0, skipped: 2 }, ['bookmarks'])).toBe(frenchSpaces('Prêt à importer depuis Safari : 1 signet (onglets épinglés) dans 0 dossier. 2 éléments ignorés (ce ne sont pas des pages web, ou l’import ne sait pas les reprendre).'))
  })

  it('does not mention the bookmarks when only the history is asked, nor the history when only the bookmarks are', () => {
    expect(previewSummary('Chrome', { bookmarks: 0, folders: 0, history: 5, skipped: 0 }, ['history'])).toBe(frenchSpaces('Prêt à importer depuis Chrome : 5 pages d’historique.'))
    expect(previewSummary('Chrome', { bookmarks: 5, folders: 1, history: 9, skipped: 0 }, ['bookmarks'])).not.toContain('historique')
  })

  it('says that links above the limit will not come in', () => {
    expect(previewSummary('Chrome', { bookmarks: MAX_IMPORTED_LINKS, folders: 4, history: 0, skipped: 0, overLimit: 130 }, ['bookmarks'])).toMatch(/130 éléments ne seront pas importés\u00a0: limite de 2\s000 atteinte\.$/)
  })
})

describe('the summaries in English', () => {
  it('give the singular and the plural of each count, and the grouping of English digits', () => {
    setLanguage('en')
    try {
      expect(importSummary('Safari', { bookmarks: 1, folders: 0, history: 1, skipped: 1 }, ['bookmarks', 'history'])).toBe('Imported from Safari: 1 pinned tab and 0 folders, 1 page of history. 1 item skipped (it isn’t a web page, or the import can’t bring it over).')
      expect(importSummary('Firefox', { bookmarks: 12_000, folders: 1, history: 0, skipped: 0 }, ['bookmarks'])).toBe('Imported from Firefox: 12,000 pinned tabs and 1 folder.')
      expect(previewSummary('Firefox', { bookmarks: 1, folders: 3, history: 400, skipped: 0 }, ['bookmarks', 'history'])).toBe('Ready to import from Firefox: 1 bookmark (pinned tabs) in 3 folders, 400 pages of history.')
      expect(previewSummary('Chrome', { bookmarks: MAX_IMPORTED_LINKS, folders: 4, history: 0, skipped: 0, overLimit: 130 }, ['bookmarks'])).toMatch(/130 items will not be imported: limit of 2,000 reached\.$/)
      expect(diskAccessMessage()).toMatch(/^macOS protects this folder\. Give Lucium “Full Disk Access”/)
    } finally {
      setLanguage('fr')
    }
    // Back in French, the same counts give the same sentences as before.
    expect(importSummary('Firefox', { bookmarks: 12_000, folders: 1, history: 0, skipped: 0 }, ['bookmarks'])).toMatch(/^Importé depuis Firefox\u00a0: 12\s000 onglets épinglés et 1 dossier\.$/)
  })
})

describe('the keys of a preview and of an import', () => {
  it('are accepted only as the main process makes them (a UUID), never as a path or as anything long', () => {
    expect(parseImportToken('3f2c8e1a-9b7d-4c55-8a10-0123456789ab')).toBe('3f2c8e1a-9b7d-4c55-8a10-0123456789ab')
    for (const bad of [undefined, null, 5, {}, [], '', 'x', '../../etc/passwd', 'ABCDEF01-0000', 'a'.repeat(65), '3f2c8e1a-9b7d-4c55-8a10-0123456789ab ', 'g'.repeat(20)]) expect(parseImportToken(bad), String(bad)).toBeNull()
  })

  it('tell the sheet which buttons to show: a preview is confirmed, an import is undone, a failure is neither', () => {
    const preview = { ...noReport(''), ok: true, token: 'a-b-c-d-e-f-g-h' }
    const done = { ...noReport(''), ok: true, undoToken: 'a-b-c-d-e-f-g-h' }
    expect(isImportPreview(preview)).toBe(true)
    expect(canUndoImport(preview)).toBe(false)
    expect(isImportPreview(done)).toBe(false)
    expect(canUndoImport(done)).toBe(true)
    expect(isImportPreview(noReport('non', { token: 'a-b-c-d-e-f-g-h' }))).toBe(false)
    expect(canUndoImport(noReport('non', { undoToken: 'a-b-c-d-e-f-g-h' }))).toBe(false)
    expect(isImportPreview(null) || canUndoImport(null)).toBe(false)
    expect(canUndoImport({ ...noReport(''), ok: true })).toBe(false)
    // A preview is never offered as an import to undo, whatever else the report carries.
    expect(canUndoImport({ ...noReport(''), ok: true, token: 'a-b-c-d-e-f-g-h', undoToken: 'a-b-c-d-e-f-g-h' })).toBe(false)
  })
})
