// Private tabs of a normal window: they exist in the state a window shows, and in no place that is kept (file, archive, session, copy, history, ranking).

import { describe, expect, it } from 'vitest'
import { copyDataOf } from './session-backups'
import { privateAction } from './private-window'
import { createInitialState, normalize, parseSavedState, persistableState, reduce, restoredState, withoutPrivateTabs, type Action, type Ctx } from './sidebar'
import { newTabOf, suggestionQuery, usageKey, type Candidate } from './command-bar'
import type { SidebarState } from './model'

let counter = 0
const ctx: Ctx = { now: 1_000_000, newId: () => `id${++counter}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

function start(): SidebarState {
  counter = 0
  return createInitialState(ctx)
}

/** A state with two normal tabs and one private tab selected. */
function withPrivate(): { state: SidebarState; privateId: string; normalIds: string[] } {
  const base = run(start(), { type: 'tab/open', url: 'https://normal.example/a' }, { type: 'tab/open', url: 'https://normal.example/b', background: true })
  const state = run(base, { type: 'tab/open', url: 'https://secret.example/page', private: true })
  const privateId = state.tabs.find((t) => t.private)!.id
  return { state, privateId, normalIds: state.tabs.filter((t) => !t.private).map((t) => t.id) }
}

describe('opening a private tab', () => {
  it('marks the tab, and selects it like any other', () => {
    const { state, privateId } = withPrivate()
    expect(state.tabs.find((t) => t.id === privateId)).toMatchObject({ private: true, url: 'https://secret.example/page' })
    expect(state.activeTabBySpace[state.activeSpaceId]).toBe(privateId)
  })

  it('is refused while the setting is off: it never comes out as an ordinary tab that is saved', () => {
    const off = run(start(), { type: 'settings/update', patch: { privateTabs: false } })
    const after = run(off, { type: 'tab/open', url: 'https://secret.example/', private: true })
    expect(after.tabs).toHaveLength(0)
    expect(run(off, { type: 'tab/open', url: 'https://ok.example/' }).tabs).toHaveLength(1)
  })

  it('a duplicate of a private tab is private', () => {
    const { state, privateId } = withPrivate()
    const copy = run(state, { type: 'tab/duplicate', id: privateId }).tabs.at(-1)!
    expect(copy).toMatchObject({ private: true, url: 'https://secret.example/page' })
  })
})

describe('what a private tab never reaches', () => {
  it('the archive: closing, archiving, sweeping, archiving a group or many never record its address', () => {
    const { state, privateId, normalIds } = withPrivate()
    const stale = { ...state, tabs: state.tabs.map((t) => ({ ...t, lastActiveAt: 0 })), activeTabBySpace: { [state.activeSpaceId]: normalIds[0]! } }
    const urls = (s: SidebarState) => JSON.stringify(s.archive)
    expect(urls(run(state, { type: 'tab/archive', id: privateId }))).not.toContain('secret.example')
    expect(run(state, { type: 'tab/archive', id: privateId }).tabs.some((t) => t.id === privateId)).toBe(false)
    expect(urls(run(state, { type: 'tabs/archive-many', ids: [privateId] }))).not.toContain('secret.example')
    expect(urls(run(state, { type: 'tab/close', id: privateId }))).not.toContain('secret.example')
    const later: Ctx = { ...ctx, now: 100 * 3_600_000 }
    const swept = reduce(stale, { type: 'archive/sweep' }, later)
    expect(swept.archive.length).toBeGreaterThan(0)
    expect(urls(swept)).not.toContain('secret.example')
    expect(swept.tabs.some((t) => t.id === privateId)).toBe(false)
    expect(urls(run(state, { type: 'tab/archive-group', id: normalIds[0]!, scope: 'others' }))).not.toContain('secret.example')
    // The normal tabs are archived as ever.
    expect(run(state, { type: 'tab/archive', id: normalIds[0]! }).archive).toHaveLength(1)
  })

  it('the pinned list and the folders: a private tab is not pinned, not moved there, not put in a folder', () => {
    const { state, privateId } = withPrivate()
    expect(run(state, { type: 'tab/pin', id: privateId }).tabs.find((t) => t.id === privateId)!.pinned).toBe(false)
    expect(run(state, { type: 'tab/move', id: privateId, toIndex: 0, pinned: true }).tabs.find((t) => t.id === privateId)!.pinned).toBe(false)
    expect(run(state, { type: 'tabs/move', ids: [privateId], toIndex: 0, pinned: true }).tabs.find((t) => t.id === privateId)!.pinned).toBe(false)
    const folder = run(state, { type: 'folder/create-with', tabIds: [privateId] })
    expect(folder.tabs.find((t) => t.id === privateId)).toMatchObject({ pinned: false })
    expect(folder.tabs.find((t) => t.id === privateId)!.folderId).toBeUndefined()
  })

  it('the read-later list and the named sessions', () => {
    const { state, privateId, normalIds } = withPrivate()
    expect(run(state, { type: 'readlater/add', tabId: privateId }).readLater).toHaveLength(0)
    expect(run(state, { type: 'readlater/add', tabId: privateId }).tabs.some((t) => t.id === privateId)).toBe(true)
    const saved = run(state, { type: 'session/save', name: 's' })
    expect(JSON.stringify(saved.sessions)).not.toContain('secret.example')
    expect(saved.sessions[0]!.tabs).toHaveLength(2)
    expect(run(state, { type: 'session/save', tabIds: [privateId] }).sessions).toHaveLength(0)
    expect(normalIds).toHaveLength(2)
  })

  it('a space put aside: its private tabs are closed with it, not kept in the session', () => {
    const { state } = withPrivate()
    const second = run(state, { type: 'space/create', name: 'Autre', emoji: '🌿', hue: 100 })
    const aside = run({ ...second, activeSpaceId: state.activeSpaceId }, { type: 'space/aside', id: state.activeSpaceId })
    expect(JSON.stringify(aside)).not.toContain('secret.example')
    expect(aside.tabs.some((t) => t.private)).toBe(false)
    expect(aside.sessions[0]!.space!.tabs).toHaveLength(2)
  })

  it('the ranking of the command bar: the address of a private tab is not learnt, from whatever tab it is chosen', () => {
    const { state, normalIds } = withPrivate()
    const onNormal = run(state, { type: 'tab/select', id: normalIds[0]! })
    const used = run(onNormal, { type: 'commandbar/used', key: usageKey('https://secret.example/page') })
    expect(used.commandBarUsage).toEqual({})
    expect(run(onNormal, { type: 'commandbar/used', key: usageKey('https://normal.example/a') }).commandBarUsage).toEqual({ default: { [usageKey('https://normal.example/a')]: 1 } })
  })

  // « Nouvel onglet privé » opens a blank private tab and the bar over it: when the line is chosen the tab is still at `about:blank`, so the
  // address typed (or the search, with its words) cannot be told from the tabs. Nothing chosen over a private tab is learnt.
  it('the ranking of the command bar: what is typed or chosen in the bar over a private tab, before the tab has gone anywhere', () => {
    const blank = run(start(), { type: 'tab/open', url: 'https://normal.example/a' }, { type: 'tab/open', url: 'about:blank', private: true })
    expect(blank.tabs.find((t) => t.private)).toMatchObject({ url: 'about:blank' })
    for (const typed of ['https://clinic.example/', 'https://search.example/?q=symptoms+of', 'https://normal.example/a']) {
      const after = run(blank, { type: 'commandbar/used', key: usageKey(typed) })
      expect(after).toBe(blank)
      expect(persistableState(after).commandBarUsage).toEqual({})
    }
    // The same bar over a normal tab of the same window still learns.
    const normal = run(blank, { type: 'tab/select', id: blank.tabs.find((t) => !t.private)!.id })
    expect(run(normal, { type: 'commandbar/used', key: usageKey('https://clinic.example/') }).commandBarUsage).toEqual({ default: { [usageKey('https://clinic.example/')]: 1 } })
  })

  it('the automatic copies of the session, when they are made from what may be kept', () => {
    const { state } = withPrivate()
    expect(JSON.stringify(copyDataOf(persistableState(state)))).not.toContain('secret.example')
  })
})

describe('⌘↩ on a line of the command bar', () => {
  const line = (tabId: string, url: string): Candidate => ({ kind: 'tab', id: `tab:${tabId}`, label: 'Page', detail: '', tabId, url })

  it('opens the page of a private tab in another private tab, never in an ordinary one', () => {
    const { state, privateId, normalIds } = withPrivate()
    expect(newTabOf(line(privateId, 'https://secret.example/page'), state)).toEqual({ how: 'private', url: 'https://secret.example/page' })
    expect(newTabOf(line(normalIds[0]!, 'https://normal.example/a'), state)).toEqual({ how: 'submit', url: 'https://normal.example/a' })
    // What the bar then sends is a private tab for the reducer, and nothing of it is kept.
    const after = run(state, { type: 'tab/open', url: 'https://secret.example/page', private: true })
    expect(after.tabs.filter((t) => t.url === 'https://secret.example/page').every((t) => t.private === true)).toBe(true)
    expect(JSON.stringify(persistableState(after))).not.toContain('secret.example')
  })

  it('opens an address or a page of the history in a new tab, and does what ↩ does for a line with no page', () => {
    const { state } = withPrivate()
    expect(newTabOf({ kind: 'open', id: 'o', label: 'x', detail: '', url: 'https://exemple.fr/' }, state)).toEqual({ how: 'submit', url: 'https://exemple.fr/' })
    expect(newTabOf({ kind: 'history', id: 'h', label: 'x', detail: '', url: 'https://exemple.fr/h' } as Candidate, state)).toEqual({ how: 'submit', url: 'https://exemple.fr/h' })
    expect(newTabOf({ kind: 'suggestion', id: 's', label: 'x', query: 'x' } as Candidate, state)).toEqual({ how: 'run' })
  })
})

describe('what the bar asks the search engine suggestions for', () => {
  const anywhere = { staysPrivate: false, genre: null, siteSearch: false } as const

  it('is the text typed, trimmed', () => {
    expect(suggestionQuery('  recette de crêpes ', anywhere)).toBe('recette de crêpes')
  })

  it('is nothing over a private tab, inside a genre, or while the text is for the search of a site', () => {
    expect(suggestionQuery('recette', { ...anywhere, staysPrivate: true })).toBeNull()
    expect(suggestionQuery('recette', { ...anywhere, genre: 'tabs' })).toBeNull()
    expect(suggestionQuery('recette', { ...anywhere, siteSearch: true })).toBeNull()
  })

  it('is nothing for an address, a single character or a text with a run of spaces', () => {
    for (const text of ['exemple.fr', 'https://exemple.fr/a', 'a', 'deux  mots']) expect(suggestionQuery(text, anywhere), text).toBeNull()
  })
})

describe('what leaves memory', () => {
  it('persistableState leaves private tabs out and repairs what pointed at them', () => {
    const { state, privateId, normalIds } = withPrivate()
    const split = run(state, { type: 'split/create', tabId: normalIds[0]!, withTabId: privateId })
    expect(split.splits).toHaveLength(1)
    const kept = persistableState(split)
    expect(kept.tabs.map((t) => t.id)).toEqual(normalIds)
    expect(kept.splits).toHaveLength(0)
    expect(JSON.stringify(kept)).not.toContain('secret.example')
    expect(JSON.stringify(kept)).not.toContain('"private"')
  })

  it('persistableState does not leave the selection on a tab that is gone', () => {
    const { state, privateId } = withPrivate()
    expect(state.activeTabBySpace[state.activeSpaceId]).toBe(privateId)
    expect(persistableState(state).activeTabBySpace[state.activeSpaceId]).toBeNull()
  })

  it('is the very same object when there is no private tab', () => {
    const plain = run(start(), { type: 'tab/open', url: 'https://normal.example/' })
    expect(persistableState(plain)).toBe(plain)
    expect(withoutPrivateTabs(plain)).toBe(plain)
  })

  it('a state that is written and read back has none', () => {
    const { state } = withPrivate()
    const reread = parseSavedState(JSON.stringify(state))
    expect(reread.tabs.some((t) => t.private)).toBe(false)
    expect(JSON.stringify(reread)).not.toContain('secret.example')
    expect(restoredState(JSON.parse(JSON.stringify(state)))!.tabs.some((t) => t.private)).toBe(false)
  })

  it('the state a window shows keeps the flag through normalisation (undo, projection), unchanged by a second round', () => {
    const { state } = withPrivate()
    const once = normalize(state)
    expect(once.tabs.filter((t) => t.private)).toHaveLength(1)
    expect(normalize(once)).toStrictEqual(once)
    expect(normalize(JSON.parse(JSON.stringify(once)))).toStrictEqual(once)
  })

  it('a flag that is not exactly true is no flag', () => {
    const { state } = withPrivate()
    const odd = JSON.parse(JSON.stringify(state)) as SidebarState
    ;(odd.tabs[0] as unknown as Record<string, unknown>)['private'] = 'true'
    expect(normalize(odd).tabs[0]!.private).toBeUndefined()
  })
})

describe('in a private window', () => {
  it('the flag is dropped from the action: every tab there is private already', () => {
    const action = privateAction({ type: 'tab/open', url: 'https://a.example/', private: true })
    expect(action).toEqual({ type: 'tab/open', url: 'https://a.example/' })
    expect(privateAction({ type: 'tab/open', url: 'https://a.example/' })).toEqual({ type: 'tab/open', url: 'https://a.example/' })
  })
})
