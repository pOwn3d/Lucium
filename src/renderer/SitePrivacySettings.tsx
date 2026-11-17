// The groups of Settings that are about sites (and `SiteForm`, the field that adds a site to a list, which the readable mode's list uses too): autoplay (for the whole browser, and site by site), the
// sheet « Effacer les données du site » (its confirmation, its notice and the animation it draws on the page), and the sites whose data is erased when their last tab closes. The lists are also
// reached from the site control center and the menu of a tab.

import { useState, type ReactNode } from 'react'
import { AUTOPLAY_LABELS, AUTOPLAY_MODES, autoplayKeyOf, type AutoplayMode } from '@shared/autoplay'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { SITE_CLEAR_MAX, setClearedOnClose } from '@shared/site-clear'
import { SITE_DATA_ANIMATIONS, SITE_DATA_ANIMATION_GLYPHS, SITE_DATA_ANIMATION_LABELS } from '@shared/site-data-overlay'
import { api } from './api'
import { Check, Group, Row, Subpage } from './settings-parts'
import { StrokeGlyph } from './stroke-glyph'
import { t } from '@shared/i18n'
import { radioGroupKeys } from './radio-keys'

type Verdict = { host: string } | { error: string } | null

/** What a typed site stands for: the host to keep, or the sentence that says why not. */
function checkSite(input: string, known: readonly string[], normalize: (site: string) => string | null, max: number): Verdict {
  if (input.trim() === '') return null
  const host = normalize(input)
  if (host === null) return { error: t('site-privacy-settings.cette-adresse-de-site-n-est-pas-valide') }
  if (known.includes(host)) return { error: t('site-privacy-settings.ce-site-est-deja-dans-la-liste') }
  if (known.length >= max) return { error: t('site-privacy-settings.la-liste-est-pleine') }
  return { host }
}

export function SiteForm({ label, known, normalize, max, onAdd, children }: { label: string; known: readonly string[]; normalize: (site: string) => string | null; max: number; onAdd: (host: string) => void; children?: ReactNode }) {
  const [draft, setDraft] = useState('')
  const verdict = checkSite(draft, known, normalize, max)
  const add = () => {
    if (!verdict || !('host' in verdict)) return
    onAdd(verdict.host)
    setDraft('')
  }
  return (
    <>
      <div className="pref-row pref-form">
        <input className="field" placeholder={t('settings.exemple-org')} aria-label={label} aria-invalid={verdict !== null && 'error' in verdict} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        {children}
        <button className="button" disabled={!verdict || 'error' in verdict} onClick={add}>
          {t('settings.ajouter')}
        </button>
      </div>
      {verdict && 'error' in verdict && (
        <div className="pref-row pref-message pref-error" role="alert">
          {verdict.error}
        </div>
      )}
    </>
  )
}

// Read when the pane draws, not when the module loads: the names follow the language chosen.
const modeChoices = () => AUTOPLAY_MODES.map((mode) => ({ mode, name: AUTOPLAY_LABELS[mode].name }))

/**
 * The autoplay for every site, at the top of Autorisations des sites. The choice of a site of its own is offered by « Infos et réglages du site » and
 * listed on the subpage « Autorisations mémorisées » (`SiteAutoplayList`); it always applies: the switch « Un réglage pour chaque site », a setting of a
 * setting, is gone (its key, `autoplayPerSite`, is no longer read).
 */
export function AutoplaySettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  return (
    <Group title={t('site-privacy-settings.lecture-automatique')} footnote={t('site-privacy-settings.un-changement-s-applique-aux-nouveaux')} more={t('site-privacy-settings.electron-laisse-tout-demarrer-seul')}>
      <Row settingKey="autoplayPolicy" label={t('site-privacy-settings.pour-tous-les-sites')} hint={AUTOPLAY_LABELS[settings.autoplayPolicy].hint} more={AUTOPLAY_LABELS[settings.autoplayPolicy].more}>
        <select className="field pop" aria-label={t('site-privacy-settings.lecture-automatique-pour-tous-les-sites')} value={settings.autoplayPolicy} onChange={(e) => update({ autoplayPolicy: e.target.value as AutoplayMode })}>
          {modeChoices().map((choice) => (
            <option key={choice.mode} value={choice.mode}>
              {choice.name}
            </option>
          ))}
        </select>
      </Row>
    </Group>
  )
}

/** The sites that have an autoplay of their own, each with its menu (« Par défaut » gives it back to the general choice), and the field that adds one. */
export function SiteAutoplayList({ snapshot }: { snapshot: UiSnapshot }) {
  const { settings } = snapshot.state
  const sites = Object.entries(settings.siteAutoplay)
  const [mode, setMode] = useState<AutoplayMode>('allow')
  const choose = (site: string, value: AutoplayMode | null) => void api().dispatch({ type: 'autoplay/site', site, mode: value })
  return (
    <Group keys={['siteAutoplay']} title={t('site-privacy-settings.lecture-automatique-par-site')}>
      {sites.length === 0 && (
        <div className="pref-row pref-message" role="status">
          {t('site-privacy-settings.aucun-site-n-a-de-reglage-propre')}
        </div>
      )}
      {sites.map(([host, own]) => (
        <Row key={host} label={<code>{host}</code>} hint={t('site-privacy-settings.ses-sous-domaines-suivent')}>
          <select className="field pop" aria-label={t('site-privacy-settings.lecture-automatique-sur-host', { host })} value={own} onChange={(e) => choose(host, e.target.value === 'default' ? null : (e.target.value as AutoplayMode))}>
            {modeChoices().map((choice) => (
              <option key={choice.mode} value={choice.mode}>
                {choice.name}
              </option>
            ))}
            <option value="default">{t('site-privacy-settings.par-defaut-reglage-general')}</option>
          </select>
        </Row>
      ))}
      <SiteForm label={t('site-privacy-settings.site-a-regler')} known={Object.keys(settings.siteAutoplay)} normalize={autoplayKeyOf} max={500} onAdd={(host) => choose(host, mode)}>
        <select className="field narrow" aria-label={t('site-privacy-settings.reglage-du-nouveau-site')} value={mode} onChange={(e) => setMode(e.target.value as AutoplayMode)}>
          {modeChoices().map((choice) => (
            <option key={choice.mode} value={choice.mode}>
              {choice.name}
            </option>
          ))}
        </select>
      </SiteForm>
    </Group>
  )
}

/**
 * « Effacer les données du site »: what the sheet does around a run (the extension's Réglages, where they fit Lucium). Its other choices (the types,
 * the scopes, the switches) stay in the sheet, remembered from one run to the next. A private window shows the main window's, without letting them change.
 */
export function SiteDataSettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  const locked = snapshot.private === true
  return (
    <Group id="sitedata" keys={['siteDataConfirm', 'siteDataNotify', 'siteDataAnimation']} title={t('site-data-settings.titre')} footnote={locked ? t('site-data.ces-reglages-sont-ceux-de-la-fenetre-principale') : t('site-data-settings.note')}>
      <Check
        settingKey="siteDataConfirm"
        label={t('site-data-settings.demander-confirmation')}
        hint={t('site-data-settings.demander-confirmation-aide')}
        checked={settings.siteDataConfirm}
        disabled={locked}
        onChange={(siteDataConfirm) => update({ siteDataConfirm })}
      />
      <Check
        settingKey="siteDataNotify"
        label={t('site-data-settings.notifier-au-raccourci')}
        hint={t('site-data-settings.une-notification-du-systeme-confirme-un')} more={t('site-data-settings.notifier-au-raccourci-aide')}
        checked={settings.siteDataNotify}
        disabled={locked}
        onChange={(siteDataNotify) => update({ siteDataNotify })}
      />
      <Row settingKey="siteDataAnimation" className="sitedata-anim-row" label={t('site-data-settings.animation-sur-la-page')} hint={t('site-data-settings.animation-sur-la-page-aide')}>
        <div className="sitedata-anim-grid" role="radiogroup" onKeyDown={radioGroupKeys} aria-label={t('site-data-settings.animation-sur-la-page')}>
          {SITE_DATA_ANIMATIONS.map((animation) => (
            <button
              key={animation}
              type="button"
              role="radio"
              aria-checked={settings.siteDataAnimation === animation}
              className="sitedata-anim"
              disabled={locked}
              onClick={() => update({ siteDataAnimation: animation })}
            >
              <StrokeGlyph parts={SITE_DATA_ANIMATION_GLYPHS[animation]} size={18} />
              <span>{SITE_DATA_ANIMATION_LABELS[animation].name}</span>
            </button>
          ))}
        </div>
      </Row>
    </Group>
  )
}

/** What the subpage « Effacer certains sites en partant » holds: the switch, the sites, the field that adds one, and the clearing at the quit too. */
export function ClearOnCloseSettings({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  return (
    <Subpage id="clearonclose">
      <ClearOnCloseList snapshot={snapshot} update={update} />
    </Subpage>
  )
}

function ClearOnCloseList({ snapshot, update }: { snapshot: UiSnapshot; update: (patch: Partial<Settings>) => void }) {
  const { settings } = snapshot.state
  const hosts = settings.siteDataClearOnClose
  if (snapshot.private) {
    return (
      <Group title={t('site-privacy-settings.effacer-les-donnees-de-ces-sites-a-la-fermeture')}>
        <Row label={<span className="muted">{t('site-privacy-settings.indisponible-dans-une-fenetre-privee-sa-session')}</span>} />
      </Group>
    )
  }
  return (
    <Group
      keys={['siteDataClearOnClose']}
      title={t('site-privacy-settings.effacer-les-donnees-de-ces-sites-a-la-fermeture')}
      footnote={t('site-privacy-settings.ce-qui-est-efface-suit-les-choix-de-effacer-en-bref')} more={t('site-privacy-settings.desactive-par-defaut-quand-le-dernier')}
    >
      <Check
        settingKey="siteDataClearOnCloseEnabled"
        label={t('site-privacy-settings.effacer-a-la-fermeture-du-dernier-onglet-du-site')}
        hint={t('site-privacy-settings.les-cookies-et-le-stockage-d-un-site-de-la')} more={t('site-privacy-settings.le-menu-d-un-onglet-et-infos-et-reglages-du-site')}
        checked={settings.siteDataClearOnCloseEnabled}
        onChange={(siteDataClearOnCloseEnabled) => update({ siteDataClearOnCloseEnabled })}
      />
      {hosts.length === 0 && (
        <div className="pref-row pref-message" role="status">
          {t('site-privacy-settings.aucun-site-le-menu-d-un-onglet-et-le')}
        </div>
      )}
      {hosts.map((host) => (
        <Row key={host} label={<code>{host}</code>}>
          <button className="link-button" aria-label={t('settings.retirer-name', { name: host })} onClick={() => void api().dispatch({ type: 'siteclear/site', site: host, on: false })}>
            {t('settings.retirer')}
          </button>
        </Row>
      ))}
      <SiteForm
        label={t('site-privacy-settings.site-a-effacer-a-la-fermeture')}
        known={hosts}
        normalize={(site) => {
          const next = setClearedOnClose([], site, true)
          return next[0] ?? null
        }}
        max={SITE_CLEAR_MAX}
        onAdd={(host) => void api().dispatch({ type: 'siteclear/site', site: host, on: true })}
      />
      <Check
        settingKey="siteDataClearOnQuit"
        label={t('site-privacy-settings.aussi-a-la-fermeture-d-lucium')}
        hint={t('site-privacy-settings.les-sites-de-la-liste-sont-aussi-effaces')} more={t('site-privacy-settings.les-sites-de-la-liste-sont-effaces-dans')}
        disabled={!settings.siteDataClearOnCloseEnabled}
        checked={settings.siteDataClearOnQuit}
        onChange={(siteDataClearOnQuit) => update({ siteDataClearOnQuit })}
      />
    </Group>
  )
}
