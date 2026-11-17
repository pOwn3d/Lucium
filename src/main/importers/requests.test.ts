import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { HistoryBook } from '../history'
import { countImportedHistory, historyProfileOfImport, mergeImportedHistory, mergeImportedHistoryTracked } from './history-target'
import { privateImportMessage, confirmImport, importRequest, listImportSources, undoImport, type ImportEnv } from './requests'
import { ImportService } from './service'

const root = mkdtempSync(join(tmpdir(), 'lucium-import-requests-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// A service over an empty home that records what it is asked: the point is what the requests do before it is reached, and which profile it sees.
function fixture() {
  const book = new HistoryBook(join(root, 'histories'))
  const calls: string[] = []
  const ctx = { now: 1, newId: () => 'x' }
  const service = new ImportService({
    home: join(root, 'home'),
    ctx: () => ctx,
    dispatch: () => undefined,
    state: () => createInitialState(ctx),
    mergeHistory: (entries: HistoryEntry[]) => mergeImportedHistory(book, entries),
    countHistory: (entries) => countImportedHistory(book, entries),
    mergeHistoryTracked: (entries) => mergeImportedHistoryTracked(book, entries),
    chooseFile: async () => null
  })
  for (const method of ['run', 'preview', 'commit', 'undo', 'listSources'] as const) {
    const original = service[method].bind(service) as (...args: unknown[]) => unknown
    vi.spyOn(service, method).mockImplementation(((...args: unknown[]) => (calls.push(method), original(...args))) as never)
  }
  const env = (over: Partial<ImportEnv> = {}): ImportEnv => ({ service, isPrivate: false, historyProfile: 'default', ...over })
  return { service, env, calls, book }
}

describe('the import messages of a private window', () => {
  it('are refused with a sentence, and never reach the service', async () => {
    const { env, calls } = fixture()
    const priv = env({ isPrivate: true })
    const request = { source: 'chrome', categories: ['bookmarks'] }
    expect(await importRequest(priv, 'run', request)).toMatchObject({ ok: false, message: privateImportMessage() })
    expect(await importRequest(priv, 'preview', request)).toMatchObject({ ok: false, message: privateImportMessage() })
    expect(confirmImport(priv, '00000000-0000-0000-0000-000000000000')).toMatchObject({ ok: false, message: privateImportMessage() })
    expect(undoImport(priv, '00000000-0000-0000-0000-000000000000')).toMatchObject({ ok: false, message: privateImportMessage() })
    expect(listImportSources(priv)).toEqual([])
    expect(calls).toEqual([])
  })

  it('are served in a normal window', () => {
    const { env, calls } = fixture()
    expect(listImportSources(env()).map((s) => s.id)).toEqual(['safari', 'html', 'other'])
    expect(calls).toEqual(['listSources'])
  })
})

describe('a request that is not what the sheet sends', () => {
  it('is refused before the service is asked', async () => {
    const { env, calls } = fixture()
    for (const bad of [null, 'chrome', { source: 'chrome' }, { source: 'chrome', categories: ['passwords'] }, { source: 'chrome', categories: ['bookmarks'], path: '/etc/passwd', profile: 5 }]) {
      expect(await importRequest(env(), 'preview', bad), JSON.stringify(bad)).toMatchObject({ ok: false, message: 'Demande d’import invalide.' })
      expect(await importRequest(env(), 'run', bad), JSON.stringify(bad)).toMatchObject({ ok: false, message: 'Demande d’import invalide.' })
    }
    expect(calls).toEqual([])
  })

  it('has to give a key as the main process makes them to confirm or to undo', () => {
    const { env, calls } = fixture()
    for (const bad of [undefined, null, 5, {}, '', 'x', '../../etc/passwd', 'ABCDEF01-0000-0000-0000-000000000000', 'a'.repeat(65)]) {
      expect(confirmImport(env(), bad), String(bad)).toMatchObject({ ok: false, message: 'Demande d’import invalide.' })
      expect(undoImport(env(), bad), String(bad)).toMatchObject({ ok: false, message: 'Demande d’annulation invalide.' })
    }
    expect(calls).toEqual([])
  })

  it('reaches the service when it is exactly what the sheet sends', async () => {
    const { env, calls } = fixture()
    await importRequest(env(), 'preview', { source: 'safari', categories: ['history'] })
    expect(calls).toEqual(['preview'])
    expect(confirmImport(env(), '00000000-0000-0000-0000-000000000000').message).toContain('plus valable')
    expect(undoImport(env(), '00000000-0000-0000-0000-000000000000').message).toContain('ne peut plus être annulé')
    expect(calls).toEqual(['preview', 'commit', 'undo'])
  })

  it('answers that the import is unavailable when there is no service', async () => {
    const { env } = fixture()
    expect(await importRequest(env({ service: null }), 'preview', { source: 'chrome', categories: ['bookmarks'] })).toMatchObject({ ok: false })
    expect(listImportSources(env({ service: null }))).toEqual([])
  })
})

describe('the profile of the pages of the history', () => {
  it('is the one the window was in, for the run, the preview, the confirmation and the undo', async () => {
    const { service, env } = fixture()
    const seen: string[] = []
    const answer = { ok: true, message: '', bookmarks: 0, folders: 0, history: 0, skipped: 0 }
    for (const method of ['run', 'preview'] as const) {
      vi.spyOn(service, method).mockImplementation(async () => (seen.push(`${method}:${historyProfileOfImport()}`), answer))
    }
    for (const method of ['commit', 'undo'] as const) {
      vi.spyOn(service, method).mockImplementation(() => (seen.push(`${method}:${historyProfileOfImport()}`), answer))
    }
    const where = env({ historyProfile: 'travail' })
    const request = { source: 'safari', categories: ['history'] }
    const key = '00000000-0000-0000-0000-000000000000'
    await importRequest(where, 'run', request)
    await importRequest(where, 'preview', request)
    confirmImport(where, key)
    undoImport(where, key)
    expect(seen).toEqual(['run:travail', 'preview:travail', 'commit:travail', 'undo:travail'])
    expect(historyProfileOfImport()).toBe('default')
  })
})
