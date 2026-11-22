import { describe, expect, it } from 'vitest'
import type { ArchivedTab, Space } from './model'
import { MAX_SESSION_RESULTS, closedSessions, parseMaxResults, sessionToRestore } from './extension-sessions'

const space = (id: string, profileId: string) => ({ id, profileId }) as unknown as Space
const entry = (id: string, over: Partial<ArchivedTab> = {}): ArchivedTab => ({ id, spaceId: 's-default', url: `https://${id}.example/`, title: `Title ${id}`, archivedAt: 1000, source: 'manual', ...over })
const spaces = [space('s-default', 'default'), space('s-work', 'work')]

describe('closedSessions', () => {
  it('lists the tabs the person closed, newest first, in seconds as the platform counts them', () => {
    const archive = [entry('old', { archivedAt: 1_000_000 }), entry('new', { archivedAt: 5_000_000, pinned: true })]
    const list = closedSessions(archive, spaces, 'default', 25)
    expect(list.map((s) => s.tab.sessionId)).toEqual(['new', 'old'])
    expect(list[0]).toMatchObject({ lastModified: 5000, tab: { sessionId: 'new', url: 'https://new.example/', title: 'Title new', pinned: true, incognito: false } })
  })

  it('shows the profile of the caller only', () => {
    const archive = [entry('a'), entry('b', { spaceId: 's-work' })]
    expect(closedSessions(archive, spaces, 'work', 25).map((s) => s.tab.sessionId)).toEqual(['b'])
    expect(closedSessions(archive, spaces, 'nobody', 25)).toEqual([])
  })

  it('leaves out what was swept for being idle and what another device left', () => {
    const archive = [entry('idle', { source: 'auto' }), entry('sync', { source: 'sync' }), entry('mini', { source: 'little' }), entry('mine')]
    expect(closedSessions(archive, spaces, 'default', 25).map((s) => s.tab.sessionId).sort()).toEqual(['mine', 'mini'])
  })

  it('leaves out an entry of a space that is not there (a locked space is hidden before this)', () => {
    expect(closedSessions([entry('ghost', { spaceId: 'gone' })], spaces, 'default', 25)).toEqual([])
  })

  it('stops at maxResults', () => {
    const archive = [entry('a', { archivedAt: 1 }), entry('b', { archivedAt: 2 }), entry('c', { archivedAt: 3 })]
    expect(closedSessions(archive, spaces, 'default', 2).map((s) => s.tab.sessionId)).toEqual(['c', 'b'])
  })
})

describe('sessionToRestore', () => {
  const archive = [entry('old', { archivedAt: 1 }), entry('new', { archivedAt: 2 }), entry('idle', { archivedAt: 9, source: 'auto' })]
  it('without an id, the latest closed tab', () => expect(sessionToRestore(archive, spaces, 'default', undefined)?.id).toBe('new'))
  it('with an id, that tab', () => expect(sessionToRestore(archive, spaces, 'default', 'old')?.id).toBe('old'))
  it('refuses an id that is not a closed tab of the profile of the caller', () => {
    expect(sessionToRestore(archive, spaces, 'work', 'old')).toBeNull()
    expect(sessionToRestore(archive, spaces, 'default', 'idle')).toBeNull()
    expect(sessionToRestore(archive, spaces, 'default', 'nothing')).toBeNull()
    expect(sessionToRestore([], spaces, 'default', undefined)).toBeNull()
  })
})

describe('parseMaxResults', () => {
  it('defaults to the most, and refuses what the platform refuses', () => {
    expect(parseMaxResults(undefined)).toBe(MAX_SESSION_RESULTS)
    expect(parseMaxResults({})).toBe(MAX_SESSION_RESULTS)
    expect(parseMaxResults({ maxResults: 3 })).toBe(3)
    expect(parseMaxResults({ maxResults: 26 })).toBeNull()
    expect(parseMaxResults({ maxResults: 0 })).toBeNull()
    expect(parseMaxResults({ maxResults: 1.5 })).toBeNull()
    expect(parseMaxResults('x')).toBeNull()
  })
})
