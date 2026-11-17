// The site-icon lookup (Settings › Téléchargements et fichiers › Plus de réglages): whether Lucium asks a site for its icon when a favourite or a pinned tab has none.
// On by default. Rendered by the Advanced pane (SettingsWindow.tsx), before the About group.

import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { Check, Group } from './settings-parts'
import { t } from '@shared/i18n'

export function FaviconSettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  return (
    <Group title={t('favicon-settings.icones-des-sites')}>
      <Check
        settingKey="resolveFavicons"
        label={t('favicon-settings.recuperer-les-icones-des-favoris-et-des-onglets')}
        hint={t('favicon-settings.lucium-demande-son-icone-a-chaque-site')} more={t('favicon-settings.lucium-demande-une-fois-a-chaque-site')}
        checked={settings.resolveFavicons}
        onChange={(resolveFavicons) => update({ resolveFavicons })}
      />
    </Group>
  )
}
