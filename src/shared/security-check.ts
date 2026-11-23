// « Vérification de sécurité » (Réglages › Vie privée et sécurité): one page that reads, and changes nothing, what protects the browsing: the
// extensions, the answers remembered for the sites, the protections, the updates and the vault. Every line comes from what the settings, the list of
// extensions and the answers to the sites already say: nothing is measured, asked of the network or sent, and no button here writes a setting.
//
// Pure: the page (src/renderer/SecurityCheck.tsx) draws what this gives. The words are keys of the catalogues, read when the page is drawn.

import { autoUpdateKey, autoUpdateOn } from './platform'
import { adsBlockingOn } from './blocker'
import { tp, t, type MessageKey } from './i18n'
import type { EngineInfo, ExtensionInfo } from './ipc'
import type { PermissionDecision, Settings } from './model'
import { sitesWithAnswers } from './permissions'

/** How a line stands: `good` is in order, `check` is worth a look, `info` only says what is. */
export type CheckStatus = 'good' | 'check' | 'info'

export type CheckArea = 'extensions' | 'permissions' | 'protection' | 'updates' | 'vault'

/** The areas, in the order the page shows them. */
export const CHECK_AREAS: readonly CheckArea[] = ['extensions', 'permissions', 'protection', 'updates', 'vault']

export interface CheckRow {
  id: string
  area: CheckArea
  status: CheckStatus
  /** One sentence, in the language of the moment. */
  text: string
  /** Where the line is set, when a setting changes it (the id of a place of `SETTINGS_PLACES`, shared/settings-path.ts). */
  where?: 'protection' | 'blockers' | 'thirdPartyCookies' | 'forgetUnusedPermissions' | 'lock' | 'passwords' | 'extensions' | 'autoUpdate'
}

/** What the lines are read from: the settings, the answers to the sites, the extensions as the interface lists them, and the engine. */
export interface SecurityFacts {
  settings: Settings
  sitePermissions: Readonly<Record<string, Readonly<Record<string, PermissionDecision>>>>
  extensions: ReadonlyArray<Pick<ExtensionInfo, 'id' | 'enabled' | 'source' | 'update'>>
  engine?: Pick<EngineInfo, 'name' | 'version'>
  /** The system the application runs on (`snapshot.platform`): it says which switch of the automatic check is the person's (shared/platform.ts, `autoUpdateOn`). Absent, the macOS one. */
  platform?: string
}

/** The permissions that give a site a view of the person or of the screen: a remembered « allow » for one of them is worth a second look. */
export const SENSITIVE_PERMISSIONS: ReadonlySet<string> = new Set(['media', 'camera', 'microphone', 'geolocation', 'display-capture'])

const distinctIds = (extensions: SecurityFacts['extensions']): string[] => [...new Set(extensions.map((extension) => extension.id))]

/** The sites that were allowed a sensitive permission and keep that answer. */
export function sitesAllowedSensitive(sitePermissions: SecurityFacts['sitePermissions']): number {
  return sitesWithAnswers(sitePermissions as Record<string, Record<string, PermissionDecision>>).filter(([, answers]) => Object.entries(answers).some(([permission, decision]) => decision === 'allow' && SENSITIVE_PERMISSIONS.has(permission))).length
}

/** A line that is in order when a setting is on, and worth a look when it is off. */
const switched = (area: CheckArea, on: boolean, id: string, onKey: MessageKey, offKey: MessageKey, where: CheckRow['where']): CheckRow => ({
  id,
  area,
  status: on ? 'good' : 'check',
  text: t(on ? onKey : offKey),
  where
})

/** Every line of the page, area by area. */
export function securityCheck(facts: SecurityFacts): CheckRow[] {
  const { settings } = facts
  const rows: CheckRow[] = []

  // Extensions: the ones that are on, those loaded from a folder (no store looked at them), and the updates that wait for an answer.
  const active = facts.extensions.filter((extension) => extension.enabled)
  const unpacked = distinctIds(active.filter((extension) => extension.source === 'unpacked'))
  const waiting = distinctIds(facts.extensions.filter((extension) => extension.update !== undefined))
  const activeIds = distinctIds(active)
  rows.push(
    activeIds.length === 0
      ? { id: 'ext-none', area: 'extensions', status: 'good', text: t('security-check.ext-none'), where: 'extensions' }
      : { id: 'ext-count', area: 'extensions', status: 'info', text: tp('security-check.ext-count', activeIds.length), where: 'extensions' }
  )
  if (unpacked.length > 0) rows.push({ id: 'ext-unpacked', area: 'extensions', status: 'check', text: tp('security-check.ext-unpacked', unpacked.length), where: 'extensions' })
  if (waiting.length > 0) rows.push({ id: 'ext-update', area: 'extensions', status: 'check', text: tp('security-check.ext-update', waiting.length), where: 'extensions' })

  // Permissions: how many sites keep an answer, how many may use the camera, the microphone, the position or the screen unasked, and the delay that forgets them.
  const remembered = sitesWithAnswers(facts.sitePermissions as Record<string, Record<string, PermissionDecision>>).length
  rows.push(remembered === 0 ? { id: 'perm-none', area: 'permissions', status: 'good', text: t('security-check.perm-none') } : { id: 'perm-sites', area: 'permissions', status: 'info', text: tp('security-check.perm-sites', remembered) })
  const sensitive = sitesAllowedSensitive(facts.sitePermissions)
  if (sensitive > 0) rows.push({ id: 'perm-sensitive', area: 'permissions', status: 'check', text: tp('security-check.perm-sensitive', sensitive) })
  rows.push(
    settings.forgetUnusedPermissionsDays > 0
      ? { id: 'perm-forget', area: 'permissions', status: 'good', text: t('security-check.perm-forget-on', { days: String(settings.forgetUnusedPermissionsDays) }), where: 'forgetUnusedPermissions' }
      : { id: 'perm-forget', area: 'permissions', status: 'info', text: t('security-check.perm-forget-off'), where: 'forgetUnusedPermissions' }
  )

  // Protection: the blocker and the privacy options, each said on or off.
  rows.push(switched('protection', adsBlockingOn(settings), 'prot-blocker', 'security-check.prot-blocker-on', 'security-check.prot-blocker-off', 'blockers'))
  rows.push(switched('protection', settings.httpsUpgrade, 'prot-https', 'security-check.prot-https-on', 'security-check.prot-https-off', 'protection'))
  rows.push(switched('protection', settings.blockThirdPartyCookies, 'prot-cookies', 'security-check.prot-cookies-on', 'security-check.prot-cookies-off', 'thirdPartyCookies'))
  rows.push(switched('protection', settings.stripTrackingParams, 'prot-params', 'security-check.prot-params-on', 'security-check.prot-params-off', 'protection'))
  rows.push(switched('protection', settings.sendGpc, 'prot-gpc', 'security-check.prot-gpc-on', 'security-check.prot-gpc-off', 'protection'))
  rows.push(switched('protection', settings.reduceFingerprint, 'prot-fingerprint', 'security-check.prot-fingerprint-on', 'security-check.prot-fingerprint-off', 'protection'))

  // Updates: whether the automatic check is switched on (it makes no request in a build that has no feed address, so the line promises no frequency), and the version that runs.
  // On Windows the line reads that system's own switch, which is off by default: off is a choice there, said without asking for a look.
  const updateOn = autoUpdateOn(settings, facts.platform)
  // `where` is the place of « Mises à jour »: the Windows switch is on the same page as the other one.
  const updateRow = switched('updates', updateOn, 'upd-auto', 'security-check.upd-auto-on', 'security-check.upd-auto-off', 'autoUpdate')
  rows.push(!updateOn && autoUpdateKey(facts.platform) === 'windowsAutoUpdate' ? { ...updateRow, status: 'info' } : updateRow)
  if (facts.engine) rows.push({ id: 'upd-version', area: 'updates', status: 'info', text: t('security-check.upd-version', { name: facts.engine.name, version: facts.engine.version }) })

  // The vault: said only when the password manager is on; its lock and its fingerprint at each fill.
  if (!settings.passwordManager) rows.push({ id: 'vault-off', area: 'vault', status: 'info', text: t('pwd.le-gestionnaire-de-mots-de-passe-est-desactive'), where: 'passwords' })
  else {
    rows.push(switched('vault', settings.lockEnabled, 'vault-lock', 'security-check.vault-lock-on', 'security-check.vault-lock-off', 'lock'))
    rows.push({ id: 'vault-touch', area: 'vault', status: settings.passwordTouchIdOnFill ? 'good' : 'info', text: t(settings.passwordTouchIdOnFill ? 'security-check.vault-touch-on' : 'security-check.vault-touch-off'), where: 'passwords' })
  }
  return rows
}

/** How many lines are worth a look. */
export const checksToReview = (rows: readonly CheckRow[]): number => rows.filter((row) => row.status === 'check').length

/** What the row that opens the page says: how many lines are worth a look, or that none is. */
export const securityCheckSummary = (rows: readonly CheckRow[]): string => {
  const count = checksToReview(rows)
  return count === 0 ? t('security-check.summary-none') : tp('security-check.summary-check', count)
}
