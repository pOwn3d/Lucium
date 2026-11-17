// Tab containers: a tab can live in an identity of its own, with cookies, storage, cache and remembered
// permissions apart from the profile of its space and from the other containers. Pure rules shared by the reducer (sidebar.ts), the loader
// (normalize) and the interface; the main process gives each container a persistent session of its own (engine `openContainer`).

import { mayRemember } from './permissions'
import { isContainerId } from './container-id'
import type { ArchivedTab, AsideSpace, PermissionDecision, Session, SessionTab, Settings, SidebarState, TabItem } from './model'
import { cleanSitePermissions, isRecord, printable } from './state-clean'
import { hostnameOf, matchesHost } from './url'
import { t } from './i18n'

export { isContainerId } from './container-id'

/** The colours a container can have: the badge on its tabs, and the dot in the menus. Eight, with our own hexadecimal values. */
export const CONTAINER_COLORS = [
  { id: 'blue', get label() { return t('containers.bleu') }, hex: '#4a8df0' },
  { id: 'turquoise', get label() { return t('containers.turquoise') }, hex: '#2fb9b0' },
  { id: 'green', get label() { return t('containers.vert') }, hex: '#4cb35e' },
  { id: 'yellow', get label() { return t('containers.jaune') }, hex: '#e8c13a' },
  { id: 'orange', get label() { return t('containers.orange') }, hex: '#ee8a34' },
  { id: 'red', get label() { return t('containers.rouge') }, hex: '#e2524d' },
  { id: 'pink', get label() { return t('containers.rose') }, hex: '#e56fb0' },
  { id: 'purple', get label() { return t('containers.violet') }, hex: '#9a6be0' }
] as const

export type ContainerColor = (typeof CONTAINER_COLORS)[number]['id']

export const isContainerColor = (value: unknown): value is ContainerColor => CONTAINER_COLORS.some((color) => color.id === value)

/** The hexadecimal colour of a container's badge (the first colour for one that is not known). */
export const containerHex = (color: string): string => (CONTAINER_COLORS.find((c) => c.id === color) ?? CONTAINER_COLORS[0]).hex

export interface Container {
  /** A slug (see container-id.ts): it names the partition on disk. */
  id: string
  name: string
  color: ContainerColor
  /** The answers to permission prompts remembered for pages of this container, by origin then permission: never shared with the profile or the other containers. */
  permissions?: Record<string, Record<string, PermissionDecision>>
}

/** "This site always opens in this container": the host and its subdomains. */
export interface ContainerRule {
  host: string
  containerId: string
}

export const CONTAINERS_MAX = 24
export const CONTAINER_RULES_MAX = 200
export const CONTAINER_NAME_MAX = 30
/** A container remembers answers for at most this many origins: the list is saved with the state at every change. */
export const CONTAINER_PERMISSION_ORIGINS_MAX = 200

/** Why a name is refused, as the Settings say it under the field (in the language of the interface when it is checked). */
export const containerNameInvalid = (): string => t('containers.nom-de-conteneur-invalide')
export const containerNameTaken = (): string => t('containers.un-conteneur-de-ce-nom-existe-deja')

const nameKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr')

/** Why a container name cannot be used, or null when it can. `existing` holds the names already taken; case and spacing do not tell two names apart. */
export function validateContainerName(name: unknown, existing: readonly string[]): string | null {
  if (typeof name !== 'string') return containerNameInvalid()
  const clean = name.trim()
  if (clean === '' || clean.length > CONTAINER_NAME_MAX || /\p{Cc}/u.test(clean)) return containerNameInvalid()
  const key = nameKey(clean)
  return existing.some((other) => nameKey(other) === key) ? containerNameTaken() : null
}

/**
 * A storage-safe id for a new container: "Travail & Co" and the suffix "3fa9c" give "travail-co-3fa9c". The suffix (part of an id the caller
 * draws) keeps a new container from taking the partition of one that was deleted a moment ago, whose data is still being erased.
 */
export function newContainerId(name: string, suffix: string, existing: readonly string[]): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 14)
      .replace(/-+$/g, '') || 'conteneur'
  const tail = suffix.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5)
  const stem = tail === '' ? base : `${base}-${tail}`
  let id = stem
  for (let n = 2; existing.includes(id); n++) id = `${stem}-${n}`
  return id
}

// ---------- what a file can say ----------

/** The origins a container remembers answers for, repaired like the profile's own: web origins and known decisions only, bounded. */
function cleanContainerPermissions(raw: unknown): Record<string, Record<string, PermissionDecision>> {
  const clean = cleanSitePermissions(raw)
  const kept = Object.entries(clean).filter(([origin]) => mayRemember(origin, 'geolocation')).slice(0, CONTAINER_PERMISSION_ORIGINS_MAX)
  return Object.fromEntries(kept)
}

/** The containers of a file: an id nobody else has, a name nobody else has, a known colour (the first one otherwise), at most `CONTAINERS_MAX`. */
export function cleanContainers(raw: unknown): Container[] {
  const out: Container[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= CONTAINERS_MAX) break
    if (!isRecord(entry)) continue
    const id = entry['id']
    const name = printable(entry['name'], CONTAINER_NAME_MAX)?.trim()
    if (!isContainerId(id) || ids.has(id) || !name || names.has(nameKey(name))) continue
    ids.add(id)
    names.add(nameKey(name))
    const permissions = cleanContainerPermissions(entry['permissions'])
    out.push({ id, name, color: isContainerColor(entry['color']) ? entry['color'] : CONTAINER_COLORS[0].id, ...(Object.keys(permissions).length > 0 ? { permissions } : {}) })
  }
  return out
}

/** The hostname a rule is about: a domain or an address as the URL parser prints it, without "www." and without a port; null for anything else. */
export function containerRuleHost(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const text = input.trim().toLowerCase()
  if (text === '' || text.length > 2048) return null
  const isAddress = /^https?:\/\//.test(text)
  const url = isAddress ? text : `https://${text}`
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  // Credentials never name a site; and a bare host is a host: a path, a query or a port typed after it make it something else.
  if (parsed.username !== '' || parsed.password !== '') return null
  if (!isAddress && (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '' || parsed.port !== '')) return null
  const host = parsed.hostname.replace(/^www\./, '')
  return host.length <= 253 && /^[a-z0-9.-]+$/.test(host) && host.includes('.') && !host.startsWith('.') && !host.endsWith('.') && !host.includes('..') ? host : null
}

/** The rules of a file: a host, a container that exists, each host once, at most `CONTAINER_RULES_MAX`. */
export function cleanContainerRules(raw: unknown, containers: readonly Pick<Container, 'id'>[]): ContainerRule[] {
  const out: ContainerRule[] = []
  const hosts = new Set<string>()
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= CONTAINER_RULES_MAX) break
    if (!isRecord(entry)) continue
    const host = containerRuleHost(entry['host'])
    const containerId = entry['containerId']
    if (host === null || hosts.has(host) || !isContainerId(containerId) || !containers.some((c) => c.id === containerId)) continue
    hosts.add(host)
    out.push({ host, containerId })
  }
  return out
}

// ---------- reading ----------

export const containerById = (settings: Pick<Settings, 'containers'>, id: string | undefined): Container | undefined => (id === undefined ? undefined : settings.containers.find((c) => c.id === id))

/**
 * The container a tab lives in. A private tab has none (its throw-away session wins); a tab that names a container which no longer exists
 * has none either. It does not depend on the switch: turning the function off must not change the identity a tab already browses with.
 */
export function containerOfTab(settings: Pick<Settings, 'containers'>, tab: Pick<TabItem, 'container' | 'private'> | undefined): Container | undefined {
  return tab === undefined || tab.private === true ? undefined : containerById(settings, tab.container)
}

/** The container a new tab for this address opens in, by the user's rules (the most specific host wins). Undefined while the function is off. */
export function containerForUrl(settings: Pick<Settings, 'tabContainers' | 'containers' | 'containerRules'>, url: string): string | undefined {
  if (!settings.tabContainers || hostnameOf(url) === '') return undefined
  return [...settings.containerRules]
    .filter((rule) => settings.containers.some((c) => c.id === rule.containerId) && matchesHost(rule.host, url))
    .sort((a, b) => b.host.length - a.host.length)[0]?.containerId
}

/** The rule that sends this host to a container, if any. */
export const ruleOfHost = (settings: Pick<Settings, 'containerRules'>, host: string): ContainerRule | undefined => settings.containerRules.find((rule) => rule.host === host)

// ---------- writing ----------

/** The rules with this host sent to a container, or freed (`containerId` null). An unknown container, a bad host or a full list changes nothing. */
export function withContainerRule(rules: readonly ContainerRule[], containers: readonly Pick<Container, 'id'>[], host: unknown, containerId: string | null): ContainerRule[] {
  const clean = containerRuleHost(host)
  if (clean === null) return [...rules]
  const others = rules.filter((rule) => rule.host !== clean)
  if (containerId === null) return others
  if (!isContainerId(containerId) || !containers.some((c) => c.id === containerId)) return [...rules]
  if (others.length === rules.length && rules.length >= CONTAINER_RULES_MAX) return [...rules]
  // The rule keeps its place when it is changed.
  const at = rules.findIndex((rule) => rule.host === clean)
  return at >= 0 ? rules.map((rule, i) => (i === at ? { host: clean, containerId } : rule)) : [...rules, { host: clean, containerId }]
}

/** The container with one permission answer remembered for an origin (`null` forgets it). The same object when nothing changes. */
export function withContainerPermission(container: Container, origin: string, permission: string, decision: PermissionDecision | null): Container {
  if (!mayRemember(origin, permission) || permission === '__proto__' || origin === '__proto__') return container
  const current = container.permissions ?? {}
  const forOrigin = { ...(current[origin] ?? {}) }
  if (decision === null) {
    if (!(permission in forOrigin)) return container
    delete forOrigin[permission]
  } else {
    if (forOrigin[permission] === decision) return container
    if (!(origin in current) && Object.keys(current).length >= CONTAINER_PERMISSION_ORIGINS_MAX) return container
    forOrigin[permission] = decision
  }
  const permissions = { ...current, [origin]: forOrigin }
  if (Object.keys(forOrigin).length === 0) delete permissions[origin]
  const { permissions: _old, ...rest } = container
  return Object.keys(permissions).length > 0 ? { ...rest, permissions } : rest
}

// ---------- consistency of a state ----------

const keepContainer = <T extends { container?: string }>(item: T, known: ReadonlySet<string>): T => {
  if (item.container === undefined || known.has(item.container)) return item
  const { container: _gone, ...rest } = item
  return rest as T
}

function pruneAside(aside: AsideSpace, known: ReadonlySet<string>): AsideSpace {
  return { ...aside, tabs: aside.tabs.map((t) => keepContainer(t, known)), archive: aside.archive.map((a) => keepContainer(a, known)) }
}

function pruneSessions(sessions: readonly Session[], known: ReadonlySet<string>): Session[] {
  return sessions.map((session) => ({
    ...session,
    tabs: session.tabs.map((t: SessionTab) => keepContainer(t, known)),
    ...(session.space ? { space: pruneAside(session.space, known) } : {})
  }))
}

const anyUnknown = (items: ReadonlyArray<{ container?: string }>, known: ReadonlySet<string>): boolean => items.some((item) => item.container !== undefined && !known.has(item.container))

/**
 * A state whose tabs, archive and sessions only name containers that exist (the others go back to the profile's session: a file can be
 * edited by hand, and a container may have been deleted). Same object when everything is consistent.
 */
export function pruneContainers(state: SidebarState): SidebarState {
  const known = new Set(state.settings.containers.map((c) => c.id))
  const asides = state.sessions.flatMap((s) => (s.space ? [s.space] : []))
  const dirty =
    anyUnknown(state.tabs, known) ||
    anyUnknown(state.archive, known) ||
    anyUnknown(state.sessions.flatMap((s) => s.tabs), known) ||
    asides.some((a) => anyUnknown(a.tabs, known) || anyUnknown(a.archive, known))
  if (!dirty) return state
  return { ...state, tabs: state.tabs.map((t) => keepContainer(t, known)), archive: state.archive.map((a) => keepContainer(a, known)), sessions: pruneSessions(state.sessions, known) }
}

/**
 * Everything that remembers a page opened in this container, gone: its tabs (closed without a trace in the archive), the archive entries
 * made from them, the pages of the saved sessions and of the spaces put aside. The container itself and its rules are the caller's.
 */
export function withoutContainerPages(state: SidebarState, id: string): SidebarState {
  const mine = <T extends { container?: string }>(item: T): boolean => item.container === id
  const dropAside = (aside: AsideSpace): AsideSpace => {
    const gone = new Set(aside.tabs.filter(mine).map((t) => t.id))
    return {
      ...aside,
      tabs: aside.tabs.filter((t) => !gone.has(t.id)),
      archive: aside.archive.filter((a: ArchivedTab) => !mine(a)),
      // A split view that lost a pane is no split view: the tabs it held stay.
      splits: aside.splits.filter((sp) => !sp.tabIds.some((id) => gone.has(id))),
      selected: aside.selected !== null && gone.has(aside.selected) ? null : aside.selected
    }
  }
  const sessions: Session[] = []
  for (const session of state.sessions) {
    const tabs = session.tabs.filter((t) => !mine(t))
    const space = session.space ? dropAside(session.space) : undefined
    // A session that held nothing but pages of this container has nothing left to open; a space put aside is kept for its theme, even empty.
    if (tabs.length === 0 && !space && session.tabs.length > 0) continue
    sessions.push({ ...session, tabs, ...(space ? { space } : {}) })
  }
  return { ...state, archive: state.archive.filter((a) => !mine(a)), sessions }
}

// ---------- on disk ----------

/** The containers that have a folder on disk (`stored`: their ids) and that the list no longer names: their data is to be erased at the next launch. */
export function orphanContainerIds(stored: readonly string[], containers: readonly Pick<Container, 'id'>[]): string[] {
  const live = new Set(containers.map((c) => c.id))
  return stored.filter((id) => isContainerId(id) && !live.has(id))
}

/**
 * The stored containers the launch sweep erases: the orphans, but none at all when the state in memory is not the one the user had (`stateTrusted`
 * false: it was not read at this launch, or a set-aside copy of it is kept beside it). Its list would then take every container of the
 * user's state for a deleted one, and the data of a state that can still be restored would go. Nor does a container go that a copy of the
 * state made before a restoration still names (`namedByCopies`, see `containersNamedByCopies`; null: the copies cannot be read, nothing goes).
 */
export function containersToSweep(stored: readonly string[], containers: readonly Pick<Container, 'id'>[], stateTrusted: boolean, namedByCopies: () => ReadonlySet<string> | null = () => new Set()): string[] {
  if (!stateTrusted) return []
  const orphans = orphanContainerIds(stored, containers)
  // The copies are read only when a folder is about to go: the usual launch has no orphan.
  if (orphans.length === 0) return []
  const kept = namedByCopies()
  return kept === null ? [] : orphans.filter((id) => !kept.has(id))
}

/** How long the folder of a container the list no longer names may stay for the sake of a copy of the state: thirty days after the last write in it. */
export const ORPHAN_CONTAINER_KEEP_MS = 30 * 24 * 3_600_000

/**
 * The orphans the launch sweep spared (`going`: those it removes anyway) whose folder nothing wrote in for `ORPHAN_CONTAINER_KEEP_MS`: they go too, with
 * the whole days they stayed unused. A copy made before a restoration, or one that cannot be read, protects a folder for that long and no longer:
 * cookies and logins of a container nobody can open would otherwise stay on disk for as long as the copy does. `idleMs` answers how long ago the
 * folder was last written, null when that is unknown (the folder stays). Nothing goes while the state is not trusted, as for the sweep itself.
 */
export function containersKeptTooLong(stored: readonly string[], containers: readonly Pick<Container, 'id'>[], stateTrusted: boolean, going: readonly string[], idleMs: (id: string) => number | null): Array<{ id: string; days: number }> {
  if (!stateTrusted) return []
  const expired: Array<{ id: string; days: number }> = []
  for (const id of orphanContainerIds(stored, containers)) {
    if (going.includes(id)) continue
    const idle = idleMs(id)
    if (idle !== null && Number.isFinite(idle) && idle >= ORPHAN_CONTAINER_KEEP_MS) expired.push({ id, days: Math.floor(idle / (24 * 3_600_000)) })
  }
  return expired
}

/**
 * The containers a copy of the state names (`text`: the whole file, as Help › Restore Data kept it before replacing the state). Null when the copy
 * cannot be read as a state: what it names is then unknown.
 */
export function containerIdsOfStateText(text: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not an error to report here: the answer "unknown" stops the sweep, and the caller logs it (`containersNamedBeforeRestore`).
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const settings = (parsed as { settings?: unknown }).settings
  // A state without settings, or without a list, names no container (the list came with the function).
  if (settings === undefined) return []
  if (typeof settings !== 'object' || settings === null) return null
  const containers = (settings as { containers?: unknown }).containers
  if (containers === undefined) return []
  if (!Array.isArray(containers)) return null
  return containers.map((c: unknown) => (typeof c === 'object' && c !== null ? (c as { id?: unknown }).id : undefined)).filter(isContainerId)
}

/**
 * The containers the copies of the state kept before a restoration name, for the launch sweep to leave their folders alone: the restored state no
 * longer names a container made after the export, but the copy does, and the dialog of the restoration offers that copy as the way back.
 * `texts`: each copy read whole, null for one that could not be read. Null when any copy is unreadable or is not a state: nothing is swept then.
 */
export function containersNamedByCopies(texts: ReadonlyArray<string | null>): Set<string> | null {
  const named = new Set<string>()
  for (const text of texts) {
    const ids = text === null ? null : containerIdsOfStateText(text)
    if (ids === null) return null
    for (const id of ids) named.add(id)
  }
  return named
}
