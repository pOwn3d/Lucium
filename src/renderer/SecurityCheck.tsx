// Settings › Vie privée et sécurité › Vérification de sécurité: what protects the browsing, read again from the settings, the list of extensions and the
// answers to the sites (shared/security-check.ts). Read-only: no line has a switch, and none writes a setting; the line says where to set it.

import type { UiSnapshot } from '@shared/ipc'
import { CHECK_AREAS, securityCheck, type CheckArea, type CheckStatus } from '@shared/security-check'
import { settingsPath } from '@shared/settings-path'
import { t, type MessageKey } from '@shared/i18n'
import { Group, Row } from './settings-parts'
import './insight.css'

const AREA_TITLES: Record<CheckArea, MessageKey> = {
  extensions: 'security-check.area-extensions',
  permissions: 'security-check.area-permissions',
  protection: 'security-check.area-protection',
  updates: 'security-check.area-updates',
  vault: 'security-check.area-vault'
}

const STATUS_WORDS: Record<CheckStatus, MessageKey> = {
  good: 'security-check.status-good',
  check: 'security-check.status-check',
  info: 'security-check.status-info'
}

/** The lines of the check as the page draws them, area by area. */
export function SecurityCheck({ snapshot }: { snapshot: UiSnapshot }) {
  const { settings, sitePermissions } = snapshot.state
  const rows = securityCheck({ settings, sitePermissions, extensions: snapshot.extensions, engine: snapshot.engine })
  return (
    <>
      {CHECK_AREAS.map((area) => {
        const lines = rows.filter((row) => row.area === area)
        return (
          <Group key={area} id={`securitycheck-${area}`} title={t(AREA_TITLES[area])}>
            {lines.map((line) => (
              <Row key={line.id} label={line.text} hint={line.where ? t('security-check.where', { path: settingsPath(line.where) }) : undefined}>
                <span className={`check-status ${line.status}`}>{t(STATUS_WORDS[line.status])}</span>
              </Row>
            ))}
          </Group>
        )
      })}
    </>
  )
}
