import { describe, expect, it } from 'vitest'
import { actionToDispatch, candidateHint, rankCandidates, type Candidate } from './command-bar'
import { COMMANDS, effectiveAccelerator, findConflicts } from './keybindings'
import { menuKey } from './menu-state'
import type { Bookmark, Settings, SidebarState } from './model'
import { createInitialState, reduce, type Ctx } from './sidebar'

let n = 0
const ctx = (): Ctx => ({ now: 1, newId: () => `id${++n}` })
const bm = (i: number, over: Partial<Bookmark> = {}): Bookmark => ({ id: `b${i}`, url: `https://site${i}.example/page`, title: `Page ${i}`, tags: [], addedAt: i, ...over })
function state(settings: Partial<Settings> = {}, url = 'https://courant.example/', bookmarks: Bookmark[] = []): SidebarState {
  let s = createInitialState(ctx())
  s = { ...s, settings: { ...s.settings, ...settings }, bookmarks }
  return url ? reduce(s, { type: 'tab/open', url }, ctx()) : s
}
/** The commands (not the search the bar offers for the typed words). */
const labels = (list: Candidate[]) => list.filter((c) => c.kind === 'action').map((c) => c.label)
const ALL_ON: Partial<Settings> = { bookmarkManager: true, liveFolders: true, webAppWindows: true }

describe('the commands of the library', () => {
  it('exist once each, with no default shortcut, and ⌘D is still "Épingler l’onglet"', () => {
    for (const id of ['bookmarkAdd', 'bookmarkList', 'openAsApp', 'newLiveFolder']) {
      expect(COMMANDS.filter((c) => c.id === id), id).toHaveLength(1)
      expect(effectiveAccelerator(id, {}), id).toBeUndefined()
    }
    expect(COMMANDS.find((c) => c.accelerator === 'CmdOrCtrl+D')?.id).toBe('pin')
    expect(findConflicts({})).toEqual({})
    expect(effectiveAccelerator('bookmarkAdd', { bookmarkAdd: 'CmdOrCtrl+Alt+D' })).toBe('CmdOrCtrl+Alt+D')
    expect(findConflicts({ bookmarkAdd: 'CmdOrCtrl+D' })['CmdOrCtrl+D']?.sort()).toEqual(['bookmarkAdd', 'pin'])
  })

  it('make the menu be built again when a function is switched on or off', () => {
    // One state, only a setting changes (two states made apart never have the same ids).
    const s = state()
    const base = menuKey(s, [])
    for (const key of ['bookmarkManager', 'liveFolders', 'webAppWindows'] as const) {
      expect(menuKey({ ...s, settings: { ...s.settings, [key]: true } }, []), key).not.toBe(base)
    }
  })
})

describe('the command bar and the library functions', () => {
  it('offers none of them, nor any bookmark, while the functions are off', () => {
    const off = state({}, 'https://courant.example/', [bm(1, { title: 'Signet visible' })])
    for (const query of ['signets', 'ajouter aux signets', 'dossier en direct', 'application', 'Signet visible', 'ouvrir les signets']) {
      const found = rankCandidates(query, off)
      expect(found.filter((c) => c.kind === 'bookmark'), query).toEqual([])
      expect(labels(found).filter((l) => /signets|direct|application/i.test(l)), query).toEqual([])
    }
  })

  it('offers each command while its function is on, the ones that need a web page only with one on screen', () => {
    const on = state(ALL_ON)
    expect(labels(rankCandidates('signets', on))).toEqual(expect.arrayContaining(['Ajouter aux signets', 'Ouvrir les signets']))
    expect(labels(rankCandidates('dossier en direct', on))).toContain('Nouveau dossier en direct…')
    expect(labels(rankCandidates('comme application', on))).toContain('Ouvrir comme application')
    const noPage = state(ALL_ON, '')
    expect(labels(rankCandidates('signets', noPage))).toEqual(['Ouvrir les signets'])
    expect(labels(rankCandidates('application', noPage))).not.toContain('Ouvrir comme application')
    const blank = state(ALL_ON, 'about:blank')
    expect(labels(rankCandidates('ajouter aux signets', blank))).not.toContain('Ajouter aux signets')
  })

  it('offers none in a private window, which keeps no bookmark and opens no application window', () => {
    const on = state(ALL_ON, 'https://courant.example/', [bm(1, { title: 'Signet visible' })])
    const found = rankCandidates('signets', on, [], [], [], { private: true })
    expect(labels(found).filter((l) => /signets|direct|application/i.test(l))).toEqual([])
    expect(rankCandidates('Signet visible', on, [], [], [], { private: true }).some((c) => c.kind === 'bookmark')).toBe(false)
  })

  it('finds bookmarks by title, address, note and tag, at most four, and says where they come from', () => {
    const list = [bm(1, { title: 'Recette de tarte', tags: ['cuisine'] }), bm(2, { title: 'Doc Electron', tags: ['dev'], note: 'à relire' }), ...[3, 4, 5, 6].map((i) => bm(i, { title: `Tarte ${i}`, tags: ['cuisine'] }))]
    const s = state({ bookmarkManager: true }, 'https://courant.example/', list)
    const byTitle = rankCandidates('tarte', s).filter((c) => c.kind === 'bookmark')
    expect(byTitle).toHaveLength(4)
    expect(byTitle.every((c) => c.kind === 'bookmark' && c.detail.startsWith('Signet · site'))).toBe(true)
    expect(rankCandidates('#dev', s).filter((c) => c.kind === 'bookmark').map((c) => c.id)).toEqual(['bookmark:b2'])
    expect(rankCandidates('relire', s).filter((c) => c.kind === 'bookmark').map((c) => c.id)).toEqual(['bookmark:b2'])
    const found = rankCandidates('doc', s).find((c) => c.kind === 'bookmark')!
    expect(found).toMatchObject({ kind: 'bookmark', label: 'Doc Electron', bookmarkId: 'b2' })
    expect(found.kind === 'bookmark' && found.detail).toContain('#dev')
    expect(candidateHint(found)).toBe('Ouvrir la page')
  })

  it('turns "Ajouter aux signets" into an action on the page on screen, and leaves the panels and the window to the caller', () => {
    const s = state(ALL_ON)
    expect(actionToDispatch('bookmark-add', s)).toEqual({ type: 'bookmark/add', tabId: s.tabs[0]!.id })
    expect(actionToDispatch('bookmark-add', state(ALL_ON, 'about:blank'))).toBeNull()
    expect(actionToDispatch('bookmark-add', state(ALL_ON, ''))).toBeNull()
    for (const action of ['bookmarks-list', 'live-folder-new', 'open-as-app'] as const) expect(actionToDispatch(action, s), action).toBeNull()
  })

  it('does not list the library commands before anything is typed', () => {
    expect(labels(rankCandidates('', state(ALL_ON))).filter((l) => /signets|direct|application/i.test(l))).toEqual([])
  })
})
