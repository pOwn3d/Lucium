import { describe, expect, it } from 'vitest'
import { createInitialState, reduce, type Action } from './sidebar'
import { NO_FACTS, menuKey, soundFact, undoableArchive } from './menu-state'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const run = (state: ReturnType<typeof createInitialState>, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)

describe('menuKey', () => {
  const empty = createInitialState(ctx)
  const base = run(empty, { type: 'tab/open', url: 'https://a.fr/' })
  const key = (state = base, extensions: string[] = []) => menuKey(state, extensions)

  it('does not change when only tabs, titles or sidebar sizes change', () => {
    const retitled = run(base, { type: 'tab/update', id: base.tabs[0]!.id, patch: { title: 'Autre' } })
    const another = run(base, { type: 'tab/open', url: 'https://b.fr/' })
    expect(key(retitled)).toBe(key())
    expect(key(another)).toBe(key())
    expect(key(run(base, { type: 'settings/update', patch: { sidebarWidth: 300 } }))).toBe(key())
  })

  // Found by the end-to-end tests: with tabSearch or shortcutHelp switched, Onglets › Rechercher un onglet and Aide › Raccourcis stayed as they were until another setting rebuilt the menu.
  it('changes when the tab search or the help of the shortcuts is switched, since their menu entries come and go', () => {
    expect(key(run(base, { type: 'settings/update', patch: { tabSearch: !base.settings.tabSearch } }))).not.toBe(key())
    expect(key(run(base, { type: 'settings/update', patch: { shortcutHelp: !base.settings.shortcutHelp } }))).not.toBe(key())
  })

  // Without these keys, File › Rappels d’onglets would stay as it was when a reminder is added or cancelled, or when the function is switched.
  it('changes when a reminder is added or cancelled, and when the reminders are switched on or off', () => {
    const withReminder = run(base, { type: 'reminder/add', tabId: base.tabs[0]!.id, dueAt: 10 ** 7 })
    expect(withReminder.tabReminders).toHaveLength(1)
    expect(key(withReminder)).not.toBe(key())
    // Cancelling brings the key back to the one of the same state without a reminder (the added tab was closed: compare with a state that has none waiting).
    const cancelled = run(withReminder, { type: 'reminder/cancel', id: withReminder.tabReminders[0]!.id })
    expect(cancelled.tabReminders).toHaveLength(0)
    expect(key(cancelled)).not.toBe(key(withReminder))
    expect(key(run(base, { type: 'settings/update', patch: { tabReminders: false } }))).not.toBe(key())
  })

  it('changes when the profil invité is switched on or off (File › Nouvelle fenêtre invité comes and goes), and is the same as before while it is off', () => {
    const on = run(base, { type: 'settings/update', patch: { guestProfile: true } })
    expect(key(on)).not.toBe(key())
    expect(key(run(on, { type: 'settings/update', patch: { guestProfile: false } }))).toBe(key())
  })

  // File › Résumer… is greyed out for a private tab on screen once Ollama is on another computer: moving Ollama there, with that tab on
  // screen, has to rebuild the menu, and nothing else of the summary does.
  it('changes when the address of Ollama moves to another computer while a private tab is on screen, and not for an ordinary tab', () => {
    const ollama = (url: string) => ({ type: 'settings/update', patch: { aiSummary: true, ollamaConfig: { ...base.settings.ollamaConfig, enabled: true, url } } }) as Action
    const priv = run(base, { type: 'tab/open', url: 'https://prive.fr/', private: true })
    expect(priv.tabs.find((t) => t.id === priv.activeTabBySpace[priv.activeSpaceId])?.private).toBe(true)
    expect(key(run(priv, ollama('http://mon-mac.local:11434')))).not.toBe(key(run(priv, ollama('http://localhost:11434'))))
    expect(key(run(base, ollama('http://mon-mac.local:11434')))).toBe(key(run(base, ollama('http://localhost:11434'))))
  })

  it('changes when the private tabs or the cookie view are switched off (their menu entries are hidden), and is the same as before while they are on', () => {
    const noTabs = run(base, { type: 'settings/update', patch: { privateTabs: false } })
    const noCookies = run(base, { type: 'settings/update', patch: { cookieManager: false } })
    expect(key(noTabs)).not.toBe(key())
    expect(key(noCookies)).not.toBe(key())
    expect(key(noTabs)).not.toBe(key(noCookies))
    expect(key(run(noTabs, { type: 'settings/update', patch: { privateTabs: true } }))).toBe(key())
    expect(key(run(noCookies, { type: 'settings/update', patch: { cookieManager: true } }))).toBe(key())
  })

  it('changes with what the menu shows: shortcuts, spaces, appearance, profile names, the extensions, the archive and split views', () => {
    const second = run(base, { type: 'tab/open', url: 'https://b.fr/' })
    const split = run(second, { type: 'split/create', tabId: second.tabs[0]!.id, withTabId: second.tabs[1]!.id })
    const archived = run(base, { type: 'tab/archive', id: base.tabs[0]!.id })
    const seen = new Set([key()])
    const variants = [
      key(empty),
      key(split),
      key(archived),
      key(run(base, { type: 'settings/update', patch: { keyBindings: { newTab: 'CmdOrCtrl+Alt+N' } } })),
      key(run(base, { type: 'space/update', id: base.spaces[0]!.id, patch: { name: 'Autre nom' } })),
      key(run(base, { type: 'space/create', name: 'Deux', emoji: '2', hue: 10 })),
      key(run(base, { type: 'settings/update', patch: { websiteAppearance: 'dark' } })),
      key(run(base, { type: 'settings/update', patch: { interfaceAppearance: 'dark' } })),
      key(run(base, { type: 'settings/update', patch: { showToolbar: false } })),
      key(run(base, { type: 'settings/update', patch: { profileNames: { default: 'Perso' } } })),
      key(base, ['abcdefghijklmnopabcdefghijklmnop']),
      key(run(base, { type: 'settings/update', patch: { webStoreInstall: false } }))
    ]
    for (const variant of variants) {
      expect(seen.has(variant)).toBe(false)
      seen.add(variant)
    }
  })
})

describe('menuKey: the icon of a space', () => {
  const two = run(createInitialState(ctx), { type: 'space/create', name: 'Deux', emoji: '2', hue: 10 })
  const key = (state = two) => menuKey(state, [])
  const id = two.spaces[1]!.id

  it('changes when a space comes to wear letters, since the menu lists it by them, and when its letters change', () => {
    const lettered = run(two, { type: 'space/update', id, patch: { iconLetter: 'ab', iconKind: 'letter' } })
    const other = run(lettered, { type: 'space/update', id, patch: { iconLetter: 'cd' } })
    expect(key(lettered)).not.toBe(key())
    expect(key(other)).not.toBe(key(lettered))
    expect(key(run(other, { type: 'space/update', id, patch: { iconKind: 'emoji' } }))).toBe(key())
  })

  it('does not change for what the menu never shows: the colour or the shape of the letters', () => {
    const lettered = run(two, { type: 'space/update', id, patch: { iconLetter: 'ab', iconKind: 'letter' } })
    expect(key(run(lettered, { type: 'space/update', id, patch: { iconColor: '#2f9e63', iconRound: true } }))).toBe(key(lettered))
  })

  it('changes for a space put aside that wears letters, listed by them to be reopened', () => {
    const lettered = run(two, { type: 'space/update', id, patch: { iconLetter: 'ab', iconKind: 'letter' } })
    expect(key(run(lettered, { type: 'space/aside', id }))).not.toBe(key(run(two, { type: 'space/aside', id })))
  })
})

describe('menuKey: the spaces put aside', () => {
  const two = run(createInitialState(ctx), { type: 'space/create', name: 'Deux', emoji: '2', hue: 10 }, { type: 'tab/open', url: 'https://a.fr/' })
  const key = (state = two) => menuKey(state, [])

  it('changes when a space is put aside, renamed in the list, reopened, and when putting the space on screen aside becomes impossible', () => {
    const aside = run(two, { type: 'space/aside', id: two.activeSpaceId })
    const renamed = run(aside, { type: 'session/rename', id: aside.sessions[0]!.id, name: 'Autre' })
    const reopened = run(aside, { type: 'space/reopen', id: aside.sessions[0]!.id })
    const full = { ...two, sessions: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, createdAt: i, tabs: [{ url: 'https://s.example/', title: 's' }] })) }
    const keys = new Set([key()])
    for (const variant of [aside, renamed, full]) {
      expect(keys.has(key(variant))).toBe(false)
      keys.add(key(variant))
    }
    expect(key(reopened)).toBe(key())
  })

  it('does not change for an ordinary session, which the menu does not list', () => {
    const plain = run(two, { type: 'session/save', name: 'Projet' })
    expect(key(plain)).toBe(key())
  })
})

describe('menuKey: what depends on the page on screen', () => {
  const base = run(createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
  const key = (state = base, facts = NO_FACTS, start = 0) => menuKey(state, [], facts, start)

  it('changes when the page can go back or forward, loads, or a search starts (Back, Forward, Stop and Find Next grey out)', () => {
    const keys = new Set([key()])
    for (const facts of [{ ...NO_FACTS, canGoBack: true }, { ...NO_FACTS, canGoForward: true }, { ...NO_FACTS, loading: true }, { ...NO_FACTS, finding: true }]) {
      expect(keys.has(key(base, facts))).toBe(false)
      keys.add(key(base, facts))
    }
  })

  it('changes with the sidebar being shown, the tab being pinned, a web page or not, and Developer Mode (the entries say which they do)', () => {
    const keys = new Set([key()])
    const variants = [
      run(base, { type: 'settings/update', patch: { sidebarVisible: false } }),
      run(base, { type: 'tab/pin', id: base.tabs[0]!.id }),
      run(base, { type: 'developer/site', site: 'a.fr', enabled: true }),
      run(createInitialState(ctx))
    ]
    for (const variant of variants) {
      expect(keys.has(key(variant))).toBe(false)
      keys.add(key(variant))
    }
  })

  it('does not change when another site goes into Developer Mode', () => {
    expect(key(run(base, { type: 'developer/site', site: 'b.org', enabled: true }))).toBe(key())
  })
})

describe('undoableArchive', () => {
  let counter = 0
  const ctxAt = (now: number) => ({ now, newId: () => `t${++counter}` })
  const started = 1_000

  it('is true for a tab archived by hand since the session began, and then gone once it is restored', () => {
    const open = reduce(createInitialState(ctxAt(started)), { type: 'tab/open', url: 'https://a.fr/' }, ctxAt(started))
    const archived = reduce(open, { type: 'tab/archive', id: open.tabs[0]!.id }, ctxAt(started + 5))
    expect(undoableArchive(archived, started)).toBe(true)
    expect(undoableArchive(reduce(archived, { type: 'archive/restore-last' }, ctxAt(started + 9)), started)).toBe(false)
  })

  it('is false for an archive that came from a session before this one, and for nothing archived', () => {
    const open = reduce(createInitialState(ctxAt(500)), { type: 'tab/open', url: 'https://a.fr/' }, ctxAt(500))
    const old = reduce(open, { type: 'tab/archive', id: open.tabs[0]!.id }, ctxAt(600))
    expect(undoableArchive(old, started)).toBe(false)
    expect(undoableArchive(createInitialState(ctxAt(1)), 0)).toBe(false)
  })

  it('is false for a tab the idle delay archived: the user did nothing to undo', () => {
    const first = reduce(createInitialState(ctxAt(started)), { type: 'tab/open', url: 'https://a.fr/' }, ctxAt(started))
    // The selected tab is never swept: a second one takes the selection.
    const open = reduce(first, { type: 'tab/open', url: 'https://b.fr/' }, ctxAt(started))
    const swept = reduce(open, { type: 'archive/sweep' }, ctxAt(started + 99 * 3_600_000))
    expect(swept.archive.length).toBeGreaterThan(0)
    expect(swept.archive[0]!.source).toBe('auto')
    expect(undoableArchive(swept, started)).toBe(false)
  })
})

describe('menuKey: the readable mode entry', () => {
  const base = run(createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
  const key = (state = base) => menuKey(state, [])
  const choose = (state: typeof base, site: string, mode: 'original' | 'dark' | 'light' | null) => run(state, { type: 'readable/site', site, mode })

  it('does not change with the default mode, nor with the mode of another site (the checked entry is the site on screen\'s own)', () => {
    expect(key(run(base, { type: 'settings/update', patch: { readableMode: 'dark' } }))).toBe(key())
    expect(key(choose(base, 'b.fr', 'dark'))).toBe(key())
  })

  it('changes when the site on screen gets a mode of its own, when that mode changes, and when it is given back to the default', () => {
    const dark = choose(base, 'a.fr', 'dark')
    const light = choose(dark, 'a.fr', 'light')
    expect(new Set([key(), key(dark), key(light)]).size).toBe(3)
    expect(key(choose(light, 'a.fr', null))).toBe(key())
  })

  it('is the same for a page that is not a web page, whatever the choices (the entry is greyed out there)', () => {
    const blank = run(createInitialState(ctx), { type: 'tab/open', url: 'about:blank' })
    expect(key(choose(blank, 'a.fr', 'dark'))).toBe(key(blank))
  })
})

describe('soundFact: what the sound entry of the Tabs menu can do', () => {
  it('mutes a tab that plays, gives its sound back to a muted one, and has nothing to do for a silent tab', () => {
    expect(soundFact({ audible: true, muted: false, awake: true })).toBe('audible')
    expect(soundFact({ audible: true, muted: true, awake: true })).toBe('muted')
    expect(soundFact({ audible: false, muted: true, awake: true })).toBe('muted')
    expect(soundFact({ audible: false, muted: false, awake: true })).toBe('silent')
  })

  it('is silent for a tab with no page (asleep) and for no tab at all', () => {
    expect(soundFact({ audible: true, muted: false, awake: false })).toBe('silent')
    expect(soundFact(undefined)).toBe('silent')
  })

  it('changes the key of the menu when the sound of the tab on screen changes', () => {
    const base = createInitialState({ now: 1, newId: () => 'x' })
    const keys = new Set(['silent', 'audible', 'muted'].map((sound) => menuKey(base, [], { ...NO_FACTS, sound: sound as 'silent' })))
    expect(keys.size).toBe(3)
  })
})

describe('menuKey: the folder of the tab on screen', () => {
  it('changes when the tab is put in a folder and when that folder is folded, so the entry says Replier then Déplier', () => {
    let state = run(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' })
    const tab = state.tabs[0]!
    const before = menuKey(state, [])
    state = run(state, { type: 'tab/pin', id: tab.id }, { type: 'folder/create', name: 'Travail' })
    const folder = state.folders[0]!
    state = run(state, { type: 'tab/move', id: tab.id, toIndex: 0, pinned: true, folderId: folder.id })
    const inFolder = menuKey(state, [])
    state = run(state, { type: 'folder/toggle', id: folder.id })
    const folded = menuKey(state, [])
    expect(new Set([before, inFolder, folded]).size).toBe(3)
    expect(state.folders[0]!.collapsed).toBe(true)
  })
})

describe('menuKey: mode compact and the tab tree', () => {
  const base = run(createInitialState(ctx), { type: 'tab/open', url: 'https://a.fr/' })
  const key = (state = base) => menuKey(state, [])

  it('is the key of a browser that has neither function, until one is switched on', () => {
    const plain = key()
    expect(plain).not.toContain('compact')
    expect(plain).not.toContain('tree')
    expect(key(run(base, { type: 'settings/update', patch: { compactMode: true } }))).not.toBe(plain)
    expect(key(run(base, { type: 'settings/update', patch: { tabTree: true } }))).not.toBe(plain)
    expect(key(run(run(base, { type: 'settings/update', patch: { compactMode: true } }), { type: 'settings/update', patch: { compactMode: false } }))).toBe(plain)
  })

  it('follows the wording of the compact entry: the bars it hides are in the key', () => {
    const on = run(base, { type: 'settings/update', patch: { compactMode: true } })
    expect(key(run(on, { type: 'compact/toggle' }))).not.toBe(key(on))
  })

  it('follows what the tab on screen has in the tree: a parent, children, a folded branch', () => {
    const on = run(base, { type: 'settings/update', patch: { tabTree: true } })
    const parent = on.tabs[0]!
    const withChild = run(on, { type: 'tab/open', url: 'https://b.fr/', parentId: parent.id })
    const keys = new Set([key(on)])
    const onParent = run(withChild, { type: 'tab/select', id: parent.id })
    const variants = [key(withChild), key(onParent), key(run(onParent, { type: 'tab/tree-collapse', id: parent.id }))]
    for (const variant of variants) {
      expect(keys.has(variant)).toBe(false)
      keys.add(variant)
    }
    // A new title changes nothing.
    expect(key(run(onParent, { type: 'tab/update', id: parent.id, patch: { title: 'Autre' } }))).toBe(key(onParent))
  })
})

describe('menuKey: the language and the translation entry', () => {
  const base = createInitialState(ctx)
  const key = (patch: Record<string, unknown>) => menuKey(run(base, { type: 'settings/update', patch: patch as never }), [])
  it('changes with the language of the labels, so that the menu is rebuilt in the new one', () => {
    // The default is translated now (it follows the system): the untranslated state is the one to compare with.
    const seen = new Set([key({ interfaceTranslated: false }), key({ interfaceTranslated: true }), key({ interfaceTranslated: true, language: 'en' }), key({ interfaceTranslated: true, language: 'fr' })])
    expect(seen.size).toBe(4)
  })

  it('changes when the entry "Traduire cette page…" comes or goes', () => {
    expect(key({ translateLocal: true })).not.toBe(key({ translateLocal: false }))
  })
})
