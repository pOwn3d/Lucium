import { describe, expect, it } from 'vitest'
import {
  PRIVATE_BACKGROUND,
  privateSpaceName,
  WINDOW_LOCAL_SETTINGS,
  canOpenInPrivate,
  changedSettings,
  createPrivateState,
  inheritedSettings,
  privateAction,
  privateTheme,
  scrubPrivateState,
  withoutPrivateProfile
} from './private-window'
import { profileDownloadDir, profileLabel, profileRecordsHistory, profileSearch } from './profiles'
import { createInitialState, reduce, type Action } from './sidebar'
import { backgroundColors, resolveAppearance } from './theme'
import type { OverlayRequest } from './ipc'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const run = (state: ReturnType<typeof createInitialState>, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** The private store: every change goes through the reducer, then the scrub. */
const privateRun = (state: ReturnType<typeof createInitialState>, ...actions: Action[]) => actions.reduce((s, a) => scrubPrivateState(reduce(s, a, ctx)), state)

describe('the private theme', () => {
  it('is dark whatever the system says, and paints the sidebar its own dark colour', () => {
    expect(resolveAppearance(privateTheme(), false)).toBe('dark')
    expect(resolveAppearance(privateTheme(), true)).toBe('dark')
    expect(backgroundColors(privateTheme(), 'dark')).toEqual([PRIVATE_BACKGROUND, PRIVATE_BACKGROUND])
  })
})

describe('createPrivateState', () => {
  const main = run(createInitialState(ctx), { type: 'tab/open', url: 'https://secret.example/' }, { type: 'tab/archive', id: 'id3' }, { type: 'favorite/add', url: 'https://fav.example/', title: 'Fav' }, {
    type: 'settings/update',
    patch: { blockAds: true, sidebarWidth: 300, extensionPaths: ['/ext'], keyBindings: { newTab: 'CmdOrCtrl+Alt+T' } }
  })

  it('has one empty space and none of the main window’s tabs, archive or favourites', () => {
    expect(main.archive.length + main.favorites.length).toBeGreaterThan(0)
    const state = createPrivateState(main, ctx)
    expect(state.spaces).toHaveLength(1)
    expect(state.spaces[0]!.name).toBe(privateSpaceName())
    expect(state.activeSpaceId).toBe(state.spaces[0]!.id)
    expect(state.activeTabBySpace).toEqual({ [state.spaces[0]!.id]: null })
    expect(state.tabs).toEqual([])
    expect(state.archive).toEqual([])
    expect(state.favorites).toEqual([])
    expect(state.sitePermissions).toEqual({})
    expect(state.spaces[0]!.id).not.toBe(main.spaces[0]!.id)
  })

  it('follows the main window’s settings, without its extensions, and starts with the sidebar shown', () => {
    const state = createPrivateState({ ...main, settings: { ...main.settings, sidebarVisible: false } }, ctx)
    expect(state.settings.blockAds).toBe(true)
    expect(state.settings.keyBindings).toEqual({ newTab: 'CmdOrCtrl+Alt+T' })
    expect(state.settings.extensionPaths).toEqual([])
    // The store cannot install into a private window, whatever the main window allows.
    expect(main.settings.webStoreInstall).toBe(true)
    expect([state.settings.webStoreInstall, state.settings.webStoreUpdates]).toEqual([false, 'manual'])
    expect(state.settings.sidebarVisible).toBe(true)
    expect(state.settings.sidebarWidth).toBe(300)
  })
})

describe('inheritedSettings', () => {
  it('leaves out what describes one window, and the extensions', () => {
    const inherited = inheritedSettings(createInitialState(ctx).settings)
    for (const key of WINDOW_LOCAL_SETTINGS) expect(inherited).not.toHaveProperty(key)
    expect(inherited).not.toHaveProperty('extensionPaths')
    expect(inherited).not.toHaveProperty('webStoreInstall')
    expect(inherited).not.toHaveProperty('webStoreUpdates')
    expect(inherited).toHaveProperty('blockAds')
    expect(inherited).toHaveProperty('searchUrlTemplate')
  })
})

describe('a profile of the user that has the id of the private window (made before the id was kept, or brought by a file)', () => {
  /** The main window: a profile « Private » under the id `private`, with its own search engine, download folder, history choice and proxy. */
  const main = () => {
    const state = createInitialState(ctx)
    const own = { searchUrlTemplate: 'https://theirs.example/?q=%s', searchSuggestions: false, downloadDir: '/Users/x/Secret', historyOff: true }
    return { ...state, settings: { ...state.settings, searchUrlTemplate: 'https://default.example/?q=%s', searchSuggestions: true, profileNames: { private: 'Private', work: 'Travail' }, profiles: { private: own, work: { downloadDir: '/Users/x/Work' } } } }
  }

  it('lends nothing to a new private window: its space reads the settings of the default profile', () => {
    const state = createPrivateState(main(), ctx)
    const id = state.spaces[0]!.profileId
    expect(id).toBe('private')
    expect(profileSearch(state.settings, id)).toEqual({ url: 'https://default.example/?q=%s', suggestions: true })
    expect(profileDownloadDir(state.settings, id)).toBeUndefined()
    expect(profileRecordsHistory(state.settings, id)).toBe(true)
    expect(profileLabel(state.settings, id)).toBe('private')
    // The other profiles are followed as before.
    expect(state.settings.profiles).toEqual({ work: { downloadDir: '/Users/x/Work' } })
    expect(state.settings.profileNames).toEqual({ work: 'Travail' })
  })

  it('lends nothing either when the settings of the main window change under an open private window', () => {
    const inherited = inheritedSettings(main().settings)
    expect(inherited.profiles).toEqual({ work: { downloadDir: '/Users/x/Work' } })
    expect(inherited.profileNames).toEqual({ work: 'Travail' })
    const open = createPrivateState(main(), ctx)
    expect(changedSettings(open.settings, inherited)).toEqual({})
  })

  it('leaves settings without such a profile as they are (the same object), and the main window keeps its profile', () => {
    const plain = createInitialState(ctx).settings
    expect(withoutPrivateProfile(plain)).toBe(plain)
    const settings = main().settings
    withoutPrivateProfile(settings)
    expect(Object.keys(settings.profiles)).toEqual(['private', 'work'])
    expect(withoutPrivateProfile({ profiles: { constructor: {} } }).profiles).toEqual({ constructor: {} })
  })
})

describe('the search engine of the private window', () => {
  const mainWith = (privateSearchUrlTemplate: string) => {
    const state = createInitialState(ctx)
    return { ...state, settings: { ...state.settings, searchUrlTemplate: 'https://default.example/?q=%s', searchSuggestions: true, privateSearchUrlTemplate } }
  }

  it('follows the engine of the other windows until one is picked for it', () => {
    const state = createPrivateState(mainWith(''), ctx)
    expect(profileSearch(state.settings, state.spaces[0]!.profileId)).toEqual({ url: 'https://default.example/?q=%s', suggestions: true })
  })

  it('uses the engine picked for it, in a new window and under an open one, and the suggestions setting is still the main one', () => {
    const picked = 'https://private.example/?q=%s'
    const state = createPrivateState(mainWith(picked), ctx)
    expect(profileSearch(state.settings, state.spaces[0]!.profileId)).toEqual({ url: picked, suggestions: true })
    const open = createPrivateState(mainWith(''), ctx)
    const changes = changedSettings(open.settings, inheritedSettings(mainWith(picked).settings))
    expect(changes.privateSearchUrlTemplate).toBe(picked)
    expect(profileSearch({ ...open.settings, ...changes }, open.spaces[0]!.profileId).url).toBe(picked)
  })

  it('leaves the other profiles on the engine of the main window, and does not let a private window change it', () => {
    const settings = mainWith('https://private.example/?q=%s').settings
    expect(profileSearch(settings, 'default').url).toBe('https://default.example/?q=%s')
    expect(profileSearch(settings, 'work').url).toBe('https://default.example/?q=%s')
    expect(privateAction({ type: 'settings/update', patch: { privateSearchUrlTemplate: 'https://x.example/?q=%s' } })).toBeNull()
  })
})

describe('scrubPrivateState', () => {
  it('drops the archive, the favourites and the Tweaks, and hands back the same object when there is nothing to drop', () => {
    const clean = createInitialState(ctx)
    expect(scrubPrivateState(clean)).toBe(clean)
    const dirty = run(clean, { type: 'tab/open', url: 'https://a.fr/' }, { type: 'favorite/add', url: 'https://f.fr/', title: 'F' })
    const archived = run(dirty, { type: 'tab/archive', id: dirty.tabs[0]!.id })
    expect(archived.archive).toHaveLength(1)
    expect(archived.favorites).toHaveLength(1)
    const scrubbed = scrubPrivateState(archived)
    expect(scrubbed.favorites).toEqual([])
    expect(scrubbed.archive).toEqual([])
  })

  // Each list alone, so that a list the scrub forgot (or the test that says it has nothing to drop) is seen.
  it('drops each list a private window must not carry, even when it is the only one that holds something', () => {
    const clean = createInitialState(ctx)
    const entry = { id: 'kept' } as never
    for (const list of ['archive', 'readLater', 'readLaterFolders', 'bookmarks', 'favorites', 'boosts'] as const) {
      const holding = { ...clean, [list]: [entry] }
      const scrubbed = scrubPrivateState(holding)
      expect(scrubbed, list).not.toBe(holding)
      expect(scrubbed[list], list).toEqual([])
    }
  })

  it('makes closing a tab leave no trace: the tab is gone and nothing can restore it', () => {
    const opened = privateRun(createPrivateState(createInitialState(ctx), ctx), { type: 'tab/open', url: 'https://a.fr/' }, { type: 'tab/open', url: 'https://b.fr/' })
    const [first, second] = opened.tabs
    const closed = privateRun(opened, { type: 'tab/archive', id: first!.id })
    expect(closed.tabs.map((t) => t.id)).toEqual([second!.id])
    expect(closed.archive).toEqual([])
    // "Clear" keeps the selected tab and never archives the others.
    const cleared = privateRun(opened, { type: 'today/clear' })
    expect(cleared.tabs.map((t) => t.id)).toEqual([second!.id])
    expect(cleared.archive).toEqual([])
    expect(privateRun(closed, { type: 'archive/restore-last' }).tabs.map((t) => t.id)).toEqual([second!.id])
  })
})

describe('privateAction', () => {
  it('lets tabs and split views through', () => {
    for (const action of [
      { type: 'tab/open', url: 'https://a.fr/' },
      { type: 'tab/select', id: 'a' },
      { type: 'tab/close', id: 'a' },
      { type: 'tab/archive', id: 'a' },
      { type: 'today/clear' },
      { type: 'split/create', tabId: 'a', withTabId: 'b' },
      { type: 'split/create', tabId: 'a', withTabId: 'b', orientation: 'vertical', focus: 'second' },
      { type: 'split/remove', tabId: 'a' },
      { type: 'split/ratios', id: 's', ratios: [0.3, 0.7] },
      { type: 'split/move', tabId: 'a', direction: 1 },
      // The "Annuler" of a closed pane: a private window has the notice too.
      { type: 'split/restore', split: { id: 's', spaceId: 'p', tabIds: ['a', 'b'], orientation: 'horizontal', ratios: [0.5, 0.5] } },
      { type: 'tab/open', url: 'https://a.fr/', openerId: 'a' },
      { type: 'tab/forget-origin', id: 'a' },
      { type: 'tab/back-to-origin', id: 'a' },
      { type: 'permission/set', origin: 'https://a.fr', permission: 'geolocation', decision: 'allow' }
    ] satisfies Action[]) {
      expect(privateAction(action)).toEqual(action)
    }
  })

  it('refuses what the window does not have: spaces, pins, folders, favourites, Tweaks, the archive, imports', () => {
    for (const action of [
      { type: 'space/create', name: 'x', emoji: 'x', hue: 1 },
      { type: 'space/delete', id: 'a' },
      { type: 'space/update', id: 'a', patch: { name: 'x' } },
      { type: 'tab/pin', id: 'a' },
      { type: 'tab/move', id: 'a', toIndex: 0, pinned: true },
      { type: 'tab/move', id: 'a', toIndex: 0, pinned: false, folderId: 'f' },
      { type: 'folder/create', name: 'x' },
      { type: 'favorite/add', url: 'https://a.fr/', title: 'A' },
      { type: 'boost/save', boost: { host: 'a.fr' } },
      { type: 'archive/restore-last' },
      { type: 'archive/add', url: 'https://a.fr/', title: 'A', source: 'manual' },
      { type: 'archive/sweep' },
      // A private window keeps no visit and forgets no answer: the days are the main window's.
      { type: 'permission/visit', origin: 'https://a.fr', day: 20_000 },
      { type: 'permission/sweep', day: 20_000 },
      { type: 'import/merge', spaces: [], tabs: [], folders: [], favorites: [] },
      { type: 'import/revert', spaces: [], tabs: [], folders: [], favorites: [], splits: [], boosts: [] }
    ] satisfies Action[]) {
      expect(privateAction(action)).toBeNull()
    }
    expect(privateAction({ type: 'tab/move', id: 'a', toIndex: 1, pinned: false })).not.toBeNull()
  })

  it('keeps only the layout settings of a settings change', () => {
    expect(privateAction({ type: 'settings/update', patch: { sidebarWidth: 300, blockAds: true, extensionPaths: ['/x'] } })).toEqual({ type: 'settings/update', patch: { sidebarWidth: 300 } })
    expect(privateAction({ type: 'settings/update', patch: { blockAds: true } })).toBeNull()
  })

  it('never remembers the sites erased from a private window, nor lets it change how erasing behaves', () => {
    // The list of recent sites is the main window's: a private window's run must leave no trace of the site in the saved settings.
    for (const key of ['siteDataRecents', 'siteDataConfirm', 'siteDataAutoClose', 'siteDataNotify', 'siteDataTypes', 'siteDataSubdomains', 'siteDataReload'] as const) {
      expect(WINDOW_LOCAL_SETTINGS as readonly string[], key).not.toContain(key)
    }
    expect(privateAction({ type: 'settings/update', patch: { siteDataRecents: ['secret.example'] } })).toBeNull()
    expect(privateAction({ type: 'settings/update', patch: { siteDataRecents: ['secret.example'], sidebarWidth: 300 } })).toEqual({ type: 'settings/update', patch: { sidebarWidth: 300 } })
  })
})

describe('canOpenInPrivate', () => {
  it('opens the panels about the page and the command bar, not the ones about kept data', () => {
    const panels: Array<OverlayRequest['panel']> = ['commandbar', 'find', 'downloads', 'settings', 'capture', 'annotate', 'site', 'sitedata', 'tab', 'permission', 'auth', 'dialog', 'peek', 'splitdrop', 'tabcycle', 'archive', 'history', 'spaces', 'space', 'theme', 'boost', 'plus']
    expect(panels.filter(canOpenInPrivate)).toEqual(['commandbar', 'find', 'downloads', 'settings', 'capture', 'annotate', 'site', 'sitedata', 'tab', 'permission', 'auth', 'dialog', 'peek', 'splitdrop', 'tabcycle'])
  })

  // chrome://extensions typed in a private window: the page is the one of Settings' family and manages the profiles' extensions, which a private window has none of.
  it('opens the Extensions page like Settings: it shows the owner’s extensions, nothing the window keeps', () => {
    expect(canOpenInPrivate('extensions')).toBe(true)
  })
})

describe('the new usage settings in a private window', () => {
  it('lets the window be named (the name is kept in memory only, windows.json never lists a private window) and nothing else of them is its own', () => {
    expect(canOpenInPrivate('windowname')).toBe(true)
    for (const key of ['warnBeforeClosingWindow', 'modifiedClickBackground', 'blankLinkBackground', 'showZoomIndicator', 'nameWindows', 'uiScale', 'showAdvancedSettings']) {
      expect(WINDOW_LOCAL_SETTINGS as readonly string[], key).not.toContain(key)
      expect(key in inheritedSettings(createInitialState(ctx).settings), key).toBe(true)
      // A private window cannot change them: they are the main window's, and follow it.
      expect(privateAction({ type: 'settings/update', patch: { [key]: true } }), key).toBeNull()
    }
  })
})

describe('changedSettings', () => {
  it('keeps only what really differs, so an unrelated change of the main window does not touch the private one', () => {
    const settings = createInitialState(ctx).settings
    expect(changedSettings(settings, inheritedSettings(settings))).toEqual({})
    expect(changedSettings(settings, { blockAds: !settings.blockAds, searchUrlTemplate: settings.searchUrlTemplate, keyBindings: { newTab: 'CmdOrCtrl+Alt+T' } })).toEqual({ blockAds: !settings.blockAds, keyBindings: { newTab: 'CmdOrCtrl+Alt+T' } })
  })
})

describe('sessions of tabs in a private window', () => {
  const withSession = run(createInitialState(ctx), { type: 'tab/open', url: 'https://secret.example/' }, { type: 'session/save', name: 'Projet X' })

  it('refuses saving, restoring, renaming and deleting a session: a private window keeps nothing on disk', () => {
    expect(withSession.sessions).toHaveLength(1)
    const id = withSession.sessions[0]!.id
    for (const action of [
      { type: 'session/save', name: 'x' },
      { type: 'session/save', name: 'x', tabIds: ['a'] },
      { type: 'session/restore', id },
      { type: 'session/restore', id, target: 'new-space' },
      { type: 'session/rename', id, name: 'y' },
      { type: 'session/delete', id }
    ] satisfies Action[]) {
      expect(privateAction(action)).toBeNull()
    }
  })

  it('refuses to put a space aside, to reopen one and to restore a copy of the session: nothing of the main window is touched from there', () => {
    const two = run(createInitialState(ctx), { type: 'space/create', name: 'Deux', emoji: '2', hue: 10 })
    const aside = run(two, { type: 'space/aside', id: two.activeSpaceId })
    const copy = { spaces: two.spaces, tabs: [], folders: [], activeSpaceId: two.activeSpaceId, activeTabBySpace: two.activeTabBySpace, splits: [], archive: [] }
    for (const action of [{ type: 'space/aside', id: two.activeSpaceId }, { type: 'space/reopen', id: aside.sessions[0]!.id }, { type: 'backup/restore', copy }] satisfies Action[]) {
      expect(privateAction(action), action.type).toBeNull()
    }
  })

  it('cannot open the panel of the sessions', () => {
    expect(canOpenInPrivate('sessions')).toBe(false)
  })

  it('starts with none of the main window’s sessions', () => {
    expect(createPrivateState(withSession, ctx).sessions).toEqual([])
  })
})

describe('the panel of the local translation in a private window', () => {
  it('opens there (it translates with the models it has) and the window inherits the settings of the function', () => {
    expect(canOpenInPrivate('translate')).toBe(true)
    const main = createInitialState({ now: 1, newId: () => 'id' })
    const settings = inheritedSettings({ ...main.settings, translateLocal: true, translateModelsDir: '/Users/moi/Modeles', interfaceTranslated: true, language: 'en' })
    expect(settings).toMatchObject({ translateLocal: true, translateModelsDir: '/Users/moi/Modeles', interfaceTranslated: true, language: 'en' })
  })

  it('cannot change those settings itself: they are not among the settings of a window', () => {
    for (const patch of [{ translateLocal: true }, { translateModelsDir: '/x' }, { translateTarget: 'de' }, { interfaceTranslated: true }, { language: 'en' }] as const) {
      expect(privateAction({ type: 'settings/update', patch })).toBeNull()
    }
  })
})
