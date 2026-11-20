// The iOS application (ios/) re-implements a few pure rules of the Mac in Swift. The two sides are held together by shared vectors
// (ios/Contracts/*.json): this suite runs them against the Mac's code, the Swift tests run the same file against theirs.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bookmarkKey, filterBookmarks, isBookmarkUrl } from './bookmarks'
import { contrastRatio } from './contrast'
import { BOOKMARKS_LIMIT, BOOKMARK_TITLE_MAX, BOOKMARK_URL_MAX, READ_LATER_LIMIT, READ_LATER_TITLE_MAX, READ_LATER_URL_MAX, type Bookmark } from './model'
import { filterReadLater } from './read-later'
import { LOCKED_SPACES_MAX } from './lock'
import { isProfileId, newProfileId, PRIVATE_PROFILE_ID } from './profiles'
import { cleanTheme, themeFromHue, themeHue, type SpaceTheme } from './theme'
import { READY_THEMES, readyThemeOf } from './theme-presets'
import { hostOf, resolveInput } from './url'
import { isYouTubePage } from './youtube-rules'

interface Vectors {
  searchTemplate: string
  resolve: { input: string; expect: { kind: 'url' | 'search'; url: string } | null }[]
  host: { input: string; expect: string }[]
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/address-vectors.json'), 'utf8')) as Vectors

describe('iOS contract: address vectors', () => {
  it('has vectors to run (an empty file would pass for nothing)', () => {
    expect(vectors.resolve.length).toBeGreaterThan(10)
    expect(vectors.host.length).toBeGreaterThan(3)
  })

  it.each(vectors.resolve)('resolveInput($input)', ({ input, expect: expected }) => {
    expect(resolveInput(input, vectors.searchTemplate)).toEqual(expected)
  })

  it.each(vectors.host)('hostOf($input)', ({ input, expect: expected }) => {
    expect(hostOf(input)).toBe(expected)
  })
})

// Spaces and profiles: what the iPhone writes when a person makes a space or a profile has to be what the Mac would have written.
interface ThemeVectors {
  theme: { hue: number; saturation?: number; baseColors: string[]; themeHue: number }[]
  newProfileId: { name: string; existing: string[]; expect: string }[]
  profileId: { id: string; valid: boolean }[]
  contrast: { foreground: string; background: string; ratio: number }[]
}

const themeVectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/theme-vectors.json'), 'utf8')) as ThemeVectors

describe('iOS contract: spaces and profiles', () => {
  it('has vectors to run', () => {
    expect(themeVectors.theme.length).toBeGreaterThan(10)
    expect(themeVectors.newProfileId.length).toBeGreaterThan(5)
    expect(themeVectors.profileId.length).toBeGreaterThan(5)
  })

  it.each(themeVectors.theme)('themeFromHue($hue, $saturation)', ({ hue, saturation, baseColors, themeHue: expectedHue }) => {
    const theme = themeFromHue(hue, saturation)
    expect(theme.baseColors).toEqual(baseColors)
    expect(themeHue(theme)).toBe(expectedHue)
  })

  // The Swift side adds the id of the private window to the taken ones (`reservedProfileId`), as `takenProfileIds` does here.
  it.each(themeVectors.newProfileId)('newProfileId($name, $existing)', ({ name, existing, expect: expected }) => {
    expect(newProfileId(name, [...existing, PRIVATE_PROFILE_ID])).toBe(expected)
  })

  // The tint behind the lists is held to the Mac's threshold with the same arithmetic (ios/LuciumKit TintContrast).
  it.each(themeVectors.contrast)('contrastRatio($foreground, $background)', ({ foreground, background, ratio }) => {
    expect(contrastRatio(foreground, background)).toBeCloseTo(ratio, 2)
  })

  it.each(themeVectors.profileId)('isProfileId($id) is $valid', ({ id, valid }) => {
    expect(isProfileId(id)).toBe(valid)
  })
})

// The ready themes (the "Thèmes" row of the Mac's theme editor): the iPhone offers the same twenty and writes them into `theme`, where the Mac reads
// them back as the ready theme they are (`readyThemeOf`). A theme added, removed, reordered or recoloured on the Mac fails here until the vector follows.
interface ReadyThemeVectors {
  ready: { id: string; palette: string; variant: 'dark' | 'light' | null; background: string; accent: string; theme: SpaceTheme }[]
}

const readyVectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/ready-theme-vectors.json'), 'utf8')) as ReadyThemeVectors

describe('iOS contract: ready themes', () => {
  it('lists every ready theme of the Mac, in the order of its row', () => {
    expect(readyVectors.ready.map((entry) => entry.id)).toEqual(READY_THEMES.map((entry) => entry.id))
  })

  it.each(readyVectors.ready)('$id is the theme the Mac makes', ({ id, palette, variant, background, accent, theme }) => {
    const mac = READY_THEMES.find((entry) => entry.id === id)!
    // The palette's own name is the same in every language; a variant is the word the application adds in its language.
    if (variant === null) expect(mac.name).toBe(palette)
    else expect(mac.name).toContain(palette)
    expect(mac.theme.appearance).toBe(variant ?? mac.theme.appearance)
    expect(theme).toEqual(mac.theme)
    expect(background).toBe(mac.background)
    expect(accent).toBe(mac.accent)
    // What the iPhone writes is read back by the Mac as this very ready theme.
    expect(readyThemeOf(cleanTheme(theme))?.id).toBe(id)
  })
})

interface GuardVectors {
  youtube: { input: string | null; expect: boolean }[]
}

const guardVectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/guard-vectors.json'), 'utf8')) as GuardVectors

describe('iOS contract: the pages the YouTube rules apply to', () => {
  it('has vectors to run, of both answers', () => {
    expect(guardVectors.youtube.filter((vector) => vector.expect).length).toBeGreaterThan(5)
    expect(guardVectors.youtube.filter((vector) => !vector.expect).length).toBeGreaterThan(5)
  })

  it.each(guardVectors.youtube)('isYouTubePage($input)', ({ input, expect: expected }) => {
    expect(isYouTubePage(input)).toBe(expected)
  })
})

// The string catalogue of the iOS application: the same rules as src/shared/i18n.test.ts, for a file Xcode reads.
interface StringUnit {
  state: string
  value: string
}
interface Localization {
  stringUnit?: StringUnit
  /** A count: one text per plural form (`one`, `other`), the way Xcode keeps them. */
  variations?: { plural?: Record<string, { stringUnit?: StringUnit }> }
}
interface Catalogue {
  sourceLanguage: string
  strings: Record<string, { localizations?: Record<string, Localization> }>
}

const IOS_SOURCES = join(__dirname, '../../ios/Lucium')
const catalogue = JSON.parse(readFileSync(join(IOS_SOURCES, 'Localizable.xcstrings'), 'utf8')) as Catalogue
// Dotted words of the Swift sources that are not text: the identifier of the rule list, and the labels of the queues and the tag of the keychain items of the
// synchronisation.
const NOT_TEXT = new Set(['app.lucium.builtin', 'app.lucium.sync.connection', 'app.lucium.sync.identity', 'app.lucium.sync.verify', 'app.lucium.sync.camera'])
const placeholders = (text: string): string[] => (text.match(/%(\d+\$)?(@|d|lld|f|s)/g) ?? []).sort()
/** A text of a localization: the one text, or the texts of the plural forms by form (a number is `%lld` in the catalogue and `\(n)` in the code). */
const textsOf = (localization: Localization | undefined): Record<string, StringUnit | undefined> =>
  localization?.stringUnit
    ? { text: localization.stringUnit }
    : Object.fromEntries(Object.entries(localization?.variations?.plural ?? {}).map(([form, variation]) => [form, variation.stringUnit]))

describe('iOS contract: string catalogue', () => {
  const keys = Object.keys(catalogue.strings)

  it.each(keys)('%s has a translated text in French and in English, with the same placeholders', (key) => {
    const en = textsOf(catalogue.strings[key]?.localizations?.en)
    const fr = textsOf(catalogue.strings[key]?.localizations?.fr)
    const forms = Object.keys(en)
    expect(forms.length, `${key}: English has no text`).toBeGreaterThan(0)
    // Both languages say the same forms. A count has at least `one` and `other`: the system picks the one a language needs (French reads 0 as one).
    expect(Object.keys(fr).sort(), `${key}: the forms differ`).toEqual([...forms].sort())
    if (forms.some((form) => form !== 'text')) expect(forms, `${key}: a count needs one and other`).toEqual(expect.arrayContaining(['one', 'other']))
    for (const form of forms) {
      expect(en[form]?.state, `${key}.${form}: English`).toBe('translated')
      expect(fr[form]?.state, `${key}.${form}: French`).toBe('translated')
      expect(en[form]?.value.trim(), `${key}.${form}: English is empty`).toBeTruthy()
      expect(fr[form]?.value.trim(), `${key}.${form}: French is empty`).toBeTruthy()
      expect(placeholders(fr[form]!.value), `${key}.${form}: placeholders differ`).toEqual(placeholders(en[form]!.value))
    }
    // French is not English left in place (one form of a count may be the same word: "%lld" alone would be; the whole key is what is compared).
    expect(forms.some((form) => fr[form]!.value !== en[form]!.value), `${key}: the French text is the English one`).toBe(true)
  })

  it('has no key the code does not read, and the code reads no key that is missing', () => {
    const swift = readdirSync(IOS_SOURCES)
      .filter((name) => name.endsWith('.swift'))
      .map((name) => readFileSync(join(IOS_SOURCES, name), 'utf8'))
      .join('\n')
    // A key is a dotted lowercase word ("bar.back"); an interpolation in it ("bar.space.of \(name)") is "%@" in the catalogue.
    const used = new Set(
      [...swift.matchAll(/"([a-z]+(?:\.[a-z-]+)+(?: \\\([^)]*\))*)"/g)].map((m) => m[1]!.replace(/\\\([^)]*\)/g, '%@')).filter((key) => !NOT_TEXT.has(key))
    )
    // The code writes a number as `\(n)`, which the catalogue keeps as `%lld`: both are one placeholder here.
    const known = new Set(keys.map((key) => key.replace(/%lld/g, '%@')))
    expect([...used].filter((key) => !known.has(key)).sort()).toEqual([])
    expect([...known].filter((key) => !used.has(key)).sort()).toEqual([])
  })

  it('writes no colour of its own in the Swift sources: system colours and the asset catalogue only', () => {
    for (const name of readdirSync(IOS_SOURCES).filter((file) => file.endsWith('.swift'))) {
      const source = readFileSync(join(IOS_SOURCES, name), 'utf8')
      expect(source, name).not.toMatch(/Color\(\s*(red|white|hue)\s*:|UIColor\(\s*(red|white|hue)\s*:|#[0-9a-fA-F]{6}\b|0x[0-9a-fA-F]{6}\b/)
    }
  })
})

// The lock of the iOS application (ios/LuciumKit/Sources/LuciumKit/LockSettings.swift) follows the Mac's (src/shared/lock.ts) on the number it shares.
describe('iOS contract: lock', () => {
  it('guards at most as many spaces as the Mac does', () => {
    const swift = readFileSync(join(__dirname, '../../ios/LuciumKit/Sources/LuciumKit/LockSettings.swift'), 'utf8')
    expect(Number(swift.match(/static let maxSpaces = (\d+)/)?.[1])).toBe(LOCKED_SPACES_MAX)
  })

  it('keeps its settings out of state.json: no Swift source of the lock reads or writes the state\'s settings', () => {
    for (const name of ['LockSettings.swift', 'LockController.swift']) {
      const source = readFileSync(join(__dirname, '../../ios/LuciumKit/Sources/LuciumKit', name), 'utf8')
      expect(source, name).not.toMatch(/BrowserState|StateFile|"settings"/)
    }
  })

  it('closes every sheet and cover of the browser screen when the application locks, so that none stays over the lock screen', () => {
    const screen = readFileSync(join(IOS_SOURCES, 'BrowserScreen.swift'), 'utf8')
    const lock = readFileSync(join(IOS_SOURCES, 'BrowserModel+Lock.swift'), 'utf8')
    const closing = lock.match(/func closePresentedScreens\(\) \{([\s\S]*?)\n    \}/)?.[1] ?? ''
    // `.sheet(isPresented: $model.spacesSheetShown)`, `.fullScreenCover(isPresented: $model.tabsSheetShown)` and the one that reads `model.downloads.sheetShown`.
    const flags = [...screen.matchAll(/\.(?:sheet|fullScreenCover)\(isPresented:\s*(?:Binding\(get:\s*\{\s*)?\$?model\.([A-Za-z.]+Shown)/g)].map((m) => m[1]!)
    expect(flags.length, 'no sheet found: the pattern no longer reads BrowserScreen').toBeGreaterThanOrEqual(5)
    expect(closing, 'closePresentedScreens not found').toContain('tabsSheetShown = false')
    for (const flag of flags) expect(closing, `${flag} is presented by BrowserScreen and not closed when the application locks`).toContain(`${flag} = false`)
  })

  it('closes the iPhone\'s sidebar, the one that slides out from the left edge, when the application locks, and keeps WebKit\'s swipe back off the iPhone', () => {
    const screen = readFileSync(join(IOS_SOURCES, 'BrowserScreen.swift'), 'utf8')
    const lock = readFileSync(join(IOS_SOURCES, 'BrowserModel+Lock.swift'), 'utf8')
    const closing = lock.match(/func closePresentedScreens\(\) \{([\s\S]*?)\n    \}/)?.[1] ?? ''
    // It is not a sheet, so the check above does not see it: the screen draws it through `EdgeDrawerHost`, and the model closes it with an event.
    expect(screen, 'BrowserScreen no longer draws the sidebar of the iPhone').toContain('EdgeDrawerHost(')
    expect(closing, 'the sidebar of the iPhone stays over the lock screen').toContain('drawerEvent(.applicationLocked)')
    const sleep = readFileSync(join(IOS_SOURCES, 'TabSleep.swift'), 'utf8')
    expect(sleep, 'the left edge is the sidebar\'s on an iPhone: the swipe back of WebKit is decided by LuciumKit').toContain('allowsBackForwardNavigationGestures = EdgeDrawer.allowsWebKitBackGesture(isPhone: isPhone)')
    expect(sleep).not.toMatch(/allowsBackForwardNavigationGestures = true/)
  })

  it('carries the Face ID sentence in both languages, and in the project so that the system never stops the application at the first prompt', () => {
    const info = JSON.parse(readFileSync(join(IOS_SOURCES, 'InfoPlist.xcstrings'), 'utf8')) as Catalogue
    const entry = info.strings['NSFaceIDUsageDescription']?.localizations
    expect(entry?.en?.stringUnit?.state).toBe('translated')
    expect(entry?.fr?.stringUnit?.state).toBe('translated')
    expect(entry?.fr?.stringUnit?.value).not.toBe(entry?.en?.stringUnit?.value)
    expect(readFileSync(join(IOS_SOURCES, '../project.yml'), 'utf8')).toMatch(/INFOPLIST_KEY_NSFaceIDUsageDescription: "[^"]{10,}"/)
  })

  it('carries the camera and the local network sentences of the synchronisation in both languages and in the project, and asks for no Bonjour service', () => {
    const info = JSON.parse(readFileSync(join(IOS_SOURCES, 'InfoPlist.xcstrings'), 'utf8')) as Catalogue
    const project = readFileSync(join(IOS_SOURCES, '../project.yml'), 'utf8')
    for (const key of ['NSCameraUsageDescription', 'NSLocalNetworkUsageDescription']) {
      const entry = info.strings[key]?.localizations
      expect(entry?.en?.stringUnit?.state, `${key} in English`).toBe('translated')
      expect(entry?.fr?.stringUnit?.state, `${key} in French`).toBe('translated')
      expect(entry?.fr?.stringUnit?.value, `${key}: French is not English left in place`).not.toBe(entry?.en?.stringUnit?.value)
      expect(project, key).toMatch(new RegExp(`INFOPLIST_KEY_${key}: "[^"]{10,}"`))
    }
    // Nothing is discovered (docs/synchronisation.md section 5, [Q1]): the Mac is reached by its .local name and its last addresses.
    expect(project).not.toContain('NSBonjourServices')
    expect(readFileSync(join(IOS_SOURCES, 'Info.plist'), 'utf8')).not.toContain('NSBonjourServices')
  })
})

describe('iOS contract: icons of the project', () => {
  const read = (name: string) => readFileSync(join(IOS_SOURCES, name), 'utf8')
  const sources = readdirSync(IOS_SOURCES).filter((name) => name.endsWith('.swift'))
  const icons = join(IOS_SOURCES, 'Assets.xcassets/Icons')
  const drawn = readdirSync(icons).filter((name) => name.endsWith('.imageset'))

  it('uses no symbol of the system: the icons are the project\'s (decision of 17 November 2026)', () => {
    for (const name of sources) expect(read(name), name).not.toMatch(/systemName\s*:|Image\(systemImage|Label\([^)]*systemImage/)
  })

  it('has every icon the code names, drawn on a grid of 20 px as a template image', () => {
    const swift = sources.map(read).join('\n')
    // Two ways of naming a drawing, one folder: `icon-back` (the bar, the sheets) and `IconPlus` (the screens of the spaces, `ProjectIcon`).
    const named = [...swift.matchAll(/"(icon-[a-z-]+|Icon[A-Z][A-Za-z]+)"/g)].map((match) => match[1]!)
    expect(named.length).toBeGreaterThan(15)
    expect(new Set(named.filter((name) => !drawn.includes(`${name}.imageset`))), 'icons named and not drawn').toEqual(new Set())
    expect(drawn.map((name) => name.replace('.imageset', '')).filter((name) => !named.includes(name)), 'icons drawn and never used').toEqual([])
    for (const set of drawn) {
      const name = set.replace('.imageset', '')
      const svg = readFileSync(join(icons, set, `${name}.svg`), 'utf8')
      expect(svg, name).toContain('viewBox="0 0 20 20"')
      expect(svg, name).toMatch(/stroke-width="(1\.5|2)"/)
      const contents = JSON.parse(readFileSync(join(icons, set, 'Contents.json'), 'utf8')) as { properties?: Record<string, unknown> }
      // A template image takes the colour of the text around it: no colour is written in a drawing.
      expect(contents.properties?.['template-rendering-intent'], name).toBe('template')
      expect(contents.properties?.['preserves-vector-representation'], name).toBe(true)
    }
  })
})


// Bookmarks and the "Read later" list of the iPhone (ios/LuciumKit/Sources/LuciumKit/Keepsakes.swift) follow the Mac's rules (bookmarks.ts, read-later.ts).
describe('iOS contract: bookmarks and read later', () => {
  interface BookmarkVectors {
    keys: { input: string; expect: string }[]
    webAddresses: { input: string; expect: boolean }[]
    bookmarks: Bookmark[]
    filters: { query: string; tags: string[]; expect: string[] }[]
    readLater: { id: string; url: string; title: string }[]
    readLaterFilters: { query: string; expect: string[] }[]
  }
  const bookmarkVectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/bookmark-vectors.json'), 'utf8')) as BookmarkVectors

  it('has vectors to run', () => {
    expect(bookmarkVectors.keys.length).toBeGreaterThan(3)
    expect(bookmarkVectors.filters.length).toBeGreaterThan(8)
  })

  it.each(bookmarkVectors.keys)('bookmarkKey($input)', ({ input, expect: expected }) => {
    expect(bookmarkKey(input)).toBe(expected)
  })

  it.each(bookmarkVectors.webAddresses)('isBookmarkUrl($input)', ({ input, expect: expected }) => {
    expect(isBookmarkUrl(input)).toBe(expected)
  })

  it.each(bookmarkVectors.filters)('filterBookmarks("$query", $tags)', ({ query, tags, expect: expected }) => {
    expect(filterBookmarks(bookmarkVectors.bookmarks.map((b) => ({ ...b, addedAt: 0 })), query, tags).map((b) => b.id)).toEqual(expected)
  })

  it.each(bookmarkVectors.readLaterFilters)('filterReadLater("$query")', ({ query, expect: expected }) => {
    expect(filterReadLater(bookmarkVectors.readLater.map((i) => ({ ...i, savedAt: 0 })), query).map((i) => i.id)).toEqual(expected)
  })

  it('keeps at most as many pages, and as long titles and addresses, as the Mac does', () => {
    const swift = readFileSync(join(__dirname, '../../ios/LuciumKit/Sources/LuciumKit/Keepsakes.swift'), 'utf8')
    const number = (name: string): number => Number(swift.match(new RegExp(`static let ${name} = (\\d+)`))?.[1])
    expect(number('bookmarksLimit')).toBe(BOOKMARKS_LIMIT)
    expect(number('bookmarkTitleMax')).toBe(BOOKMARK_TITLE_MAX)
    expect(number('bookmarkUrlMax')).toBe(BOOKMARK_URL_MAX)
    expect(number('readLaterLimit')).toBe(READ_LATER_LIMIT)
    expect(number('readLaterTitleMax')).toBe(READ_LATER_TITLE_MAX)
    expect(number('readLaterUrlMax')).toBe(READ_LATER_URL_MAX)
  })
})
