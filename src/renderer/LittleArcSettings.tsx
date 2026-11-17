// The mini window (Settings › Navigation › Plus de réglages): what the Links pane does not have. The delay before a forgotten window is archived stays in Liens,
// and nothing is added to that pane. The note says so, and that the pin "Garder ouvert" of a window's header leaves it out of that archiving.
// Rendered by the Advanced pane (SettingsWindow.tsx), before the About group.

import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { Check, Group } from './settings-parts'
import { t } from '@shared/i18n'

export function LittleArcSettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  return (
    <Group
      title={t('little-arc-settings.mini-fenetre')}
      footnote={t('little-arc-settings.ces-options-ne-touchent-pas-les-fenetres-et')}
      more={[t('little-arc-settings.le-delai-avant-l-archivage-d-une-fenetre'), t('little-arc-settings.garder-ouvert-exempte')]}
    >
      <Check
        settingKey="littleArcNewTabLinks"
        label={t('little-arc-settings.liens-nouvel-onglet-en-mini-fenetre')}
        hint={t('little-arc-settings.liens-nouvel-onglet-en-mini-fenetre-ligne')} more={t('little-arc-settings.liens-nouvel-onglet-en-mini-fenetre-aide')}
        checked={settings.littleArcNewTabLinks}
        onChange={(littleArcNewTabLinks) => update({ littleArcNewTabLinks })}
      />
      <Check
        settingKey="littleArcModifier"
        label={t('little-arc-settings.ouvrir-un-lien-dans-une-mini-fenetre-avec-clic')}
        hint={t('little-arc-settings.clic-sur-un-lien-l-ouvre-dans-une-mini')} more={t('little-arc-settings.maintenez-et-en-cliquant-sur-un-lien')}
        checked={settings.littleArcModifier}
        onChange={(littleArcModifier) => update({ littleArcModifier })}
      />
      <Check
        settingKey="littleDownloadBubble"
        label={t('little-arc-settings.afficher-une-bulle-d-actions-apres-un')}
        hint={t('little-arc-settings.quand-un-fichier-telecharge-dans-une')}
        checked={settings.littleDownloadBubble}
        onChange={(littleDownloadBubble) => update({ littleDownloadBubble })}
      />
    </Group>
  )
}
