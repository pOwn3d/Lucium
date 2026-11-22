import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import type { SidebarState } from './model'
import { cleanAside } from './sessions'
import { createInitialState, reduce, type Action, type Ctx } from './sidebar'
import { MAIN_ONLY_ACTIONS } from './ipc-policy'
import { SPACE_TRANSFER_FORMAT, parseSpaceTransfer, spaceTransferOf, spaceTransferRefusal } from './space-transfer'

setLanguage('en')

function makeCtx(prefix = 'a'): Ctx {
  let n = 0
  return { now: 1_700_000_000_000, newId: () => `${prefix}${++n}` }
}
const run = (ctx: Ctx, state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** Two spaces; "Travail" has a folder with a pinned tab, two Today tabs (one with a picture and a container), a favourite page, an archived page. */
function world() {
  const ctx = makeCtx()
  let s = createInitialState(ctx)
  const home = s.activeSpaceId
  s = run(ctx, s, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileName: 'Clients' })
  const work = s.activeSpaceId
  s = run(ctx, s, { type: 'tab/open', url: 'https://one.example/', spaceId: work, background: true }, { type: 'tab/open', url: 'https://two.example/', spaceId: work, background: true }, { type: 'tab/open', url: 'https://home.example/', spaceId: home, background: true })
  const [one, two, other] = s.tabs.filter((t) => t.url.includes('.example'))
  s = run(ctx, s, { type: 'folder/create', name: 'Dossier', spaceId: work })
  const folder = s.folders.find((f) => f.spaceId === work)!
  s = run(ctx, s, { type: 'tab/move', id: one!.id, toIndex: 0, pinned: true, folderId: folder.id })
  s = {
    ...s,
    spaces: s.spaces.map((sp) => (sp.id === work ? { ...sp, image: 'photo.png', iconKind: 'image', background: { type: 'image', value: 'fond.png' } } : sp)),
    tabs: s.tabs.map((t) => (t.id === two!.id ? { ...t, image: 'tab.png', container: 'c1', openerId: one!.id, customTitle: 'Deux' } : t)),
    archive: [...s.archive, { id: 'ar1', spaceId: work, url: 'https://old.example/', title: 'Old', archivedAt: 5, container: 'c1' }]
  }
  return { ctx, s, home, work, one: one!, two: two!, other: other!, folder }
}

describe('space transfer', () => {
  it('holds the space, its folders, tabs and archive, and nothing of the other spaces', () => {
    const { s, work, one, two, folder, other } = world()
    const transfer = spaceTransferOf(s, work)!
    expect(transfer.format).toBe(SPACE_TRANSFER_FORMAT)
    expect(transfer.aside.space.name).toBe('Travail')
    expect(transfer.aside.tabs.map((t) => t.id).sort()).toEqual([one.id, two.id].sort())
    expect(transfer.aside.tabs.some((t) => t.id === other.id)).toBe(false)
    expect(transfer.aside.folders.map((f) => f.id)).toEqual([folder.id])
    expect(transfer.aside.archive.map((a) => a.url)).toEqual(['https://old.example/'])
    expect(transfer.aside.tabs.find((t) => t.id === two.id)!.customTitle).toBe('Deux')
  })

  it('leaves out what only means something on this Mac: pictures of the data folder, profile, container, opener', () => {
    const { s, work, two } = world()
    const { aside } = spaceTransferOf(s, work)!
    expect(aside.space.image).toBeUndefined()
    expect(aside.space.background).toBeUndefined()
    expect(aside.space.iconKind).toBeUndefined()
    expect(aside.space.profileId).toBe('default')
    const tab = aside.tabs.find((t) => t.id === two.id)!
    expect(tab.image).toBeUndefined()
    expect(tab.container).toBeUndefined()
    expect(tab.openerId).toBeUndefined()
    expect(aside.archive[0]!.container).toBeUndefined()
  })

  it('keeps a colour background, which is a value and not a file', () => {
    const { s, work } = world()
    const colored = { ...s, spaces: s.spaces.map((sp) => (sp.id === work ? { ...sp, background: { type: 'color' as const, value: '#112233' } } : sp)) }
    expect(spaceTransferOf(colored, work)!.aside.space.background).toEqual({ type: 'color', value: '#112233' })
  })

  it('carries no cookie, password or secret: the file holds only the space, whatever the state holds', () => {
    const { s, work } = world()
    const rich = { ...s, settings: { ...s.settings, profileNames: { x: 'secret-profile' } }, sitePermissions: { 'https://x.example': { camera: 'allow' as const } } }
    const text = JSON.stringify(spaceTransferOf(rich, work))
    expect(text).not.toMatch(/secret-profile|sitePermissions|cookie|password/i)
  })

  it('does not take the page that stands for a favourite along: its tile does not travel', () => {
    const { s, work, two } = world()
    const withFavourite = { ...s, tabs: s.tabs.map((t) => (t.id === two.id ? { ...t, favoriteId: 'fav1' } : t)) }
    expect(spaceTransferOf(withFavourite, work)!.aside.tabs.some((t) => t.id === two.id)).toBe(false)
  })

  it('refuses a locked space, an unknown one, and one with too many tabs', () => {
    const { s, work } = world()
    expect(spaceTransferRefusal(s, work, [])).toBeNull()
    expect(spaceTransferRefusal(s, work, [work])).toMatch(/unlock/i)
    expect(spaceTransferRefusal(s, 'nope', [])).not.toBeNull()
    const many = { ...s, tabs: Array.from({ length: 1001 }, (_, i) => ({ ...s.tabs[0]!, id: `m${i}`, spaceId: work })) }
    expect(spaceTransferRefusal(many, work, [])).not.toBeNull()
  })

  it('is imported on another profile of the app: space, folder and tabs back, in a new space on screen, ids made anew where taken', () => {
    const { s, work, one, two } = world()
    const file = JSON.parse(JSON.stringify(spaceTransferOf(s, work)))
    const parsed = parseSpaceTransfer(file)
    if (!parsed.ok) throw new Error(parsed.message)
    // Another Mac: a fresh state; then the same Mac: the ids exist already.
    const other = createInitialState(makeCtx('z'))
    const back = reduce(other, { type: 'space/import', aside: parsed.aside }, makeCtx('y'))
    expect(back.spaces).toHaveLength(2)
    const imported = back.spaces.at(-1)!
    expect(imported.name).toBe('Travail')
    expect(back.activeSpaceId).toBe(imported.id)
    const tabs = back.tabs.filter((t) => t.spaceId === imported.id)
    expect(tabs.map((t) => t.url).sort()).toEqual(['https://one.example/', 'https://two.example/'])
    expect(tabs.map((t) => t.id).sort()).toEqual([one.id, two.id].sort())
    const filed = tabs.find((t) => t.url === 'https://one.example/')!
    expect(back.folders.find((f) => f.id === filed.folderId)?.name).toBe('Dossier')

    const twice = reduce(s, { type: 'space/import', aside: parsed.aside }, makeCtx('q'))
    expect(twice.spaces).toHaveLength(3)
    const ids = [...twice.tabs.map((t) => t.id), ...twice.folders.map((f) => f.id), ...twice.spaces.map((sp) => sp.id)]
    expect(new Set(ids).size).toBe(ids.length)
    // The original is untouched.
    expect(twice.tabs.filter((t) => t.spaceId === work)).toHaveLength(2)
  })

  it('is main-process only: the interface cannot add a space with an action', () => {
    expect(MAIN_ONLY_ACTIONS.has('space/import')).toBe(true)
  })

  it('refuses what is not a space file: a full export, any JSON, a newer version, an unreadable space', () => {
    const { s, work } = world()
    expect(parseSpaceTransfer(s).ok).toBe(false)
    expect(parseSpaceTransfer(null).ok).toBe(false)
    expect(parseSpaceTransfer([]).ok).toBe(false)
    const file = JSON.parse(JSON.stringify(spaceTransferOf(s, work)))
    expect(parseSpaceTransfer({ ...file, version: 99 })).toMatchObject({ ok: false, message: expect.stringMatching(/newer/) })
    expect(parseSpaceTransfer({ ...file, aside: { space: 3 } })).toMatchObject({ ok: false })
  })

  it('repairs a file like any state file: a hostile tab list is cleaned, not trusted', () => {
    const { s, work } = world()
    const file = JSON.parse(JSON.stringify(spaceTransferOf(s, work)))
    file.aside.tabs.push({ id: 5, url: 42 }, null)
    file.aside.space.image = '../../etc/passwd'
    file.aside.space.profileId = 'someone-else'
    const parsed = parseSpaceTransfer(file)
    if (!parsed.ok) throw new Error(parsed.message)
    expect(parsed.aside.tabs).toHaveLength(2)
    expect(parsed.aside.space.image).toBeUndefined()
    expect(parsed.aside.space.profileId).toBe('default')
    expect(cleanAside(parsed.aside)).toBeDefined()
  })
})
