// The boxes of « Exporter cet espace… » and « Importer un espace… », in their order, over a fake Electron: what each answer leads to, and what is written.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dialog = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn(),
  showErrorBox: vi.fn()
}))
const lock = vi.hoisted(() => ({ spaces: [] as string[] }))
vi.mock('electron', () => ({ dialog, app: { getPath: () => tmpdir() } }))
vi.mock('../lock-service', () => ({ getLockService: () => ({ lockedSpaces: () => lock.spaces }) }))

import { setLanguage, t } from '@shared/i18n'
import { createInitialState, reduce, type Ctx } from '@shared/sidebar'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { exportSpace, importSpace } from './space-transfer'

const ctx: Ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
let state = createInitialState(ctx)
state = reduce(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 }, ctx)
const work = state.activeSpaceId
state = reduce(state, { type: 'tab/open', url: 'https://a.example/', spaceId: work }, ctx)

const folder = mkdtempSync(join(tmpdir(), 'lucium-space-transfer-'))

const setup = () => {
  const dispatch = vi.fn()
  const toast = vi.fn()
  const askPassphrase = vi.fn()
  const browser = { dispatch, showToast: toast, askPassphrase, isPrivate: () => false } as unknown as Browser
  const store = { root: () => ({ get: () => state }), get: () => state } as unknown as StateStore
  return { dispatch, toast, askPassphrase, browser, store }
}

beforeEach(() => {
  for (const fn of Object.values(dialog)) fn.mockReset()
  lock.spaces = []
  setLanguage('fr')
})

describe('exporting a space', () => {
  it('asks to seal, then the phrase twice, then where to write, and writes a sealed file only the user reads', async () => {
    const { browser, store, askPassphrase, toast } = setup()
    const path = join(folder, 'sealed.json')
    dialog.showMessageBox.mockResolvedValue({ response: 0 })
    askPassphrase.mockResolvedValue('une phrase assez longue')
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path })
    await exportSpace(browser, store, {} as never, work)
    expect(askPassphrase).toHaveBeenCalledTimes(2)
    expect(readFileSync(path, 'utf8')).not.toContain('a.example')
    expect(toast).toHaveBeenCalledTimes(1)
    expect(dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('writes the plain file without asking for a phrase when « Sans chiffrement » is chosen', async () => {
    const { browser, store, askPassphrase } = setup()
    const path = join(folder, 'plain.json')
    dialog.showMessageBox.mockResolvedValue({ response: 1 })
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path })
    await exportSpace(browser, store, {} as never, work)
    expect(askPassphrase).not.toHaveBeenCalled()
    expect(readFileSync(path, 'utf8')).toContain('https://a.example/')
  })

  it('stops at « Annuler », at a phrase refused, and at a file name not given: nothing is written', async () => {
    const first = setup()
    dialog.showMessageBox.mockResolvedValue({ response: 2 })
    await exportSpace(first.browser, first.store, {} as never, work)
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()

    const second = setup()
    dialog.showMessageBox.mockResolvedValue({ response: 0 })
    second.askPassphrase.mockResolvedValue(null)
    await exportSpace(second.browser, second.store, {} as never, work)
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()

    const third = setup()
    dialog.showMessageBox.mockResolvedValue({ response: 1 })
    dialog.showSaveDialog.mockResolvedValue({ canceled: true })
    await exportSpace(third.browser, third.store, {} as never, work)
    expect(third.toast).not.toHaveBeenCalled()
  })

  it('refuses a locked space before any box is shown, and says why', async () => {
    const { browser, store } = setup()
    lock.spaces = [work]
    await exportSpace(browser, store, {} as never, work)
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
    expect(dialog.showErrorBox).toHaveBeenCalledWith(t('space-transfer.exportation-impossible'), t('lock.deverrouillez-l-espace-d-abord'))
  })
})

describe('importing a space', () => {
  it('does nothing when the file box is cancelled', async () => {
    const { browser, store, dispatch } = setup()
    dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await importSpace(browser, store, {} as never)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('tells why a file that is not a space cannot be imported', async () => {
    const { browser, store, dispatch } = setup()
    const path = join(folder, 'other.json')
    writeFileSync(path, '{"hello":1}')
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] })
    await importSpace(browser, store, {} as never)
    expect(dialog.showErrorBox).toHaveBeenCalledWith(t('space-transfer.importation-impossible'), expect.any(String))
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reads back a file it wrote, and dispatches the space once', async () => {
    const out = setup()
    const path = join(folder, 'roundtrip.json')
    dialog.showMessageBox.mockResolvedValue({ response: 1 })
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path })
    await exportSpace(out.browser, out.store, {} as never, work)

    const { browser, store, dispatch } = setup()
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] })
    await importSpace(browser, store, {} as never)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ type: 'space/import', aside: { space: { name: 'Travail' } } })
  })
})
