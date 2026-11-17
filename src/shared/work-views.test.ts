// Work views: a tile that opens 2 to 4 chosen sites in a split view, in their places and proportions. What a file may hold, what the reducer makes of a
// split view on screen, what a click opens (and what a second click does not open again), and what stays out of a private window and of a lock.

import { describe, expect, it } from 'vitest'
import type { SidebarState, SplitView, WorkView } from './model'
import { createInitialState, normalize, parseSavedState, reduce, type Action } from './sidebar'
import { scrubPrivateState, privateAction } from './private-window'
import { hiddenIds, lockRefuses, namesHiddenId, redactForLock } from './lock'
import { interfaceMayDispatch } from './ipc-policy'
import { defaultSettings } from './model'
import { WORK_VIEWS_MAX, cleanWorkViews, dockWorkViews, gridShareOfPercent, opensInNewWindow, sharesOfPercents, shownWorkViews, typedWorkViewUrl, workViewOfSplit, workViewPlace, workViewRemovedUndo, workViewShown, workViewSpace, workViewSummary } from './work-views'
import { foreignFieldsOf, withForeignFields } from './state-clean'
import { frenchSpaces } from './french-typography'

let counter = 0
const ctx = { now: 1_000, newId: () => `id${++counter}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

const MAIL = 'https://mail.example/'
const AGENDA = 'https://agenda.example/'
const DOCS = 'https://docs.example/'

/** A space with the mail and the agenda side by side, at 60 / 40, and one other tab. */
function withSplit(urls = [MAIL, AGENDA]): { state: SidebarState; split: SplitView } {
  let state = run(createInitialState(ctx), { type: 'tab/open', url: 'https://tickets.example/' })
  for (const url of urls) state = run(state, { type: 'tab/open', url })
  const ids = state.tabs.slice(1).map((t) => t.id)
  state = run(state, { type: 'split/create', tabId: ids[0]!, withTabId: ids[1]! })
  for (const id of ids.slice(2)) state = run(state, { type: 'split/create', tabId: ids[0]!, withTabId: id })
  const split = state.splits[0]!
  if (urls.length === 2) state = run(state, { type: 'split/ratios', id: split.id, ratios: [0.6, 0.4] })
  return { state, split: state.splits[0]! }
}

/** The state with the split view saved as « Matin ». */
function saved(): { state: SidebarState; view: WorkView; split: SplitView } {
  const { state, split } = withSplit()
  const after = run(state, { type: 'view/save', splitId: split.id, name: 'Matin', emoji: '☀️' })
  return { state: after, view: after.workViews[0]!, split: after.splits[0]! }
}

const tabsAt = (state: SidebarState, url: string) => state.tabs.filter((t) => t.url === url)

describe('reading the work views of a file', () => {
  const pane = (url: string) => ({ url, title: url })
  const raw = (fields: Record<string, unknown>) => ({ id: 'v1', name: 'Matin', emoji: '☀️', profileId: 'default', panes: [pane(MAIL), pane(AGENDA)], orientation: 'horizontal', ratios: [0.6, 0.4], ...fields })

  it('keeps a view as it was saved', () => {
    expect(cleanWorkViews([raw({})])).toEqual([{ id: 'v1', name: 'Matin', emoji: '☀️', profileId: 'default', panes: [pane(MAIL), pane(AGENDA)], orientation: 'horizontal', ratios: [0.6, 0.4] }])
  })

  it('leaves out a site a view must not open (a script, a data page, an empty tab, a page of the application), and a view left with fewer than two sites', () => {
    const [view] = cleanWorkViews([raw({ panes: [pane(MAIL), pane('javascript:alert(1)'), pane('data:text/html,x'), pane('about:blank'), pane('chrome://settings'), pane(DOCS)] })])
    expect(view?.panes.map((p) => p.url)).toEqual([MAIL, DOCS])
    expect(cleanWorkViews([raw({ panes: [pane(MAIL), pane('javascript:alert(1)')] })])).toEqual([])
  })

  it('keeps four sites at most, and shares the stage equally when the shares do not fit the sites', () => {
    const [view] = cleanWorkViews([raw({ panes: [MAIL, AGENDA, DOCS, 'https://four.example/', 'https://five.example/'].map(pane), ratios: [0.2, 0.2, 0.2, 0.2, 0.2] })])
    expect(view?.panes).toHaveLength(4)
    expect(view?.ratios).toEqual([0.25, 0.25, 0.25, 0.25])
  })

  it('shares the stage equally when a share is under the minimum of a pane', () => {
    expect(cleanWorkViews([raw({ ratios: [0.95, 0.05] })])[0]?.ratios).toEqual([0.5, 0.5])
  })

  it('gives a blank name its default, a word that is not an emoji the default icon, and drops a place it does not know', () => {
    const [view] = cleanWorkViews([raw({ name: '   ', emoji: 'pas un emoji', target: { kind: 'ailleurs' } })])
    expect(view).toMatchObject({ name: 'Vue de travail', emoji: '💼' })
    expect(view?.target).toBeUndefined()
  })

  it('keeps no more than the limit', () => {
    const many = Array.from({ length: WORK_VIEWS_MAX + 5 }, (_, i) => raw({ id: `v${i}` }))
    expect(cleanWorkViews(many)).toHaveLength(WORK_VIEWS_MAX)
  })

  it('drops the views of a profile that no longer exists, as its favourites go', () => {
    const state = normalize({ ...createInitialState(ctx), workViews: [raw({}), raw({ id: 'v2', profileId: 'gone' })] as unknown as WorkView[] })
    expect(state.workViews.map((view) => view.id)).toEqual(['v1'])
  })

  it('reads a file of 1.0.1, which has neither views nor their setting: no view, and the function on', () => {
    const { workViews: _views, settings, ...older } = createInitialState(ctx)
    const { workViewsEnabled: _switch, ...olderSettings } = settings
    const state = parseSavedState(JSON.stringify({ ...older, settings: olderSettings }))
    expect(state.workViews).toEqual([])
    expect(state.settings.workViewsEnabled).toBe(true)
  })

  it('is kept in the file by a build that does not know it: the views are a field of the top of the state, which an older build writes back', () => {
    const { state } = saved()
    const file = JSON.parse(JSON.stringify(state)) as Record<string, unknown>
    // What a build without work views knows of the top of the state: everything but them.
    const olderTop = new Set(Object.keys(createInitialState(ctx)).filter((key) => key !== 'workViews'))
    const foreign = foreignFieldsOf(file, olderTop, new Set(Object.keys(defaultSettings())))
    const { workViews: _gone, ...older } = state
    const written = withForeignFields(older, foreign) as unknown as SidebarState
    expect(parseSavedState(JSON.stringify(written)).workViews).toEqual(state.workViews)
  })

  it('keeps the mark of a split view only while its view exists, is of the profile of the space, and is not on another split view of that space', () => {
    const { state, split } = saved()
    expect(normalize(state).splits[0]?.viewId).toBe(state.workViews[0]!.id)
    expect(normalize({ ...state, workViews: [] }).splits[0]?.viewId).toBeUndefined()
    const other = normalize({ ...state, workViews: state.workViews.map((view) => ({ ...view, profileId: 'work' })), settings: { ...state.settings, profileNames: { work: 'Travail' } } })
    expect(other.splits.find((each) => each.id === split.id)?.viewId).toBeUndefined()
  })
})

describe('view/save: « Enregistrer comme vue de travail… »', () => {
  it('keeps the sites of the split view in their order, its proportions and its profile, and marks the split view as the view’s', () => {
    const { state, view, split } = saved()
    expect(view).toMatchObject({ name: 'Matin', emoji: '☀️', profileId: 'default', orientation: 'horizontal', ratios: [0.6, 0.4] })
    expect(view.panes.map((pane) => pane.url)).toEqual([MAIL, AGENDA])
    expect(split.viewId).toBe(view.id)
    expect(workViewShown(state, view.id, state.activeSpaceId)).toBe(true)
    expect(workViewSummary(view)).toBe('2 sites, côte à côte, 60 / 40')
  })

  it('keeps a grid with its dividers', () => {
    const { state, split } = withSplit([MAIL, AGENDA, DOCS])
    const grid = run(state, { type: 'split/layout', id: split.id, layout: 'grid' }, { type: 'split/grid', id: split.id, column: 0.55, row: 0.6 })
    const view = run(grid, { type: 'view/save', splitId: split.id, name: 'Client' }).workViews[0]!
    expect(view.grid).toEqual({ column: 0.55, row: 0.6, span: 'bottom' })
    expect(workViewSummary(view)).toBe('3 sites, en grille, 55 / 45 en largeur, 60 / 40 en hauteur')
  })

  it('names a view saved without a name « Vue de travail »', () => {
    const { state, split } = withSplit()
    expect(run(state, { type: 'view/save', splitId: split.id, name: ' ' }).workViews[0]?.name).toBe('Vue de travail')
  })

  it('refuses a split view one of whose pages a view could not open again (an empty tab), and says why in the menu', () => {
    const { state, split } = withSplit([MAIL, 'about:blank'])
    expect(workViewOfSplit(state, split)).toBeNull()
    expect(run(state, { type: 'view/save', splitId: split.id, name: 'X' })).toBe(state)
  })

  it('refuses a view past the limit rather than push one out', () => {
    const { state, split } = withSplit()
    const one = saved().view
    const full = { ...state, workViews: Array.from({ length: WORK_VIEWS_MAX }, (_, i) => ({ ...one, id: `full${i}` })) }
    expect(run(full, { type: 'view/save', splitId: split.id, name: 'Un de trop' }).workViews).toHaveLength(WORK_VIEWS_MAX)
  })
})

describe('view/open: a click on the tile', () => {
  it('opens the sites in Today of the space shown, as a split view at the proportions kept, marked as the view’s, and leaves the other tabs alone', () => {
    const { state, view } = saved()
    // The split view it was saved from is gone (its tabs archived): the view opens again from its addresses.
    const archived = run(state, ...state.splits[0]!.tabIds.map((id): Action => ({ type: 'tab/archive', id })))
    expect(archived.splits).toEqual([])
    const before = archived.tabs.map((t) => t.id)
    const opened = run(archived, { type: 'view/open', id: view.id, spaceId: archived.activeSpaceId })
    const split = opened.splits.find((each) => each.viewId === view.id)!
    expect(split.ratios).toEqual([0.6, 0.4])
    const panes = split.tabIds.map((id) => opened.tabs.find((t) => t.id === id)!)
    expect(panes.map((t) => [t.url, t.pinned, t.spaceId])).toEqual([[MAIL, false, archived.activeSpaceId], [AGENDA, false, archived.activeSpaceId]])
    expect(opened.tabs.filter((t) => before.includes(t.id)).map((t) => t.url)).toEqual(archived.tabs.map((t) => t.url))
    expect(opened.activeTabBySpace[opened.activeSpaceId]).toBe(split.tabIds[0])
  })

  it('shows the same split view again at the second click, as it was left: nothing is opened twice', () => {
    const { state, view } = saved()
    const elsewhere = run(state, { type: 'tab/select', id: tabsAt(state, 'https://tickets.example/')[0]!.id })
    expect(workViewShown(elsewhere, view.id, elsewhere.activeSpaceId)).toBe(false)
    const again = run(elsewhere, { type: 'view/open', id: view.id, spaceId: elsewhere.activeSpaceId })
    expect(again.tabs).toHaveLength(elsewhere.tabs.length)
    expect(workViewShown(again, view.id, again.activeSpaceId)).toBe(true)
  })

  it('opens a tab of its own for a site that is already open in another space, and takes nothing from there', () => {
    const { state, view } = saved()
    const withOther = run(state, { type: 'space/create', name: 'Autre', emoji: '🧰', hue: 120, profileId: 'default' })
    const other = withOther.activeSpaceId
    const opened = run(withOther, { type: 'view/open', id: view.id, spaceId: other })
    expect(tabsAt(opened, MAIL).map((t) => t.spaceId).sort()).toEqual([state.activeSpaceId, other].sort())
    expect(opened.splits.filter((each) => each.viewId === view.id)).toHaveLength(2)
  })

  it('does not open a view of one profile in a space of another: its pages would have that profile’s cookies', () => {
    const { state, view } = saved()
    const work = run(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileId: 'work' })
    expect(workViewSpace(work, view, work.activeSpaceId)).toBeNull()
    expect(run(work, { type: 'view/open', id: view.id, spaceId: work.activeSpaceId })).toBe(work)
    expect(shownWorkViews(work, work.activeSpaceId)).toEqual([])
  })

  it('opens in the space it is always opened in, whatever space is shown', () => {
    const { state, view } = saved()
    const home = state.activeSpaceId
    const twoSpaces = run(state, { type: 'space/create', name: 'Clients', emoji: '🧰', hue: 120, profileId: 'default' })
    const clients = twoSpaces.activeSpaceId
    const placed = run(twoSpaces, { type: 'view/edit', id: view.id, patch: { target: { kind: 'space', spaceId: clients } } }, { type: 'space/select', id: home })
    const opened = run(placed, { type: 'view/open', id: view.id, spaceId: home })
    expect(opened.activeSpaceId).toBe(clients)
    expect(opened.splits.find((each) => each.viewId === view.id && each.spaceId === clients)).toBeDefined()
  })

  it('makes its own space once, then opens there again', () => {
    const { state, view } = saved()
    const placed = run(state, { type: 'view/edit', id: view.id, patch: { target: { kind: 'new-space' } } })
    const first = run(placed, { type: 'view/open', id: view.id })
    expect(first.spaces).toHaveLength(placed.spaces.length + 1)
    const made = first.spaces.at(-1)!
    expect(made).toMatchObject({ name: 'Matin', emoji: '☀️', profileId: 'default' })
    expect(first.workViews[0]?.target).toEqual({ kind: 'space', spaceId: made.id })
    const back = run(first, { type: 'space/select', id: state.activeSpaceId }, { type: 'view/open', id: view.id })
    expect(back.spaces).toHaveLength(first.spaces.length)
    expect(back.activeSpaceId).toBe(made.id)
  })

  it('opens in the space shown again once the space it was always opened in is gone', () => {
    const { state, view } = saved()
    const withSpace = run(state, { type: 'space/create', name: 'Clients', emoji: '🧰', hue: 120, profileId: 'default' })
    const clients = withSpace.activeSpaceId
    const gone = run(withSpace, { type: 'view/edit', id: view.id, patch: { target: { kind: 'space', spaceId: clients } } }, { type: 'space/delete', id: clients })
    expect(gone.workViews[0]?.target).toBeUndefined()
  })

  it('says when a view opens in a window of its own (the main process opens the window first)', () => {
    const { state, view } = saved()
    expect(opensInNewWindow(state, view.id)).toBe(false)
    expect(opensInNewWindow(run(state, { type: 'view/edit', id: view.id, patch: { target: { kind: 'window' } } }), view.id)).toBe(true)
  })
})

describe('the tile’s menu', () => {
  it('renames and gives another icon; a blank name keeps the one it has', () => {
    const { state, view } = saved()
    expect(run(state, { type: 'view/edit', id: view.id, patch: { name: 'Soir', emoji: '🌙' } }).workViews[0]).toMatchObject({ name: 'Soir', emoji: '🌙' })
    expect(run(state, { type: 'view/edit', id: view.id, patch: { name: '  ' } }).workViews[0]?.name).toBe('Matin')
  })

  it('refuses sites the view could not open, fewer than two or more than four, and a space of another profile', () => {
    const { state, view } = saved()
    expect(run(state, { type: 'view/edit', id: view.id, patch: { panes: [{ url: MAIL }, { url: 'javascript:alert(1)' }] } })).toBe(state)
    expect(run(state, { type: 'view/edit', id: view.id, patch: { panes: [{ url: MAIL }] } })).toBe(state)
    expect(run(state, { type: 'view/edit', id: view.id, patch: { panes: [MAIL, AGENDA, DOCS, MAIL, AGENDA].map((url) => ({ url })) } })).toBe(state)
    const work = run(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileId: 'work' })
    expect(run(work, { type: 'view/edit', id: view.id, patch: { target: { kind: 'space', spaceId: work.activeSpaceId } } })).toBe(work)
    // The whole patch is refused, not only its place: the name that came with it is not taken either.
    expect(run(work, { type: 'view/edit', id: view.id, patch: { name: 'Autre', target: { kind: 'space', spaceId: work.activeSpaceId } } })).toBe(work)
  })

  it('changes the sites and shares the stage equally when their number changes without new shares', () => {
    const { state, view } = saved()
    const edited = run(state, { type: 'view/edit', id: view.id, patch: { panes: [MAIL, AGENDA, DOCS].map((url) => ({ url })) } }).workViews[0]!
    expect(edited.panes.map((pane) => pane.url)).toEqual([MAIL, AGENDA, DOCS])
    expect(edited.ratios.map((r) => Math.round(r * 100))).toEqual([33, 33, 33])
  })

  it('moves a view among the views of its profile', () => {
    const { state, split } = withSplit()
    const two = run(state, { type: 'view/save', splitId: split.id, name: 'A' }, { type: 'view/save', splitId: split.id, name: 'B' })
    const moved = run(two, { type: 'view/move', id: two.workViews[1]!.id, direction: -1 })
    expect(moved.workViews.map((view) => view.name)).toEqual(['B', 'A'])
    expect(run(moved, { type: 'view/move', id: moved.workViews[0]!.id, direction: -1 })).toBe(moved)
  })

  it('« Enregistrer ce qui est affiché » takes the sites and the proportions on screen; nothing changes without it', () => {
    const { state, view, split } = saved()
    const changed = run(state, { type: 'tab/update', id: split.tabIds[1]!, patch: { url: 'https://agenda.example/semaine' } }, { type: 'split/ratios', id: split.id, ratios: [0.3, 0.7] })
    expect(changed.workViews[0]).toEqual(view)
    const kept = run(changed, { type: 'view/capture', id: view.id }).workViews[0]!
    expect(kept.panes.map((pane) => pane.url)).toEqual([MAIL, 'https://agenda.example/semaine'])
    expect(kept.ratios).toEqual([0.3, 0.7])
  })

  it('« Revenir aux adresses enregistrées » puts each pane back on its address and the proportions back', () => {
    const { state, view, split } = saved()
    const changed = run(state, { type: 'tab/update', id: split.tabIds[1]!, patch: { url: 'https://agenda.example/semaine' } }, { type: 'split/ratios', id: split.id, ratios: [0.3, 0.7] })
    const reset = run(changed, { type: 'view/reset', id: view.id })
    const after = reset.splits.find((each) => each.id === split.id)!
    expect(after.tabIds.map((id) => reset.tabs.find((t) => t.id === id)?.url)).toEqual([MAIL, AGENDA])
    expect(after.ratios).toEqual([0.6, 0.4])
    expect(reset.tabs).toHaveLength(changed.tabs.length)
  })

  it('« Revenir aux adresses enregistrées » opens the view again whole when its split view lost a pane, and leaves that one as it is', () => {
    const { state, split } = withSplit([MAIL, AGENDA, DOCS])
    const viewed = run(state, { type: 'view/save', splitId: split.id, name: 'Trois' })
    const lost = run(viewed, { type: 'split/remove', tabId: split.tabIds[2]! })
    const reset = run(lost, { type: 'view/reset', id: viewed.workViews[0]!.id })
    expect(reset.splits.find((each) => each.id === split.id)?.viewId).toBeUndefined()
    const fresh = reset.splits.find((each) => each.viewId === viewed.workViews[0]!.id)!
    expect(fresh.tabIds.map((id) => reset.tabs.find((t) => t.id === id)?.url)).toEqual([MAIL, AGENDA, DOCS])
  })
})

describe('view/remove and its « Annuler »', () => {
  it('takes the tile away and leaves the tabs open, in an ordinary split view', () => {
    const { state, view, split } = saved()
    const removed = run(state, { type: 'view/remove', id: view.id })
    expect(removed.workViews).toEqual([])
    expect(removed.tabs).toEqual(state.tabs)
    expect(removed.splits[0]).toMatchObject({ id: split.id, tabIds: split.tabIds })
    expect(removed.splits[0]?.viewId).toBeUndefined()
  })

  it('puts the view back at its place with the split view it had open, so that its tile is lit again', () => {
    const { state, view } = saved()
    const removed = run(state, { type: 'view/remove', id: view.id })
    const notice = workViewRemovedUndo(state, removed, { type: 'view/remove', id: view.id })!
    expect(notice.notice).toBe(frenchSpaces('Vue de travail « Matin » retirée'))
    const back = run(removed, notice.undo)
    expect(back.workViews).toEqual(state.workViews)
    expect(back.splits).toEqual(state.splits)
  })

  it('is the main process’ alone: the interface cannot hand a view of its own making back to the state', () => {
    expect(interfaceMayDispatch({ type: 'view/restore', view: {}, index: 0, splitIds: [] }, [])).toBe(false)
    expect(interfaceMayDispatch({ type: 'view/remove', id: 'v' }, [])).toBe(true)
  })
})

describe('the function switched off', () => {
  it('refuses every view/* action and keeps the views', () => {
    const { state, view, split } = saved()
    const off = run(state, { type: 'settings/update', patch: { workViewsEnabled: false } })
    for (const action of [
      { type: 'view/save', splitId: split.id, name: 'X' },
      { type: 'view/open', id: view.id },
      { type: 'view/edit', id: view.id, patch: { name: 'Y' } },
      { type: 'view/remove', id: view.id },
      { type: 'view/move', id: view.id, direction: 1 }
    ] satisfies Action[]) expect(run(off, action), action.type).toBe(off)
    expect(off.workViews).toEqual(state.workViews)
    expect(shownWorkViews(off, off.activeSpaceId)).toEqual([])
  })
})

describe('the private window and the lock', () => {
  it('keeps no view in a private window, and refuses the actions of the views there', () => {
    const { state, view } = saved()
    expect(scrubPrivateState(state).workViews).toEqual([])
    expect(privateAction({ type: 'view/open', id: view.id })).toBeNull()
    expect(privateAction({ type: 'view/save', splitId: 's', name: 'X' })).toBeNull()
  })

  it('shows no view while the application is locked: their names and addresses say what the user works on', () => {
    const { state } = saved()
    expect(redactForLock(state, { appLocked: true, lockedSpaces: [] }).workViews).toEqual([])
  })

  it('refuses to open a view in a locked space, the space it is always opened in included', () => {
    const { state, view } = saved()
    const home = state.activeSpaceId
    expect(lockRefuses({ type: 'view/open', id: view.id, spaceId: home }, [home], home, state)).toBe(true)
    const twoSpaces = run(state, { type: 'space/create', name: 'Clients', emoji: '🧰', hue: 120, profileId: 'default' })
    const clients = twoSpaces.activeSpaceId
    const placed = run(twoSpaces, { type: 'view/edit', id: view.id, patch: { target: { kind: 'space', spaceId: clients } } })
    expect(lockRefuses({ type: 'view/open', id: view.id, spaceId: home }, [clients], home, placed)).toBe(true)
    expect(lockRefuses({ type: 'view/open', id: view.id, spaceId: home }, [clients], home, state)).toBe(false)
  })

  it('refuses to save a split view a lock hides: the interface never saw it', () => {
    const { state, split } = withSplit()
    const hidden = hiddenIds(state, { appLocked: false, lockedSpaces: [state.activeSpaceId] })
    expect(namesHiddenId({ type: 'view/save', splitId: split.id, name: 'X' }, hidden)).toBe(true)
  })
})

describe('what the whole sheet reads from what is typed', () => {
  it('takes an address as the command bar would open it, and refuses words, a script and a page that is not one a view keeps', () => {
    expect(typedWorkViewUrl('mail.example.fr')).toBe('https://mail.example.fr')
    expect(typedWorkViewUrl(' https://agenda.example/semaine ')).toBe('https://agenda.example/semaine')
    expect(typedWorkViewUrl('file:///Users/moi/notes.html')).toBe('file:///Users/moi/notes.html')
    for (const text of ['', 'mon agenda', 'javascript:alert(1)', 'about:blank', 'data:text/html,x', 'chrome://settings']) expect(typedWorkViewUrl(text), text).toBeNull()
  })

  it('scales the percents typed to make the whole, and refuses a pane under 12 % or a share that is not a number above zero', () => {
    expect(sharesOfPercents([60, 40])).toEqual([0.6, 0.4])
    expect(sharesOfPercents([3, 2])).toEqual([0.6, 0.4])
    expect(sharesOfPercents([95, 5])).toBeNull()
    expect(sharesOfPercents([50, 0])).toBeNull()
    expect(sharesOfPercents([50, Number.NaN])).toBeNull()
    expect(sharesOfPercents([100])).toBeNull()
    expect(gridShareOfPercent(55)).toBe(0.55)
    expect(gridShareOfPercent(5)).toBeNull()
    expect(gridShareOfPercent(95)).toBeNull()
  })

  it('says where a view opens', () => {
    const { state, view } = saved()
    expect(workViewPlace(view, state)).toBe('S’ouvre dans l’espace affiché')
    expect(workViewPlace({ target: { kind: 'space', spaceId: state.activeSpaceId } }, state)).toBe(frenchSpaces('S’ouvre toujours dans l’espace « Perso »'))
    expect(workViewPlace({ target: { kind: 'window' } }, state)).toBe('S’ouvre dans une nouvelle fenêtre')
  })
})

describe('the menu of the Dock', () => {
  it('lists the views of the profile of the space shown, each with its icon, and none with the function off', () => {
    const { state, view } = saved()
    expect(dockWorkViews(state)).toEqual([{ id: view.id, label: '☀️ Matin' }])
    const work = run(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileId: 'work' })
    expect(dockWorkViews(work)).toEqual([])
    expect(dockWorkViews(run(state, { type: 'settings/update', patch: { workViewsEnabled: false } }))).toEqual([])
  })
})
