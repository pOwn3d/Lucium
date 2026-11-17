// The copies of the session on disk keep the Back lists of the archived tabs. Clearing the history or a site edits them in place.
// Real files in a throw-away folder; the rules of the text of one copy are in shared/session-backups-forget.test.ts.

import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArchivedTab, ClosedHistory, SidebarState } from '@shared/model'
import { backupPlan } from '@shared/backup-settings'
import { copyDataOf, serializeCopy } from '@shared/session-backups'
import { createInitialState } from '@shared/sidebar'
import { BackupFiles } from '../backup-store'
import { SessionBackups } from './backups'
import { tempDir } from '../temp-dir'

// A rename that can be made to fail: the edited copy is written under another name first, so a failure must leave the copy as it was.
const renaming = vi.hoisted(() => ({ fail: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (renaming.fail) throw new Error('forced: the rename failed')
      return actual.renameSync(from, to)
    }
  }
})

const at = (host: string, n: number) => ({ url: `https://${host}/p${n}`, title: `${host} ${n}` })
const longList = (): ClosedHistory => ({ entries: [at('bank.example', 1), at('news.example', 2), at('mail.example', 3)], index: 2 })
const archived = (id: string, spaceId: string, history?: ClosedHistory): ArchivedTab => ({ id, spaceId, url: 'https://mail.example/p3', title: id, archivedAt: 7, ...(history ? { history } : {}) })

function sessionState(): SidebarState {
  const base = createInitialState({ now: 1, newId: () => 'sp' })
  const work = { ...base.spaces[0]!, id: 'work-space', profileId: 'work' }
  return { ...base, spaces: [base.spaces[0]!, work], archive: [archived('home-1', 'sp', longList()), archived('work-1', 'work-space', longList())] }
}

let errors: unknown[][]
beforeEach(() => {
  renaming.fail = false
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args))
})
afterEach(() => vi.restoreAllMocks())

/** Copies on disk (two of them, from two moments), and the service that edits them. */
function setup() {
  const dir = join(tempDir('lucium-forget-'), 'copies')
  const files = new BackupFiles(dir)
  const state = sessionState()
  files.write({ createdAt: 1_700_000_000_000, reason: 'auto', data: copyDataOf(state) }, 10)
  files.write({ createdAt: 1_700_000_100_000, reason: 'quit', data: copyDataOf(state) }, 10)
  const service = new SessionBackups({ files, state: () => state, subscribe: () => () => {}, apply: () => {}, toast: () => {} })
  const texts = () => files.ids().map((id) => readFileSync(join(dir, `${id}.json`), 'utf8'))
  return { dir, files, service, texts }
}
const historiesIn = (text: string): string[] => (JSON.parse(text) as { data: { archive: Array<{ id: string; history?: unknown }> } }).data.archive.filter((entry) => entry.history !== undefined).map((entry) => entry.id)

describe('forgetting the pages in the copies on disk', () => {
  it('edits every copy: the lists of the profile are gone, the other profile’s are not, and the archived tabs stay', () => {
    const t = setup()
    expect(t.texts().every((text) => text.includes('bank.example'))).toBe(true)
    expect(t.service.forgetPages({ profileId: 'default' })).toEqual({ rewritten: 2, left: 0 })
    for (const text of t.texts()) {
      expect(historiesIn(text)).toEqual(['work-1'])
      expect((JSON.parse(text) as { data: { archive: unknown[] } }).data.archive).toHaveLength(2)
    }
  })

  it('takes only a site’s pages out when a site is named, in every copy', () => {
    const t = setup()
    t.service.forgetPages({ profileId: 'default', site: { host: 'bank.example', subdomains: false } })
    for (const text of t.texts()) {
      const archive = (JSON.parse(text) as { data: { archive: Array<{ id: string; history: { entries: Array<{ url: string }> } }> } }).data.archive
      expect(archive.find((entry) => entry.id === 'home-1')!.history.entries.map((page) => page.url)).toEqual(['https://news.example/p2', 'https://mail.example/p3'])
      expect(archive.find((entry) => entry.id === 'work-1')!.history.entries).toHaveLength(3)
    }
  })

  it('edits them whether the automatic copies are on or not: the files stay when the function is switched off', () => {
    const t = setup()
    const off = { ...sessionState(), settings: { ...sessionState().settings, autoBackup: false } }
    expect(backupPlan(off.settings).enabled).toBe(false)
    const service = new SessionBackups({ files: t.files, state: () => off, subscribe: () => () => {}, apply: () => {}, toast: () => {} })
    expect(service.forgetPages({ profileId: 'default' }).rewritten).toBe(2)
  })

  it('keeps the name, the date and the mode of the copies and leaves no temporary file', () => {
    const t = setup()
    const before = readdirSync(t.dir).sort()
    t.service.forgetPages({ profileId: 'default' })
    expect(readdirSync(t.dir).sort()).toEqual(before)
    for (const id of t.files.ids()) expect(statSync(join(t.dir, `${id}.json`)).mode & 0o777).toBe(0o600)
    expect(t.files.list().entries.map((entry) => entry.createdAt)).toEqual([1_700_000_100_000, 1_700_000_000_000])
  })

  it('writes nothing for a copy that holds nothing to forget', () => {
    const t = setup()
    const before = t.texts()
    expect(t.service.forgetPages({ profileId: 'nobody' })).toEqual({ rewritten: 0, left: 0 })
    expect(t.texts()).toEqual(before)
  })

  it('leaves a copy it cannot edit as it was, counts it, says why, and goes on with the others', () => {
    const t = setup()
    const [newest, oldest] = t.files.ids()
    writeFileSync(join(t.dir, `${oldest}.json`), 'this is not a copy')
    const result = t.service.forgetPages({ profileId: 'default' })
    expect(result).toEqual({ rewritten: 1, left: 1 })
    expect(readFileSync(join(t.dir, `${oldest}.json`), 'utf8')).toBe('this is not a copy')
    expect(historiesIn(readFileSync(join(t.dir, `${newest}.json`), 'utf8'))).toEqual(['work-1'])
    expect(errors.map((e) => String(e[0])).join('\n')).toMatch(/was not edited/)
    expect(errors.map((e) => String(e[0])).join('\n')).toMatch(/could not be cleaned of the pages of the closed tabs and still hold them/)
  })

  it('keeps a copy whole when the file cannot be put in place: the old one is there, no half-written file', () => {
    const t = setup()
    const before = t.texts()
    renaming.fail = true
    const result = t.service.forgetPages({ profileId: 'default' })
    renaming.fail = false
    expect(result).toEqual({ rewritten: 0, left: 2 })
    expect(t.texts()).toEqual(before)
    expect(readdirSync(t.dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(errors.map((e) => String(e[0])).join('\n')).toMatch(/could not be edited \(forced: the rename failed\)/)
  })

  it('counts a copy it cannot even read, and does not throw', () => {
    const t = setup()
    const [newest] = t.files.ids()
    chmodSync(join(t.dir, `${newest}.json`), 0o000)
    try {
      const result = t.service.forgetPages({ profileId: 'default' })
      // As root a read goes through; elsewhere it is counted as left. Either way nothing throws and the other copy is edited.
      expect(result.rewritten + result.left).toBe(2)
    } finally {
      chmodSync(join(t.dir, `${newest}.json`), 0o600)
    }
  })

  it('does nothing when there is no folder of copies', () => {
    const files = new BackupFiles(join(tempDir('lucium-forget-none-'), 'never-made'))
    const service = new SessionBackups({ files, state: sessionState, subscribe: () => () => {}, apply: () => {}, toast: () => {} })
    expect(service.forgetPages({ profileId: 'default' })).toEqual({ rewritten: 0, left: 0 })
    expect(existsSync(files.dir)).toBe(false)
  })

  it('reaches an entry through the spaces of the profile today, when the copy gives its space to another profile', () => {
    const t = setup()
    // Today the "work-space" belongs to the default profile: its lists in the older copies were browsed there.
    const today = sessionState()
    const moved = { ...today, spaces: today.spaces.map((space) => (space.id === 'work-space' ? { ...space, profileId: 'default' } : space)) }
    const service = new SessionBackups({ files: t.files, state: () => moved, subscribe: () => () => {}, apply: () => {}, toast: () => {} })
    service.forgetPages({ profileId: 'default' })
    for (const text of t.texts()) expect(historiesIn(text)).toEqual([])
  })
})

// Used by the copies written before this version existed: the format is the same, only the text is edited (serializeCopy is the writer of both).
describe('the edited copy is still a copy', () => {
  it('is read back by the application with the lists gone and the tabs there', () => {
    const t = setup()
    t.service.forgetPages({ profileId: 'default' })
    const listed = t.files.list()
    expect(listed.unreadable).toBe(0)
    expect(listed.entries).toHaveLength(2)
    const read = t.files.read(t.files.ids()[0]!)
    expect(read.data.archive.map((entry) => [entry.id, entry.history !== undefined])).toEqual([['home-1', false], ['work-1', true]])
    expect(serializeCopy(read)).toContain('work-1')
  })
})
