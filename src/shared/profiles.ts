import type { Settings, SidebarState } from './model'
import type { Action } from './sidebar'
import { isSearchTemplate } from './url'
import { cleanProxySetting, type ProxySetting } from './proxy'
import { isAbsolutePath } from './platform'
import { t, tp } from './i18n'

// The search engine, suggestions, auto-archive delay and download folder are kept per profile. The top-level settings are
// the default profile's values and what any profile without its own override uses.

export interface ProfileSettings {
  searchUrlTemplate?: string
  searchSuggestions?: boolean
  autoArchiveHours?: number
  /** Absolute path of the folder downloads go to; absent means the system Downloads folder. */
  downloadDir?: string
  /** Ids of the extensions switched off in this profile: they are not loaded there (the others of the profile run as before). */
  disabledExtensions?: string[]
  /**
   * Ids of the extensions the person let capture the sound of a tab in this profile (never its picture; shared/tab-capture.ts). None by default: an
   * extension that asks without being in this list is refused, and the person is told where to switch it on.
   */
  tabCaptureExtensions?: string[]
  /** Visited pages of this profile are not recorded (true) or are, whatever the global setting says (false). */
  historyOff?: boolean
  /** The proxy of this profile, instead of the global one (only used while `proxyEnabled` is on). */
  proxy?: ProxySetting
}

export type ProfileOverrides = Record<string, ProfileSettings>

// `__proto__` is refused: profile ids are used as keys of records.
const PROFILE_ID = /^(?!__proto__$)[A-Za-z0-9_-]{1,32}$/

/**
 * The profile id of the only space of a private or guest window. The engine ignores it (every page of such a window goes to the window's own
 * throw-away session), but the settings a private window follows are read by profile id: a profile of the user under this id would lend the
 * private window its search engine, its download folder and its proxy. No new profile takes it (`takenProfileIds`), and a private window reads
 * nothing of a profile that already has it (private-window.ts).
 */
export const PRIVATE_PROFILE_ID = 'private'

/** Profile ids name a storage partition on disk: nothing but plain characters. */
export const isProfileId = (id: unknown): id is string => typeof id === 'string' && PROFILE_ID.test(id)

/** The profile a space browses with. */
export const profileOfSpace = (state: SidebarState, spaceId: string): string => state.spaces.find((sp) => sp.id === spaceId)?.profileId ?? 'default'

/** The profile of the space the user is in. */
export const activeProfileId = (state: SidebarState): string => profileOfSpace(state, state.activeSpaceId)

/**
 * The space a tab opened on behalf of a profile goes to: the space the user is in when it is of that profile, else the first space of
 * the profile. Undefined when the profile has none (its extension is then refused: its tab would open in another profile's cookies).
 */
export function spaceOfProfile(state: SidebarState, profileId: string): string | undefined {
  if (profileOfSpace(state, state.activeSpaceId) === profileId && state.spaces.some((s) => s.id === state.activeSpaceId)) return state.activeSpaceId
  return state.spaces.find((s) => (s.profileId ?? 'default') === profileId)?.id
}

export function profileSearch(settings: Settings, profileId: string): { url: string; suggestions: boolean } {
  const own = settings.profiles[profileId]
  return { url: own?.searchUrlTemplate ?? settings.searchUrlTemplate, suggestions: own?.searchSuggestions ?? settings.searchSuggestions }
}

export const profileArchiveHours = (settings: Settings, profileId: string): number => settings.profiles[profileId]?.autoArchiveHours ?? settings.autoArchiveHours

/** Whether the pages of a profile go to its history: its own choice when it made one, else the global setting. */
export const profileRecordsHistory = (settings: Pick<Settings, 'historyOff' | 'profiles'>, profileId: string): boolean => !(settings.profiles[profileId]?.historyOff ?? settings.historyOff)

export const profileDownloadDir = (settings: Settings, profileId: string): string | undefined => settings.profiles[profileId]?.downloadDir

/** More than this many extensions switched off in one profile is not a thing a person does: the rest of a file's list is dropped. */
export const DISABLED_EXTENSIONS_MAX = 200

/** The extension ids of a saved list: well-formed ones only (32 letters from a to p), each once, in the order of the file. */
export function cleanDisabledExtensions(raw: unknown): string[] {
  const ids = new Set<string>()
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (ids.size >= DISABLED_EXTENSIONS_MAX) break
    if (typeof entry === 'string' && /^[a-p]{32}$/.test(entry)) ids.add(entry)
  }
  return [...ids]
}

/** The profile settings with one extension switched on or off in one profile. The profile's entry goes when nothing is left in it. */
export function withExtensionEnabled(profiles: ProfileOverrides, profileId: string, extensionId: string, enabled: boolean): ProfileOverrides {
  if (!PROFILE_ID.test(profileId) || !/^[a-p]{32}$/.test(extensionId)) return profiles
  const own = profiles[profileId] ?? {}
  const before = own.disabledExtensions ?? []
  if (before.includes(extensionId) === !enabled) return profiles
  const off = enabled ? before.filter((id) => id !== extensionId) : [...before, extensionId].slice(0, DISABLED_EXTENSIONS_MAX)
  const { disabledExtensions: _dropped, ...rest } = own
  const next: ProfileSettings = off.length > 0 ? { ...rest, disabledExtensions: off } : rest
  const { [profileId]: _old, ...others } = profiles
  return Object.keys(next).length > 0 ? { ...others, [profileId]: next } : others
}

/** The profile settings with one extension allowed or not to capture the sound of a tab in one profile. The profile's entry goes when nothing is left in it. */
export function withExtensionTabCapture(profiles: ProfileOverrides, profileId: string, extensionId: string, allowed: boolean): ProfileOverrides {
  if (!PROFILE_ID.test(profileId) || !/^[a-p]{32}$/.test(extensionId)) return profiles
  const own = profiles[profileId] ?? {}
  const before = own.tabCaptureExtensions ?? []
  if (before.includes(extensionId) === allowed) return profiles
  const next = allowed ? [...before, extensionId].slice(0, DISABLED_EXTENSIONS_MAX) : before.filter((id) => id !== extensionId)
  const { tabCaptureExtensions: _dropped, ...rest } = own
  const kept: ProfileSettings = next.length > 0 ? { ...rest, tabCaptureExtensions: next } : rest
  const { [profileId]: _old, ...others } = profiles
  return Object.keys(kept).length > 0 ? { ...others, [profileId]: kept } : others
}

/**
 * Keeps what a saved or imported file can safely say about profiles: known ids, a search address with a `%s`, an
 * archive delay that is a non-negative number, a download folder that is an absolute path. Empty overrides are dropped.
 */
export function cleanProfileOverrides(input: unknown): ProfileOverrides {
  if (typeof input !== 'object' || input === null) return {}
  const clean: ProfileOverrides = {}
  for (const [id, raw] of Object.entries(input)) {
    if (!PROFILE_ID.test(id) || typeof raw !== 'object' || raw === null) continue
    const value = raw as Record<string, unknown>
    const own: ProfileSettings = {}
    if (isSearchTemplate(value['searchUrlTemplate'])) own.searchUrlTemplate = value['searchUrlTemplate']
    if (typeof value['searchSuggestions'] === 'boolean') own.searchSuggestions = value['searchSuggestions']
    if (typeof value['autoArchiveHours'] === 'number' && Number.isFinite(value['autoArchiveHours']) && value['autoArchiveHours'] >= 0) own.autoArchiveHours = value['autoArchiveHours']
    const dir = value['downloadDir']
    // A path that is absolute on either family of systems: the file is the machine's own, and a Windows folder (C:\...) begins with no slash.
    if (typeof dir === 'string' && (isAbsolutePath(dir) || isAbsolutePath(dir, 'win32')) && dir.length <= 1024 && !/\p{Cc}/u.test(dir)) own.downloadDir = dir
    const off = cleanDisabledExtensions(value['disabledExtensions'])
    if (off.length > 0) own.disabledExtensions = off
    const captures = cleanDisabledExtensions(value['tabCaptureExtensions'])
    if (captures.length > 0) own.tabCaptureExtensions = captures
    if (typeof value['historyOff'] === 'boolean') own.historyOff = value['historyOff']
    // "System" is a choice too: it lets a profile ignore a global proxy.
    if (typeof value['proxy'] === 'object' && value['proxy'] !== null) own.proxy = cleanProxySetting(value['proxy'])
    if (Object.keys(own).length > 0) clean[id] = own
  }
  return clean
}

/**
 * The profiles that spaces use, those put aside included: their cookies and logins stay on disk while they wait, and must not look
 * unused (the clean-up of unused profiles erases what no space uses).
 */
export const profilesInUse = (state: SidebarState): string[] => [...new Set([...state.spaces.map((sp) => sp.profileId), ...state.sessions.flatMap((s) => (s.space ? [s.space.space.profileId] : []))])]

/** Every profile that exists: the default one, those spaces use (even a space put aside), and those created (named or customised) without a space yet. */
export function knownProfiles(state: SidebarState): string[] {
  return [...new Set(['default', ...profilesInUse(state), ...Object.keys(state.settings.profileNames), ...Object.keys(state.settings.profiles)])]
}

/**
 * The ids a new profile may not take: the profiles that exist, those deleted whose folders may still be on disk (profile-retire.ts), and the
 * one of the private window (a profile named « Private » becomes `private-2`).
 */
export const takenProfileIds = (state: SidebarState): string[] => [...knownProfiles(state), ...state.settings.retiredProfileIds, PRIVATE_PROFILE_ID]

/** A storage-safe id for a new profile named by the user: "Travail & Co" gives "travail-co", then "travail-co-2" if taken. */
export function newProfileId(name: string, existing: readonly string[]): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28) || 'profil'
  let id = base
  for (let n = 2; existing.includes(id); n++) id = `${base}-${n}`
  return id
}

// ---------- names ----------

/** Same limit as `PROFILE_NAME_MAX` of sidebar.ts (profiles.ts cannot import it without a cycle; a test keeps them equal). */
export const PROFILE_NAME_LIMIT = 40

/** Why a profile name was refused, in the language of the interface. */
export const profileNameInvalid = (): string => t('profiles.nom-de-profil-invalide')
export const profileNameTaken = (): string => t('profiles.un-profil-de-ce-nom-existe-deja')

/** What the user sees for a profile: the name they gave it, else "Profil par défaut" or the raw id. */
export const profileLabel = (settings: Settings, id: string): string => settings.profileNames[id] ?? (id === 'default' ? t('menu.profil-par-defaut') : id)

/** The names of every known profile, optionally leaving one out (the one being renamed). */
export const profileLabels = (state: SidebarState, except?: string): string[] =>
  knownProfiles(state)
    .filter((id) => id !== except)
    .map((id) => profileLabel(state.settings, id))

const nameKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr')

/**
 * Why a profile name cannot be used (it is not valid, or a profile with that name already exists), or null when it can.
 * `existing` holds the names already taken; case and spacing do not tell two names apart.
 */
export function validateProfileName(name: string, existing: readonly string[]): string | null {
  const clean = name.trim()
  if (clean === '' || clean.length > PROFILE_NAME_LIMIT || /\p{Cc}/u.test(clean)) return profileNameInvalid()
  const key = nameKey(clean)
  return existing.some((other) => nameKey(other) === key) ? profileNameTaken() : null
}

export type ProfileCreation = { ok: true; id: string; actions: Action[] } | { ok: false; error: string }

/**
 * The actions that create a profile and move the chosen spaces to it (the profile is named, then the spaces
 * that use it are chosen). The name is stored first: a profile exists through its name or through a space that uses it.
 */
export function planProfileCreation(state: SidebarState, name: string, spaceIds: readonly string[]): ProfileCreation {
  const error = validateProfileName(name, profileLabels(state))
  if (error) return { ok: false, error }
  const id = newProfileId(name, takenProfileIds(state))
  const actions: Action[] = [{ type: 'settings/update', patch: { profileNames: { ...state.settings.profileNames, [id]: name.trim() } } }]
  for (const spaceId of spaceIds) {
    if (state.spaces.some((sp) => sp.id === spaceId)) actions.push({ type: 'space/update', id: spaceId, patch: { profileId: id } })
  }
  return { ok: true, id, actions }
}

// ---------- archive delay across profiles ----------

export type ArchiveScope = 'all' | 'only'

/** The profiles that have no archive delay of their own: they follow the default profile's. */
export const profilesFollowingDefault = (state: SidebarState): string[] =>
  knownProfiles(state).filter((id) => id !== 'default' && state.settings.profiles[id]?.autoArchiveHours === undefined)

/**
 * The settings patch for a new archive delay of the default profile. `all` gives every profile that delay (their own values
 * go); `only` changes the default profile and keeps what the others use now, by writing the old delay to those that followed it.
 */
export function archiveDelayPatch(state: SidebarState, hours: number, scope: ArchiveScope): Pick<Settings, 'autoArchiveHours' | 'profiles'> {
  const profiles: ProfileOverrides = {}
  for (const [id, own] of Object.entries(state.settings.profiles)) {
    if (scope === 'all') {
      const { autoArchiveHours: _gone, ...rest } = own
      if (Object.keys(rest).length > 0) profiles[id] = rest
    } else profiles[id] = { ...own }
  }
  if (scope === 'only') {
    for (const id of profilesFollowingDefault(state)) profiles[id] = { ...profiles[id], autoArchiveHours: state.settings.autoArchiveHours }
  }
  return { autoArchiveHours: hours, profiles }
}

/** "6 heures", "1 jour", "7 jours": how long a delay is, in the words of the archive choices. */
export function archiveDelayLabel(hours: number): string {
  if (hours >= 24 && hours % 24 === 0) return tp('profiles.jours', hours / 24)
  return tp('profiles.heures', hours)
}

/** The sentence shown once an archive delay is set: after how long the tabs will be archived, or that they never will be. */
export function archiveDelayNotice(hours: number, profileName?: string): string {
  const whose = profileName ? t('profiles.les-onglets-du-profil-profilename', { profileName }) : t('profiles.vos-onglets')
  return hours <= 0 ? t('profiles.lucium-n-archivera-jamais-whose', { whose }) : t('profiles.lucium-archivera-desormais-whose-apres-delay', { whose, delay: archiveDelayLabel(hours) })
}
