import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { convertNetscapeBookmarks } from '../../src/main/importers/netscape'
import { setLanguage } from '../../src/shared/i18n'
import { notesContext, notesInScope, notesSections, openingNotesScope, parseNotesFile } from '../../src/shared/notes'
import { SIDEBAR_WIDTH_DEFAULT } from '../../src/shared/model'
import { coverShare } from '../../src/shared/space-media'
import { savedStateOf } from '../../src/shared/sidebar-state'
import { PROTECTION_OF_NEW_PROFILES } from '../../src/shared/model-defaults'
import { PRESETS, presetOf } from '../../src/shared/settings-presets'
import { cleanFaviconUrl } from '../../src/shared/state-clean'
import { usableSession } from '../../src/shared/window-session'
import { communityUrl } from './community'
import {
  BOOKMARK_FOLDERS,
  BOOKMARK_LINKS,
  DEMO_EXTENSIONS,
  DEMO_KEYWORD,
  FAVORITES,
  FRAMING_VIDEO,
  GROUPS_WORKER,
  NOTES_PAGE,
  NOTES_PANEL_REQUEST,
  PAGES,
  SITE_TABS,
  SPACES,
  VAULT_LOGINS,
  VAULT_PAGE,
  bookmarkLink,
  bookmarksFile,
  bookmarksPath,
  demoNotes,
  demoSettings,
  demoState,
  demoWindows,
  extensionIcon,
  extensionManifest,
  faviconUri,
  pageAt,
  pageDef,
  pageUrl,
  spaceId,
  tabId,
  tabPage
} from './demo'
import { browserNamesIn } from './names'
import { LANGS } from './shots'

const NOW = Date.UTC(2026, 10, 4, 10, 0, 0)

describe('the demonstration state', () => {
  it('is read back by the application whole: three spaces, every tab in its folder, the favourites, the selection', () => {
    for (const lang of LANGS) {
      const written = demoState(lang, 'dark', NOW)
      const read = savedStateOf(JSON.parse(JSON.stringify(written)))
      expect(read.spaces.map((s) => s.id)).toEqual(written.spaces.map((s) => s.id))
      expect(read.tabs.map((t) => [t.id, t.pinned, t.folderId ?? null, t.title])).toEqual(written.tabs.map((t) => [t.id, t.pinned, t.folderId ?? null, t.title]))
      expect(read.folders.map((f) => [f.id, f.name, f.collapsed])).toEqual(written.folders.map((f) => [f.id, f.name, f.collapsed]))
      expect(read.favorites.map((f) => f.url)).toEqual(written.favorites.map((f) => f.url))
      expect(read.activeSpaceId).toBe(spaceId('work'))
      expect(read.activeTabBySpace[spaceId('home')]).toBe(tabId('home', 'recipes'))
      // The pages of pages.ts carry their icon; the page of the site gives its own when it loads.
      for (const tab of read.tabs) expect(tab.faviconUrl !== undefined, tab.id).toBe(!SITE_TABS.some((site) => tabId('projects', site.key) === tab.id))
    }
  })

  it('has the protection a new profile starts with, « Renforcée », once read as the application reads its state file', () => {
    const read = savedStateOf(JSON.parse(JSON.stringify(demoState('fr', 'light', NOW))))
    expect(read.settings).toMatchObject(PROTECTION_OF_NEW_PROFILES)
    // Its baseline too: without it the file would be a profile of before, and the Settings would mark the protection as changed.
    expect(read.settings.protectionBaseline).toBe('renforcee')
    expect(presetOf(PRESETS.protection, read.settings)).toBe('renforcee')
  })

  it('sets the language and the theme with the application’s own settings', () => {
    const read = savedStateOf(JSON.parse(JSON.stringify(demoState('en', 'dark', NOW))))
    expect(read.settings).toMatchObject({ interfaceTranslated: true, language: 'en', interfaceAppearance: 'dark', firstLaunchDone: true, warnBeforeQuitting: false, searchSuggestions: false })
    expect(demoSettings('fr', 'light')).toMatchObject({ language: 'fr', interfaceAppearance: 'light' })
  })

  it('names the spaces in each language and gives each its own colours', () => {
    expect(demoState('fr', 'light', NOW).spaces.map((s) => s.name)).toEqual(['Travail', 'Maison', 'Projets'])
    expect(demoState('en', 'light', NOW).spaces.map((s) => s.name)).toEqual(['Work', 'Home', 'Projects'])
    const colours = SPACES.map((s) => s.colors.join())
    expect(new Set(colours).size).toBe(SPACES.length)
    for (const space of demoState('fr', 'light', NOW).spaces) expect(space.theme.appearance).toBe('auto')
  })

  it('has pinned tabs, folders and tabs of the day in the space on screen, and a few favourites', () => {
    const state = demoState('fr', 'light', NOW)
    const work = state.tabs.filter((t) => t.spaceId === spaceId('work'))
    expect(work.filter((t) => t.pinned && !t.folderId).length).toBeGreaterThanOrEqual(2)
    expect(work.filter((t) => t.folderId).length).toBeGreaterThanOrEqual(2)
    expect(work.filter((t) => !t.pinned).length).toBeGreaterThanOrEqual(2)
    expect(state.favorites.map((f) => f.title)).toHaveLength(FAVORITES.length)
  })

  it('keeps the space Travail of the captures already on the site, and gives Projets the pages of the film’s mosaic and the site', () => {
    const state = demoState('fr', 'light', NOW)
    expect(state.tabs.filter((t) => t.spaceId === spaceId('work')).map((t) => t.title)).toEqual([
      'Mosaïque — Tableau', 'Carnet de notes', 'Compte rendu — lundi', 'Ordre du jour — jeudi', 'Guide de style', 'Glossaire du projet', 'Météo de la semaine', 'Bien nommer ses fichiers'
    ])
    expect(state.tabs.filter((t) => t.spaceId === spaceId('projects') && !t.pinned).map((t) => t.url)).toEqual([pageUrl('maps', 'fr'), pageUrl('report', 'fr'), communityUrl('fr')])
  })

  it('leaves out the tabs it is asked to: the Community page when no checkout of the site is at hand', () => {
    const state = demoState('en', 'light', NOW, { leaveOut: ['community'] })
    expect(state.tabs.some((t) => t.url === communityUrl('en'))).toBe(false)
    expect(state.tabs).toHaveLength(demoState('en', 'light', NOW).tabs.length - 1)
  })

  it('was used a moment ago, so that nothing of it is archived as left idle', () => {
    for (const tab of demoState('fr', 'light', NOW).tabs) {
      expect(tab.lastActiveAt).toBeLessThan(NOW)
      expect(NOW - tab.lastActiveAt).toBeLessThan(3_600_000)
    }
  })
})

describe('the pages', () => {
  it('have one address each, under the reserved domain, distinct across the two languages', () => {
    const addresses = LANGS.flatMap((lang) => PAGES.map((p) => pageUrl(p.key, lang)))
    expect(new Set(addresses).size).toBe(addresses.length)
    for (const address of addresses) expect(address).toMatch(/^https:\/\/[a-z]+\.example\/[a-z-]*(\.pdf)?$/)
    for (const lang of LANGS) for (const p of PAGES) expect(pageAt(new URL(pageUrl(p.key, lang)).host, p.path[lang], lang)?.key).toBe(p.key)
    expect(new Set(PAGES.map((p) => p.key)).size).toBe(PAGES.length)
  })

  it('are in one space at most, as is the page of the site', () => {
    const keys = SPACES.flatMap((s) => [...s.pinned, ...s.folders.flatMap((f) => f.tabs), ...s.today])
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of [...keys, ...FAVORITES]) expect(PAGES.some((p) => p.key === key) || SITE_TABS.some((t) => t.key === key), key).toBe(true)
  })

  it('give the page of the site the address and the title of the site, and the others those of pages.ts', () => {
    for (const lang of LANGS) {
      expect(tabPage('community', lang)).toEqual({ url: communityUrl(lang), title: lang === 'fr' ? 'Communauté — proposer et voter' : 'Community — suggest and vote' })
      expect(tabPage('notes', lang)).toEqual({ url: pageUrl('notes', lang), title: pageDef('notes').title[lang], faviconUrl: faviconUri(pageDef('notes')) })
    }
    expect(() => tabPage('nowhere', 'fr')).toThrow(/page de démonstration inconnue/)
  })

  it('have a small SVG icon the state keeps', () => {
    for (const p of PAGES) {
      const uri = faviconUri(p)
      expect(uri.startsWith('data:image/svg+xml,')).toBe(true)
      expect(uri.length).toBeLessThan(4096)
      expect(cleanFaviconUrl(uri)).toBe(uri)
    }
  })
})

describe('the place of the window', () => {
  it('is read back by the application as the place of its main window', () => {
    const bounds = { x: 36, y: 60, width: 1440, height: 900 }
    const state = savedStateOf(JSON.parse(JSON.stringify(demoState('fr', 'light', NOW))))
    expect(usableSession(demoWindows(bounds), [{ x: 0, y: 37, width: 1512, height: 945 }], state).main).toEqual(bounds)
  })
})

describe('the bookmarks file of the import', () => {
  const ctx = { now: NOW, newId: (() => { let n = 0; return () => `id-${n++}` })() }

  it('gives the import, read by the application’s own reader, one space of twelve bookmarks in three folders, all under the demonstration domain', () => {
    for (const lang of LANGS) {
      setLanguage(lang)
      const result = convertNetscapeBookmarks(bookmarksFile(lang).html, ctx, undefined, 'html')
      expect(result.spaces.map((s) => s.name)).toEqual([lang === 'fr' ? 'Signets importés' : 'Imported bookmarks'])
      expect(result.report).toMatchObject({ tabs: 12, folders: 3, skipped: 0, overLimit: 0 })
      expect(result.folders.map((f) => f.name)).toEqual(BOOKMARK_FOLDERS.map((f) => f.title[lang]))
      expect(result.tabs.every((t) => new URL(t.url).hostname.endsWith('.example'))).toBe(true)
      expect(result.tabs.filter((t) => t.folderId === undefined).map((t) => t.title)).toEqual(BOOKMARK_LINKS.map((link) => bookmarkLink(link, lang).title))
    }
    setLanguage('fr')
  })

  it('names no browser, in its text or its name, and holds no pinned tab of the demonstration (the preview would say « déjà épinglé »)', () => {
    for (const lang of LANGS) {
      const file = bookmarksFile(lang)
      expect(browserNamesIn(`${file.name}\n${file.html}`)).toEqual([])
      const pinned = new Set(demoState(lang, 'light', NOW).tabs.filter((t) => t.pinned).map((t) => t.url))
      const links = [...BOOKMARK_LINKS, ...BOOKMARK_FOLDERS.flatMap((f) => f.links)].map((link) => bookmarkLink(link, lang).url)
      expect(links.filter((url) => pinned.has(url))).toEqual([])
    }
  })

  it('opens first a page the local server serves: the tab `import-done` shows', () => {
    const first = BOOKMARK_LINKS[0]!
    expect('page' in first && PAGES.some((p) => p.key === first.page)).toBe(true)
  })

  it('lies in the Documents folder of the made-up home folder', () => {
    expect(bookmarksPath('/tmp/run/home-fr/', 'fr')).toBe('/tmp/run/home-fr/Documents/signets.html')
    expect(bookmarksPath('/tmp/run/home-en', 'en')).toBe('/tmp/run/home-en/Documents/bookmarks.html')
  })
})

describe('the quick notes', () => {
  it('are read back whole by the application, two about the page of the shot, one about its space, one elsewhere', () => {
    for (const lang of LANGS) {
      const { notes, dropped } = parseNotesFile(JSON.stringify(demoNotes(lang, NOW)))
      expect(dropped).toBe(0)
      expect(notes).toHaveLength(4)
      const sections = notesSections(notes, notesContext(spaceId('home'), { url: pageUrl(NOTES_PAGE, lang) }))
      expect([sections.page.length, sections.space.length, sections.others.length]).toEqual([2, 1, 1])
    }
  })
})

describe('the panel of the quick notes', () => {
  it('opens on « Toutes », so the four notes are listed in their sections (a plain request keeps to the page and lists two)', () => {
    for (const lang of LANGS) {
      const { notes } = parseNotesFile(JSON.stringify(demoNotes(lang, NOW)))
      const context = notesContext(spaceId('home'), { url: pageUrl(NOTES_PAGE, lang) })
      // Why the request names a scope: the page of the shot has notes, so the panel would open on « Cette page » alone.
      expect(openingNotesScope(notes, context)).toBe('page')
      expect(notesInScope(notes, context, 'page')).toBeLessThan(notes.length)
      const scope = openingNotesScope(notes, context, NOTES_PANEL_REQUEST.scope)
      expect(scope).toBe('all')
      expect(notesInScope(notes, context, scope)).toBe(notes.length)
    }
  })
})

describe('the video of the framing card', () => {
  const bytes = readFileSync(fileURLToPath(new URL(`./${FRAMING_VIDEO.file}`, import.meta.url)))

  it('is a WebM the application stores (the EBML header media-storage.ts checks, far under its 50 MB) and holds the size the table says', () => {
    expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
    expect(bytes.length).toBeLessThan(1_000_000)
    // The track's PixelWidth (0xB0) and PixelHeight (0xBA), each a two-byte number.
    const sized = Buffer.from([0xb0, 0x82, FRAMING_VIDEO.width >> 8, FRAMING_VIDEO.width & 0xff, 0xba, 0x82, FRAMING_VIDEO.height >> 8, FRAMING_VIDEO.height & 0xff])
    expect(bytes.includes(sized)).toBe(true)
  })

  it('is wider than the sidebar, so the frame has a part of it to choose, and landscape: the stage of the panel stops at 260 px high, and a tall video would not line up with its frame', () => {
    const share = coverShare(FRAMING_VIDEO, { width: SIDEBAR_WIDTH_DEFAULT, height: 720 })
    expect(share.x).toBeLessThan(1)
    expect(share.y).toBe(1)
    expect(FRAMING_VIDEO.width).toBeGreaterThan(FRAMING_VIDEO.height)
  })
})

describe('the logins of the vault', () => {
  it('are for pages of the demonstration, the page of the shot among them, with no two alike', () => {
    for (const lang of LANGS) {
      for (const login of VAULT_LOGINS) expect(new URL(pageUrl(login.page, lang)).hostname.endsWith('.example')).toBe(true)
      expect(new Set(VAULT_LOGINS.map((l) => `${pageUrl(l.page, lang)} ${l.username[lang]}`)).size).toBe(VAULT_LOGINS.length)
    }
    expect(VAULT_LOGINS.map((l) => l.page)).toContain(VAULT_PAGE)
  })
})

describe('the demonstration extension', () => {
  it('is a manifest of version 3 with a name, a description and an icon, and asks for nothing', () => {
    for (const lang of LANGS) {
      const manifest = extensionManifest(lang) as Record<string, unknown>
      expect(manifest).toMatchObject({ manifest_version: 3, version: '1.2.0', icons: { '128': 'icon-128.png' } })
      expect(String(manifest['name']).length).toBeGreaterThan(3)
      for (const key of ['permissions', 'host_permissions', 'background', 'content_scripts', 'action']) expect(manifest[key], key).toBeUndefined()
      expect(browserNamesIn(JSON.stringify(manifest))).toEqual([])
    }
  })

  it('has an icon of its size, opaque in the middle and transparent in the corners', () => {
    const size = 128
    const pixels = extensionIcon(size)
    expect(pixels).toHaveLength(size * size * 4)
    const alpha = (x: number, y: number) => pixels[(y * size + x) * 4 + 3]
    expect(alpha(0, 0)).toBe(0)
    expect(alpha(size - 1, size - 1)).toBe(0)
    expect(alpha(size / 2, size / 2)).toBe(255)
    // The marker crosses the middle in white.
    expect([...pixels.subarray(((size / 2) * size + size / 2) * 4, ((size / 2) * size + size / 2) * 4 + 3)]).toEqual([255, 255, 255])
  })
})

describe('the extensions of the features page', () => {
  const manifestOf = (kind: keyof typeof DEMO_EXTENSIONS, lang: 'fr' | 'en') => JSON.parse(DEMO_EXTENSIONS[kind].files(lang)['manifest.json']!) as Record<string, unknown>

  it('are manifests of version 3 under their name in each language, naming no browser, with no icon and no host permission', () => {
    for (const kind of ['keyword', 'groups'] as const) {
      for (const lang of LANGS) {
        const manifest = manifestOf(kind, lang)
        expect(manifest).toMatchObject({ manifest_version: 3, name: DEMO_EXTENSIONS[kind].name[lang] })
        for (const key of ['host_permissions', 'content_scripts', 'icons', 'action']) expect(manifest[key], `${kind} ${key}`).toBeUndefined()
        expect(browserNamesIn(JSON.stringify(manifest)), `${kind} ${lang}`).toEqual([])
      }
      expect(DEMO_EXTENSIONS[kind].name.fr).not.toBe(DEMO_EXTENSIONS[kind].name.en)
    }
  })

  it('declare a keyword and run nothing (keyword), or hold the tab groups and answer only the pages of the demonstration (groups)', () => {
    for (const lang of LANGS) {
      const keyword = manifestOf('keyword', lang)
      expect(keyword['omnibox']).toEqual({ keyword: DEMO_KEYWORD })
      for (const key of ['permissions', 'background', 'externally_connectable']) expect(keyword[key], key).toBeUndefined()
      expect(Object.keys(DEMO_EXTENSIONS.keyword.files(lang))).toEqual(['manifest.json'])
      const groups = manifestOf('groups', lang)
      expect(groups['permissions']).toEqual(['tabs', 'tabGroups'])
      expect(groups['background']).toEqual({ service_worker: 'worker.js' })
      const matches = (groups['externally_connectable'] as { matches: string[] }).matches
      expect(matches.every((pattern) => /^https:\/\/[a-z-]+\.example\/\*$/.test(pattern))).toBe(true)
      for (const def of PAGES) expect(matches, def.key).toContain(`https://${def.host[lang]}.example/*`)
      expect(DEMO_EXTENSIONS.groups.files(lang)['worker.js']).toBe(GROUPS_WORKER)
    }
  })

  describe('the worker of the groups', () => {
    type Reply = { ok: boolean; groupId?: number; error?: string }
    /** The worker run against a stand-in of the API: the tabs it finds, and what it was asked to do. */
    function worker(tabs: Array<{ id: number; url: string }>, failGroup = false) {
      const calls: unknown[][] = []
      let listener: ((message: unknown, sender: unknown, reply: (answer: Reply) => void) => boolean) | null = null
      const chrome = {
        runtime: { onMessageExternal: { addListener: (fn: typeof listener) => (listener = fn) } },
        tabs: {
          query: async () => tabs,
          group: async (options: unknown) => {
            calls.push(['group', options])
            if (failGroup) throw new Error('no such window')
            return 7
          }
        },
        tabGroups: { update: async (id: number, options: unknown) => calls.push(['update', id, options]) }
      }
      new Function('chrome', GROUPS_WORKER)(chrome)
      const ask = (message: unknown) =>
        new Promise<Reply | 'ignored'>((resolve) => {
          if (listener?.(message, {}, resolve) !== true) resolve('ignored')
        })
      return { calls, ask }
    }
    const tabs = [
      { id: 3, url: 'https://meteo.example/semaine' },
      { id: 5, url: 'https://carnet.example/' },
      { id: 9, url: 'https://lecture.example/bien-nommer-ses-fichiers' }
    ]

    it('groups the tabs at the addresses asked for, in that order, and gives the group its title', async () => {
      const { calls, ask } = worker(tabs)
      expect(await ask({ kind: 'group', urls: ['https://meteo.example/semaine', 'https://lecture.example/bien-nommer-ses-fichiers'], title: 'Cette semaine' })).toEqual({ ok: true, groupId: 7 })
      expect(calls).toEqual([
        ['group', { tabIds: [3, 9] }],
        ['update', 7, { title: 'Cette semaine', color: 'blue' }]
      ])
    })

    it('makes no group when a tab is missing, and says which, nor when the API refuses', async () => {
      const missing = worker(tabs)
      const answer = await missing.ask({ kind: 'group', urls: ['https://meteo.example/semaine', 'https://ailleurs.example/'], title: 'Cette semaine' })
      expect(answer).toMatchObject({ ok: false, error: expect.stringContaining('https://ailleurs.example/') })
      expect(missing.calls).toEqual([])
      const refused = worker(tabs, true)
      expect(await refused.ask({ kind: 'group', urls: ['https://carnet.example/'], title: 'Notes' })).toEqual({ ok: false, error: 'no such window' })
    })

    it('answers nothing that is not a request for a group', async () => {
      const { calls, ask } = worker(tabs)
      for (const message of [null, 'group', { kind: 'other', urls: [], title: 'x' }, { kind: 'group', urls: 'https://carnet.example/', title: 'x' }, { kind: 'group', urls: [], title: 3 }]) expect(await ask(message)).toBe('ignored')
      expect(calls).toEqual([])
    })
  })
})
