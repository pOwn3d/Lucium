// Settings › Téléchargements et fichiers › "Téléchargements et lecture": the optional behaviours of downloads and of the read-later list. All off by
// default, so that the popover and the list keep their default form (the pause of the downloads, « Ouvrir sans l’enregistrer » and the PDF with the
// address are features to add, in « Fonctions en option »). The applications remembered for a type of file are listed here, where they can be changed
// and forgotten; only the main process can name a new one (through the system's box).

import type { ReactNode } from 'react'
import { applicationName } from '@shared/open-with'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { api } from './api'
import { Check, Group, Row, type DrawsRows } from './settings-parts'
import { t } from '@shared/i18n'
import { actionName } from './action-name'

/** `leading`: the first row of the group (the download folder of the profile on screen); `children`: more rows (the switch of the status of the downloads, which has no pane of its own). */
/** Whether each download asks where to go: in Téléchargements et fichiers, and again on « Pour commencer » (`mirror`). */
export function DownloadAskWhereRow({ snapshot, update, mirror }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void; mirror?: boolean }) {
  return (
    <Check
      settingKey="downloadAskWhere"
      mirror={mirror}
      label={t('download-settings.demander-ou-enregistrer-chaque-fichier')}
      hint={t('download-settings.desactive-les-fichiers-vont-dans-le')}
      checked={snapshot.state.settings.downloadAskWhere}
      onChange={(downloadAskWhere) => update({ downloadAskWhere })}
    />
  )
}
;(DownloadAskWhereRow as DrawsRows).rows = ['downloadAskWhere']

export function DownloadSettings({ snapshot, update, leading, children }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void; leading?: ReactNode; children?: ReactNode }) {
  const { settings } = snapshot.state
  const remembered = Object.entries(settings.openWithApps).sort(([a], [b]) => a.localeCompare(b))
  const forget = (type: string) => update({ openWithApps: Object.fromEntries(remembered.filter(([key]) => key !== type)) })
  return (
    <>
      <Group
        id="downloads"
        title={t('download-settings.telechargements-et-lecture')}
        footnote={t('download-settings.desactivees-ces-options-ne-changent-rien-aux')} more={t('download-settings.ces-options-sont-facultatives-desactivees')}
      >
        {leading}
        <Check
          settingKey="tidyDownloads"
          label={t('settings.epurer-les-telechargements')}
          hint={t('settings.nettoie-le-nom-des-fichiers-telecharges')}
          checked={settings.tidyDownloads}
          onChange={(tidyDownloads) => update({ tidyDownloads })}
        />
        {children}
        <Check
          settingKey="downloadResume"
          label={t('download-settings.reprendre-les-telechargements-apres-un')}
          hint={t('download-settings.un-telechargement-interrompu-reprend-au')} more={t('download-settings.l-adresse-souvent-avec-un-jeton-et-le')}
          checked={settings.downloadResume}
          onChange={(downloadResume) => update({ downloadResume })}
        />
        <DownloadAskWhereRow snapshot={snapshot} update={update} />
        <Check
          settingKey="useReadLaterFolders"
          label={t('download-settings.classer-lire-plus-tard-dans-des-dossiers')}
          hint={t('download-settings.rangez-la-liste-lire-plus-tard-en-dossiers')} more={t('download-settings.la-liste-lire-plus-tard-se-range-en-dossiers')}
          checked={settings.useReadLaterFolders}
          onChange={(useReadLaterFolders) => update({ useReadLaterFolders })}
        />
      </Group>

      <Group title={t('download-settings.ouverture-des-fichiers')}>
        <Check
          settingKey="openWithMemory"
          label={t('download-settings.memoriser-l-application-d-ouverture-par-type-de')}
          hint={t('download-settings.ouvrir-reprend-l-application-choisie-une')} more={t('download-settings.ouvrir-avec-dans-le-menu-d-un')}
          checked={settings.openWithMemory}
          onChange={(openWithMemory) => update({ openWithMemory })}
        />
        {remembered.map(([type, app]) => (
          <Row key={type} settingKey="openWithApps" label={<span>.{type} · {applicationName(app)}</span>} hint={app}>
            {settings.openWithMemory && (
              <button className="link-button" aria-label={actionName(t('settings.changer'), `.${type}`)} onClick={() => api().chooseOpenWith(type)}>
                {t('settings.changer')}
              </button>
            )}
            <button className="link-button" aria-label={t('settings.retirer-name', { name: `.${type}` })} onClick={() => forget(type)}>
              {t('settings.retirer')}
            </button>
          </Row>
        ))}
        {remembered.length > 1 && (
          <Row settingKey="openWithApps" label={t('download-settings.applications-memorisees')}>
            <button className="link-button" onClick={() => update({ openWithApps: {} })}>
              {t('download-settings.tout-effacer')}
            </button>
          </Row>
        )}
      </Group>
    </>
  )
}
