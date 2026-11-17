// « Signaler un problème… » (Aide): a report in plain text that the user reads before anything leaves the Mac. It is built here, from the numbers and names
// the main process hands over (main/shell/problem-report.ts); nothing is sent by Lucium: the sheet shows it, and « Copier » / « Enregistrer… » put it where the
// user chooses, to attach to a message of their own (the page of the site, the issues of the repository).
//
// What it holds: the version and the variant of Lucium, the engine, the system, the extensions (name and version), the features that are on (their ids in the
// catalogue of features.ts) and the lines of the error log, which are redacted again here (a path keeps its file name, an address its host). No page, no title,
// no setting other than the on/off of a feature, no secret. The lines of the log are the application's own words: one may name the host of a site (the
// origin a permission was refused for, the host of a feed that failed) and the internal id of a profile or of an extension. The person reads them before sending.
//
// It is bounded (`PROBLEM_REPORT_MAX`): the form of the community page takes one text of 20 000 characters and no file, so the report must fit in it with
// the person's own words. What gives way is said in the report: the extensions past their share are counted, and the oldest lines of the log are left out.

import { formatWhen, platformName, variantName, widevineText, type EngineHost } from './engine-status'
import { FEATURES, isFeatureOn } from './features'
import { t, tp, type Language } from './i18n'
import type { ExtensionInfo, OverlayRequest } from './ipc'
import { redactLogLine } from './log-redaction'
import type { Settings } from './model'

/** What the report is made from: every field is a version, a name of an extension, the on/off of a feature or a line of the log. */
export interface ProblemReportInput {
  now: number
  appVersion: string
  engine: { electron: string; chromium: string }
  variant: EngineHost['variant']
  /** The Widevine module's version when it is installed, else null. */
  widevine: string | null
  platform: string
  /** The version of the system (`process.getSystemVersion()`: "15.1.0"), '' when it cannot be said. */
  systemVersion: string
  arch: string
  /** Every copy of every extension, in every profile. */
  extensions: readonly Pick<ExtensionInfo, 'name' | 'version' | 'enabled'>[]
  settings: Settings
  /** The lines of the error log, oldest first. */
  log: readonly string[]
}

/** The extensions listed in the report; the others are counted. */
export const EXTENSION_LINES_MAX = 60
/** A name or a version of an extension is cut here: it is text of the extension's manifest. */
export const EXTENSION_TEXT_MAX = 60
/**
 * The longest report: the form of the community page of the site takes 20 000 characters in its one text field (`maxlength` of the page, and the
 * server refuses more), and no file. What is left under that is for the words of the person who writes.
 */
export const PROBLEM_REPORT_MAX = 16_000
/** The share of the report the lines of the extensions may take: past it they are counted, so that the log keeps most of the room. */
export const EXTENSION_LINES_BUDGET = 1500
/** A line of the list of features is cut where it reaches this width. */
const LIST_WIDTH = 88

/** One line of a manifest's text: no control character, no line break, no path or address, cut short. */
function plain(text: string): string {
  const line = redactLogLine(String(text).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim())
  return line.length > EXTENSION_TEXT_MAX ? `${line.slice(0, EXTENSION_TEXT_MAX)}…` : line
}

/** The items of a list on lines of about `LIST_WIDTH` characters, each line indented. */
function wrapped(items: readonly string[]): string[] {
  const lines: string[] = []
  let line = ''
  for (const item of items) {
    const next = line === '' ? item : `${line}, ${item}`
    if (line !== '' && next.length > LIST_WIDTH) {
      lines.push(`  ${line},`)
      line = item
    } else {
      line = next
    }
  }
  if (line !== '') lines.push(`  ${line}`)
  return lines
}

/** The extensions of the report: one line each ("Name 1.2.3", "Name 1.2.3 (désactivée)"), the same copy in several profiles once. */
function extensionLines(extensions: ProblemReportInput['extensions']): string[] {
  if (extensions.length === 0) return [t('problem-report.extensions-aucune')]
  const lines = [...new Set(extensions.map((extension) => `${plain(extension.name)} ${plain(extension.version)}`.trim() + (extension.enabled ? '' : ` ${t('problem-report.desactivee')}`)))]
  const shown: string[] = []
  let used = 0
  for (const line of lines.slice(0, EXTENSION_LINES_MAX)) {
    used += line.length + 3
    if (used > EXTENSION_LINES_BUDGET) break
    shown.push(`  ${line}`)
  }
  return [t('problem-report.extensions-count', { count: lines.length }), ...shown, ...(lines.length > shown.length ? [`  ${t('problem-report.et-count-de-plus', { count: lines.length - shown.length })}`] : [])]
}

/**
 * The lines of the log that fit in `room` characters, the newest kept (the oldest are the ones left out, and the report says how many): what just
 * happened is what a report is read for.
 */
function logLines(log: readonly string[], room: number): string[] {
  if (log.length === 0) return [t('problem-report.journal-vide')]
  const head = tp('problem-report.journal-count-lignes', log.length)
  // The line that says how many were left out is counted before it is known to be needed: the report must fit either way.
  let left = room - head.length - tp('problem-report.journal-lignes-anciennes-omises', log.length).length - 4
  const kept: string[] = []
  for (let i = log.length - 1; i >= 0 && left > 3; i--) {
    const line = redactLogLine(log[i]!)
    const whole = line.length + 3 <= left
    // A line that does not fit ends the list; only the newest one is cut instead, so that a report never comes without its last error.
    if (!whole && kept.length > 0) break
    const cut = whole ? line : `${line.slice(0, left - 4)}…`
    kept.unshift(`  ${cut}`)
    left -= cut.length + 3
  }
  const omitted = log.length - kept.length
  return [head, ...(omitted > 0 ? [`  ${tp('problem-report.journal-lignes-anciennes-omises', omitted)}`] : []), ...kept]
}

/** The report, as plain text. */
export function buildProblemReport(input: ProblemReportInput): string {
  const on = FEATURES.filter((feature) => isFeatureOn(input.settings, feature.id)).map((feature) => feature.id)
  const system = [platformName(input.platform), input.systemVersion].filter((part) => part !== '').join(' ')
  const head = [
    t('problem-report.rapport-pour-le-support-date', { date: formatWhen(input.now) }),
    t('problem-report.prepare-sur-ce-mac'),
    '',
    t('engine-status.versions-line', { app: input.appVersion || '?', electron: input.engine.electron, chromium: input.engine.chromium, variant: variantName(input.variant) }),
    t('engine-status.widevine-line', { state: widevineText(input.widevine) }),
    `${system} · ${input.arch}`,
    '',
    ...extensionLines(input.extensions),
    '',
    on.length === 0 ? t('problem-report.fonctions-aucune') : t('problem-report.fonctions-count', { count: on.length }),
    ...wrapped(on),
    ''
  ].join('\n')
  return [head, ...logLines(input.log, PROBLEM_REPORT_MAX - head.length - 1)].join('\n')
}

/** The sheet, as Aide › Signaler un problème… asks for it. The interface cannot ask for it (main/shell/ipc.ts `validOverlay`), and a private window does not open it. */
export const PROBLEM_REPORT_REQUEST: OverlayRequest = { panel: 'problemreport' }

/** `lucium-rapport-2026-11-07.txt`: the name the save dialog proposes, with the date of the day on this Mac. */
export function reportFileName(now: number): string {
  const day = new Date(now)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `lucium-rapport-${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}.txt`
}

/**
 * The page of the site where a request is made without a GitHub account (SUPPORT.md): the community page, in the language of the interface. The address is
 * here and nowhere else; the interface asks for « the page of the site » (`Channel.openProblemSite`) and never sends an address.
 */
export const PROBLEM_SITE_URLS: Readonly<Record<Language, string>> = {
  fr: 'https://lucium.app/communaute/',
  en: 'https://lucium.app/en/community/'
}

/** The answer of « Enregistrer… »: where the report went (the file name only), that the user gave up, or why it could not be written. */
export type ProblemReportSave = { status: 'saved'; file: string } | { status: 'canceled' } | { status: 'failed'; message: string }

/** What the sheet is made from while the main process prepares the report. */
export type ProblemReportView = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; text: string }
