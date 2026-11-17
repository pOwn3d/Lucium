// The pure part of `scripts/electron-watch.mjs` (and of the `check` step of `scripts/electron-upgrade.mjs`): what the public release feeds say,
// compared with the Electron this repository declares. No network here: the readers take the JSON a caller fetched, `watch()` takes the function
// that fetches. Nothing is written anywhere. The feeds (docs/mise-a-jour-chromium.md):
//   - releases.electronjs.org/releases.json      every Electron release with its Chromium, Node and V8
//   - chromiumdash (Google)                        the Chrome stable releases for macOS, with their milestone
//   - api.github.com castlabs/electron-releases   the ECS builds (`v<electron>+wvcus`), the only Electron that plays Widevine (docs/drm.md)
//   - api.github.com electron/electron releases   the release notes, read for the security advisories
//   - releases.electronjs.org/schedule.json       the planned dates of the next majors (optional: a failure is a warning, not an error)
//
// Exit codes, for an automation (launchd, a workflow): 0 up to date, 10 a newer minor or patch on the installed line, 20 a newer major,
// 30 a feed could not be read (network, timeout, malformed answer), 2 the installed version itself cannot be read.

export const EXIT_UP_TO_DATE = 0
export const EXIT_PATCH = 10
export const EXIT_MAJOR = 20
export const EXIT_NETWORK = 30
export const EXIT_USAGE = 2

export type WatchExitCode = typeof EXIT_UP_TO_DATE | typeof EXIT_PATCH | typeof EXIT_MAJOR

export const WATCH_SOURCES = {
  releases: 'https://releases.electronjs.org/releases.json',
  chrome: 'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=20',
  ecs: 'https://api.github.com/repos/castlabs/electron-releases/releases?per_page=100',
  notes: 'https://api.github.com/repos/electron/electron/releases?per_page=60',
  schedule: 'https://releases.electronjs.org/schedule.json'
} as const

export type WatchSource = keyof typeof WATCH_SOURCES

/** The castLabs tag of an Electron version: `v45.0.0+wvcus`. */
export const ecsTagFor = (version: string): string => `v${version.replace(/^v/, '')}+wvcus`

// ---- Versions ----

export interface Version {
  major: number
  minor: number
  patch: number
  /** "alpha.14", "beta.2", "nightly.20261026"; null for a stable. */
  prerelease: string | null
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** A semantic version ("45.0.0", "v46.0.0-alpha.2", "44.9.3+wvcus": the build metadata is dropped), or null for anything else. */
export function parseVersion(text: string): Version | null {
  const m = VERSION.exec(text.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null }
}

export const formatVersion = (v: Version): string => `${v.major}.${v.minor}.${v.patch}${v.prerelease ? `-${v.prerelease}` : ''}`

/** Semantic order: 1 when `a` is newer than `b`. A stable is newer than any prerelease of the same numbers; prerelease parts compare numerically when both are numbers.
 *  Not shared/versions.ts on purpose: an Electron prerelease must come before its release, which that order ignores (and this file imports nothing, see isRecord). */
export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  const left = a.prerelease.split('.')
  const right = b.prerelease.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x) ? Number(x) : null
    const ny = /^\d+$/.test(y) ? Number(y) : null
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx > ny ? 1 : -1
    } else if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

const newest = <T extends { parsed: Version }>(list: readonly T[]): T | null => {
  let best: T | null = null
  for (const item of list) if (!best || compareVersions(item.parsed, best.parsed) > 0) best = item
  return best
}

// ---- Readers: the feeds as this module needs them. A feed that is not what it should be is an error naming the feed and the entry, never a half-read. ----

export class WatchError extends Error {
  readonly code: 'malformed' | 'usage'
  readonly source: string

  constructor(code: 'malformed' | 'usage', source: string, message: string) {
    super(message)
    this.name = 'WatchError'
    this.code = code
    this.source = source
  }
}

// A copy of shared/record.ts on purpose: Node runs this file directly for the scripts, which resolve no alias and no extensionless import.
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const malformed = (source: string, what: string): WatchError => new WatchError('malformed', source, `${source}: réponse inattendue, ${what}`)

// What a field of a public feed may hold before it goes into a report, so into the title and the body of the issue the daily watch opens
// (src/main/chromium-watch-issue.ts): a feed that was tampered with must not get free text there. `string` alone is not a check.
/** A Chromium version: four numbers ("156.0.8078.48"). */
export const CHROMIUM_VERSION = /^\d{1,4}(?:\.\d{1,6}){3}$/
/** A day: YYYY-MM-DD. */
export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
/** The state of a major in the schedule: "stable", "prerelease", "nightly", "eol". */
const SCHEDULE_STATUS = /^[a-z][a-z-]{0,19}$/
/** A Node or a V8 version as the releases feed gives them ("24.22.0", "15.6.75.19", "14.2.231.21-electron.0"). */
const ENGINE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/

/** The day of a GitHub timestamp ("2026-10-22T08:00:00Z"), or '' when it is not one. */
const dayOf = (value: unknown): string => {
  const day = typeof value === 'string' ? value.slice(0, 10) : ''
  return ISO_DAY.test(day) ? day : ''
}

const listOf = (raw: unknown, source: string): unknown[] => {
  if (!Array.isArray(raw)) throw malformed(source, `un tableau JSON était attendu (reçu ${raw === null ? 'null' : typeof raw})`)
  return raw
}

export interface ElectronRelease {
  version: string
  parsed: Version
  /** YYYY-MM-DD. */
  date: string
  chrome: string
  node: string
  v8: string
}

/** releases.electronjs.org/releases.json: `[{ version, date, chrome, node, v8, … }]`. */
export function readElectronReleases(raw: unknown, source: string = WATCH_SOURCES.releases): ElectronRelease[] {
  const out: ElectronRelease[] = []
  listOf(raw, source).forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry['version'] !== 'string' || typeof entry['date'] !== 'string' || typeof entry['chrome'] !== 'string') {
      throw malformed(source, `l'entrée ${index} n'a pas de version, de date et de chrome`)
    }
    const parsed = parseVersion(entry['version'])
    if (!parsed) throw malformed(source, `l'entrée ${index} a une version illisible (« ${entry['version'].slice(0, 40)} »)`)
    if (!ISO_DAY.test(entry['date'])) throw malformed(source, `l'entrée ${index} (${entry['version']}) a une date qui n'est pas AAAA-MM-JJ`)
    if (!CHROMIUM_VERSION.test(entry['chrome'])) throw malformed(source, `l'entrée ${index} (${entry['version']}) a un chrome qui n'est pas une version de Chromium`)
    const engine = (value: unknown): string => (typeof value === 'string' && ENGINE_VERSION.test(value) ? value : '')
    // `version` goes out as parsed (trimmed), never as received.
    out.push({ version: entry['version'].trim(), parsed, date: entry['date'], chrome: entry['chrome'], node: engine(entry['node']), v8: engine(entry['v8']) })
  })
  if (out.length === 0) throw malformed(source, 'la liste est vide')
  return out
}

export interface ChromeRelease {
  version: string
  milestone: number
  /** YYYY-MM-DD. */
  date: string
}

/** chromiumdash `fetch_releases`: `[{ version, milestone, time (ms), … }]`. */
export function readChromeReleases(raw: unknown, source: string = WATCH_SOURCES.chrome): ChromeRelease[] {
  const out: ChromeRelease[] = []
  listOf(raw, source).forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry['version'] !== 'string' || typeof entry['milestone'] !== 'number') throw malformed(source, `l'entrée ${index} n'a pas de version et de jalon`)
    if (!CHROMIUM_VERSION.test(entry['version']) || !Number.isInteger(entry['milestone']) || entry['milestone'] < 0) throw malformed(source, `l'entrée ${index} a une version ou un jalon qui n'en est pas un`)
    const time = typeof entry['time'] === 'number' ? new Date(entry['time']) : null
    out.push({ version: entry['version'], milestone: entry['milestone'], date: time && !Number.isNaN(time.getTime()) ? time.toISOString().slice(0, 10) : '' })
  })
  if (out.length === 0) throw malformed(source, 'la liste est vide')
  return out
}

export interface EcsRelease {
  /** `v44.9.3+wvcus`. */
  tag: string
  parsed: Version
  /** YYYY-MM-DD, or '' when the feed is the tag list (no date there). */
  date: string
}

/** GitHub `releases` (`tag_name`, `published_at`) or `tags` (`name`) of castlabs/electron-releases; only the `+wvcus` tags are kept (the Widevine builds, docs/drm.md). */
export function readEcsReleases(raw: unknown, source: string = WATCH_SOURCES.ecs): EcsRelease[] {
  const out: EcsRelease[] = []
  listOf(raw, source).forEach((entry, index) => {
    const tag = isRecord(entry) ? (typeof entry['tag_name'] === 'string' ? entry['tag_name'] : typeof entry['name'] === 'string' ? entry['name'] : null) : null
    if (tag === null) throw malformed(source, `l'entrée ${index} n'a ni tag_name ni name`)
    if (!tag.endsWith('+wvcus')) return
    const parsed = parseVersion(tag)
    if (!parsed) return
    out.push({ tag: tag.trim(), parsed, date: isRecord(entry) ? dayOf(entry['published_at']) : '' })
  })
  return out
}

export interface ReleaseNote {
  tag: string
  parsed: Version
  date: string
  body: string
}

/** GitHub `releases` of electron/electron: the notes of each version. */
export function readReleaseNotes(raw: unknown, source: string = WATCH_SOURCES.notes): ReleaseNote[] {
  const out: ReleaseNote[] = []
  listOf(raw, source).forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry['tag_name'] !== 'string') throw malformed(source, `l'entrée ${index} n'a pas de tag_name`)
    const parsed = parseVersion(entry['tag_name'])
    if (!parsed) return
    out.push({ tag: entry['tag_name'].trim(), parsed, date: dayOf(entry['published_at']), body: typeof entry['body'] === 'string' ? entry['body'] : '' })
  })
  return out
}

export interface ScheduledMajor {
  /** "46.0.0". */
  version: string
  major: number
  chromium: number
  stableDate: string
  eolDate: string
  status: string
}

/** releases.electronjs.org/schedule.json: `[{ version, chromiumVersion, stableDate, eolDate, status }]`. */
export function readSchedule(raw: unknown, source: string = WATCH_SOURCES.schedule): ScheduledMajor[] {
  const out: ScheduledMajor[] = []
  listOf(raw, source).forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry['version'] !== 'string' || typeof entry['stableDate'] !== 'string') throw malformed(source, `l'entrée ${index} n'a pas de version et de stableDate`)
    const parsed = parseVersion(entry['version'])
    if (!parsed) return
    if (!ISO_DAY.test(entry['stableDate'])) throw malformed(source, `l'entrée ${index} a une stableDate qui n'est pas AAAA-MM-JJ`)
    out.push({
      version: entry['version'].trim(),
      major: parsed.major,
      chromium: typeof entry['chromiumVersion'] === 'number' && Number.isInteger(entry['chromiumVersion']) ? entry['chromiumVersion'] : 0,
      stableDate: entry['stableDate'],
      eolDate: typeof entry['eolDate'] === 'string' && ISO_DAY.test(entry['eolDate']) ? entry['eolDate'] : '',
      status: typeof entry['status'] === 'string' && SCHEDULE_STATUS.test(entry['status']) ? entry['status'] : ''
    })
  })
  return out
}

// ---- The comparison ----

export type WatchStatus = 'up-to-date' | 'patch' | 'major'

export interface SecurityNote {
  version: string
  date: string
  /** The lines of the notes that name an advisory. */
  lines: string[]
}

export interface WatchReport {
  checkedAt: string
  status: WatchStatus
  exitCode: WatchExitCode
  installed: {
    version: string
    /** null when the feed has no entry for the installed version (a build of one's own, or a version the feed dropped). */
    release: ElectronRelease | null
    /** Days since its publication; null when unknown. */
    ageDays: number | null
  }
  line: {
    major: number
    latest: ElectronRelease | null
    /** Days since the newest release of the line came out, when it is newer than the installed one; 0 otherwise. */
    lagDays: number
  }
  latestMajor: {
    release: ElectronRelease | null
    lagDays: number
  }
  /** The newest prerelease of a major above the newest stable one (the next Electron), when the feed has one. */
  nextMajorPreview: ElectronRelease | null
  schedule: {
    next: ScheduledMajor | null
    installed: ScheduledMajor | null
  }
  chrome: {
    latest: ChromeRelease | null
    /** Milestones between the Chromium of the installed Electron and the newest Chrome stable; null when the installed Chromium is unknown. */
    milestonesBehind: number | null
  }
  ecs: {
    forInstalled: EcsRelease | null
    lineLatest: EcsRelease | null
    lineLatestStable: EcsRelease | null
    latestStable: EcsRelease | null
    /** The ECS build of the version the status points to (the newest of the line, or the newest major); null when there is none or nothing to upgrade to. */
    forTarget: EcsRelease | null
  }
  security: {
    /** The notes of the releases newer than the installed one (same line, and the newest major) that name an advisory. */
    advisories: SecurityNote[]
    /** How many "Backported fix(es) from upstream" lines those same notes carry (Chromium's security backports, mostly). */
    backports: number
  }
  alerts: string[]
  warnings: string[]
}

export interface WatchInput {
  installed: string
  now: Date
  releases: ElectronRelease[]
  chrome: ChromeRelease[]
  ecs: EcsRelease[]
  notes: ReleaseNote[]
  /** null when the schedule could not be read (the report says so in its warnings). */
  schedule: ScheduledMajor[] | null
  warnings?: string[]
}

const ADVISORY = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|CVE-\d{4}-\d{4,}|security advisor/i
const BACKPORT = /backported fix/i

const daysBetween = (from: string, to: Date): number | null => {
  const start = Date.parse(from)
  return Number.isNaN(start) ? null : Math.max(0, Math.floor((to.getTime() - start) / 86_400_000))
}

/** What the feeds say about the installed version. Throws a `WatchError('usage')` when the installed version is not a version. */
export function assess(input: WatchInput): WatchReport {
  const installed = parseVersion(input.installed)
  if (!installed) throw new WatchError('usage', 'package.json', `la version installée « ${input.installed} » n'est pas une version (attendu : 45.0.0)`)
  const alerts: string[] = []
  const warnings = [...(input.warnings ?? [])]
  const stable = input.releases.filter((r) => r.parsed.prerelease === null)
  const installedRelease = input.releases.find((r) => compareVersions(r.parsed, installed) === 0) ?? null
  if (!installedRelease) alerts.push(`La version installée ${formatVersion(installed)} n'est pas dans le calendrier d'Electron : son Chromium n'est pas connu d'ici (lu dans node_modules/electron/package.json par le script).`)

  const lineLatest = newest(stable.filter((r) => r.parsed.major === installed.major))
  const latestMajor = newest(stable)
  const nextMajorPreview = latestMajor ? newest(input.releases.filter((r) => r.parsed.major > latestMajor.parsed.major && r.parsed.prerelease !== null && !r.parsed.prerelease.startsWith('nightly'))) : null

  const status: WatchStatus =
    latestMajor && latestMajor.parsed.major > installed.major ? 'major' : lineLatest && compareVersions(lineLatest.parsed, installed) > 0 ? 'patch' : 'up-to-date'
  const exitCode: WatchExitCode = status === 'major' ? EXIT_MAJOR : status === 'patch' ? EXIT_PATCH : EXIT_UP_TO_DATE
  const lineLag = status !== 'up-to-date' && lineLatest && compareVersions(lineLatest.parsed, installed) > 0 ? (daysBetween(lineLatest.date, input.now) ?? 0) : 0
  const majorLag = status === 'major' && latestMajor ? (daysBetween(latestMajor.date, input.now) ?? 0) : 0

  const chromeLatest = ((): ChromeRelease | null => {
    let best: ChromeRelease | null = null
    for (const c of input.chrome) {
      const parsed = parseVersion(c.version.split('.').slice(0, 3).join('.'))
      const bestParsed = best ? parseVersion(best.version.split('.').slice(0, 3).join('.')) : null
      if (!parsed) continue
      if (!best || !bestParsed || compareVersions(parsed, bestParsed) > 0 || (compareVersions(parsed, bestParsed) === 0 && c.version > best.version)) best = c
    }
    return best
  })()
  const installedMilestone = installedRelease ? Number(installedRelease.chrome.split('.')[0]) : null
  const milestonesBehind = chromeLatest && installedMilestone !== null && Number.isFinite(installedMilestone) ? Math.max(0, chromeLatest.milestone - installedMilestone) : null

  const ecsForInstalled = input.ecs.find((e) => e.tag === ecsTagFor(formatVersion(installed))) ?? null
  const ecsLine = input.ecs.filter((e) => e.parsed.major === installed.major)
  const ecsLineLatest = newest(ecsLine)
  const ecsLineLatestStable = newest(ecsLine.filter((e) => e.parsed.prerelease === null))
  const ecsLatestStable = newest(input.ecs.filter((e) => e.parsed.prerelease === null))
  const target = status === 'major' ? latestMajor : status === 'patch' ? lineLatest : null
  const ecsForTarget = target ? (input.ecs.find((e) => e.tag === ecsTagFor(target.version)) ?? null) : null
  if (!ecsForInstalled) {
    alerts.push(
      `castLabs ECS : aucune version pour Electron ${formatVersion(installed)} (la variante DRM, docs/drm.md, ne peut pas être sur la même version) ; ` +
        (ecsLineLatest ? `la plus récente de la ligne ${installed.major} est ${ecsLineLatest.tag}${ecsLineLatest.parsed.prerelease ? ' (préversion)' : ''}` : `la ligne ${installed.major} n'a aucune version ECS`) +
        (ecsLatestStable ? ` ; dernière ECS stable : ${ecsLatestStable.tag}` : '')
    )
  }
  if (target && !ecsForTarget) alerts.push(`castLabs ECS : pas encore de version pour la cible ${target.version} : la variante DRM attendra (${ecsLineLatestStable ? `dernière stable de la ligne : ${ecsLineLatestStable.tag}` : 'aucune stable sur cette ligne'}).`)

  const advisories: SecurityNote[] = []
  let backports = 0
  for (const note of input.notes) {
    if (note.parsed.prerelease !== null || compareVersions(note.parsed, installed) <= 0) continue
    if (note.parsed.major !== installed.major && note.parsed.major !== latestMajor?.parsed.major) continue
    const lines = note.body.split('\n').map((l) => l.trim())
    backports += lines.filter((l) => BACKPORT.test(l)).length
    const hits = lines.filter((l) => ADVISORY.test(l))
    if (hits.length > 0) advisories.push({ version: note.tag.replace(/^v/, ''), date: note.date, lines: hits })
  }
  advisories.sort((a, b) => compareVersions(parseVersion(b.version)!, parseVersion(a.version)!))
  if (advisories.length > 0) alerts.push(`Sécurité : ${advisories.length} version(s) publiée(s) après ${formatVersion(installed)} citent un avis de sécurité : ${advisories.map((a) => a.version).join(', ')}.`)

  const scheduleNext = input.schedule ? (input.schedule.filter((s) => latestMajor && s.major > latestMajor.parsed.major).sort((a, b) => a.major - b.major)[0] ?? null) : null
  const scheduleInstalled = input.schedule ? (input.schedule.find((s) => s.major === installed.major) ?? null) : null
  if (scheduleInstalled?.status === 'eol') alerts.push(`Electron ${installed.major} n'est plus soutenu (fin de vie le ${scheduleInstalled.eolDate}) : plus aucun correctif de sécurité pour la ligne installée.`)

  return {
    checkedAt: input.now.toISOString(),
    status,
    exitCode,
    installed: { version: formatVersion(installed), release: installedRelease, ageDays: installedRelease ? daysBetween(installedRelease.date, input.now) : null },
    line: { major: installed.major, latest: lineLatest, lagDays: lineLag },
    latestMajor: { release: latestMajor, lagDays: majorLag },
    nextMajorPreview,
    schedule: { next: scheduleNext, installed: scheduleInstalled },
    chrome: { latest: chromeLatest, milestonesBehind },
    ecs: { forInstalled: ecsForInstalled, lineLatest: ecsLineLatest, lineLatestStable: ecsLineLatestStable, latestStable: ecsLatestStable, forTarget: ecsForTarget },
    security: { advisories, backports },
    alerts,
    warnings
  }
}

// ---- The whole look, with the fetch given by the caller ----

export type FetchJson = (url: string) => Promise<unknown>

export type WatchOutcome =
  | { kind: 'report'; report: WatchReport; exitCode: WatchExitCode }
  | { kind: 'error'; exitCode: typeof EXIT_NETWORK | typeof EXIT_USAGE; source: string; message: string }

/**
 * Reads the five feeds and compares. A feed that fails (network, timeout, malformed) is an error naming it, exit 30, never a report with holes;
 * the schedule alone is optional and leaves a warning. An unreadable installed version is exit 2.
 */
export async function watch(installed: string, fetchJson: FetchJson, now: Date = new Date()): Promise<WatchOutcome> {
  const warnings: string[] = []
  const read = async <T>(source: WatchSource, reader: (raw: unknown, source: string) => T): Promise<T> => {
    const url = WATCH_SOURCES[source]
    let raw: unknown
    try {
      raw = await fetchJson(url)
    } catch (error) {
      throw new WatchError('malformed', url, `${url} : lecture impossible (${error instanceof Error ? error.message : String(error)})`)
    }
    return reader(raw, url)
  }
  try {
    const [releases, chrome, ecs, notes] = await Promise.all([read('releases', readElectronReleases), read('chrome', readChromeReleases), read('ecs', readEcsReleases), read('notes', readReleaseNotes)])
    let schedule: ScheduledMajor[] | null = null
    try {
      schedule = await read('schedule', readSchedule)
    } catch (error) {
      warnings.push(`Calendrier des majeures non lu (${error instanceof Error ? error.message : String(error)}) : les dates prévues manquent.`)
    }
    const report = assess({ installed, now, releases, chrome, ecs, notes, schedule, warnings })
    return { kind: 'report', report, exitCode: report.exitCode }
  } catch (error) {
    if (error instanceof WatchError && error.code === 'usage') return { kind: 'error', exitCode: EXIT_USAGE, source: error.source, message: error.message }
    if (error instanceof WatchError) return { kind: 'error', exitCode: EXIT_NETWORK, source: error.source, message: error.message }
    return { kind: 'error', exitCode: EXIT_NETWORK, source: 'inconnue', message: error instanceof Error ? error.message : String(error) }
  }
}

// ---- The text report ----

const describe = (r: ElectronRelease): string => `${r.version} (Chromium ${r.chrome}${r.node ? `, Node ${r.node}` : ''}${r.v8 ? `, V8 ${r.v8}` : ''}), publiée le ${r.date}`

const plural = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`

export function formatReport(report: WatchReport): string {
  const lines: string[] = []
  const { installed, line, latestMajor, chrome, ecs, security } = report
  lines.push(`Electron installé : ${installed.release ? describe(installed.release) : `${installed.version} (absent du calendrier)`}${installed.ageDays !== null ? ` (il y a ${plural(installed.ageDays, 'jour', 'jours')})` : ''}`)
  lines.push(
    `Ligne ${line.major} : ` +
      (line.latest ? (line.lagDays > 0 || (line.latest.version !== installed.version && report.status !== 'up-to-date') ? `dernière ${describe(line.latest)} — ${plural(line.lagDays, 'jour', 'jours')} de retard` : `dernière ${line.latest.version} — à jour`) : 'aucune version stable connue')
  )
  if (latestMajor.release && latestMajor.release.parsed.major !== line.major) lines.push(`Dernière majeure : ${describe(latestMajor.release)} — ${plural(latestMajor.lagDays, 'jour', 'jours')} de retard`)
  else if (latestMajor.release) lines.push(`Dernière majeure : ${latestMajor.release.parsed.major} (la ligne installée)`)
  if (report.nextMajorPreview) {
    const planned = report.schedule.next ? `, stable prévue le ${report.schedule.next.stableDate} (Chromium ${report.schedule.next.chromium})` : ''
    lines.push(`Préversion suivante : ${report.nextMajorPreview.version} (Chromium ${report.nextMajorPreview.chrome})${planned}`)
  } else if (report.schedule.next) lines.push(`Majeure suivante prévue : ${report.schedule.next.version} le ${report.schedule.next.stableDate} (Chromium ${report.schedule.next.chromium})`)
  if (report.schedule.installed) lines.push(`Fin de vie de la ligne ${line.major} : ${report.schedule.installed.eolDate} (état : ${report.schedule.installed.status})`)
  if (chrome.latest) {
    const behind = chrome.milestonesBehind === null ? 'jalon de l’Electron installé inconnu' : chrome.milestonesBehind === 0 ? 'même jalon que l’Electron installé' : `${plural(chrome.milestonesBehind, 'jalon', 'jalons')} d’avance sur l’Electron installé`
    lines.push(`Chrome stable (Mac) : ${chrome.latest.version} (M${chrome.latest.milestone}${chrome.latest.date ? `, ${chrome.latest.date}` : ''}) — ${behind}`)
  }
  lines.push(
    `castLabs ECS : ${ecs.forInstalled ? `${ecs.forInstalled.tag} existe${ecs.forInstalled.date ? ` (${ecs.forInstalled.date})` : ''}` : `aucune version pour ${installed.version}`}` +
      (ecs.lineLatest ? ` ; ligne ${line.major} : ${ecs.lineLatest.tag}${ecs.lineLatest.parsed.prerelease ? ' (préversion)' : ''}${ecs.lineLatest.date ? ` du ${ecs.lineLatest.date}` : ''}` : ` ; ligne ${line.major} : rien`) +
      (ecs.latestStable ? ` ; dernière stable : ${ecs.latestStable.tag}` : ' ; aucune stable') +
      (ecs.forTarget ? ` ; cible ${ecs.forTarget.tag} disponible` : '')
  )
  if (report.status === 'up-to-date') lines.push(`Sécurité : rien de plus récent que ${installed.version} à lire`)
  else lines.push(`Sécurité : ${security.advisories.length === 0 ? 'aucun avis de sécurité cité' : `${plural(security.advisories.length, 'version cite', 'versions citent')} un avis de sécurité`} dans les notes plus récentes ; ${plural(security.backports, 'ligne', 'lignes')} de rétroportages amont`)
  for (const a of security.advisories) for (const l of a.lines) lines.push(`  ${a.version} (${a.date}) : ${l.replace(/^[>*-]\s*/, '').slice(0, 200)}`)
  if (report.alerts.length > 0) {
    lines.push('Alertes :')
    for (const a of report.alerts) lines.push(`  - ${a}`)
  }
  for (const w of report.warnings) lines.push(`Avertissement : ${w}`)
  const verdict = report.status === 'up-to-date' ? 'à jour' : report.status === 'patch' ? `mise à jour mineure ou correctif disponible (${line.latest?.version})` : `nouvelle majeure disponible (${latestMajor.release?.version})`
  lines.push(`Verdict : ${verdict} — code de sortie ${report.exitCode}`)
  return lines.join('\n')
}
