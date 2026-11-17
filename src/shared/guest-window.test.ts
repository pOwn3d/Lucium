import { describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import { GUEST_INHERITED, createGuestState, guestInherited, guestLabel, guestTheme, guestWording } from './guest-window'
import { GUEST_QUERY, PRIVATE_QUERY, isGuestSurface, isPrivateSurface } from './ipc'
import { defaultSettings, type Settings } from './model'
import { PRIVATE_BACKGROUND, PRIVATE_PROFILE_ID, createPrivateState, privateAction, privateTheme, scrubPrivateState } from './private-window'
import { createInitialState, reduce, type Action } from './sidebar'
import { backgroundColors, resolveAppearance } from './theme'
import { windowEntryLabel } from './window-names'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const run = (state: ReturnType<typeof createInitialState>, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** An owner who has built a lot: every list and record of the settings filled, and tabs, favourites and an archive. */
const owner = run(createInitialState(ctx), { type: 'tab/open', url: 'https://secret.example/' }, { type: 'favorite/add', url: 'https://fav.example/', title: 'Fav' }, {
  type: 'settings/update',
  patch: {
    blockAds: true,
    blockScriptlets: true,
    reduceFingerprint: true,
    fingerprintStrict: true,
    fingerprintExceptions: ['owner-only.example'],
    searchUrlTemplate: 'https://duckduckgo.com/?q=%s',
    keyBindings: { newTab: 'CmdOrCtrl+Alt+T' },
    uiScale: 120,
    pageWatches: [{ id: 'w1', url: 'https://watched.example/', intervalMinutes: 60, lastHash: 'x', lastChecked: 0 } as never],
    siteDataRecents: ['bank.example'],
    siteSearches: [{ keyword: 'zz', name: 'Mon wiki', url: 'https://wiki.private.example/?q=%s' }],
    blockExceptions: ['private-site.example'],
    extensionPaths: ['/ext'],
    developerHosts: ['intranet.example'],
    profileNames: { work: 'Travail' },
    littleArcShortcut: false,
    guestProfile: true
  }
})

describe('createGuestState', () => {
  const guest = createGuestState(owner, ctx)

  it('has one empty space named "Invité" and nothing of the owner’s tabs, archive, favourites, Tweaks or permissions', () => {
    expect(owner.tabs.length + owner.favorites.length).toBeGreaterThan(0)
    expect(guest.spaces).toHaveLength(1)
    expect(guest.spaces[0]!.name).toBe(guestLabel())
    expect(guest.spaces[0]!.profileId).toBe(PRIVATE_PROFILE_ID)
    expect(guest.spaces[0]!.id).not.toBe(owner.spaces[0]!.id)
    expect(guest.activeSpaceId).toBe(guest.spaces[0]!.id)
    expect(guest.activeTabBySpace).toEqual({ [guest.spaces[0]!.id]: null })
    for (const key of ['tabs', 'folders', 'favorites', 'archive', 'readLater', 'readLaterFolders', 'splits', 'boosts', 'sessions'] as const) expect(guest[key], key).toEqual([])
    expect(guest.sitePermissions).toEqual({})
    expect(guest.commandBarUsage).toEqual({})
  })

  it('shows none of the lists the owner built, and no extension', () => {
    const { settings } = guest
    expect(settings.pageWatches).toEqual([])
    expect(settings.siteDataRecents).toEqual([])
    expect(settings.siteSearches).toEqual(defaultSettings().siteSearches)
    expect(settings.siteSearches.some((search) => search.keyword === 'zz')).toBe(false)
    expect(settings.blockExceptions).toEqual([])
    expect(settings.developerHosts).toEqual([])
    expect(settings.profileNames).toEqual({})
    expect(settings.extensionPaths).toEqual([])
    expect([settings.webStoreInstall, settings.webStoreUpdates]).toEqual([false, 'manual'])
  })

  it('is no private window in disguise: its own theme, which follows the system, not the private one', () => {
    expect(guestTheme()).not.toEqual(privateTheme())
    expect(guest.spaces[0]!.theme).toEqual(guestTheme())
    expect(guestTheme().appearance).toBe('auto')
    expect(resolveAppearance(guestTheme(), false)).toBe('light')
    expect(backgroundColors(guestTheme(), 'dark')).not.toContain(PRIVATE_BACKGROUND)
    expect(guest.spaces[0]!.name).not.toBe(createPrivateState(owner, ctx).spaces[0]!.name)
    expect(guest.spaces[0]!.emoji).not.toBe(createPrivateState(owner, ctx).spaces[0]!.emoji)
  })

  it('follows the owner for the protections and the look, and starts with the sidebar shown', () => {
    const hidden = createGuestState({ ...owner, settings: { ...owner.settings, sidebarVisible: false } }, ctx)
    expect(hidden.settings.sidebarVisible).toBe(true)
    expect(guest.settings.blockAds).toBe(true)
    expect(guest.settings.searchUrlTemplate).toBe('https://duckduckgo.com/?q=%s')
    expect(guest.settings.keyBindings).toEqual({ newTab: 'CmdOrCtrl+Alt+T' })
    expect(guest.settings.uiScale).toBe(120)
  })

  // The fingerprint protection and the extended rules of the blocker are read by the page guard of the window's own settings, so a guest
  // that did not follow them browsed without the protection its owner switched on. The owner's list of excepted sites is not shared.
  it('follows the fingerprint protection and the extended rules, but not the sites the owner excepted', () => {
    expect([guest.settings.blockScriptlets, guest.settings.reduceFingerprint, guest.settings.fingerprintStrict]).toEqual([true, true, true])
    expect(guest.settings.fingerprintExceptions).toEqual([])
  })

  it('does not offer a guest window to the guest, and keeps the owner’s other options at their defaults', () => {
    expect(owner.settings.guestProfile).toBe(true)
    expect(guest.settings.guestProfile).toBe(false)
    expect(guest.settings.littleArcShortcut).toBe(defaultSettings().littleArcShortcut)
  })

  // The test that fails if the guest takes the owner's settings whole (`...main.settings`) or lets a personal list into the allowlist.
  it('differs from the default settings by the allowlist and the lock on extensions alone', () => {
    const everything = Object.fromEntries(Object.keys(defaultSettings()).map((key) => [key, (owner.settings as unknown as Record<string, unknown>)[key]]))
    const differing = Object.keys(defaultSettings()).filter((key) => JSON.stringify(guest.settings[key as keyof Settings]) !== JSON.stringify((defaultSettings() as unknown as Record<string, unknown>)[key]))
    const allowed = new Set<string>([...GUEST_INHERITED, 'webStoreInstall'])
    expect(Object.keys(everything).length).toBeGreaterThan(100)
    expect(differing.filter((key) => !allowed.has(key))).toEqual([])
  })
})

describe('GUEST_INHERITED', () => {
  it('lists real settings, each once, none of them a list or a record the owner builds', () => {
    const defaults = defaultSettings() as unknown as Record<string, unknown>
    expect(new Set(GUEST_INHERITED).size).toBe(GUEST_INHERITED.length)
    for (const key of GUEST_INHERITED) {
      expect(key in defaults, key).toBe(true)
      // `keyBindings` is the one record: shortcuts, no address, no name.
      if (key !== 'keyBindings') expect(['string', 'number', 'boolean'], key).toContain(typeof defaults[key])
    }
  })

  it('is all a guest window follows: a change of any other setting of the owner changes nothing for it', () => {
    const changed = guestInherited({ ...owner.settings, pageWatches: [], siteDataRecents: ['x.example'], littleArcShortcut: false, blockAds: false })
    expect(Object.keys(changed).sort()).toEqual([...GUEST_INHERITED].sort())
    expect(changed.blockAds).toBe(false)
  })
})

describe('the rules of a private window apply to a guest window', () => {
  const guest = createGuestState(owner, ctx)

  it('refuses what would persist something (spaces, pins, favourites, Tweaks, import)', () => {
    for (const action of [{ type: 'favorite/add', url: 'https://a.example/', title: 'a' }, { type: 'space/create', name: 'x', emoji: '1' }, { type: 'boost/add', host: 'a.example' }] as unknown as Action[]) {
      expect(privateAction(action), action.type).toBeNull()
    }
  })

  it('scrubs what a tab closed there would archive', () => {
    const opened = scrubPrivateState(reduce(guest, { type: 'tab/open', url: 'https://page.example/' }, ctx))
    const closed = scrubPrivateState(reduce(opened, { type: 'tab/archive', id: opened.tabs[0]!.id }, ctx))
    expect(closed.archive).toEqual([])
  })
})

describe('the surfaces of a guest window', () => {
  it('are private surfaces that also say they are a guest’s, and a private surface alone is no guest’s', () => {
    expect(isGuestSurface(`?${PRIVATE_QUERY}=1&${GUEST_QUERY}=1`)).toBe(true)
    expect(isPrivateSurface(`?${PRIVATE_QUERY}=1&${GUEST_QUERY}=1`)).toBe(true)
    expect(isGuestSurface(`?${PRIVATE_QUERY}=1`)).toBe(false)
    // A query that says "guest" without "private" would be a window with the private rules missing: not a guest surface.
    expect(isGuestSurface(`?${GUEST_QUERY}=1`)).toBe(false)
    expect(isGuestSurface('')).toBe(false)
  })

  it('has its own name in the Window menu', () => {
    expect(windowEntryLabel({ kind: 'private', position: 2 })).toBe('Fenêtre privée')
    expect(windowEntryLabel({ kind: 'private', guest: true, position: 2 })).toBe('Fenêtre invité')
    expect(windowEntryLabel({ kind: 'private', guest: true, name: 'Pour Léa', position: 2 })).toBe('Pour Léa')
  })
})

describe('guestWording', () => {
  it('calls the window a guest’s where a notice of the private rules says private', () => {
    expect(guestWording('Les extensions ne fonctionnent pas dans une fenêtre privée.')).toBe('Les extensions ne fonctionnent pas dans une fenêtre invité.')
    expect(guestWording('Fenêtre privée')).toBe('Fenêtre invité')
    expect(guestWording('Les thèmes ne sont pas disponibles dans une fenêtre privée, ni dans les fenêtres privées.')).toBe('Les thèmes ne sont pas disponibles dans une fenêtre invité, ni dans les fenêtres invité.')
  })

  it('leaves every other notice as it is', () => {
    for (const message of ['Onglet archivé', 'Un onglet privé a été ouvert', 'Page surveillée', '']) expect(guestWording(message)).toBe(message)
  })

  it('changes the words of the language the notice is written in: English in an English interface', () => {
    setLanguage('en')
    try {
      expect(guestWording('Extensions don’t run in a private window.')).toBe('Extensions don’t run in a guest window.')
      expect(guestWording('Themes aren’t available in a private window, nor in private windows.')).toBe('Themes aren’t available in a guest window, nor in guest windows.')
      expect(guestWording('Private windows keep nothing.')).toBe('Guest windows keep nothing.')
      expect(guestLabel()).toBe('Guest')
    } finally {
      setLanguage('fr')
    }
  })
})
