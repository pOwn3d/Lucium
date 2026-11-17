// ⌃Tab: the order of use, a split view as one entry, the size of the panel.

import { describe, expect, it } from 'vitest'
import type { SidebarState } from './model'
import { createInitialState, reduce, type Action, type Ctx } from './sidebar'
import { CYCLE_PANEL, cyclePanelWidth, decideCycleKey, firstSelection, parseCycleKey, recentCards, stepSelection, visibleRecentCards, type CycleKey, type CycleKeyContext } from './tab-cycle'
import { keyLayoutOf } from './keybindings'

function makeCtx(now = 1_000_000): Ctx & { now: number } {
  let n = 0
  return { now, newId: () => `id${++n}` }
}
const run = (ctx: Ctx, state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** The cycle as the browser makes it from a key press: the order, then the tab each ⌃Tab lands on. */
const landings = (state: SidebarState, presses: number): string[] => {
  const ids: string[] = []
  let current = state
  const ctx = makeCtx(5_000_000)
  // What the window keeps: the moment each tab was left.
  const usedAt = new Map<string, number>()
  for (let i = 0; i < presses; i++) {
    const cards = recentCards(current, { usedAt })
    const index = firstSelection(cards.length, 1)
    if (index === null) break
    const target = cards[index]!.id
    ids.push(target)
    ctx.now += 10
    const leaving = current.activeTabBySpace[current.activeSpaceId]
    if (leaving) usedAt.set(leaving, ctx.now)
    current = reduce(current, { type: 'tab/select', id: target }, ctx)
  }
  return ids
}

/** Three tabs: 1 on screen, 2 and 3 never visited, 3 created last (the test of §4). */
function threeTabs() {
  const ctx = makeCtx()
  let state = createInitialState(ctx)
  for (const host of ['one', 'two', 'three']) {
    ctx.now += 100
    state = run(ctx, state, { type: 'tab/open', url: `https://${host}.example/`, background: host !== 'one' })
  }
  const [one, two, three] = state.tabs
  return { ctx, state, one: one!, two: two!, three: three! }
}

describe('the order of use', () => {
  it('puts the tab on screen first, then the others from the most recently used (a tab never visited counts from its creation)', () => {
    const { state, one, two, three } = threeTabs()
    expect(recentCards(state).map((c) => c.id)).toEqual([one.id, three.id, two.id])
  })

  it('toggles between the last two tabs: 3 → 1 → 3 → 1, and the third tab is never reached', () => {
    const { state, one, three } = threeTabs()
    expect(landings(state, 4)).toEqual([three.id, one.id, three.id, one.id])
  })

  it('counts the moment a tab was left: the tab that was on screen when others were opened is more recent than they are', () => {
    const { state, one, two, three } = threeTabs()
    const left = new Map([[one.id, 9_000_000]])
    // Tab 3 is on screen now (selected after 1 was left).
    const ctx = makeCtx(9_000_100)
    const on3 = reduce(state, { type: 'tab/select', id: three.id }, ctx)
    expect(recentCards(on3, { usedAt: left }).map((c) => c.id)).toEqual([three.id, one.id, two.id])
    expect(recentCards(on3).map((c) => c.id)).toEqual([three.id, two.id, one.id])
  })

  it('follows the order tabs are visited in, not their order in the sidebar', () => {
    const { ctx, state, one, two, three } = threeTabs()
    ctx.now += 1000
    const visited = run(ctx, state, { type: 'tab/select', id: two.id })
    ctx.now += 1000
    const again = reduce(visited, { type: 'tab/select', id: three.id }, ctx)
    ctx.now += 1000
    const last = reduce(again, { type: 'tab/select', id: one.id }, ctx)
    expect(recentCards(last).map((c) => c.id)).toEqual([one.id, three.id, two.id])
  })

  it('goes back with the shift: the first stop is the last entry of the list', () => {
    const { state, two } = threeTabs()
    const cards = recentCards(state)
    expect(cards[firstSelection(cards.length, -1)!]!.id).toBe(two.id)
    expect(firstSelection(3, 1)).toBe(1)
    expect(firstSelection(3, -1)).toBe(2)
  })

  it('has nowhere to go with a single tab or none', () => {
    expect(firstSelection(1, 1)).toBeNull()
    expect(firstSelection(0, -1)).toBeNull()
  })

  it('wraps around in both directions', () => {
    expect([0, 1, 2].map((i) => stepSelection(i, 3, 1))).toEqual([1, 2, 0])
    expect([0, 1, 2].map((i) => stepSelection(i, 3, -1))).toEqual([2, 0, 1])
    expect(stepSelection(0, 0, 1)).toBe(0)
  })

  it('looks at the tabs of the space on screen only, and leaves out the tabs another window shows', () => {
    const { ctx, state, one, two, three } = threeTabs()
    const other = reduce(state, { type: 'space/create', name: 'Autre', emoji: '🧪', hue: 100 }, ctx)
    expect(recentCards(other)).toEqual([])
    expect(recentCards(state, { exclude: new Set([three.id]) }).map((c) => c.id)).toEqual([one.id, two.id])
    // The tab on screen stays first even when it is the oldest.
    expect(recentCards(state)[0]!.id).toBe(one.id)
  })
})

describe('a split view', () => {
  it('is one entry, at the place of the member used last, and the entry selects that member', () => {
    const { ctx, state, one, two, three } = threeTabs()
    ctx.now += 1000
    let next = reduce(state, { type: 'split/create', tabId: two.id, withTabId: three.id }, ctx)
    ctx.now += 1000
    next = reduce(next, { type: 'tab/select', id: one.id }, ctx)
    const cards = recentCards(next)
    expect(cards.map((c) => c.members.map((m) => m.id))).toEqual([[one.id], [two.id, three.id]])
    expect(cards[1]!.orientation).toBe('horizontal')
    expect(cards[1]!.grid).toBeUndefined()
    // `select` of the pair took two first; three was never shown after: the pair lands on the member the split selected.
    expect([two.id, three.id]).toContain(cards[1]!.id)
  })

  it('in a grid is drawn as its grid: the side of the pane along it with three members, none with four', () => {
    const { ctx, state, one, two, three } = threeTabs()
    let next = reduce(state, { type: 'split/create', tabId: two.id, withTabId: three.id }, ctx)
    next = reduce(next, { type: 'split/create', tabId: one.id, withTabId: two.id, zone: 'bottom' }, ctx)
    expect(recentCards(next)[0]).toMatchObject({ members: [{ id: two.id }, { id: three.id }, { id: one.id }], grid: { span: 'bottom' } })
    // A fourth tab, joined without a place: the free half of the long pane, 2 x 2.
    const added = reduce(next, { type: 'tab/open', url: 'https://four.example/', background: true }, ctx)
    const fourth = added.tabs.find((t) => t.url === 'https://four.example/')!
    const square = reduce(added, { type: 'split/create', tabId: fourth.id, withTabId: two.id }, ctx)
    expect(recentCards(square)[0]).toMatchObject({ members: [{ id: two.id }, { id: three.id }, { id: one.id }, { id: fourth.id }], grid: {} })
  })

  it('comes first when it is the one on screen, and cycling from it goes to the next recent tab, then back to the pair', () => {
    const { ctx, state, one, two, three } = threeTabs()
    ctx.now += 1000
    let next = reduce(state, { type: 'split/create', tabId: two.id, withTabId: three.id }, ctx)
    expect(recentCards(next).map((c) => c.members.length)).toEqual([2, 1])
    const ids = landings(next, 2)
    expect(ids[0]).toBe(one.id)
    expect([two.id, three.id]).toContain(ids[1])
    next = state
  })
})

describe('pictures', () => {
  it('are looked up for each member, null when there is none; only the first entries carry one', () => {
    const ctx = makeCtx()
    let state = createInitialState(ctx)
    for (let i = 0; i < CYCLE_PANEL.pictureLimit + 3; i++) {
      ctx.now += 10
      state = run(ctx, state, { type: 'tab/open', url: `https://t${i}.example/` })
    }
    const asked: string[] = []
    const cards = recentCards(state, { thumb: (id) => (asked.push(id), `data:image/jpeg;base64,${id}`) })
    expect(cards).toHaveLength(CYCLE_PANEL.pictureLimit + 3)
    expect(cards[0]!.members[0]!.thumb).toMatch(/^data:image\/jpeg/)
    expect(cards.slice(CYCLE_PANEL.pictureLimit).every((c) => c.members.every((m) => m.thumb === null))).toBe(true)
    expect(asked).toHaveLength(CYCLE_PANEL.pictureLimit)
    expect(recentCards(state)[0]!.members[0]!.thumb).toBeNull()
  })

  it('give the icon and the title when a tab has no picture: its own name wins over the page title', () => {
    const ctx = makeCtx()
    const state = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' })
    const named = reduce(reduce(state, { type: 'tab/rename', id: state.tabs[0]!.id, title: 'Mon onglet' }, ctx), { type: 'tab/icon', id: state.tabs[0]!.id, icon: '🚀' }, ctx)
    const member = recentCards(named)[0]!.members[0]!
    expect([member.title, member.icon, member.thumb]).toEqual(['Mon onglet', '🚀', null])
  })
})

describe('the panel', () => {
  it('is 632 wide for three entries: 8 of margin on each side, 200 per card and 8 between them; never narrower than 480', () => {
    expect(cyclePanelWidth(3, 1680)).toBe(632)
    expect(cyclePanelWidth(2, 1680)).toBe(CYCLE_PANEL.minWidth)
    expect(CYCLE_PANEL.head + CYCLE_PANEL.card.height + CYCLE_PANEL.padding * 2 + CYCLE_PANEL.foot).toBe(CYCLE_PANEL.height)
  })

  it('stays inside a narrow window: the cards then scroll', () => {
    expect(cyclePanelWidth(40, 900)).toBe(900 - CYCLE_PANEL.windowMargin * 2)
    expect(cyclePanelWidth(40, 100)).toBeGreaterThanOrEqual(CYCLE_PANEL.card.width + CYCLE_PANEL.padding * 2)
  })

  it('tells the site of each tab under its title, and nothing for an address that is not one', () => {
    const ctx = makeCtx()
    let state = createInitialState(ctx)
    state = run(ctx, state, { type: 'tab/open', url: 'https://www.exemple.fr:8443/page?x=1' }, { type: 'tab/open', url: 'about:blank', background: true })
    expect(recentCards(state).map((c) => c.members[0]!.host)).toEqual(['exemple.fr:8443', ''])
  })
})

describe('the keys the panel reports', () => {
  const good = { type: 'keyUp', code: 'ControlLeft', key: 'Control', meta: false, control: false, alt: false, shift: false, isAutoRepeat: false }

  it('are accepted when they are what the panel sends', () => {
    expect(parseCycleKey(good)).toEqual(good)
    expect(parseCycleKey({ ...good, type: 'keyDown', code: 'Tab', key: 'Tab', control: true })?.control).toBe(true)
  })

  it('are refused when they are anything else: wrong kind, long text, missing or non-boolean flags, not an object', () => {
    for (const bad of [null, undefined, 'keyUp', 42, [], { ...good, type: 'keyPress' }, { ...good, code: 'x'.repeat(33) }, { ...good, key: 7 }, { ...good, control: 'yes' }, { ...good, isAutoRepeat: undefined }, { type: 'keyUp' }]) {
      expect(parseCycleKey(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('carry only the known fields', () => {
    expect(Object.keys(parseCycleKey({ ...good, extra: 'x', __proto__: { polluted: true } })!).sort()).toEqual(['alt', 'code', 'control', 'isAutoRepeat', 'key', 'meta', 'shift', 'type'])
  })
})

describe('what a key does to ⌃Tab', () => {
  const press = (code: string, over: Partial<CycleKey> = {}): CycleKey => ({ type: 'keyDown', code, key: code, meta: false, control: false, alt: false, shift: false, isAutoRepeat: false, ...over })
  const tab = (over: Partial<CycleKey> = {}) => press('Tab', { control: true, ...over })
  const idle: CycleKeyContext = { enabled: true, holding: null, otherPanelOpen: false, forward: 'Ctrl+Tab', back: 'Ctrl+Shift+Tab' }
  const up: CycleKeyContext = { ...idle, holding: ['control'] }

  it('recognises a shortcut given to a letter by the letter typed: on a French keyboard the key marked A is not the key of Q', () => {
    const letters: CycleKeyContext = { ...idle, forward: 'Ctrl+A', back: 'Ctrl+Shift+A' }
    expect(decideCycleKey(letters, press('KeyQ', { key: 'a', control: true }))).toEqual({ kind: 'start', direction: 1, accelerator: 'Ctrl+A' })
    expect(decideCycleKey(letters, press('KeyQ', { key: 'A', control: true, shift: true }))).toEqual({ kind: 'start', direction: -1, accelerator: 'Ctrl+Shift+A' })
    expect(decideCycleKey(letters, press('KeyA', { key: 'q', control: true }))).toEqual({ kind: 'ignore' })
  })

  it('recognises a shortcut held with Option by the keyboard layout: ⌥A on a French keyboard gives « æ » at the place of Q', () => {
    const option: CycleKeyContext = { ...idle, forward: 'Alt+A', back: 'Alt+Shift+A', layout: keyLayoutOf({ KeyQ: 'a', KeyA: 'q' }) }
    expect(decideCycleKey(option, press('KeyQ', { key: 'æ', alt: true }))).toEqual({ kind: 'start', direction: 1, accelerator: 'Alt+A' })
    expect(decideCycleKey(option, press('KeyQ', { key: 'Æ', alt: true, shift: true }))).toEqual({ kind: 'start', direction: -1, accelerator: 'Alt+Shift+A' })
    // The key marked Q, at the place of A, is another shortcut.
    expect(decideCycleKey(option, press('KeyA', { key: '‡', alt: true }))).toEqual({ kind: 'ignore' })
    // The panel is up: the same press moves on, and the release of Option ends it.
    const held: CycleKeyContext = { ...option, holding: ['alt'] }
    expect(decideCycleKey(held, press('KeyQ', { key: 'æ', alt: true }))).toEqual({ kind: 'step', direction: 1 })
    expect(decideCycleKey(held, press('AltLeft', { key: 'Alt', type: 'keyUp' }))).toEqual({ kind: 'commit' })
  })

  it('opens the panel on ⌃Tab (forward) and ⌃⇧Tab (back), and on nothing else', () => {
    expect(decideCycleKey(idle, tab())).toEqual({ kind: 'start', direction: 1, accelerator: 'Ctrl+Tab' })
    expect(decideCycleKey(idle, tab({ shift: true }))).toEqual({ kind: 'start', direction: -1, accelerator: 'Ctrl+Shift+Tab' })
    for (const key of [press('Tab'), tab({ type: 'keyUp' }), tab({ alt: true }), press('KeyT', { control: true }), press('Control', { control: true })]) expect(decideCycleKey(idle, key), JSON.stringify(key)).toEqual({ kind: 'ignore' })
  })

  it('leaves every key alone with the setting off, and ⌃Tab to the panel that is open', () => {
    expect(decideCycleKey({ ...idle, enabled: false }, tab())).toEqual({ kind: 'ignore' })
    expect(decideCycleKey({ ...up, enabled: false }, tab())).toEqual({ kind: 'ignore' })
    expect(decideCycleKey({ ...idle, otherPanelOpen: true }, tab())).toEqual({ kind: 'ignore' })
  })

  it('follows the shortcut the user chose, and nothing when they turned it off', () => {
    const remapped = { ...idle, forward: 'Alt+Tab', back: undefined }
    expect(decideCycleKey(remapped, tab())).toEqual({ kind: 'ignore' })
    expect(decideCycleKey(remapped, press('Tab', { alt: true }))).toEqual({ kind: 'start', direction: 1, accelerator: 'Alt+Tab' })
    expect(decideCycleKey(remapped, press('Tab', { alt: true, shift: true }))).toEqual({ kind: 'ignore' })
  })

  it('moves the selection on Tab and ⇧Tab while ⌃ is held, auto-repeat included', () => {
    expect(decideCycleKey(up, tab())).toEqual({ kind: 'step', direction: 1 })
    expect(decideCycleKey(up, tab({ shift: true }))).toEqual({ kind: 'step', direction: -1 })
    expect(decideCycleKey(up, tab({ isAutoRepeat: true }))).toEqual({ kind: 'step', direction: 1 })
  })

  it('ends on the release of ⌃: the key of ⌃ going up, or any key that no longer has ⌃ down (the release may have been lost)', () => {
    expect(decideCycleKey(up, press('ControlLeft', { type: 'keyUp', key: 'Control', control: false }))).toEqual({ kind: 'commit' })
    expect(decideCycleKey(up, press('KeyA'))).toEqual({ kind: 'commit' })
    expect(decideCycleKey(up, tab({ control: false }))).toEqual({ kind: 'commit' })
  })

  it('waits for every modifier of a shortcut that holds two, and for the one that was chosen', () => {
    const both = { ...idle, holding: ['alt', 'meta'] as const }
    expect(decideCycleKey(both, press('Tab', { alt: true, meta: true }))).toEqual({ kind: 'ignore' })
    expect(decideCycleKey(both, press('Tab', { alt: true, meta: true, shift: true }))).toEqual({ kind: 'ignore' })
    expect(decideCycleKey(both, press('Tab', { alt: true }))).toEqual({ kind: 'commit' })
    expect(decideCycleKey({ ...idle, holding: ['alt'], forward: 'Alt+Tab' }, press('Tab', { alt: true }))).toEqual({ kind: 'step', direction: 1 })
    expect(decideCycleKey({ ...idle, holding: ['alt'], forward: 'Alt+Tab' }, press('Tab', { control: true }))).toEqual({ kind: 'commit' })
  })

  it('cancels on Escape, and spends the Tab that goes up', () => {
    expect(decideCycleKey(up, press('Escape', { control: true }))).toEqual({ kind: 'cancel' })
    expect(decideCycleKey(up, tab({ type: 'keyUp' }))).toEqual({ kind: 'swallow' })
    expect(decideCycleKey(up, press('KeyA', { type: 'keyUp', control: true }))).toEqual({ kind: 'ignore' })
    expect(decideCycleKey(up, press('KeyA', { control: true }))).toEqual({ kind: 'ignore' })
  })
})

describe('under a lock', () => {
  /** Two tabs in each of two spaces, with a picture for every tab. */
  function twoSpaces() {
    const { ctx, state } = threeTabs()
    const home = state.activeSpaceId
    const withWork = run(ctx, state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 20 }, { type: 'tab/open', url: 'https://secret.example/' }, { type: 'tab/open', url: 'https://secret-two.example/', background: true })
    return { state: withWork, home, work: withWork.activeSpaceId }
  }
  const thumb = (id: string): string => `data:image/jpeg;base64,${id}`

  it('offers the same entries as before when nothing is locked', () => {
    const { state } = twoSpaces()
    expect(visibleRecentCards(state, undefined).map((c) => c.id)).toEqual(recentCards(state).map((c) => c.id))
    expect(visibleRecentCards(state, { appLocked: false, lockedSpaces: [] }).length).toBe(2)
  })

  it('offers no entry for the space on screen when it is locked: no title, no icon, no picture is asked for (this fails if the panel is made from the whole state)', () => {
    const { state, work } = twoSpaces()
    const asked: string[] = []
    const cards = visibleRecentCards(state, { appLocked: false, lockedSpaces: [work] }, { thumb: (id) => (asked.push(id), thumb(id)) })
    expect(cards).toEqual([])
    expect(asked).toEqual([])
    expect(JSON.stringify(cards)).not.toContain('secret')
    // The whole state would have drawn them.
    expect(recentCards(state, { thumb }).map((c) => c.members[0]!.title)).toEqual(expect.arrayContaining(['secret.example']))
    expect(firstSelection(cards.length, 1)).toBeNull()
  })

  it('offers nothing while the application is locked, whichever space is on screen', () => {
    const { state, home } = twoSpaces()
    expect(visibleRecentCards(state, { appLocked: true, lockedSpaces: [] }, { thumb })).toEqual([])
    expect(visibleRecentCards({ ...state, activeSpaceId: home }, { appLocked: true, lockedSpaces: [] }, { thumb })).toEqual([])
  })

  it('goes on offering the tabs of the space on screen when it is another space that is locked', () => {
    const { state, home } = twoSpaces()
    const cards = visibleRecentCards({ ...state, activeSpaceId: home }, { appLocked: false, lockedSpaces: [state.activeSpaceId] }, { thumb })
    expect(cards).toHaveLength(3)
    expect(cards.every((c) => c.members.every((m) => m.thumb === thumb(m.id)))).toBe(true)
  })
})
