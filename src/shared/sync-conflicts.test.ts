// The journal of the settled conflicts and the sentences of « Conflit réglé » (sync-conflicts.ts, docs/synchronisation.md §11.7.3 and §13.4). The cases that
// LuciumKit plays too are written to ios/Contracts/sync-conflict-vectors.json as a file snapshot of this test.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from './i18n-en'
import { fr } from './i18n-fr'
import { mergeSnapshots, type SyncConflict } from './sync-merge'
import { draws } from './sync-merge-draws.test-support'
import { emptySnapshot, parseSnapshot, type SyncSnapshot } from './sync-snapshot'
import {
  addToJournal,
  clip,
  JOURNAL_LIMITS,
  FIELD_KEYS,
  KIND_KEYS,
  SETTING_KEYS,
  labelOf,
  lastSession,
  parseJournal,
  pruneJournal,
  removeFromJournal,
  serializeJournal,
  renderText,
  settleConflicts,
  stampTime,
  formatWhen,
  viewOf,
  type Platform,
  type SettledConflict,
} from './sync-conflicts'

const NOW = 1790000100000
const DAY = 24 * 60 * 60 * 1000
const M = '1790000000001-0000-mac'

const mergeVectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/sync-merge-vectors.json'), 'utf8')) as {
  cases: { name: string; base: SyncSnapshot | null; local: SyncSnapshot; remote: SyncSnapshot; withheld: string[]; expect: { conflicts: SyncConflict[] } }[]
}
const read = (snapshot: unknown): SyncSnapshot => {
  const parsed = parseSnapshot(snapshot)
  if ('problem' in parsed) throw new Error(parsed.problem)
  return parsed.snapshot
}
const vector = (prefix: string) => {
  const found = mergeVectors.cases.find((c) => c.name.startsWith(prefix))
  if (found === undefined) throw new Error(`no vector "${prefix}"`)
  return found
}
/** The settled lines of a merge vector, this device being the Mac (the peer is the iPhone) unless said. */
function settled(prefix: string, peer: Platform = 'ios'): SettledConflict[] {
  const c = vector(prefix)
  const local = read(c.local)
  const remote = read(c.remote)
  const merged = mergeSnapshots(c.base === null ? null : read(c.base), local, remote, c.withheld)
  return settleConflicts({ conflicts: merged.conflicts, local, remote, merged: merged.snapshot, now: NOW, peer })
}

describe('sync conflicts: what the merge settled, as the journal keeps it', () => {
  it('keeps both versions of a field, who won, when each side changed it, and what puts the other back', () => {
    const [line] = settled('the same field changed differently')
    expect(line).toEqual({
      id: '["space","s1","name"]',
      settledAt: NOW,
      peer: 'ios',
      kind: 'space',
      entityId: 's1',
      field: 'name',
      reason: 'newer',
      winner: 'remote',
      label: 'Boulot',
      kept: { t: 'text', text: 'Boulot' },
      lost: { t: 'text', text: 'Pro' },
      keptAt: 1790000000007,
      lostAt: 1790000000003,
      restore: { type: 'set', kind: 'space', id: 's1', field: 'name', value: 'Pro' },
    })
  })

  it('turns the sides around for the other device: the same conflict, the winner the other way, the same restore', () => {
    const c = vector('the same field changed differently')
    const local = read(c.local)
    const remote = read(c.remote)
    const back = mergeSnapshots(read(c.base), remote, local)
    const [line] = settleConflicts({ conflicts: back.conflicts, local: remote, remote: local, merged: back.snapshot, now: NOW, peer: 'mac' })
    expect(line?.winner).toBe('local')
    expect(line?.peer).toBe('mac')
    expect(line?.kept).toEqual({ t: 'text', text: 'Boulot' })
    expect(line?.restore).toEqual({ type: 'set', kind: 'space', id: 's1', field: 'name', value: 'Pro' })
  })

  it('keeps a deletion that lost as « kept », with the name of the thing and a restore that deletes it', () => {
    const [line] = settled('deleted on one side, modified on the other')
    expect(line).toMatchObject({
      reason: 'modification-over-deletion',
      winner: 'remote',
      field: null,
      label: 'Gardé',
      kept: { t: 'absent' },
      lost: { t: 'absent' },
      keptAt: 1790000000006,
      lostAt: 1790000000008,
      restore: { type: 'delete', kind: 'tab', id: 't1' },
    })
  })

  it('names a folder that was kept because a tab moved into it (the mockup: « Gardé dans « Réunions », sur les deux appareils »)', () => {
    const lines = settled('a folder deleted on one side while a tab moves into it')
    expect(lines.map((l) => [l.kind, l.id, l.label, l.reason])).toEqual([['folder', '["folder","f1",null]', 'Réunions', 'modification-over-deletion']])
  })

  it('shows the folder a tab was put in by its name, and nothing for a folder that cannot be named', () => {
    const base = { entities: { space: { s1: { fields: { name: 'S' }, stamps: { name: M } } }, folder: { f1: { fields: { spaceId: 's1', name: 'Réunions' }, stamps: { spaceId: M, name: M } }, f2: { fields: { spaceId: 's1', name: 'Lecture' }, stamps: { spaceId: M, name: M } } }, tab: { t1: { fields: { spaceId: 's1', pinned: true, anchorUrl: 'https://a.example/' }, stamps: { spaceId: M, pinned: M, anchorUrl: M } } } } }
    const tab = (folderId: string, mark: string) => ({ ...base, entities: { ...base.entities, tab: { t1: { fields: { spaceId: 's1', pinned: true, anchorUrl: 'https://a.example/', folderId }, stamps: { spaceId: M, pinned: M, anchorUrl: M, folderId: mark } } } } })
    const local = read(tab('f1', '1790000000003-0000-mac'))
    const remote = read(tab('f2', '1790000000007-0000-phone'))
    const merged = mergeSnapshots(read(base), local, remote)
    const [line] = settleConflicts({ conflicts: merged.conflicts, local, remote, merged: merged.snapshot, now: NOW, peer: 'ios' })
    expect(line).toMatchObject({ field: 'folderId', kept: { t: 'text', text: 'Lecture' }, lost: { t: 'text', text: 'Réunions' }, restore: { type: 'set', field: 'folderId', value: 'f1' } })
    const gone = settleConflicts({ conflicts: merged.conflicts, local, remote, merged: emptySnapshot(), now: NOW, peer: 'ios' })[0]
    expect(gone?.kept.t === 'complex' || gone?.kept.t === 'text').toBe(true)
  })

  it('keeps the list that lost, to put it back, with the name of the space it is in', () => {
    const lines = settled('order: both reorder')
    const line = lines.find((l) => l.kind === 'order')
    expect(line).toMatchObject({ reason: 'order', field: null, kept: { t: 'complex' }, lost: { t: 'complex' } })
    expect(line?.restore).toMatchObject({ type: 'order', list: 'tabs:s1:-' })
    expect(line?.label).toBe('Travail')
  })

  it('shows a lost value that is too large as « another value » and offers no restore', () => {
    const big = 'x'.repeat(JOURNAL_LIMITS.maxValueChars)
    const side = (name: string, mark: string) => read({ entities: { space: { s1: { fields: { name }, stamps: { name: mark } } } } })
    const local = side(big, '1790000000003-0000-mac')
    const remote = side('court', '1790000000007-0000-phone')
    const merged = mergeSnapshots(null, local, remote)
    const [line] = settleConflicts({ conflicts: merged.conflicts, local, remote, merged: merged.snapshot, now: NOW, peer: 'ios' })
    expect(line).toMatchObject({ lost: { t: 'complex' }, restore: null })
  })

  it('keeps a value whose canonical text is exactly 4096 characters and drops one of 4097', () => {
    const settle = (text: string) => {
      const side = (name: string, mark: string) => read({ entities: { space: { s1: { fields: { name }, stamps: { name: mark } } } } })
      const local = side(text, '1790000000003-0000-mac')
      const remote = side('court', '1790000000007-0000-phone')
      const merged = mergeSnapshots(null, local, remote)
      return settleConflicts({ conflicts: merged.conflicts, local, remote, merged: merged.snapshot, now: NOW, peer: 'ios' })[0]
    }
    expect(settle('x'.repeat(JOURNAL_LIMITS.maxValueChars - 2))?.restore).not.toBeNull()
    expect(settle('x'.repeat(JOURNAL_LIMITS.maxValueChars - 1))?.restore).toBeNull()
  })

  it('shows a value cut to 80 characters, by code point, and a bool as a bool', () => {
    expect(clip('abc', 5)).toBe('abc')
    expect(clip('abcdef', 3)).toBe('abc…')
    expect(clip('😀😀😀😀', 2)).toBe('😀😀…')
    const side = (hideHeader: boolean, name: string, mark: string) => read({ entities: { space: { s1: { fields: { hideHeader, name }, stamps: { hideHeader: mark, name: mark } } } } })
    const local = side(true, '😀'.repeat(100), '1790000000003-0000-mac')
    const remote = side(false, 'b', '1790000000007-0000-phone')
    const merged = mergeSnapshots(null, local, remote)
    const lines = settleConflicts({ conflicts: merged.conflicts, local, remote, merged: merged.snapshot, now: NOW, peer: 'ios' })
    expect(lines.find((l) => l.field === 'hideHeader')).toMatchObject({ kept: { t: 'bool', value: false }, lost: { t: 'bool', value: true } })
    expect(lines.find((l) => l.field === 'name')?.lost).toEqual({ t: 'text', text: `${'😀'.repeat(80)}…` })
  })

  it('names a tab by its custom title, else its title, else its address, and a favourite by its title, else its address', () => {
    expect(labelOf('tab', { customTitle: 'Mine', title: 'Theirs', anchorUrl: 'https://a.example/' })).toBe('Mine')
    expect(labelOf('tab', { title: 'Theirs', anchorUrl: 'https://a.example/' })).toBe('Theirs')
    expect(labelOf('tab', { anchorUrl: 'https://a.example/' })).toBe('https://a.example/')
    expect(labelOf('favorite', { title: 'T', url: 'https://a.example/' })).toBe('T')
    expect(labelOf('archived', { url: 'https://a.example/' })).toBe('https://a.example/')
    expect(labelOf('tab', {})).toBeNull()
    expect(labelOf('setting', { value: true })).toBeNull()
    expect(labelOf('space', { name: 'x'.repeat(200) })).toBe(`${'x'.repeat(JOURNAL_LIMITS.maxLabelChars)}…`)
  })

  it('does not show a profile id, which says nothing to the person', () => {
    const side = (profileId: string, mark: string) => read({ entities: { favorite: { v1: { fields: { url: 'https://a.example/', title: 'T', profileId }, stamps: { url: M, title: M, profileId: mark } } } } })
    const local = side('p1', '1790000000003-0000-mac')
    const remote = side('p2', '1790000000007-0000-phone')
    const merged = mergeSnapshots(null, local, remote)
    const [line] = settleConflicts({ conflicts: merged.conflicts, local, remote, merged: merged.snapshot, now: NOW, peer: 'ios' })
    expect(line).toMatchObject({ field: 'profileId', kept: { t: 'complex' }, lost: { t: 'complex' }, restore: { type: 'set', value: 'p1' } })
  })

  it('reads the time of a mark, and none for the mark of zero', () => {
    expect(stampTime('1790000000007-0000-mac')).toBe(1790000000007)
    expect(stampTime('0')).toBeNull()
  })
})

const line = (id: string, settledAt: number, extra: Partial<SettledConflict> = {}): SettledConflict => ({
  id,
  settledAt,
  peer: 'ios',
  kind: 'space',
  entityId: id,
  field: 'name',
  reason: 'newer',
  winner: 'remote',
  label: 'x',
  kept: { t: 'text', text: 'a' },
  lost: { t: 'text', text: 'b' },
  keptAt: 5,
  lostAt: 4,
  restore: { type: 'set', kind: 'space', id, field: 'name', value: 'b' },
  ...extra,
})

describe('sync conflicts: the journal keeps 30 days and 200 lines', () => {
  it('drops a line older than 30 days and keeps one of exactly 30 days', () => {
    const kept = pruneJournal([line('a', NOW - 30 * DAY), line('b', NOW - 30 * DAY - 1), line('c', NOW)], NOW)
    expect(kept.map((l) => l.id)).toEqual(['c', 'a'])
  })

  it('keeps the 200 newest, whatever the order they come in', () => {
    const many = Array.from({ length: 250 }, (_, i) => line(`id${String(i).padStart(3, '0')}`, NOW - i * 1000))
    const kept = pruneJournal([...many].reverse(), NOW)
    expect(kept).toHaveLength(JOURNAL_LIMITS.maxEntries)
    expect(kept[0]?.id).toBe('id000')
    expect(kept[199]?.id).toBe('id199')
  })

  it('has the same thing settled again replace its line, and a session add its lines', () => {
    const journal = [line('a', NOW - 5 * DAY, { label: 'old' }), line('b', NOW - 4 * DAY)]
    const next = addToJournal(journal, [line('a', NOW, { label: 'new' }), line('c', NOW)], NOW)
    expect(next.map((l) => [l.id, l.label])).toEqual([['a', 'new'], ['c', 'x'], ['b', 'x']])
  })

  it('removes a line that was put back or acknowledged, and tells the last session', () => {
    const journal = [line('a', NOW), line('b', NOW), line('c', NOW - DAY)]
    expect(removeFromJournal(journal, 'a').map((l) => l.id)).toEqual(['b', 'c'])
    expect(lastSession(journal).map((l) => l.id)).toEqual(['a', 'b'])
    expect(lastSession([])).toEqual([])
  })
})

describe('sync conflicts: reading the journal file (a file is hostile until it is read)', () => {
  it('writes the journal and reads it back', () => {
    const journal = [line('a', NOW), line('b', NOW - DAY, { restore: null, field: null, reason: 'modification-over-deletion', kept: { t: 'absent' }, lost: { t: 'absent' }, keptAt: null, lostAt: null, label: null })]
    expect(parseJournal(serializeJournal(journal), NOW)).toEqual({ entries: journal, skipped: 0, tooNew: false, unreadable: false })
  })

  it('says a file is unreadable when it is not JSON, not a journal, too large or of no version, and starts with nothing', () => {
    for (const text of ['', '{', 'null', '[]', '{"v":1}', '{"v":1,"entries":5}', '{"v":0,"entries":[]}', '{"entries":[]}', 'x'.repeat(JOURNAL_LIMITS.maxFileChars + 1)]) {
      expect(parseJournal(text, NOW), text.slice(0, 20)).toEqual({ entries: [], skipped: 0, tooNew: false, unreadable: true })
    }
  })

  it('says a file of a newer version is not to be overwritten', () => {
    expect(parseJournal('{"v":2,"entries":[{"future":true}]}', NOW)).toEqual({ entries: [], skipped: 0, tooNew: true, unreadable: false })
  })

  it('leaves out a line that is not in the form, a repeated one, and counts them', () => {
    const good = line('a', NOW)
    const bad: unknown[] = [
      5, null, [], {}, { ...good, id: '' }, { ...good, settledAt: -1 }, { ...good, settledAt: 1.5 }, { ...good, peer: 'pc' }, { ...good, kind: '' }, { ...good, field: '' }, { ...good, reason: 'because' },
      { ...good, winner: 'both' }, { ...good, label: 5 }, { ...good, kept: { t: 'text' } }, { ...good, kept: { t: 'other' } }, { ...good, keptAt: 'x' }, { ...good, restore: { type: 'run', command: 'rm' } },
      { ...good, restore: { type: 'set', kind: 'space', id: 's', field: 'name', value: JSON.parse('{"__proto__":1}') } }, { ...good, restore: { type: 'order', list: 'spaces', ids: [1] } },
      { ...good, restore: { type: 'order', list: 'spaces', ids: Array.from({ length: JOURNAL_LIMITS.maxListIds + 1 }, (_, i) => `i${i}`) } }, { ...good, entityId: 'x'.repeat(401) },
      { ...good, label: 'x'.repeat(500) }, { ...good, id: 'e\u0301' }, { ...good, kind: 'cafe\u0301' }, { ...good, entityId: 'e\u0301' }, { ...good, field: 'e\u0301' },
      { ...good, restore: { type: 'set', kind: 'space', id: 'e\u0301', field: 'name', value: 'b' } }, { ...good, restore: { type: 'set', kind: 'space', id: 's', field: 'name', value: { 'e\u0301': 1 } } },
      { ...good, restore: { type: 'order', list: 'spaces', ids: ['e\u0301'] } },
    ]
    // Each bad line has an id of its own, so that none of them is left out only because it repeats another's.
    const unique = bad.map((entry, index) => (typeof entry === 'object' && entry !== null && !Array.isArray(entry) && !('id' in (entry as object) && (entry as { id: unknown }).id !== 'a') ? { ...(entry as object), id: `bad${index}` } : entry))
    const read = parseJournal(JSON.stringify({ v: 1, entries: [good, ...unique] }), NOW)
    expect(read.entries.map((l) => l.id)).toEqual(['a'])
    expect(read.skipped).toBe(bad.length)
  })

  it('leaves out a line that repeats the id of an earlier one', () => {
    const read = parseJournal(JSON.stringify({ v: 1, entries: [line('a', NOW), line('a', NOW - 1), line('b', NOW)] }), NOW)
    expect(read.entries.map((l) => l.id)).toEqual(['a', 'b'])
    expect(read.skipped).toBe(1)
  })

  it('reads at most 400 lines and keeps 200: the lines after the 400th are not read, even the newest', () => {
    // The later the line, the newer: if every line were read, the newest 200 would be the last ones.
    const entries = Array.from({ length: 500 }, (_, i) => line(`id${i}`, NOW - (499 - i)))
    const read = parseJournal(JSON.stringify({ v: 1, entries }), NOW)
    expect(read.entries).toHaveLength(JOURNAL_LIMITS.maxEntries)
    expect(read.entries[0]?.id).toBe('id399')
  })

  it('says a journal that is valid but too large is unreadable, before it is read', () => {
    const padded = JSON.stringify({ v: 1, entries: [], pad: 'x'.repeat(JOURNAL_LIMITS.maxFileChars) })
    expect(parseJournal(padded, NOW)).toEqual({ entries: [], skipped: 0, tooNew: false, unreadable: true })
  })

  it('copies what it reads, and leaves out what it does not know', () => {
    const raw = { ...line('a', NOW), extra: 'x' } as Record<string, unknown>
    const read = parseJournal(JSON.stringify({ v: 1, entries: [raw] }), NOW)
    expect(read.entries[0]).not.toHaveProperty('extra')
  })
})

describe('sync conflicts: the sentences of « Conflit réglé »', () => {
  const sentence = (e: SettledConflict) => viewOf(e)
  it('tells a field the newer version won, the rows oldest first, with the device that did each', () => {
    const [entry] = settled('the same field changed differently')
    const view = sentence(entry as SettledConflict)
    expect(view.title).toEqual({ key: 'sync-conflict.kind-space', params: [] })
    expect(view.label).toBe('Boulot')
    expect(view.rows).toEqual([
      { platform: 'mac', kept: false, text: { key: 'sync-conflict.row-set', params: [{ key: 'sync-conflict.field-name', params: [] }, 'Pro'] }, at: 1790000000003 },
      { platform: 'ios', kept: true, text: { key: 'sync-conflict.row-set', params: [{ key: 'sync-conflict.field-name', params: [] }, 'Boulot'] }, at: 1790000000007 },
    ])
    expect(view.outcome).toEqual({ key: 'sync-conflict.outcome-newer-ios', params: [] })
    expect(view.compare).toBe(true)
    expect(view.restore).toMatchObject({ type: 'set' })
  })

  it('names the device that won from the point of view of the device that tells it', () => {
    const base = line('a', NOW)
    expect(viewOf({ ...base, peer: 'ios', winner: 'local' }).outcome.key).toBe('sync-conflict.outcome-newer-mac')
    expect(viewOf({ ...base, peer: 'ios', winner: 'remote' }).outcome.key).toBe('sync-conflict.outcome-newer-ios')
    expect(viewOf({ ...base, peer: 'mac', winner: 'local' }).outcome.key).toBe('sync-conflict.outcome-newer-ios')
    expect(viewOf({ ...base, peer: 'mac', winner: 'remote' }).outcome.key).toBe('sync-conflict.outcome-newer-mac')
  })

  it('tells a tie, a deletion that lost, and an order', () => {
    const base = line('a', NOW)
    expect(viewOf({ ...base, reason: 'device-id' }).outcome.key).toBe('sync-conflict.outcome-tie-ios')
    expect(viewOf({ ...base, reason: 'value', winner: 'local' }).outcome.key).toBe('sync-conflict.outcome-tie-mac')
    const deleted = viewOf({ ...base, reason: 'modification-over-deletion', field: null, kept: { t: 'absent' }, lost: { t: 'absent' } })
    expect(deleted.outcome.key).toBe('sync-conflict.outcome-kept')
    expect(deleted.rows.map((r) => r.text.key).sort()).toEqual(['sync-conflict.row-deleted', 'sync-conflict.row-modified'])
    expect(deleted.compare).toBe(false)
    const order = viewOf({ ...base, kind: 'order', field: null, reason: 'order', entityId: 'spaces' })
    expect(order.outcome.key).toBe('sync-conflict.outcome-order-ios')
    expect(order.compare).toBe(true)
  })

  it('tells a boolean, a removed field, a folder and a value that is not shown', () => {
    const rowOf = (lost: SettledConflict['lost'], field = 'hideHeader') => viewOf(line('a', NOW, { field, lost, lostAt: 1 })).rows.find((r) => !r.kept)?.text
    expect(rowOf({ t: 'bool', value: true })?.key).toBe('sync-conflict.row-on')
    expect(rowOf({ t: 'bool', value: false })?.key).toBe('sync-conflict.row-off')
    expect(rowOf({ t: 'absent' })?.key).toBe('sync-conflict.row-unset')
    expect(rowOf({ t: 'complex' })?.key).toBe('sync-conflict.row-other')
    expect(rowOf({ t: 'text', text: 'Réunions' }, 'folderId')).toEqual({ key: 'sync-conflict.row-moved', params: ['Réunions'] })
  })

  it('shows a field or a kind a newer version added by its own name, and a setting by its name', () => {
    const view = viewOf(line('a', NOW, { field: 'futureField', kind: 'widget' }))
    expect(view.title.key).toBe('sync-conflict.kind-other')
    expect(view.rows[0]?.text.params[0]).toBe('futureField')
    const setting = viewOf(line('a', NOW, { kind: 'setting', entityId: 'sendGpc', field: 'value', kept: { t: 'bool', value: true }, lost: { t: 'bool', value: false }, label: null }))
    expect(setting.title).toEqual({ key: 'sync-conflict.kind-setting-named', params: [{ key: 'sync-conflict.setting-send-gpc', params: [] }] })
    expect(viewOf(line('a', NOW, { kind: 'setting', entityId: 'weird', field: 'value' })).title.params).toEqual(['weird'])
  })

  it('puts a row with no time first, and breaks a tie by the name of the device', () => {
    const view = viewOf(line('a', NOW, { keptAt: 7, lostAt: null }))
    expect(view.rows.map((r) => r.kept)).toEqual([false, true])
    const same = viewOf(line('a', NOW, { keptAt: 7, lostAt: 7 }))
    expect(same.rows.map((r) => r.platform)).toEqual(['ios', 'mac'])
  })

  it('knows the fields, the kinds and the settings the catalogues name', () => {
    expect(FIELD_KEYS.has('folderId')).toBe(true)
    expect(FIELD_KEYS.has('constructor')).toBe(false)
    expect(KIND_KEYS.has('order')).toBe(true)
    expect(SETTING_KEYS.size).toBe(8)
  })
})

// The cases LuciumKit plays too, as a file snapshot.
describe('sync conflicts: the vectors LuciumKit plays too', () => {
  it('are written as a file snapshot of this module', async () => {
    const sources: { source: string; name: string; base: SyncSnapshot | null; local: SyncSnapshot; remote: SyncSnapshot; withheld: string[] }[] = []
    for (const c of mergeVectors.cases) sources.push({ source: 'vectors', name: c.name, base: c.base === null ? null : read(c.base), local: read(c.local), remote: read(c.remote), withheld: c.withheld })
    for (const [index, d] of draws(20261119, 60).entries()) sources.push({ source: 'draws', name: `draw ${index}`, base: d.base, local: d.local, remote: d.remote, withheld: d.withheld })
    const settle = sources.flatMap((s, index) => {
      const merged = mergeSnapshots(s.base, s.local, s.remote, s.withheld)
      if (merged.conflicts.length === 0) return []
      const peer: Platform = index % 2 === 0 ? 'ios' : 'mac'
      const entries = settleConflicts({ conflicts: merged.conflicts, local: s.local, remote: s.remote, merged: merged.snapshot, now: NOW, peer })
      return [{ source: s.source, name: s.name, now: NOW, peer, entries, views: entries.map(viewOf) }]
    })
    const journal = {
      retention: [
        { name: 'a line of exactly 30 days stays and one of 30 days and a millisecond goes', now: NOW, journal: [['a', NOW - 30 * DAY], ['b', NOW - 30 * DAY - 1], ['c', NOW]], settled: [], expect: ['c', 'a'] },
        { name: 'the 200 newest stay', now: NOW, journal: Array.from({ length: 250 }, (_, i) => [`id${String(i).padStart(3, '0')}`, NOW - i * 1000]), settled: [], expect: Array.from({ length: 200 }, (_, i) => `id${String(i).padStart(3, '0')}`) },
        { name: 'a thing settled again replaces its line and a session adds its lines', now: NOW, journal: [['a', NOW - 5 * DAY], ['b', NOW - 4 * DAY]], settled: [['a', NOW], ['c', NOW]], expect: ['a', 'c', 'b'] },
      ],
      parse: [
        { name: 'a journal with one good line and one that is not', text: JSON.stringify({ v: 1, entries: [line('a', NOW), { id: 'b' }] }), now: NOW, expect: { ids: ['a'], skipped: 1, tooNew: false, unreadable: false } },
        { name: 'not JSON', text: '{', now: NOW, expect: { ids: [], skipped: 0, tooNew: false, unreadable: true } },
        { name: 'a newer version', text: '{"v":2,"entries":[]}', now: NOW, expect: { ids: [], skipped: 0, tooNew: true, unreadable: false } },
        { name: 'a repeated id', text: JSON.stringify({ v: 1, entries: [line('a', NOW), line('a', NOW)] }), now: NOW, expect: { ids: ['a'], skipped: 1, tooNew: false, unreadable: false } },
        { name: 'a value to put back that holds a __proto__ key', text: `{"v":1,"entries":[${JSON.stringify(line('a', NOW)).replace('"value":"b"', '"value":{"__proto__":1}')}]}`, now: NOW, expect: { ids: [], skipped: 1, tooNew: false, unreadable: false } },
        { name: 'a line from the future is kept', text: JSON.stringify({ v: 1, entries: [line('a', NOW + DAY)] }), now: NOW, expect: { ids: ['a'], skipped: 0, tooNew: false, unreadable: false } },
      ],
    }
    const file = {
      comment:
        'The conflicts the merge settled and how they are told (docs/synchronisation.md §11.7.3, §13.4; src/shared/sync-conflicts.ts). `settle` holds, for each case of sync-merge-vectors.json (`source: "vectors"`) and of sync-merge-draws.json (`source: "draws"`) that has a conflict, the journal lines (`entries`) and the sentences (`views`: keys of the catalogue and the words to put in them) the Mac gives, with `now` the end of the session and `peer` the other device; the merge is run on the three snapshots of the source and `withheld`, this device being the one the peer is not. It is a file snapshot: src/shared/sync-conflicts.test.ts rewrites it with `pnpm exec vitest run src/shared/sync-conflicts.test.ts -u` and refuses a difference otherwise, and LuciumKit (SyncConflictVectorTests) plays it against the Swift. `journal.retention` gives `[id, settledAt]` pairs and the ids that must be left, newest first; `journal.parse` the text of a file and what is read from it.',
      settle,
      journal,
    }
    await expect(`${JSON.stringify(file)}\n`).toMatchFileSnapshot('../../ios/Contracts/sync-conflict-vectors.json')
    expect(settle.length).toBeGreaterThan(20)
    // Every sentence is told with keys of the catalogue of the area only, and the cases use more than a handful of them.
    const keys = new Set<string>()
    const walk = (ref: unknown): void => {
      if (typeof ref !== 'object' || ref === null) return
      const r = ref as { key?: string; params?: unknown[] }
      if (typeof r.key === 'string') keys.add(r.key)
      for (const p of r.params ?? []) walk(p)
    }
    for (const c of settle) for (const v of c.views) {
      walk(v.title)
      walk(v.outcome)
      for (const row of v.rows) walk(row.text)
    }
    expect([...keys].every((k) => k.startsWith('sync-conflict.'))).toBe(true)
    expect(keys.size).toBeGreaterThan(8)
    // The journal cases hold what the module says (the Swift is held to this file, so the file must be right).
    for (const c of journal.retention) {
      const toLine = ([id, at]: (string | number)[]) => line(id as string, at as number)
      expect(addToJournal(c.journal.map(toLine), c.settled.map(toLine), c.now).map((l) => l.id), c.name).toEqual(c.expect)
    }
    for (const c of journal.parse) {
      const got = parseJournal(c.text, c.now)
      expect({ ids: got.entries.map((l) => l.id), skipped: got.skipped, tooNew: got.tooNew, unreadable: got.unreadable }, c.name).toEqual(c.expect)
    }
  })
})

describe('sync conflicts: the catalogues say every sentence the screens can tell', () => {
  /** Every key a line can ask for, from lines of every kind, reason, side, field, value and setting. */
  function keysAsked(): Set<string> {
    const keys = new Set<string>()
    const walk = (ref: unknown): void => {
      if (typeof ref !== 'object' || ref === null) return
      const r = ref as { key?: string; params?: unknown[] }
      if (typeof r.key === 'string') keys.add(r.key)
      for (const p of r.params ?? []) walk(p)
    }
    const values = [{ t: 'text', text: 'v' }, { t: 'bool', value: true }, { t: 'bool', value: false }, { t: 'absent' }, { t: 'complex' }] as const
    const reasons = ['newer', 'device-id', 'value', 'modification-over-deletion', 'order'] as const
    for (const peer of ['mac', 'ios'] as const) for (const winner of ['local', 'remote'] as const) for (const reason of reasons) {
      for (const kind of [...KIND_KEYS.keys(), 'setting', 'widget']) {
        const fields = kind === 'order' || reason === 'modification-over-deletion' ? [null] : [...FIELD_KEYS.keys(), 'futureField', 'constructor']
        const entities = kind === 'setting' ? [...SETTING_KEYS.keys(), 'weird'] : ['e']
        for (const field of fields) for (const entityId of entities) for (const kept of values) for (const lost of values) {
          const view = viewOf(line('a', NOW, { peer, winner, reason, kind, field, entityId, kept, lost }))
          walk(view.title)
          walk(view.outcome)
          for (const row of view.rows) walk(row.text)
        }
      }
    }
    return keys
  }
  // The keys the sheets ask for themselves, without a line to tell: the title, the buttons, the names of the devices, the words for a value.
  const OWN = ['title', 'subtitle', 'count.one', 'count.other', 'ok', 'compare', 'hide-compare', 'delete-everywhere', 'restore', 'kept-version', 'other-version', 'device-mac', 'device-ios', 'value-yes', 'value-no', 'value-none', 'value-other', 'explain-restore'].map((k) => `sync-conflict.${k}`)

  it('has every key a line asks for in French and in English, and no key that nothing asks for', () => {
    const asked = new Set([...keysAsked(), ...OWN])
    for (const key of asked) {
      expect(key in fr, `${key} in French`).toBe(true)
      expect(key in en, `${key} in English`).toBe(true)
    }
    const present = Object.keys(fr).filter((key) => key.startsWith('sync-conflict.'))
    expect(present.filter((key) => !asked.has(key))).toEqual([])
    expect(asked.size).toBeGreaterThan(70)
  })

  it('puts the words of a sentence in the places the catalogue gives them, a name of a field first translated', () => {
    const translate = (key: string, vars: Record<string, string>): string => `${(fr as Record<string, string>)[key] ?? key}`.replace(/\{(p\d)\}/g, (_m, name: string) => vars[name] ?? '')
    const view = viewOf(line('a', NOW, { field: 'folderId', kept: { t: 'text', text: 'Réunions' }, lost: { t: 'absent' }, peer: 'ios', winner: 'remote', keptAt: 2, lostAt: 1 }))
    expect(view.rows.map((r) => renderText(r.text, translate))).toEqual(['Dossier retiré', 'Rangé dans « Réunions »'])
    expect(renderText(viewOf(line('a', NOW, { field: 'name', kept: { t: 'text', text: 'Pro' } })).rows[1]?.text ?? { key: '', params: [] }, translate)).toBe('Nom changé en « Pro »')
  })

  it('says a time for today and a date for another day, in the language of the interface', () => {
    const at = new Date(2026, 10, 18, 9, 15).getTime()
    expect(formatWhen(at, at + 60_000, 'fr')).toMatch(/^09:15$|^9:15$|^9 h 15$/)
    expect(formatWhen(at, at + 60_000, 'en')).toMatch(/9:15/)
    expect(formatWhen(at, at + 3 * DAY, 'en')).toMatch(/Nov/)
    expect(formatWhen(at, at + 3 * DAY, 'fr')).toMatch(/nov/)
  })
})
