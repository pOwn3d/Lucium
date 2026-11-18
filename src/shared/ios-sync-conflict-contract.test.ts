// The words of « Conflit réglé » on the two devices (docs/synchronisation.md §13.4): the Mac's catalogues (`sync-conflict.*`, i18n-fr.ts and i18n-en.ts) and the
// iPhone's (`conflict.*`, ios/Lucium/Localizable.xcstrings) say the same things, and the table of the iPhone (ios/Lucium/SyncConflictTexts.swift) leads from the
// keys the shared sentences ask for (sync-conflict-vectors.json) to the iPhone's. The built application is checked by SyncConflictScreenTests (simulator).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from './i18n-en'
import { fr } from './i18n-fr'

const root = join(__dirname, '../..')
const swift = readFileSync(join(root, 'ios/Lucium/SyncConflictTexts.swift'), 'utf8')
interface Unit { stringUnit?: { state: string; value: string } }
const catalogue = JSON.parse(readFileSync(join(root, 'ios/Lucium/Localizable.xcstrings'), 'utf8')) as {
  strings: Record<string, { localizations: Record<string, Unit & { variations?: { plural?: Record<string, Unit> } }> }>
}
const vectors = JSON.parse(readFileSync(join(root, 'ios/Contracts/sync-conflict-vectors.json'), 'utf8')) as { settle: { views: unknown[] }[] }

const table = new Map([...swift.matchAll(/^\s+"(sync-conflict\.[a-z0-9.-]+)": "(conflict\.[a-z0-9.-]+)",$/gm)].map((m) => [m[1]!, m[2]!] as const))
const mac = (catalogue: Record<string, string>): Map<string, string> => new Map(Object.entries(catalogue).filter(([key]) => key.startsWith('sync-conflict.')))
const macFr = mac(fr)
const macEn = mac(en)
/** The Mac names its words `{p1}`, `{p2}`; the iPhone reads them `%1$@`, `%2$@`. */
const forIos = (text: string): string => text.replace(/\{p(\d+)\}/g, '%$1$@').replace('{count}', '%lld')
/** The key of the iPhone for a key of the Mac: `sync-conflict.field-profile-id` is `conflict.field.profile-id` (the first hyphen after the area becomes a dot). */
const iosKeyOf = (key: string): string => {
  const rest = key.slice('sync-conflict.'.length)
  const at = rest.indexOf('-')
  return at < 0 ? `conflict.${rest}` : `conflict.${rest.slice(0, at)}.${rest.slice(at + 1)}`
}

/** The names of the two devices are proper nouns, the same in both languages: the catalogue of the iPhone refuses a text that is, so the screen writes them itself. */
const PROPER_NOUNS = ['sync-conflict.device-mac', 'sync-conflict.device-ios']

describe('iOS contract: the words of « Conflit réglé »', () => {
  const nonPlural = [...macFr.keys()].filter((key) => !key.startsWith('sync-conflict.count.') && !PROPER_NOUNS.includes(key))

  it('keeps the names of the devices out of the catalogue of the iPhone because they are the same in both languages, and has the screen write them', () => {
    for (const key of PROPER_NOUNS) expect(macFr.get(key), key).toBe(macEn.get(key))
    expect(macFr.get('sync-conflict.device-mac')).toBe('Mac')
    expect(macFr.get('sync-conflict.device-ios')).toBe('iPhone')
    expect(swift).toContain('platform == .mac ? "Mac" : "iPhone"')
    expect(Object.keys(catalogue.strings).filter((key) => key.startsWith('conflict.device'))).toEqual([])
  })


  it('has a table of the iPhone that leads from every key of the Mac to one key of the iPhone, and from nothing else', () => {
    expect([...table.keys()].sort()).toEqual([...nonPlural].sort())
    expect(new Set(table.values()).size).toBe(table.size)
    for (const [key, ios] of table) expect(ios, key).toBe(iosKeyOf(key))
  })

  it('says in both languages the same things as the Mac, word for word, with the words put at %1$@, %2$@…', () => {
    for (const [key, ios] of table) {
      const entry = catalogue.strings[ios]
      expect(entry, `${ios} is in the catalogue of the iPhone`).toBeDefined()
      expect(entry?.localizations['fr']?.stringUnit?.state, `${ios} fr`).toBe('translated')
      expect(entry?.localizations['en']?.stringUnit?.state, `${ios} en`).toBe('translated')
      expect(entry?.localizations['fr']?.stringUnit?.value, `${ios} fr`).toBe(forIos(macFr.get(key)!))
      expect(entry?.localizations['en']?.stringUnit?.value, `${ios} en`).toBe(forIos(macEn.get(key)!))
    }
  })

  it('has the count as a plural of the iPhone, one text for each form, as the Mac has', () => {
    const entry = catalogue.strings['conflict.count %lld']
    for (const [language, texts] of [['fr', macFr], ['en', macEn]] as const) {
      const plural = entry?.localizations[language]?.variations?.plural
      expect(plural?.['one']?.stringUnit?.value, language).toBe(forIos(texts.get('sync-conflict.count.one')!))
      expect(plural?.['other']?.stringUnit?.value, language).toBe(forIos(texts.get('sync-conflict.count.other')!))
    }
  })

  it('leaves no key of the area in the catalogue of the iPhone that the table does not lead to', () => {
    const known = new Set([...table.values(), 'conflict.count %lld'])
    expect(Object.keys(catalogue.strings).filter((key) => key.startsWith('conflict.') && !known.has(key))).toEqual([])
  })

  it('knows every key a sentence asks for, in the vectors both languages play and in the sheets', () => {
    const asked = new Set<string>()
    const walk = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return
      if (Array.isArray(value)) value.forEach(walk)
      else {
        const record = value as { key?: unknown; params?: unknown }
        if (typeof record.key === 'string' && record.key.startsWith('sync-conflict.')) asked.add(record.key)
        Object.values(record).forEach(walk)
      }
    }
    walk(vectors.settle.map((c) => c.views))
    expect(asked.size).toBeGreaterThan(8)
    for (const key of asked) expect(table.has(key) || PROPER_NOUNS.includes(key), `${key} is in the table of the iPhone`).toBe(true)
    // The words the screen asks for itself, which no sentence of a line carries.
    for (const key of ['title', 'subtitle', 'ok', 'compare', 'hide-compare', 'delete-everywhere', 'restore', 'kept-version', 'other-version', 'value-yes', 'value-no', 'value-none', 'value-other', 'explain-restore']) {
      expect(table.has(`sync-conflict.${key}`), key).toBe(true)
    }
  })

  it('puts as many words in a text as the Mac does, so that a text of one never takes a word the other did not give', () => {
    const count = (text: string): number => new Set(text.match(/%\d+\$@|\{p\d+\}/g) ?? []).size
    for (const [key, ios] of table) {
      for (const language of ['fr', 'en'] as const) expect(count(catalogue.strings[ios]!.localizations[language]!.stringUnit!.value), `${ios} ${language}`).toBe(count((language === 'fr' ? macFr : macEn).get(key)!))
    }
  })
})
