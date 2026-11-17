// Settings › Icône de l’application: one of the application icons (shared/icons.ts), shown in the Dock and put on the application file, so that the
// Dock, the Finder and the Launchpad keep it once Lucium is closed (main/shell/app-icon.ts). The pane says that the file is changed, and why the icon
// could not be shown or kept.

import { useEffect, useState } from 'react'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { APP_ICONS, type AppIconIssue } from '@shared/icons'
import { api } from './api'
import { Group } from './settings-parts'
import { t } from '@shared/i18n'
import { radioGroupKeys } from './radio-keys'

interface PaneProps {
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
}

/** The picture of each icon, by id: Vite gives the files of resources/app-icons their addresses. */
const ICON_PICTURES = Object.fromEntries(
  Object.entries(import.meta.glob<string>('../../resources/app-icons/*.png', { eager: true, query: '?url', import: 'default' })).map(([path, url]) => [path.split('/').pop()!.replace('.png', ''), url])
)

export function IconSettings({ snapshot, update }: PaneProps) {
  const current = snapshot.state.settings.appIcon
  const [issue, setIssue] = useState<AppIconIssue | null>(null)
  // The Dock and the application file take the icon at the choice (and say why when they could not): asked again at each choice.
  useEffect(() => {
    let live = true
    api()
      .appIconIssue()
      .then(
        (found) => live && setIssue(found),
        // Nothing is waiting on a button here: the page keeps saying nothing of the picture, and the log says why.
        (error: unknown) => console.warn('[settings] the icon of the Dock could not be checked:', error)
      )
    return () => {
      live = false
    }
  }, [current])
  return (
    <>
      {issue && (
        <div className="pref-callout" role="status">
          <div className="pref-label">{issue.reason === 'bundle-not-writable' ? t('settings.icone-paquet-non-modifiable') : t('settings.icone-image-introuvable-dock')}</div>
        </div>
      )}
      <Group id="icon" keys={['appIcon']} title={t('settings.icone-de-l-application')} footnote={t('settings.l-icone-reste-dans-le-dock-une-fois-lucium')} more={t('settings.icone-gardee-a-la-fermeture')}>
        <div className="icon-grid" role="radiogroup" onKeyDown={radioGroupKeys} aria-label={t('settings.icone-de-l-application')}>
          {APP_ICONS.map((icon) => (
            <button key={icon.id} role="radio" aria-checked={icon.id === current} className={icon.id === current ? 'current' : ''} onClick={() => update({ appIcon: icon.id })}>
              <span className="icon-radio" aria-hidden="true" />
              <img src={ICON_PICTURES[icon.id]} alt="" width={52} height={52} draggable={false} />
              <span className="icon-name">
                <span>{icon.label}</span>
                {icon.id === current && <span className="icon-current">{t('settings.icone-actuelle')}</span>}
              </span>
            </button>
          ))}
        </div>
      </Group>
    </>
  )
}
