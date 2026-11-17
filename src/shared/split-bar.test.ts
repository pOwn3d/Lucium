import { describe, expect, it } from 'vitest'
import type { SidebarState } from './model'
import { activeTab, createInitialState, reduce, type Action, type Ctx } from './sidebar'
import { SPLIT_PRESETS, paneClosedUndo, presetLabel, splitBarAction, splitBarItems } from './split-bar'
import { frenchSpaces } from './french-typography'

function makeCtx(): Ctx {
  let n = 0
  return { now: 1_000_000, newId: () => `id${++n}` }
}

const run = (ctx: Ctx, state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** Four tabs of one space, a and b side by side. */
function setup(count = 4) {
  const ctx = makeCtx()
  const urls = ['https://a.fr/', 'https://b.fr/', 'https://c.fr/', 'https://d.fr/'].slice(0, count)
  let s = run(ctx, createInitialState(ctx), ...urls.map((url): Action => ({ type: 'tab/open', url })))
  const ids = s.tabs.map((t) => t.id)
  s = run(ctx, s, { type: 'split/create', tabId: ids[0]!, withTabId: ids[1]! })
  return { ctx, s, ids: ids as [string, string, string, string] }
}

describe('splitBarItems', () => {
  it('offers the three ratios and the swap, and "Défilement synchronisé" only while the setting that offers it is on', () => {
    const { s } = setup()
    const split = s.splits[0]!
    expect(splitBarItems(split, { scrollSync: false, synced: false }).map((item) => item.kind)).toEqual(['ratio', 'ratio', 'ratio', 'swap'])
    expect(splitBarItems(split, { scrollSync: true, synced: false }).map((item) => item.kind)).toEqual(['ratio', 'ratio', 'ratio', 'swap', 'sync'])
    expect(SPLIT_PRESETS).toEqual([0.3, 0.5, 0.7])
  })

  it('shows the button of the ratio the panes have (50 / 50 at first), and none when they are somewhere else', () => {
    const { ctx, s } = setup()
    const pressed = (state: SidebarState) => splitBarItems(state.splits[0]!, { scrollSync: false, synced: false }).filter((item) => item.kind === 'ratio' && item.pressed).map((item) => (item.kind === 'ratio' ? item.first : null))
    expect(pressed(s)).toEqual([0.5])
    expect(pressed(run(ctx, s, { type: 'split/ratios', id: s.splits[0]!.id, ratios: [0.7, 0.3] }))).toEqual([0.7])
    // A drag stops anywhere: within half a percent of a ratio is still that ratio, further is none.
    expect(pressed(run(ctx, s, { type: 'split/ratios', id: s.splits[0]!.id, ratios: [0.302, 0.698] }))).toEqual([0.3])
    expect(pressed(run(ctx, s, { type: 'split/ratios', id: s.splits[0]!.id, ratios: [0.4, 0.6] }))).toEqual([])
    // Four percent off a ratio is not that ratio: the button does not claim it.
    expect(pressed(run(ctx, s, { type: 'split/ratios', id: s.splits[0]!.id, ratios: [0.34, 0.66] }))).toEqual([])
  })

  it('shows "Défilement synchronisé" pressed while the panes scroll together', () => {
    const { s } = setup()
    const sync = (synced: boolean) => splitBarItems(s.splits[0]!, { scrollSync: true, synced }).find((item) => item.kind === 'sync')
    expect(sync(true)).toEqual({ kind: 'sync', pressed: true })
    expect(sync(false)).toEqual({ kind: 'sync', pressed: false })
  })

  it('has no bar for a split view of more than two panes', () => {
    const { ctx, s, ids } = setup()
    const three = run(ctx, s, { type: 'split/create', tabId: ids[0], withTabId: ids[2] })
    expect(three.splits[0]!.tabIds).toHaveLength(3)
    expect(splitBarItems(three.splits[0]!, { scrollSync: true, synced: true })).toEqual([])
    expect(splitBarAction(three.splits[0]!, { kind: 'swap' })).toBeNull()
  })
})

describe('what the buttons do', () => {
  it('30 / 70, 50 / 50 and 70 / 30 give the first pane that share and the second the rest', () => {
    const { ctx, s } = setup()
    const split = s.splits[0]!
    for (const share of SPLIT_PRESETS) {
      const next = run(ctx, s, splitBarAction(split, { kind: 'ratio', first: share, pressed: false })!)
      expect(next.splits[0]!.ratios[0]).toBeCloseTo(share)
      expect(next.splits[0]!.ratios[0]! + next.splits[0]!.ratios[1]!).toBeCloseTo(1)
    }
  })

  it('"Échanger" trades the places of the two pages, each page keeping its size, and the focus stays on the page it was on', () => {
    const { ctx, s, ids } = setup()
    const sized = run(ctx, s, { type: 'split/ratios', id: s.splits[0]!.id, ratios: [0.3, 0.7] })
    const split = sized.splits[0]!
    const swapped = run(ctx, sized, splitBarAction(split, { kind: 'swap' })!)
    expect(swapped.splits[0]!.tabIds).toEqual([ids[1], ids[0]])
    expect(swapped.splits[0]!.ratios).toEqual([0.7, 0.3])
    expect(activeTab(swapped)?.id).toBe(activeTab(sized)?.id)
    // Swapping again is the way back.
    expect(run(ctx, swapped, splitBarAction(swapped.splits[0]!, { kind: 'swap' })!).splits[0]).toEqual(split)
  })

  it('"Défilement synchronisé" is not a change of the sidebar: the shell keeps it', () => {
    const { s } = setup()
    expect(splitBarAction(s.splits[0]!, { kind: 'sync', pressed: false })).toBeNull()
  })

  it('labels the ratio buttons "30 / 70"', () => {
    expect(presetLabel(0.3)).toBe('30 / 70')
    expect(presetLabel(0.5)).toBe('50 / 50')
    expect(presetLabel(0.7)).toBe('70 / 30')
  })
})

describe('the ratios belong to their split view', () => {
  it('keeps each split view\'s own shares: changing one leaves the other, and they survive the focus going elsewhere', () => {
    const { ctx, s, ids } = setup()
    const both = run(ctx, s, { type: 'split/create', tabId: ids[2], withTabId: ids[3] })
    const [first, second] = both.splits
    expect(both.splits).toHaveLength(2)
    const changed = run(ctx, both, { type: 'split/ratios', id: first!.id, ratios: [0.3, 0.7] }, { type: 'tab/select', id: ids[2] }, { type: 'split/ratios', id: second!.id, ratios: [0.7, 0.3] }, { type: 'tab/select', id: ids[0] })
    expect(changed.splits.find((sp) => sp.id === first!.id)!.ratios).toEqual([0.3, 0.7])
    expect(changed.splits.find((sp) => sp.id === second!.id)!.ratios).toEqual([0.7, 0.3])
  })
})

describe('paneClosedUndo: "Volet fermé" and its "Annuler"', () => {
  it('names the pane that left, and the action that puts the split view back as it was', () => {
    const { ctx, s, ids } = setup()
    const sized = run(ctx, s, { type: 'split/ratios', id: s.splits[0]!.id, ratios: [0.3, 0.7] })
    const action: Action = { type: 'split/remove', tabId: ids[1] }
    const after = run(ctx, sized, action)
    expect(after.splits).toHaveLength(0)
    const undo = paneClosedUndo(sized, after, action)!
    expect(undo.notice).toBe(frenchSpaces('Volet « b.fr » fermé'))
    expect(run(ctx, after, undo.undo).splits).toEqual(sized.splits)
  })

  it('puts back a split view of three whole, with the order and the shares it had', () => {
    const { ctx, s, ids } = setup()
    const three = run(ctx, s, { type: 'split/create', tabId: ids[0], withTabId: ids[2] }, { type: 'split/ratios', id: s.splits[0]!.id, ratios: [0.2, 0.3, 0.5] })
    const action: Action = { type: 'split/remove', tabId: ids[1] }
    const after = run(ctx, three, action)
    expect(after.splits[0]!.tabIds).toEqual([ids[0], ids[2]])
    const undo = paneClosedUndo(three, after, action)!
    expect(run(ctx, after, undo.undo).splits).toEqual(three.splits)
  })

  it('says nothing for what is not the closing of a pane, or changed nothing', () => {
    const { ctx, s, ids } = setup()
    const move: Action = { type: 'split/move', tabId: ids[0], direction: 1 }
    expect(paneClosedUndo(s, run(ctx, s, move), move)).toBeNull()
    // A tab that is in no split view: nothing to put back.
    const outside: Action = { type: 'split/remove', tabId: ids[3] }
    expect(paneClosedUndo(s, run(ctx, s, outside), outside)).toBeNull()
    const unknown: Action = { type: 'split/remove', tabId: 'nope' }
    expect(paneClosedUndo(s, run(ctx, s, unknown), unknown)).toBeNull()
    // The action did not go through (a lock refused it, the window is private and refused it): the pane is still where it was, and no notice says it closed.
    const refused: Action = { type: 'split/remove', tabId: ids[1] }
    expect(paneClosedUndo(s, s, refused)).toBeNull()
  })

  it('cuts a long title, so that the notice fits in the sidebar', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' })
    s = run(ctx, s, { type: 'tab/rename', id: s.tabs[1]!.id, title: 'Un titre très long qui ne tiendrait jamais dans la barre latérale' }, { type: 'split/create', tabId: s.tabs[0]!.id, withTabId: s.tabs[1]!.id })
    const action: Action = { type: 'split/remove', tabId: s.tabs[1]!.id }
    const notice = paneClosedUndo(s, run(ctx, s, action), action)!.notice
    expect(notice).toBe(frenchSpaces('Volet « Un titre très long qui ne tiend… » fermé'))
    expect(notice.match(/«\u00a0(.*)\u00a0»/)![1]!.length).toBe(32)
  })
})

describe('split/restore refuses what is no longer true', () => {
  const closed = () => {
    const { ctx, s, ids } = setup()
    const action: Action = { type: 'split/remove', tabId: ids[1] }
    const after = run(ctx, s, action)
    return { ctx, s, ids, after, undo: paneClosedUndo(s, after, action)!.undo }
  }

  it('does nothing when a pane was closed in the meantime', () => {
    const { ctx, ids, after, undo } = closed()
    const gone = run(ctx, after, { type: 'tab/close', id: ids[1] })
    expect(run(ctx, gone, undo)).toBe(gone)
  })

  it('does nothing when a pane went to another space', () => {
    const { ctx, ids, after, undo } = closed()
    const other = run(ctx, after, { type: 'space/create', name: 'B', emoji: 'b', hue: 1 })
    const moved = run(ctx, other, { type: 'tab/move-to-space', id: ids[1], spaceId: other.activeSpaceId })
    expect(run(ctx, moved, undo)).toBe(moved)
  })

  it('does nothing when a pane is in another split view now', () => {
    const { ctx, ids, after, undo } = closed()
    const joined = run(ctx, after, { type: 'split/create', tabId: ids[1], withTabId: ids[2] })
    expect(joined.splits).toHaveLength(1)
    expect(run(ctx, joined, undo)).toBe(joined)
  })

  it('does nothing for a shape that is not a split view: one pane, panes that are not tabs, no id', () => {
    const { ctx, after, ids } = closed()
    const spaceId = after.tabs[0]!.spaceId
    const make = (patch: object) => ({ type: 'split/restore', split: { id: 'x', spaceId, tabIds: [ids[0], ids[1]], orientation: 'horizontal', ratios: [0.5, 0.5], ...patch } }) as unknown as Action
    expect(run(ctx, after, make({ tabIds: [ids[0]] }))).toBe(after)
    expect(run(ctx, after, make({ tabIds: ['nope', 'nada'] }))).toBe(after)
    expect(run(ctx, after, make({ id: 5 }))).toBe(after)
    expect(run(ctx, after, { type: 'split/restore', split: null } as unknown as Action)).toBe(after)
  })

  it('puts nothing back when only some of the panes can come back: a split view of three is all or nothing', () => {
    const { ctx, s, ids } = setup()
    const three = run(ctx, s, { type: 'split/create', tabId: ids[0], withTabId: ids[2] })
    const [a, b, c] = three.splits[0]!.tabIds as [string, string, string]
    const action: Action = { type: 'split/remove', tabId: b }
    const left = run(ctx, three, action)
    const undo = paneClosedUndo(three, left, action)!.undo
    // One of the panes joined another split view in the meantime: the two others are not left as a split view of two.
    const joined = run(ctx, left, { type: 'split/create', tabId: b, withTabId: ids[3] })
    expect(joined.splits).toHaveLength(2)
    expect(run(ctx, joined, undo)).toBe(joined)
    // One of the panes went to another space: same.
    const elsewhere = run(ctx, left, { type: 'space/create', name: 'B', emoji: 'b', hue: 1 })
    const moved = run(ctx, elsewhere, { type: 'tab/move-to-space', id: c, spaceId: elsewhere.activeSpaceId })
    expect(moved.splits.some((sp) => sp.tabIds.includes(a))).toBe(false)
    expect(run(ctx, moved, undo)).toBe(moved)
  })

  it('does nothing when what is left of that split view holds a pane the saved one does not have', () => {
    const { ctx, s, ids } = setup()
    const three = run(ctx, s, { type: 'split/create', tabId: ids[0], withTabId: ids[2] })
    const [a, b, c] = three.splits[0]!.tabIds
    const left = run(ctx, three, { type: 'split/remove', tabId: b! })
    expect(left.splits[0]!.tabIds).toEqual([a, c])
    // The same split view (same id), saved with other panes: it may not stand on a split view that has a pane of its own.
    const forged = { type: 'split/restore', split: { ...three.splits[0]!, tabIds: [a!, b!] } } as Action
    expect(run(ctx, left, forged)).toBe(left)
  })

  it('cleans the shares like a saved state does: a crushed pane is shared equally', () => {
    const { ctx, after, ids } = closed()
    const spaceId = after.tabs[0]!.spaceId
    const next = run(ctx, after, { type: 'split/restore', split: { id: 'x', spaceId, tabIds: [ids[0], ids[1]], orientation: 'horizontal', ratios: [0.01, 0.99] } })
    expect(next.splits[0]!.ratios).toEqual([0.5, 0.5])
  })
})
