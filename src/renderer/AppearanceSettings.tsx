// Settings › Appearance: the readable mode of websites (the default for every site, and the sites that have a mode of their own), and the look of
// the window itself (a material behind the interface, how translucent it is, the border around the page). Every default keeps the standard look.

import type { Settings, WindowVibrancy } from '@shared/model'
import { SIDEBAR_OPACITY_MIN, WINDOW_BORDER_DEFAULT, WINDOW_BORDER_MAX, WINDOW_VIBRANCIES } from '@shared/model'
import { normalizeBlockHost } from '@shared/blocker'
import { READABLE_DEFAULTS, READABLE_LABELS, READABLE_MODES, SITE_READABLE_MAX, newSiteMode, type ReadableDefault, type ReadableMode } from '@shared/readable-mode'
import { VIBRANCY_LABELS } from '@shared/window-look'
import type { UiSnapshot } from '@shared/ipc'
import { api } from './api'
import { Check, Choice, Group, Row, Subpage, SubpageEntry } from './settings-parts'
import { SiteForm } from './SitePrivacySettings'
import { PanelSizeRows } from './PanelSizeSettings'
import { t } from '@shared/i18n'

interface Props {
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
}

// Built when the pane draws (not when the module loads): the texts follow the language chosen.
const opacityChoices = (): Array<[number, string]> => [100, 90, 80, 70, 60, 50, SIDEBAR_OPACITY_MIN].map((percent) => [percent, percent === 100 ? t('appearance-settings.100-opaque') : t('appearance-settings.percent', { percent })])
const borderChoices = (): Array<[number, string]> => [0, 2, 4, 6, 8, WINDOW_BORDER_DEFAULT, 12, 16, WINDOW_BORDER_MAX].map((px) => [px, px === WINDOW_BORDER_DEFAULT ? t('appearance-settings.px-par-defaut', { px }) : px === 0 ? t('appearance-settings.aucune') : `${px} px`])

export function AppearanceSettings({ snapshot, update }: Props) {
  const { settings } = snapshot.state
  const sites = Object.entries(settings.siteReadableMode)
  const choose = (site: string, value: ReadableMode | null) => void api().dispatch({ type: 'readable/site', site, mode: value })

  return (
    <>
      <Group title={t('appearance-settings.apparence-des-sites')} footnote={t('appearance-settings.les-images-et-les-videos-gardent-leurs')} more={t('appearance-settings.les-images-les-videos-et-les-lecteurs')}>
        <Row settingKey="websiteAppearance" label={t('settings.apparence-demandee-aux-sites')} hint={t('settings.le-theme-clair-ou-sombre-que-les-sites')} more={t('settings.apparence-demandee-aux-sites-hint')}>
          <select className="field pop" aria-label={t('settings.apparence-demandee-aux-sites')} value={settings.websiteAppearance} onChange={(e) => update({ websiteAppearance: e.target.value as Settings['websiteAppearance'] })}>
            <option value="auto">{t('menu.automatique')}</option>
            <option value="light">{t('menu.clair')}</option>
            <option value="dark">{t('menu.sombre')}</option>
          </select>
        </Row>
        <Row settingKey="readableMode" label={t('appearance-settings.contraste-de-la-page-pour-tous-les-sites')} hint={READABLE_LABELS[settings.readableMode].hint}>
          <select className="field pop" aria-label={t('appearance-settings.contraste-de-la-page-pour-tous-les-sites')} value={settings.readableMode} onChange={(e) => update({ readableMode: e.target.value as ReadableDefault })}>
            {READABLE_DEFAULTS.map((value) => (
              <option key={value} value={value}>
                {READABLE_LABELS[value].name}
              </option>
            ))}
          </select>
        </Row>
        <SubpageEntry id="contrast" snapshot={snapshot} />
      </Group>

      <Subpage id="contrast">
      <Group keys={['siteReadableMode']} title={t('appearance-settings.sites-avec-un-contraste-de-la-page-a-part')} footnote={t('appearance-settings.un-site-couvre-aussi-ses-sous-domaines-sauf')}>
        {sites.length === 0 && (
          <div className="pref-row pref-message" role="status">
            {t('appearance-settings.aucun-site-n-a-de-mode-a-part')}
          </div>
        )}
        {sites.map(([host, own]) => (
          <Row key={host} label={<code>{host}</code>}>
            <select className="field narrow" aria-label={t('appearance-settings.contraste-de-la-page-sur-host', { host })} value={own} onChange={(e) => choose(host, e.target.value as ReadableMode)}>
              {READABLE_MODES.map((value) => (
                <option key={value} value={value}>
                  {READABLE_LABELS[value].name}
                </option>
              ))}
            </select>
            <button className="link-button" onClick={() => choose(host, null)} aria-label={t('settings.retirer-name', { name: host })}>
              {t('settings.retirer')}
            </button>
          </Row>
        ))}
        <SiteForm label={t('site-privacy-settings.site-a-regler')} known={sites.map(([host]) => host)} normalize={normalizeBlockHost} max={SITE_READABLE_MAX} onAdd={(host) => choose(host, newSiteMode(settings.readableMode))} />
      </Group>
      </Subpage>

      {/* The anchor of the notice « Les panneaux vous semblent trop petits ? Régler… » (`panelsize`): the group is the place it leads to. */}
      <Group id="panelsize" title={t('panel-size.titre')} footnote={t('panel-size.les-panneaux-et-les-fenetres-a-part-prennent')} more={t('panel-size.note')}>
        <PanelSizeRows settings={settings} />
      </Group>

      <Group title={t('menu.fenetre')} footnote={t('appearance-settings.l-effet-de-verre-ne-se-voit-qu-a-travers-la')} more={t('appearance-settings.le-flou-d-arriere-plan-reel-derriere-la')}>
        <Row settingKey="windowVibrancy" label={t('appearance-settings.effet-de-verre-de-la-fenetre')} hint={t('appearance-settings.un-verre-depoli-derriere-la-barre-laterale')} more={t('appearance-settings.un-effet-de-verre-depoli-de-macos-derriere')}>
          <select className="field pop" aria-label={t('appearance-settings.effet-de-verre-de-la-fenetre')} value={settings.windowVibrancy} onChange={(e) => update({ windowVibrancy: e.target.value as WindowVibrancy })}>
            {WINDOW_VIBRANCIES.map((value) => (
              <option key={value} value={value}>
                {VIBRANCY_LABELS[value]}
              </option>
            ))}
          </select>
        </Row>
        <Row settingKey="sidebarOpacity" label={t('appearance-settings.opacite-de-la-barre-laterale')} hint={t('appearance-settings.laisse-voir-l-effet-de-verre-a-travers-les')}>
          <Choice className="pop" label={t('appearance-settings.opacite-de-la-barre-laterale')} value={settings.sidebarOpacity} choices={opacityChoices()} disabled={settings.windowVibrancy === 'none'} onChange={(sidebarOpacity) => update({ sidebarOpacity })} />
        </Row>
        <Row settingKey="windowBorder" label={t('appearance-settings.bordure-autour-de-la-page')} hint={t('appearance-settings.l-espace-entre-la-page-et-le-bord-de-la')}>
          <Choice className="pop" label={t('appearance-settings.bordure-autour-de-la-page')} value={settings.windowBorder} choices={borderChoices()} onChange={(windowBorder) => update({ windowBorder })} />
        </Row>
        <Check settingKey="cardOutline" label={t('appearance-settings.contour-fin-autour-de-la-page')} hint={t('appearance-settings.un-filet-clair-d-un-pixel-qui-detache-la')} checked={settings.cardOutline} onChange={(cardOutline) => update({ cardOutline })} />
      </Group>
    </>
  )
}
