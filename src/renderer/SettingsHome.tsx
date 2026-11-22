// « Pour commencer », the first page of the Settings: the choices of the first minutes, gathered. Each row but the language, the default browser and the
// import is the very row of its category drawn again (`data-mirror`, shared/settings-catalog.ts `HOME_MIRROR_KEYS`): one setting, two places, no copy.
// Four of them are presets (PresetSettings.tsx): the level of protection, the links of other applications, the launch and the sleep. Each section ends
// with the way to its category.

import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { activeProfileId } from '@shared/profiles'
import { settingsPaneLabel } from '@shared/settings-catalog'
import type { SettingsPage } from '@shared/ipc'
import { DISCOVER_REQUEST } from '@shared/discover'
import { t, tp } from '@shared/i18n'
import { api } from './api'
import { ArchiveRow, DownloadDirRow, EngineRows } from './CurrentProfileSettings'
import { DownloadAskWhereRow } from './DownloadSettings'
import { catalogueFeatures, featuresOn } from './FeaturesPage'
import { DefaultBrowserRow, InterfaceAppearanceRow, UiScaleRow } from './GeneralSettings'
import { LanguageSettings } from './LanguageSettings'
import { PasswordManagerRow } from './PasswordsSettings'
import { LaunchRow, LinksPresetRow, ProtectionLevelRow } from './CategoryRows'
import { SidebarSideRow } from './SpacesSettings'
import { SleepLevelRow } from './TabsSettings'
import { Group, Row } from './settings-parts'

interface HomeProps {
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
  goTo: (target: string) => void
}

/** The way from a section to the category its rows belong to. */
function OpenCategory({ page, goTo }: { page: SettingsPage; goTo: (target: string) => void }) {
  return (
    <button type="button" className="link-button home-open" onClick={() => goTo(page)}>
      {t('settings.home-ouvrir', { name: settingsPaneLabel(page) })}
    </button>
  )
}

export function HomePage({ snapshot, update, goTo }: HomeProps) {
  const profileId = activeProfileId(snapshot.state)
  return (
    <>
      <Group title={t('settings.home-section-navigateur')}>
        <DefaultBrowserRow />
        <Row label={t('import-sheet.importer-depuis-un-autre-navigateur')} hint={t('settings.home-importer-aide')}>
          <button className="button" onClick={() => api().openOverlay({ panel: 'import' })}>
            {t('settings.home-importer')}
          </button>
        </Row>
      </Group>
      <LanguageSettings snapshot={snapshot} update={update} />
      <Group title={t('settings.cat-appearance')} footnote={<OpenCategory page="appearance" goTo={goTo} />}>
        <InterfaceAppearanceRow snapshot={snapshot} update={update} mirror />
        <UiScaleRow snapshot={snapshot} update={update} mirror />
        <SidebarSideRow snapshot={snapshot} update={update} mirror />
      </Group>
      <Group title={t('settings.home-section-protection')} footnote={<OpenCategory page="protection" goTo={goTo} />}>
        <ProtectionLevelRow snapshot={snapshot} update={update} mirror />
        <PasswordManagerRow snapshot={snapshot} update={update} mirror />
      </Group>
      <Group title={t('settings.home-section-recherche')} footnote={<OpenCategory page="navigation" goTo={goTo} />}>
        <EngineRows snapshot={snapshot} update={update} profileId={profileId} place="home" engineOnly />
        <LinksPresetRow snapshot={snapshot} update={update} mirror />
      </Group>
      <Group title={t('settings.home-section-onglets')} footnote={<OpenCategory page="tabs" goTo={goTo} />}>
        <LaunchRow snapshot={snapshot} update={update} mirror />
        <SleepLevelRow snapshot={snapshot} update={update} mirror />
        <ArchiveRow snapshot={snapshot} update={update} profileId={profileId} place="home" />
      </Group>
      <Group title={t('settings.home-section-telechargements')} footnote={<OpenCategory page="files" goTo={goTo} />}>
        <DownloadDirRow snapshot={snapshot} update={update} profileId={profileId} place="home" />
        <DownloadAskWhereRow snapshot={snapshot} update={update} mirror />
      </Group>
      <div className="reset-bar home-features">
        <span>{tp('settings.home-fonctions', featuresOn(snapshot.state.settings), { all: catalogueFeatures().length })}</span>
        <button className="button" type="button" onClick={() => api().openOverlay(DISCOVER_REQUEST)}>
          {t('discover.lien-reglages')}
        </button>
        <button className="button" type="button" onClick={() => goTo('features')}>
          {t('settings.home-voir-fonctions')}
        </button>
      </div>
    </>
  )
}
