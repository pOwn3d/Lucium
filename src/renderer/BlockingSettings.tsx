// The settings of the ad and tracker blocker, beyond its two switches: the mode, hiding elements and the sites where nothing is blocked
// (`BlockingSettings`, under "Bloqueur"), and the filter lists and how fresh they are (`FilterListsSettings`, under "Listes et réseau").

import { useId, useState } from 'react'
import { fieldError } from './field-error'
import { checkBlockException } from '@shared/blocker'
import { CUSTOM_LISTS_MAX, CUSTOM_PASTE_MAX_CHARS, describeReview, type AddFilterListResult } from '@shared/custom-filter-lists'
import { FILTER_LISTS, listStatusLine, type BlockingStatus } from '@shared/filter-lists'
import { getLanguage, t, tp } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { BlockMode, Settings } from '@shared/model'
import { adsBlockingOn } from '@shared/privacy-dashboard'
import { api } from './api'
import { ArcDialog } from './ArcDialog'
import { Check, Group, MoreText, Row, Subpage } from './settings-parts'
import './shields.css'
import { settingsPath } from '@shared/settings-path'

// The full sentence of each mode is the hint of the row: the pop-up button itself only has room for the name.
// (Getters and a function, not constants: the texts are looked up when the pane draws, in the language chosen then.)
const MODE_NAMES: Record<BlockMode, string> = {
  get standard() { return t('blocking-settings.standard') },
  get strict() { return t('blocking-settings.strict') }
}
const MODE_HINTS: Record<BlockMode, string> = {
  get standard() { return t('blocking-settings.standard-bloque-les-publicites-et') },
  get strict() { return t('blocking-settings.strict-bloque-aussi-les-requetes-du-site') }
}

const updateChoices = (): Array<[number, string]> => [[1, t('blocking-settings.tous-les-jours')], [2, t('blocking-settings.tous-les-2-jours')], [4, t('blocking-settings.tous-les-4-jours')], [7, t('blocking-settings.toutes-les-semaines')], [14, t('blocking-settings.toutes-les-2-semaines')]]

interface Props {
  snapshot: UiSnapshot
  update: (patch: Partial<Settings>) => void
}

export function BlockingSettings({ snapshot, update }: Props) {
  const { settings } = snapshot.state
  const [draft, setDraft] = useState('')
  const anyOn = adsBlockingOn(settings) || settings.blockCookieBanners
  const cosmeticLabel = t('blocking-settings.masquer-les-encarts-publicitaires-dans-les')
  const cosmeticId = useId()
  const exceptions = settings.blockExceptions
  const verdict = draft.trim() === '' ? null : checkBlockException(draft, exceptions)
  const error = fieldError(useId(), verdict !== null && 'error' in verdict)
  const add = () => {
    if (!verdict || !('host' in verdict)) return
    update({ blockExceptions: [...exceptions, verdict.host] })
    setDraft('')
  }

  return (
    <>
      <Group title={t('blocking-settings.mode-de-blocage')} keys={['blockMode']} footnote={t('blocking-settings.le-mode-ne-change-pas-le-masquage-des')} more={t('blocking-settings.le-masquage-des-elements-ne-change-pas-avec-le-mode')}>
        {/* The mode judges the requests of both kinds of lists (ads and cookie banners, see service.ts `judge`): it stays a working choice while either is on. */}
        <Row settingKey="blockMode" label={t('blocking-settings.mode-de-blocage')} hint={MODE_HINTS[settings.blockMode]} className={anyOn ? '' : 'shields-dim'}>
          <select className="field pop" aria-label={t('blocking-settings.mode-de-blocage')} value={settings.blockMode} disabled={!anyOn} onChange={(e) => update({ blockMode: e.target.value as BlockMode })}>
            {(Object.keys(MODE_NAMES) as BlockMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {MODE_NAMES[mode]}
              </option>
            ))}
          </select>
        </Row>
      </Group>

      <Group title={t('blocking-settings.filtrage-cosmetique')} keys={['blockCosmetic']} footnote={t('blocking-settings.les-bannieres-de-cookies-sont-masquees')}>
        {/* The hiding rides on the ad blocking (see service.ts, `cosmeticCss`): with that off the switch changes nothing, so it says so and stays off the table. */}
        {/* Its name alone is the label of the switch: « En savoir plus » and the text it unfolds never flip it (settings-parts.tsx, `MoreText`). */}
        <div className={`pref-row pref-check pref-check-split ${adsBlockingOn(settings) ? '' : 'shields-dim'}`} data-setting="blockCosmetic">
          <div className="pref-label">
            <label htmlFor={cosmeticId} id={`${cosmeticId}-name`}>
              {cosmeticLabel}
            </label>
            <div className="pref-hint">{t('blocking-settings.cache-aussi-les-emplacements-publicitaires')}</div>
            {!adsBlockingOn(settings) && <div className="pref-hint">{t('blocking-settings.demande-bloquer-les-publicites-et-les-traqueurs')}</div>}
            <MoreText more={t('blocking-settings.cache-ce-que-les-listes-designent')} name={`${cosmeticId}-name`} />
          </div>
          <input id={cosmeticId} type="checkbox" role="switch" aria-label={cosmeticLabel} checked={settings.blockCosmetic} disabled={!adsBlockingOn(settings)} onChange={(e) => update({ blockCosmetic: e.target.checked })} />
        </div>
      </Group>

      {/* The sites where a protection is lifted wait on the subpage « Exceptions par site », the sites with no blocking first. */}
      <Subpage id="exceptions">
      <Group title={t('blocking-settings.sites-sans-blocage')} keys={['blockExceptions']} footnote={t('blocking-settings.sur-ces-sites-rien-n-est-bloque-ni-masque-en-bref')} more={t('blocking-settings.sur-ces-sites-rien-n-est-bloque-ni-masque')}>
        {exceptions.length === 0 && (
          <div className="pref-row pref-message" role="status">
            {t('settings.aucun-site')}
          </div>
        )}
        {exceptions.map((host) => (
          <div key={host} className="pref-row">
            <div className="pref-label">
              <code>{host}</code>
            </div>
            <div className="pref-control">
              <button className="link-button" onClick={() => update({ blockExceptions: exceptions.filter((h) => h !== host) })} aria-label={t('settings.retirer-name', { name: host })}>
                {t('settings.retirer')}
              </button>
            </div>
          </div>
        ))}
        <div className="pref-row pref-form">
          <input
            className="field"
            placeholder={t('settings.exemple-org')}
            aria-label={t('blocking-settings.site-a-ne-jamais-bloquer')}
            {...error.field}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="button" disabled={!verdict || 'error' in verdict} onClick={add}>
            {t('settings.ajouter')}
          </button>
        </div>
        {verdict && 'error' in verdict && (
          <div className="pref-row pref-message pref-error" {...error.message}>
            {verdict.error}
          </div>
        )}
      </Group>

      <Group title={t('blocking-settings.fenetres-autorisees')} keys={['popupExceptions']} footnote={t('blocking-settings.ces-sites-peuvent-ouvrir-une-fenetre')}>
        {settings.popupExceptions.length === 0 && (
          <div className="pref-row pref-message" role="status">
            {t('settings.aucun-site')}
          </div>
        )}
        {settings.popupExceptions.map((host) => (
          <div key={host} className="pref-row">
            <div className="pref-label">
              <code>{host}</code>
            </div>
            <div className="pref-control">
              <button className="link-button" onClick={() => update({ popupExceptions: settings.popupExceptions.filter((h) => h !== host) })} aria-label={t('settings.retirer-name', { name: host })}>
                {t('settings.retirer')}
              </button>
            </div>
          </div>
        ))}
      </Group>
      </Subpage>
    </>
  )
}

/** The filter lists: the ones shipped, each with its state, the ones the user brought (a file, pasted rules), and how often they are refreshed. */
export function FilterListsSettings({ snapshot, update }: Props) {
  const { settings } = snapshot.state
  const status: BlockingStatus | undefined = snapshot.blocking
  const [busy, setBusy] = useState(false)
  const anyOn = adsBlockingOn(settings) || settings.blockCookieBanners
  const choices = updateChoices()
  const refreshing = busy || status?.updating === true
  const toggleList = (id: string, on: boolean) =>
    update({ disabledFilterLists: on ? settings.disabledFilterLists.filter((x) => x !== id) : [...settings.disabledFilterLists, id] })
  const customLists = settings.customFilterLists
  const [pasting, setPasting] = useState(false)
  const [pastedTitle, setPastedTitle] = useState('')
  const [pastedRules, setPastedRules] = useState('')
  const [outcome, setOutcome] = useState<{ text: string; failed: boolean } | null>(null)
  const [adding, setAdding] = useState(false)
  // The custom list « Retirer » was clicked on, while the question is on screen: its rules are deleted with it, and rules that were pasted are
  // kept nowhere else.
  const [removing, setRemoving] = useState<{ id: string; title: string } | null>(null)
  const remove = () => {
    if (!removing) return
    const { id } = removing
    setRemoving(null)
    api()
      .removeFilterList(id)
      .then(() => setOutcome(null))
      .catch((error: unknown) => {
        console.warn('[blocking] the custom list could not be removed:', error)
        setOutcome({ text: t('blocking-settings.la-liste-n-a-pas-pu-etre-retiree'), failed: true })
      })
  }
  const refresh = () => {
    setBusy(true)
    api()
      .updateFilterLists()
      .catch((error: unknown) => {
        console.warn('[blocking] the filter lists could not be updated:', error)
        setOutcome({ text: t('blocking-settings.les-listes-n-ont-pas-pu-etre-mises-a-jour'), failed: true })
      })
      .finally(() => setBusy(false))
  }
  const told = (result: AddFilterListResult) => {
    if (!result.ok) {
      // A cancelled file dialog is not worth a message.
      setOutcome(result.canceled ? null : { text: result.reason, failed: true })
      return false
    }
    // The counts are written the way the language writes numbers (a thin space between thousands in French).
    const locale = getLanguage() === 'en' ? 'en-US' : 'fr-FR'
    const counted = (key: 'blocking-settings.rules-count' | 'blocking-settings.rules-ignored' | 'blocking-settings.rules-invalid', count: number) => tp(key, count, { count: count.toLocaleString(locale) })
    const left = [result.ignored > 0 ? counted('blocking-settings.rules-ignored', result.ignored) : '', result.invalid > 0 ? counted('blocking-settings.rules-invalid', result.invalid) : ''].filter(Boolean)
    setOutcome({ text: t('blocking-settings.title-ajoutee-details', { title: result.list.title, details: [counted('blocking-settings.rules-count', result.rules), ...left].join(', ') }), failed: false })
    return true
  }
  const addFile = () => {
    setAdding(true)
    void api()
      .addFilterListFile()
      .then(told)
      .catch((error: unknown) => setOutcome({ text: error instanceof Error ? error.message : t('blocking-settings.la-liste-n-a-pas-pu-etre-ajoutee'), failed: true }))
      .finally(() => setAdding(false))
  }
  const addPasted = () => {
    setAdding(true)
    void api()
      .addFilterListText(pastedTitle, pastedRules)
      .then((result) => {
        if (told(result)) {
          setPastedRules('')
          setPastedTitle('')
          setPasting(false)
        }
      })
      .catch((error: unknown) => setOutcome({ text: error instanceof Error ? error.message : t('blocking-settings.la-liste-n-a-pas-pu-etre-ajoutee'), failed: true }))
      .finally(() => setAdding(false))
  }

  return (
    <>
    <Group
      title={t('feature.listes-de-filtres')}
      keys={['disabledFilterLists', 'filterUpdateDays', 'customFilterListsEnabled', 'customFilterLists']}
      footnote={t('blocking-settings.les-listes-se-telechargent-sans-rien-envoyer')} more={t('blocking-settings.les-listes-viennent-du-site-de-leurs')}
    >
      {!anyOn && <div className="pref-row pref-message">{t('blocking-settings.activez-un-blocage-ci-dessus-pour-utiliser-les', { settingsPath: settingsPath('blockers') })}</div>}
      {anyOn && status && !status.engineReady && (
        <div className="pref-row pref-message" role="status">
          {t('blocking-settings.en-attendant-les-listes-une-courte-liste')}
        </div>
      )}
      {FILTER_LISTS.map((list) => {
        const categoryOn = list.category === 'ads' ? adsBlockingOn(settings) : settings.blockCookieBanners
        const enabled = !settings.disabledFilterLists.includes(list.id)
        const line = listStatusLine(status?.lists.find((l) => l.id === list.id), categoryOn, enabled)
        return (
          <label key={list.id} className={`pref-row pref-check ${categoryOn ? '' : 'shields-dim'}`}>
            <div className="pref-label">
              {list.title}
              <div className="pref-hint">{list.description}</div>
              <div className="pref-hint shields-status">{line.text}</div>
              {line.error && <div className="pref-hint shields-error shields-status" role="alert">{line.error}</div>}
            </div>
            <input type="checkbox" role="switch" aria-label={list.title} checked={enabled} disabled={!categoryOn} onChange={(e) => toggleList(list.id, e.target.checked)} />
          </label>
        )
      })}
      <Check
        settingKey="customFilterListsEnabled"
        label={t('blocking-settings.listes-personnalisees')}
        hint={t('blocking-settings.vos-propres-listes-au-format-d-easylist-ou-d')} more={t('blocking-settings.ajouter-ses-propres-regles-un-fichier-ou')}
        checked={settings.customFilterListsEnabled}
        onChange={(customFilterListsEnabled) => update({ customFilterListsEnabled })}
      />
      {customLists.map((list) => {
        const state = status?.lists.find((l) => l.id === list.id)
        const line = describeReview(state?.rules ?? null, state?.review)
        return (
          <div key={list.id} className={`pref-row ${adsBlockingOn(settings) && settings.customFilterListsEnabled ? '' : 'shields-dim'}`}>
            <div className="pref-label">
              {list.title}
              <div className="pref-hint">{list.source === 'file' ? t('blocking-settings.fichier-sourcename', { sourceName: list.sourceName }) : list.sourceName} · {t('blocking-settings.liste-personnalisee-appliquee-avec-le')}</div>
              <div className="pref-hint shields-status">{!settings.customFilterListsEnabled ? t('blocking-settings.desactivee-avec-les-listes-personnalisees') : !state?.installed ? t('blocking-settings.regles-introuvables-retirez-cette-liste-et') : line}</div>
              {state?.error && <div className="pref-hint shields-error shields-status" role="alert">{state.error.message}</div>}
              {state?.review && state.review.samples.length > 0 && (
                <details className="pref-hint">
                  <summary>{t('blocking-settings.regles-laissees-de-cote-count', { count: state.review.ignored + state.review.invalid })}</summary>
                  <ul>
                    {state.review.samples.map((sample) => (
                      <li key={`${sample.line}`}>
                        {t('blocking-settings.ligne-line', { line: sample.line })} <code>{sample.text}</code> — {sample.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <div className="pref-control">
              <input type="checkbox" role="switch" aria-label={list.title} checked={list.enabled} onChange={(e) => void api().dispatch({ type: 'filterlist/enable', id: list.id, enabled: e.target.checked })} />
              <button className="link-button" aria-label={t('settings.retirer-name', { name: list.title })} onClick={() => setRemoving({ id: list.id, title: list.title })}>
                {t('settings.retirer')}
              </button>
            </div>
          </div>
        )
      })}
      {!snapshot.private && settings.customFilterListsEnabled && (
        <div className="pref-row pref-form">
          <button className="button" disabled={adding || customLists.length >= CUSTOM_LISTS_MAX} onClick={addFile}>
            {t('blocking-settings.ajouter-un-fichier')}
          </button>
          <button className="button" disabled={adding || customLists.length >= CUSTOM_LISTS_MAX} onClick={() => setPasting((on) => !on)} aria-expanded={pasting}>
            {t('blocking-settings.coller-des-regles')}
          </button>
        </div>
      )}
      {pasting && !snapshot.private && settings.customFilterListsEnabled && (
        <div className="pref-row pref-form">
          <input className="field" placeholder={t('blocking-settings.nom-de-la-liste-facultatif')} aria-label={t('blocking-settings.nom-de-la-liste')} maxLength={80} value={pastedTitle} onChange={(e) => setPastedTitle(e.target.value)} />
          <textarea
            className="field"
            rows={6}
            placeholder={`${t('blocking-settings.exemple-pub-com')}\n${t('blocking-settings.exemple-org-bandeau')}`}
            aria-label={t('blocking-settings.regles-a-ajouter')}
            spellCheck={false}
            maxLength={CUSTOM_PASTE_MAX_CHARS}
            value={pastedRules}
            onChange={(e) => setPastedRules(e.target.value)}
          />
          <button className="button" disabled={adding || pastedRules.trim() === ''} onClick={addPasted}>
            {t('blocking-settings.ajouter-ces-regles')}
          </button>
        </div>
      )}
      {outcome && (
        <div className={`pref-row pref-message ${outcome.failed ? 'pref-error' : ''}`} role={outcome.failed ? 'alert' : 'status'}>
          {outcome.text}
        </div>
      )}
      <div className="pref-row pref-message">
        {/* One element: a row lays its children out side by side, and the sentence would be cut in three columns around the code. */}
        <span>
          {t('blocking-settings.syntaxe-des-filtres-d-easylist-et-d-ublock')}
          <code>##+js(…)</code>
          {t('blocking-settings.ceux-qu-elle-connait-ne-tournent-que-si')}
        </span>
      </div>
      <div className="pref-row" data-setting="filterUpdateDays">
        <div className="pref-label">{t('blocking-settings.rechercher-les-mises-a-jour')}</div>
        <div className="pref-control">
          <select className="field" aria-label={t('blocking-settings.frequence-des-mises-a-jour')} value={settings.filterUpdateDays} onChange={(e) => update({ filterUpdateDays: Number(e.target.value) })}>
            {!choices.some(([days]) => days === settings.filterUpdateDays) && <option value={settings.filterUpdateDays}>{t('blocking-settings.tous-les-filterupdatedays-jours', { filterUpdateDays: settings.filterUpdateDays })}</option>}
            {choices.map(([days, label]) => (
              <option key={days} value={days}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="pref-row">
        <div className="pref-label">{t('blocking-settings.telecharger-les-listes-maintenant')}</div>
        <div className="pref-control">
          <button
            className="button"
            disabled={!anyOn || refreshing}
            onClick={refresh}
          >
            {refreshing ? t('blocking-settings.mise-a-jour') : t('blocking-settings.mettre-a-jour-maintenant')}
          </button>
        </div>
      </div>
    </Group>
      {/* Beside the group, not in it: the group counts its children as rows. */}
      {removing && (
        <ArcDialog
          title={t('blocking-settings.retirer-la-liste-name-question', { name: removing.title })}
          message={t('blocking-settings.retirer-la-liste-message')}
          confirmLabel={t('settings.retirer')}
          onCancel={() => setRemoving(null)}
          onConfirm={remove}
        />
      )}
    </>
  )
}
