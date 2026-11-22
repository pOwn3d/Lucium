import { describe, expect, it } from 'vitest'
import { canReopen, CLOSED_WINDOWS_MAX, mayRemember, remember, takeLast, type ClosedWindow } from './closed-windows'

const NO_LOCK = { appLocked: false, lockedSpaces: [] as string[] }
const entry = (n: number, spaceId = 's1', extra: Partial<ClosedWindow> = {}): ClosedWindow => ({ bounds: { x: n, y: n, width: 900, height: 600 }, selection: { spaceId, tabs: { [spaceId]: `t${n}` }, layout: {} }, ...extra })
const win = (over: Partial<Parameters<typeof mayRemember>[0]> = {}): Parameters<typeof mayRemember>[0] => ({ kind: 'window', quitting: false, selection: entry(1).selection, ...over })

describe('which closed windows are remembered', () => {
  it('keeps a normal window closed by the user', () => {
    expect(mayRemember(win(), NO_LOCK)).toBe(true)
  })

  it('never keeps a private window, a guest window, nor the first window (it is put away or ends the application)', () => {
    expect(mayRemember(win({ kind: 'private' }), NO_LOCK)).toBe(false)
    expect(mayRemember(win({ kind: 'private', guest: true }), NO_LOCK)).toBe(false)
    expect(mayRemember(win({ kind: 'main' }), NO_LOCK)).toBe(false)
  })

  it('never keeps a window closed on the way out of the application', () => {
    expect(mayRemember(win({ quitting: true }), NO_LOCK)).toBe(false)
  })

  it('never keeps a window of a locked space, nor any window while the application is locked', () => {
    expect(mayRemember(win(), { appLocked: false, lockedSpaces: ['s1'] })).toBe(false)
    expect(mayRemember(win(), { appLocked: false, lockedSpaces: ['other'] })).toBe(true)
    expect(mayRemember(win(), { appLocked: true, lockedSpaces: [] })).toBe(false)
  })
})

describe('the list of closed windows', () => {
  it('is bounded: the oldest is dropped first, and the list given is not changed', () => {
    let list: ClosedWindow[] = []
    for (let n = 1; n <= CLOSED_WINDOWS_MAX + 3; n += 1) list = remember(list, entry(n))
    expect(list).toHaveLength(CLOSED_WINDOWS_MAX)
    expect(list[0]!.bounds.x).toBe(4)
    expect(list.at(-1)!.bounds.x).toBe(CLOSED_WINDOWS_MAX + 3)
    const before = [entry(1)]
    remember(before, entry(2))
    expect(before).toHaveLength(1)
  })

  it('gives back the latest one first, with its name, its sidebar and the tab it showed', () => {
    const list = remember(remember([], entry(1)), entry(2, 's1', { name: 'Courses', sidebar: { docked: true } }))
    const first = takeLast(list, NO_LOCK)
    expect(first.entry).toMatchObject({ name: 'Courses', sidebar: { docked: true }, selection: { tabs: { s1: 't2' } } })
    expect(takeLast(first.rest, NO_LOCK).entry?.selection.tabs).toEqual({ s1: 't1' })
    expect(takeLast(takeLast(first.rest, NO_LOCK).rest, NO_LOCK).entry).toBeNull()
  })

  it('does not reopen a window of a space that is locked now, and drops it; it skips to the one before', () => {
    const list = [entry(1, 's1'), entry(2, 's2')]
    const { entry: taken, rest } = takeLast(list, { appLocked: false, lockedSpaces: ['s2'] })
    expect(taken?.selection.spaceId).toBe('s1')
    expect(rest).toEqual([])
  })

  it('reopens nothing while the application is locked, and keeps the list for later', () => {
    const list = [entry(1)]
    expect(takeLast(list, { appLocked: true, lockedSpaces: [] })).toEqual({ entry: null, rest: list })
  })

  it('says whether there is something to reopen now', () => {
    expect(canReopen([], NO_LOCK)).toBe(false)
    expect(canReopen([entry(1)], NO_LOCK)).toBe(true)
    expect(canReopen([entry(1)], { appLocked: true, lockedSpaces: [] })).toBe(false)
    expect(canReopen([entry(1, 's1')], { appLocked: false, lockedSpaces: ['s1'] })).toBe(false)
  })
})
