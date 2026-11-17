// The export as a file, and the restore that reads it: plain as before, sealed with a passphrase, and every way a chosen file can be wrong.

import { truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { restoredState } from '@shared/sidebar'
import { EXPORT_FILE_MAX, decryptExport, encryptExport, type ScryptParams } from './export-crypto'
import { PASSPHRASE_TRIES, exportText, finishRestore, openExportFile, parseExportRequest } from './export-file'
import { configureNotes } from './notes-store'
import { notesFileText } from '@shared/notes'
import { tempDir } from './temp-dir'

const CHEAP: ScryptParams = { N: 2 ** 14, r: 8, p: 1 }
const PHRASE = 'une phrase secrète assez longue'
const state = () => {
  const initial = createInitialState({ now: 1, newId: () => 'e1' })
  return { ...initial, tabs: [{ id: 't1', spaceId: 'e1', url: 'https://confidentiel.example/compte', title: 'Mon compte', pinned: false, createdAt: 1, lastActiveAt: 1 }] }
}

let dir = ''
let logged: string[] = []
beforeEach(() => {
  dir = tempDir('lucium-export-')
  logged = []
  for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
})
afterEach(() => vi.restoreAllMocks())

const write = (name: string, text: string): string => {
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

describe('exportText', () => {
  it('writes plain JSON, as always, when there is no passphrase', async () => {
    const { text, encrypted } = await exportText(state(), null)
    expect(encrypted).toBe(false)
    expect(JSON.parse(text)).toMatchObject({ version: 1 })
    expect(text).toContain('confidentiel.example')
  })

  it('seals it when there is one: nothing of the content in the file, and the same state comes back', async () => {
    const { text, encrypted } = await exportText(state(), PHRASE, { params: CHEAP })
    expect(encrypted).toBe(true)
    expect(text).not.toContain('confidentiel')
    expect(text).not.toContain(PHRASE)
    expect(restoredState(JSON.parse(await decryptExport(JSON.parse(text), PHRASE)))?.tabs[0]?.url).toBe('https://confidentiel.example/compte')
  })

  it('leaves the lock out of the file in both forms: it is this installation\'s, and a file must not switch one on or off', async () => {
    const locked = { ...state(), settings: { ...defaultSettings(), lockEnabled: true, lockApp: true, lockedSpaces: ['e1'], lockTouchId: false } }
    const plain = JSON.parse((await exportText(locked, null)).text) as { settings: Record<string, unknown> }
    expect(plain.settings).toMatchObject({ lockEnabled: false, lockApp: false, lockedSpaces: [], lockTouchId: true })
    const sealed = JSON.parse(await decryptExport(JSON.parse((await exportText(locked, PHRASE, { params: CHEAP })).text), PHRASE)) as { settings: Record<string, unknown> }
    expect(sealed.settings).toMatchObject({ lockEnabled: false, lockedSpaces: [] })
  })

  it('refuses a passphrase that is too short rather than writing a file that protects nothing', async () => {
    await expect(exportText(state(), 'court', { params: CHEAP })).rejects.toMatchObject({ kind: 'weak-passphrase' })
  })

  it('adds the quick notes of notes.json while their function is on, and the file still restores as the state it holds', async () => {
    const notes = [{ id: 'n1', text: 'à exporter', createdAt: 1, updatedAt: 2, link: { kind: 'page' as const, url: 'https://example.org/' } }]
    configureNotes(write('notes.json', notesFileText(notes)))
    const plain = JSON.parse((await exportText(state(), null)).text) as { notes?: unknown }
    expect(plain.notes).toEqual(notes)
    expect(restoredState(plain)?.tabs[0]?.url).toBe('https://confidentiel.example/compte')
    const sealed = JSON.parse(await decryptExport(JSON.parse((await exportText(state(), PHRASE, { params: CHEAP })).text), PHRASE)) as { notes?: unknown }
    expect(sealed.notes).toEqual(notes)
    // Off, the export is the one of before, and notes.json is not read.
    const off = { ...state(), settings: { ...defaultSettings(), notes: false } }
    expect(JSON.parse((await exportText(off, null)).text)).not.toHaveProperty('notes')
    // No note: nothing is added either.
    expect(JSON.parse((await exportText(state(), null, undefined, [])).text)).not.toHaveProperty('notes')
  })
})

describe('parseExportRequest', () => {
  it('reads nothing, or a passphrase, and refuses anything else', () => {
    expect(parseExportRequest(undefined)).toEqual({ ok: true, passphrase: null })
    expect(parseExportRequest(null)).toEqual({ ok: true, passphrase: null })
    expect(parseExportRequest({})).toEqual({ ok: true, passphrase: null })
    expect(parseExportRequest({ passphrase: 'abc' })).toEqual({ ok: true, passphrase: 'abc' })
    for (const hostile of ['text', 42, [], { passphrase: 42 }, { passphrase: {} }, { passphrase: ['a'] }]) expect(parseExportRequest(hostile).ok, JSON.stringify(hostile)).toBe(false)
  })
})

describe('openExportFile', () => {
  it('opens a plain export as it always did, without asking anything', async () => {
    const path = write('plain.json', JSON.stringify(state()))
    const ask = vi.fn()
    const opened = await openExportFile(path, ask)
    expect(opened).toMatchObject({ ok: true, encrypted: false })
    expect(ask).not.toHaveBeenCalled()
  })

  it('opens a sealed export with its passphrase', async () => {
    const path = write('sealed.json', (await exportText(state(), PHRASE, { params: CHEAP })).text)
    const ask = vi.fn().mockResolvedValue(PHRASE)
    const opened = await openExportFile(path, ask)
    expect(opened).toMatchObject({ ok: true, encrypted: true })
    expect(restoredState((opened as { value: unknown }).value)?.spaces).toHaveLength(1)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask).toHaveBeenCalledWith(null)
  })

  it('asks again, saying the last one was wrong, and then opens', async () => {
    const path = write('sealed.json', (await exportText(state(), PHRASE, { params: CHEAP })).text)
    const ask = vi.fn().mockResolvedValueOnce('phrase fausse mais assez longue').mockResolvedValueOnce(PHRASE)
    const opened = await openExportFile(path, ask)
    expect(opened.ok).toBe(true)
    expect(ask).toHaveBeenNthCalledWith(2, expect.stringMatching(/incorrecte/))
  })

  it('gives up after a few wrong passphrases, and says so', async () => {
    const path = write('sealed.json', (await exportText(state(), PHRASE, { params: CHEAP })).text)
    const ask = vi.fn().mockResolvedValue('toujours la mauvaise phrase')
    const opened = await openExportFile(path, ask)
    expect(opened).toMatchObject({ ok: false, message: expect.stringMatching(/incorrecte[^]*5 essais/) })
    expect(ask).toHaveBeenCalledTimes(PASSPHRASE_TRIES)
  })

  it('reads nothing when the user cancels the question', async () => {
    const path = write('sealed.json', (await exportText(state(), PHRASE, { params: CHEAP })).text)
    expect(await openExportFile(path, async () => null)).toMatchObject({ ok: false, cancelled: true })
  })

  it('stops at once, without asking again, when the file was altered, and tells so', async () => {
    const text = (await exportText(state(), PHRASE, { params: CHEAP })).text
    const envelope = JSON.parse(text) as { data: string }
    const bytes = Buffer.from(envelope.data, 'base64')
    bytes[10] = bytes[10]! ^ 1
    const path = write('altered.json', JSON.stringify({ ...envelope, data: bytes.toString('base64') }))
    const ask = vi.fn().mockResolvedValue(PHRASE)
    const opened = await openExportFile(path, ask)
    expect(opened).toMatchObject({ ok: false, message: expect.stringMatching(/altéré/) })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(logged.some((line) => line.includes('tampered'))).toBe(true)
  })

  it('refuses a file that asks for an absurd cost before it asks the user for anything (this fails if the bounds are not checked first)', async () => {
    const envelope = JSON.parse((await exportText(state(), PHRASE, { params: CHEAP })).text) as { kdf: Record<string, unknown> }
    const path = write('hostile.json', JSON.stringify({ ...envelope, kdf: { ...envelope.kdf, N: 2 ** 30 } }))
    const ask = vi.fn().mockResolvedValue(PHRASE)
    const opened = await openExportFile(path, ask)
    expect(opened).toMatchObject({ ok: false, message: expect.stringMatching(/démesuré/) })
    expect(ask).not.toHaveBeenCalled()
  })

  it('refuses a file larger than any export, without reading it', async () => {
    const path = join(dir, 'huge.json')
    writeFileSync(path, '{}')
    truncateSync(path, EXPORT_FILE_MAX + 1)
    const opened = await openExportFile(path, vi.fn())
    expect(opened).toMatchObject({ ok: false, message: expect.stringMatching(/trop volumineux/) })
  })

  it('tells where the problem is, and logs it, when the file is not JSON or cannot be read', async () => {
    const notJson = await openExportFile(write('bad.json', '{"version": 1,'), vi.fn())
    expect(notJson).toMatchObject({ ok: false, message: expect.stringContaining('bad.json') })
    const missing = await openExportFile(join(dir, 'absent.json'), vi.fn())
    expect(missing).toMatchObject({ ok: false, message: expect.stringContaining('absent.json') })
    expect(logged.filter((line) => line.includes('[restore]'))).toHaveLength(2)
  })

  it('never writes the passphrase in the log, whatever fails', async () => {
    const secret = 'une phrase qui ne doit jamais être écrite'
    const path = write('sealed.json', (await exportText(state(), PHRASE, { params: CHEAP })).text)
    await openExportFile(path, async () => secret)
    expect(logged.length).toBeGreaterThan(0)
    expect(logged.join('\n')).not.toContain(secret)
    expect(logged.join('\n')).not.toContain(PHRASE)
  })

  it('opens what encryptExport wrote with the default cost too (the file a user really gets)', async () => {
    const path = write('default.json', await encryptExport(JSON.stringify(state()), PHRASE))
    expect(await openExportFile(path, async () => PHRASE)).toMatchObject({ ok: true, encrypted: true })
  })
})

describe('the end of a confirmed restore', () => {
  const steps = (refusal: string | null) => {
    const done: string[] = []
    return { done, steps: { refusal: () => refusal, backUpState: () => (done.push('copy'), null), notes: null, applyState: () => void done.push('state') } }
  }

  it('copies the present state, then replaces it', () => {
    const s = steps(null)
    expect(finishRestore(s.steps, null)).toEqual({ ok: true })
    expect(s.done).toEqual(['copy', 'state'])
  })

  it('restores nothing while a space is locked, makes no copy, and says why', () => {
    const s = steps('Déverrouillez vos espaces verrouillés avant de restaurer.')
    const result = finishRestore(s.steps, null)
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Déverrouillez vos espaces verrouillés avant de restaurer.') })
    expect((result as { message: string }).message).toContain('Rien n’a été restauré')
    expect(s.done).toEqual([])
    expect(logged.join('\n')).toContain('refused while a space is locked')
  })
})
