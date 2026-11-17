// A copy of the session holds the archive, and so the Back lists of the archived tabs. Clearing the history or a site edits the copies on disk
// (main/backup-store.ts, main/shell/backups.ts); this is the rule for the text of one copy.

import { describe, expect, it } from 'vitest'
import { copyAfterForgetting, copyDataOf, serializeCopy, type SessionCopy } from './session-backups'
import type { ArchivedTab, ClosedHistory } from './model'
import { createInitialState } from './sidebar'

const at = (host: string, n: number) => ({ url: `https://${host}/p${n}`, title: `${host} ${n}` })
const longList = (): ClosedHistory => ({ entries: [at('bank.example', 1), at('news.example', 2), at('mail.example', 3)], index: 2 })
const archived = (id: string, spaceId: string, url: string, history?: ClosedHistory): ArchivedTab => ({ id, spaceId, url, title: `Title of ${id}`, archivedAt: 7, ...(history ? { history } : {}) })

/** A copy with two spaces (the default profile's and a work profile's) and an archive with lists on both. */
function copyText(over: Partial<SessionCopy['data']> = {}, spaces?: unknown): string {
  const base = createInitialState({ now: 1, newId: () => 'sp' })
  const work = { ...base.spaces[0]!, id: 'work-space', profileId: 'work' }
  const data = copyDataOf({
    ...base,
    spaces: [base.spaces[0]!, work],
    archive: [archived('home-1', 'sp', 'https://mail.example/p3', longList()), archived('work-1', 'work-space', 'https://mail.example/p3', longList()), archived('bare', 'sp', 'https://news.example/x')]
  })
  const text = serializeCopy({ createdAt: 123, reason: 'auto', data: { ...data, ...over } })
  if (spaces === undefined) return text
  const raw = JSON.parse(text)
  raw.data.spaces = spaces
  return JSON.stringify(raw)
}
const archiveOf = (text: string): Array<Record<string, unknown>> => (JSON.parse(text) as { data: { archive: Array<Record<string, unknown>> } }).data.archive
const edited = (result: ReturnType<typeof copyAfterForgetting>): string => {
  if (result.kind !== 'changed') throw new Error(`expected a change, got ${result.kind}`)
  return result.text
}
const NO_CURRENT: ReadonlySet<string> = new Set()

describe('copyAfterForgetting', () => {
  it('drops the Back lists of the profile’s archived tabs and keeps the tabs, and every other part of the copy as it was', () => {
    const before = copyText()
    const after = edited(copyAfterForgetting(before, { profileId: 'default' }, NO_CURRENT))
    const lists = archiveOf(after).map((entry) => [entry['id'], 'history' in entry])
    expect(lists).toEqual([['home-1', false], ['work-1', true], ['bare', false]])
    expect(archiveOf(after).map((entry) => [entry['url'], entry['title'], entry['archivedAt']])).toEqual(archiveOf(before).map((entry) => [entry['url'], entry['title'], entry['archivedAt']]))
    const rest = (text: string) => ({ ...JSON.parse(text), data: { ...JSON.parse(text).data, archive: undefined } })
    expect(rest(after)).toEqual(rest(before))
  })

  it('takes a site’s pages out of the lists and leaves the lists of the other profile alone (this fails if the profile is not looked at)', () => {
    const after = edited(copyAfterForgetting(copyText(), { profileId: 'default', site: { host: 'bank.example', subdomains: false } }, NO_CURRENT))
    const byId = Object.fromEntries(archiveOf(after).map((entry) => [entry['id'], entry]))
    expect(byId['home-1']!['history']).toEqual({ entries: [at('news.example', 2), at('mail.example', 3)], index: 1 })
    expect(byId['work-1']!['history']).toEqual(longList())
  })

  it('leaves no trace of the site in the lists of its profile', () => {
    const after = edited(copyAfterForgetting(copyText(), { profileId: 'default', site: { host: 'bank.example', subdomains: false } }, NO_CURRENT))
    const homeEntries = archiveOf(after).filter((entry) => entry['spaceId'] === 'sp')
    expect(JSON.stringify(homeEntries)).not.toContain('bank.example')
  })

  it('answers "unchanged", and writes nothing, when the copy holds nothing of the kind', () => {
    expect(copyAfterForgetting(copyText(), { profileId: 'nobody' }, NO_CURRENT)).toEqual({ kind: 'unchanged' })
    expect(copyAfterForgetting(copyText(), { profileId: 'default', site: { host: 'unrelated.example', subdomains: false } }, NO_CURRENT)).toEqual({ kind: 'unchanged' })
    expect(copyAfterForgetting(copyText({ archive: [] }), { profileId: 'default' }, NO_CURRENT)).toEqual({ kind: 'unchanged' })
  })

  it('reaches an entry whose space is the profile’s today even if the copy put it in another (a space can change profile): the pages are the more forgotten, never the less', () => {
    const text = copyText()
    expect(copyAfterForgetting(text, { profileId: 'default' }, new Set(['work-space'])).kind).toBe('changed')
    const after = edited(copyAfterForgetting(text, { profileId: 'default' }, new Set(['work-space'])))
    expect(archiveOf(after).filter((entry) => 'history' in entry)).toEqual([])
  })

  it('takes an entry whose space the copy does not list for the default profile’s, as the state does', () => {
    const text = copyText({}, [])
    const after = edited(copyAfterForgetting(text, { profileId: 'default' }, NO_CURRENT))
    expect(archiveOf(after).filter((entry) => 'history' in entry)).toEqual([])
  })

  it('drops a list that is not a valid one with the rest: its pages would otherwise stay in the file', () => {
    const raw = JSON.parse(copyText())
    raw.data.archive[0].history = { entries: [{ url: 'https://bank.example/secret', title: 'x' }], index: 7 }
    const after = edited(copyAfterForgetting(JSON.stringify(raw), { profileId: 'default', site: { host: 'unrelated.example', subdomains: false } }, NO_CURRENT))
    expect(after).not.toContain('bank.example/secret')
  })

  it('leaves, and says why, what is not a copy of this version: not JSON, another format, another version, too big', () => {
    const scope = { profileId: 'default' }
    expect(copyAfterForgetting('not json', scope, NO_CURRENT)).toMatchObject({ kind: 'left' })
    expect(copyAfterForgetting(JSON.stringify({ format: 'something-else', version: 1, data: {} }), scope, NO_CURRENT)).toMatchObject({ kind: 'left' })
    expect(copyAfterForgetting(JSON.stringify({ ...JSON.parse(copyText()), version: 2 }), scope, NO_CURRENT)).toMatchObject({ kind: 'left' })
    expect(copyAfterForgetting('x'.repeat(33 * 1024 * 1024), scope, NO_CURRENT)).toMatchObject({ kind: 'left', why: 'too big' })
  })

  it('does not choke on a copy whose archive holds entries that are not objects', () => {
    const raw = JSON.parse(copyText())
    raw.data.archive.push(null, 42, 'text', [], { history: null })
    const after = edited(copyAfterForgetting(JSON.stringify(raw), { profileId: 'default' }, NO_CURRENT))
    expect(JSON.parse(after).data.archive.slice(-5)).toEqual([null, 42, 'text', [], { history: null }])
  })
})
