// "À propos de Lucium": who makes it, under which licence, where the code lives. The texts and addresses below are the only copy:
// the About group of Settings › À propos et mises à jour and the macOS About panel both read them, so the two cannot disagree. Nothing here reaches the
// network; an address is only ever followed when the user clicks it, and then it is an ordinary tab of the browser.

import { t } from './i18n'
import { updatesByHand, updatesOnDemandOnly } from './platform'

export const ABOUT_NAME = 'Lucium'
export const ABOUT_LICENSE = 'GPL-3.0-or-later'
export const ABOUT_YEAR = 2026
export const ABOUT_COMPANY = 'ConsilioWeb'

/** The company's site, shown as "consilioweb.fr". */
export const COMPANY_URL = 'https://consilioweb.fr'
/**
 * The address of the repository. This one line moves the "source", "issues" and "news" links; the files that cannot import it write the same address
 * (electron-builder.yml, the issue forms, the user agents of the scripts: test src/main/platform/build-files.test.ts).
 */
export const REPOSITORY_URL = 'https://github.com/pOwn3d/Lucium'
export const ISSUES_URL = `${REPOSITORY_URL}/issues`
/** The licences of the components, in the documentation shipped with the application (docs/ of the resources). */
export const LICENSES_DOC = 'docs/licences-tierces.md'

// The sentences are read in the language of the interface when they are shown: functions, not constants (a constant would be French forever).
export const aboutTagline = (): string => t('about.navigateur-libre-et-communautaire-licence', { license: ABOUT_LICENSE })
export const aboutCredit = (): string => t('about.un-projet-de-company', { company: ABOUT_COMPANY })
export const aboutCopyright = (): string => t('about-window.droits', { year: ABOUT_YEAR, company: ABOUT_COMPANY })
export const aboutFootnote = (): string => t('about.rien-n-est-envoye-a-company', { company: ABOUT_COMPANY })

/** What a link of the About group can ask for. The interface sends one of these words, never an address. */
export const ABOUT_TARGETS = ['site', 'source', 'issues', 'news', 'licenses'] as const
export type AboutTarget = (typeof ABOUT_TARGETS)[number]

/** The word a message from the interface carries, or null when it is anything else (an address, a path, another type). */
export function parseAboutTarget(raw: unknown): AboutTarget | null {
  return typeof raw === 'string' && (ABOUT_TARGETS as readonly string[]).includes(raw) ? (raw as AboutTarget) : null
}

const WEB_ADDRESSES = { site: COMPANY_URL, source: REPOSITORY_URL, issues: ISSUES_URL, news: `${REPOSITORY_URL}/releases` } as const

/** The address a link opens in a tab, or null for the licences: a file of the documentation, which the system opens. */
export function aboutUrl(target: AboutTarget): string | null {
  return target === 'licenses' ? null : WEB_ADDRESSES[target]
}

/** An address as it is shown next to its link: no scheme, no closing slash ("github.com/pOwn3d/Lucium"). */
export function displayAddress(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/\/$/, '')
}

export interface AboutRow {
  target: AboutTarget
  label: string
  /** Where the link leads, as the group shows it. */
  detail: string
}

/** The five links of the group, in order. */
export const ABOUT_ROWS: readonly AboutRow[] = [
  { target: 'site', get label() { return aboutCredit() }, detail: displayAddress(COMPANY_URL) },
  { target: 'source', get label() { return t('about.code-source-et-contributions') }, detail: displayAddress(REPOSITORY_URL) },
  { target: 'issues', get label() { return t('about.signaler-un-probleme') }, detail: displayAddress(ISSUES_URL) },
  { target: 'news', get label() { return t('about.nouveautes') }, detail: displayAddress(`${REPOSITORY_URL}/releases`) },
  { target: 'licenses', get label() { return t('about.licences-des-composants') }, detail: LICENSES_DOC }
]

const VERSION = /^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]{1,32})?$/

/** The version of the application ("0.1.0"), or '' when what the main process reported is not a version. */
export function aboutVersion(raw: unknown): string {
  return typeof raw === 'string' && VERSION.test(raw) ? raw : ''
}

/** "Version 0.1.0", or "Version inconnue" when there is none to show. */
export function aboutVersionLabel(raw: unknown): string {
  const version = aboutVersion(raw)
  return version ? t('about.version-version', { version }) : t('about.version-inconnue')
}

/** The options of `app.setAboutPanelOptions` (macOS About panel), all text, in the language of the main process when they are built. */
export interface AboutPanelOptions {
  applicationName: string
  applicationVersion: string
  /** The build number the panel shows in parentheses after the version: empty, since the version is the only number there is. */
  version: string
  copyright: string
  credits: string
}

export function aboutPanelOptions(version: unknown): AboutPanelOptions {
  return {
    applicationName: ABOUT_NAME,
    applicationVersion: aboutVersion(version) || t('about.inconnue'),
    version: '',
    copyright: aboutCopyright(),
    credits: [t('about.navigateur-libre-et-communautaire-gratuit'), t('about.licence-license', { license: ABOUT_LICENSE }), COMPANY_URL].join('\n')
  }
}

/** The engine under the browser, as the About window says it (major versions: "Chromium 156"). */
export interface AboutEngine {
  chromium: string
  electron: string
  platform: string
  /** This system has no update installer (Linux: shared/platform.ts, `updatesByHand`): the window says where to download the latest version instead of naming a setting. Absent on macOS and Windows. */
  updatesByHand?: true
  /** This system installs an update but never looks by itself (Windows, `updatesOnDemandOnly`): the window says the button is the only look, instead of naming a switch it does not have. Absent elsewhere. */
  updatesOnDemandOnly?: true
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }
const majorOf = (version: unknown): string => (typeof version === 'string' ? (/^\d+/.exec(version)?.[0] ?? '') : '')

/** What the main process knows (`process.versions`, `process.platform`) as the three words of the window; a version that is not one is left out. */
export function aboutEngine(versions: { chrome?: unknown; electron?: unknown }, platform: string): AboutEngine {
  return { chromium: majorOf(versions.chrome), electron: majorOf(versions.electron), platform: PLATFORM_NAMES[platform] ?? platform, ...(updatesByHand(platform) ? { updatesByHand: true as const } : {}), ...(updatesOnDemandOnly(platform) ? { updatesOnDemandOnly: true as const } : {}) }
}

/**
 * The note under the button « Rechercher les mises à jour » of the About window. With a background look to switch (macOS, and while the engine is not
 * known yet) it says the button looks at once whether or not that switch is on; on Linux, which has none, it says where the button leads; on Windows, that the button
 * is the only look.
 */
export function aboutCheckNote(engine: AboutEngine | null): string {
  if (engine?.updatesOnDemandOnly === true) return t('about-window.cherche-maintenant-sur-demande')
  return engine?.updatesByHand === true ? t('about-window.cette-version-ne-se-met-pas-a-jour') : t('about-window.cherche-maintenant-setting', { setting: t('features.rechercher-les-mises-a-jour-automatiquement') })
}

/** "Chromium 156 · Electron 45 · macOS": the parts there are. */
export function aboutEngineLabel(engine: AboutEngine): string {
  return [engine.chromium && `Chromium ${engine.chromium}`, engine.electron && `Electron ${engine.electron}`, engine.platform].filter(Boolean).join(' · ')
}

/** The line a bug report starts with, copied by the window: "Lucium 0.2.0 · Chromium 156 · Electron 45 · macOS". */
export function aboutReport(version: unknown, engine: AboutEngine): string {
  return [`${ABOUT_NAME} ${aboutVersion(version) || t('about.version-inconnue-2')}`, aboutEngineLabel(engine)].filter(Boolean).join(' · ')
}
