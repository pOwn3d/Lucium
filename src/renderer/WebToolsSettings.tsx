// Settings for the battery saver (Outils et extensions), the pages watched and the summary by a local model (« Fonctions en option », FeaturesPage.tsx:
// the switches of the QR code, the reading aloud and the watching of pages are lines of that page), and for the mouse gestures (Clavier et souris).
// Every one is off by default and costs nothing while it is off. The autoscroll is drawn with the mouse gestures and the synchronized scrolling with the
// split view (SettingsCategories.tsx, TabsSettings.tsx).

import { useState, type ReactNode } from 'react'
import type { UiSnapshot } from '@shared/ipc'
import type { PageWatch, Settings } from '@shared/model'
import { gesturesSummary } from '@shared/gestures'
import { PAGE_WATCH_MAX, pageWatchChoices, watchIntervalLabel, watchStatus } from '@shared/page-watch'
import { checkSleepHost } from '@shared/sleep'
import { Check, Group, Row, Subpage, SubpageEntry } from './settings-parts'
import { AISettings } from './AISettings'
import { t } from '@shared/i18n'
import { settingsPath } from '@shared/settings-path'

interface Props {
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
}

/** The mouse gestures: the switch, what each shape does, and the sites where they are off. `children`: more rows of the group (the autoscroll, drawn by the category). */
export function MouseGesturesSettings({ snapshot, update, children }: Props & { children?: ReactNode }) {
  const { settings } = snapshot.state
  const hosts = settings.mouseGestureExcludedHosts
  const [draft, setDraft] = useState('')
  const verdict = draft.trim() === '' ? null : checkSleepHost(draft, hosts)
  const add = () => {
    if (!verdict || !('host' in verdict)) return
    update({ mouseGestureExcludedHosts: [...hosts, verdict.host] })
    setDraft('')
  }
  return (
    <>
      <Group
        title={t('web-tools-settings.gestes-de-souris')}
        footnote={
          settings.mouseGestures
            ? t('web-tools-settings.maintenez-le-bouton-droit-tracez-le-geste')
            : t('web-tools-settings.desactive-le-clic-droit-ouvre-toujours-le')
        }
        more={settings.mouseGestures ? t('web-tools-settings.maintenez-le-bouton-droit-deplacez-la', { gestures: gesturesSummary() }) : undefined}
      >
        <Check
          settingKey="mouseGestures"
          label={t('web-tools-settings.gestes-de-souris')}
          hint={t('web-tools-settings.un-geste-du-bouton-droit-pour-reculer')} more={t('web-tools-settings.certains-sites-utilisent-le-clic-droit-eux', { settingsPath: settingsPath('mouseGestureSites') })}
          checked={settings.mouseGestures}
          onChange={(mouseGestures) => update({ mouseGestures })}
        />
        {children}
        {/* The sites left out of the gestures and of the Vim keys: one subpage, while either is on. */}
        {(settings.mouseGestures || settings.vimKeys) && <SubpageEntry id="siteexclusions" snapshot={snapshot} />}
      </Group>
      {settings.mouseGestures && (
        <Subpage id="siteexclusions">
        <Group keys={['mouseGestureExcludedHosts']} title={t('web-tools-settings.sites-sans-gestes-de-souris')} footnote={t('web-tools-settings.un-site-de-la-liste-couvre-aussi-ses-sous')}>
          {hosts.length === 0 && (
            <div className="pref-row pref-message" role="status">
              {t('settings.aucun-site')}
            </div>
          )}
          {hosts.map((host) => (
            <Row key={host} label={<code>{host}</code>}>
              <button className="link-button" onClick={() => update({ mouseGestureExcludedHosts: hosts.filter((h) => h !== host) })} aria-label={t('settings.retirer-name', { name: host })}>
                {t('settings.retirer')}
              </button>
            </Row>
          ))}
          <div className="pref-row pref-form">
            <input
              className="field"
              placeholder={t('settings.exemple-org')}
              aria-label={t('web-tools-settings.site-sans-gestes-de-souris')}
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
        </Group>
        </Subpage>
      )}
    </>
  )
}

function WatchRow({ watch, update, all, now }: { watch: PageWatch; update: Props['update']; all: readonly PageWatch[]; now: number }) {
  const host = URL.canParse(watch.url) ? new URL(watch.url).host : watch.url
  const offered = pageWatchChoices()
  const choices = offered.some(([minutes]) => minutes === watch.minutes) ? offered : [...offered,[watch.minutes, t('web-tools-settings.toutes-les-interval', { interval: watchIntervalLabel(watch.minutes) })] as [number, string]]
  return (
    <Row label={watch.title} hint={`${host}${watch.selector ? ` · ${t('web-tools-settings.une-zone-de-la-page')}` : ''} · ${watchStatus(watch, now)}`}>
      <select
        className="field pop"
        aria-label={t('web-tools-settings.frequence-de-la-surveillance-de-title', { title: watch.title })}
        value={watch.minutes}
        onChange={(e) => update({ pageWatches: all.map((w) => (w.id === watch.id ? { ...w, minutes: Number(e.target.value) } : w)) })}
      >
        {choices.map(([minutes, text]) => (
          <option key={minutes} value={minutes}>
            {text}
          </option>
        ))}
      </select>
      <button className="link-button" onClick={() => update({ pageWatches: all.filter((w) => w.id !== watch.id) })} aria-label={t('web-tools-settings.ne-plus-surveiller-title', { title: watch.title })}>
        {t('settings.retirer')}
      </button>
    </Row>
  )
}

/** The battery saver (Outils et extensions): the one row left of the web tools, whose switches are lines of « Fonctions en option ». */
export function WebToolsSettings({ snapshot, update }: Props) {
  const { settings } = snapshot.state
  return (
    <Group title={t('web-tools-settings.outils-web')} footnote={t('web-tools-settings.ces-outils-sont-facultatifs-tous-sont')}>
      <Check
        settingKey="batterySaver"
        label={t('menu.mode-economie-de-batterie')}
        hint={t('web-tools-settings.a-20-de-batterie-ou-moins-ou-a-la-demande')} more={t('web-tools-settings.quand-la-batterie-est-a-20-ou-moins-ou-a')}
        checked={settings.batterySaver}
        onChange={(batterySaver) => update({ batterySaver })}
      />
    </Group>
  )
}

/**
 * The pages watched, on the subpage « Pages surveillées », whose row follows the line of « Surveiller des pages » in « Fonctions en option »: drawn while
 * the watching is on.
 */
export function PageWatchesSettings({ snapshot, update }: Props) {
  const { settings } = snapshot.state
  if (!settings.pageWatch) return null
  return (
    <Subpage id="pagewatches">
    <Group keys={['pageWatches']} title={t('web-tools-settings.pages-surveillees')} footnote={t('web-tools-settings.au-plus-page-watch-max-pages-chacune-relue', { PAGE_WATCH_MAX })} more={t('web-tools-settings.au-plus-page-watch-max-pages-une-lecture-a-la', { PAGE_WATCH_MAX })}>
      {settings.pageWatches.length === 0 && (
        <div className="pref-row pref-message" role="status">
          {t('web-tools-settings.aucune-page-surveillee-ouvrez-en-une-puis')}
        </div>
      )}
      {settings.pageWatches.map((watch) => (
        <WatchRow key={watch.id} watch={watch} update={update} all={settings.pageWatches} now={Date.now()} />
      ))}
    </Group>
    </Subpage>
  )
}

/** The page summary by a local model (« Fonctions en option »): its switch, the configuration of Ollama, and where the text of a page goes. */
export function SummarySettings({ snapshot, update }: Props) {
  return (
    <Group keys={['ollamaConfig', 'aiSummary']} title={t('ollama-settings.title')}>
      <AISettings settings={snapshot.state.settings} update={update} />
    </Group>
  )
}
