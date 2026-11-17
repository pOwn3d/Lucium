// The automatic copies of the session (Settings › Téléchargements et fichiers, above « Exporter les données », which waits in « Plus de réglages »): whether Lucium keeps a few dated copies of the
// spaces and tabs, how often, and how many. On by default; the copies stay in the data folder of the application and go nowhere.
// The copies themselves are listed and restored in the panel of File › Sessions… .

import { BACKUP_KEEP_CHOICES, BACKUP_MINUTES_CHOICES, minutesLabel } from '@shared/backup-settings'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { Check, Choice, Group, Row } from './settings-parts'
import { t } from '@shared/i18n'

export function BackupSettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  return (
    <Group
      title={t('backup-settings.copies-automatiques')}
      footnote={t('backup-settings.les-copies-restent-sur-ce-mac-et-ne-sont')} more={t('backup-settings.les-copies-restent-sur-ce-mac-dans-le')}
    >
      <Check
        settingKey="autoBackup"
        label={t('backup-settings.garder-des-copies-automatiques-de-mes-espaces')}
        hint={t('backup-settings.pour-revenir-a-un-etat-d-avant-une')}
        checked={settings.autoBackup}
        onChange={(autoBackup) => update({ autoBackup })}
      />
      <Row settingKey="autoBackupMinutes" label={t('backup-settings.une-copie-au-plus-toutes-les')}>
        <Choice className="pop" label={t('backup-settings.delai-entre-deux-copies')} disabled={!settings.autoBackup} value={settings.autoBackupMinutes} choices={BACKUP_MINUTES_CHOICES.map((m): [number, string] => [m, minutesLabel(m)])} onChange={(autoBackupMinutes) => update({ autoBackupMinutes })} />
      </Row>
      <Row settingKey="autoBackupKeep" label={t('backup-settings.copies-conservees')} hint={t('backup-settings.au-dela-la-plus-ancienne-copie-automatique')} more={t('backup-settings.la-plus-ancienne-est-supprimee-quand-une')}>
        <Choice className="pop" label={t('backup-settings.nombre-de-copies-conservees')} disabled={!settings.autoBackup} value={settings.autoBackupKeep} choices={BACKUP_KEEP_CHOICES.map((n): [number, string] => [n, String(n)])} onChange={(autoBackupKeep) => update({ autoBackupKeep })} />
      </Row>
    </Group>
  )
}
