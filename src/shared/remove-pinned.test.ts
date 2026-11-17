// Taking a pinned tab out of the pinned ones, to the archive (the cross of a pinned tab that is already asleep does it: see src/main/shell/pinned-cross.test.ts).

import { describe, expect, it } from 'vitest'
import type { SidebarState } from './model'
import { createInitialState, normalize, reduce, type Action } from './sidebar'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

const withPinned = (): { state: SidebarState; pinnedId: string; todayId: string } => {
  let state = run(createInitialState(ctx), { type: 'tab/open', url: 'https://pinned.example.org/' }, { type: 'tab/open', url: 'https://today.example.org/' })
  const [first, second] = state.tabs.slice(-2)
  state = run(state, { type: 'tab/pin', id: first!.id })
  return { state, pinnedId: first!.id, todayId: second!.id }
}

describe('tab/remove-pinned', () => {
  it('takes a pinned tab out of the tabs and puts it in the archive, where it can come back', () => {
    const { state, pinnedId } = withPinned()
    expect(state.tabs.find((t) => t.id === pinnedId)?.pinned).toBe(true)
    const after = run(state, { type: 'tab/remove-pinned', id: pinnedId })
    expect(after.tabs.some((t) => t.id === pinnedId)).toBe(false)
    expect(after.archive[0]).toMatchObject({ id: pinnedId, url: 'https://pinned.example.org/' })
    // The other tabs stay.
    expect(after.tabs).toHaveLength(state.tabs.length - 1)
  })

  it('does nothing for a tab that is not pinned, or that does not exist', () => {
    const { state, todayId } = withPinned()
    expect(run(state, { type: 'tab/remove-pinned', id: todayId })).toBe(state)
    expect(run(state, { type: 'tab/remove-pinned', id: 'nobody' })).toBe(state)
  })

  it('leaves tab/archive as it was: it still refuses a pinned tab', () => {
    const { state, pinnedId } = withPinned()
    expect(run(state, { type: 'tab/archive', id: pinnedId })).toBe(state)
  })
})

// ---- the archive keeps where a pinned tab was ----

const inFolder = (): { state: SidebarState; tabId: string; folderId: string } => {
  const { state: pinned, pinnedId } = withPinned()
  let state = run(pinned, { type: 'folder/create', name: 'Travail' })
  const folderId = state.folders.at(-1)!.id
  state = run(state, { type: 'tab/move', id: pinnedId, toIndex: 0, pinned: true, folderId })
  return { state, tabId: pinnedId, folderId }
}

/** The pinned tab of `inFolder`, gone from its anchor to another page of the site: the archive has to keep the two addresses apart. */
const ANCHOR = 'https://pinned.example.org/'
const DEEP = 'https://pinned.example.org/deep/page'
const awayFromAnchor = (): { state: SidebarState; tabId: string; folderId: string } => {
  const { state, tabId, folderId } = inFolder()
  return { state: run(state, { type: 'tab/update', id: tabId, patch: { url: DEEP } }), tabId, folderId }
}

describe('a pinned tab that goes to the archive', () => {
  it('keeps that it was pinned, its anchor address and its folder', () => {
    const { state, tabId, folderId } = awayFromAnchor()
    expect(state.tabs.find((t) => t.id === tabId)).toMatchObject({ url: DEEP, anchorUrl: ANCHOR })
    const entry = run(state, { type: 'tab/remove-pinned', id: tabId }).archive[0]!
    expect(entry).toMatchObject({ id: tabId, url: DEEP, pinned: true, anchorUrl: ANCHOR, folderId })
  })

  it('comes back pinned, at its anchor address and in its folder (what the "Annuler" of the notice does)', () => {
    const { state, tabId, folderId } = awayFromAnchor()
    const back = run(state, { type: 'tab/remove-pinned', id: tabId }, { type: 'archive/restore-last' })
    // The page it was on comes back, and the anchor it goes back to is still the one it was pinned at.
    const restored = back.tabs.find((t) => t.url === DEEP)!
    expect(restored).toMatchObject({ pinned: true, anchorUrl: ANCHOR, folderId })
    expect(back.archive).toHaveLength(state.archive.length)
  })

  it('comes back at the root of the pinned ones when its folder is gone', () => {
    const { state, tabId, folderId } = inFolder()
    const archived = run(state, { type: 'tab/remove-pinned', id: tabId })
    const withoutFolder = { ...archived, folders: archived.folders.filter((f) => f.id !== folderId) }
    const back = run(withoutFolder, { type: 'archive/restore', id: tabId })
    const restored = back.tabs.find((t) => t.url === 'https://pinned.example.org/')!
    expect(restored.pinned).toBe(true)
    expect(restored.folderId).toBeUndefined()
  })

  it('leaves a tab of the day as it was: it comes back as a tab of the day, with nothing of a pin in the archive', () => {
    const { state, todayId } = withPinned()
    const archived = run(state, { type: 'tab/archive', id: todayId })
    expect(archived.archive[0]!).not.toHaveProperty('pinned')
    expect(archived.archive[0]!).not.toHaveProperty('anchorUrl')
    const back = run(archived, { type: 'archive/restore', id: todayId })
    expect(back.tabs.find((t) => t.url === 'https://today.example.org/')?.pinned).toBe(false)
  })
})

describe('the archive in a saved state', () => {
  it('keeps what an entry says of the pin, and drops what is not valid', () => {
    const { state, tabId, folderId } = inFolder()
    const archived = run(state, { type: 'tab/remove-pinned', id: tabId })
    const kept = normalize(JSON.parse(JSON.stringify(archived))).archive[0]!
    expect(kept).toMatchObject({ pinned: true, folderId })
    const damaged = JSON.parse(JSON.stringify(archived))
    damaged.archive[0].anchorUrl = 'javascript:alert(1)'
    damaged.archive[0].folderId = 42
    const cleaned = normalize(damaged).archive[0]!
    expect(cleaned.pinned).toBe(true)
    expect(cleaned.anchorUrl).toBeUndefined()
    expect(cleaned.folderId).toBeUndefined()
    // An entry that says nothing of a pin is not given one.
    const plain = JSON.parse(JSON.stringify(archived))
    delete plain.archive[0].pinned
    plain.archive[0].anchorUrl = 'https://x.example.org/'
    expect(normalize(plain).archive[0]).not.toHaveProperty('anchorUrl')
  })
})
