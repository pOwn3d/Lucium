// « Sur l'iPhone »: the pure rules of the list, played with the vectors shared with the iPhone (ios/Contracts/sync-resume-vectors.json), and the check of the request of the bar.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isWebAddress, matchResume, parseSyncResumeRequest, resumeAge, resumeAvailability, resumeRows, resumeTargetSpace, resumeView, RESUME_MAX_TABS, type ResumeAge, type ResumeAvailability, type ResumeRow, type ResumeTab } from './sync-resume'

interface Vectors {
  rows: Array<{ name: string; tabs: ResumeTab[]; expect: Array<Pick<ResumeRow, 'id' | 'title' | 'host' | 'spaceId'>> }>
  availability: Array<{ paired: boolean; categoryOnHere: boolean; announcedAt: number | null; listAnnounced: boolean; rowCount: number; sessionHappened: boolean; expect: ResumeAvailability }>
  targetSpace: Array<{ name: string; rowSpace: string; spaces: string[]; active: string; locked: string[]; expect: string | null }>
  age: Array<{ at: number; now: number; expect: ResumeAge }>
}
const vectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/sync-resume-vectors.json'), 'utf8')) as Vectors

describe('sync resume vectors (shared with the iPhone)', () => {
  it('has vectors to run', () => {
    expect(vectors.rows.length).toBeGreaterThan(1)
    expect(vectors.availability.length).toBeGreaterThan(5)
    expect(vectors.targetSpace.length).toBeGreaterThan(3)
    expect(vectors.age.length).toBeGreaterThan(5)
  })
  for (const v of vectors.rows) {
    it(`rows: ${v.name}`, () => {
      expect(resumeRows(v.tabs).map(({ id, title, host, spaceId }) => ({ id, title, host, spaceId }))).toEqual(v.expect)
    })
  }
  it('availability', () => {
    for (const v of vectors.availability) expect(resumeAvailability(v), JSON.stringify(v)).toBe(v.expect)
  })
  for (const v of vectors.targetSpace) {
    it(`target space: ${v.name}`, () => {
      expect(resumeTargetSpace({ spaceId: v.rowSpace }, new Set(v.spaces), v.active, (id) => v.locked.includes(id))).toBe(v.expect)
    })
  }
  it('age', () => {
    for (const v of vectors.age) expect(resumeAge(v.at, v.now), JSON.stringify(v)).toEqual(v.expect)
  })
})

describe('isWebAddress', () => {
  it('keeps http and https with a host, and nothing else', () => {
    expect(isWebAddress('https://example.com/a?b=1')).toBe(true)
    expect(isWebAddress('HTTP://example.com')).toBe(true)
    for (const bad of ['javascript:alert(1)', 'file:///etc/hosts', 'data:text/html,hi', 'ftp://example.com', 'ws://example.com', 'lucium-ui://extensions/', 'about:blank', 'https://', 'example.com', '']) expect(isWebAddress(bad), bad).toBe(false)
  })
  it('refuses an address longer than the protocol allows', () => {
    expect(isWebAddress(`https://example.com/${'a'.repeat(4096)}`)).toBe(false)
    expect(isWebAddress(`https://example.com/${'a'.repeat(4000)}`)).toBe(true)
  })
})

describe('resumeRows', () => {
  it('keeps no more than the protocol allows', () => {
    const tabs = Array.from({ length: RESUME_MAX_TABS + 30 }, (_, i): ResumeTab => ({ id: `t${i}`, spaceId: 's', url: `https://e.example/${i}`, title: `T${i}`, lastActiveAt: i }))
    const rows = resumeRows(tabs)
    expect(rows).toHaveLength(RESUME_MAX_TABS)
    expect(rows[0]!.id).toBe(`t${RESUME_MAX_TABS + 29}`)
  })
})

describe('matchResume', () => {
  const lines = [
    { id: '1', title: 'Cooking pasta', host: 'recipes.example', lastActiveAt: 3 },
    { id: '2', title: 'Pasta history', host: 'history.example', lastActiveAt: 2 },
    { id: '3', title: 'Weather', host: 'pasta.example', lastActiveAt: 1 }
  ]
  it('keeps the lines whose title or host matches, the order of the list for equal scores', () => {
    expect(matchResume(lines, 'pasta').map((l) => l.id).sort()).toEqual(['1', '2', '3'])
    expect(matchResume(lines, 'weather').map((l) => l.id)).toEqual(['3'])
    expect(matchResume(lines, 'zzzz')).toEqual([])
  })
  it('keeps the whole list for no text, and cuts it at the limit', () => {
    expect(matchResume(lines, '  ')).toHaveLength(3)
    expect(matchResume(lines, 'pasta', 2)).toHaveLength(2)
  })
})

describe('resumeView', () => {
  const row: ResumeRow = { id: 'p:1', url: 'https://secret.example/path?token=1', title: 'T', host: 'secret.example', spaceId: 'space-private', lastActiveAt: 9 }
  const base = { paired: true, categoryOnHere: true, announcedAt: 9, listAnnounced: true, sessionHappened: true }
  it('gives the bar the line without its address or its space', () => {
    const view = resumeView({ ...base, rows: [row] })
    expect(view).toEqual({ availability: 'list', lines: [{ id: 'p:1', title: 'T', host: 'secret.example', lastActiveAt: 9 }], announcedAt: 9 })
    expect(JSON.stringify(view)).not.toContain('token')
    expect(JSON.stringify(view)).not.toContain('space-private')
  })
  it('gives nothing when the category is off here, or when no iPhone is paired', () => {
    expect(resumeView({ ...base, categoryOnHere: false, rows: [row] })).toEqual({ availability: 'disabled-here', lines: [], announcedAt: null })
    expect(resumeView({ ...base, paired: false, rows: [row] })).toEqual({ availability: 'not-paired', lines: [], announcedAt: null })
  })
})

describe('parseSyncResumeRequest', () => {
  it('reads the two kinds', () => {
    expect(parseSyncResumeRequest({ kind: 'list' })).toEqual({ kind: 'list' })
    expect(parseSyncResumeRequest({ kind: 'open', id: 'abc:12.x_y-z' })).toEqual({ kind: 'open', id: 'abc:12.x_y-z' })
  })
  it('refuses everything else', () => {
    for (const bad of [null, undefined, 3, 'list', [], { kind: 'list', extra: 1 }, { kind: 'open' }, { kind: 'open', id: '' }, { kind: 'open', id: 3 }, { kind: 'open', id: 'a b' }, { kind: 'open', id: 'https://x.example/' }, { kind: 'open', id: 'a'.repeat(201) }, { kind: 'open', id: 'a', url: 'https://x.example/' }, { kind: 'other' }, Object.create({ kind: 'list' })]) {
      expect(parseSyncResumeRequest(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})
