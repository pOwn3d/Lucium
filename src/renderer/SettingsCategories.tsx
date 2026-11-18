// What each page of the Settings window holds: « Pour commencer », the 8 categories named by what one wants to do, « Fonctions en option » and « À propos
// et mises à jour ». The panes (`*Settings.tsx`) are the components of the old panes; this file puts them where they belong, in the order of their groups,
// and draws the few groups that had no component of their own. `SETTINGS_KEYS` (shared/settings-catalog.ts) says which setting each page draws;
// src/renderer/settings-structure.test.ts renders them all and compares.

import { useState } from 'react'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import type { SettingsPage } from '@shared/ipc'
import { ALL_SITES, decisionOfChoice, permissionName, sitesWithAnswers } from '@shared/permissions'
import { platformOf } from '@shared/platform'
import { activeProfileId } from '@shared/profiles'
import { api } from './api'
import { AboutSettings } from './AboutSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { BackupSettings } from './BackupSettings'
import { BlockingSettings, FilterListsSettings } from './BlockingSettings'
import { BoostShareSettings } from './BoostShareSettings'
import { ClearDataRow, DownloadDirRow } from './CurrentProfileSettings'
import { DownloadSettings } from './DownloadSettings'
import { EngineStatus } from './EngineStatus'
import { ExportData } from './ExportData'
import { ExtensionRows } from './ExtensionSettings'
import { FaviconSettings } from './FaviconSettings'
import { FeatureSwitch } from './FeaturesSettings'
import { AccessibilitySettings, DisplaySettings, UpdatesSettings } from './GeneralSettings'
import { GuardSettings } from './GuardSettings'
import { HardwareSettings } from './HardwareSettings'
import { IconSettings } from './IconSettings'
import { VimKeysSettings } from './KeyExtSettings'
import { LinksSettings, LittleShortcutRow } from './LinksSettings'
import { LockSettings } from './LockSettings'
import { PasswordsSettings } from './PasswordsSettings'
import { PrivacyDashboard } from './PrivacyDashboard'
import { HistorySettings, NetworkSettings } from './PrivacyExtraSettings'
import { PrivacySettings } from './PrivacySettings'
import { CommandBarSettings, SearchSettings } from './SearchSettings'
import { ProfilesPane } from './SettingsProfiles'
import { HomePage } from './SettingsHome'
import { BlockAdsRow, LaunchRow, ProtectionLevelRow } from './CategoryRows'
import { FeatureSubpages, FeaturesPage } from './FeaturesPage'
import { SyncEntry, SyncSettings } from './SyncSettings'
import { ShortcutsPane } from './SettingsShortcuts'
import { AutoplaySettings, ClearOnCloseSettings, SiteAutoplayList, SiteDataSettings } from './SitePrivacySettings'
import { SpacesSettings } from './SpacesSettings'
import { SleepSettings, TabsSettings } from './TabsSettings'
import { TranslateSettings } from './TranslateSettings'
import { MouseGesturesSettings, WebToolsSettings } from './WebToolsSettings'
import { Check, Group, Place, ROW_ICONS, Row, RowIcon, Subpage, SubpageEntry } from './settings-parts'
import { t } from '@shared/i18n'
import { actionName } from './action-name'
import { settingsPath } from '@shared/settings-path'
import { settingsPaneLabel } from '@shared/settings-catalog'

export interface CategoryProps {
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
  /** Leads to another place of the Settings: a category, and a group of it ("privacy/permissions"). */
  goTo: (target: string) => void
}

type PaneProps = Pick<CategoryProps, 'snapshot' | 'update'>

/**
 * Au lancement: the preset « Quand vous ouvrez Lucium » at the top of the page; the two settings it writes wait in « Plus de réglages », each with its
 * own switch. The preset row stands for the windows of the last session (settings-presets.ts): their switch leaves it the key, and keeps its dot and
 * its « Rétablir ».
 */
function LaunchGroup({ snapshot, update }: PaneProps) {
  const { settings } = snapshot.state
  return (
    <Group title={t('settings.section-au-lancement')}>
      <LaunchRow snapshot={snapshot} update={update} />
      <Check
        placement="more"
        changeKeys={['restoreWindows']}
        label={t('settings.rouvrir-les-fenetres-de-la-session-precedente')}
        hint={t('features.au-lancement-les-fenetres-reviennent-ou-elles')}
        checked={settings.restoreWindows}
        onChange={(restoreWindows) => update({ restoreWindows })}
      />
      <Check settingKey="loadAllTabsAtLaunch" label={t('settings.charger-tous-les-onglets-au-lancement')} hint={t('settings.chaque-onglet-se-charge-des-le-lancement-et')} more={t('settings.desactive-seuls-l-onglet-affiche-et-les')} checked={settings.loadAllTabsAtLaunch} onChange={(loadAllTabsAtLaunch) => update({ loadAllTabsAtLaunch })} />
    </Group>
  )
}

/** Windows: what drags the window, the warnings before closing one and before quitting (naming the windows and the independent windows are features to add). */
function WindowGroups({ snapshot, update }: PaneProps) {
  const { settings } = snapshot.state
  return (
    <>
      <Group title={t('menu.fenetre')} className="with-icons">
        <Check settingKey="dragWindowFromToolbar" icon={<RowIcon color="green">{ROW_ICONS.drag}</RowIcon>} label={t('settings.autoriser-le-deplacement-de-la-fenetre')} hint={t('features.la-fenetre-se-deplace-en-tirant-la-barre-d')} checked={settings.dragWindowFromToolbar} onChange={(dragWindowFromToolbar) => update({ dragWindowFromToolbar })} />
      </Group>

      <Group title={t('settings.autres-reglages-des-fenetres')}>
        <Check
          settingKey="warnBeforeClosingWindow"
          label={t('settings.avertir-avant-de-fermer-une-fenetre-de')}
          hint={t('settings.jamais-pour-la-derniere-fenetre-la-fermer')}
          checked={settings.warnBeforeClosingWindow}
          onChange={(warnBeforeClosingWindow) => update({ warnBeforeClosingWindow })}
        />
        <Check settingKey="warnBeforeQuitting" label={t('settings.avertir-avant-de-quitter')} checked={settings.warnBeforeQuitting} onChange={(warnBeforeQuitting) => update({ warnBeforeQuitting })} />
      </Group>
    </>
  )
}

/** Apparence: the interface, the sidebar, the window, the websites. */
function AppearanceCategory({ snapshot, update }: PaneProps) {
  const { settings } = snapshot.state
  return (
    <>
      <AccessibilitySettings snapshot={snapshot} update={update} />
      <DisplaySettings snapshot={snapshot} update={update} />
      <SpacesSettings snapshot={snapshot} update={update}>
        <FeatureSwitch id="compact-mode" snapshot={snapshot} update={update} />
        <FeatureSwitch id="media-player" snapshot={snapshot} update={update} />
        <FeatureSwitch id="favorite-names" snapshot={snapshot} update={update} />
        <FeatureSwitch id="resource-gauge" snapshot={snapshot} update={update} />
      </SpacesSettings>
      <AppearanceSettings snapshot={snapshot} update={update} />
      <Group title={t('settings.section-pages-web')} className="with-icons">
        <Check
          settingKey="allowThemeToSites"
          icon={<RowIcon color="purple">{ROW_ICONS.palette}</RowIcon>}
          label={t('settings.autoriser-les-sites-web-a-obtenir-les')}
          info={t('settings.les-pages-recoivent-la-palette-de-l-espace')}
          checked={settings.allowThemeToSites}
          onChange={(allowThemeToSites) => update({ allowThemeToSites })}
        />
      </Group>
    </>
  )
}

/**
 * Clavier et souris: the shortcuts valid outside Lucium (⌥⌘N, ⌥⌘M: a shortcut that works in every application is set here), the row of the editor of
 * the shortcuts with ⌃Tab, the mouse gestures and the scroll with the middle button, the swipe of the trackpad, the Vim keys; the editor itself on its
 * subpage (`#keyboard/shortcuts`; the help of the shortcuts is a feature to add).
 */
function KeyboardCategory({ snapshot, update, goTo }: CategoryProps) {
  const { settings } = snapshot.state
  return (
    <>
      <Group title={t('settings.section-raccourcis-partout')}>
        <LittleShortcutRow snapshot={snapshot} update={update} />
        <Check
          settingKey="annotateGlobalShortcut"
          label={t('settings.annoter-depuis-toute-application')}
          hint={t('settings.m-annote-la-page-meme-depuis-une-autre')} more={t('settings.annoter-depuis-toute-application-aide')}
          checked={settings.annotateGlobalShortcut}
          onChange={(annotateGlobalShortcut) => update({ annotateGlobalShortcut })}
        />
      </Group>
      <Group title={t('settings.section-raccourcis-clavier')} footnote={t('settings-shortcuts.quelques-raccourcis-prennent-une-touche-que')} more={t('settings-shortcuts.raccourcis-du-systeme-repris', { settingsPath: settingsPath('shortcuts') })}>
        <SubpageEntry id="shortcuts" snapshot={snapshot} />
        <Check
          settingKey="tabCycleRecent"
          label={t('settings-shortcuts.ctrl-tab-ordre-recent')}
          hint={t('settings-shortcuts.tab-revient-a-l-onglet-utilise-juste-avant')} more={t('settings-shortcuts.ctrl-tab-ordre-recent-aide')}
          checked={settings.tabCycleRecent}
          onChange={(tabCycleRecent) => update({ tabCycleRecent })}
        />
      </Group>
      <MouseGesturesSettings snapshot={snapshot} update={update}>
        <Check settingKey="autoScroll" label={t('web-tools-settings.defilement-automatique-avec-le-clic-du-milieu')} hint={t('web-tools-settings.un-clic-du-milieu-sur-la-page-la-fait')} more={t('web-tools-settings.un-clic-du-milieu-sur-la-page-hors-lien-et')} checked={settings.autoScroll} onChange={(autoScroll) => update({ autoScroll })} />
      </MouseGesturesSettings>
      <Group title={t('settings.pave-tactile')}>
        <Check settingKey="spaceSwipe" label={t('settings.balayer-pour-changer-d-espace')} hint={t('settings.deux-doigts-en-travers-de-la-liste-des')} more={t('settings.balayer-pour-changer-d-espace-aide')} checked={settings.spaceSwipe} onChange={(spaceSwipe) => update({ spaceSwipe })} />
      </Group>
      <VimKeysSettings snapshot={snapshot} update={update} />
      {/* The editor of the shortcuts, a tool of 140 commands, is on its subpage, which the row « Raccourcis clavier » opens. */}
      <Subpage id="shortcuts">
        <div id="shortcuts" className="shortcuts-area">
          <ShortcutsPane bindings={settings.keyBindings} platform={platformOf(snapshot.platform)} extensions={snapshot.extensions.filter((extension) => extension.enabled)} littleEverywhere={settings.littleArcShortcut} update={update} open={() => goTo('keyboard/shortcuts')} />
        </div>
      </Subpage>
    </>
  )
}

/**
 * Protection (in Vie privée et sécurité): the level of protection at the top of the page, then the blocker (`BlockAdsRow`) and the protections of the
 * page, each setting the level writes with its own switch: four at the top under the level, the others in « Plus de réglages » with the dashboard.
 */
function BlockerCategory({ snapshot, update }: PaneProps) {
  const { settings } = snapshot.state
  return (
    <>
      <Group title={t('settings.section-protection')}>
        <ProtectionLevelRow snapshot={snapshot} update={update} />
      </Group>
      <Place at="more">
        <PrivacyDashboard snapshot={snapshot} />
      </Place>
      <Group title={t('settings.bloqueur')} footnote={t('settings.les-listes-de-filtres-se-telechargent-quand')} more={t('settings.le-blocage-s-appuie-sur-les-listes-de', { settingsPath: settingsPath('filterLists') })}>
        <BlockAdsRow snapshot={snapshot} update={update} />
        <Check settingKey="blockCookieBanners" label={t('settings.bloquer-les-bannieres-de-cookies')} hint={t('settings.bloque-les-plateformes-de-consentement-et')} checked={settings.blockCookieBanners} onChange={(blockCookieBanners) => update({ blockCookieBanners })} />
      </Group>
      <BlockingSettings snapshot={snapshot} update={update} />
      <PrivacySettings snapshot={snapshot} update={update} />
      <GuardSettings snapshot={snapshot} update={update} />
    </>
  )
}

/**
 * Autorisations des sites (in Vie privée et sécurité): autoplay, the notifications, screen sharing, the devices; the permissions remembered for each
 * site, and the autoplay of a site of its own, on the subpage « Autorisations mémorisées » (`#protection/permissions`).
 */
function SitesCategory({ snapshot, update }: PaneProps) {
  const { settings, sitePermissions } = snapshot.state
  // The answer for every site is its own line (the menu below), not one of the sites.
  const remembered = sitesWithAnswers(sitePermissions)
  const forNotifications = sitePermissions[ALL_SITES]?.notifications ?? 'ask'
  return (
    <>
      <AutoplaySettings snapshot={snapshot} update={update} />
      <Group title={t('settings.autorisations-memorisees')} searchKey="sitePermissions">
        <Check settingKey="allowScreenShare" label={t('settings.autoriser-les-sites-a-demander-le-partage')} hint={t('settings.un-site-peut-demander-a-partager-votre-ecran')} more={t('settings.un-site-ne-peut-le-demander-qu-apres-un')} checked={settings.allowScreenShare} onChange={(allowScreenShare) => update({ allowScreenShare })} />
        <Row label={t('settings.notifications-des-sites')} hint={t('settings.repond-a-la-demande-de-notification-de-tous-les-sites')}>
          <select
            className="field pop"
            aria-label={t('settings.notifications-des-sites')}
            value={forNotifications}
            onChange={(e) => void api().dispatch({ type: 'permission/set', origin: ALL_SITES, permission: 'notifications', decision: decisionOfChoice(e.target.value) })}
          >
            <option value="ask">{t('settings.demander-a-chaque-site')}</option>
            <option value="allow">{t('settings.autoriser-sur-tous-les-sites')}</option>
            <option value="deny">{t('settings.bloquer-sur-tous-les-sites')}</option>
          </select>
        </Row>
        <SubpageEntry id="permissions" snapshot={snapshot} />
      </Group>
      <HardwareSettings snapshot={snapshot} update={update} />
      <Subpage id="permissions">
      <Group id="permissions" title={t('settings.sub-permissions')} searchKey="sitePermissions">
        {remembered.length === 0 && <Row label={<span className="muted">{t('settings.aucune')}</span>} />}
        {remembered.flatMap(([origin, perms]) =>
          Object.entries(perms).map(([permission, decision]) => (
            <Row key={`${origin}/${permission}`} label={t('settings.permission-entry', { origin: origin.replace(/^https?:\/\//, ''), permission: permissionName(permission), decision: decision === 'allow' ? t('settings.autorise') : t('settings.refuse') })}>
              <button className="link-button" aria-label={actionName(t('settings.oublier'), `${origin.replace(/^https?:\/\//, '')}, ${permissionName(permission)}`)} onClick={() => void api().dispatch({ type: 'permission/set', origin, permission, decision: null })}>
                {t('settings.oublier')}
              </button>
            </Row>
          ))
        )}
      </Group>
      <SiteAutoplayList snapshot={snapshot} />
      </Subpage>
    </>
  )
}

/** Historique et données: the history, the clearing of the data of the browsing (the row of the current profile), the sheet « Effacer les données du site », the sites' data cleared on closing. */
function HistoryCategory({ snapshot, update }: PaneProps) {
  return (
    <>
      <HistorySettings
        snapshot={snapshot}
        update={update}
        leading={<ClearDataRow key={`clear-${activeProfileId(snapshot.state)}`} data-placement="page" snapshot={snapshot} profileId={activeProfileId(snapshot.state)} place="category" />}
        trailing={<SubpageEntry id="clearonclose" snapshot={snapshot} />}
      />
      <SiteDataSettings snapshot={snapshot} update={update} />
      <ClearOnCloseSettings snapshot={snapshot} update={update} />
    </>
  )
}

/** Verrouillage et mots de passe: the lock of the spaces and the password manager. */
function LockCategory({ snapshot, update }: PaneProps) {
  return (
    <>
      <LockSettings snapshot={snapshot} />
      <PasswordsSettings snapshot={snapshot} update={update} />
    </>
  )
}

/** Réseau et listes de filtres: the rows of two subpages, the filter lists of the blocker, and the encrypted DNS and the proxy. */
function NetworkCategory({ snapshot, update }: PaneProps) {
  return (
    <>
      <Group title={t('settings.section-reseau')}>
        <SubpageEntry id="filterlists" snapshot={snapshot} />
        <SubpageEntry id="network" snapshot={snapshot} />
      </Group>
      <Subpage id="filterlists">
        <FilterListsSettings snapshot={snapshot} update={update} />
      </Subpage>
      <Subpage id="network">
        <NetworkSettings snapshot={snapshot} update={update} />
      </Subpage>
    </>
  )
}

/** The bookmarks: the export to an HTML file, which asks for the tabs of the day each time (the library and the live folders are features to add). */
function BookmarksGroup({ snapshot }: Pick<PaneProps, 'snapshot'>) {
  const [bookmarksToday, setBookmarksToday] = useState(false)
  const [bookmarksStatus, setBookmarksStatus] = useState('')
  const exportBookmarks = () =>
    void api()
      .exportBookmarks({ includeToday: bookmarksToday })
      .then(
        (outcome) => setBookmarksStatus(outcome.message),
        (error: unknown) => {
          console.warn('[bookmarks] the export failed:', error)
          setBookmarksStatus(t('settings.export-impossible-erreur'))
        }
      )
  return (
    // An action and its option, no setting: the group waits in « Plus de réglages », where it was while it held the switches of the library.
    <Group title={t('settings.signets')} placement="more" footnote={<span role="status">{bookmarksStatus || t('settings.ecrit-les-favoris-les-onglets-epingles-et')}</span>}>
      <Check label={t('settings.inclure-aussi-les-onglets-du-jour')} hint={t('settings.desactive-seuls-les-favoris-les-onglets')} checked={bookmarksToday} onChange={setBookmarksToday} />
      <Row label={t('settings.exporter-les-signets-html')} hint={snapshot.private ? t('settings.indisponible-dans-une-fenetre-privee') : undefined} searchKey="exportBookmarks">
        <button className="button" disabled={snapshot.private === true} onClick={exportBookmarks}>
          {t('settings.exporter-les-signets-html-2')}
        </button>
      </Row>
    </Group>
  )
}

/** Fichiers et données: the downloads and the opening of files, the export of the bookmarks, the icons of the sites, the automatic copies, the export of everything. */
function FilesCategory({ snapshot, update }: PaneProps) {
  return (
    <>
      <DownloadSettings snapshot={snapshot} update={update} leading={<DownloadDirRow snapshot={snapshot} update={update} profileId={activeProfileId(snapshot.state)} place="category" />}>
        <FeatureSwitch id="download-status-chip" snapshot={snapshot} update={update} />
      </DownloadSettings>
      <BookmarksGroup snapshot={snapshot} />
      <FaviconSettings snapshot={snapshot} update={update} />
      <BackupSettings snapshot={snapshot} update={update} />
      <Group>
        <SyncEntry snapshot={snapshot} />
      </Group>
      <SyncSettings />
      <Place at="more">
        <ExportData />
      </Place>
    </>
  )
}

/** The folders of extensions loaded by hand and the button that loads one: the list of `extensionPaths`, on the subpage « Extensions chargées depuis un dossier ». */
function ExtensionFolders({ snapshot, update }: PaneProps) {
  const { extensionPaths } = snapshot.state.settings
  return (
    <Group keys={['extensionPaths']} title={t('settings.sub-extensionfolders')}>
      {extensionPaths.length === 0 && <Row label={<span className="muted">{t('settings.aucun-dossier-d-extension-charge-au')}</span>} />}
      {extensionPaths.map((path) => (
        // The main process follows the list (extension-folders.ts): the row going away takes the extension out of every profile at once.
        <Row key={path} label={<code>{path}</code>} hint={t('settings.l-extension-est-aussi-dechargee-tout-de-suite')}>
          <button className="link-button" aria-label={t('settings.retirer-name', { name: path })} onClick={() => update({ extensionPaths: extensionPaths.filter((p) => p !== path) })}>
            {t('settings.retirer')}
          </button>
        </Row>
      ))}
      <Row label={t('settings.extension-non-empaquetee-dossier-avec-manifest-json')}>
        <button className="button" onClick={() => void api().loadExtension()}>
          {t('settings.charger-une-extension')}
        </button>
      </Row>
    </Group>
  )
}

/**
 * The extensions: the page of the extensions (the one row of the essential level), the Web Store and each extension and its profiles, the folders loaded
 * by hand, the bridges to the programs of the Mac, and the toolbar.
 */
function ExtensionsGroup({ snapshot, update }: PaneProps) {
  const { settings } = snapshot.state
  return (
    <Group id="extensions" title={t('settings.extensions')} footnote={t('settings.desactiver-une-extension-pour-un-profil-ne')}>
      <Row label={t('settings.page-extensions')} hint={t('settings.page-extensions-hint')} searchKey="extensionList" placement="page">
        <button className="button" onClick={() => api().openOverlay({ panel: 'extensions' })}>
          {t('settings.ouvrir-la-page-extensions')}
        </button>
      </Row>
      <SubpageEntry id="extensionfolders" snapshot={snapshot} />
      <ExtensionRows snapshot={snapshot} update={update} />
      <Check
        settingKey="chromeNativeHosts"
        label={t('settings.utiliser-les-hotes-de-messagerie-native-de')}
        hint={t('settings.laisse-une-extension-parler-au-programme-qu')} more={t('settings.permet-a-une-extension-comme-claude-de')}
        checked={settings.chromeNativeHosts}
        onChange={(chromeNativeHosts) => update({ chromeNativeHosts })}
      />
      <Check
        settingKey="extensionOverflow"
        label={t('settings.ranger-dans-un-menu-les-icones-d-extensions')}
        hint={t('settings.les-icones-qui-ne-tiennent-pas-dans-la-barre')} more={t('settings.les-icones-qui-ne-tiennent-pas-sur-la-ligne')}
        checked={settings.extensionOverflow}
        onChange={(extensionOverflow) => update({ extensionOverflow })}
      />
      <Check
        settingKey="extensionDataApis"
        label={t('settings.donner-aux-extensions-l-acces-a-l')}
        hint={t('settings.les-extensions-qui-le-declarent-lisent-l')} more={t('settings.seules-les-extensions-qui-ont-declare-la')}
        checked={settings.extensionDataApis}
        onChange={(extensionDataApis) => update({ extensionDataApis })}
      />
      <Check
        settingKey="extensionTabCapture"
        label={t('settings.autoriser-les-extensions-a-capter-le-son-d-un-onglet')}
        hint={t('settings.une-extension-qui-le-declare-capte-le-son-d-un-onglet')} more={t('settings.eteint-aucune-extension-ne-capte-le-son-d-un-onglet')}
        checked={settings.extensionTabCapture}
        onChange={(extensionTabCapture) => update({ extensionTabCapture })}
      />
    </Group>
  )
}

/** The extensions, and the folders loaded by hand on their subpage. */
function ExtensionsCategory({ snapshot, update }: PaneProps) {
  return (
    <>
      <ExtensionsGroup snapshot={snapshot} update={update} />
      <Subpage id="extensionfolders">
        <ExtensionFolders snapshot={snapshot} update={update} />
      </Subpage>
    </>
  )
}

/** Outils et extensions: the extensions, the Tweaks, the battery saver and the translation (the scripts and the web tools are features to add). */
function ToolsCategory({ snapshot, update }: PaneProps) {
  const { settings } = snapshot.state
  return (
    <>
      <ExtensionsCategory snapshot={snapshot} update={update} />
      <Group className="with-icons">
        <Check
          settingKey="boostsEnabled"
          icon={<RowIcon color="purple">{ROW_ICONS.boost}</RowIcon>}
          label={t('settings.activer-les-retouches-sur-les-sites-web-que')}
          info={t('settings.desactive-aucune-retouche-ne-s-applique')}
          checked={settings.boostsEnabled}
          onChange={(boostsEnabled) => update({ boostsEnabled })}
        />
      </Group>
      <BoostShareSettings snapshot={snapshot} update={update} />
      <WebToolsSettings snapshot={snapshot} update={update} />
      <TranslateSettings snapshot={snapshot} update={update} />
    </>
  )
}

/** The content of a page, in the order its rows are best found. */
export function CategoryContent({ pane, snapshot, update, goTo }: CategoryProps & { pane: SettingsPage }) {
  switch (pane) {
    case 'home':
      // The choices of the first minutes, side by side: the page is drawn whole, with no fold.
      return (
        <Place at="page">
          <HomePage snapshot={snapshot} update={update} goTo={goTo} />
        </Place>
      )
    case 'appearance':
      return <AppearanceCategory snapshot={snapshot} update={update} />
    case 'tabs':
      return (
        <>
          <LaunchGroup snapshot={snapshot} update={update} />
          <SleepSettings snapshot={snapshot} update={update} />
          <TabsSettings snapshot={snapshot} update={update} />
          <WindowGroups snapshot={snapshot} update={update} />
        </>
      )
    case 'navigation':
      return (
        <>
          <SearchSettings snapshot={snapshot} update={update} />
          <CommandBarSettings snapshot={snapshot} update={update} />
          <LinksSettings snapshot={snapshot} update={update} />
        </>
      )
    case 'keyboard':
      return <KeyboardCategory snapshot={snapshot} update={update} goTo={goTo} />
    case 'protection':
      return (
        <>
          <BlockerCategory snapshot={snapshot} update={update} />
          <HistoryCategory snapshot={snapshot} update={update} />
          <SitesCategory snapshot={snapshot} update={update} />
          <LockCategory snapshot={snapshot} update={update} />
          <NetworkCategory snapshot={snapshot} update={update} />
        </>
      )
    case 'files':
      return <FilesCategory snapshot={snapshot} update={update} />
    case 'tools':
      return <ToolsCategory snapshot={snapshot} update={update} />
    case 'profiles':
      // The list of the profiles and the settings of the one picked sit side by side: the page is drawn whole, with no fold. The other ways to keep
      // activities apart (the containers, the private tabs, the guest window) are features to add, switched in « Fonctions en option ».
      return (
        <Place at="page">
          <ProfilesPane snapshot={snapshot} update={update} />
          <p className="pref-intro profiles-features">
            {t('settings-profiles.separer-dans-fonctions', { page: settingsPaneLabel('features') })}{' '}
            <button type="button" className="link-button" onClick={() => goTo('features')}>
              {t('settings.home-voir-fonctions')}
            </button>
          </p>
        </Place>
      )
    case 'features':
      // The catalogue is drawn whole, with no fold; the lists of three of its features are subpages, beside it.
      return (
        <>
          <Place at="page">
            <FeaturesPage snapshot={snapshot} update={update} />
          </Place>
          <FeatureSubpages snapshot={snapshot} update={update} />
        </>
      )
    case 'about':
      return (
        <>
          <UpdatesSettings snapshot={snapshot} update={update} />
          <IconSettings snapshot={snapshot} update={update} />
          <AboutSettings />
          {/* What informs the support (the state of the engine, the log, the report) waits in the fold. */}
          <Place at="more">
            <EngineStatus snapshot={snapshot} />
          </Place>
        </>
      )
  }
}
