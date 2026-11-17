// The guards of the sidebar reducer: an archive restore that touches only its own tab, the default
// site searches that stay as the person left them, a copy that keeps the cloud AI consent, the groups of tabs that go to the archive, the
// malformed payloads that are refused without a throw, and a pinned tab whose anchor address stays.

import { describe, expect, it } from 'vitest'
import type { SidebarState, TabItem } from './model'
import { copyDataOf } from './session-backups'
import { createInitialState, reduce, type Action, type Ctx } from './sidebar'

function makeCtx(now = 1_000_000): Ctx {
  let n = 0
  return { now, newId: () => `id${++n}` }
}

function run(ctx: Ctx, state: SidebarState, ...actions: Action[]): SidebarState {
  return actions.reduce((s, a) => reduce(s, a, ctx), state)
}

const EXTENSION_PAGE = `chrome-extension://${'a'.repeat(32)}/options.html`

describe('archive restore', () => {
  it('restores an extension page without renaming, pinning or moving another tab, and drops its entry', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    // The page of an extension is open next to a web tab; it is pinned, then closed (archived with its pin).
    const withTabs = run(ctx, base, { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: EXTENSION_PAGE, allowExtensionPages: true })
    const extension = withTabs.tabs.find((t) => t.url === EXTENSION_PAGE)!
    const archived = run(ctx, withTabs, { type: 'tab/pin', id: extension.id }, { type: 'tab/remove-pinned', id: extension.id })
    expect(archived.archive).toHaveLength(1)

    const restored = run(ctx, archived, { type: 'archive/restore-last' })
    const web = restored.tabs.find((t) => t.url === 'https://a.fr/')!
    expect(web.title).toBe('a.fr')
    expect(web.pinned).toBe(false)
    expect(web.anchorUrl).toBeUndefined()
    expect(restored.tabs.some((t) => t.url === EXTENSION_PAGE)).toBe(false)
    expect(restored.archive).toHaveLength(0)
  })

  it('keeps the entry in the archive when no tab comes of it', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const refused: SidebarState = {
      ...base,
      archive: [{ id: 'old', spaceId: base.activeSpaceId, url: 'javascript:alert(1)', title: 'x', archivedAt: 0 }]
    }
    const after = run(ctx, refused, { type: 'archive/restore-last' })
    expect(after.tabs).toHaveLength(0)
    expect(after.archive.map((a) => a.id)).toEqual(['old'])
  })
})

describe('site searches', () => {
  it('keeps the order that was sent, custom searches included', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const [first, ...rest] = base.settings.siteSearches
    const custom = { keyword: 'mine', name: 'Mine', url: 'https://mine.example/?q=%s' }
    const sent = [first!, custom, ...rest]
    const kept = run(ctx, base, { type: 'settings/update', patch: { siteSearches: sent } })
    expect(kept.settings.siteSearches.map((s) => s.keyword)).toEqual(sent.map((s) => s.keyword))
  })
})

describe('backup restore', () => {
  // A copy holds no settings: the ones of this installation stay as they are.
  it('leaves the settings of the summary as they are', () => {
    const ctx = makeCtx()
    const base = createInitialState(ctx)
    const on = run(ctx, base, { type: 'settings/update', patch: { aiSummary: true, ollamaConfig: { ...base.settings.ollamaConfig, enabled: true } } })
    const restored = run(ctx, on, { type: 'backup/restore', copy: copyDataOf(on) })
    expect(restored.settings.aiSummary).toBe(true)
    expect(restored.settings.ollamaConfig).toEqual(on.settings.ollamaConfig)
  })
})

describe('closing the other tabs of a space', () => {
  it('archives the tabs it closes, and they come back with one undo', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' }, { type: 'tab/open', url: 'https://c.fr/' })
    const keep = s.tabs[1]!
    s = run(ctx, s, { type: 'tab/close-others', id: keep.id })
    expect(s.tabs.map((t) => t.id)).toEqual([keep.id])
    expect(s.archive.map((a) => a.url).sort()).toEqual(['https://a.fr/', 'https://c.fr/'])
    expect(s.archive.every((a) => a.source === 'manual')).toBe(true)

    const back = run(ctx, s, { type: 'archive/restore-last', count: 2 })
    expect(back.tabs.map((t) => t.url).sort()).toEqual(['https://a.fr/', 'https://b.fr/', 'https://c.fr/'])
    expect(back.archive).toHaveLength(0)
  })
})

describe('malformed payloads', () => {
  const base = () => {
    const ctx = makeCtx()
    const state = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
    return { ctx, state }
  }

  it('refuses a favourite edit without a patch, on a favourite that exists', () => {
    const ctx = makeCtx()
    const state = run(ctx, createInitialState(ctx), { type: 'favorite/add', url: 'https://a.fr/', title: 'A' })
    const id = state.favorites[0]!.id
    const edit = { type: 'favorite/edit', id, patch: undefined as unknown as { title?: string } } as Action
    expect(() => reduce(state, edit, ctx)).not.toThrow()
    expect(reduce(state, edit, ctx)).toBe(state)
  })

  const malformed: Array<[string, Action]> = [
    ['tab/open without an address', { type: 'tab/open', url: undefined as unknown as string }],
    ['tab/icon without an icon', { type: 'tab/icon', id: 'nope', icon: undefined as unknown as string }],
    ['tabs/archive-many with ids that are not a list', { type: 'tabs/archive-many', ids: 42 as unknown as string[] }],
    ['folder/create-with with tab ids that are not a list', { type: 'folder/create-with', tabIds: 42 as unknown as string[] }]
  ]

  for (const [name, action] of malformed) {
    it(`refuses ${name} without a throw`, () => {
      const { ctx, state } = base()
      expect(() => reduce(state, action, ctx)).not.toThrow()
      expect(reduce(state, action, ctx)).toBe(state)
    })
  }
})

describe('space order', () => {
  it('refuses a move to an index that is not a number', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'space/create', name: 'Deux', emoji: '🧪', hue: 10 })
    const ids = s.spaces.map((sp) => sp.id)
    const last = ids[ids.length - 1]!
    for (const toIndex of [NaN, undefined as unknown as number]) {
      const after = reduce(s, { type: 'space/move', id: last, toIndex }, ctx)
      expect(after.spaces.map((sp) => sp.id)).toEqual(ids)
    }
    s = reduce(s, { type: 'space/move', id: last, toIndex: 0 }, ctx)
    expect(s.spaces[0]!.id).toBe(last)
  })
})

describe('pinned tab', () => {
  it('keeps its anchor address when it is pinned again', () => {
    const ctx = makeCtx()
    let s = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
    const id = s.tabs[0]!.id
    s = run(ctx, s, { type: 'tab/pin', id }, { type: 'tab/update', id, patch: { url: 'https://a.fr/deep' } }, { type: 'tab/pin', id })
    const tab = s.tabs.find((t: TabItem) => t.id === id)!
    expect(tab.pinned).toBe(true)
    expect(tab.anchorUrl).toBe('https://a.fr/')
  })
})
