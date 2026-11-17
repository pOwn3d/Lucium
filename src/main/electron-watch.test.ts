import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  EXIT_MAJOR,
  EXIT_NETWORK,
  EXIT_PATCH,
  EXIT_UP_TO_DATE,
  EXIT_USAGE,
  WATCH_SOURCES,
  WatchError,
  assess,
  compareVersions,
  ecsTagFor,
  formatReport,
  formatVersion,
  parseVersion,
  readChromeReleases,
  readEcsReleases,
  readElectronReleases,
  readReleaseNotes,
  readSchedule,
  watch,
  type FetchJson,
  type WatchInput
} from './electron-watch'

// ---- Simulated feeds, in the shape of the real ones ----

const NOW = new Date('2026-10-27T10:00:00Z')

const electron = (version: string, date: string, chrome: string, node = '24.22.0', v8 = '15.6.75.19') => ({ version, date, chrome, node, v8 })

/** 45.0.0 installed; 45.1.0 and 45.1.1 out on the line; 46.0.0 out as a new major; 47 in alpha; a nightly above everything. */
const RELEASES_MAJOR = [
  electron('47.0.0-nightly.20261026', '2026-10-26', '160.0.8200.0'),
  electron('47.0.0-alpha.2', '2026-10-26', '160.0.8200.0'),
  electron('46.0.0', '2026-10-25', '158.0.8120.40', '24.23.0', '15.8.44'),
  electron('45.1.1', '2026-10-24', '156.0.8078.70'),
  electron('45.1.0', '2026-10-22', '156.0.8078.60'),
  electron('45.0.0', '2026-10-21', '156.0.8078.48'),
  electron('45.0.0-beta.7', '2026-10-21', '156.0.8078.36'),
  electron('44.9.3', '2026-10-21', '152.0.7977.167')
]
const RELEASES_PATCH = RELEASES_MAJOR.filter((r) => !r.version.startsWith('46') && !r.version.startsWith('47'))
const RELEASES_UP_TO_DATE = RELEASES_PATCH.filter((r) => !r.version.startsWith('45.1'))

const chrome = (version: string, milestone: number, date: string) => ({ channel: 'Stable', version, milestone, platform: 'Mac', time: Date.parse(date) })
const CHROME = [chrome('157.0.8100.12', 157, '2026-11-03'), chrome('156.0.8078.48', 156, '2026-10-20'), chrome('155.0.8059.86', 155, '2026-10-20')]
const CHROME_SAME = [chrome('156.0.8078.48', 156, '2026-10-20'), chrome('155.0.8059.86', 155, '2026-10-20')]

const ecs = (tag: string, published_at: string, prerelease = false) => ({ tag_name: tag, published_at: `${published_at}T10:00:00Z`, prerelease })
const ECS_FULL = [ecs('v46.0.0+wvcus', '2026-10-26'), ecs('v45.1.1+wvcus', '2026-10-25'), ecs('v45.0.0+wvcus', '2026-10-22'), ecs('v45.0.0-alpha.14+wvcus', '2026-10-04', true), ecs('v44.9.3+wvcus', '2026-10-22')]
const ECS_WITHOUT_45 = ECS_FULL.filter((e) => !e.tag_name.startsWith('v45.0.0+') && !e.tag_name.startsWith('v45.1'))

const note = (tag: string, published_at: string, body: string, prerelease = false) => ({ tag_name: tag, published_at: `${published_at}T10:00:00Z`, body, prerelease })
const NOTES = [
  note('v46.0.0', '2026-10-25', '# Release Notes for v46.0.0\n\n## Breaking Changes\n\n* Removed `safeStorage.encryptString()`.\n* Backported fixes from upstream Chromium and V8. [#1](https://example.org)'),
  note('v45.1.1', '2026-10-24', '> This release contains the fix for https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9, the mitigation for compromised certificates\n\n## Fixes\n\n* Backported fixes from upstream ANGLE, Chromium, PDFium and V8. [#2](https://example.org)'),
  note('v45.1.0', '2026-10-22', '## Other Changes\n\n* Updated Chromium to 156.0.8078.60.'),
  note('v45.0.0', '2026-10-21', '> Security: this is the installed one, so it must not count: https://github.com/electron/electron/security/advisories/GHSA-aaaa-bbbb-cccc'),
  note('v45.2.0-beta.1', '2026-10-26', 'CVE-2026-0001 in a prerelease: not counted either', true),
  note('v44.9.3', '2026-10-21', '> Older line: https://github.com/electron/electron/security/advisories/GHSA-dddd-eeee-ffff (never counted: not the installed line nor the newest major)')
]

/** The notes when nothing newer than 45.0.0 is out: the two feeds agree. */
const NOTES_UP_TO_DATE = NOTES.filter((n) => !/^v4(5\.[12]|6)/.test(n.tag_name))

const SCHEDULE = [
  { version: '47.0.0', branch: 'main', stableDate: '2027-03-02', chromiumVersion: 164, eolDate: '2027-08-17', status: 'nightly' },
  { version: '46.0.0', branch: '46-x-y', stableDate: '2027-01-05', chromiumVersion: 160, eolDate: '2027-06-22', status: 'prerelease' },
  { version: '45.0.0', branch: '45-x-y', stableDate: '2026-10-20', chromiumVersion: 156, eolDate: '2027-04-27', status: 'stable' },
  { version: '44.0.0', branch: '44-x-y', stableDate: '2026-08-24', chromiumVersion: 152, eolDate: '2027-03-02', status: 'stable' }
]

const input = (over: Partial<WatchInput> = {}): WatchInput => ({
  installed: '45.0.0',
  now: NOW,
  releases: readElectronReleases(RELEASES_UP_TO_DATE),
  chrome: readChromeReleases(CHROME_SAME),
  ecs: readEcsReleases(ECS_FULL),
  notes: readReleaseNotes(NOTES_UP_TO_DATE),
  schedule: readSchedule(SCHEDULE),
  ...over
})

/** A fetch that answers each feed from the tables above, with the overrides given (a value to answer, or an Error to reject with). */
const fetcher = (answers: Partial<Record<keyof typeof WATCH_SOURCES, unknown>> = {}): FetchJson => {
  const byUrl = new Map<string, unknown>([
    [WATCH_SOURCES.releases, RELEASES_PATCH],
    [WATCH_SOURCES.chrome, CHROME],
    [WATCH_SOURCES.ecs, ECS_FULL],
    [WATCH_SOURCES.notes, NOTES],
    [WATCH_SOURCES.schedule, SCHEDULE]
  ])
  for (const [key, value] of Object.entries(answers)) byUrl.set(WATCH_SOURCES[key as keyof typeof WATCH_SOURCES], value)
  return async (url) => {
    if (!byUrl.has(url)) throw new Error(`unexpected url ${url}`)
    const value = byUrl.get(url)
    if (value instanceof Error) throw value
    return value
  }
}

describe('parseVersion and compareVersions', () => {
  it('reads stables, prereleases and build metadata, refuses the rest', () => {
    expect(parseVersion('v45.0.0')).toEqual({ major: 45, minor: 0, patch: 0, prerelease: null })
    expect(parseVersion('46.0.0-alpha.2')).toEqual({ major: 46, minor: 0, patch: 0, prerelease: 'alpha.2' })
    expect(parseVersion('v44.9.3+wvcus')).toEqual({ major: 44, minor: 9, patch: 3, prerelease: null })
    expect(parseVersion('45.0.0-alpha.14+wvcus')?.prerelease).toBe('alpha.14')
    for (const bad of ['latest', '45', '45.0', '', '45.0.0.1', 'a.b.c']) expect(parseVersion(bad), bad).toBeNull()
  })

  it('orders numerically, a stable above its prereleases, prerelease numbers as numbers', () => {
    const v = (s: string) => parseVersion(s)!
    expect(compareVersions(v('45.10.0'), v('45.9.0'))).toBe(1)
    expect(compareVersions(v('45.0.0'), v('45.0.0-beta.7'))).toBe(1)
    expect(compareVersions(v('45.0.0-alpha.14'), v('45.0.0-alpha.3'))).toBe(1)
    expect(compareVersions(v('45.0.0-alpha.3'), v('45.0.0-beta.1'))).toBe(-1)
    expect(compareVersions(v('45.0.0-beta'), v('45.0.0-beta.1'))).toBe(-1)
    expect(compareVersions(v('44.9.3+wvcus'), v('44.9.3'))).toBe(0)
    expect(formatVersion(v('v46.0.0-alpha.2+wvcus'))).toBe('46.0.0-alpha.2')
    expect(ecsTagFor('45.0.0')).toBe('v45.0.0+wvcus')
  })
})

describe('readers: a feed that is not what it should be is an error naming the feed and the entry', () => {
  it('refuses a releases feed that is not a list, an entry without chrome, an unreadable version, an empty list', () => {
    expect(() => readElectronReleases({ version: '45.0.0' })).toThrow(/releases\.json.*tableau JSON/)
    expect(() => readElectronReleases('oops')).toThrow(WatchError)
    expect(() => readElectronReleases([electron('45.0.0', '2026-10-21', '156.0.8078.48'), { version: '44.0.0', date: '2026-08-24' }])).toThrow(/entrée 1 n'a pas de version, de date et de chrome/)
    expect(() => readElectronReleases([{ version: 'latest', date: '2026-10-21', chrome: '156.0.8078.48' }])).toThrow(/version illisible/)
    expect(() => readElectronReleases([])).toThrow(/vide/)
    const [one] = readElectronReleases([{ version: '45.0.0', date: '2026-10-21', chrome: '156.0.8078.48' }])
    expect(one).toMatchObject({ version: '45.0.0', node: '', v8: '' })
  })

  it('refuses a Chrome feed without milestones, and reads the time into a date', () => {
    expect(() => readChromeReleases([{ version: '156.0.8078.48' }])).toThrow(/jalon/)
    expect(readChromeReleases(CHROME_SAME)[0]).toEqual({ version: '156.0.8078.48', milestone: 156, date: '2026-10-20' })
  })

  it('keeps only the +wvcus tags of castLabs, from a releases or a tags answer, and refuses an entry without a tag', () => {
    expect(readEcsReleases([{ tag_name: 'v44.9.3+wvcus', published_at: '2026-10-22T08:00:00Z' }, { tag_name: 'v30.0.0+wvvmp' }, { name: 'v43.8.3+wvcus' }])).toEqual([
      { tag: 'v44.9.3+wvcus', parsed: parseVersion('44.9.3'), date: '2026-10-22' },
      { tag: 'v43.8.3+wvcus', parsed: parseVersion('43.8.3'), date: '' }
    ])
    expect(() => readEcsReleases([{ published_at: '2026-10-22T08:00:00Z' }])).toThrow(/ni tag_name ni name/)
    expect(() => readEcsReleases(null)).toThrow(/tableau JSON.*null/)
  })

  it('refuses release notes without a tag, and a schedule entry without a date', () => {
    expect(() => readReleaseNotes([{ body: 'x' }])).toThrow(/tag_name/)
    expect(readReleaseNotes([{ tag_name: 'v45.0.0' }])[0]).toMatchObject({ tag: 'v45.0.0', body: '', date: '' })
    expect(() => readSchedule([{ version: '46.0.0' }])).toThrow(/stableDate/)
    expect(readSchedule(SCHEDULE)[1]).toEqual({ version: '46.0.0', major: 46, chromium: 160, stableDate: '2027-01-05', eolDate: '2027-06-22', status: 'prerelease' })
  })
})

describe('assess', () => {
  it('up to date: exit 0, no lag, the ECS build of the installed version found, nothing to read for security', () => {
    const report = assess(input())
    expect(report.status).toBe('up-to-date')
    expect(report.exitCode).toBe(EXIT_UP_TO_DATE)
    expect(report.installed).toMatchObject({ version: '45.0.0', ageDays: 6 })
    expect(report.installed.release?.chrome).toBe('156.0.8078.48')
    expect(report.line).toMatchObject({ major: 45, lagDays: 0 })
    expect(report.line.latest?.version).toBe('45.0.0')
    expect(report.latestMajor.release?.version).toBe('45.0.0')
    expect(report.chrome).toMatchObject({ milestonesBehind: 0 })
    expect(report.ecs.forInstalled?.tag).toBe('v45.0.0+wvcus')
    expect(report.ecs.latestStable?.tag).toBe('v46.0.0+wvcus')
    expect(report.ecs.forTarget).toBeNull()
    expect(report.security).toEqual({ advisories: [], backports: 0 })
    expect(report.alerts).toEqual([])
    expect(report.schedule.installed?.eolDate).toBe('2027-04-27')
    expect(report.schedule.next?.version).toBe('46.0.0')
  })

  it('patch: exit 10, the lag counted from the newest of the line, the advisories of the newer notes of the line only', () => {
    const report = assess(input({ releases: readElectronReleases(RELEASES_PATCH), chrome: readChromeReleases(CHROME), notes: readReleaseNotes(NOTES) }))
    expect(report.status).toBe('patch')
    expect(report.exitCode).toBe(EXIT_PATCH)
    expect(report.line.latest?.version).toBe('45.1.1')
    expect(report.line.lagDays).toBe(3)
    expect(report.latestMajor.lagDays).toBe(0)
    expect(report.chrome.milestonesBehind).toBe(1)
    expect(report.ecs.forTarget?.tag).toBe('v45.1.1+wvcus')
    // 45.1.1 cites an advisory; 45.0.0 (installed), 45.2.0-beta.1 (prerelease) and 44.9.3 (older line) do not count.
    expect(report.security.advisories).toEqual([{ version: '45.1.1', date: '2026-10-24', lines: [expect.stringContaining('GHSA-jr5w-w6x2-84p9')] }])
    expect(report.security.backports).toBe(1)
    expect(report.alerts).toEqual([expect.stringMatching(/^Sécurité : 1 version.*45\.1\.1/)])
  })

  it('major: exit 20 even when a patch is also out, the target is the new major, the notes of both lines are read', () => {
    const report = assess(input({ releases: readElectronReleases(RELEASES_MAJOR), chrome: readChromeReleases(CHROME), notes: readReleaseNotes(NOTES) }))
    expect(report.status).toBe('major')
    expect(report.exitCode).toBe(EXIT_MAJOR)
    expect(report.line.latest?.version).toBe('45.1.1')
    expect(report.line.lagDays).toBe(3)
    expect(report.latestMajor.release?.version).toBe('46.0.0')
    expect(report.latestMajor.lagDays).toBe(2)
    expect(report.ecs.forTarget?.tag).toBe('v46.0.0+wvcus')
    // The alpha of 47 is the preview; its nightly is not.
    expect(report.nextMajorPreview?.version).toBe('47.0.0-alpha.2')
    expect(report.schedule.next?.version).toBe('47.0.0')
    expect(report.security.advisories.map((a) => a.version)).toEqual(['45.1.1'])
    expect(report.security.backports).toBe(2)
  })

  it('an installed version the feed does not know: compared anyway, its Chromium unknown, said in the alerts', () => {
    const report = assess(input({ installed: '45.0.5', releases: readElectronReleases(RELEASES_PATCH), chrome: readChromeReleases(CHROME), ecs: readEcsReleases(ECS_WITHOUT_45), notes: readReleaseNotes(NOTES) }))
    expect(report.status).toBe('patch')
    expect(report.installed.release).toBeNull()
    expect(report.installed.ageDays).toBeNull()
    expect(report.chrome.milestonesBehind).toBeNull()
    expect(report.alerts).toEqual([
      expect.stringContaining('45.0.5 n\'est pas dans le calendrier'),
      expect.stringMatching(/^castLabs ECS : aucune version pour Electron 45\.0\.5.*la plus récente de la ligne 45 est v45\.0\.0-alpha\.14\+wvcus \(préversion\) ; dernière ECS stable : v46\.0\.0\+wvcus/),
      expect.stringMatching(/^castLabs ECS : pas encore de version pour la cible 45\.1\.1.*aucune stable sur cette ligne/),
      expect.stringMatching(/^Sécurité/)
    ])
  })

  it('an installed version that is not one is a usage error (exit 2 through watch)', async () => {
    expect(() => assess(input({ installed: '^45.0.0' }))).toThrow(/« \^45\.0\.0 » n'est pas une version/)
    const outcome = await watch('latest', fetcher())
    expect(outcome).toEqual({ kind: 'error', exitCode: EXIT_USAGE, source: 'package.json', message: expect.stringContaining('« latest »') })
  })

  it('the castLabs build of the installed version missing: said in the alerts, with the newest of the line and the newest stable', () => {
    const report = assess(input({ ecs: readEcsReleases(ECS_WITHOUT_45) }))
    expect(report.ecs.forInstalled).toBeNull()
    expect(report.ecs.lineLatest?.tag).toBe('v45.0.0-alpha.14+wvcus')
    expect(report.ecs.lineLatestStable).toBeNull()
    expect(report.alerts).toEqual([expect.stringMatching(/^castLabs ECS : aucune version pour Electron 45\.0\.0 .*v45\.0\.0-alpha\.14\+wvcus \(préversion\) ; dernière ECS stable : v46\.0\.0\+wvcus$/)])
    const nothing = assess(input({ ecs: [] }))
    expect(nothing.alerts).toEqual([expect.stringMatching(/la ligne 45 n'a aucune version ECS$/)])
  })

  it('a line past its end of life is an alert', () => {
    const eol = SCHEDULE.map((s) => (s.version === '45.0.0' ? { ...s, status: 'eol', eolDate: '2026-10-20' } : s))
    expect(assess(input({ schedule: readSchedule(eol) })).alerts).toEqual([expect.stringMatching(/^Electron 45 n'est plus soutenu \(fin de vie le 2026-10-20\)/)])
    expect(assess(input({ schedule: null })).alerts).toEqual([])
  })
})

describe('watch', () => {
  it('reads the five feeds and gives the report with its exit code', async () => {
    const outcome = await watch('45.0.0', fetcher(), NOW)
    expect(outcome.kind).toBe('report')
    if (outcome.kind !== 'report') return
    expect(outcome.exitCode).toBe(EXIT_PATCH)
    expect(outcome.report.warnings).toEqual([])
    expect(outcome.report.schedule.next?.stableDate).toBe('2027-01-05')
  })

  it('a feed that cannot be fetched is exit 30, naming the feed and the cause, never a report', async () => {
    const outcome = await watch('45.0.0', fetcher({ chrome: new Error('fetch failed: ENOTFOUND chromiumdash.appspot.com') }), NOW)
    expect(outcome).toEqual({ kind: 'error', exitCode: EXIT_NETWORK, source: WATCH_SOURCES.chrome, message: expect.stringContaining('ENOTFOUND chromiumdash.appspot.com') })
    expect((outcome as { message: string }).message).toContain(WATCH_SOURCES.chrome)
  })

  it('a malformed feed is exit 30 too, naming the feed and the entry', async () => {
    const outcome = await watch('45.0.0', fetcher({ releases: [{ version: '45.0.0', date: '2026-10-21' }] }), NOW)
    expect(outcome).toEqual({ kind: 'error', exitCode: EXIT_NETWORK, source: WATCH_SOURCES.releases, message: expect.stringContaining("l'entrée 0 n'a pas de version, de date et de chrome") })
    const broken = await watch('45.0.0', fetcher({ ecs: 'not json at all' }), NOW)
    expect(broken).toMatchObject({ kind: 'error', exitCode: EXIT_NETWORK, source: WATCH_SOURCES.ecs })
  })

  it('the schedule alone may fail: the report comes with a warning that says so', async () => {
    const outcome = await watch('45.0.0', fetcher({ schedule: new Error('HTTP 503') }), NOW)
    expect(outcome.kind).toBe('report')
    if (outcome.kind !== 'report') return
    expect(outcome.report.schedule).toEqual({ next: null, installed: null })
    expect(outcome.report.warnings).toEqual([expect.stringMatching(/^Calendrier des majeures non lu \(.*HTTP 503\)/)])
    expect(formatReport(outcome.report)).toContain('Avertissement : Calendrier des majeures non lu')
  })

  it('a throw that is not a WatchError (a reader tripping on a hostile answer) is still exit 30 with its message', async () => {
    // A list whose entries cannot even be read: the reader throws a TypeError, not a WatchError.
    const hostile = new Proxy([{}], { get: (target, key) => (key === 'length' ? 1 : key === '0' ? (() => { throw new TypeError('boom') })() : Reflect.get(target, key)) })
    const outcome = await watch('45.0.0', fetcher({ releases: hostile }), NOW)
    expect(outcome).toEqual({ kind: 'error', exitCode: EXIT_NETWORK, source: 'inconnue', message: 'boom' })
  })
})

describe('formatReport', () => {
  it('says the installed version, the line, the next major, Chrome, ECS, security, the alerts and the verdict', () => {
    const text = formatReport(assess(input({ releases: readElectronReleases(RELEASES_MAJOR), chrome: readChromeReleases(CHROME), ecs: readEcsReleases(ECS_WITHOUT_45), notes: readReleaseNotes(NOTES) })))
    expect(text).toContain('Electron installé : 45.0.0 (Chromium 156.0.8078.48, Node 24.22.0, V8 15.6.75.19), publiée le 2026-10-21 (il y a 6 jours)')
    expect(text).toContain('Ligne 45 : dernière 45.1.1 (Chromium 156.0.8078.70, Node 24.22.0, V8 15.6.75.19), publiée le 2026-10-24 — 3 jours de retard')
    expect(text).toContain('Dernière majeure : 46.0.0 (Chromium 158.0.8120.40, Node 24.23.0, V8 15.8.44), publiée le 2026-10-25 — 2 jours de retard')
    expect(text).toContain('Préversion suivante : 47.0.0-alpha.2 (Chromium 160.0.8200.0), stable prévue le 2027-03-02 (Chromium 164)')
    expect(text).toContain('Fin de vie de la ligne 45 : 2027-04-27 (état : stable)')
    expect(text).toContain('Chrome stable (Mac) : 157.0.8100.12 (M157, 2026-11-03) — 1 jalon d’avance sur l’Electron installé')
    expect(text).toContain('castLabs ECS : aucune version pour 45.0.0 ; ligne 45 : v45.0.0-alpha.14+wvcus (préversion) du 2026-10-04 ; dernière stable : v46.0.0+wvcus ; cible v46.0.0+wvcus disponible')
    expect(text).toContain('Sécurité : 1 version cite un avis de sécurité dans les notes plus récentes ; 2 lignes de rétroportages amont')
    expect(text).toContain('  45.1.1 (2026-10-24) : This release contains the fix for https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9')
    expect(text).toContain('Alertes :\n  - castLabs ECS : aucune version pour Electron 45.0.0')
    expect(text).toMatch(/Verdict : nouvelle majeure disponible \(46\.0\.0\) — code de sortie 20$/)
  })

  it('up to date: the short form', () => {
    const text = formatReport(assess(input()))
    expect(text).toContain('Ligne 45 : dernière 45.0.0 — à jour')
    expect(text).toContain('Dernière majeure : 45 (la ligne installée)')
    expect(text).toContain('Majeure suivante prévue : 46.0.0 le 2027-01-05 (Chromium 160)')
    expect(text).toContain('Chrome stable (Mac) : 156.0.8078.48 (M156, 2026-10-20) — même jalon que l’Electron installé')
    expect(text).toContain('Sécurité : rien de plus récent que 45.0.0 à lire')
    expect(text).not.toContain('Alertes :')
    expect(text).toMatch(/Verdict : à jour — code de sortie 0$/)
  })
})

describe('the copy of isRecord this file keeps', () => {
  // Node runs electron-watch.ts directly for the scripts, without the aliases of the bundler: it cannot import @shared/record, and keeps its own copy.
  // The copy must stay the very check of shared/record.ts, as must the one of shared/perf-core.ts, which imports nothing for the same reason.
  const definition = (file: string): string => {
    const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
    const line = text.split('\n').find((l) => /^(?:export )?const isRecord = /.test(l))
    expect(line, `${file} has no isRecord any more`).toBeDefined()
    return line!.replace(/^export /, '').trim()
  }

  it('is the definition of shared/record.ts, character for character', () => {
    const shared = definition('../shared/record.ts')
    expect(definition('./electron-watch.ts')).toBe(shared)
    expect(definition('../shared/perf-core.ts')).toBe(shared)
  })

  it('imports nothing, so that Node can run it as it is', () => {
    const text = readFileSync(fileURLToPath(new URL('./electron-watch.ts', import.meta.url)), 'utf8')
    expect(text).not.toMatch(/^import /m)
  })
})
