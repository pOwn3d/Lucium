// The iOS application (ios/) re-implements a few pure rules of the Mac in Swift. The two sides are held together by shared vectors
// (ios/Contracts/*.json): this suite runs them against the Mac's code, the Swift tests run the same file against theirs.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOCKED_SPACES_MAX } from './lock'
import { isProfileId, newProfileId, PRIVATE_PROFILE_ID } from './profiles'
import { themeFromHue, themeHue } from './theme'
import { hostOf, resolveInput } from './url'

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

  it.each(themeVectors.profileId)('isProfileId($id) is $valid', ({ id, valid }) => {
    expect(isProfileId(id)).toBe(valid)
  })
})

// The string catalogue of the iOS application: the same rules as src/shared/i18n.test.ts, for a file Xcode reads.
interface Catalogue {
  sourceLanguage: string
  strings: Record<string, { localizations?: Record<string, { stringUnit?: { state: string; value: string } }> }>
}

const IOS_SOURCES = join(__dirname, '../../ios/Lucium')
const catalogue = JSON.parse(readFileSync(join(IOS_SOURCES, 'Localizable.xcstrings'), 'utf8')) as Catalogue
// Dotted words of the Swift sources that are not text: SF Symbol names and the identifier of the rule list.
const NOT_TEXT = new Set(['arrow.clockwise', 'chevron.backward', 'chevron.forward', 'square.on.square', 'app.lucium.builtin'])
const placeholders = (text: string): string[] => (text.match(/%(\d+\$)?(@|d|lld|f|s)/g) ?? []).sort()

describe('iOS contract: string catalogue', () => {
  const keys = Object.keys(catalogue.strings)

  it.each(keys)('%s has a translated text in French and in English, with the same placeholders', (key) => {
    const en = catalogue.strings[key]?.localizations?.en?.stringUnit
    const fr = catalogue.strings[key]?.localizations?.fr?.stringUnit
    expect(en?.state, `${key}: English`).toBe('translated')
    expect(fr?.state, `${key}: French`).toBe('translated')
    expect(en?.value.trim(), `${key}: English is empty`).toBeTruthy()
    expect(fr?.value.trim(), `${key}: French is empty`).toBeTruthy()
    expect(placeholders(fr!.value), `${key}: placeholders differ`).toEqual(placeholders(en!.value))
    // French is not English left in place.
    expect(fr!.value, `${key}: the French text is the English one`).not.toBe(en!.value)
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
    expect([...used].filter((key) => !keys.includes(key)).sort()).toEqual([])
    expect(keys.filter((key) => !used.has(key)).sort()).toEqual([])
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

  it('carries the Face ID sentence in both languages, and in the project so that the system never stops the application at the first prompt', () => {
    const info = JSON.parse(readFileSync(join(IOS_SOURCES, 'InfoPlist.xcstrings'), 'utf8')) as Catalogue
    const entry = info.strings['NSFaceIDUsageDescription']?.localizations
    expect(entry?.en?.stringUnit?.state).toBe('translated')
    expect(entry?.fr?.stringUnit?.state).toBe('translated')
    expect(entry?.fr?.stringUnit?.value).not.toBe(entry?.en?.stringUnit?.value)
    expect(readFileSync(join(IOS_SOURCES, '../project.yml'), 'utf8')).toMatch(/INFOPLIST_KEY_NSFaceIDUsageDescription: "[^"]{10,}"/)
  })
})
