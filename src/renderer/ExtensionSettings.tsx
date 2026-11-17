// Settings › Extensions et outils › Extensions: the Chrome Web Store switch and its updates, and each extension with its choice per profile.
// Rendered inside the Extensions group of the Advanced pane (SettingsWindow.tsx).

import type { ExtensionInfo, UiSnapshot } from '@shared/ipc'
import { WEB_STORE_UPDATES, type Settings, type WebStoreUpdates } from '@shared/model'
import { profileLabel } from '@shared/profiles'
import { WEB_STORE_UPDATE_LABELS } from '@shared/web-store'
import { api } from './api'
import { Check, Row, type DrawsRows } from './settings-parts'
import './extension-settings.css'
import { getLanguage, t } from '@shared/i18n'
import { actionName } from './action-name'

/** The extensions of the snapshot, one entry per extension, with its copy in each profile it lives in, in the alphabetical order of the language of the interface. */
export function byExtension(list: readonly ExtensionInfo[]): ExtensionInfo[][] {
  const groups = new Map<string, ExtensionInfo[]>()
  for (const info of list) groups.set(info.id, [...(groups.get(info.id) ?? []), info])
  return [...groups.values()].sort((a, b) => a[0]!.name.localeCompare(b[0]!.name, getLanguage()))
}

export function ExtensionRows({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  const act = api()
  const groups = byExtension(snapshot.extensions)
  return (
    <>
      <Check
        settingKey="webStoreInstall"
        label={t('extension-settings.autoriser-l-installation-d-extensions-depuis-le')}
        hint={t('extension-settings.installe-une-extension-depuis-sa-page-du')} more={t('extension-settings.une-page-du-chrome-web-store-ouverte-dans')}
        checked={settings.webStoreInstall}
        onChange={(webStoreInstall) => update({ webStoreInstall })}
      />
      <Row settingKey="webStoreUpdates" label={t('extension-settings.mises-a-jour-des-extensions-du-web-store')} hint={t('extension-settings.par-defaut-seulement-a-votre-demande-une')} more={t('extension-settings.par-defaut-jamais-sans-votre-demande-avec')}>
        <select
          className="field pop"
          aria-label={t('extension-settings.mises-a-jour-des-extensions-du-web-store')}
          value={settings.webStoreUpdates}
          disabled={!settings.webStoreInstall}
          onChange={(e) => update({ webStoreUpdates: e.target.value as WebStoreUpdates })}
        >
          {WEB_STORE_UPDATES.map((mode) => (
            <option key={mode} value={mode}>
              {WEB_STORE_UPDATE_LABELS[mode]}
            </option>
          ))}
        </select>
        <button className="button" disabled={!settings.webStoreInstall} onClick={() => act.extensionUpdates()}>
          {t('extension-settings.rechercher-maintenant')}
        </button>
      </Row>
      <Row label={t('extension-settings.chrome-web-store')} hint={t('extension-settings.ouvre-le-site-dans-un-onglet-de-l-espace')}>
        <button className="button" disabled={!settings.webStoreInstall} onClick={() => act.openWebStore()}>
          {t('extension-settings.ouvrir-le-chrome-web-store')}
        </button>
      </Row>
      {groups.length === 0 && <Row label={<span className="muted">{t('extension-settings.aucune-extension-installee')}</span>} />}
      {groups.map((copies) => {
        const first = copies[0]!
        const update_ = copies.find((c) => c.update)
        return (
          <Row
            key={first.id}
            className="ext-row"
            label={
              <>
                {first.name} <span className="muted">{first.version}</span>
              </>
            }
            hint={[first.source === 'store' ? t('extension-settings.chrome-web-store') : t('extension-settings.dossier-local'), update_?.update ? t('extension-settings.version-version-en-attente-elle-demande-de', { version: update_.update.version }) : ''].filter(Boolean).join(' · ')}
          >
            <div className="ext-profiles">
              {copies.map((copy) => (
                <span key={copy.profileId} className="ext-profile">
                  <label>
                    <input
                      type="checkbox"
                      checked={copy.enabled}
                      aria-label={t('extension-settings.name-dans-le-profil-profile', { name: copy.name, profile: profileLabel(settings, copy.profileId) })}
                      onChange={(e) => void act.dispatch({ type: 'extension/set-enabled', profileId: copy.profileId, extensionId: copy.id, enabled: e.target.checked })}
                    />{' '}
                    {profileLabel(settings, copy.profileId)}
                  </label>
                  {copy.update && (
                    <button className="link-button" aria-label={actionName(t('extension-settings.examiner-la-mise-a-jour'), t('extension-settings.name-dans-le-profil-profile', { name: copy.name, profile: profileLabel(settings, copy.profileId) }))} onClick={() => act.extensionUpdates({ profileId: copy.profileId, extensionId: copy.id })}>
                      {t('extension-settings.examiner-la-mise-a-jour')}
                    </button>
                  )}
                  {copy.source === 'store' && (
                    <button className="link-button" aria-label={actionName(t('extension-settings.desinstaller'), t('extension-settings.name-dans-le-profil-profile', { name: copy.name, profile: profileLabel(settings, copy.profileId) }))} onClick={() => act.extensionUninstall(copy.profileId, copy.id)}>
                      {t('extension-settings.desinstaller')}
                    </button>
                  )}
                </span>
              ))}
            </div>
          </Row>
        )
      })}
    </>
  )
}
// The settings these rows stand for: at the essential level they fold with the Web Store (settings-parts.tsx, `Group`).
;(ExtensionRows as DrawsRows).rows = ['webStoreInstall', 'webStoreUpdates']
