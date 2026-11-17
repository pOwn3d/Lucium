import { afterEach, describe, expect, it } from 'vitest'
import { CLIPBOARD_TEXT_MAX } from './clipboard-text'
import { formatWhen } from './engine-status'
import { FEATURES, featurePatch, isFeatureOn } from './features'
import { setLanguage } from './i18n'
import { defaultSettings, type Settings } from './model'
import { buildProblemReport, EXTENSION_LINES_BUDGET, EXTENSION_LINES_MAX, EXTENSION_TEXT_MAX, PROBLEM_REPORT_MAX, PROBLEM_REPORT_REQUEST, PROBLEM_SITE_URLS, reportFileName, type ProblemReportInput } from './problem-report'
import { frenchSpaces } from './french-typography'

const NOW = new Date(2026, 10, 7, 21, 49).getTime()

const input = (over: Partial<ProblemReportInput> = {}): ProblemReportInput => ({
  now: NOW,
  appVersion: '0.2.12',
  engine: { electron: '45.0.0', chromium: '156.0.8078.48' },
  variant: 'ecs',
  widevine: '4.10.2891.0',
  platform: 'darwin',
  systemVersion: '15.1.0',
  arch: 'arm64',
  extensions: [
    { name: 'uBlock Origin', version: '1.60.0', enabled: true },
    { name: 'Dark Reader', version: '4.9.90', enabled: false }
  ],
  settings: defaultSettings(),
  log: ['2026-11-07T10:00:00.000Z [site] the data of shop.example was not erased', '2026-11-07T10:01:00.000Z [state] cannot read state.json'],
  ...over
})

afterEach(() => setLanguage('fr'))

describe('the report « Signaler un problème »', () => {
  it('holds the version and the variant of Lucium, the engine, the system, the extensions, the features that are on and the log', () => {
    setLanguage('fr')
    const report = buildProblemReport(input())
    expect(report.split('\n')[0]).toBe(`Rapport pour le support de Lucium — ${formatWhen(NOW)}`)
    expect(report).toContain(frenchSpaces('Rien n’a été envoyé : relisez-le avant de le partager.'))
    expect(report).toContain('Lucium 0.2.12 · Electron 45.0.0 · Chromium 156.0.8078.48 · variante DRM (castLabs)')
    expect(report).toContain(frenchSpaces('Widevine : Installé (4.10.2891.0)'))
    expect(report).toContain('macOS 15.1.0 · arm64')
    expect(report).toContain('Extensions (2)\n  uBlock Origin 1.60.0\n  Dark Reader 4.9.90 (désactivée)')
    expect(report).toContain(frenchSpaces('Journal des erreurs (2 lignes ; chemins réduits au nom du fichier, adresses au nom du site)\n  2026-11-07T10:00:00.000Z [site] the data of shop.example was not erased\n  2026-11-07T10:01:00.000Z [state] cannot read state.json'))
  })

  it('says the standard variant, an engine without Widevine, an unknown system version and an unknown application version', () => {
    const report = buildProblemReport(input({ variant: 'standard', widevine: null, systemVersion: '', appVersion: '' }))
    expect(report).toContain('Lucium ? · Electron 45.0.0 · Chromium 156.0.8078.48 · variante Standard')
    expect(report).toContain('Widevine\u00a0: Absent')
    expect(report).toContain('\nmacOS · arm64\n')
  })

  it('lists exactly the features that are on, by their id in the catalogue', () => {
    const settings = { ...defaultSettings(), sleepAfterMinutes: 0, passwordManager: true }
    const report = buildProblemReport(input({ settings }))
    const on = FEATURES.filter((feature) => isFeatureOn(settings, feature.id)).map((feature) => feature.id)
    expect(on).toContain('password-manager')
    expect(on).not.toContain('sleep')
    const listed = report
      .split(/Fonctions activées \(\d+\)\u00a0:\n/)[1]!
      .split('\n\n')[0]!
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    expect(listed).toEqual(on)
    expect(report).toContain(frenchSpaces(`Fonctions activées (${on.length}) :`))
    // The list is wrapped: no line of it is wider than the report's other lines.
    for (const line of report.split('\n')) expect(line.length, line).toBeLessThanOrEqual(120)
  })

  it('says so when no extension is installed and when no feature is on', () => {
    const off = Object.assign({}, ...FEATURES.map((feature) => featurePatch(feature.id, false))) as Partial<Settings>
    const report = buildProblemReport(input({ extensions: [], settings: { ...defaultSettings(), ...off }, log: [] }))
    expect(report).toContain(frenchSpaces('Extensions : aucune'))
    expect(report).toContain(frenchSpaces('Fonctions activées : aucune'))
    expect(report).toContain(frenchSpaces('Journal des erreurs : rien à signaler depuis le lancement'))
  })

  it('lists the same extension of several profiles once, and counts those past the sixtieth', () => {
    const copies = [{ name: 'Dark Reader', version: '4.9.90', enabled: true }, { name: 'Dark Reader', version: '4.9.90', enabled: true }]
    expect(buildProblemReport(input({ extensions: copies }))).toContain('Extensions (1)\n  Dark Reader 4.9.90\n')
    const many = Array.from({ length: EXTENSION_LINES_MAX + 5 }, (_, i) => ({ name: `Extension ${i}`, version: '1.0', enabled: true }))
    const report = buildProblemReport(input({ extensions: many }))
    expect(report).toContain(`Extensions (${EXTENSION_LINES_MAX + 5})`)
    expect(report).toContain(`  Extension ${EXTENSION_LINES_MAX - 1} 1.0\n  … et 5 de plus`)
    expect(report).not.toContain(`Extension ${EXTENSION_LINES_MAX} 1.0`)
  })

  it('writes the text of a manifest on one short line, with no control character, no path and no address', () => {
    const report = buildProblemReport(
      input({
        extensions: [
          { name: 'Évil\nName\u0007 at /Users/jane/Dev/ext/manifest.json', version: '1.0 (https://ext.example/update?id=jane&k=abc)', enabled: true },
          { name: 'x'.repeat(200), version: '2', enabled: true }
        ]
      })
    )
    expect(report).toContain('  Évil Name at manifest.json 1.0 (ext.example)')
    expect(report).toContain(`  ${'x'.repeat(EXTENSION_TEXT_MAX)}… 2`)
    expect(report).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/)
  })

  it('redacts the lines of the log again, whatever the log held: no path of a home, no address with a path or a query', () => {
    const report = buildProblemReport(
      input({
        log: [
          "2026-11-07T10:00:00.000Z [state] ENOENT: no such file or directory, open '/Users/jane/Library/Application Support/Lucium/state.json'",
          '2026-11-07T10:00:01.000Z [site] cannot load https://compte.example.com/factures/2026?token=abc123&user=jane#haut',
          '2026-11-07T10:00:02.000Z [x] at fn (file:///Users/jane/Dev/lucium/out/main/index.js:12:3) and ~/Documents/secret.txt'
        ]
      })
    )
    expect(report).not.toMatch(/\/Users|jane|Application Support|~\/|token|abc123|factures|\?|#haut|https?:\/\//)
    expect(report).toContain("open 'state.json'")
    expect(report).toContain('cannot load compte.example.com')
    expect(report).toContain('at fn (index.js:12:3) and secret.txt')
  })

  it('is in English when the language is, with no French word left', () => {
    setLanguage('en')
    const report = buildProblemReport(input())
    expect(report).toContain('Lucium support report —')
    expect(report).toContain('Nothing was sent: read it before you share it.')
    expect(report).toContain('Lucium 0.2.12 · Electron 45.0.0 · Chromium 156.0.8078.48 · DRM (castLabs) variant')
    expect(report).toContain('Extensions (2)\n  uBlock Origin 1.60.0\n  Dark Reader 4.9.90 (disabled)')
    expect(report).toContain('Features on (')
    expect(report).toContain('Error log (2 lines; paths reduced to the file name, addresses to the site name)')
    for (const french of ['Rapport', 'Fonctions', 'Journal', 'désactivée', 'variante']) expect(report, french).not.toContain(french)
  })

  it('stays under what the clipboard takes, with the most it can hold: sixty extensions of the longest name, fifty lines of the longest length', () => {
    const extensions = Array.from({ length: 300 }, (_, i) => ({ name: `${'N'.repeat(200)}${i}`, version: 'v'.repeat(200), enabled: i % 2 === 0 }))
    const log = Array.from({ length: 50 }, (_, i) => `2026-11-07T10:00:00.000Z ${'l'.repeat(300 + i)}`)
    const report = buildProblemReport(input({ extensions, log }))
    expect(report.length).toBeLessThan(CLIPBOARD_TEXT_MAX)
  })
})

describe('the report and the form of the site', () => {
  // What the community page of the site takes in its one text field (its `maxlength`, and the bound of the server); it takes no file.
  const FORM_MAX = 20_000
  const fullLog = Array.from({ length: 50 }, (_, i) => `2026-11-07T10:00:${String(i).padStart(2, '0')}.000Z [x] line ${i} ${'l'.repeat(290)}…`)

  it('fits in the form with room for the words of the person, with the most it can hold, in both languages', () => {
    expect(PROBLEM_REPORT_MAX).toBe(16_000)
    expect(PROBLEM_REPORT_MAX).toBeLessThanOrEqual(FORM_MAX - 1500)
    const extensions = Array.from({ length: 300 }, (_, i) => ({ name: `${'N'.repeat(200)}${i}`, version: 'v'.repeat(200), enabled: i % 2 === 0 }))
    const on = Object.assign({}, ...FEATURES.map((feature) => featurePatch(feature.id, true))) as Partial<Settings>
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      const report = buildProblemReport(input({ extensions, log: fullLog, settings: { ...defaultSettings(), ...on } }))
      expect(report.length, language).toBeLessThanOrEqual(PROBLEM_REPORT_MAX)
    }
  })

  it('keeps the newest lines of a full log, whole, and says how many older ones were left out', () => {
    setLanguage('fr')
    const report = buildProblemReport(input({ log: fullLog }))
    const lines = report.split('\n')
    const head = lines.findIndex((line) => line.startsWith('Journal des erreurs (50 lignes'))
    expect(head).toBeGreaterThan(0)
    const kept = lines.slice(head + 2)
    // Some fourteen thousand characters are left to the log: forty of these lines at least, where a shorter report kept a dozen.
    expect(kept.length).toBeGreaterThanOrEqual(40)
    expect(kept.length).toBeLessThan(50)
    expect(lines[head + 1]).toBe(frenchSpaces(`  … ${50 - kept.length} lignes plus anciennes laissées de côté : le rapport doit tenir dans le formulaire du site`))
    // The last lines of the log, in their order, none cut.
    expect(kept).toEqual(fullLog.slice(50 - kept.length).map((line) => `  ${line}`))
    expect(report.length).toBeLessThanOrEqual(PROBLEM_REPORT_MAX)
  })

  it('leaves a log that fits as it is, without a word about lines left out', () => {
    const report = buildProblemReport(input())
    expect(report).not.toContain('laissée')
    expect(report).toContain('[state] cannot read state.json')
  })

  it('counts the extensions past their share of the report instead of listing them, so that the log keeps its room', () => {
    const extensions = Array.from({ length: 40 }, (_, i) => ({ name: `${'N'.repeat(70)}${i}`, version: `1.${i}`, enabled: true }))
    const report = buildProblemReport(input({ extensions }))
    const block = report.split('Extensions (40)\n')[1]!.split('\n\n')[0]!
    const listed = block.split('\n')
    expect(block.length).toBeLessThanOrEqual(EXTENSION_LINES_BUDGET + 40)
    expect(listed.at(-1)).toBe(`  … et ${40 - (listed.length - 1)} de plus`)
    expect(listed.length - 1).toBeGreaterThan(10)
  })

  it('cuts a line that is alone longer than the room that is left, rather than dropping the whole log', () => {
    const report = buildProblemReport(input({ log: ['2026-11-07T10:00:00.000Z ' + 'x'.repeat(20000)] }))
    expect(report.length).toBeLessThanOrEqual(PROBLEM_REPORT_MAX)
    expect(report).toMatch(/\n  2026-11-07T10:00:00\.000Z x{1000,}…$/)
  })
})

describe('the name of the file', () => {
  it('is lucium-rapport- and the date of the day on this Mac, with two digits for the month and the day', () => {
    expect(reportFileName(new Date(2026, 10, 7, 23, 59).getTime())).toBe('lucium-rapport-2026-11-07.txt')
    expect(reportFileName(new Date(2027, 0, 3, 0, 0).getTime())).toBe('lucium-rapport-2027-01-03.txt')
  })
})

describe('the page of the site', () => {
  it('is the community page, in the language of the interface, on the site and over https', () => {
    expect(PROBLEM_SITE_URLS).toEqual({ fr: 'https://lucium.app/communaute/', en: 'https://lucium.app/en/community/' })
    for (const url of Object.values(PROBLEM_SITE_URLS)) expect(new URL(url).protocol).toBe('https:')
  })

  it('is asked for with a request that carries no address', () => {
    expect(PROBLEM_REPORT_REQUEST).toEqual({ panel: 'problemreport' })
  })
})
