// The rules of the sheet « Effacer les données du site » (renderer/SiteData.tsx), apart from its drawing so that they are tested without a window:
// what it starts with, what a key does in the field of the domains, what keeps a run from starting and how it is said, the run it asks
// for, what it remembers, and how the answer is summed up. The choices are those of the extension « Clear Domain Data » the sheet comes from.

import { t, tp } from './i18n'
import type { OverlayRequest } from './ipc'
import type { Settings } from './model'
import {
  MEDIA_LICENSE_TYPES,
  SITE_DATA_HOSTS_MAX,
  SITE_DATA_TYPES,
  allSitesCleared,
  describeSiteDataResult,
  erasesMediaLicenses,
  parseSiteHost,
  siteDataResultLabel,
  splitSiteHosts,
  type SiteDataBatchRequest,
  type SiteDataResult,
  type SiteDataResultType,
  type SiteDataSiteResult,
  type SiteDataType
} from './site-data'

/** The place of Réglages the sheet's settings button leads to: the group « Effacement des données du site » (confirmation, notice, animation) of Vie privée et sécurité. */
export const SITE_DATA_SETTINGS_REQUEST = { panel: 'settings', pane: 'protection', anchor: 'sitedata' } as const satisfies OverlayRequest

/** What the sheet reads of the settings. */
export type SheetSettings = Pick<Settings, 'siteDataTypes' | 'siteDataSubdomains' | 'siteDataReload' | 'siteDataAutoClose' | 'siteDataHttp'>

/** The types the sheet offers: every one, but the history in a private window, which keeps none. */
export const offeredSiteDataTypes = (isPrivate: boolean): SiteDataType[] => SITE_DATA_TYPES.filter((type) => !(isPrivate && type === 'history'))

/** The choices of the sheet, as it opens and as the user changes them. */
export interface SheetChoices {
  tags: string[]
  types: SiteDataType[]
  /** « Inclure HTTP ». */
  http: boolean
  /** « Sous-domaines ». */
  subdomains: boolean
  /** « Recharger l'onglet »: back to the root of the site. */
  reload: boolean
  /** « Fermeture auto »: the sheet closes at once and the run ends in the background. */
  autoClose: boolean
}

/**
 * What the sheet opens with: the site of the tab as the first tag (its port included, `localhost` and IP addresses as they are), the remembered
 * types and switches, and « Inclure HTTP » ticked for a page served over http (its data is stored under the http origin) or when it was
 * ticked by hand before. A tab that is not on a web page gives no tag.
 */
export function sheetStart(tabUrl: string | null | undefined, settings: SheetSettings, options: { private: boolean }): SheetChoices {
  const url = tabUrl && /^https?:\/\//i.test(tabUrl) && URL.canParse(tabUrl) ? new URL(tabUrl) : null
  const site = url ? parseSiteHost(url.host) : null
  const offered = offeredSiteDataTypes(options.private)
  return {
    tags: site ? [site.host] : [],
    types: settings.siteDataTypes.filter((type) => offered.includes(type)),
    http: settings.siteDataHttp || url?.protocol === 'http:',
    subdomains: settings.siteDataSubdomains,
    reload: settings.siteDataReload,
    autoClose: settings.siteDataAutoClose
  }
}

/** The sites of a run: the tags, then what is still typed in the field (a site typed and not added is not lost when the button is pressed). */
export function sheetHosts(tags: readonly string[], draft: string): { hosts: string[]; draftInvalid: boolean } {
  const typed = splitSiteHosts(draft).map((token) => parseSiteHost(token))
  return {
    hosts: [...new Set([...tags, ...typed.flatMap((site) => (site ? [site.host] : []))])],
    draftInvalid: typed.some((site) => site === null)
  }
}

/**
 * The tags once `list` is added to them: each site once, and no more than a run takes. What is past the limit is left out and `refused` says so:
 * a long list pasted in the field used to become as many tags, and as many requests to count their cookies, before the button refused it.
 */
export function addSheetSites(tags: readonly string[], list: readonly string[]): { tags: string[]; refused: boolean } {
  const all = [...new Set([...tags, ...list.flatMap((host) => parseSiteHost(host)?.host ?? [])])]
  return { tags: all.slice(0, Math.max(tags.length, SITE_DATA_HOSTS_MAX)), refused: all.length > Math.max(tags.length, SITE_DATA_HOSTS_MAX) }
}

/** What a key does in the field of the domains. */
export type SheetKeyAction = 'take' | 'clear' | 'remove-last' | null

/**
 * Enter adds what is typed as a tag, or starts the run when the field is empty (as the button does, with the same checks); Backspace in
 * an empty field takes the last tag away. Anything else is typing.
 */
export function sheetKeyAction(key: string, draft: string, tagCount: number): SheetKeyAction {
  if (key === 'Enter') return draft.trim() !== '' ? 'take' : 'clear'
  if (key === 'Backspace' && draft === '' && tagCount > 0) return 'remove-last'
  return null
}

/** Why a run cannot start: no site, a typed site that is not one, too many sites, no type ticked. */
export type SheetProblem = 'no-site' | 'invalid' | 'too-many' | 'no-type'

/** The first reason a run cannot start, in the order the extension checks (the site, then the types), or null when it can. */
export function sheetProblem(input: { hosts: readonly string[]; draftInvalid: boolean; types: readonly SiteDataType[] }): SheetProblem | null {
  if (input.draftInvalid) return 'invalid'
  if (input.hosts.length === 0) return 'no-site'
  if (input.hosts.length > SITE_DATA_HOSTS_MAX) return 'too-many'
  if (input.types.length === 0) return 'no-type'
  return null
}

/** The line under the switches that says it. */
export function sheetProblemText(problem: SheetProblem): string {
  switch (problem) {
    case 'no-site':
      return t('site-data.entrez-un-domaine')
    case 'no-type':
      return t('site-data.selectionnez-au-moins-un-type')
    case 'invalid':
      return t('site-data.adresse-non-valide-domaine-localhost-ip')
    case 'too-many':
      return t('site-data.max-sites-au-plus-a-la-fois', { max: SITE_DATA_HOSTS_MAX })
  }
}

/** The run the button asks for: the sites, the ticked types in the panel's order, the two scopes, the reload, and whether the sheet waits for the answer. */
export function sheetRequest(hosts: readonly string[], choices: Omit<SheetChoices, 'tags'>): SiteDataBatchRequest {
  return {
    hosts: [...hosts],
    types: SITE_DATA_TYPES.filter((type) => choices.types.includes(type)),
    subdomains: choices.subdomains,
    http: choices.http,
    reload: choices.reload,
    detached: choices.autoClose
  }
}

/**
 * What a run remembers for the next one. « Inclure HTTP » is remembered only when the user flipped it: ticked by itself for a page served over
 * http, it must not stay ticked for the https sites after.
 */
export function rememberedChoices(choices: Omit<SheetChoices, 'tags'>, options: { httpChosen: boolean; settings: SheetSettings }): Pick<Settings, 'siteDataTypes' | 'siteDataSubdomains' | 'siteDataReload' | 'siteDataAutoClose' | 'siteDataHttp'> {
  return {
    siteDataTypes: SITE_DATA_TYPES.filter((type) => choices.types.includes(type)),
    siteDataSubdomains: choices.subdomains,
    siteDataReload: choices.reload,
    siteDataAutoClose: choices.autoClose,
    siteDataHttp: options.httpChosen ? choices.http : options.settings.siteDataHttp
  }
}

/** The banner of the answer: the run went through, or how many operations failed, and whether the tab was left as it was. */
export function resultsSummary(results: readonly SiteDataSiteResult[], options: { reload: boolean }): { ok: boolean; title: string; detail: string } {
  const operations = results.flatMap((site) => site.results)
  const failed = operations.filter((result) => !result.ok).length
  if (allSitesCleared(results)) return { ok: true, title: t('site-data.donnees-effacees'), detail: tp('site-data.operations-reussies', operations.length) }
  // A site with no answer at all failed without a line to count: it counts as one failure.
  const missing = results.filter((site) => site.results.length === 0).length
  const detail = t('site-data.reussies-ok-echecs-failed', { ok: operations.length - failed, failed: failed + missing })
  return { ok: false, title: tp('site-data.termine-avec-erreurs', failed + missing), detail: options.reload ? `${detail} · ${t('site-data.onglet-non-recharge')}` : detail }
}

/**
 * What the sheet says of the licences of protected video for the types ticked: they go with the rest, or they stay and why. Null (nothing is
 * said) when none of the storage their erasure takes is ticked: someone who erases the network cache or the history alone expects no licence to go.
 */
export function licencesNoteKey(types: readonly SiteDataType[]): 'site-data.note-licences-effacees' | 'site-data.note-licences-gardees' | null {
  if (erasesMediaLicenses(types)) return 'site-data.note-licences-effacees'
  return MEDIA_LICENSE_TYPES.some((type) => types.includes(type)) ? 'site-data.note-licences-gardees' : null
}

/** One chip of a site's card: the type, whether it went, its count when the engine gave one, and the sentence a tooltip says. */
export function resultChip(result: SiteDataResult): { type: SiteDataResultType; ok: boolean; label: string; count: number | null; title: string } {
  // A list that could not be whole is said on the chip itself, not only in its tooltip.
  const label = result.ok && result.seenOnly ? t('site-data.sous-domaines-vus-seulement') : siteDataResultLabel(result.type)
  return { type: result.type, ok: result.ok, label, count: result.ok && result.count !== undefined && result.count > 0 ? result.count : null, title: describeSiteDataResult(result) }
}

/** The lines under a site's chips: each failure with what the engine said. */
export const resultErrors = (results: readonly SiteDataResult[]): string[] =>
  results.filter((result) => !result.ok).map((result) => `${siteDataResultLabel(result.type)} — ${result.error ?? t('site-data.echec')}`)
