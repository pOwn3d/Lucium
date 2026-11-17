// "Ranger les onglets…" and the folders under the Today tabs, rendered to markup with the real components (no window, as space-panels.test.ts does): the button of the
// Today header, the panel with the proposal, and the sidebar with a folder under the tabs. What each part promises is measured here.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { showsFolderBottomZone, type DragSource } from '@shared/dnd'
import type { UiSnapshot } from '@shared/ipc'
import type { SpaceBackgroundMediaReply } from '@shared/space-background-media'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({
  api: () => ({
    // The reply the main process gives now: the bytes of the file and its type (the sidebar makes a blob URL of them), no data URL.
    spaceBackgroundMedia: async (): Promise<SpaceBackgroundMediaReply> => ({ ok: true, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' })
  }),
  useSnapshot: () => holder.snapshot
}))

import { Sidebar } from './Sidebar'
import { TidyPanel } from './TidyPanel'
import { frenchSpaces } from '@shared/french-typography'

let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** Today: three tabs of github.com, two of google.com, one alone. */
function fixture(): SidebarState {
  return run(createInitialState(ctx), ...['https://github.com/a', 'https://github.com/b', 'https://github.com/c', 'https://google.com/1', 'https://google.com/2', 'https://lone.example/'].map((url): Action => ({ type: 'tab/open', url, background: true })))
}

const panel = (state: SidebarState, initial?: Parameters<typeof TidyPanel>[0]['initial']): string => {
  holder.snapshot = { state }
  return renderToStaticMarkup(createElement(TidyPanel, { spaceId: state.activeSpaceId, ...(initial ? { initial } : {}) }))
}

function snapshotOf(state: SidebarState, extra: Partial<UiSnapshot> = {}): UiSnapshot {
  return { state, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, engine: {}, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null, platform: 'darwin', ...extra } as unknown as UiSnapshot
}
const sidebar = (state: SidebarState, extra: Partial<UiSnapshot> = {}): string => renderToStaticMarkup(createElement(Sidebar, { snapshot: snapshotOf(state, extra), space: state.spaces.find((sp) => sp.id === state.activeSpaceId)! }))

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), innerWidth: 1200, lucium: {} })
  vi.stubGlobal('location', { hash: '' })
  setLanguage('fr')
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

/** Every button has a name (its text, or an aria-label) and every field a label. */
function unnamed(markup: string): string[] {
  const buttons = [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(([, attrs, inner]) => !/aria-label="[^"]+"/.test(attrs!) && inner!.replace(/<[^>]*>/g, '').trim() === '').map(([whole]) => whole.slice(0, 80))
  const inputs = [...markup.matchAll(/<input\b([^>]*)\/?>/g)].filter(([, attrs]) => !/aria-label="[^"]+"/.test(attrs!) && !/type="(?:checkbox|radio)"/.test(attrs!)).map(([whole]) => whole.slice(0, 80))
  return [...buttons, ...inputs]
}

describe('the panel "Ranger les onglets"', () => {
  it('draws nothing until the first snapshot has come', () => {
    holder.snapshot = null
    expect(renderToStaticMarkup(createElement(TidyPanel, { spaceId: 'x' }))).toBe('')
  })

  it('keeps the footer space buttons without background media while the main sidebar still uses it', () => {
    const base = fixture()
    const state = run(base, { type: 'space/update', id: base.activeSpaceId, patch: { background: { type: 'image', value: 'demo.png' } } })
    const markup = sidebar(state)
    // The class may carry the text tone after it (text-auto): what matters is the background image of the sidebar.
    expect(markup).toMatch(/class="sidebar-background image[ "]/)
    expect(markup).not.toContain('class="space-background image"')
  })

  it('is a dialog with one block per folder proposed: its name in a field, its count, its tabs with a tick box each', () => {
    const markup = panel(fixture())
    expect(markup).toMatch(/role="dialog"[^>]*aria-modal="true"/)
    expect(markup).toContain('>Ranger les onglets</h2>')
    expect(markup).toContain(frenchSpaces('Rien ne bouge avant « Ranger ».'))
    expect([...markup.matchAll(/class="tk-field tp-name"/g)]).toHaveLength(2)
    expect(markup).toContain('value="GitHub"')
    expect(markup).toContain('value="Google"')
    expect(markup).toContain('>3 onglets<')
    expect(markup).toContain('>2 onglets<')
    // Nine tick boxes in the groups' lists would be wrong: five tabs, two groups, the radio of the side, and nothing for the tab that stays alone.
    expect([...markup.matchAll(/<label class="tp-tab">/g)]).toHaveLength(5)
    expect(markup).not.toContain('lone.example')
    expect(markup).toContain('github.com')
    expect(markup).toContain('aria-label="Ranger le groupe GitHub"')
    expect(markup).toContain('aria-label="Nom du dossier"')
  })

  it('has "Ranger" as its main button, "Annuler" beside it, and says what will happen: the folders and the tabs', () => {
    const markup = panel(fixture())
    expect(markup).toMatch(/<button type="submit" class="tk-btn primary">Ranger<\/button>/)
    expect(markup).toContain('>Annuler</button>')
    expect(markup).toContain('2 dossiers · 5 onglets')
    expect(unnamed(markup)).toEqual([])
  })

  it('asks where the new folders stand, "Au-dessus des onglets" by default and "Sous les onglets" when that is what was remembered', () => {
    const top = panel(fixture())
    expect(top).toMatch(/role="radiogroup"/)
    expect(top).toMatch(/<input type="radio"[^>]*checked=""[^>]*\/>Au-dessus des onglets/)
    expect(top).toMatch(/<input type="radio"(?![^>]*checked)[^>]*\/>Sous les onglets/)
    const bottom = panel(run(fixture(), { type: 'settings/update', patch: { tidyFoldersPosition: 'bottom' } }))
    expect(bottom).toMatch(/<input type="radio"[^>]*checked=""[^>]*\/>Sous les onglets/)
    expect(bottom).toMatch(/<input type="radio"(?![^>]*checked)[^>]*\/>Au-dessus des onglets/)
  })

  it('opens on what the person has changed: a name typed, a group unticked, a tab unticked', () => {
    const s = fixture()
    const tab = s.tabs.find((t) => t.url === 'https://github.com/b')!.id
    const named = panel(s, { names: new Map([['github', 'Code']]) })
    expect(named).toContain('value="Code"')
    expect(named).not.toContain('value="GitHub"')
    expect(named).toContain('aria-label="Ranger le groupe Code"')
    // One tab unticked: the count goes down, its box is clear, the others stay ticked.
    const less = panel(s, { offTabs: new Set([tab]) })
    expect(less).toContain('>2 onglets<')
    expect([...less.matchAll(/<input type="checkbox"(?![^>]*checked)[^>]*\/>/g)]).toHaveLength(1)
    expect(less).toContain('2 dossiers · 4 onglets')
  })

  it('leaves the main button off, and says nothing is ticked, when every group is unticked (and the tabs of an unticked group cannot be touched)', () => {
    const off = panel(fixture(), { offGroups: new Set(['github', 'google']) })
    expect(off).toMatch(/<button type="submit" class="tk-btn primary" disabled="">Ranger<\/button>/)
    expect(off).toContain('Rien n’est coché.')
    expect(off).not.toContain('2 dossiers · 5 onglets')
    expect([...off.matchAll(/class="tp-group off"/g)]).toHaveLength(2)
    expect([...off.matchAll(/<input type="checkbox"[^>]*disabled=""[^>]*\/>/g)]).toHaveLength(5)
    // One group left ticked: the button is back.
    expect(panel(fixture(), { offGroups: new Set(['github']) })).toMatch(/<button type="submit" class="tk-btn primary">Ranger<\/button>/)
  })

  it('warns a group that is left with a single tab, which makes no folder, and counts only what applies', () => {
    const s = fixture()
    const one = s.tabs.find((t) => t.url === 'https://google.com/1')!.id
    const markup = panel(s, { offTabs: new Set([one]) })
    expect(markup).toContain('Un nouveau dossier a besoin d’au moins deux onglets')
    expect(markup).toContain('1 dossier · 3 onglets')
  })

  it('says a folder joins the one that exists with its name, and does not ask for a side when it makes no new folder', () => {
    let s = fixture()
    s = run(s, { type: 'folder/create', name: 'github' })
    const some = panel(s)
    expect(some).toContain('Rejoint le dossier qui existe déjà')
    expect(some).toMatch(/role="radiogroup"/)
    s = run(s, { type: 'folder/create', name: 'Google' })
    const all = panel(s)
    expect([...all.matchAll(/Rejoint le dossier qui existe déjà/g)]).toHaveLength(2)
    expect(all).not.toMatch(/role="radiogroup"/)
    expect(all).toContain('2 dossiers · 5 onglets')
  })

  it('says there is nothing to tidy when no site has two tabs, with a way to close and no main button', () => {
    const s = run(createInitialState(ctx), ...['https://a.example/', 'https://b.example/'].map((url): Action => ({ type: 'tab/open', url, background: true })))
    const markup = panel(s)
    expect(markup).toContain(frenchSpaces('Rien à ranger : aucun site n’a deux onglets ouverts ou plus.'))
    expect(markup).toContain('>Fermer</button>')
    expect(markup).not.toContain('type="submit"')
    expect(markup).not.toContain('tp-groups')
  })

  it('reads in English when the interface does', () => {
    setLanguage('en')
    const markup = panel(fixture())
    expect(markup).toContain('>Tidy Tabs</h2>')
    expect(markup).toContain('Nothing moves until you choose “Tidy”.')
    expect(markup).toContain('>Tidy</button>')
    expect(markup).toContain('2 folders · 5 tabs')
    expect(markup).toContain('>3 tabs<')
    expect(markup).toContain('Under the tabs')
  })
})

describe('the Today header', () => {
  const header = (markup: string): string => /<div class="today-head">([\s\S]*?)<\/div>/.exec(markup)![1]!

  it('has a small button "Ranger les onglets…" before "Tout archiver" when two tabs can be put in order', () => {
    const markup = header(sidebar(fixture()))
    expect(markup).toMatch(/<button class="today-tidy" title="Ranger les onglets…" aria-label="Ranger les onglets…">/)
    expect(markup.indexOf('today-tidy')).toBeLessThan(markup.indexOf('today-all'))
    expect(markup).toContain('Tout archiver')
  })

  it('is as it always was when fewer than two tabs can be put in order: only "Tout archiver"', () => {
    const one = run(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/', background: true })
    expect(header(sidebar(one))).toMatch(/^<span>Aujourd’hui · 1<\/span><button class="today-all" title="Vider les onglets du jour · ⇧⌘K"><svg[\s\S]*<\/svg>Tout archiver<\/button>$/)
  })

  it('is not there in a private window, which has no folder to put tabs in', () => {
    expect(header(sidebar(fixture(), { private: true }))).not.toContain('today-tidy')
  })

  it('does not count what cannot be put in order: pinned tabs, tabs in a folder', () => {
    const base = fixture()
    const ids = base.tabs.map((t) => t.id)
    const pinned = run(base, ...ids.slice(0, 4).map((id): Action => ({ type: 'tab/pin', id })))
    // Two are left that can be put in order: the button is there, and it goes when a folder takes one of them.
    expect(header(sidebar(pinned))).toContain('today-tidy')
    const filed = run(pinned, { type: 'folder/create-with', tabIds: [ids[4]!], name: 'Dossier' })
    expect(header(sidebar(filed))).not.toContain('today-tidy')
  })
})

describe('the sidebar with a folder under the Today tabs', () => {
  /** Folders "Haut" and "Bas" with a tab each; Today: t1, t2. */
  function listed(): SidebarState {
    let s = createInitialState(ctx)
    s = run(s, { type: 'folder/create', name: 'Haut' }, { type: 'folder/create', name: 'Bas' })
    for (const name of ['h1', 'b1', 't1', 't2']) s = run(s, { type: 'tab/open', url: `https://${name}.example/`, background: true })
    const id = (name: string) => s.tabs.find((t) => t.url === `https://${name}.example/`)!.id
    const [haut, bas] = s.folders.map((f) => f.id) as [string, string]
    s = run(s, { type: 'tab/move', id: id('h1'), toIndex: 99, pinned: true, folderId: haut }, { type: 'tab/move', id: id('b1'), toIndex: 99, pinned: true, folderId: bas })
    return s
  }
  const at = (markup: string, text: string): number => markup.indexOf(text)

  it('draws the folders as it always did while none is put under the tabs: both above Today', () => {
    const markup = sidebar(listed())
    expect(at(markup, 'Haut')).toBeLessThan(at(markup, 'Bas'))
    expect(at(markup, 'Bas')).toBeLessThan(at(markup, 'Aujourd’hui'))
    expect(markup).not.toContain('data-side')
  })

  it('draws the folder put under the tabs after the Today tabs, and marks it for the drop code', () => {
    const s = listed()
    const markup = sidebar(run(s, { type: 'folder/bottom', id: s.folders[1]!.id, bottom: true }))
    expect(at(markup, 'Haut')).toBeLessThan(at(markup, 'Aujourd’hui'))
    expect(at(markup, 'Aujourd’hui')).toBeLessThan(at(markup, 't2.example'))
    expect(at(markup, 't2.example')).toBeLessThan(at(markup, 'Bas'))
    expect(markup.match(/data-side="bottom"/g)).toHaveLength(1)
    expect(markup).toMatch(/<button class="folder-title [^"]*"[^>]*data-id="[^"]+"[^>]*data-side="bottom"[^>]*><span class="folder-icon">[\s\S]*?<span class="folder-name">Bas<\/span>/)
    // Its own tab is in it, not among the loose pinned ones above.
    expect(at(markup, 'b1.example')).toBeGreaterThan(at(markup, 't2.example'))
  })

  it('draws no empty pinned section when every folder is under the tabs and nothing is pinned loose', () => {
    let s = listed()
    s = run(s, { type: 'folder/bottom', id: s.folders[0]!.id, bottom: true }, { type: 'folder/bottom', id: s.folders[1]!.id, bottom: true })
    const markup = sidebar(s)
    expect(markup).not.toContain('pinned-rows')
    expect(markup.match(/<section>/g)).toHaveLength(1)
    const before = sidebar(listed())
    expect(before).toContain('pinned-rows')
    expect(before.match(/<section>/g)).toHaveLength(2)
  })

  it('shows the zone under everything only while a folder is dragged', () => {
    expect(showsFolderBottomZone({ kind: 'folder', id: 'f' })).toBe(true)
    const others: Array<DragSource | null> = [null, { kind: 'tabs', ids: ['t'] }, { kind: 'favorite', id: 'f' }, { kind: 'window-tabs', tabs: [], spaceId: 's' }]
    for (const other of others) expect(showsFolderBottomZone(other)).toBe(false)
    expect(sidebar(listed())).not.toContain('folder-bottom-drop')
  })
})

describe('the sidebar with a folder at the start of Today', () => {
  /** Folders "Haut" and "Debut" with a tab each; Today: t1, t2. "Debut" is put at the start of Today. */
  function listed(): SidebarState {
    let s = createInitialState(ctx)
    s = run(s, { type: 'folder/create', name: 'Haut' }, { type: 'folder/create', name: 'Debut' })
    for (const name of ['h1', 'd1', 't1', 't2']) s = run(s, { type: 'tab/open', url: `https://${name}.example/`, background: true })
    const id = (name: string) => s.tabs.find((t) => t.url === `https://${name}.example/`)!.id
    const [haut, debut] = s.folders.map((f) => f.id) as [string, string]
    s = run(s, { type: 'tab/move', id: id('h1'), toIndex: 99, pinned: true, folderId: haut }, { type: 'tab/move', id: id('d1'), toIndex: 99, pinned: true, folderId: debut })
    return run(s, { type: 'folder/move', id: debut, parentId: null, toIndex: 0, side: 'today-start' })
  }
  const at = (markup: string, text: string): number => markup.indexOf(text)

  it('draws the folder under the Today header and its "New tab" row, before the Today tabs, and marks it for the drop code', () => {
    const markup = sidebar(listed())
    // The folder kept above the header stays there; the one at the start of Today is drawn after the "New tab" row, with its own tab inside it.
    expect(at(markup, 'Haut')).toBeLessThan(at(markup, 'Aujourd’hui'))
    expect(at(markup, 'Aujourd’hui')).toBeLessThan(at(markup, 'class="new-tab'))
    expect(at(markup, 'class="new-tab')).toBeLessThan(at(markup, 'Debut'))
    expect(at(markup, 'Debut')).toBeLessThan(at(markup, 'd1.example'))
    expect(at(markup, 'd1.example')).toBeLessThan(at(markup, 't1.example'))
    expect(at(markup, 't1.example')).toBeLessThan(at(markup, 't2.example'))
    expect(markup.match(/data-side="today-start"/g)).toHaveLength(1)
    expect(markup).not.toContain('data-side="bottom"')
    expect(markup).toMatch(/<button class="folder-title [^"]*"[^>]*data-id="[^"]+"[^>]*data-side="today-start"[^>]*><span class="folder-icon">[\s\S]*?<span class="folder-name">Debut<\/span>/)
  })

  it('leaves the pinned section above the header when only a folder at the start of Today is left, and the "New tab" row is a drop target', () => {
    let s = listed()
    s = run(s, { type: 'folder/move', id: s.folders.find((f) => f.name === 'Haut')!.id, parentId: null, toIndex: 1, side: 'today-start' })
    const markup = sidebar(s)
    expect(markup).not.toContain('pinned-rows')
    expect(markup.match(/<section>/g)).toHaveLength(1)
    expect(markup).toContain('data-drop="today-start"')
    expect(at(markup, 'Haut')).toBeGreaterThan(at(markup, 'Aujourd’hui'))
    expect(at(markup, 'Haut')).toBeLessThan(at(markup, 't1.example'))
  })

  it('draws the three places in their order: above the header, at the start of Today, under the Today tabs', () => {
    let s = listed()
    s = run(s, { type: 'folder/create', name: 'Bas' })
    const bas = s.folders.find((f) => f.name === 'Bas')!.id
    const markup = sidebar(run(s, { type: 'folder/bottom', id: bas, bottom: true }))
    const order = ['Haut', 'Aujourd’hui', 'Debut', 't1.example', 't2.example', 'Bas'].map((text) => at(markup, text))
    expect(order).toEqual([...order].sort((x, y) => x - y))
    expect(order.every((place) => place > -1)).toBe(true)
  })
})
