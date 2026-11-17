// The rules of the lock: what the interface is shown while something is locked, what cannot be sent to it, how fast wrong phrases are allowed.

import { describe, expect, it } from 'vitest'
import { Channel, type UiSnapshot } from './ipc'
import { interfaceMayDispatch } from './ipc-policy'
import {
  FREE_TRIES,
  LOCKED_SPACES_MAX,
  LOCK_PHRASE_MAX,
  LOCK_PHRASE_MIN,
  LOCK_SETTING_KEYS,
  OPEN_WHILE_LOCKED,
  RETRY_FIRST_MS,
  RETRY_MAX_MS,
  canOpenWhileLocked,
  cleanLockedSpaces,
  exportableState,
  hiddenIds,
  lockPhraseProblem,
  editsLockedSpace,
  importUndoRefusal,
  lockRefusalMessage,
  lockRefuses,
  newFolderRefusal,
  restoreRefusal,
  spaceLookRefusal,
  sparingLockedSpaces,
  parseLockConfig,
  namesHiddenId,
  parseUnlockRequest,
  redactForLock,
  redactSnapshotForLock,
  retryDelayMs,
  runtimeOfTabs
} from './lock'
import { defaultSettings, type RuntimeState, type SidebarState } from './model'
import { frenchSpaces } from './french-typography'
import { createInitialState, normalize, reduce, type Action } from './sidebar'

const ctx = { now: 1, newId: () => 'x' }
/** Two spaces with tabs, folders, an archive, a split, a session of each kind, and settings that name sites. */
function sample(): SidebarState {
  const base = createInitialState({ now: 1, newId: () => 'home' })
  const home = base.spaces[0]!
  const work = { ...home, id: 'work', name: 'Travail confidentiel', emoji: '💼' }
  const tab = (id: string, spaceId: string) => ({ id, spaceId, url: `https://${id}.example/`, title: `Titre ${id}`, pinned: false, createdAt: 1, lastActiveAt: 1 })
  return {
    ...base,
    spaces: [{ ...home, id: 'home', name: 'Perso', emoji: '🏠' }, work],
    tabs: [tab('h1', 'home'), tab('w1', 'work'), tab('w2', 'work')],
    folders: [{ id: 'fw', spaceId: 'work', name: 'Dossier secret', collapsed: false }],
    favorites: [{ id: 'f1', url: 'https://favori.example/', title: 'Favori' }],
    bookmarks: [{ id: 'bk1', url: 'https://marque.example/', title: 'Signet confidentiel', tags: ['banque'], addedAt: 1 }],
    readLater: [{ id: 'rl1', url: 'https://lire.example/', title: 'À relire', savedAt: 1, folderId: 'rlf1' }],
    readLaterFolders: [{ id: 'rlf1', name: 'Lectures intimes' }],
    archive: [
      { id: 'a-home', spaceId: 'home', url: 'https://old-home.example/', title: 'Vieux', archivedAt: 1 },
      { id: 'a-work', spaceId: 'work', url: 'https://old-work.example/', title: 'Vieux travail', archivedAt: 1 }
    ],
    splits: [{ id: 's1', spaceId: 'work', tabIds: ['w1', 'w2'], orientation: 'horizontal' as const, ratios: [0.5, 0.5] }],
    sessions: [
      { id: 'se1', name: 'Projet', createdAt: 1, tabs: [{ url: 'https://p.example/', title: 'P' }] },
      { id: 'se2', name: 'Travail', createdAt: 1, tabs: [], space: { space: { ...work, id: 'aside' }, index: 1, folders: [], tabs: [], splits: [], selected: null, archive: [] } }
    ],
    activeSpaceId: 'work',
    activeTabBySpace: { home: 'h1', work: 'w1' },
    sitePermissions: { 'https://cam.example': { camera: 'allow' as const } },
    boosts: [{ id: 'b1', name: 'B', host: 'banque.example', enabled: true, css: '', js: '', zoom: 1, zap: [], tint: { hue: 0, saturation: 1, brightness: 1, contrast: 1 } }],
    settings: { ...defaultSettings(), siteDataRecents: ['banque.example'], developerHosts: ['dev.example'], sleepExcludedHosts: ['secret.example'], lockEnabled: true, lockApp: true, lockedSpaces: ['work'], sidebarWidth: 300 }
  }
}

describe('redactForLock', () => {
  it('gives the same object when nothing is locked', () => {
    const state = sample()
    expect(redactForLock(state, { appLocked: false, lockedSpaces: [] })).toBe(state)
  })

  it('shows a skeleton while the application is locked: spaces without names, nothing else (this fails if a part of the state is left in)', () => {
    const state = sample()
    const shown = redactForLock(state, { appLocked: true, lockedSpaces: [] })
    const text = JSON.stringify(shown)
    for (const secret of ['Perso', 'Travail', 'confidentiel', 'secret', 'example', 'Favori', 'Titre', 'banque', 'Projet', 'intimes', 'relire']) expect(text, secret).not.toContain(secret)
    expect(shown.spaces).toHaveLength(2)
    expect(shown.spaces.map((s) => s.id)).toEqual(['home', 'work'])
    expect(shown.tabs).toEqual([])
    expect(shown.folders).toEqual([])
    expect(shown.favorites).toEqual([])
    expect(shown.archive).toEqual([])
    expect(shown.readLater).toEqual([])
    expect(shown.bookmarks).toEqual([])
    expect(shown.readLaterFolders).toEqual([])
    expect(shown.sessions).toEqual([])
    expect(shown.boosts).toEqual([])
    expect(shown.splits).toEqual([])
    expect(shown.activeSpaceId).toBe('work')
    expect(shown.activeTabBySpace).toEqual({ home: null, work: null })
    // What the window needs to draw itself is kept.
    expect(shown.settings).toMatchObject({ sidebarWidth: 300, lockEnabled: true, lockApp: true, lockedSpaces: [] })
    // The real state is untouched.
    expect(state.tabs).toHaveLength(3)
  })

  it('hides the tabs, folders, archive, splits and saved sessions of a locked space, and only of it', () => {
    const state = sample()
    const shown = redactForLock(state, { appLocked: false, lockedSpaces: ['work'] })
    expect(shown.tabs.map((t) => t.id)).toEqual(['h1'])
    expect(shown.folders).toEqual([])
    expect(shown.archive.map((a) => a.id)).toEqual(['a-home'])
    expect(shown.splits).toEqual([])
    expect(shown.sessions.map((s) => s.id)).toEqual(['se1', 'se2'])
    expect(shown.activeTabBySpace).toEqual({ home: 'h1', work: null })
    // The space itself is still there to be chosen and unlocked.
    expect(shown.spaces.map((s) => s.name)).toEqual(['Perso', 'Travail confidentiel'])
    expect(JSON.stringify(shown)).not.toContain('w1.example')
    expect(JSON.stringify(shown)).not.toContain('old-work')
  })

  it('hides a space put aside that was a locked one, by the id the session holds', () => {
    const state = sample()
    const aside = { ...state, sessions: [{ ...state.sessions[1]!, space: { ...state.sessions[1]!.space!, space: { ...state.sessions[1]!.space!.space, id: 'work' } } }] }
    expect(redactForLock(aside, { appLocked: false, lockedSpaces: ['work'] }).sessions).toEqual([])
  })
})

describe('what a file or the interface cannot do to the lock', () => {
  it('keeps the lock out of an export, and puts back the defaults', () => {
    const state = sample()
    const exported = exportableState(state)
    expect(exported.settings).toMatchObject({ lockEnabled: false, lockApp: false, lockedSpaces: [], lockTouchId: true })
    expect(exported.settings.sidebarWidth).toBe(300)
    const plain = createInitialState(ctx)
    expect(exportableState(plain)).toBe(plain)
  })

  it('refuses a settings patch from the interface that names a setting of the lock (this fails if the filter is removed)', () => {
    for (const key of LOCK_SETTING_KEYS) expect(interfaceMayDispatch({ type: 'settings/update', patch: { [key]: key === 'lockedSpaces' ? [] : false } }, []), key).toBe(false)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { hoverCards: false, lockApp: false } }, [])).toBe(false)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { hoverCards: false } }, [])).toBe(true)
  })

  it('keeps this installation\'s lock when a state is restored, whatever the file says', () => {
    const current = sample()
    const file = { ...sample(), settings: { ...defaultSettings(), lockEnabled: false, lockApp: false, lockedSpaces: [], lockTouchId: false } }
    const after = reduce(current, { type: 'state/restore', state: file }, ctx)
    expect(after.settings).toMatchObject({ lockEnabled: true, lockApp: true, lockedSpaces: ['work'], lockTouchId: true })
    const foreign = { ...sample(), settings: { ...defaultSettings(), lockEnabled: true, lockApp: true, lockedSpaces: ['home', 'work', 'ghost'] } }
    const kept = reduce({ ...current, settings: { ...current.settings, lockEnabled: false, lockApp: false, lockedSpaces: [] } }, { type: 'state/restore', state: foreign }, ctx)
    expect(kept.settings).toMatchObject({ lockEnabled: false, lockApp: false, lockedSpaces: [] })
  })

  it('forgets the lock of a space that no longer exists when a state is loaded', () => {
    const loaded = normalize({ ...sample(), settings: { ...sample().settings, lockedSpaces: ['work', 'ghost', 'home'] } })
    expect(loaded.settings.lockedSpaces).toEqual(['work', 'home'])
  })
})

describe('cleanLockedSpaces and lockPhraseProblem', () => {
  it('keeps ids, each once, and drops what is not an id', () => {
    expect(cleanLockedSpaces(['a', 'b', 'a', 3, '', null, '__proto__', {}])).toEqual(['a', 'b'])
    expect(cleanLockedSpaces('a')).toEqual([])
    expect(cleanLockedSpaces(['a', 'b', 'c'], new Set(['b']))).toEqual(['b'])
    expect(cleanLockedSpaces(Array.from({ length: 5000 }, (_, i) => `s${i}`))).toHaveLength(LOCKED_SPACES_MAX)
  })

  it('accepts a phrase of at least the minimum, counted in characters', () => {
    expect(lockPhraseProblem('x'.repeat(LOCK_PHRASE_MIN))).toBeNull()
    expect(lockPhraseProblem('日本語日本語日本')).toBeNull()
    expect(lockPhraseProblem('x'.repeat(LOCK_PHRASE_MAX))).toBeNull()
    for (const bad of ['', 'court', 'x'.repeat(LOCK_PHRASE_MIN - 1), 'x'.repeat(LOCK_PHRASE_MAX + 1), 42, null, undefined]) expect(lockPhraseProblem(bad), String(bad)).toMatch(/phrase/i)
  })

  it('counts what the user typed, not the units of its encoding: four emoji or four accented letters are four characters', () => {
    // Each of these is eight UTF-16 units but four characters once composed: counted by `.length` they would pass the minimum.
    const short = frenchSpaces(`La phrase du verrou doit faire au moins ${LOCK_PHRASE_MIN} caractères.`)
    expect(lockPhraseProblem('🔒🔑🔐🔏')).toBe(short)
    expect(lockPhraseProblem('e\u0301'.repeat(4))).toBe(short)
    expect(lockPhraseProblem('x'.repeat(LOCK_PHRASE_MAX + 1))).toBe(frenchSpaces('La phrase du verrou est trop longue.'))
    expect(lockPhraseProblem(42)).toBe(frenchSpaces('La phrase du verrou est invalide.'))
  })
})

describe('retryDelayMs', () => {
  it('lets a few wrong phrases through, then doubles the wait up to a ceiling', () => {
    for (let n = 0; n < FREE_TRIES; n++) expect(retryDelayMs(n)).toBe(0)
    expect(retryDelayMs(FREE_TRIES)).toBe(RETRY_FIRST_MS)
    expect(retryDelayMs(FREE_TRIES + 1)).toBe(RETRY_FIRST_MS * 2)
    expect(retryDelayMs(FREE_TRIES + 2)).toBe(RETRY_FIRST_MS * 4)
    expect(retryDelayMs(1000)).toBe(RETRY_MAX_MS)
    expect(retryDelayMs(Number.NaN)).toBe(0)
    expect(retryDelayMs(-1)).toBe(0)
  })
})

describe('requests from the interface are hostile', () => {
  it('parses an unlock request, with the phrase or without (Touch ID), and refuses anything else', () => {
    expect(parseUnlockRequest({ target: { scope: 'app' } })).toEqual({ target: { scope: 'app' } })
    expect(parseUnlockRequest({ target: { scope: 'app' }, phrase: 'abc' })).toEqual({ target: { scope: 'app' }, phrase: 'abc' })
    expect(parseUnlockRequest({ target: { scope: 'space', spaceId: 'work' }, phrase: '' })).toEqual({ target: { scope: 'space', spaceId: 'work' }, phrase: '' })
    const hostile = [null, 'app', [], {}, { target: null }, { target: [] }, { target: { scope: 'other' } }, { target: { scope: 'space' } }, { target: { scope: 'space', spaceId: 3 } }, { target: { scope: 'space', spaceId: '__proto__' } }, { target: { scope: 'app' }, phrase: 3 }, { target: { scope: 'app' }, phrase: 'x'.repeat(LOCK_PHRASE_MAX + 1) }]
    for (const raw of hostile) expect(parseUnlockRequest(raw), JSON.stringify(raw)).toBeNull()
    // The longest phrase the lock takes still reaches the check: refused here, it could never be typed to unlock.
    const longest = 'x'.repeat(LOCK_PHRASE_MAX)
    expect(parseUnlockRequest({ target: { scope: 'app' }, phrase: longest })).toEqual({ target: { scope: 'app' }, phrase: longest })
  })

  it('parses each change of the lock, and refuses anything else', () => {
    expect(parseLockConfig({ op: 'set-phrase', phrase: 'abcdefgh' })).toEqual({ op: 'set-phrase', phrase: 'abcdefgh' })
    expect(parseLockConfig({ op: 'set-phrase', phrase: 'abcdefgh', current: 'old' })).toEqual({ op: 'set-phrase', phrase: 'abcdefgh', current: 'old' })
    expect(parseLockConfig({ op: 'disable', current: 'abc' })).toEqual({ op: 'disable', current: 'abc' })
    expect(parseLockConfig({ op: 'app', value: true })).toEqual({ op: 'app', value: true })
    expect(parseLockConfig({ op: 'touch-id', value: false })).toEqual({ op: 'touch-id', value: false })
    expect(parseLockConfig({ op: 'space', spaceId: 'work', locked: true })).toEqual({ op: 'space', spaceId: 'work', locked: true })
    expect(parseLockConfig({ op: 'lock-now' })).toEqual({ op: 'lock-now' })
    const hostile = [null, 'lock-now', [], {}, { op: 'nope' }, { op: 'set-phrase' }, { op: 'set-phrase', phrase: 3 }, { op: 'set-phrase', phrase: 'abcdefgh', current: 3 }, { op: 'disable' }, { op: 'app', value: 'true' }, { op: 'touch-id' }, { op: 'space', spaceId: 'w', locked: 1 }, { op: 'space', locked: true }, { op: 'set-phrase', phrase: 'x'.repeat(LOCK_PHRASE_MAX + 1) }]
    for (const raw of hostile) expect(parseLockConfig(raw), JSON.stringify(raw)).toBeNull()
    const longest = 'x'.repeat(LOCK_PHRASE_MAX)
    expect(parseLockConfig({ op: 'set-phrase', phrase: longest, current: longest })).toEqual({ op: 'set-phrase', phrase: longest, current: longest })
    expect(parseLockConfig({ op: 'disable', current: longest })).toEqual({ op: 'disable', current: longest })
    for (const raw of [{ op: 'set-phrase', phrase: 'abcdefgh', current: `${longest}x` }, { op: 'disable', current: `${longest}x` }]) expect(parseLockConfig(raw)).toBeNull()
  })
})

describe('what stays open while the application is locked', () => {
  it('is exactly the snapshot (a skeleton), the unlock, and closing a panel', () => {
    expect([...OPEN_WHILE_LOCKED].sort()).toEqual([Channel.getSnapshot, Channel.lockUnlock, Channel.closeOverlay].sort())
  })

  it('does not include the channels that change or read anything', () => {
    for (const channel of [Channel.dispatch, Channel.exportData, Channel.lockConfigure, Channel.searchHistory, Channel.tabThumbnail, Channel.openOverlay, Channel.submitUrl, Channel.suggest]) expect(OPEN_WHILE_LOCKED.has(channel)).toBe(false)
  })
})

describe('lockRefuses', () => {
  it('refuses deleting or putting aside a locked space, and copying the tabs of the locked space on screen (this fails if the list is removed)', () => {
    expect(lockRefuses({ type: 'space/delete', id: 'work' }, ['work'], 'home')).toBe(true)
    expect(lockRefuses({ type: 'space/aside', id: 'work' }, ['work'], 'home')).toBe(true)
    expect(lockRefuses({ type: 'session/save' }, ['work'], 'work')).toBe(true)
    expect(lockRefuses({ type: 'readlater/add', tabId: 'w1' }, ['work'], 'work')).toBe(true)
  })

  it('refuses what empties or resets a locked space, named or on screen', () => {
    for (const type of ['today/clear', 'tabs/reset-pinned', 'tabs/tidy', 'folder/collapse-all']) {
      // The space the action names (the menu of a space's icon sends it whatever is on screen).
      expect(lockRefuses({ type, spaceId: 'work' }, ['work'], 'home'), type).toBe(true)
      // Without a space, the one on screen (the application menu and its shortcuts).
      expect(lockRefuses({ type }, ['work'], 'work'), type).toBe(true)
      expect(lockRefuses({ type }, ['work'], 'home'), type).toBe(false)
      expect(lockRefuses({ type, spaceId: 'home' }, ['work'], 'work'), type).toBe(false)
    }
  })

  it('refuses changing the sites kept beside a locked space, and moving it to another profile', () => {
    expect(lockRefuses({ type: 'space/panel-remove', id: 'work', panelId: 'p' }, ['work'], 'home')).toBe(true)
    expect(lockRefuses({ type: 'space/panel-add', id: 'work', panelId: 'p', url: 'https://a.example/' }, ['work'], 'home')).toBe(true)
    expect(lockRefuses({ type: 'space/update', id: 'work', patch: { profileId: 'other' } }, ['work'], 'home')).toBe(true)
    expect(lockRefuses({ type: 'space/update', id: 'home', patch: { profileId: 'other' } }, ['work'], 'home')).toBe(false)
    expect(lockRefuses({ type: 'space/select', id: 'work' }, ['work'], 'home')).toBe(false)
  })

  it('refuses changing what a locked space is recognised by: its name, its icon, its theme, its background, its picture, its header', () => {
    const patches = [{ name: 'Travail' }, { emoji: '🔥' }, { iconKind: 'letter', iconLetter: 'T' }, { theme: { intensity: 0.2 } }, { background: undefined }, {}]
    for (const patch of patches) {
      expect(lockRefuses({ type: 'space/update', id: 'work', patch }, ['work'], 'home'), JSON.stringify(patch)).toBe(true)
      expect(lockRefuses({ type: 'space/update', id: 'home', patch }, ['work'], 'work'), JSON.stringify(patch)).toBe(false)
    }
    for (const action of [{ type: 'space/header', visible: false }, { type: 'space/header', visible: true }, { type: 'space/image', image: 'a.png' }, { type: 'space/image', image: null }, { type: 'space/background-position', x: 20, y: 80 }]) {
      expect(lockRefuses({ ...action, id: 'work' }, ['work'], 'home'), JSON.stringify(action)).toBe(true)
      expect(lockRefuses({ ...action, id: 'home' }, ['work'], 'work'), JSON.stringify(action)).toBe(false)
    }
    expect(spaceLookRefusal('work', ['work'])).toBe(frenchSpaces('Cet espace est verrouillé : déverrouillez-le d’abord.'))
    expect(spaceLookRefusal('home', ['work'])).toBeNull()
  })

  it('refuses making a folder, live or not, in a locked space: the one named, the one of the folder it is made in, the one on screen', () => {
    const places = { spaces: [{ id: 'home' }, { id: 'work' }], folders: [{ id: 'in-work', spaceId: 'work' }, { id: 'in-home', spaceId: 'home' }] }
    for (const type of ['folder/create', 'livefolder/create']) {
      expect(lockRefuses({ type, name: 'F', spaceId: 'work' }, ['work'], 'home', places), type).toBe(true)
      expect(lockRefuses({ type, name: 'F' }, ['work'], 'work', places), type).toBe(true)
      // A folder made inside another goes to its space, whatever space the action names and whatever is on screen.
      expect(lockRefuses({ type, name: 'F', parentId: 'in-work', spaceId: 'home' }, ['work'], 'home', places), type).toBe(true)
      expect(lockRefuses({ type, name: 'F', parentId: 'in-home', spaceId: 'work' }, ['work'], 'work', places), type).toBe(false)
      // A space that does not exist is the one on screen, as in the reducer.
      expect(lockRefuses({ type, name: 'F', spaceId: 'gone' }, ['work'], 'work', places), type).toBe(true)
      expect(lockRefuses({ type, name: 'F', spaceId: 'gone' }, ['work'], 'home', places), type).toBe(false)
      // The other spaces keep making folders, even while the locked one is on screen.
      expect(lockRefuses({ type, name: 'F', spaceId: 'home' }, ['work'], 'work', places), type).toBe(false)
      expect(lockRefuses({ type, name: 'F' }, ['work'], 'home', places), type).toBe(false)
    }
    // The menus that offer « Nouveau dossier » grey it out with the sentence of that refusal, for the locked space only.
    expect(newFolderRefusal('work', ['work'])).toBe(lockRefusalMessage({ type: 'folder/create' }))
    expect(newFolderRefusal('home', ['work'])).toBeNull()
    expect(newFolderRefusal('work', [])).toBeNull()
  })

  it('leaves the place of a locked space in the list free', () => {
    expect(lockRefuses({ type: 'space/move', id: 'work', toIndex: 0 }, ['work'], 'work')).toBe(false)
  })

  it('refuses what replaces every space, or takes whole spaces away, while any space is locked', () => {
    const replacing = [{ type: 'state/restore', state: {} }, { type: 'backup/restore', copy: {} }, { type: 'import/revert', spaces: [], tabs: [], folders: [], favorites: [], splits: [], boosts: [] }]
    for (const action of replacing) {
      expect(lockRefuses(action, ['work'], 'home'), action.type).toBe(true)
      expect(lockRefuses(action, [], 'home'), action.type).toBe(false)
    }
    // An import only adds: it is not among them.
    expect(lockRefuses({ type: 'import/merge', spaces: [] }, ['work'], 'home')).toBe(false)
  })

  it('says why in a sentence of its own: restoring, taking an import back, or a single space', () => {
    const restore = frenchSpaces('Déverrouillez vos espaces verrouillés avant de restaurer : la restauration remplacerait leurs onglets.')
    const undo = frenchSpaces('Déverrouillez vos espaces verrouillés avant d’annuler l’import : l’annulation pourrait retirer leurs onglets.')
    expect(lockRefusalMessage({ type: 'state/restore' })).toBe(restore)
    expect(lockRefusalMessage({ type: 'backup/restore' })).toBe(restore)
    expect(lockRefusalMessage({ type: 'import/revert' })).toBe(undo)
    expect(lockRefusalMessage({ type: 'space/update' })).toBe(frenchSpaces('Cet espace est verrouillé : déverrouillez-le d’abord.'))
    expect(restoreRefusal(['work'])).toBe(restore)
    expect(restoreRefusal([])).toBeNull()
    expect(importUndoRefusal(['work'])).toBe(undo)
    expect(importUndoRefusal([])).toBeNull()
  })

  it('knows the editor of a locked space among the panels: the one of its name and icon, and the one of its theme', () => {
    expect(editsLockedSpace({ panel: 'space', spaceId: 'work' }, ['work'])).toBe(true)
    expect(editsLockedSpace({ panel: 'theme', spaceId: 'work' }, ['work'])).toBe(true)
    expect(editsLockedSpace({ panel: 'space', spaceId: 'home' }, ['work'])).toBe(false)
    expect(editsLockedSpace({ panel: 'space', spaceId: 'work' }, [])).toBe(false)
    // The other panels that name a space change nothing of its look: they are the lock's other rules' to refuse.
    expect(editsLockedSpace({ panel: 'spacemenu', spaceId: 'work' }, ['work'])).toBe(false)
    expect(editsLockedSpace({ panel: 'spaces' }, ['work'])).toBe(false)
  })

  it('makes « Appliquer ce thème à tous les espaces » leave the locked spaces as they are', () => {
    const action = { type: 'space/apply-themes', entries: [{ id: 'home', theme: { intensity: 1 } }, { id: 'work', theme: { intensity: 1 } }, { id: 'play', theme: { intensity: 1 } }] }
    expect(sparingLockedSpaces(action, ['work'])).toEqual({ type: 'space/apply-themes', entries: [{ id: 'home', theme: { intensity: 1 } }, { id: 'play', theme: { intensity: 1 } }] })
    expect(sparingLockedSpaces(action, [])).toBe(action)
  })

  it('makes « Vider l’archive » spare the locked spaces, whatever the sender asked to keep', () => {
    expect(sparingLockedSpaces({ type: 'archive/clear' }, ['work'])).toEqual({ type: 'archive/clear', keepSpaces: ['work'] })
    expect(sparingLockedSpaces({ type: 'archive/clear', keepSpaces: ['home'] }, ['work'])).toEqual({ type: 'archive/clear', keepSpaces: ['work'] })
    expect(sparingLockedSpaces({ type: 'archive/clear', keepSpaces: ['home'] }, [])).toEqual({ type: 'archive/clear' })
    const other = { type: 'today/clear' }
    expect(sparingLockedSpaces(other, ['work'])).toBe(other)
  })

  it('lets everything else through', () => {
    expect(lockRefuses({ type: 'space/delete', id: 'home' }, ['work'], 'home')).toBe(false)
    expect(lockRefuses({ type: 'session/save' }, ['work'], 'home')).toBe(false)
    expect(lockRefuses({ type: 'tab/open', url: 'https://a.example/' }, ['work'], 'work')).toBe(false)
    expect(lockRefuses({ type: 'space/delete', id: 'work' }, [], 'work')).toBe(false)
    expect(lockRefuses(null, ['work'], 'work')).toBe(false)
    expect(lockRefuses({ type: 3 }, ['work'], 'work')).toBe(false)
  })
})

describe('the web panels of a space the lock hides', () => {
  const withPanels = (): SidebarState => {
    const state = sample()
    const panel = (id: string) => [{ id: `p-${id}`, url: `https://panneau-${id}.example/`, title: `Panneau ${id}` }]
    return { ...state, spaces: state.spaces.map((s) => ({ ...s, image: `${s.id}.png`, webPanels: panel(s.id) })) }
  }

  it('are not in the skeleton shown while the application is locked, nor is the picture of a space (this fails if a space is passed through whole)', () => {
    const shown = redactForLock(withPanels(), { appLocked: true, lockedSpaces: [] })
    const text = JSON.stringify(shown)
    expect(text).not.toContain('panneau')
    expect(text).not.toContain('Panneau')
    expect(text).not.toContain('.png')
    expect(shown.spaces.map((s) => s.id)).toEqual(['home', 'work'])
  })

  it('are taken out of a locked space only: the other spaces keep theirs, and the locked one keeps its name to be chosen and unlocked', () => {
    const state = withPanels()
    const shown = redactForLock(state, { appLocked: false, lockedSpaces: ['work'] })
    const home = shown.spaces.find((s) => s.id === 'home')!
    const work = shown.spaces.find((s) => s.id === 'work')!
    expect(home.webPanels).toEqual(state.spaces[0]!.webPanels)
    expect(home).toBe(state.spaces[0])
    expect(work.webPanels).toBeUndefined()
    expect(work.name).toBe('Travail confidentiel')
    expect(JSON.stringify(shown)).not.toContain('panneau-work')
    // The real state is untouched.
    expect(state.spaces[1]!.webPanels).toHaveLength(1)
  })
})

describe('runtimeOfTabs', () => {
  const runtime = (): RuntimeState => ({
    tabs: { h1: { loading: false, audible: false, muted: false, awake: true }, w1: { loading: false, audible: true, muted: false, awake: false }, ghost: { loading: false, audible: false, muted: false, awake: false } },
    canGoBack: false,
    canGoForward: false,
    media: ['h1', 'w1']
  })

  it('leaves no entry for a tab the interface is not shown: its id would give it away (this fails without the filter)', () => {
    const state = sample()
    const shown = redactForLock(state, { appLocked: false, lockedSpaces: ['work'] })
    const given = runtimeOfTabs(runtime(), shown)
    expect(Object.keys(given.tabs)).toEqual(['h1'])
    expect(given.media).toEqual(['h1'])
    expect(JSON.stringify(given)).not.toContain('w1')
    expect(given.canGoBack).toBe(false)
  })

  it('shows nothing of any tab while the application is locked', () => {
    const shown = redactForLock(sample(), { appLocked: true, lockedSpaces: [] })
    expect(runtimeOfTabs(runtime(), shown).tabs).toEqual({})
  })

  it('names no hidden tab among the rows « Actualiser tous les onglets » marks (this fails without the filter)', () => {
    const shown = redactForLock(sample(), { appLocked: false, lockedSpaces: ['work'] })
    const given = runtimeOfTabs({ ...runtime(), reloadMarks: { h1: 'pending', w1: 'running' } }, shown)
    expect(given.reloadMarks).toEqual({ h1: 'pending' })
    expect(Object.hasOwn(runtimeOfTabs({ ...runtime(), reloadMarks: { w1: 'running' } }, shown), 'reloadMarks')).toBe(false)
    // Nothing hidden: the same object.
    const open: RuntimeState = { tabs: {}, canGoBack: false, canGoForward: false, reloadMarks: { h1: 'reloaded' } }
    expect(runtimeOfTabs(open, sample())).toBe(open)
  })

  it('drops the entry of a tab that was closed while it slept: the shell keeps its facts to the tabs the state holds (this fails if the entries are kept)', () => {
    const state = sample()
    const kept = runtimeOfTabs(runtime(), state)
    expect(Object.keys(kept.tabs)).toEqual(['h1', 'w1'])
    expect(kept.tabs['ghost']).toBeUndefined()
    // Dropping again changes nothing: the same object, so a shell that runs it at every sync copies nothing.
    expect(runtimeOfTabs(kept, state)).toBe(kept)
  })

  it('gives the same object back when every entry is a tab that is shown', () => {
    const state = sample()
    const all: RuntimeState = { tabs: { h1: runtime().tabs['h1']!, w1: runtime().tabs['w1']! }, canGoBack: true, canGoForward: false, media: ['h1'] }
    expect(runtimeOfTabs(all, state)).toBe(all)
    const bare: RuntimeState = { tabs: {}, canGoBack: false, canGoForward: false }
    expect(runtimeOfTabs(bare, state)).toBe(bare)
  })
})

describe('hiddenIds and namesHiddenId: the interface cannot name what it was never shown', () => {
  const view = { appLocked: false, lockedSpaces: ['work'] }

  it('lists what redactForLock takes out: tabs, folders, archive entries, split views, a session put aside', () => {
    const state = sample()
    expect([...hiddenIds(state, view)].sort()).toEqual(['a-work', 'fw', 's1', 'w1', 'w2'])
    const aside = { ...state, sessions: [{ ...state.sessions[1]!, space: { ...state.sessions[1]!.space!, space: { ...state.sessions[1]!.space!.space, id: 'work' } } }] }
    expect(hiddenIds(aside, view).has('se2')).toBe(true)
    expect(hiddenIds(state, view).has('se2')).toBe(false)
  })

  it('lists everything while the application is locked, and nothing when nothing is', () => {
    const state = sample()
    expect(hiddenIds(state, { appLocked: true, lockedSpaces: [] })).toEqual(new Set(['h1', 'w1', 'w2', 'fw', 'a-home', 'a-work', 's1', 'se1', 'se2']))
    expect(hiddenIds(state, { appLocked: false, lockedSpaces: [] }).size).toBe(0)
  })

  it('sees an id in any field that holds the id of a tab, a folder or a split, alone or in a list', () => {
    const hidden = new Set(['w1'])
    for (const action of [{ type: 'tab/close', id: 'w1' }, { type: 'readlater/add', tabId: 'w1' }, { type: 'split/create', tabId: 'h1', withTabId: 'w1' }, { type: 'tab/open', url: 'https://a.example/', openerId: 'w1' }, { type: 'tab/move', id: 'h1', toIndex: 0, pinned: true, folderId: 'w1' }, { type: 'tabs/move', ids: ['h1', 'w1'], toIndex: 0, pinned: false }, { type: 'session/save', tabIds: ['w1'] }, { type: 'tabs/archive-many', ids: ['w1'] }]) {
      expect(namesHiddenId(action, hidden), JSON.stringify(action)).toBe(true)
    }
  })

  it('sees the tabs and the id of a split view carried whole by split/restore', () => {
    const hidden = new Set(['w1', 'sp-hidden'])
    const split = (patch: object) => ({ type: 'split/restore', split: { id: 'sp', spaceId: 'home', tabIds: ['h1', 'h2'], orientation: 'horizontal', ratios: [0.5, 0.5], ...patch } })
    expect(namesHiddenId(split({ tabIds: ['h1', 'w1'] }), hidden)).toBe(true)
    expect(namesHiddenId(split({ id: 'sp-hidden' }), hidden)).toBe(true)
    expect(namesHiddenId(split({}), hidden)).toBe(false)
  })

  it('sees the tabs named in the groups of a tidy, which the other fields do not reach (this fails if the groups are not read)', () => {
    const hidden = new Set(['w1'])
    const tidy = (...groups: object[]) => ({ type: 'tabs/tidy', groups })
    expect(namesHiddenId(tidy({ name: 'A', tabIds: ['h1', 'w1'] }), hidden)).toBe(true)
    expect(namesHiddenId(tidy({ name: 'A', tabIds: ['h1'] }, { name: 'B', tabIds: ['w1'] }), hidden)).toBe(true)
    expect(namesHiddenId(tidy({ name: 'A', tabIds: ['h1', 'h2'] }, { name: 'B', tabIds: [] }), hidden)).toBe(false)
    for (const odd of [null, 'groups', 5, [null, 4, 'w1'], { w1: 1 }]) expect(namesHiddenId({ type: 'tabs/tidy', groups: odd }, hidden)).toBe(false)
    // The undo names its tabs and folders in its own fields.
    expect(namesHiddenId({ type: 'tabs/untidy', tabs: [{ id: 'w1', folderId: 'f', index: 0 }], folderIds: ['w1'] }, hidden)).toBe(false)
  })

  it('lets through what names something shown, a space (the lock screen is that of a space), or nothing', () => {
    const hidden = new Set(['w1'])
    for (const action of [{ type: 'tab/select', id: 'h1' }, { type: 'space/select', id: 'work' }, { type: 'tab/open', url: 'https://a.example/', spaceId: 'work' }, { type: 'session/save', tabIds: ['h1'] }, { type: 'tabs/move', ids: [], toIndex: 0, pinned: false }, { type: 'compact/toggle' }, { id: 5 }, { tabIds: 'w1' }, { tabIds: [5, null] }]) {
      expect(namesHiddenId(action, hidden), JSON.stringify(action)).toBe(false)
    }
    for (const odd of [null, undefined, 'w1', 5, [], ['w1']]) expect(namesHiddenId(odd, hidden)).toBe(false)
    expect(namesHiddenId({ id: 'w1' }, new Set())).toBe(false)
  })

  it('catches the actions forged against a locked space, which change what the interface is shown if they get through (this fails if the guard is removed)', () => {
    const state = sample()
    const hidden = hiddenIds(state, view)
    const forged: Action[] = [
      { type: 'tab/move-to-space', id: 'w1', spaceId: 'home' },
      { type: 'readlater/add', tabId: 'w1' },
      { type: 'bookmark/add', tabId: 'w1' },
      { type: 'session/save', tabIds: ['w1', 'w2'] },
      { type: 'tab/duplicate', id: 'w1' },
      { type: 'tab/update', id: 'w1', patch: { title: 'x' } }
    ]
    const leaked = (action: Action): string => JSON.stringify(redactForLock(reduce({ ...state, settings: { ...state.settings, bookmarkManager: true } }, action, { now: 2, newId: () => 'new' }), view))
    // Without the guard the address of the locked tab shows in what the interface is given.
    expect(leaked(forged[0]!)).toContain('w1.example')
    expect(leaked(forged[1]!)).toContain('w1.example')
    expect(leaked(forged[2]!)).toContain('w1.example')
    expect(leaked(forged[3]!)).toContain('w1.example')
    for (const action of forged) expect(namesHiddenId(action, hidden), action.type).toBe(true)
  })
})

describe('canOpenWhileLocked', () => {
  it('lets every panel open while the application is not locked', () => {
    for (const panel of ['commandbar', 'history', 'archive', 'space', 'peek', 'downloads', 'plus', 'site', 'passwords', 'tabcycle', 'dialog']) {
      expect(canOpenWhileLocked(panel, false)).toBe(true)
    }
  })

  it('opens nothing of the user’s own over the lock screen (the command bar of the Dock’s New Window would hide the field of the phrase)', () => {
    for (const panel of ['commandbar', 'history', 'archive', 'spaces', 'space', 'spacecreate', 'theme', 'peek', 'downloads', 'plus', 'site', 'sitedata', 'cookies', 'passwords', 'bookmarks', 'readlater', 'sessions', 'import', 'find', 'findreplace', 'boost', 'capture', 'annotate', 'windowname', 'favorite', 'tab', 'settings', 'extensions', 'livefolder', 'autoreload', 'qr', 'translate']) {
      expect(canOpenWhileLocked(panel, true), panel).toBe(false)
    }
  })

  it('still lets the questions of a page or an extension through, and ⌃Tab (which is made from the state the interface is given)', () => {
    for (const panel of ['dialog', 'permission', 'auth', 'extreview', 'passphrase', 'tabcycle']) expect(canOpenWhileLocked(panel, true), panel).toBe(true)
  })
})

describe('redactSnapshotForLock: what the lock screen is told beside the state', () => {
  /** A snapshot whose every part beside the state names something of the user's: a download, an extension, a notice, a panel, a window. */
  function full(state: SidebarState): UiSnapshot {
    return {
      state,
      runtime: { tabs: {} },
      engine: { name: 'electron', version: '45', chromium: '140', extensionsSupported: true },
      extensions: [{ id: 'ext', name: 'Extension secrète' }],
      downloads: [{ id: 'd1', filename: 'releve-bancaire.pdf', url: 'https://banque.example/releve.pdf', path: '/Users/x/Downloads/releve-bancaire.pdf', state: 'completed', receivedBytes: 1, totalBytes: 1, startedAt: 1 }],
      find: { text: 'mot cherché', matches: 1, ordinal: 1 },
      peek: { url: 'https://peek.example/', title: 'Aperçu', canGoBack: false, canGoForward: false, loading: false },
      scrollSyncedSplits: ['s1', 'gone'],
      sidePanel: { extensionId: 'ext', name: 'Panneau secret' },
      webPanel: { id: 'wp', title: 'Panneau web', url: 'https://panneau.example/' },
      toast: { id: 1, message: 'Téléchargement terminé : releve-bancaire.pdf', durationMs: 3000 },
      platform: 'darwin',
      windows: [{ id: 'window-2', name: 'Banque' }],
      windowName: 'Perso',
      foreignDrag: { token: 1, tabs: [] },
      reloadRun: { done: 1, total: 2, phase: 'awake', spaceId: 'work' },
      deadTabs: [{ id: 'h1', reason: 'not-found' }, { id: 'w1', reason: 'refused' }],
      spaceTabs: { home: 2, work: 3 }
    } as unknown as UiSnapshot
  }

  it('tells the lock screen of the application nothing of the downloads, the extensions, a notice, a panel or the windows', () => {
    const state = redactForLock(sample(), { appLocked: true, lockedSpaces: ['work'] })
    const shown = redactSnapshotForLock(full(state), { appLocked: true })
    expect(shown.downloads).toEqual([])
    expect(shown.extensions).toEqual([])
    expect(shown.toast).toBeNull()
    expect(shown.find).toBeNull()
    expect(shown.peek).toBeNull()
    expect(shown.sidePanel).toBeNull()
    for (const key of ['webPanel', 'windows', 'windowName', 'foreignDrag', 'scrollSyncedSplits', 'reloadRun', 'deadTabs', 'spaceTabs']) expect(Object.hasOwn(shown, key), key).toBe(false)
    const text = JSON.stringify(shown)
    for (const secret of ['releve-bancaire', 'banque.example', 'Extension secrète', 'mot cherché', 'peek.example', 'Panneau', 'Banque', 'Perso']) expect(text, secret).not.toContain(secret)
    expect(shown.state).toBe(state)
    expect(shown.platform).toBe('darwin')
  })

  it('with spaces locked only, keeps the downloads (the application’s list) and names only the split views the shown state holds', () => {
    const state = redactForLock(sample(), { appLocked: false, lockedSpaces: ['work'] })
    const snapshot = full(state)
    const shown = redactSnapshotForLock(snapshot, { appLocked: false })
    expect(shown.downloads).toBe(snapshot.downloads)
    expect(Object.hasOwn(shown, 'scrollSyncedSplits')).toBe(false)
    const open = full(sample())
    expect(redactSnapshotForLock(open, { appLocked: false }).scrollSyncedSplits).toEqual(['s1'])
  })

  it('with spaces locked, names among the sites that no longer answer only the tabs the shown state holds (this fails without the filter)', () => {
    const state = redactForLock(sample(), { appLocked: false, lockedSpaces: ['work'] })
    expect(redactSnapshotForLock(full(state), { appLocked: false }).deadTabs).toEqual([{ id: 'h1', reason: 'not-found' }])
    const none = { ...full(state), deadTabs: [{ id: 'w1', reason: 'refused' }] } as unknown as UiSnapshot
    expect(Object.hasOwn(redactSnapshotForLock(none, { appLocked: false }), 'deadTabs')).toBe(false)
  })

  it('gives the same object back when the lock is off', () => {
    const snapshot = full(sample())
    expect(redactSnapshotForLock(snapshot, undefined)).toBe(snapshot)
  })
})
