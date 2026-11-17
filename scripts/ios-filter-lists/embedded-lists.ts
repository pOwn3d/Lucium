// The filter lists the iOS application carries, and the registry that says where each one comes from (docs/ios.md, section 6.5).
//
// The lists are converted when a build is prepared (scripts/ios-filter-lists.mjs) and embedded in the application: nothing is downloaded on the
// phone, and they are updated with the application only. They are not ours: each keeps its licence, and the application shows, for every
// list, its title, its author, its licence, the address of its source and the date of the copy. This file builds that registry from the same
// catalogue the Mac reads (src/shared/filter-lists.ts, so the mentions are not written twice) and refuses an incomplete one: a list without a
// licence or a source address is never written.
//
// Pure: the converted rules come in, files and registry go out. Loaded by Node with type stripping: no enum, no parameter property.

import { createHash } from 'node:crypto'
// The converter (abp-to-webkit.ts) is imported for its types only: a module Node loads by itself cannot import a sibling without its extension.
import type { ConvertedList, ListStats } from './abp-to-webkit'

/**
 * The lists of the Mac's catalogue that the iOS application embeds: EasyList, EasyPrivacy and the uBlock filters (the decision of 17 November
 * 2026, docs/ios.md section 15, point 2), and the cookie-banner lists the Mac reads next to them. AdGuard's French list is in the Mac's catalogue
 * and not here: the decision does not name it, and its licence (GPL-3.0, over a CC BY-SA list it takes in) is the least clear of the catalogue.
 * Adding it is one line, and its entry in docs/licences-tierces.md is already there.
 */
export const EMBEDDED_LIST_IDS: readonly string[] = [
  'easylist',
  'easyprivacy',
  'ublock-filters',
  'ublock-badware',
  'ublock-privacy',
  'ublock-unbreak',
  'ublock-quick-fixes',
  'easylist-cookie',
  'ublock-cookies'
]

/** A text in both languages of the application. */
export interface Localized {
  en: string
  fr: string
}

/** What the catalogue says about a list (src/shared/filter-lists.ts), in both languages. */
export interface ListSource {
  id: string
  title: Localized
  category: 'ads' | 'cookies'
  author: Localized
  license: Localized
  licenseUrl: string
  homepage: string
  sourceUrl: string
}

/**
 * `network` and `cosmetic` are files of WebKit rules (compiled by the application); `scriptlets` is the table of the calls the list names for
 * sites (scriptlets.ts), read by the application's page guard: its `rules` are calls, and WebKit never sees it.
 */
export type FileKind = 'network' | 'cosmetic' | 'scriptlets'

export interface RegistryFile {
  /** The file name in the application, `<id>.<kind>.json`. */
  name: string
  kind: FileKind
  rules: number
  /** SHA-256 of the file, hex: the application names its compiled list after it, so a new copy replaces the old one. */
  sha256: string
}

export interface RegistryList extends ListSource {
  /** The copy: when it was fetched (an ISO date and time, UTC) and the version the list says of itself, when it says one. */
  fetchedAt: string
  sourceVersion: string | null
  sourceSha256: string
  /** What the conversion left out, by reason: the registry keeps it so that a smaller list is visible. */
  filters: number
  dropped: Record<string, number>
  files: RegistryFile[]
}

export interface Registry {
  schema: 1
  generatedAt: string
  lists: RegistryList[]
}

export interface ListInput {
  source: ListSource
  /** The text of the list as it was fetched. */
  text: string
  fetchedAt: string
  converted: ConvertedList
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const HEX_64 = /^[0-9a-f]{64}$/

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The version a list gives of itself in its header (`! Version:`, `! Last modified:`, `! TimeUpdated:`), or null. */
export function sourceVersionOf(text: string): string | null {
  for (const line of text.split('\n', 40)) {
    const match = /^!\s*(?:Version|Last modified|TimeUpdated)\s*:\s*(.+?)\s*$/i.exec(line)
    if (match) return match[1]!.slice(0, 80)
  }
  return null
}

/** What is wrong with a registry, in sentences; empty when it is complete. Read before anything is written, and by the tests of the application's side. */
export function registryProblems(registry: Registry, ruleLimit: number): string[] {
  const problems: string[] = []
  if (registry.schema !== 1) problems.push(`schema ${String(registry.schema)} is not 1`)
  if (!ISO_DATE.test(registry.generatedAt)) problems.push('generatedAt is not an ISO date')
  if (registry.lists.length === 0) problems.push('no list')
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const list of registry.lists) {
    const at = `list ${list.id || '(no id)'}`
    if (!/^[a-z0-9-]+$/.test(list.id)) problems.push(`${at}: the id is not a name`)
    if (ids.has(list.id)) problems.push(`${at}: twice`)
    ids.add(list.id)
    for (const field of ['title', 'author', 'license'] as const) {
      for (const language of ['en', 'fr'] as const) {
        if (typeof list[field]?.[language] !== 'string' || list[field][language].trim() === '') problems.push(`${at}: no ${field} in ${language}`)
      }
    }
    // The attribution a licence asks for: where the list comes from and under what terms. Without them the list is not embedded.
    for (const field of ['licenseUrl', 'homepage', 'sourceUrl'] as const) {
      if (!/^https:\/\/[^\s]+$/.test(list[field] ?? '')) problems.push(`${at}: ${field} is not an https address`)
    }
    if (!ISO_DATE.test(list.fetchedAt)) problems.push(`${at}: fetchedAt is not an ISO date`)
    if (!HEX_64.test(list.sourceSha256)) problems.push(`${at}: sourceSha256 is not a SHA-256`)
    if (list.files.length === 0) problems.push(`${at}: no file`)
    for (const file of list.files) {
      if (file.name !== `${list.id}.${file.kind}.json`) problems.push(`${at}: the file ${file.name} is not named after its list and kind`)
      if (names.has(file.name)) problems.push(`${at}: the file ${file.name} twice`)
      names.add(file.name)
      if (!Number.isInteger(file.rules) || file.rules < 1 || file.rules > ruleLimit) problems.push(`${at}: ${file.name} has ${file.rules} rules, WebKit takes 1 to ${ruleLimit}`)
      if (!HEX_64.test(file.sha256)) problems.push(`${at}: ${file.name} has no SHA-256`)
    }
  }
  return problems
}

export interface Embedded {
  /** File name → content, for `registry.json` and every list file. */
  files: Record<string, string>
  registry: Registry
}

/** The registry file, in the application. */
export const REGISTRY_FILE = 'filter-lists-registry.json'

/** The files of the lists and their registry. Throws, with every problem, when the registry would be incomplete: nothing is half-written. */
export function buildEmbedded(inputs: readonly ListInput[], generatedAt: string, ruleLimit: number): Embedded {
  const files: Record<string, string> = {}
  const lists: RegistryList[] = inputs.map(({ source, text, fetchedAt, converted }) => {
    const entries: RegistryFile[] = []
    for (const kind of ['network', 'cosmetic'] as const) {
      const rules = converted[kind]
      // An empty list is not a list WebKit takes: the shield alone counts as one rule, a file with none is not written.
      if (rules.length === 0) continue
      const name = `${source.id}.${kind}.json`
      // Compact, as `serializeRules` of the converter writes it.
      const json = JSON.stringify(rules)
      files[name] = json
      entries.push({ name, kind, rules: rules.length, sha256: sha256(json) })
    }
    if (converted.scriptlets.calls > 0) {
      const name = `${source.id}.scriptlets.json`
      // The format the application reads (ScriptletTable.swift): a schema, then site → calls, each `[id, args]` or `[id, args, unlessSites]`.
      const json = JSON.stringify({ schema: 1, domains: converted.scriptlets.domains })
      files[name] = json
      entries.push({ name, kind: 'scriptlets', rules: converted.scriptlets.calls, sha256: sha256(json) })
    }
    const stats: ListStats = converted.stats
    return { ...source, fetchedAt, sourceVersion: sourceVersionOf(text), sourceSha256: sha256(text), filters: stats.filters, dropped: stats.dropped, files: entries }
  })
  const registry: Registry = { schema: 1, generatedAt, lists }
  const problems = registryProblems(registry, ruleLimit)
  if (problems.length > 0) throw new Error(`the registry of the filter lists is incomplete:\n- ${problems.join('\n- ')}`)
  files[REGISTRY_FILE] = `${JSON.stringify(registry, null, 2)}\n`
  return { files, registry }
}

// ---------- the proof list ----------

/** The list the tests of the application play against real pages (fixtures/proof.txt): its mentions are made up, its dates are fixed so that the files stay the same. */
export const FIXTURE_SOURCE: ListSource = {
  id: 'proof',
  title: { en: 'Lucium proof list', fr: 'Liste d’essai de Lucium' },
  category: 'ads',
  author: { en: 'The Lucium project', fr: 'Le projet Lucium' },
  license: { en: 'GPL-3.0-or-later', fr: 'GPL-3.0-or-later' },
  licenseUrl: 'https://www.gnu.org/licenses/gpl-3.0.html',
  homepage: 'https://github.com/pOwn3d/Lucium',
  sourceUrl: 'https://github.com/pOwn3d/Lucium/blob/main/scripts/ios-filter-lists/fixtures/proof.txt'
}

const FIXTURE_DATE = '2026-11-17T12:00:00Z'

/**
 * The proof list as a folder of embedded lists in miniature: `ios/LuciumTests/Fixtures/` holds the registry and the two files of rules, read by
 * the application's own code (`EmbeddedLists`) in its tests. File name → content.
 */
export function fixtureFiles(converted: ConvertedList, text: string, ruleLimit: number): Record<string, string> {
  return buildEmbedded([{ source: FIXTURE_SOURCE, text, fetchedAt: FIXTURE_DATE, converted }], FIXTURE_DATE, ruleLimit).files
}
