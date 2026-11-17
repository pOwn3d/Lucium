// The facultative permissions of an extension (`optional_permissions`, `optional_host_permissions`): what a manifest lets it ask for later,
// what a request (`chrome.permissions.request`) names, and what the person granted. Pure rules. A grant never goes past what the manifest
// lists as facultative, and it is read again against the manifest each time: a new version that no longer lists a permission no longer holds it.
// What is granted is added to the manifest the access rules read (`withGranted`), so every rule that reads `permissions` and
// `host_permissions` (extension-access.ts, `shimAllowed`) counts it without knowing where it came from.

import { MANIFEST_LIST_MAX, isHostEntry } from './chrome-compat'
import { accessOf, parseMatchPattern } from './extension-access'
import { addedAccess, cleanText, covers, describeAccess, NAME_MAX, type ExtensionReview, type ReviewedPermission, type SuffixTest } from './extension-review'
import { t } from './i18n'
import { isRecord } from './record'

/** The shape `chrome.permissions` speaks: names of permissions, and match patterns of sites. */
export interface PermissionSet {
  permissions: string[]
  origins: string[]
}

/** How many names and how many sites one request, or one stored grant, may hold. */
export const PERMISSION_SET_MAX = 64
const NAME_LENGTH_MAX = 60
const ORIGIN_LENGTH_MAX = 300
const INVISIBLE = /\p{Cc}|\p{Cf}/u

export const isEmptySet = (set: PermissionSet): boolean => set.permissions.length === 0 && set.origins.length === 0

/**
 * A request as an extension sent it, or a grant as it was stored: hostile input both. Null for anything that is not a list of short names
 * and a list of match patterns, a few of them: the caller refuses it whole, nothing is taken from a request that is half readable.
 */
export function readPermissionSet(raw: unknown): PermissionSet | null {
  if (!isRecord(raw)) return null
  const list = (value: unknown, max: number, valid: (entry: string) => boolean): string[] | null => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > PERMISSION_SET_MAX) return null
    const entries: string[] = []
    for (const entry of value) {
      if (typeof entry !== 'string' || entry === '' || entry.length > max || INVISIBLE.test(entry) || !valid(entry)) return null
      if (!entries.includes(entry)) entries.push(entry)
    }
    return entries
  }
  const permissions = list(raw['permissions'], NAME_LENGTH_MAX, (name) => !isHostEntry(name))
  const origins = list(raw['origins'], ORIGIN_LENGTH_MAX, (origin) => parseMatchPattern(origin) !== null)
  return permissions === null || origins === null ? null : { permissions, origins }
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.slice(0, MANIFEST_LIST_MAX).filter((entry): entry is string => typeof entry === 'string') : [])

/** What a manifest lists as facultative. A Manifest V2 extension writes its facultative sites among `optional_permissions`; Manifest V3 has a list for them. */
export function optionalOf(manifest: unknown): PermissionSet {
  const record = isRecord(manifest) ? manifest : {}
  const listed = strings(record['optional_permissions'])
  return {
    permissions: listed.filter((entry) => !isHostEntry(entry)),
    origins: [...strings(record['optional_host_permissions']), ...(record['manifest_version'] === 2 ? listed.filter(isHostEntry) : [])]
  }
}

/** Whether every address `origin` matches is matched by one of `patterns` (written the same, or wider). */
export function originCovered(patterns: readonly string[], origin: string): boolean {
  if (patterns.includes(origin)) return true
  const wanted = parseMatchPattern(origin)
  if (wanted === null) return false
  return patterns.some((pattern) => {
    const held = parseMatchPattern(pattern)
    return held !== null && covers(held, wanted)
  })
}

/** The part of `set` the manifest lists as facultative: a name it lists, a site one of its facultative patterns covers. */
export function withinOptional(manifest: unknown, set: PermissionSet): PermissionSet {
  const optional = optionalOf(manifest)
  return { permissions: set.permissions.filter((name) => optional.permissions.includes(name)), origins: set.origins.filter((origin) => originCovered(optional.origins, origin)) }
}

/** Whether the manifest lists all of `set` as facultative. */
export function isOptional(manifest: unknown, set: PermissionSet): boolean {
  const kept = withinOptional(manifest, set)
  return kept.permissions.length === set.permissions.length && kept.origins.length === set.origins.length
}

/**
 * The manifest the access rules read: the one of the extension, with what was granted added to `permissions` and `host_permissions`, after what
 * the manifest gives by itself. Only the part of the grant the manifest still lists as facultative is added. The very same object when nothing is
 * granted. The readers stop at `MANIFEST_LIST_MAX` entries: a grant that would go past it gives nothing, it never pushes out what the manifest gives.
 */
export function withGranted<T>(manifest: T, granted: PermissionSet): T {
  if (!isRecord(manifest)) return manifest
  const kept = withinOptional(manifest, granted)
  if (isEmptySet(kept)) return manifest
  const own = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  return { ...manifest, permissions: [...own(manifest['permissions']), ...kept.permissions], host_permissions: [...own(manifest['host_permissions']), ...kept.origins] } as T
}

/** Everything the extension holds, as `chrome.permissions.getAll` answers it. `manifest` is the one the access rules read (`withGranted`). */
export function heldBy(manifest: unknown): PermissionSet {
  const access = accessOf(manifest)
  return { permissions: [...access.permissions], origins: [...new Set(access.hosts)] }
}

/** The part of `set` the extension does not hold. `manifest` is the one the access rules read. */
export function missingFrom(manifest: unknown, set: PermissionSet): PermissionSet {
  const access = accessOf(manifest)
  return { permissions: set.permissions.filter((name) => !access.permissions.has(name)), origins: set.origins.filter((origin) => !originCovered(access.hosts, origin)) }
}

export function unionOf(a: PermissionSet, b: PermissionSet): PermissionSet {
  return { permissions: [...new Set([...a.permissions, ...b.permissions])], origins: [...new Set([...a.origins, ...b.origins])] }
}

/**
 * What is left of a grant once `set` is taken away, and what was taken: a name, and every granted site the pattern asked for covers (taking
 * every site away takes each granted site). Null when `set` names something the manifest gives by itself: that is not the extension's to give up.
 */
export function withoutRemoved(manifest: unknown, granted: PermissionSet, set: PermissionSet): { kept: PermissionSet; removed: PermissionSet } | null {
  const required = accessOf(manifest)
  if (set.permissions.some((name) => required.permissions.has(name)) || set.origins.some((origin) => originCovered(required.hosts, origin))) return null
  const goes = (origin: string): boolean => originCovered(set.origins, origin)
  return {
    kept: { permissions: granted.permissions.filter((name) => !set.permissions.includes(name)), origins: granted.origins.filter((origin) => !goes(origin)) },
    removed: { permissions: granted.permissions.filter((name) => set.permissions.includes(name)), origins: granted.origins.filter(goes) }
  }
}

/**
 * The sheet for a request: only what is asked and not held, with the sentences and the levels of the sheet of an installation (a permission that
 * reaches every site because the extension already has them all is wide here too). `name` is the name the extension goes by in the lists.
 * Null when there is nothing to show: nothing is then granted.
 */
export function reviewOfRequest(manifest: unknown, granted: PermissionSet, asked: PermissionSet, name: string, isSuffix?: SuffixTest): ExtensionReview | null {
  if (!isRecord(manifest)) return null
  // Without the content scripts: the pages they are injected into are not sites the extension holds, and a site asked for is new even when a script already runs there.
  const { content_scripts: _scripts, ...own } = manifest
  const added = addedAccess(withGranted(own, granted), withGranted(own, unionOf(granted, asked)), undefined, isSuffix)
  if (added === null) return null
  const warning = added.sites.scope === 'all' ? t('extension-review.cette-extension-peut-lire-et-modifier-vos') : added.broad ? t('extension-review.cette-extension-demande-des-acces-etendus-a') : ''
  return { ...added, name: cleanText(name, NAME_MAX) || added.name, description: '', warning }
}

/** What the Extensions page lists of a grant: each permission with its sentence and its level, each site as it was asked for. */
export interface GrantedFacts {
  permissions: ReviewedPermission[]
  origins: string[]
}

export function grantedFacts(manifest: unknown, granted: PermissionSet): GrantedFacts {
  const kept = withinOptional(manifest, granted)
  const all = isRecord(manifest) ? describeAccess(withGranted(manifest, kept)).permissions : []
  return { permissions: all.filter((permission) => kept.permissions.includes(permission.id)), origins: kept.origins }
}

/** A grant as it is kept on disk. */
export const storeGrant = (set: PermissionSet): string => JSON.stringify({ permissions: set.permissions, origins: set.origins })

/** A grant read back from disk. Throws when the text is not one: the caller says so and holds nothing for it. */
export function readStoredGrant(text: string): PermissionSet {
  const set = readPermissionSet(JSON.parse(text) as unknown)
  if (set === null) throw new Error('not a list of permissions and a list of sites')
  return set
}
