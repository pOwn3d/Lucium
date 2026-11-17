import { describe, expect, it } from 'vitest'
import { asideRefusal } from './sessions'
import { createInitialState, reduce, type Action } from './sidebar'
import type { SidebarState } from './model'
import { archiveRefusal, archivedSpaces, asideSessionOf, canDeleteSpace, dropIndex, manageCounts, managedSpaces, spacesLeft, stepIndex } from './space-manage'

// One counter for the whole file: every id a reducer makes is new.
let counter = 0
const ctx = { now: 1, newId: () => `id${++counter}` }
const run = (state: SidebarState, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** Four spaces (the first is the one on screen) with 2, 0, 1 and 3 tabs. */
function fourSpaces(): SidebarState {
  let state = createInitialState(ctx)
  const first = state.spaces[0]!.id
  state = run(state, { type: 'space/create', name: 'Perso', emoji: '🏡', hue: 100 }, { type: 'space/create', name: 'Études', emoji: '📚', hue: 150, profileId: 'default' }, { type: 'space/create', name: 'Client ACME', emoji: '🚀', hue: 200, letterIcon: { letter: 'ac' } })
  const ids = state.spaces.map((s) => s.id)
  state = run(state, { type: 'space/select', id: first })
  const open = (spaceId: string, n: number) => Array.from({ length: n }, (_, i) => ({ type: 'tab/open', url: `https://${spaceId}-${i}.example/`, spaceId, background: true }) as Action)
  return run(state, ...open(ids[0]!, 2), ...open(ids[2]!, 1), ...open(ids[3]!, 3))
}

describe('the rows of "Gérer les espaces"', () => {
  it('list the spaces in the order of the sidebar with their tabs, profile and the one on screen', () => {
    const state = fourSpaces()
    const rows = managedSpaces(state)
    expect(rows.map((row) => row.name)).toEqual([state.spaces[0]!.name, 'Perso', 'Études', 'Client ACME'])
    expect(rows.map((row) => row.tabs)).toEqual([2, 0, 1, 3])
    expect(rows.map((row) => row.current)).toEqual([true, false, false, false])
    expect(rows.every((row) => row.profile === 'Profil par défaut' || row.profile.length > 0)).toBe(true)
  })

  it('name the icon of a space in plain text: the letters of a letter icon, else the emoji', () => {
    expect(managedSpaces(fourSpaces()).map((row) => row.glyph)).toEqual([expect.any(String), '🏡', '📚', 'AC'])
  })

  it('count the spaces and their tabs, and the archived ones; what waits to be deleted is not counted', () => {
    const state = fourSpaces()
    expect(manageCounts(state)).toEqual({ spaces: 4, tabs: 6, archived: 0 })
    expect(manageCounts(state, new Set([state.spaces[3]!.id]))).toEqual({ spaces: 3, tabs: 3, archived: 0 })
    expect(spacesLeft(state, new Set([state.spaces[1]!.id, state.spaces[2]!.id]))).toBe(2)
  })

  // With windows of their own, the window lists its own tabs only; the snapshot gives the tabs of every window, which a deletion closes too.
  it('count the tabs of every window when they are given, and their own otherwise', () => {
    const state = fourSpaces()
    const [a, b, c, d] = state.spaces.map((space) => space.id)
    const everyWindow = { [a!]: 5, [b!]: 1, [c!]: 1, [d!]: 3 }
    expect(managedSpaces(state, everyWindow).map((row) => row.tabs)).toEqual([5, 1, 1, 3])
    expect(manageCounts(state, new Set(), everyWindow)).toEqual({ spaces: 4, tabs: 10, archived: 0 })
    expect(manageCounts(state, new Set([a!]), everyWindow)).toEqual({ spaces: 3, tabs: 5, archived: 0 })
    // A space the counts do not name (it came after them) is counted from the window's own tabs.
    expect(managedSpaces(state, { [a!]: 5 }).map((row) => row.tabs)).toEqual([5, 0, 1, 3])
  })
})

describe('archiving', () => {
  it('puts a space aside as a session, listed under "Archivés" with its name, icon, profile and tab count', () => {
    let state = fourSpaces()
    const acme = state.spaces[3]!.id
    state = run(state, { type: 'space/aside', id: acme })
    expect(state.spaces.map((s) => s.name)).not.toContain('Client ACME')
    const archived = archivedSpaces(state)
    expect(archived).toHaveLength(1)
    expect(archived[0]).toMatchObject({ name: 'Client ACME', glyph: 'AC', tabs: 3 })
    expect(manageCounts(state)).toEqual({ spaces: 3, tabs: 3, archived: 1 })
    expect(asideSessionOf(state, acme)).toBe(archived[0]!.sessionId)
  })

  it('is given back at its place with its tabs by "Restaurer"', () => {
    let state = fourSpaces()
    const before = state.spaces.map((s) => s.name)
    const study = state.spaces[2]!.id
    state = run(state, { type: 'space/aside', id: study })
    const session = archivedSpaces(state)[0]!.sessionId
    state = run(state, { type: 'space/reopen', id: session })
    expect(state.spaces.map((s) => s.name)).toEqual(before)
    expect(state.tabs.filter((tab) => tab.spaceId === study)).toHaveLength(1)
    expect(archivedSpaces(state)).toEqual([])
    expect(asideSessionOf(state, study)).toBeNull()
  })

  it('is refused for the only space, with the reason the panel puts in the button', () => {
    const state = createInitialState(ctx)
    expect(asideRefusal(state, state.spaces[0]!.id)).not.toBeNull()
    expect(run(state, { type: 'space/aside', id: state.spaces[0]!.id })).toBe(state)
  })

  it('leaves out the sessions that are not spaces', () => {
    const state = fourSpaces()
    const withSession = run(state, { type: 'session/save', name: 'Veille' })
    expect(withSession.sessions.length).toBeGreaterThan(0)
    expect(archivedSpaces(withSession)).toEqual([])
  })
})

describe('the order', () => {
  const spaces = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]

  it('follows a drop: the dragged space takes the place of the one it is dropped on', () => {
    expect(dropIndex(spaces, 'a', 'c')).toBe(2)
    expect(dropIndex(spaces, 'd', 'b')).toBe(1)
    expect(dropIndex(spaces, 'b', 'a')).toBe(0)
  })

  it('leaves the order alone for a drop on itself or on a row that is gone', () => {
    expect(dropIndex(spaces, 'b', 'b')).toBeNull()
    expect(dropIndex(spaces, 'b', 'zzz')).toBeNull()
    expect(dropIndex(spaces, 'zzz', 'b')).toBeNull()
  })

  it('gives the same order in the sidebar as in the panel once the move is made', () => {
    let state = fourSpaces()
    const ids = state.spaces.map((s) => s.id)
    state = run(state, { type: 'space/move', id: ids[0]!, toIndex: dropIndex(state.spaces, ids[0]!, ids[2]!)! })
    expect(state.spaces.map((s) => s.id)).toEqual([ids[1], ids[2], ids[0], ids[3]])
    state = run(state, { type: 'space/move', id: ids[3]!, toIndex: dropIndex(state.spaces, ids[3]!, ids[1]!)! })
    expect(state.spaces.map((s) => s.id)).toEqual([ids[3], ids[1], ids[2], ids[0]])
  })

  it('moves one step with ⌥↑ and ⌥↓, and nowhere past either end', () => {
    expect(stepIndex(spaces, 'b', -1)).toBe(0)
    expect(stepIndex(spaces, 'b', 1)).toBe(2)
    expect(stepIndex(spaces, 'a', -1)).toBeNull()
    expect(stepIndex(spaces, 'd', 1)).toBeNull()
    expect(stepIndex(spaces, 'zzz', 1)).toBeNull()
    let state = fourSpaces()
    const ids = state.spaces.map((s) => s.id)
    state = run(state, { type: 'space/move', id: ids[1]!, toIndex: stepIndex(state.spaces, ids[1]!, 1)! })
    expect(state.spaces.map((s) => s.id)).toEqual([ids[0], ids[2], ids[1], ids[3]])
  })
})

describe('what cannot be deleted or archived', () => {
  const none: ReadonlySet<string> = new Set()

  it('lets a space be deleted or archived while others are left', () => {
    const state = fourSpaces()
    const id = state.spaces[2]!.id
    expect(canDeleteSpace(state, none, id)).toBe(true)
    expect(archiveRefusal(state, none, id)).toBeNull()
  })

  it('keeps the last space: it cannot be deleted, archived, or put aside', () => {
    const state = createInitialState(ctx)
    const id = state.spaces[0]!.id
    expect(canDeleteSpace(state, none, id)).toBe(false)
    expect(archiveRefusal(state, none, id)).toContain('au moins un espace')
  })

  it('counts the spaces that wait to be deleted as gone: the one that is left cannot go too', () => {
    let state = createInitialState(ctx)
    state = run(state, { type: 'space/create', name: 'Perso', emoji: '🏡', hue: 100 })
    const [a, b] = state.spaces.map((s) => s.id) as [string, string]
    expect(canDeleteSpace(state, none, b)).toBe(true)
    // "a" waits for its deletion: "b" is the last one, though the state still holds two.
    expect(canDeleteSpace(state, new Set([a]), b)).toBe(false)
    expect(archiveRefusal(state, none, b)).toBeNull()
    expect(archiveRefusal(state, new Set([a]), b)).toContain('au moins un espace')
  })

  it('knows nothing of a space that is not there', () => {
    expect(canDeleteSpace(fourSpaces(), none, 'zzz')).toBe(false)
    expect(archiveRefusal(fourSpaces(), none, 'zzz')).not.toBeNull()
  })

  it('gives the reason of the limits of putting a space aside (a sentence for the button)', () => {
    const state = fourSpaces()
    const crowded = { ...state, sessions: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, createdAt: 0, tabs: [] })) }
    expect(archiveRefusal(crowded, none, state.spaces[1]!.id)).toMatch(/limite|100/i)
  })
})
