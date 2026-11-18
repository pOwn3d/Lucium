// The listing of the iOS application in App Store Connect (ios/AppStore/): the texts the maintainer pastes, in English and in French, and the pictures a
// script takes. App Store Connect refuses a field that is too long only when somebody saves it, and Apple's reviewers refuse a note that says something the
// app does not do: this suite holds the texts to the limits, to the rules of the project, and to the code they describe.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { browserNamesIn } from '../../scripts/site-captures/names'

const ROOT = join(__dirname, '../..')
const METADATA = join(ROOT, 'ios/AppStore/metadata')
const LOCALES = ['en-US', 'fr-FR'] as const

/**
 * The limits of App Store Connect (its page "Platform version information", read on 18 November 2026: promotional text 170 characters, description and
 * What's New 4000 characters, keywords 100 **bytes**, review notes 4000 **bytes**; name and subtitle 30 characters is the limit everyone knows, which that
 * page does not state). A file in `BYTES` is counted in UTF-8 bytes, so that an accent costs two.
 */
const LIMITS: Record<string, number> = {
  name: 30,
  subtitle: 30,
  promotional_text: 170,
  keywords: 100,
  description: 4000,
  release_notes: 4000,
  copyright: 100,
  support_url: 150,
  marketing_url: 150,
  privacy_url: 150
}

const BYTES = new Set(['keywords'])

const text = (locale: string, field: string): string => readFileSync(join(METADATA, locale, `${field}.txt`), 'utf8')
/** What App Store Connect counts: the field without the newline that ends the file. */
const field = (locale: string, name: string): string => text(locale, name).replace(/\n$/, '')
const source = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

/** Every Swift source of the application and of its package (the tests are not what ships). */
function swiftSources(): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.swift')) out.push({ path, code: source(path) })
    }
  }
  walk('ios/Lucium')
  walk('ios/LuciumKit/Sources')
  return out
}

describe('the texts of the listing', () => {
  it('are the same files in English and in French', () => {
    const files = LOCALES.map((locale) => readdirSync(join(METADATA, locale)).sort())
    expect(files[0]).toEqual(files[1])
    expect(files[0]).toEqual(expect.arrayContaining(Object.keys(LIMITS).map((name) => `${name}.txt`)))
  })

  it('are written plainly: not empty, no tab, no carriage return, one newline at the end and no blank line around', () => {
    for (const locale of LOCALES) {
      for (const file of readdirSync(join(METADATA, locale))) {
        const content = readFileSync(join(METADATA, locale, file), 'utf8')
        expect(content.trim().length, `${locale}/${file} is empty`).toBeGreaterThan(0)
        expect(content, `${locale}/${file}`).not.toMatch(/[\t\r]/)
        expect(content.endsWith('\n') && !content.endsWith('\n\n'), `${locale}/${file} must end with exactly one newline`).toBe(true)
        expect(content.startsWith('\n'), `${locale}/${file} starts with a blank line`).toBe(false)
      }
    }
  })

  it('fit the limits of App Store Connect', () => {
    for (const locale of LOCALES) {
      for (const [name, limit] of Object.entries(LIMITS)) {
        // Characters as a person counts them (an accented letter or a typographic apostrophe is one), not UTF-16 units; bytes where the store counts bytes.
        const value = field(locale, name)
        expect(BYTES.has(name) ? Buffer.byteLength(value, 'utf8') : [...value].length, `${locale}/${name}`).toBeLessThanOrEqual(limit)
      }
    }
  })

  it('make a list of keywords App Store Connect takes: commas without spaces, each word once, neither the name nor the category', () => {
    for (const locale of LOCALES) {
      const words = field(locale, 'keywords').split(',')
      expect(field(locale, 'keywords'), locale).not.toMatch(/,\s|\s,|^,|,$|,,/)
      expect(new Set(words.map((word) => word.toLowerCase())).size, `${locale}: a keyword is repeated`).toBe(words.length)
      for (const word of words) {
        expect(['lucium', 'utilities', 'utilitaires'], `${locale}: "${word}" is already the name or the category`).not.toContain(word.toLowerCase())
      }
    }
  })

  it('name no other browser, product or company the project does not speak about (the list the site and its pictures use)', () => {
    const everything = [...LOCALES.flatMap((locale) => readdirSync(join(METADATA, locale)).map((file) => text(locale, file.replace(/\.txt$/, '')))), readFileSync(join(METADATA, 'review/notes.txt'), 'utf8')]
    for (const content of everything) expect(browserNamesIn(content), content.slice(0, 40)).toEqual([])
  })

  it('give English and French of their own: the French is not the English left as it is, and it is French', () => {
    for (const name of ['subtitle', 'promotional_text', 'keywords', 'description', 'release_notes', 'support_url', 'marketing_url', 'privacy_url']) {
      expect(field('fr-FR', name), name).not.toBe(field('en-US', name))
    }
    expect(field('fr-FR', 'description')).toMatch(/[éèàç]/)
    expect(field('en-US', 'description')).not.toMatch(/[éèàç]/)
  })

  it('point to pages of the project, over https, with the privacy policy of the iOS application in each language', () => {
    for (const locale of LOCALES) {
      for (const name of ['support_url', 'marketing_url', 'privacy_url']) {
        const url = new URL(field(locale, name))
        expect([url.protocol, url.hostname], `${locale}/${name}`).toEqual(['https:', 'lucium.app'])
      }
    }
    expect(new URL(field('en-US', 'privacy_url')).pathname).toBe('/en/privacy-ios/')
    expect(new URL(field('fr-FR', 'privacy_url')).pathname).toBe('/vie-privee-ios/')
  })
})

describe('the notes for the review', () => {
  const notes = readFileSync(join(METADATA, 'review/notes.txt'), 'utf8')

  it('fit App Store Connect (4000 bytes), and say who they are for: no account, nothing to sign in to', () => {
    expect(Buffer.byteLength(notes, 'utf8')).toBeLessThanOrEqual(4000)
    expect(notes).toMatch(/no account, sign-in/i)
  })

  it('say what the code does: the one App Transport Security exception, the scripts the app brings itself, and no connection of its own', () => {
    // "Info.plist sets NSAllowsArbitraryLoadsInWebContent ... NSAllowsArbitraryLoads is not set": the file says exactly that.
    const plist = source('ios/Lucium/Info.plist')
    expect(notes).toContain('NSAllowsArbitraryLoadsInWebContent')
    expect(plist).toContain('<key>NSAllowsArbitraryLoadsInWebContent</key>')
    expect(plist).not.toContain('<key>NSAllowsArbitraryLoads</key>')
    // "Downloaded files go to the Downloads folder of the app, which shows in the Files app (UIFileSharingEnabled, LSSupportsOpeningDocumentsInPlace)".
    for (const key of ['UIFileSharingEnabled', 'LSSupportsOpeningDocumentsInPlace']) {
      expect(notes).toContain(key)
      expect(plist, key).toMatch(new RegExp(`<key>${key}</key>\\s*<true/>`))
    }
    // "no native function of the device is exposed to a web page (no script message handler)".
    expect(notes).toContain('no script message handler')
    // "The app makes no connection of its own": nothing in the sources opens one, WebKit loads the pages.
    expect(notes).toContain('The app makes no connection of its own')
    const own = /\b(?:URLSession|NWConnection|NWBrowser|NWListener|CFStream|URLSessionWebSocketTask)\b/
    const bridge = /\b(?:WKScriptMessageHandler|WKScriptMessageHandlerWithReply|addScriptMessageHandler|addScriptMessageHandlerWithReply)\b/
    for (const { path, code } of swiftSources()) {
      expect(own.test(code), `${path} opens a connection of its own, which the notes for the review deny`).toBe(false)
      expect(bridge.test(code), `${path} exposes a native function to pages, which the notes for the review deny`).toBe(false)
    }
  })

  it('say the only encryption is what iOS provides, which the Info.plist declares exempt, and no source has a cipher of its own', () => {
    // "The only encryption is what iOS provides for HTTPS (WebKit)": with the key at false, App Store Connect takes that as the answer for every build.
    expect(notes).toContain('The only encryption is what iOS provides for HTTPS (WebKit)')
    expect(source('ios/Lucium/Info.plist')).toMatch(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/)
    // CryptoKit is imported, but only for SHA-256 identifiers: a hash is not a cipher. A cipher, a symmetric key or a sealed box would make the answer false.
    const cipher = /\b(?:CCCrypt|CCCryptorCreate|SymmetricKey|AES|ChaChaPoly|SealedBox|SecKeyCreateEncryptedData|SecKeyCreateDecryptedData)\b/
    for (const { path, code } of swiftSources()) {
      expect(cipher.test(code), `${path} has a cipher of its own, which the declaration "exempt encryption" denies`).toBe(false)
    }
  })

  it('name the Face ID text the app declares, and the privacy manifest it ships', () => {
    expect(notes).toContain('LocalAuthentication')
    expect(source('ios/project.yml')).toContain('INFOPLIST_KEY_NSFaceIDUsageDescription')
    expect(notes).toContain('PrivacyInfo.xcprivacy')
    expect(existsSync(join(ROOT, 'ios/Lucium/PrivacyInfo.xcprivacy'))).toBe(true)
  })
})

describe('the pictures of the listing', () => {
  const script = source('scripts/ios-store-shots.sh')
  const readme = source('ios/AppStore/README.md')

  /** The names the test of the application draws, in the order it takes them. */
  const drawn = [...source('ios/LuciumTests/StoreScreenshotTests.swift').matchAll(/shoot\("([^"]+)"\)/g)].map((match) => match[1]!)

  it('are the ones the script waits for: the test of the application takes exactly the pictures the script collects', () => {
    const expected = /^expected=\(([^)]*)\)/m.exec(script)?.[1]?.trim().split(/\s+/) ?? []
    expect(expected.length).toBeGreaterThan(0)
    expect(drawn).toEqual(expected)
  })

  it('have the sizes App Store Connect takes for a 6.9 inch iPhone and a 13 inch iPad, and the README says them with the names of the files', () => {
    expect(script).toMatch(/iphone-6\.9:[^:]+:1320x2868/)
    expect(script).toMatch(/ipad-13:[^:]+:2064x2752/)
    for (const size of ['1320 × 2868', '2064 × 2752']) expect(readme).toContain(size)
    for (const name of drawn) expect(readme, name).toContain(name)
  })

  it('show demo data on reserved domains only: no real site is named in the pages the test draws', () => {
    const test = source('ios/LuciumTests/StoreScreenshotTests.swift')
    const hosts = [...test.matchAll(/"([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})"/g)].map((match) => match[1]!)
    expect(hosts.length).toBeGreaterThan(10)
    for (const host of hosts) expect(host, host).toMatch(/\.example$/)
  })
})
