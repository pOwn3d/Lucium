// Settings › Onglets et fenêtres: the tabs of the day (archiving, the Back button, the pinned titles, the folders of "Ranger", the badges of the tabs),
// the split view and the video, and putting idle tabs to sleep (`SleepSettings`). The tree of tabs, the search of the tabs, the groups of the extensions,
// the button that reloads every tab and what the cards of the tabs measure are features to add, in « Fonctions en option » (FeaturesPage.tsx).

import { useState } from 'react'
import type { UiSnapshot } from '@shared/ipc'
import { activeProfileId } from '@shared/profiles'
import type { Settings, SleepMode } from '@shared/model'
import { checkSleepHost } from '@shared/sleep'
import { ArchiveRow } from './CurrentProfileSettings'
import { FeatureSwitch } from './FeaturesSettings'
import { PRESETS } from '@shared/settings-presets'
import { PresetRow } from './PresetSettings'
import { Check, Choice, Group, ROW_ICONS, Row, RowIcon, Subpage, SubpageEntry, type DrawsRows } from './settings-parts'
import { t } from '@shared/i18n'

// Functions, not constants: the words are read when the pane is drawn, in the language of the moment.
const sleepChoices = (): Array<[number, string]> => [[0, t('settings.jamais')], [5, t('settings.apres-5-minutes')], [10, t('settings.apres-10-minutes')], [15, t('settings.apres-15-minutes')], [30, t('settings.apres-30-minutes')], [60, t('settings.apres-1-heure')], [120, t('settings.apres-2-heures')]]
const awakeMaxChoices = (): Array<[number, string]> => [[0, t('settings.sans-limite')], ...[4, 6, 8, 12, 20, 30, 50].map((count): [number, string] => [count, String(count)])]
const freezeChoices = (): Array<[number, string]> => [[0, t('settings.jamais')], [2, t('settings.apres-2-minutes')], [5, t('settings.apres-5-minutes')], [10, t('settings.apres-10-minutes')], [15, t('settings.apres-15-minutes')]]

interface PaneProps {
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
}

/** The level of the sleep (Jamais, Modéré, Équilibré, Maximal, or « Personnalisé »): in Mise en veille, and again on « Pour commencer » (`mirror`). */
export function SleepLevelRow({ snapshot, update, mirror }: PaneProps & { mirror?: boolean }) {
  // The preset of the sleep (settings-presets.ts): Jamais or a level, the line of what it does under it, « Personnalisé » for values set one by one.
  return <PresetRow preset={PRESETS.veille.id} settings={snapshot.state.settings} update={update} mirror={mirror} more={t('settings.quand-la-memoire-vient-a-manquer')} />
}

;(SleepLevelRow as DrawsRows).rows = ['sleepAfterMinutes']

/** Putting idle tabs to sleep: the delay, what it does, what it spares, and the sites it never touches. */
export function SleepSettings({ snapshot, update }: PaneProps) {
  const { settings } = snapshot.state
  const hosts = settings.sleepExcludedHosts
  const [draft, setDraft] = useState('')
  const verdict = draft.trim() === '' ? null : checkSleepHost(draft, hosts)
  const off = !(settings.sleepAfterMinutes > 0)
  const add = () => {
    if (!verdict || !('host' in verdict)) return
    update({ sleepExcludedHosts: [...hosts, verdict.host] })
    setDraft('')
  }

  return (
    <>
      <Group title={t('settings.mise-en-veille')} footnote={t('settings.un-onglet-affiche-ou-occupe-telechargement')} more={t('settings.ne-sont-jamais-mis-en-veille-l-onglet')}>
        <SleepLevelRow snapshot={snapshot} update={update} />
        {/* The delay alone: the preset row above stands for its setting, so this row leaves it the key and keeps its dot and its « Rétablir ». */}
        <Row placement="more" changeKeys={['sleepAfterMinutes']} label={t('settings.delai-de-mise-en-veille')} hint={t('settings.une-fois-le-delai-ecoule-sans-que-vous-y')}>
          <Choice className="pop" label={t('settings.delai-de-mise-en-veille')} value={settings.sleepAfterMinutes} choices={sleepChoices()} onChange={(sleepAfterMinutes) => update({ sleepAfterMinutes })} />
        </Row>
        <Row settingKey="sleepAwakeMax" label={t('settings.onglets-eveilles-en-arriere-plan-au-plus')} hint={t('settings.au-dela-l-onglet-quitte-est-mis-en-veille-avant')} more={t('settings.au-dela-l-onglet-quitte-depuis-le-plus')}>
          <Choice className="pop" label={t('settings.onglets-eveilles-en-arriere-plan-au-plus')} value={settings.sleepAwakeMax} choices={awakeMaxChoices()} disabled={off} onChange={(sleepAwakeMax) => update({ sleepAwakeMax })} />
        </Row>
        <Row settingKey="sleepFreezeAfterMinutes" label={t('settings.geler-d-abord-les-onglets-caches')} hint={t('settings.un-onglet-cache-depuis-ce-delai-cesse-d')} more={t('settings.un-onglet-cache-depuis-ce-delai-ne')}>
          <Choice className="pop" label={t('settings.geler-d-abord-les-onglets-caches')} value={settings.sleepFreezeAfterMinutes} choices={freezeChoices()} disabled={off} onChange={(sleepFreezeAfterMinutes) => update({ sleepFreezeAfterMinutes })} />
        </Row>
        <Row settingKey="sleepMode" label={t('settings.mode-de-veille')} hint={settings.sleepMode === 'freeze' ? t('settings.la-page-reste-en-memoire-mais-ne-consomme') : t('settings.la-page-est-fermee-pour-liberer-la-memoire')}>
          <select className="field pop" value={settings.sleepMode} aria-label={t('settings.mode-de-veille')} onChange={(e) => update({ sleepMode: e.target.value as SleepMode })}>
            <option value="discard">{t('settings.liberer-la-memoire')}</option>
            <option value="freeze">{t('settings.geler')}</option>
          </select>
        </Row>
        <Check settingKey="sleepSkipAudible" label={t('settings.ne-pas-mettre-en-veille-les-onglets-qui')} checked={settings.sleepSkipAudible} onChange={(sleepSkipAudible) => update({ sleepSkipAudible })} />
        <Check settingKey="sleepSkipPinned" label={t('settings.ne-pas-mettre-en-veille-les-onglets-epingles')} hint={t('settings.les-onglets-epingles-ne-sont-jamais-mis-en')} more={t('settings.ne-pas-mettre-en-veille-les-onglets-epingles-aide')} checked={settings.sleepSkipPinned} onChange={(sleepSkipPinned) => update({ sleepSkipPinned })} />
        <Check settingKey="sleepNotify" label={t('settings.prevenir-a-chaque-mise-en-veille')} hint={t('settings.une-notice-propose-de-reveiller-l-onglet')} checked={settings.sleepNotify} onChange={(sleepNotify) => update({ sleepNotify })} />
        <SubpageEntry id="awake" snapshot={snapshot} />
      </Group>

      {/* By default the list keeps one tab of each site awake, not all of them: the title says which, as the switch at the bottom sets it. */}
      <Subpage id="awake">
      <Group keys={['sleepExcludedHosts']} title={settings.sleepExcludedKeepAll ? t('settings.sites-gardes-eveilles-tous-leurs-onglets') : t('settings.sites-gardes-eveilles-un-onglet-chacun')} footnote={t('settings.par-defaut-seul-le-dernier-onglet-affiche-de')} more={t('settings.sites-gardes-eveilles-note')}>
        {hosts.length === 0 && (
          <div className="pref-row pref-message" role="status">
            {t('settings.aucun-site')}
          </div>
        )}
        {hosts.map((host) => (
          <Row key={host} label={<code>{host}</code>}>
            <button className="link-button" onClick={() => update({ sleepExcludedHosts: hosts.filter((h) => h !== host) })} aria-label={t('settings.retirer-name', { name: host })}>
              {t('settings.retirer')}
            </button>
          </Row>
        ))}
        <div className="pref-row pref-form">
          <input
            className="field"
            placeholder={t('settings.exemple-org')}
            aria-label={t('settings.site-a-garder-eveille')}
            aria-invalid={verdict !== null && 'error' in verdict}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="button" disabled={!verdict || 'error' in verdict} onClick={add}>
            {t('settings.ajouter')}
          </button>
        </div>
        {verdict && 'error' in verdict && (
          <div className="pref-row pref-message pref-error" role="alert">
            {verdict.error}
          </div>
        )}
        <Check settingKey="sleepExcludedKeepAll" label={t('settings.garder-eveilles-tous-les-onglets-de-ces-sites')} hint={t('settings.aucun-onglet-de-ces-sites-n-est-mis-en-veille')} more={t('settings.desactive-seul-l-onglet-affiche-en-dernier')} checked={settings.sleepExcludedKeepAll} onChange={(sleepExcludedKeepAll) => update({ sleepExcludedKeepAll })} />
      </Group>
      </Subpage>
    </>
  )
}

/** Onglets: the tabs of the day and their badges, the other settings of the tabs, the split view and the video. */
export function TabsSettings({ snapshot, update }: PaneProps) {
  const { settings } = snapshot.state
  return (
    <>
      <Group title={t('settings.archivage-et-organisation')}>
        <ArchiveRow snapshot={snapshot} update={update} profileId={activeProfileId(snapshot.state)} place="category" />
        <Check settingKey="tidyPinnedTitles" label={t('settings.epurer-les-titres-des-onglets-epingles')} hint={t('settings.un-onglet-epingle-perd-le-compteur-de-son-titre')} more={t('settings.un-onglet-epingle-affiche-le-nom-du-site')} checked={settings.tidyPinnedTitles} onChange={(tidyPinnedTitles) => update({ tidyPinnedTitles })} />
        <FeatureSwitch id="tab-state-badges" snapshot={snapshot} update={update} />
        <Row settingKey="tidyFoldersPosition" label={t('tidy-panel.placer-les-nouveaux-dossiers')} hint={t('settings.ou-ranger-les-onglets-place-les-dossiers-qu')} more={t('settings.ou-ranger-les-onglets-met-les-dossiers')}>
          <select className="field pop" aria-label={t('tidy-panel.placer-les-nouveaux-dossiers')} value={settings.tidyFoldersPosition} onChange={(e) => update({ tidyFoldersPosition: e.target.value === 'bottom' ? 'bottom' : 'top' })}>
            <option value="top">{t('tidy-panel.en-haut')}</option>
            <option value="bottom">{t('tidy-panel.en-bas')}</option>
          </select>
        </Row>
      </Group>

      <Group title={t('settings.autres-reglages-des-onglets')}>
        <Check
          settingKey="reopenHistory"
          label={t('settings.rouvrir-un-onglet-archive-avec-ses-pages')}
          hint={t('settings.un-onglet-rouvert-retrouve-ses-pages')} more={t('settings.garde-avec-l-archive-jusqu-a-20-adresses')}
          checked={settings.reopenHistory}
          onChange={(reopenHistory) => update({ reopenHistory })}
        />
        <Check
          settingKey="backClosesOpenedTab"
          label={t('settings.le-bouton-precedent-ferme-l-onglet-ouvert')}
          hint={t('settings.sur-la-premiere-page-d-un-onglet-ouvert-par')} more={t('settings.sur-la-premiere-page-d-un-onglet-ouvert')}
          checked={settings.backClosesOpenedTab}
          onChange={(backClosesOpenedTab) => update({ backClosesOpenedTab })}
        />
        <Check
          settingKey="dragToSplit"
          label={t('settings.faire-glisser-un-onglet-sur-la-page-pour')}
          hint={t('settings.glissez-un-onglet-vers-un-bord-de-la-page')} more={t('settings.glissez-un-onglet-de-la-barre-laterale-vers')}
          checked={settings.dragToSplit}
          onChange={(dragToSplit) => update({ dragToSplit })}
        />
      </Group>

      <Group title={t('settings.section-vue-scindee-et-video')} className="with-icons">
        <Check
          settingKey="autoPictureInPicture"
          icon={<RowIcon color="purple">{ROW_ICONS.pip}</RowIcon>}
          label={t('settings.activer-l-image-dans-l-image-quand-vous')}
          hint={t('features.une-video-qui-joue-avec-le-son-flotte-dans')} more={t('features.une-video-que-vous-regardez-flotte-dans')}
          checked={settings.autoPictureInPicture}
          onChange={(autoPictureInPicture) => update({ autoPictureInPicture })}
        />
        <Check
          settingKey="sitePictureInPictureInLucium"
          icon={<RowIcon color="purple">{ROW_ICONS.pip}</RowIcon>}
          label={t('settings.image-dans-l-image-d-un-site-dans-la-fenetre-de-lucium')}
          hint={t('settings.le-bouton-d-un-site-ouvre-la-fenetre-de-lucium')}
          checked={settings.sitePictureInPictureInLucium}
          onChange={(sitePictureInPictureInLucium) => update({ sitePictureInPictureInLucium })}
        />
        <Check settingKey="scrollSync" icon={<RowIcon color="purple">{ROW_ICONS.drag}</RowIcon>} label={t('web-tools-settings.defilement-synchronise-des-volets-d-une-vue')} info={t('web-tools-settings.ajoute-defilement-synchronise-au-menu-des')} checked={settings.scrollSync} onChange={(scrollSync) => update({ scrollSync })} />
        <Check settingKey="rememberScroll" label={t('features.retrouver-la-position-de-defilement-des-onglets')} info={t('features.la-position-de-defilement-d-un-onglet-est-gardee')} checked={settings.rememberScroll} onChange={(rememberScroll) => update({ rememberScroll })} />
      </Group>

    </>
  )
}
