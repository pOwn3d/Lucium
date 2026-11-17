// The privacy manifest of the iOS application (ios/Lucium/PrivacyInfo.xcprivacy) must say what the code does. App Store Connect refuses a build
// whose code calls an API of Apple's "required reason" list without declaring a reason for it, and Lucium collects nothing and tracks nobody
// (AGENTS.md, section 5): this suite reads the Swift sources and the manifest together, so that neither can drift from the other.
//
// The list below is Apple's "Describing use of required reason API" (developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api),
// read on 17 November 2026: the five categories, the APIs of each, and the reason codes a manifest may give. When Apple changes the page, change it here.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface Category {
  /** The code names of the APIs, as they are written in Swift (or in the C functions Swift can call). */
  apis: RegExp
  reasons: string[]
}

const REQUIRED_REASON_CATEGORIES: Record<string, Category> = {
  NSPrivacyAccessedAPICategoryFileTimestamp: {
    apis: /\.(creationDate|modificationDate)\b|\bfileModificationDate\b|\b(contentModificationDateKey|creationDateKey)\b|\b(NSFileCreationDate|NSFileModificationDate)\b|\b(stat|fstat|lstat|fstatat|getattrlist|getattrlistbulk|fgetattrlist|getattrlistat)\(/,
    reasons: ['DDA9.1', 'C617.1', '3B52.1', '0A2A.1']
  },
  NSPrivacyAccessedAPICategorySystemBootTime: {
    apis: /\bsystemUptime\b|\bmach_absolute_time\(/,
    reasons: ['35F9.1', '8FFB.1', '3D61.1']
  },
  NSPrivacyAccessedAPICategoryDiskSpace: {
    apis: /\b(volumeAvailableCapacityKey|volumeAvailableCapacityForImportantUsageKey|volumeAvailableCapacityForOpportunisticUsageKey|volumeTotalCapacityKey|systemFreeSize|systemSize)\b|\b(statfs|statvfs|fstatfs|fstatvfs)\(/,
    reasons: ['E174.1', '85F4.1', '7D9E.1', 'B728.1']
  },
  NSPrivacyAccessedAPICategoryActiveKeyboards: {
    apis: /\bactiveInputModes\b/,
    reasons: ['3EC4.1', '54BD.1']
  },
  NSPrivacyAccessedAPICategoryUserDefaults: {
    // `@AppStorage` is `UserDefaults` underneath.
    apis: /\b(UserDefaults|NSUserDefaults)\b|@AppStorage\b/,
    reasons: ['CA92.1', '1C8F.1', 'C56D.1', 'AC6B.1']
  }
}

/** The categories whose APIs a Swift source calls. Comments are not code: a sentence that names an API calls nothing. */
function categoriesUsedBy(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  return Object.entries(REQUIRED_REASON_CATEGORIES)
    .filter(([, category]) => category.apis.test(code))
    .map(([name]) => name)
}

// ---------- a plist, as far as a privacy manifest needs one ----------

type Plist = string | boolean | number | Plist[] | { [key: string]: Plist }

function parsePlist(xml: string): Plist {
  const stripped = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, '')
  // A tag, then the text up to the next one: `<key>a</key>` is two tokens, `<true/>` is one.
  const tokens = [...stripped.matchAll(/<(\/?)([a-zA-Z]+)(?:\s[^>]*?)?(\/?)>([^<]*)/g)]
  let at = 0
  const next = (): RegExpMatchArray => {
    const token = tokens[at++]
    if (!token) throw new Error('plist: unexpected end')
    return token
  }
  const textOf = (token: RegExpMatchArray): string => {
    const text = decode(token[4]!.trim())
    next() // the closing tag
    return text
  }
  const value = (token: RegExpMatchArray): Plist => {
    const [, closing, name, selfClosing] = token
    if (closing) throw new Error(`plist: unexpected </${name}>`)
    switch (name) {
      case 'true': return true
      case 'false': return false
      case 'string': return selfClosing ? '' : textOf(token)
      case 'integer': return Number(textOf(token))
      case 'array': {
        const items: Plist[] = []
        if (selfClosing) return items
        for (let t = next(); !(t[1] && t[2] === 'array'); t = next()) items.push(value(t))
        return items
      }
      case 'dict': {
        const entries: { [key: string]: Plist } = {}
        if (selfClosing) return entries
        for (let t = next(); !(t[1] && t[2] === 'dict'); t = next()) {
          if (t[2] !== 'key') throw new Error(`plist: expected <key>, got <${t[2]}>`)
          entries[textOf(t)] = value(next())
        }
        return entries
      }
      default: throw new Error(`plist: <${name}> is not supported`)
    }
  }
  const root = tokens.findIndex((token) => token[2] === 'plist' && !token[1])
  if (root < 0) throw new Error('plist: no <plist> element')
  at = root + 1
  return value(next())
}

const decode = (text: string): string => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

// ---------- the manifest and the sources ----------

const IOS = join(__dirname, '../../ios')
const manifest = parsePlist(readFileSync(join(IOS, 'Lucium/PrivacyInfo.xcprivacy'), 'utf8')) as Record<string, Plist>

/** The Swift sources that end up in the application: its own, and those of LuciumKit, which it links (the tests are not shipped). */
function shippedSources(): { name: string; source: string }[] {
  const folders = [join(IOS, 'Lucium'), join(IOS, 'LuciumKit/Sources/LuciumKit')]
  return folders.flatMap((folder) => readdirSync(folder).filter((name) => name.endsWith('.swift')).map((name) => ({ name, source: readFileSync(join(folder, name), 'utf8') })))
}

describe('iOS privacy manifest', () => {
  it('says that Lucium tracks nobody and collects nothing', () => {
    expect(manifest.NSPrivacyTracking).toBe(false)
    expect(manifest.NSPrivacyTrackingDomains).toEqual([])
    expect(manifest.NSPrivacyCollectedDataTypes).toEqual([])
    expect(Array.isArray(manifest.NSPrivacyAccessedAPITypes)).toBe(true)
  })

  const declared = ((manifest.NSPrivacyAccessedAPITypes ?? []) as Record<string, Plist>[]).map((entry) => ({
    category: entry.NSPrivacyAccessedAPIType as string,
    reasons: entry.NSPrivacyAccessedAPITypeReasons as string[]
  }))
  const used = new Map<string, string[]>()
  for (const { name, source } of shippedSources()) for (const category of categoriesUsedBy(source)) used.set(category, [...(used.get(category) ?? []), name])

  it('declares every category of required-reason API that the code calls', () => {
    const missing = [...used].filter(([category]) => !declared.some((entry) => entry.category === category)).map(([category, files]) => `${category} (called in ${files.join(', ')})`)
    expect(missing, 'add the category and one of its reasons to ios/Lucium/PrivacyInfo.xcprivacy').toEqual([])
  })

  it('declares only categories the code calls, each with reasons Apple allows for it', () => {
    for (const { category, reasons } of declared) {
      expect(Object.keys(REQUIRED_REASON_CATEGORIES), `${category} is not a category of Apple's list`).toContain(category)
      expect(used.has(category), `${category} is declared and no source calls it: remove it`).toBe(true)
      expect(reasons.length, `${category} has no reason`).toBeGreaterThan(0)
      for (const reason of reasons) expect(REQUIRED_REASON_CATEGORIES[category]!.reasons, `${reason} is not a reason of ${category}`).toContain(reason)
    }
  })

  it('has sources to look at (an empty folder would pass for nothing)', () => {
    expect(shippedSources().length).toBeGreaterThan(15)
  })
})

describe('the scan of the sources', () => {
  it('finds each category by one of its APIs', () => {
    expect(categoriesUsedBy('let d = UserDefaults.standard')).toEqual(['NSPrivacyAccessedAPICategoryUserDefaults'])
    expect(categoriesUsedBy('@AppStorage("x") var x = 1')).toEqual(['NSPrivacyAccessedAPICategoryUserDefaults'])
    expect(categoriesUsedBy('let m = attributes[.modificationDate]')).toEqual(['NSPrivacyAccessedAPICategoryFileTimestamp'])
    expect(categoriesUsedBy('let t = ProcessInfo.processInfo.systemUptime')).toEqual(['NSPrivacyAccessedAPICategorySystemBootTime'])
    expect(categoriesUsedBy('values.volumeAvailableCapacityForImportantUsage; let k = URLResourceKey.volumeAvailableCapacityKey')).toEqual(['NSPrivacyAccessedAPICategoryDiskSpace'])
    expect(categoriesUsedBy('let modes = UITextInputMode.activeInputModes')).toEqual(['NSPrivacyAccessedAPICategoryActiveKeyboards'])
  })

  it('does not take a comment for a call, nor the size and the type of a file for its dates', () => {
    expect(categoriesUsedBy('// UserDefaults would need a reason\n/* systemUptime */ let x = 1')).toEqual([])
    expect(categoriesUsedBy('let size = attributes[.size]; let type = attributes[.type]')).toEqual([])
  })
})

describe('the plist reader', () => {
  it('reads the manifest shapes: dictionaries, arrays, flags, strings', () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE plist><plist version="1.0"><dict><!-- c --><key>a</key><false/><key>b</key><array/><key>c</key><array><dict><key>d</key><string>x &amp; y</string><key>e</key><array><string>1</string><string>2</string></array></dict></array></dict></plist>`
    expect(parsePlist(xml)).toEqual({ a: false, b: [], c: [{ d: 'x & y', e: ['1', '2'] }] })
  })
})
