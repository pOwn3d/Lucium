// The state of the engine and the diagnostic: the versions, the platform, the blocker's lists, a few counts,
// and a report in plain text that can be copied. Everything is read from this machine when the pane is on screen; nothing is sent anywhere.
//
// The report holds versions, numbers and the names of settings, and nothing the person did or has: no address, no title, no name of a tab, a profile, an
// extension or a Tweak, no path. The journal of errors is shown apart (it can name sites) and is never part of it.

import { getLanguage, t, tp } from './i18n'
import type { EngineInfo, ExtensionInfo } from './ipc'
import type { FilterListState } from './filter-lists'

/** What only the main process knows (`Channel.engineStatus`); the rest of the pane comes from the snapshot it already has. */
export interface EngineHost {
  electron: string
  node: string
  v8: string
  arch: string
  /** The kernel's release (`os.release()`), "27.2.0" for instance. */
  osRelease: string
  /** `ecs`: the castLabs build of Electron, which can install Widevine (docs/drm.md). `standard`: the Electron of the project. */
  variant: 'ecs' | 'standard'
  /** The Widevine module's version when it is installed, else null. */
  widevine: string | null
  processes: number
  memoryMb: number
  /** The last lines the main process wrote to its error log (src/main/error-log.ts), oldest first. They can name sites: shown apart, never in the report. */
  log: string[]
}

/** The blocker's lists, in three numbers. */
export interface ListsSummary {
  installed: number
  rules: number
  /** The most recent update among the lists (ms since the epoch), or null when none was ever fetched. */
  updatedAt: number | null
}

export function summarizeLists(lists: readonly Pick<FilterListState, 'installed' | 'rules' | 'updatedAt'>[] | undefined): ListsSummary {
  const installed = (lists ?? []).filter((list) => list.installed)
  const dates = installed.flatMap((list) => (list.updatedAt === null ? [] : [list.updatedAt]))
  return { installed: installed.length, rules: installed.reduce((sum, list) => sum + (list.rules ?? 0), 0), updatedAt: dates.length > 0 ? Math.max(...dates) : null }
}

const locale = (): string => (getLanguage() === 'fr' ? 'fr-FR' : 'en-GB')
export const formatWhen = (at: number): string => new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(at)
export const formatDay = (at: number): string => new Intl.DateTimeFormat(locale(), { dateStyle: 'medium' }).format(at)
export const number = (n: number): string => n.toLocaleString(locale())

/** The platform as people name it ("macOS"), else the identifier Node gives. */
export const platformName = (platform: string): string => (platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform)

/** What the report is made from: every field is a version, a count, a date or the name of a setting. */
export interface StatusInput {
  now: number
  appVersion: string
  engine: Pick<EngineInfo, 'version' | 'chromium'>
  platform: string
  host: Omit<EngineHost, 'log'> & { log?: readonly string[] }
  lists: ListsSummary
  /** Every copy of every extension, in every profile: only counted. */
  extensions: readonly Pick<ExtensionInfo, 'profileId'>[]
  boosts: number
  tabs: number
  /** The names of the settings that are not at their default. */
  modified: readonly string[]
}

/** The variant in words, for the pane and for the report. */
export const variantName = (variant: EngineHost['variant']): string => (variant === 'ecs' ? t('engine-status.variante-drm-castlabs') : t('engine-status.variante-standard'))

/** Widevine in words: the version when it is installed. */
export const widevineText = (widevine: string | null): string => (widevine !== null ? t('engine-status.widevine-installe-version', { version: widevine }) : t('engine-status.widevine-absent'))

/** The lists of the blocker in words: how many, how many rules, and since when; or that there is none. */
export function listsText(lists: ListsSummary): string {
  if (lists.installed === 0 || lists.updatedAt === null) return t('engine-status.aucune-liste-installee')
  return tp('engine-status.count-listes-regles-date', lists.installed, { count: lists.installed, rules: number(lists.rules), date: formatDay(lists.updatedAt) })
}

/** The report, as plain text. */
export function buildReport(input: StatusInput): string {
  const { host } = input
  const profiles = new Set(input.extensions.map((extension) => extension.profileId)).size
  return [
    t('engine-status.etat-d-lucium-date', { date: formatWhen(input.now) }),
    t('engine-status.versions-line', { app: input.appVersion || '?', electron: input.engine.version, chromium: input.engine.chromium, variant: variantName(host.variant) }),
    `${platformName(input.platform)} ${host.osRelease} · ${host.arch}`,
    t('engine-status.widevine-line', { state: widevineText(host.widevine) }),
    t('engine-status.bloqueur-line', { lists: listsText(input.lists) }),
    t('engine-status.extensions-line', { extensions: input.extensions.length, profiles, boosts: input.boosts, tabs: input.tabs }),
    t('engine-status.memoire-line', { memory: number(host.memoryMb), processes: host.processes }),
    input.modified.length > 0 ? t('engine-status.reglages-hors-defaut-noms-seulement', { names: [...input.modified].sort().join(', ') }) : t('engine-status.tous-les-reglages-sont-par-defaut'),
    t('engine-status.journal-count-lignes-non-incluses', { count: host.log?.length ?? 0 })
  ].join('\n')
}
