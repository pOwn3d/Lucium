import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { exportBookmarksHtml } from '@shared/bookmarks-html'
import { createInitialState, reduce } from '@shared/sidebar'

const dialogs = vi.hoisted(() => ({ showSaveDialog: vi.fn() }))
vi.mock('electron', () => ({ dialog: dialogs }))

import { exportBookmarks, lockedExportMessage, nothingToExportMessage, privateExportMessage } from './bookmarks-export'
import { frenchSpaces } from '@shared/french-typography'

let dir: string
const win = {} as BrowserWindow
const ctx = { now: 1_700_000_000_000, newId: (() => { let n = 0; return () => `id${++n}` })() }
const withPins = () => {
  let state = createInitialState(ctx)
  state = reduce(state, { type: 'tab/open', url: 'https://epingle.example/' }, ctx)
  state = reduce(state, { type: 'tab/pin', id: state.tabs[0]!.id }, ctx)
  state = reduce(state, { type: 'tab/open', url: 'https://aujourdhui.example/' }, ctx)
  return state
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-bookmarks-'))
  dialogs.showSaveDialog.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('exportBookmarks', () => {
  it('writes the bookmarks file at the path the user chose, and only there', async () => {
    const chosen = join(dir, 'mes-signets.html')
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: chosen })
    const state = withPins()
    const outcome = await exportBookmarks({ win, state, isPrivate: false }, { includeToday: false })
    expect(outcome.path).toBe(chosen)
    expect(outcome.message).toContain(`Enregistré dans ${chosen}`)
    expect(outcome.message).toContain('1 onglet épinglé')
    expect(readFileSync(chosen, 'utf8')).toBe(exportBookmarksHtml(state, { includeToday: false }).html)
    expect(readFileSync(chosen, 'utf8')).not.toContain('aujourdhui.example')
    // Nothing else appeared next to it (no temporary file, no copy).
    expect(readdirSync(dir)).toEqual(['mes-signets.html'])
    const [, options] = dialogs.showSaveDialog.mock.calls[0]!
    expect(options).toMatchObject({ defaultPath: 'lucium-signets.html', filters: [{ extensions: ['html'] }] })
  })

  it('includes the Today tabs only when asked', async () => {
    const chosen = join(dir, 'avec-aujourdhui.html')
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: chosen })
    const outcome = await exportBookmarks({ win, state: withPins(), isPrivate: false }, { includeToday: true })
    expect(readFileSync(chosen, 'utf8')).toContain('https://aujourdhui.example/')
    expect(outcome.message).toContain('1 onglet du jour')
  })

  it('refuses in a private window: no dialog, no file, a sentence that says why', async () => {
    const outcome = await exportBookmarks({ win, state: withPins(), isPrivate: true }, { includeToday: true })
    expect(outcome).toEqual({ path: null, message: privateExportMessage() })
    expect(dialogs.showSaveDialog).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses while a space is locked: the file lists the pins and folders of every space (no dialog, no file, a sentence that says why; this fails without the check)', async () => {
    const state = withPins()
    const outcome = await exportBookmarks({ win, state, isPrivate: false, lockedSpaces: [state.spaces[0]!.id] }, { includeToday: true })
    expect(outcome).toEqual({ path: null, message: lockedExportMessage() })
    expect(lockedExportMessage()).toMatch(/Déverrouillez/)
    expect(dialogs.showSaveDialog).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
    // Nothing locked: the export goes on as before.
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: join(dir, 'ok.html') })
    expect((await exportBookmarks({ win, state, isPrivate: false, lockedSpaces: [] }, { includeToday: false })).path).toBe(join(dir, 'ok.html'))
  })

  it('writes nothing and says nothing when the user gives up the save dialog', async () => {
    dialogs.showSaveDialog.mockResolvedValue({ canceled: true })
    expect(await exportBookmarks({ win, state: withPins(), isPrivate: false }, { includeToday: false })).toEqual({ path: null, message: '' })
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '' })
    expect(await exportBookmarks({ win, state: withPins(), isPrivate: false }, { includeToday: false })).toEqual({ path: null, message: '' })
    expect(readdirSync(dir)).toEqual([])
  })

  it('does not even ask where to save when there is nothing to write', async () => {
    const outcome = await exportBookmarks({ win, state: createInitialState(ctx), isPrivate: false }, { includeToday: false })
    expect(outcome).toEqual({ path: null, message: nothingToExportMessage() })
    expect(dialogs.showSaveDialog).not.toHaveBeenCalled()
  })

  it('reports a file it cannot write, in the log with where, and to the user with the reason', async () => {
    const chosen = join(dir, 'absent', 'signets.html')
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: chosen })
    const outcome = await exportBookmarks({ win, state: withPins(), isPrivate: false }, { includeToday: false })
    expect(outcome.path).toBeNull()
    expect(outcome.message).toMatch(/^Enregistrement impossible dans signets\.html\u00a0: /)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(chosen), expect.anything())
  })

  it('tells the person what to do about a folder that is gone or protected, not the system’s English with the path in it', async () => {
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: join(dir, 'absent', 'signets.html') })
    const gone = await exportBookmarks({ win, state: withPins(), isPrivate: false }, { includeToday: false })
    expect(gone.message).toBe(frenchSpaces('Enregistrement impossible dans signets.html : le dossier choisi n’existe plus. Choisissez un autre emplacement.'))

    const locked = join(dir, 'protege')
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    try {
      dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: join(locked, 'signets.html') })
      const refused = await exportBookmarks({ win, state: withPins(), isPrivate: false }, { includeToday: false })
      expect(refused.message).toMatch(/^Enregistrement impossible dans signets\.html\u00a0: vous n’avez pas le droit d’écrire à cet endroit/)
      expect(refused.message).not.toMatch(/EACCES|permission denied|protege/)
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})
