// The menus and the importers read the favourites of a profile, never the whole list. The rules are tested in src/shared/favorite-scope.test.ts; here
// are the real menu of a tab (Electron replaced by a stand-in, as context-menus.test.ts does) and the real import service, on a pretend home folder.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action, type Ctx } from '@shared/sidebar'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template }, nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, setTemplateImage: () => undefined }) } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { menuItems } = await import('./shell/context-menus')
const { ImportService } = await import('./importers/service')

let n = 0
const ctx: Ctx = { now: 1, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

describe('the menu of a tab', () => {
  type Item = Electron.MenuItemConstructorOptions
  const flat = (items: Item[]): Item[] => items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flat(item.submenu as Item[]) : [])])

  /** "Maison" on the default profile and "Travail" on the profile "work"; Courrier is a favourite of Travail only. */
  function twoProfiles(): { state: SidebarState; home: string; work: string } {
    let state = run(createInitialState(ctx), { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileId: 'work' })
    const home = state.spaces.find((s) => s.profileId === 'default')!.id
    const work = state.spaces.find((s) => s.profileId === 'work')!.id
    state = run(state, { type: 'space/select', id: home }, { type: 'favorite/add', url: 'https://courrier.example/', title: 'Courrier', spaceId: work })
    return { state, home, work }
  }

  /** The entry of the favourites in the menu of the tab of `spaceId` on Courrier, and what a click on it dispatches. */
  function favoriteEntry(state: SidebarState, spaceId: string): { label: unknown; dispatched: Action[] } {
    const opened = run(state, { type: 'tab/open', url: 'https://courrier.example/', spaceId })
    const tab = opened.tabs.find((t) => t.spaceId === spaceId && t.url === 'https://courrier.example/')!
    const dispatched: Action[] = []
    const base: Record<string, unknown> = { isPrivate: () => false, windowMoveChoices: () => [], dispatch: (action: Action) => void dispatched.push(action), snapshot: () => ({ runtime: { tabs: {} }, extensions: [], downloads: [] }), livePageIds: () => [], sleepStateOf: () => 'awake', isShown: () => false, isScrollSynced: () => false }
    const browser = new Proxy(base, { get: (t, p: string) => (p in t ? t[p] : () => undefined) }) as never
    const items = flat(menuItems({ kind: 'tab', id: tab.id }, browser, { get: () => opened } as never, {} as never, { clipboardText: '', headers: true }) as Item[])
    const entry = items.find((item) => item.label === t('sidebar.ajouter-aux-favoris') || item.label === t('sidebar.retirer-des-favoris'))
    expect(entry, 'the menu has the entry of the favourites').toBeDefined()
    ;(entry!.click as unknown as () => void)()
    return { label: entry!.label, dispatched }
  }

  it('asks whether a page is a favourite of the profile of its space, and adds it there', () => {
    const { state, home } = twoProfiles()
    // Courrier is a favourite of the other profile: in Maison it is not one, and the entry adds it to Maison's.
    expect(favoriteEntry(state, home)).toEqual({ label: t('sidebar.ajouter-aux-favoris'), dispatched: [expect.objectContaining({ type: 'favorite/add', url: 'https://courrier.example/', spaceId: home })] })
  })

  it('takes away the favourite of the profile of its space', () => {
    const { state, work } = twoProfiles()
    const id = state.favorites.find((f) => f.title === 'Courrier')!.id
    expect(favoriteEntry(state, work)).toEqual({ label: t('sidebar.retirer-des-favoris'), dispatched: [{ type: 'favorite/remove', id }] })
  })
})

describe('an import that brings favourites', () => {
  const root = mkdtempSync(join(tmpdir(), 'lucium-favorite-import-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'Library/Application Support/Arc/StorableSidebar.json')
  mkdirSync(dirname(file), { recursive: true })
  // The sidebar file interleaves ids and objects: one space, with one favourite.
  const item = (id: string, parentID: string | null, childrenIds: string[], data: object) => [id, { id, parentID, childrenIds, data, title: null, createdAt: 720_000_000 }]
  writeFileSync(
    file,
    JSON.stringify({
      sidebar: {
        containers: [
          { global: {} },
          {
            topAppsContainerIDs: [{ default: true }, 'top'],
            spaces: ['s1', { id: 's1', title: 'Arc', customInfo: { iconType: { emoji_v2: '💼' } }, containerIDs: ['pinned', 'pin', 'unpinned', 'today'] }],
            items: [
              ...item('top', null, ['fav'], { itemContainer: {} }),
              ...item('fav', 'top', [], { tab: { savedURL: 'https://favori.example/', savedTitle: 'Favori', timeLastActiveAt: 720_000_100 } }),
              ...item('pin', null, [], { itemContainer: {} }),
              ...item('today', null, [], { itemContainer: {} })
            ]
          }
        ]
      }
    })
  )

  it('counts what it brings by the same rule as the reducer: a favourite whose address the profile got in the meantime is not brought, so not taken back', async () => {
    let state = createInitialState(ctx)
    const service = () => new ImportService({ home: root, ctx: () => ctx, dispatch: (action) => void (state = reduce(state, action, ctx)), state: () => state, mergeHistory: () => 0, chooseFile: async () => null })
    expect(await service().run({ source: 'arc', categories: ['sidebar'] })).toMatchObject({ ok: true, favorites: 1 })
    // The user takes the imported favourite away: imported again, it would be new.
    const arcs = state.favorites.find((f) => f.url === 'https://favori.example/')!
    state = run(state, { type: 'favorite/remove', id: arcs.id })
    const again = service()
    const preview = await again.preview({ source: 'arc', categories: ['sidebar'] })
    expect(preview).toMatchObject({ ok: true, favorites: 1 })
    // Before the import is confirmed, the user adds the same address as a favourite of their own, in the same profile: the reducer does not add the imported one.
    state = run(state, { type: 'favorite/add', url: 'https://favori.example/', title: 'Le mien', spaceId: state.spaces.find((s) => s.profileId === arcs.profileId)!.id })
    const mine = state.favorites.map((f) => f.id)
    const done = again.commit(preview.token!)
    expect(done).toMatchObject({ ok: true, favorites: 0 })
    expect(done.undoToken).toBeUndefined()
    expect(state.favorites.map((f) => f.id)).toEqual(mine)
  })
})
