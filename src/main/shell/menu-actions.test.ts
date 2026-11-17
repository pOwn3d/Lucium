import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { notesFileText } from '@shared/notes'
import { createInitialState, reduce } from '@shared/sidebar'

const userData = vi.hoisted(() => ({ dir: '' }))
const dialogs = vi.hoisted(() => ({ showOpenDialog: vi.fn(), showMessageBox: vi.fn(), showErrorBox: vi.fn(), showSaveDialog: vi.fn() }))
const tracing = vi.hoisted(() => ({ startRecording: vi.fn(), stopRecording: vi.fn() }))
const systemShell = vi.hoisted(() => ({ showItemInFolder: vi.fn(), openPath: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => userData.dir, getAppPath: () => process.cwd(), isPackaged: false }, contentTracing: tracing, net: {}, shell: systemShell, dialog: dialogs }))

import { encryptExport } from '../export-crypto'
import { exportBookmarksFromMenu, gettingStartedFile, isRecordingTrace, openDocumentation, recordTrace, restoreData } from './menu-actions'
import { configureNotes } from '../notes-store'
import { tempDir } from '../temp-dir'

const exported = () => JSON.stringify(createInitialState({ now: 1, newId: () => 'exported' }))
const setup = (flush: () => boolean, over: { isPrivate?: boolean; askPassphrase?: ReturnType<typeof vi.fn> } = {}) => {
  const dispatch = vi.fn()
  const askPassphrase = over.askPassphrase ?? vi.fn().mockResolvedValue(null)
  const window = { win: {}, browser: { dispatch, isPrivate: () => over.isPrivate === true, askPassphrase }, store: { flush } } as unknown as Parameters<typeof restoreData>[0]
  return { dispatch, window, askPassphrase }
}
const backups = () => readdirSync(userData.dir).filter((n) => n.includes('.avant-restauration-'))

beforeEach(() => {
  userData.dir = tempDir('lucium-restore-')
  const chosen = join(userData.dir, 'export.json')
  writeFileSync(chosen, exported())
  dialogs.showOpenDialog.mockReset().mockResolvedValue({ canceled: false, filePaths: [chosen] })
  dialogs.showMessageBox.mockReset().mockResolvedValue({ response: 0 })
  dialogs.showErrorBox.mockReset()
  dialogs.showSaveDialog.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('Help › Getting Started', () => {
  afterEach(() => setLanguage('fr'))

  it('opens the README written in the language of the interface, and both are files of the repository that the build ships', async () => {
    systemShell.openPath.mockReset().mockResolvedValue('')
    setLanguage('fr')
    await openDocumentation('start')
    setLanguage('en')
    await openDocumentation('start')
    expect(systemShell.openPath.mock.calls.map(([path]) => path)).toEqual([join(process.cwd(), 'README.fr.md'), join(process.cwd(), 'README.md')])
    const shipped = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    for (const language of ['fr', 'en'] as const) {
      const file = gettingStartedFile(language)
      expect(existsSync(join(process.cwd(), file)), file).toBe(true)
      expect(shipped, file).toContain(`  - from: ${file}\n    to: docs/${file}\n`)
    }
  })

  it('says where it looked when the file cannot be opened', async () => {
    systemShell.openPath.mockReset().mockResolvedValue('no application can open it')
    setLanguage('fr')
    await openDocumentation('start')
    expect(dialogs.showErrorBox).toHaveBeenCalledWith('Documentation introuvable', expect.stringContaining('README.fr.md\n\nno application can open it'))
  })
})

describe('Help › Restore Data', () => {
  it('copies the current state first, then restores', async () => {
    writeFileSync(join(userData.dir, 'state.json'), 'current')
    const { dispatch, window } = setup(() => true)
    await restoreData(window)
    expect(backups()).toHaveLength(1)
    expect(readFileSync(join(userData.dir, backups()[0]!), 'utf8')).toBe('current')
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'state/restore' }))
    expect(dialogs.showErrorBox).not.toHaveBeenCalled()
  })

  it('tells the user, and restores nothing, when the copy cannot be made', async () => {
    // A folder where the state file should be: copying it fails, as it would on a full disk or without permission.
    mkdirSync(join(userData.dir, 'state.json'))
    const { dispatch, window } = setup(() => true)
    await restoreData(window)
    expect(dispatch).not.toHaveBeenCalled()
    expect(dialogs.showErrorBox).toHaveBeenCalledWith('Restauration impossible', expect.stringMatching(/copie de sauvegarde.*échoué[^]*Rien n’a été restauré/))
  })

  it('tells the user, and restores nothing, when the current state cannot be saved first', async () => {
    writeFileSync(join(userData.dir, 'state.json'), 'old')
    const { dispatch, window } = setup(() => false)
    await restoreData(window)
    expect(dispatch).not.toHaveBeenCalled()
    expect(backups()).toEqual([])
    expect(dialogs.showErrorBox).toHaveBeenCalledWith('Restauration impossible', expect.stringContaining('Rien n’a été restauré'))
  })

  // Guard: the reducer keeps from this installation what a file from elsewhere must not decide (`state/restore`). The question names all of it before the
  // person answers: where files and traffic go, what a site is allowed, and what Lucium does on its own.
  it('says in the question what is not taken from the file: folders, proxy, DNS, permissions of the sites, watched pages, commands by address, the search for updates', async () => {
    writeFileSync(join(userData.dir, 'state.json'), 'current')
    const { window } = setup(() => true)
    await restoreData(window)
    // The spaces French puts inside « » and before a colon are no-break ones: read as plain spaces here.
    const plain = (text: string): string => text.replace(/[\u00a0\u202f]/g, ' ')
    const detail = plain(dialogs.showMessageBox.mock.calls[0]![1].detail as string)
    for (const said of [/les dossiers de téléchargement, le proxy et le DNS restent ceux de cette installation/, /n’accorde pas non plus d’autorisation à un site/, /« Surveiller des pages »/, /« Commandes par adresse lucium:\/\/ »/, /« Rechercher les mises à jour automatiquement » restent allumés ou éteints comme ils le sont ici/, /pages à surveiller que liste le fichier ne sont reprises que si la surveillance est éteinte ici/]) {
      expect(detail).toMatch(said)
    }
    // The names are the ones Réglages shows for these three switches.
    for (const label of ['web-tools-settings.surveiller-des-pages', 'features.rechercher-les-mises-a-jour-automatiquement'] as const) expect(detail).toContain(`« ${plain(t(label))} »`)
    expect(detail).toContain(`« ${plain(t('features.commandes-par-adresse-lucium-applescript')).replace(/ \(.*$/, '')} »`)
  })

  it('says in the question that the Tweak scripts of the file come back switched off, and only then', async () => {
    const ctx = { now: 1, newId: () => 'with-script' }
    const boost = { id: 'b1', name: 'Script', host: 'example.com', enabled: true, css: '', js: 'document.title = "x"', zoom: 1, zap: [], tint: null }
    const chosen = join(userData.dir, 'export.json')
    writeFileSync(join(userData.dir, 'state.json'), 'current')
    const { window } = setup(() => true)
    await restoreData(window)
    expect(dialogs.showMessageBox.mock.calls[0]![1].detail).not.toContain('JavaScript')
    writeFileSync(chosen, JSON.stringify(reduce(createInitialState(ctx), { type: 'boost/save', boost } as never, ctx)))
    dialogs.showMessageBox.mockClear()
    await restoreData(window)
    expect(dialogs.showMessageBox.mock.calls[0]![1].detail).toMatch(/JavaScript d’une Retouche est restauré désactivé/)
  })

  it('asks nothing and changes nothing when the user cancels the confirmation', async () => {
    writeFileSync(join(userData.dir, 'state.json'), 'current')
    dialogs.showMessageBox.mockResolvedValue({ response: 1 })
    const { dispatch, window } = setup(() => true)
    await restoreData(window)
    expect(dispatch).not.toHaveBeenCalled()
    expect(backups()).toEqual([])
  })
})

// The quick notes an export carries: put back with the rest, in the same confirmation, after a copy of notes.json.
describe('Help › Restore Data, with the quick notes of the export', () => {
  const mine = { id: 'mine', text: 'ma note actuelle', createdAt: 5, updatedAt: 6 }
  const fromFile = [
    { id: 'from-file', text: 'note de l’export', createdAt: 1, updatedAt: 2, link: { kind: 'page' as const, url: 'https://example.org/' } },
    { id: 'not-a-note', text: '', createdAt: 'hier' }
  ]
  const notesPath = () => join(userData.dir, 'notes.json')
  const notesNow = () => (JSON.parse(readFileSync(notesPath(), 'utf8')) as { notes: Array<{ id: string }> }).notes.map((note) => note.id)
  const exportWith = (extra: Record<string, unknown>) => writeFileSync(join(userData.dir, 'export.json'), JSON.stringify({ ...createInitialState({ now: 1, newId: () => 'exported' }), ...extra }))
  const notesBackups = () => readdirSync(userData.dir).filter((n) => n.startsWith('notes.json.avant-restauration-'))

  beforeEach(() => {
    configureNotes(notesPath())
    writeFileSync(notesPath(), notesFileText([mine]))
    writeFileSync(join(userData.dir, 'state.json'), 'current')
  })

  it('puts back the notes of the file, after a copy of notes.json, and says so in the same confirmation', async () => {
    exportWith({ notes: fromFile })
    const { dispatch, window } = setup(() => true)
    await restoreData(window)
    expect(dialogs.showMessageBox).toHaveBeenCalledTimes(1)
    expect(dialogs.showMessageBox.mock.calls[0]![1].detail).toMatch(/1 note rapide du fichier remplace vos notes actuelles/)
    expect(notesNow()).toEqual(['from-file'])
    expect(notesBackups()).toHaveLength(1)
    expect(readFileSync(join(userData.dir, notesBackups()[0]!), 'utf8')).toBe(notesFileText([mine]))
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'state/restore' }))
    expect(dialogs.showErrorBox).not.toHaveBeenCalled()
  })

  it('leaves the notes alone when the file carries none (an export made without notes, a copy of state.json)', async () => {
    for (const extra of [{}, { notes: [] }, { notes: 'pas une liste' }, { notes: [{ id: 'x' }] }]) {
      exportWith(extra)
      dialogs.showMessageBox.mockClear()
      const { dispatch, window } = setup(() => true)
      await restoreData(window)
      expect(dispatch, JSON.stringify(extra)).toHaveBeenCalled()
      expect(dialogs.showMessageBox.mock.calls[0]![1].detail, JSON.stringify(extra)).not.toMatch(/notes? rapides? du fichier/)
      expect(notesNow(), JSON.stringify(extra)).toEqual(['mine'])
    }
    expect(notesBackups()).toEqual([])
  })

  it('restores nothing, neither the state nor the notes, when notes.json cannot be copied first', async () => {
    exportWith({ notes: fromFile })
    // notes.json is a folder: it cannot be copied, as on a full disk or without permission.
    rmSync(notesPath())
    mkdirSync(notesPath())
    const { dispatch, window } = setup(() => true)
    await restoreData(window)
    expect(dispatch).not.toHaveBeenCalled()
    expect(dialogs.showErrorBox).toHaveBeenCalledWith('Restauration impossible', expect.stringMatching(/notes rapides du fichier n’ont pas pu être restaurées[^]*Rien n’a été restauré/))
  })

  it('changes neither the state nor the notes when the user cancels the confirmation', async () => {
    exportWith({ notes: fromFile })
    dialogs.showMessageBox.mockResolvedValue({ response: 1 })
    const { dispatch, window } = setup(() => true)
    await restoreData(window)
    expect(dispatch).not.toHaveBeenCalled()
    expect(notesNow()).toEqual(['mine'])
    expect(notesBackups()).toEqual([])
  })
})

describe('Lucium › Exporter les signets (HTML)…', () => {
  const ctx = { now: 1_700_000_000_000, newId: (() => { let n = 0; return () => `e${++n}` })() }
  const pinned = () => {
    let state = createInitialState(ctx)
    state = reduce(state, { type: 'tab/open', url: 'https://epingle.example/' }, ctx)
    state = reduce(state, { type: 'tab/pin', id: state.tabs[0]!.id }, ctx)
    return reduce(state, { type: 'tab/open', url: 'https://aujourdhui.example/' }, ctx)
  }
  /** The state of every window: with windows of their own, another window holds a Today tab this window does not list. */
  const everyWindow = () => reduce(pinned(), { type: 'tab/open', url: 'https://autre-fenetre.example/' }, ctx)
  const exportWindow = (extra: { isPrivate?: boolean } = {}) => {
    const showToast = vi.fn()
    const window = { win: {}, browser: { isPrivate: () => extra.isPrivate === true, showToast }, store: { get: pinned, root: () => ({ get: everyWindow }) } } as unknown as Parameters<typeof exportBookmarksFromMenu>[0]
    return { showToast, window }
  }
  const target = () => join(userData.dir, 'signets.html')

  it('asks whether the Today tabs go in (not ticked), then where, writes the file and says so in a notice', async () => {
    dialogs.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target() })
    const { showToast, window } = exportWindow()
    await exportBookmarksFromMenu(window, [])
    expect(dialogs.showMessageBox).toHaveBeenCalledWith(window.win, expect.objectContaining({ checkboxLabel: 'Inclure aussi les onglets du jour', checkboxChecked: false }))
    const html = readFileSync(target(), 'utf8')
    expect(html).toContain('https://epingle.example/')
    expect(html).not.toContain('aujourdhui.example')
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Enregistré dans'))
  })

  it('includes the Today tabs when the box is ticked', async () => {
    dialogs.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: true })
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target() })
    await exportBookmarksFromMenu(exportWindow().window, [])
    expect(readFileSync(target(), 'utf8')).toContain('https://aujourdhui.example/')
    // Those of the other windows too, as « Exporter les données… » writes them.
    expect(readFileSync(target(), 'utf8')).toContain('https://autre-fenetre.example/')
  })

  it('asks nothing and writes nothing in a private window, or when the user cancels', async () => {
    await exportBookmarksFromMenu(exportWindow({ isPrivate: true }).window, [])
    dialogs.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: true })
    await exportBookmarksFromMenu(exportWindow().window, [])
    expect(dialogs.showSaveDialog).not.toHaveBeenCalled()
    expect(dialogs.showMessageBox).toHaveBeenCalledTimes(1)
    expect(readdirSync(userData.dir)).not.toContain('signets.html')
  })

  it('tells the user, and logs it, when the save dialog itself fails', async () => {
    dialogs.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    dialogs.showSaveDialog.mockRejectedValue(new Error('boîte de dialogue indisponible'))
    const { showToast, window } = exportWindow()
    await exportBookmarksFromMenu(window, [])
    expect(showToast).not.toHaveBeenCalled()
    expect(dialogs.showErrorBox).toHaveBeenCalledWith('Export des signets impossible', 'boîte de dialogue indisponible')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[bookmarks]'), expect.any(Error))
  })

  it('writes nothing while a space is locked, and says why: the file would list what the lock hides', async () => {
    dialogs.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: true })
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target() })
    const { showToast, window } = exportWindow()
    await exportBookmarksFromMenu(window, ['espace-verrouille'])
    expect(dialogs.showSaveDialog).not.toHaveBeenCalled()
    expect(readdirSync(userData.dir)).not.toContain('signets.html')
    expect(showToast).not.toHaveBeenCalled()
    expect(dialogs.showErrorBox).toHaveBeenCalledWith('Export des signets impossible', expect.stringContaining('verrouillés'))
  })

  it('tells the user in a dialog, not in a notice, when the file cannot be written', async () => {
    dialogs.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: join(userData.dir, 'absent', 'signets.html') })
    const { showToast, window } = exportWindow()
    await exportBookmarksFromMenu(window, [])
    expect(showToast).not.toHaveBeenCalled()
    expect(dialogs.showErrorBox).toHaveBeenCalledWith('Export des signets impossible', expect.stringContaining('Enregistrement impossible'))
  })
})

describe('Help › Restore Data, from an export sealed with a passphrase', () => {
  const PHRASE = 'une phrase pour ce fichier'
  const cheap = { N: 2 ** 14, r: 8, p: 1 }
  const choose = async () => {
    const sealed = join(userData.dir, 'sealed.json')
    writeFileSync(sealed, await encryptExport(exported(), PHRASE, { params: cheap }))
    writeFileSync(join(userData.dir, 'state.json'), 'current')
    dialogs.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [sealed] })
  }

  it('asks for the passphrase in the window\'s panel, then restores like any export', async () => {
    await choose()
    const { dispatch, window, askPassphrase } = setup(() => true, { askPassphrase: vi.fn().mockResolvedValue(PHRASE) })
    await restoreData(window)
    expect(askPassphrase).toHaveBeenCalledWith(expect.stringMatching(/chiffré/), expect.any(String), null)
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'state/restore' }))
    expect(backups()).toHaveLength(1)
    expect(dialogs.showErrorBox).not.toHaveBeenCalled()
  })

  it('asks again after a wrong passphrase and says it was wrong', async () => {
    await choose()
    const { dispatch, window, askPassphrase } = setup(() => true, { askPassphrase: vi.fn().mockResolvedValueOnce('une mauvaise phrase ici').mockResolvedValueOnce(PHRASE) })
    await restoreData(window)
    expect(askPassphrase).toHaveBeenCalledTimes(2)
    expect(askPassphrase).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.stringMatching(/incorrecte/))
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('restores nothing and shows no error when the user gives up the question', async () => {
    await choose()
    const { dispatch, window } = setup(() => true)
    await restoreData(window)
    expect(dispatch).not.toHaveBeenCalled()
    expect(dialogs.showErrorBox).not.toHaveBeenCalled()
    expect(dialogs.showMessageBox).not.toHaveBeenCalled()
    expect(backups()).toEqual([])
  })

  it('restores nothing, and says why, when the file was altered', async () => {
    await choose()
    const path = join(userData.dir, 'sealed.json')
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as { data: string }
    const bytes = Buffer.from(envelope.data, 'base64')
    bytes[7] = bytes[7]! ^ 1
    writeFileSync(path, JSON.stringify({ ...envelope, data: bytes.toString('base64') }))
    const { dispatch, window } = setup(() => true, { askPassphrase: vi.fn().mockResolvedValue(PHRASE) })
    await restoreData(window)
    expect(dispatch).not.toHaveBeenCalled()
    expect(dialogs.showErrorBox).toHaveBeenCalledWith('Restauration impossible', expect.stringMatching(/altéré/))
  })

  it('does nothing from a private window but say so (it would ask for a passphrase for nothing)', async () => {
    await choose()
    const { dispatch, window, askPassphrase } = setup(() => true, { isPrivate: true })
    await restoreData(window)
    expect(askPassphrase).not.toHaveBeenCalled()
    expect(dialogs.showOpenDialog).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(dialogs.showErrorBox).toHaveBeenCalledWith('Restauration impossible', expect.stringMatching(/fenêtre privée/))
  })
})

describe('Help › Troubleshooting › Record Trace', () => {
  const window = {} as Parameters<typeof recordTrace>[0]
  const traceFile = () => join(userData.dir, 'trace.json')
  const dialogOptions = (call: number) => dialogs.showMessageBox.mock.calls[call]![1] as { type: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number }

  beforeEach(() => {
    tracing.startRecording.mockReset().mockResolvedValue(undefined)
    tracing.stopRecording.mockReset().mockResolvedValue(traceFile())
    systemShell.showItemInFolder.mockReset()
  })
  // The recording flag lives as long as the process: a test that left one running must not decide the next one.
  afterEach(async () => {
    if (!isRecordingTrace()) return
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: traceFile() })
    await recordTrace(window, () => {})
  })

  it('warns before recording: what the trace may hold, where it is written, that it is never sent; Cancel is the default button', async () => {
    dialogs.showMessageBox.mockResolvedValue({ response: 1 })
    const changed = vi.fn()
    await recordTrace(window, changed)
    expect(dialogs.showMessageBox).toHaveBeenCalledTimes(1)
    const options = dialogOptions(0)
    expect(options.type).toBe('warning')
    expect(options.buttons).toEqual(['Démarrer l’enregistrement', 'Annuler'])
    expect(options.defaultId).toBe(1)
    expect(options.cancelId).toBe(1)
    expect(options.detail).toMatch(/toutes les catégories/)
    expect(options.detail).toMatch(/adresses des pages/)
    expect(options.detail).toMatch(/fichier que vous choisirez/)
    expect(options.detail).toMatch(/ne l’envoie nulle part/)
    // Cancelling starts nothing, changes nothing in the menu, and is not an error.
    expect(tracing.startRecording).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    expect(isRecordingTrace()).toBe(false)
    expect(dialogs.showErrorBox).not.toHaveBeenCalled()
  })

  it('starts only once the user has confirmed, and still records every category', async () => {
    dialogs.showMessageBox.mockResolvedValue({ response: 0 })
    const changed = vi.fn()
    await recordTrace(window, changed)
    expect(tracing.startRecording).toHaveBeenCalledTimes(1)
    expect(tracing.startRecording).toHaveBeenCalledWith({ included_categories: ['*'] })
    expect(dialogs.showMessageBox.mock.invocationCallOrder[0]!).toBeLessThan(tracing.startRecording.mock.invocationCallOrder[0]!)
    expect(isRecordingTrace()).toBe(true)
    expect(changed).toHaveBeenCalledTimes(1)
    // The second box is the existing “recording under way” one, not the warning again.
    expect(dialogs.showMessageBox).toHaveBeenCalledTimes(2)
    expect(dialogOptions(1).type).toBe('info')
  })

  it('does not warn again to stop: choosing the entry again saves the trace where the user says', async () => {
    dialogs.showMessageBox.mockResolvedValue({ response: 0 })
    await recordTrace(window, () => {})
    dialogs.showMessageBox.mockClear()
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: traceFile() })
    const changed = vi.fn()
    await recordTrace(window, changed)
    expect(dialogs.showMessageBox).not.toHaveBeenCalled()
    expect(tracing.stopRecording).toHaveBeenCalledWith(traceFile())
    expect(systemShell.showItemInFolder).toHaveBeenCalledWith(traceFile())
    expect(isRecordingTrace()).toBe(false)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('says in the save panel itself what the trace holds and that the Desktop is only suggested, with no second box', async () => {
    dialogs.showMessageBox.mockResolvedValue({ response: 0 })
    await recordTrace(window, () => {})
    dialogs.showMessageBox.mockClear()
    dialogs.showSaveDialog.mockReset().mockResolvedValue({ canceled: false, filePath: traceFile() })
    await recordTrace(window, () => {})
    const options = dialogs.showSaveDialog.mock.calls[0]![1] as { message: string; defaultPath: string }
    expect(options.message).toMatch(/adresses des pages visitées/)
    expect(options.message).toMatch(/Bureau/)
    expect(options.message).toMatch(/relisez la trace/)
    expect(options.defaultPath).toMatch(/lucium-trace-.*\.json$/)
    expect(dialogs.showMessageBox).not.toHaveBeenCalled()
  })

  it('tells the user, and records nothing, when Chromium refuses to start', async () => {
    dialogs.showMessageBox.mockResolvedValue({ response: 0 })
    tracing.startRecording.mockRejectedValue(new Error('already tracing'))
    await recordTrace(window, () => {})
    expect(isRecordingTrace()).toBe(false)
    expect(dialogs.showErrorBox).toHaveBeenCalledWith('Trace impossible', 'already tracing')
  })
})
