import { describe, expect, it } from 'vitest'
import { createInitialState, reduce, type Ctx } from './sidebar'
import { SESSION_WINDOWS_MAX, SHRINK_GRACE_MS, fitToDisplays, mayReplaceSession, selectionOfSaved, sessionOf, sessionWindowCount, usableSession } from './window-session'
import { selectionOf } from './window-selection'

const screen = { x: 0, y: 0, width: 1920, height: 1080 }
const second = { x: 1920, y: 0, width: 1440, height: 900 }

describe('fitToDisplays', () => {
  it('keeps a window where it was when it is on a screen', () => {
    expect(fitToDisplays({ x: 100, y: 80, width: 1200, height: 800 }, [screen])).toEqual({ x: 100, y: 80, width: 1200, height: 800 })
    expect(fitToDisplays({ x: 2000, y: 40, width: 900, height: 600 }, [screen, second])).toEqual({ x: 2000, y: 40, width: 900, height: 600 })
  })

  it('brings a window back to the first screen when the screen it was on is gone', () => {
    expect(fitToDisplays({ x: 2000, y: 40, width: 900, height: 600 }, [screen])).toEqual({ x: 510, y: 240, width: 900, height: 600 })
    // Barely on the screen (a few pixels of its edge) does not count as visible.
    expect(fitToDisplays({ x: 1900, y: 40, width: 900, height: 600 }, [screen])).toEqual({ x: 510, y: 240, width: 900, height: 600 })
  })

  it('never makes a window smaller than the minimum or bigger than the screen', () => {
    expect(fitToDisplays({ x: 0, y: 0, width: 100, height: 100 }, [screen])).toMatchObject({ width: 720, height: 480 })
    expect(fitToDisplays({ x: 0, y: 0, width: 9000, height: 9000 }, [screen])).toMatchObject({ width: 1920, height: 1080 })
  })

  it('has nowhere to put a window when there is no screen', () => {
    expect(fitToDisplays({ x: 0, y: 0, width: 800, height: 600 }, [])).toBeNull()
  })
})

describe('usableSession', () => {
  const ctx: Ctx = { now: 1, newId: (() => { let n = 0; return () => `w${++n}` })() }
  const state = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' }, ctx)
  const space = state.spaces[0]!.id

  it('reads back what sessionOf wrote', () => {
    const saved = sessionOf({ x: 10, y: 20, width: 1000, height: 700 }, [{ bounds: { x: 50, y: 60, width: 900, height: 600 }, selection: selectionOf(state) }])
    const read = usableSession(JSON.parse(JSON.stringify(saved)), [screen], state)
    expect(read.main).toEqual({ x: 10, y: 20, width: 1000, height: 700 })
    expect(read.windows).toHaveLength(1)
    expect(read.windows[0]).toMatchObject({ spaceId: space, bounds: { x: 50, y: 60 }, sidebarVisible: true })
  })

  it('remembers the names of the windows, the first one included, and drops them when there is none', () => {
    const win = { bounds: { x: 50, y: 60, width: 900, height: 600 }, selection: selectionOf(state) }
    const saved = sessionOf({ x: 10, y: 20, width: 1000, height: 700 }, [{ ...win, name: 'Travail' }, win], 'Principale')
    const read = usableSession(JSON.parse(JSON.stringify(saved)), [screen], state)
    expect(read.mainName).toBe('Principale')
    expect(read.windows.map((w) => w.name)).toEqual(['Travail', undefined])
    const unnamed = JSON.parse(JSON.stringify(sessionOf({ x: 10, y: 20, width: 1000, height: 700 }, [win])))
    expect('mainName' in unnamed).toBe(false)
    expect('name' in unnamed.windows[0]).toBe(false)
  })

  it('remembers the sidebar each window chose for itself (its side, docked), the first one included, and nothing for a window that chose nothing', () => {
    const win = { bounds: { x: 50, y: 60, width: 900, height: 600 }, selection: selectionOf(state) }
    const saved = JSON.parse(JSON.stringify(sessionOf({ x: 10, y: 20, width: 1000, height: 700 }, [{ ...win, sidebar: { side: 'right', docked: true } }, { ...win, sidebar: {} }, win], undefined, { docked: true })))
    expect(saved.mainSidebar).toEqual({ docked: true })
    expect('sidebar' in saved.windows[1]).toBe(false)
    expect('sidebar' in saved.windows[2]).toBe(false)
    const read = usableSession(saved, [screen], state)
    expect(read.mainSidebar).toEqual({ docked: true })
    expect(read.windows.map((w) => w.sidebar)).toEqual([{ side: 'right', docked: true }, undefined, undefined])
    const plain = JSON.parse(JSON.stringify(sessionOf({ x: 10, y: 20, width: 1000, height: 700 }, [win], undefined, {})))
    expect('mainSidebar' in plain).toBe(false)
  })

  it('reads a file written before the sidebar of each window, and drops a damaged one (the window opens as the new windows)', () => {
    const entry = { bounds: { x: 0, y: 0, width: 800, height: 600 }, spaceId: space, tabs: {}, sidebarVisible: true }
    const old = usableSession({ main: { x: 0, y: 0, width: 800, height: 600 }, windows: [entry] }, [screen], state)
    expect(old.mainSidebar).toBeUndefined()
    expect(old.windows[0]!.sidebar).toBeUndefined()
    const damaged = usableSession({ mainSidebar: 'right', windows: [{ ...entry, sidebar: { side: 'top', docked: 1 } }, { ...entry, sidebar: ['right'] }, { ...entry, sidebar: { side: 'left', docked: 'yes' } }] }, [screen], state)
    expect(damaged.mainSidebar).toBeUndefined()
    expect(damaged.windows.map((w) => w.sidebar)).toEqual([undefined, undefined, { side: 'left' }])
  })

  it('reads a file written before windows had names, and a file whose names are damaged', () => {
    const entry = { bounds: { x: 0, y: 0, width: 800, height: 600 }, spaceId: space, tabs: {}, sidebarVisible: true }
    const old = usableSession({ main: { x: 0, y: 0, width: 800, height: 600 }, windows: [entry] }, [screen], state)
    expect(old.mainName).toBeUndefined()
    expect(old.windows).toHaveLength(1)
    expect(old.windows[0]!.name).toBeUndefined()
    const damaged = usableSession({ mainName: { not: 'text' }, windows: [{ ...entry, name: 42 }, { ...entry, name: '   ' }, { ...entry, name: 'ok\n\u202Enom' }, { ...entry, name: 'x'.repeat(500) }] }, [screen], state)
    expect(damaged.mainName).toBeUndefined()
    expect(damaged.windows.map((w) => w.name)).toEqual([undefined, undefined, 'ok nom', 'x'.repeat(60)])
  })

  it('is empty for a file that is not a session, drops entries that are not windows, and keeps at most eight', () => {
    for (const bad of [null, 'x', 3, [], {}]) expect(usableSession(bad, [screen], state)).toEqual({ main: null, windows: [] })
    const entry = { bounds: { x: 0, y: 0, width: 800, height: 600 }, spaceId: space, tabs: {} }
    const many = { windows: [...Array.from({ length: SESSION_WINDOWS_MAX + 4 }, () => entry), 7, null, { bounds: { x: 'a' } }] }
    expect(usableSession(many, [screen], state).windows).toHaveLength(SESSION_WINDOWS_MAX)
    expect(usableSession({ windows: [7, null, { bounds: { x: 'a' } }] }, [screen], state).windows).toEqual([])
  })

  it('selects no tab in a window whose tab or space no longer exists', () => {
    const selection = selectionOfSaved({ bounds: { x: 0, y: 0, width: 800, height: 600 }, spaceId: 'gone', tabs: { [space]: 'gone-tab', other: 'x' }, sidebarVisible: false }, state)
    expect(selection.spaceId).toBe(space)
    expect(selection.tabs).toEqual({ [space]: null })
    expect(selection.layout.sidebarVisible).toBe(false)
    const kept = selectionOfSaved({ bounds: { x: 0, y: 0, width: 800, height: 600 }, spaceId: space, tabs: { [space]: state.tabs[0]!.id }, sidebarVisible: true }, state)
    expect(kept.tabs[space]).toBe(state.tabs[0]!.id)
  })
})

describe('mayReplaceSession', () => {
  it('lets a list as long as the saved one, or longer, replace it at once', () => {
    expect(mayReplaceSession(3, 3, null)).toBe(true)
    expect(mayReplaceSession(4, 3, null)).toBe(true)
    // A window that went away a moment ago does not matter when another one came.
    expect(mayReplaceSession(3, 3, 100)).toBe(true)
  })

  it('has nothing to keep when it does not know what the file holds', () => {
    expect(mayReplaceSession(1, null, null)).toBe(true)
  })

  it('keeps the saved list while fewer windows are still settling, and takes the shorter one once the grace has gone by', () => {
    expect(mayReplaceSession(1, 3, 0)).toBe(false)
    expect(mayReplaceSession(2, 3, SHRINK_GRACE_MS - 1)).toBe(false)
    expect(mayReplaceSession(2, 3, SHRINK_GRACE_MS)).toBe(true)
    // Fewer windows with no closing ever seen (a launch whose windows are not all back yet) keeps the file as well.
    expect(mayReplaceSession(1, 3, null)).toBe(false)
  })

  it('counts the first window and the others', () => {
    const rect = { x: 0, y: 0, width: 800, height: 600 }
    expect(sessionWindowCount({ main: rect, windows: [] })).toBe(1)
    expect(sessionWindowCount({ main: rect, windows: [{ bounds: rect, spaceId: 's', tabs: {}, sidebarVisible: true }, { bounds: rect, spaceId: 's', tabs: {}, sidebarVisible: true }] })).toBe(3)
    expect(sessionWindowCount({ main: null, windows: [] })).toBe(0)
  })
})
