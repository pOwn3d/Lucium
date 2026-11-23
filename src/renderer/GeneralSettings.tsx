// Rows of the application and of what the window shows of the page chrome: the default browser (« Pour commencer »), the updates (« À propos et mises à
// jour »), and in Apparence the accessibility (`AccessibilitySettings`) and the display (`DisplaySettings`: the previews of the tabs, light or dark, the
// zoom mark). A row that « Pour commencer » draws again is a component of its own here, drawn in both places.

import { useEffect, useState } from 'react'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from '@shared/ui-scale'
import { autoUpdateKey, updatesByHand } from '@shared/platform'
import { api } from './api'
import { FeatureSwitch } from './FeaturesSettings'
import { MIN_FONT_SIZES } from '@shared/min-font-size'
import { Check, Choice, Group, ROW_ICONS, Row, RowIcon, type DrawsRows } from './settings-parts'
import { t } from '@shared/i18n'

interface PaneProps {
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
}

/**
 * Whether Lucium is the browser of the system, and the button that makes it so (« Pour commencer » › Votre navigateur). The system is asked once the row
 * is drawn; until it answers, the row says nothing of it.
 */
export function DefaultBrowserRow() {
  const [isDefault, setIsDefault] = useState<boolean | null>(null)
  // What is said when Lucium could not be made the default browser.
  const [defaultNote, setDefaultNote] = useState('')
  useEffect(() => {
    let live = true
    const ask = (): void =>
      void api()
        .defaultBrowser()
        .then((value) => live && setIsDefault(value))
        // The answer stays unknown and the button is not drawn: the log says why.
        .catch((error: unknown) => console.warn('[settings] whether Lucium is the default browser could not be read:', error))
    ask()
    // Windows leaves the choice to its own Settings: ask again when the user comes back from there.
    window.addEventListener('focus', ask)
    return () => {
      live = false
      window.removeEventListener('focus', ask)
    }
  }, [])

  const makeDefault = () => {
    setDefaultNote('')
    void api()
      .setDefaultBrowser()
      .then((outcome) => {
        if (outcome === 'failed') setDefaultNote(t('general-settings.navigateur-par-defaut-echec'))
        else if (outcome === 'system-settings') setDefaultNote(t('general-settings.navigateur-par-defaut-parametres'))
        return api().defaultBrowser().then(setIsDefault)
      })
      .catch((error: unknown) => {
        console.error('[settings] Lucium could not be made the default browser:', error)
        setDefaultNote(t('general-settings.navigateur-par-defaut-echec'))
      })
  }

  const hint = isDefault === null ? undefined : isDefault ? t('settings.home-lucium-est-par-defaut') : t('settings.lucium-n-est-pas-votre-navigateur-par')
  return (
    <>
      <Row label={t('settings.home-navigateur-par-defaut')} hint={hint} searchKey="defaultBrowser">
        {isDefault === false && (
          <button className="button" onClick={makeDefault}>
            {t('settings.definir-lucium-par-defaut')}
          </button>
        )}
      </Row>
      {/* A row of its own under the button: a sentence in the control column would squeeze the label (seen on Windows). It goes once Lucium is the default. */}
      {defaultNote !== '' && isDefault !== true && (
        <div className="pref-row pref-message" role="status" data-role="default-browser-note">
          {defaultNote}
        </div>
      )}
    </>
  )
}

/**
 * The updates (« À propos et mises à jour »): the automatic check (on macOS; on Windows its own switch, off by default; on Linux, which installs nothing yet, a sentence
 * instead), the test channel of a build that carries one, the news after an update.
 */
export function UpdatesSettings({ snapshot, update }: PaneProps) {
  const { settings } = snapshot.state
  return (
    <Group title={t('settings.section-mises-a-jour')}>
      {updatesByHand(snapshot.platform) ? (
        // Linux reads no update address and has no installer yet: a switch for a check that reads nothing would only mislead. The row says how an update is made instead.
        <div className="pref-row pref-message" role="status" data-role="updates-by-hand">
          {t('settings.cette-version-ne-se-met-pas-a-jour-toute-seule')}
        </div>
      ) : autoUpdateKey(snapshot.platform) === 'windowsAutoUpdate' ? (
        // Windows has a switch of its own, off by default for everyone: `autoUpdate` (on in every profile of the 1.1.5, never chosen) commands nothing there. The help says what is sent.
        <Check
          settingKey="windowsAutoUpdate"
          label={t('features.rechercher-les-mises-a-jour-automatiquement')}
          hint={t('settings.windows-recherche-automatique-eteinte-par-defaut')} more={t('settings.windows-recherche-automatique-ce-qui-est-envoye')}
          checked={settings.windowsAutoUpdate}
          onChange={(windowsAutoUpdate) => update({ windowsAutoUpdate })}
        />
      ) : (
        <Check
          settingKey="autoUpdate"
          label={t('features.rechercher-les-mises-a-jour-automatiquement')}
          hint={t('settings.lucium-verifie-chaque-jour-s-il-existe-une')} more={t('settings.lucium-cherche-une-nouvelle-version-au')}
          checked={settings.autoUpdate}
          onChange={(autoUpdate) => update({ autoUpdate })}
        />
      )}
      {/* The choice exists only in a build that carries a test address: the setting picks between the two sealed addresses, never names one. */}
      {snapshot.updateTestChannel === true && (
        <Check
          settingKey="updateChannel"
          label={t('settings.recevoir-les-versions-de-test')}
          hint={t('settings.les-versions-de-test-arrivent-avant-la-version')}
          checked={settings.updateChannel === 'test'}
          onChange={(test) => update({ updateChannel: test ? 'test' : 'stable' })}
        />
      )}
      <FeatureSwitch id="whats-new" snapshot={snapshot} update={update} />
    </Group>
  )
}

/** The size of the interface: in Apparence › Accessibilité, and again on « Pour commencer » (`mirror`). */
export function UiScaleRow({ snapshot, update, mirror }: PaneProps & { mirror?: boolean }) {
  const { settings } = snapshot.state
  return (
    <Row settingKey="uiScale" mirror={mirror} label={t('settings.taille-de-l-interface')} hint={t('settings.agrandit-la-barre-laterale-la-barre-d-outils')} more={t('settings.agrandit-la-barre-laterale-la-barre-d')}>
      <input
        type="range"
        className="ui-scale-slider"
        aria-label={t('settings.taille-de-l-interface')}
        min={UI_SCALE_MIN}
        max={UI_SCALE_MAX}
        step={UI_SCALE_STEP}
        value={settings.uiScale}
        onChange={(e) => update({ uiScale: Number(e.target.value) })}
      />
      <span className="ui-scale-value" aria-live="polite">
        {t('resources.pourcent', { n: settings.uiScale })}
      </span>
    </Row>
  )
}
;(UiScaleRow as DrawsRows).rows = ['uiScale']

/** Light, dark or the system's, for Lucium: in Apparence › Affichage, and again on « Pour commencer » (`mirror`). */
export function InterfaceAppearanceRow({ snapshot, update, mirror }: PaneProps & { mirror?: boolean }) {
  const { settings } = snapshot.state
  return (
    <Row settingKey="interfaceAppearance" mirror={mirror} label={t('settings.apparence')} hint={t('settings.clair-sombre-ou-comme-le-mac-pour-les')} more={t('settings.clair-sombre-ou-celle-du-systeme-pour-les')}>
      <select className="field pop" aria-label={t('settings.apparence')} value={settings.interfaceAppearance} onChange={(e) => update({ interfaceAppearance: e.target.value as Settings['interfaceAppearance'] })}>
        <option value="auto">{t('menu.automatique')}</option>
        <option value="light">{t('menu.clair')}</option>
        <option value="dark">{t('menu.sombre')}</option>
      </select>
    </Row>
  )
}
;(InterfaceAppearanceRow as DrawsRows).rows = ['interfaceAppearance']

/** Whether the system asks for `query` now (a media query of the preferences of the system); false where there is no window to ask (the static render of a test). */
function useSystemAsks(query: string): boolean {
  const [asks, setAsks] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const listen = () => setAsks(list.matches)
    list.addEventListener('change', listen)
    return () => list.removeEventListener('change', listen)
  }, [query])
  return asks
}

/**
 * Apparence › Accessibilité: what helps to see and to read, in one group at the head of the category. The size of the interface is the setting it always was,
 * moved here; the three others can force what the system may already ask for (the value of the system is named in the hint, since a forced switch does not show it).
 * A switch asks for more, never for less than the system: "off" is "follow the system".
 */
export function AccessibilitySettings({ snapshot, update }: PaneProps) {
  const { settings } = snapshot.state
  const motion = useSystemAsks('(prefers-reduced-motion: reduce)')
  const contrast = useSystemAsks('(prefers-contrast: more)')
  const transparency = useSystemAsks('(prefers-reduced-transparency: reduce)')
  const says = (asked: boolean): string => (asked ? t('settings.le-systeme-le-demande') : t('settings.le-systeme-ne-le-demande-pas'))
  return (
    <Group title={t('settings.accessibilite')} footnote={t('settings.un-reglage-coche-s-ajoute-a-ce-que-demande-le')}>
      <UiScaleRow snapshot={snapshot} update={update} />
      <Row settingKey="minimumFontSize" label={t('settings.taille-minimale-du-texte-des-pages')} hint={t('settings.aucun-texte-de-page-n-est-dessine-plus-petit')} more={t('settings.les-onglets-deja-ouverts-gardent-la-taille-qu-ils')}>
        <Choice
          value={settings.minimumFontSize}
          choices={MIN_FONT_SIZES.map((px): [number, string] => [px, px === 0 ? t('settings.minimum-desactive') : t('settings.minimum-px', { px })])}
          onChange={(minimumFontSize) => update({ minimumFontSize })}
          label={t('settings.taille-minimale-du-texte-des-pages')}
        />
      </Row>
      <Check
        settingKey="forceReduceMotion"
        label={t('settings.toujours-reduire-les-animations')}
        hint={`${t('settings.arrete-les-animations-et-les-transitions-de-l')} ${says(motion)}`}
        checked={settings.forceReduceMotion}
        onChange={(forceReduceMotion) => update({ forceReduceMotion })}
      />
      <Check
        settingKey="forceHighContrast"
        label={t('settings.toujours-augmenter-le-contraste')}
        hint={`${t('settings.les-textes-gris-passent-en-gris-fonce-et-les')} ${says(contrast)}`}
        checked={settings.forceHighContrast}
        onChange={(forceHighContrast) => update({ forceHighContrast })}
      />
      <Check
        settingKey="forceReduceTransparency"
        label={t('settings.toujours-reduire-la-transparence')}
        hint={`${t('settings.les-panneaux-et-les-menus-flottants-deviennent')} ${says(transparency)}`}
        checked={settings.forceReduceTransparency}
        onChange={(forceReduceTransparency) => update({ forceReduceTransparency })}
      />
    </Group>
  )
}

/** Apparence › Interface: the previews of the tabs, light or dark, the zoom mark, the whole address in the toolbar, the button of the readable mode. */
export function DisplaySettings({ snapshot, update }: PaneProps) {
  const { settings } = snapshot.state
  return (
    <Group title={t('settings.affichage')}>
      <InterfaceAppearanceRow snapshot={snapshot} update={update} />
      <Check
        settingKey="hoverCards"
        label={t('settings.afficher-les-apercus-au-survol-des-onglets')}
        hint={t('settings.la-carte-d-un-onglet-survole-montre-son')} more={t('settings.survolez-un-onglet-de-la-barre-laterale-une')}
        checked={settings.hoverCards}
        onChange={(hoverCards) => update({ hoverCards })}
      />
      <Check
        settingKey="showZoomIndicator"
        label={t('settings.afficher-le-niveau-de-zoom-dans-la-barre-d')}
        hint={t('settings.une-petite-marque-125-apparait-quand-la')}
        checked={settings.showZoomIndicator}
        onChange={(showZoomIndicator) => update({ showZoomIndicator })}
      />
      <Check
        settingKey="fullUrlInToolbar"
        icon={<RowIcon color="red">{ROW_ICONS.url}</RowIcon>}
        label={t('settings.afficher-l-adresse-complete-quand-la-barre')}
        hint={t('settings.affiche-toute-l-adresse-plutot-que-le-nom-du')}
        more={t('settings.reglage-de-la-fenetre-principale')}
        checked={settings.fullUrlInToolbar}
        onChange={(fullUrlInToolbar) => update({ fullUrlInToolbar })}
      />
      <Check
        settingKey="readableToolbarButton"
        label={t('settings.bouton-contraste-de-la-page-dans-la-barre-d-outils')}
        hint={t('settings.un-clic-sur-ce-bouton-passe-la-page-en-mode')} more={t('settings.un-bouton-a-cote-de-infos-et-reglages-du-site')}
        checked={settings.readableToolbarButton}
        onChange={(readableToolbarButton) => update({ readableToolbarButton })}
      />
    </Group>
  )
}
