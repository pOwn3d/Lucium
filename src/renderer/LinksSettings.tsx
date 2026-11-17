// Settings › Navigation, its links: where the links of other apps open (the preset « Liens venus d’autres applications », at the top of the group
// « Liens »), the mini window (the links from other apps, the delay before a forgotten one is archived, ⌥⌘-click), Glance, where a link opens in the
// background, and the routes that send a link from another app to a space. The two ways other programs hand Lucium a page (a site as an application,
// the lucium:// addresses) are features to add, in « Fonctions en option ».

import { useState } from 'react'
import type { UiSnapshot } from '@shared/ipc'
import type { LinkRoute, Settings } from '@shared/model'
import { routeTargetLabel } from '@shared/sessions'
import { effectiveAccelerator, formatAccelerator } from '@shared/keybindings'
import { LinksPresetRow } from './CategoryRows'
import { LittleArcSettings } from './LittleArcSettings'
import { Check, Choice, Group, Place, Row, Subpage, SubpageEntry, type DrawsRows } from './settings-parts'
import { t } from '@shared/i18n'

// Functions, not constants: the words are read when the pane is drawn, in the language of the moment.
// The row names the action (close and archive the forgotten mini windows): each delay reads "After …", as the archive of the tabs does.
const littleChoices = (): Array<[number, string]> => [[0, t('settings.jamais')], [1, t('settings.apres-1-heure')], [6, t('settings.apres-6-heures')], [12, t('settings.apres-12-heures')], [24, t('settings.apres-1-jour')], [168, t('settings.apres-7-jours')]]

interface PaneProps {
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
}

/**
 * "Air Traffic Control": which space a site opens in when a link comes from another app. The rules, each with « Retirer », and the form that adds one:
 * on the subpage « Diriger les liens de certains sites vers un espace » (it was a box over the window before).
 */
export function LinkRoutes({ snapshot, update }: PaneProps) {
  const { settings, spaces } = snapshot.state
  const [route, setRoute] = useState<LinkRoute>({ host: '', spaceId: '' })
  const valid = /^[a-z0-9.-]+\.[a-z]{2,}$|^localhost$/i.test(route.host.trim()) && route.spaceId !== ''
  const add = () => {
    if (!valid) return
    const host = route.host.trim().toLowerCase().replace(/^www\./, '')
    update({ linkRoutes: [...settings.linkRoutes.filter((x) => x.host !== host), { host, spaceId: route.spaceId }] })
    setRoute({ host: '', spaceId: '' })
  }
  return (
    <Group keys={['linkRoutes']} title={t('settings.choisissez-ou-les-liens-s-ouvrent-dans')} footnote={t('settings.sans-regle-pour-son-site-le-lien-s-ouvre')} more={t('settings.un-lien-ouvert-depuis-une-autre-app-mail')}>
      {settings.linkRoutes.length === 0 && <div className="pref-row pref-message">{t('settings.aucune-regle')}</div>}
      {settings.linkRoutes.map((r) => (
        <Row
          key={r.host}
          label={
            <>
              <code>{r.host}</code> → {routeTargetLabel(snapshot.state, r.spaceId)}
            </>
          }
        >
          <button className="link-button" aria-label={t('settings.retirer-name', { name: r.host })} onClick={() => update({ linkRoutes: settings.linkRoutes.filter((x) => x.host !== r.host) })}>
            {t('settings.retirer')}
          </button>
        </Row>
      ))}
      {/* The form stands for the rules (a search that names them, « espaces » or « liens », finds it as it found the row that opened the box before). */}
      <div className="pref-row pref-form" data-setting="linkRoutes">
        <input className="field" placeholder={t('settings.site-ex-github-com')} aria-label={t('settings.site')} value={route.host} onChange={(e) => setRoute({ ...route, host: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <select className="field" aria-label={t('settings.espace')} value={route.spaceId} onChange={(e) => setRoute({ ...route, spaceId: e.target.value })}>
          <option value="">{t('settings.espace-2')}</option>
          {spaces.map((sp) => (
            <option key={sp.id} value={sp.id}>
              {sp.emoji} {sp.name}
            </option>
          ))}
        </select>
        <button className="button" disabled={!valid} onClick={add}>
          {t('settings.ajouter')}
        </button>
      </div>
    </Group>
  )
}

/** ⌥⌘N, the mini window from any application: in Clavier et souris › Raccourcis dans toutes les applications. */
export function LittleShortcutRow({ snapshot, update }: PaneProps) {
  const { settings } = snapshot.state
  const accelerator = effectiveAccelerator('newLittleArc', settings.keyBindings)
  const shortcut = accelerator ? formatAccelerator(accelerator) : ''
  return (
    <Check
      settingKey="littleArcShortcut"
      label={t('settings.raccourci-de-la-mini-fenetre-dans-toutes-les-applications')}
      hint={accelerator ? t('settings.little-shortcut-on', { shortcut }) : t('settings.la-commande-nouvelle-mini-fenetre-n-a-pas-de-raccourci')}
      checked={settings.littleArcShortcut}
      disabled={!accelerator}
      onChange={(littleArcShortcut) => update({ littleArcShortcut })}
    />
  )
}
;(LittleShortcutRow as DrawsRows).rows = ['littleArcShortcut']

export function LinksSettings({ snapshot, update }: PaneProps) {
  const { settings } = snapshot.state
  return (
    <div className="pane-links">
      {/* The mini window and what introduces it wait in « Plus de réglages »: where the links of other applications open is the preset of « Liens », below. */}
      <Place at="more">
        <p className="links-text" style={{ marginTop: 24 }}>
          {t('settings.la-mini-fenetre-est-une-fenetre-lucium-plus')}
        </p>
      </Place>
      <Group id="links" title={t('little-arc-settings.mini-fenetre')}>
        <Row settingKey="littleArcArchiveHours" label={t('settings.fermer-et-archiver-les-mini-fenetres-oubliees')} className="popup-row">
          <Choice className="pop" label={t('settings.fermer-et-archiver-les-mini-fenetres-oubliees')} value={settings.littleArcArchiveHours} choices={littleChoices()} onChange={(littleArcArchiveHours) => update({ littleArcArchiveHours })} />
        </Row>
      </Group>

      <LittleArcSettings snapshot={snapshot} update={update} />

      {/* What introduces the Peek goes with its rows, in « Plus de réglages ». */}
      <Place at="more">
        <div className="pref-sep" />
        <p className="links-text" style={{ marginTop: 24 }}>
          {t('settings.le-coup-d-oeil-affiche-un-lien-par-dessus-la-page')}
        </p>
      </Place>
      <Group title={t('settings.section-coup-d-oeil')}>
        <Check settingKey="peekWithShift" label={t('settings.coup-d-oeil-avec-maj-clic-sur-un-lien')} hint={t('features.previsualise-le-lien-dans-un-panneau-plutot-que')} checked={settings.peekWithShift} onChange={(peekWithShift) => update({ peekWithShift })} />
        <Check settingKey="peekOnExternalLinks" label={t('settings.coup-d-oeil-pour-les-liens-vers-d-autres-sites')} hint={t('settings.seulement-pour-les-liens-qui-ouvrent-un-nouvel-onglet')} checked={settings.peekOnExternalLinks} onChange={(peekOnExternalLinks) => update({ peekOnExternalLinks })} />
      </Group>

      {/* The preset at the top; the switch of the links of other apps waits under the same title, in « Plus de réglages » (the one of the links that
          open a new tab, the other setting it writes, is the first option of the mini window, which the note of that group names). */}
      <Group title={t('settings.section-liens')}>
        <LinksPresetRow snapshot={snapshot} update={update} />
        <Check
          settingKey="modifiedClickBackground"
          label={t('settings.ouvrir-en-arriere-plan-les-liens-ouverts')}
          hint={t('settings.desactive-l-onglet-s-ouvre-au-premier-plan')}
          checked={settings.modifiedClickBackground}
          onChange={(modifiedClickBackground) => update({ modifiedClickBackground })}
        />
        {/* The switch alone: the preset row stands for its setting, so this row leaves it the key and keeps its dot and its « Rétablir ». */}
        <Check
          placement="more"
          changeKeys={['externalLinksInLittleArc']}
          label={t('settings.les-liens-d-autres-apps-s-ouvrent-dans')}
          checked={settings.externalLinksInLittleArc}
          onChange={(externalLinksInLittleArc) => update({ externalLinksInLittleArc })}
        />
        <Check
          settingKey="blankLinkBackground"
          label={t('settings.ouvrir-en-arriere-plan-les-liens-qui-s')}
          hint={t('settings.un-lien-prevu-pour-un-nouvel-onglet-s-ouvre')}
          more={t('settings.par-defaut-lucium-les-ouvre-au-premier')}
          checked={settings.blankLinkBackground}
          onChange={(blankLinkBackground) => update({ blankLinkBackground })}
        />
        <SubpageEntry id="linkroutes" snapshot={snapshot} />
      </Group>
      <Subpage id="linkroutes">
        <LinkRoutes snapshot={snapshot} update={update} />
      </Subpage>
    </div>
  )
}

