import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ExtensionInfo } from './ipc'
import { defaultSettings } from './model-defaults'
import type { Settings } from './model'
import { INTERNAL_PAGE_SETTINGS, internalSnapshot, type InternalSnapshotSource } from './internal-snapshot'
import { createInitialState } from './sidebar-state'

const SECRET = 'a-name-the-page-must-never-be-told'

const extension = (id: string): ExtensionInfo => ({ id, name: `Extension ${id}`, version: '1.0', profileId: 'default', source: 'store', enabled: true }) as ExtensionInfo

/** What a window knows: the settings carry names, folders, sites and addresses of the person, and the page may read none but its own. */
function source(): InternalSnapshotSource {
  const settings = {
    ...defaultSettings(),
    extensionPaths: [`/Users/jane/${SECRET}/ext`],
    searchUrlTemplate: `https://${SECRET}.example/?q=%s`,
    profileNames: { default: 'Perso', work: SECRET },
    developerHosts: [`${SECRET}.example`],
    profiles: {
      default: { tabCaptureExtensions: ['a'.repeat(32)], downloadDir: `/Users/jane/${SECRET}`, searchUrlTemplate: `https://${SECRET}.example/?q=%s`, disabledExtensions: ['b'.repeat(32)] },
      work: { proxy: { mode: 'manual' as const, host: `${SECRET}.example`, port: 8080 } }
    } as unknown as Settings['profiles'],
    extensionDataApis: false,
    extensionTabCapture: false,
    webStoreInstall: false,
    keyBindings: { newTab: 'Cmd+K' },
    interfaceTranslated: true,
    language: 'en' as const,
    forceHighContrast: true,
    forceReduceMotion: true,
    forceReduceTransparency: true
  }
  return { state: { settings }, extensions: [extension('a'.repeat(32)), extension('b'.repeat(32))], platform: 'darwin', scrollBarsAlways: true }
}

describe('the snapshot of the Extensions page', () => {
  it('carries the extensions, the settings the page reads, and the scroll bars', () => {
    const snapshot = internalSnapshot(source(), false)
    expect(snapshot.extensions.map((e) => e.id)).toEqual(['a'.repeat(32), 'b'.repeat(32)])
    expect(snapshot.scrollBarsAlways).toBe(true)
    expect(snapshot.platform).toBe('darwin')
    const { settings } = snapshot.state
    expect(settings.extensionDataApis).toBe(false)
    expect(settings.extensionTabCapture).toBe(false)
    expect(settings.webStoreInstall).toBe(false)
    expect(settings.keyBindings).toEqual({ newTab: 'Cmd+K' })
    expect(settings.profileNames).toEqual({ default: 'Perso', work: SECRET })
    expect(settings.language).toBe('en')
    expect(settings.interfaceTranslated).toBe(true)
    expect([settings.forceHighContrast, settings.forceReduceMotion, settings.forceReduceTransparency]).toEqual([true, true, true])
  })

  it('tells of the profiles which extensions may capture the sound of a tab, and nothing else of what a profile sets', () => {
    const { settings } = internalSnapshot(source(), false).state
    expect(settings.profiles).toEqual({ default: { tabCaptureExtensions: ['a'.repeat(32)] } })
    expect(JSON.stringify(settings.profiles)).not.toContain(SECRET)
    // A copy: what the page does with it changes nothing of the window's own.
    const own = source()
    internalSnapshot(own, false).state.settings.profiles['default']!.tabCaptureExtensions!.push('c'.repeat(32))
    expect(own.state.settings.profiles['default']?.tabCaptureExtensions).toEqual(['a'.repeat(32)])
  })

  it('tells nothing else of the settings: every other one is at its default', () => {
    const { settings } = internalSnapshot(source(), false).state
    const blank = defaultSettings()
    const others = (Object.keys(blank) as Array<keyof typeof blank>).filter((key) => !(INTERNAL_PAGE_SETTINGS as readonly string[]).includes(key))
    for (const key of others) expect(settings[key], key).toEqual(blank[key])
    expect(JSON.stringify(settings)).not.toContain('/Users/jane')
  })

  it('has no tab, no address, no space of the person, no download, no peek, no toast and no life of the windows', () => {
    const snapshot = internalSnapshot(source(), false)
    expect(snapshot.state.tabs).toEqual([])
    expect(snapshot.state.favorites).toEqual([])
    expect(snapshot.state.bookmarks).toEqual([])
    expect(snapshot.state.archive).toEqual([])
    expect(snapshot.state.readLater).toEqual([])
    expect(snapshot.state.sessions).toEqual([])
    expect(snapshot.state.folders).toEqual([])
    expect(snapshot.state.sitePermissions).toEqual({})
    expect(snapshot.state.spaces).toHaveLength(1)
    expect(snapshot.state.spaces[0]).toMatchObject({ name: 'Perso', profileId: 'default' })
    expect(snapshot.runtime).toEqual({ tabs: {}, canGoBack: false, canGoForward: false })
    expect(snapshot.downloads).toEqual([])
    expect([snapshot.find, snapshot.peek, snapshot.sidePanel, snapshot.toast]).toEqual([null, null, null, null])
    expect(Object.keys(snapshot).sort()).toEqual(['downloads', 'engine', 'extensions', 'find', 'peek', 'platform', 'runtime', 'scrollBarsAlways', 'sidePanel', 'state', 'toast'])
  })

  it('tells nothing of the whole snapshot of a window it is handed (the caller gives it that one)', () => {
    const whole = {
      ...source(),
      state: {
        ...createInitialState({ now: 0, newId: () => 's1' }),
        settings: source().state.settings,
        tabs: [{ id: 't1', spaceId: 's1', url: `https://${SECRET}.example/private`, title: SECRET, pinned: false, createdAt: 0, lastActiveAt: 0 }],
        favorites: [{ id: 'f1', url: `https://${SECRET}.example/`, title: SECRET }]
      },
      runtime: { tabs: { t1: { loading: false, audible: true, muted: false, awake: true } }, canGoBack: true, canGoForward: true },
      downloads: [{ id: 'd1', filename: SECRET, url: `https://${SECRET}.example/f` }],
      toast: { id: 1, message: SECRET, durationMs: 1000 },
      peek: { url: `https://${SECRET}.example/`, title: SECRET }
    } as unknown as InternalSnapshotSource
    const text = JSON.stringify(internalSnapshot(whole, false))
    // The one place the secret may be is the name of a profile, which the page draws.
    expect(text.split(SECRET)).toHaveLength(2)
    expect(text).not.toContain('t1')
    expect(text).not.toContain('audible')
  })

  it('says nothing the person called anything: the text of the snapshot holds none of what the window knows but the extensions and the profile names', () => {
    const text = JSON.stringify(internalSnapshot(source(), false))
    // The one place the name of a profile is told is `profileNames`, which the page draws.
    expect(text.split(SECRET)).toHaveLength(2)
  })

  it('does not tell the list of the extensions while the application is locked', () => {
    const snapshot = internalSnapshot(source(), true)
    expect(snapshot.extensions).toEqual([])
    expect(internalSnapshot(source(), false).extensions).toHaveLength(2)
  })

  it('leaves the scroll bars out when the system does not always show them', () => {
    expect('scrollBarsAlways' in internalSnapshot({ ...source(), scrollBarsAlways: undefined }, false)).toBe(false)
  })

  it('is a new object each time: nothing the window changes later is in one already sent', () => {
    const one = internalSnapshot(source(), false)
    const two = internalSnapshot(source(), false)
    expect(one).not.toBe(two)
    expect(one.state.settings).not.toBe(two.state.settings)
    expect(one.state.settings.keyBindings).toEqual(two.state.settings.keyBindings)
  })

  it('names the settings the page reads: every setting ExtensionsPage.tsx reads is on the list', () => {
    const page = readFileSync(fileURLToPath(new URL('../renderer/ExtensionsPage.tsx', import.meta.url)), 'utf8')
    const read = new Set([...page.matchAll(/(?<![-\w'])settings\.([A-Za-z]+)/g)].map((match) => match[1]!))
    expect([...read].length).toBeGreaterThan(0)
    for (const key of read) expect(INTERNAL_PAGE_SETTINGS as readonly string[], `the page reads settings.${key}`).toContain(key)
    // The name of a profile is read through profileLabel(settings, id), the language and the accessibility by the document (api.ts).
    expect(page).toContain('profileLabel(settings')
    const api = readFileSync(fileURLToPath(new URL('../renderer/api.ts', import.meta.url)), 'utf8')
    expect(api).toContain('followLanguage(document.documentElement, snapshot.state.settings')
    expect(api).toContain('applyAccessibility(document.documentElement, snapshot.state.settings)')
  })
})
