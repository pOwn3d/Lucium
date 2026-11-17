// The sheet of a work view (shared/ipc.ts, panel `workview`). « Enregistrer comme vue de travail… » of a split view asks only for a name and an icon:
// the sites, their order, the layout and the proportions are the ones on screen, and « Plus de réglages… » opens the whole sheet. « Modifier… » of a tile
// and « Nouvelle vue de travail… » of the + open the whole sheet: the sites in the order of the panes, the layout, the proportions, where it opens.
// Nothing is kept before « Enregistrer »: Escape and « Annuler » leave everything as it was. The state checks again what the sheet sends.

import { useState } from 'react'
import type { GridSpan, SidebarState, SplitArrangement, SplitGrid, SplitOrientation, WorkView, WorkViewTarget } from '@shared/model'
import type { PlusAnchor } from '@shared/plus-menu'
import type { WorkViewPatch } from '@shared/sidebar-actions'
import { SPLIT_MIN_RATIO } from '@shared/split'
import { arrangementChoices } from '@shared/split-grid'
import { WORK_VIEW_EMOJI, WORK_VIEW_NAME_MAX, WORK_VIEW_PANES_MAX, WORK_VIEW_PANES_MIN, gridShareOfPercent, sharesOfPercents, typedWorkViewUrl, workViewOfSplit, workViewSummary } from '@shared/work-views'
import { t, tp } from '@shared/i18n'
import { api, useSnapshot } from './api'
import { radioGroupKeys } from './radio-keys'
import { Sheet, SheetField, useSpaceHue } from './templates'
import './work-views.css'

/** The icons offered for a view: one line of a day's work each, eight to a row. */
export const WORK_VIEW_EMOJIS = ['💼', '☀️', '🌙', '📧', '📅', '💬', '📝', '📚', '🛠️', '🪚', '🎧', '🧪', '🎨', '🛒', '💰', '🚀']

/** Two panes side by side: the glyph of the sheet. */
function WorkViewGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.500" y="4" width="8" height="12" rx="2" />
      <rect x="12.500" y="4" width="5" height="12" rx="2" />
    </svg>
  )
}

/** The icon of a view: one emoji of a short list, as a group of radios (the arrows move and choose). */
export function WorkViewIcon({ value, onChange }: { value: string; onChange: (emoji: string) => void }) {
  const choices = WORK_VIEW_EMOJIS.includes(value) ? WORK_VIEW_EMOJIS : [value, ...WORK_VIEW_EMOJIS.slice(0, -1)]
  return (
    <div className="sh-field" role="radiogroup" aria-label={t('work-view.icone')} onKeyDown={radioGroupKeys}>
      <span>{t('work-view.icone')}</span>
      <div className="emoji-grid">
        {choices.map((emoji) => (
          <button key={emoji} type="button" role="radio" aria-checked={emoji === value} tabIndex={emoji === value ? 0 : -1} className={`emoji ${emoji === value ? 'current' : ''}`} onClick={() => onChange(emoji)}>
            {emoji}
          </button>
        ))}
      </div>
    </div>
  )
}

type Place = 'shown' | 'space' | 'new-space' | 'window'

/** What the whole sheet holds while it is open: the sites as typed, the layout in percents, the place. */
interface Draft {
  sites: Array<{ text: string; title?: string; faviconUrl?: string; url?: string }>
  orientation: SplitOrientation
  /** One per site, for a row or a column. */
  percents: number[]
  /** Set in a grid: the left column and the top row, in percents. */
  grid: { column: number; row: number; span?: GridSpan } | null
  place: Place
  spaceId: string
}

const percentOf = (share: number): number => Math.round(share * 100)
const equalPercents = (count: number): number[] => Array.from({ length: count }, () => Math.round(100 / count))

/** The draft of a view (or of what a split view would become), opened from `shown`. */
function draftOf(kept: Pick<WorkView, 'panes' | 'orientation' | 'ratios' | 'grid'> & { target?: WorkViewTarget | undefined }, shown: string): Draft {
  const target = kept.target
  return {
    sites: kept.panes.map((pane) => ({ text: pane.url, url: pane.url, title: pane.title, ...(pane.faviconUrl ? { faviconUrl: pane.faviconUrl } : {}) })),
    orientation: kept.orientation,
    percents: kept.ratios.map(percentOf),
    grid: kept.grid ? { column: percentOf(kept.grid.column), row: percentOf(kept.grid.row), ...(kept.grid.span ? { span: kept.grid.span } : {}) } : null,
    place: target?.kind ?? 'shown',
    spaceId: target?.kind === 'space' ? target.spaceId : shown
  }
}

/** A draft with `sites` in place of its own: a change of their number shares the stage equally again, and a grid needs three or four. */
function withSites(draft: Draft, sites: Draft['sites']): Draft {
  if (sites.length === draft.sites.length) return { ...draft, sites }
  const span: GridSpan = draft.grid?.span ?? 'bottom'
  const grid: Draft['grid'] = draft.grid && (sites.length === 3 || sites.length === 4) ? { column: draft.grid.column, row: draft.grid.row, ...(sites.length === 3 ? { span } : {}) } : null
  return { ...draft, sites, percents: equalPercents(sites.length), grid }
}

/** What the draft makes, or the first thing that is wrong with it, in words. */
function readDraft(draft: Draft, state: SidebarState): { ok: true; patch: Required<Pick<WorkViewPatch, 'panes' | 'orientation' | 'ratios' | 'grid' | 'target'>> } | { ok: false; error: string } {
  const urls = draft.sites.map((site) => typedWorkViewUrl(site.text))
  const wrong = urls.findIndex((url) => url === null)
  if (wrong >= 0) return { ok: false, error: t('work-view.site-refuse', { n: wrong + 1 }) }
  const panes = draft.sites.map((site, at) => ({ url: urls[at]!, ...(site.url === urls[at] && site.title ? { title: site.title } : {}), ...(site.url === urls[at] && site.faviconUrl ? { faviconUrl: site.faviconUrl } : {}) }))
  const count = panes.length
  let ratios = sharesOfPercents(draft.grid ? equalPercents(count) : draft.percents)
  let grid: SplitGrid | null = null
  if (draft.grid) {
    const column = gridShareOfPercent(draft.grid.column)
    const row = gridShareOfPercent(draft.grid.row)
    if (column === null || row === null) return { ok: false, error: t('work-view.proportions-refusees', { min: percentOf(SPLIT_MIN_RATIO) }) }
    grid = { column, row, ...(draft.grid.span ? { span: draft.grid.span } : {}) }
  }
  if (!ratios) return { ok: false, error: t('work-view.proportions-refusees', { min: percentOf(SPLIT_MIN_RATIO) }) }
  const space = state.spaces.find((each) => each.id === draft.spaceId)
  const target: WorkViewTarget | null = draft.place === 'space' && space ? { kind: 'space', spaceId: space.id } : draft.place === 'new-space' ? { kind: 'new-space' } : draft.place === 'window' ? { kind: 'window' } : null
  ratios = ratios.length === count ? ratios : sharesOfPercents(equalPercents(count))!
  return { ok: true, patch: { panes, orientation: draft.orientation, ratios, grid, target } }
}

export function WorkViewSheet({ splitId, viewId, full, anchor }: { splitId?: string; viewId?: string; full?: true; anchor?: PlusAnchor }) {
  const snapshot = useSnapshot()
  const hue = useSpaceHue()
  const act = api()
  const state = snapshot?.state
  const view = viewId !== undefined ? state?.workViews.find((each) => each.id === viewId) : undefined
  const split = splitId !== undefined ? state?.splits.find((each) => each.id === splitId) : undefined
  // What the view will keep of the split view on screen (its sites and layout), or what the view keeps already; nothing for a view made from nothing.
  const kept = state && split ? workViewOfSplit(state, split) : view
  const creating = viewId === undefined && splitId === undefined
  const [name, setName] = useState<string | null>(null)
  const [emoji, setEmoji] = useState<string | null>(null)
  const [whole, setWhole] = useState(full === true || creating)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState('')
  if (!state || (!kept && !creating)) return null

  const shown = state.activeSpaceId
  const profileId = view?.profileId ?? state.spaces.find((space) => space.id === (split?.spaceId ?? shown))?.profileId ?? 'default'
  const current: Draft = draft ?? (kept ? draftOf(kept, shown) : { sites: [{ text: '' }, { text: '' }], orientation: 'horizontal', percents: [50, 50], grid: null, place: 'shown', spaceId: shown })
  const change = (next: Draft) => {
    setError('')
    setDraft(next)
  }
  const shownEmoji = emoji ?? view?.emoji ?? WORK_VIEW_EMOJI

  const save = () => {
    const named = { ...(name !== null ? { name } : {}), emoji: shownEmoji }
    if (!whole) {
      if (split) void act.dispatch({ type: 'view/save', splitId: split.id, name: name ?? '', emoji: shownEmoji })
      // A blank name is the state's to refuse: the tile keeps the name it has.
      else if (view) void act.dispatch({ type: 'view/edit', id: view.id, patch: named })
      return act.closeOverlay()
    }
    const read = readDraft(current, state)
    if (!read.ok) return setError(read.error)
    if (split) void act.dispatch({ type: 'view/save', splitId: split.id, name: name ?? '', emoji: shownEmoji, patch: read.patch })
    else if (view) void act.dispatch({ type: 'view/edit', id: view.id, patch: { ...named, ...read.patch } })
    else void act.dispatch({ type: 'view/create', spaceId: shown, view: { name: name ?? '', emoji: shownEmoji, ...read.patch, grid: read.patch.grid ?? undefined, target: read.patch.target ?? undefined } })
    act.closeOverlay()
  }

  const count = current.sites.length
  const arrangement: SplitArrangement = current.grid && (count === 3 || count === 4) ? 'grid' : current.orientation
  const choices = arrangementChoices({ tabIds: current.sites.map((_, at) => String(at)), orientation: current.orientation, ...(current.grid ? { grid: { column: 0.5, row: 0.5 } } : {}) })
  const arrange = (to: SplitArrangement) =>
    change(
      to === 'grid'
        ? { ...current, grid: { column: 50, row: 50, ...(count === 3 ? { span: current.orientation === 'vertical' ? 'left' : 'bottom' } : {}) } }
        : { ...current, orientation: to, grid: null }
    )
  const move = (at: number, by: -1 | 1) => {
    const sites = [...current.sites]
    const percents = [...current.percents]
    ;[sites[at], sites[at + by]] = [sites[at + by]!, sites[at]!]
    ;[percents[at], percents[at + by]] = [percents[at + by]!, percents[at]!]
    change({ ...current, sites, percents })
  }
  const spacesOfProfile = state.spaces.filter((space) => space.profileId === profileId)

  return (
    <Sheet
      className="work-view-sheet"
      title={view ? t('work-view.modifier-la-vue-de-travail') : t('work-view.nouvelle-vue-de-travail')}
      context={view?.name}
      glyph={<WorkViewGlyph />}
      hue={hue}
      anchor={whole ? undefined : anchor}
      side="right"
      onCancel={() => act.closeOverlay()}
      primary={{ label: t('templates.enregistrer') }}
      onSubmit={save}
      footStart={
        whole && view ? (
          <button
            type="button"
            className="tk-btn quiet danger"
            onClick={() => {
              // The notice that follows offers « Annuler ».
              void act.dispatch({ type: 'view/remove', id: view.id })
              act.closeOverlay()
            }}
          >
            {t('work-view.retirer-la-vue-de-travail')}
          </button>
        ) : !whole ? (
          <button type="button" className="tk-btn quiet" onClick={() => setWhole(true)}>
            {t('work-view.plus-de-reglages')}
          </button>
        ) : undefined
      }
    >
      <SheetField label={t('templates.nom')} help={view || whole ? undefined : t('work-view.aide-nom')}>
        {(field) => <input className="tk-field" {...field} value={name ?? view?.name ?? ''} placeholder={t('work-view.vue-de-travail')} maxLength={WORK_VIEW_NAME_MAX} data-autofocus onChange={(e) => setName(e.target.value)} />}
      </SheetField>
      <WorkViewIcon value={shownEmoji} onChange={setEmoji} />
      {!whole && kept && (
        <>
          <p className="wv-summary">{workViewSummary(kept)}</p>
          <p className="wv-note">{t('work-view.sites-repris', { sites: kept.panes.map((pane) => pane.title).join(', ') })}</p>
        </>
      )}
      {whole && (
        <>
          <div className="sh-field" role="group" aria-label={tp('work-view.sites-dans-l-ordre', count, { max: WORK_VIEW_PANES_MAX })}>
            <span>{tp('work-view.sites-dans-l-ordre', count, { max: WORK_VIEW_PANES_MAX })}</span>
            <ol className="wv-sites">
              {current.sites.map((site, at) => (
                <li key={at} className="wv-site">
                  <span className="wv-site-number" aria-hidden="true">
                    {at + 1}
                  </span>
                  <input
                    className="tk-field"
                    type="text"
                    spellCheck={false}
                    aria-label={t('work-view.site-n', { n: at + 1 })}
                    aria-invalid={error !== '' && typedWorkViewUrl(site.text) === null ? true : undefined}
                    value={site.text}
                    onChange={(e) => change(withSites(current, current.sites.map((each, i) => (i === at ? { ...each, text: e.target.value } : each))))}
                  />
                  <button type="button" className="tk-btn quiet" aria-label={t('work-view.monter-le-site', { n: at + 1 })} disabled={at === 0} onClick={() => move(at, -1)}>
                    ↑
                  </button>
                  <button type="button" className="tk-btn quiet" aria-label={t('work-view.descendre-le-site', { n: at + 1 })} disabled={at === count - 1} onClick={() => move(at, 1)}>
                    ↓
                  </button>
                  <button type="button" className="tk-btn quiet" aria-label={t('work-view.retirer-le-site', { n: at + 1 })} disabled={count <= WORK_VIEW_PANES_MIN} onClick={() => change(withSites(current, current.sites.filter((_, i) => i !== at)))}>
                    ✕
                  </button>
                </li>
              ))}
            </ol>
            <div className="wv-row">
              <button type="button" className="tk-btn quiet" disabled={count >= WORK_VIEW_PANES_MAX} onClick={() => change(withSites(current, [...current.sites, { text: '' }]))}>
                {t('work-view.ajouter-un-site')}
              </button>
            </div>
            <p className="wv-note">{t('work-view.aide-sites')}</p>
          </div>
          <div className="sh-field" role="radiogroup" aria-label={t('ctx.disposition')}>
            <span>{t('ctx.disposition')}</span>
            <div className="wv-row">
              {choices.map((choice) => (
                <label key={choice.arrangement} className="wv-choice">
                  <input type="radio" name="wv-arrangement" checked={arrangement === choice.arrangement} disabled={!choice.enabled} onChange={() => arrange(choice.arrangement)} />
                  {choice.label}
                </label>
              ))}
            </div>
          </div>
          <div className="sh-field" role="group" aria-label={t('work-view.proportions')}>
            <span>{t('work-view.proportions')}</span>
            <div className="wv-row">
              {current.grid ? (
                <>
                  <label className="wv-share-label">
                    {t('work-view.colonne-de-gauche')}
                    <input className="tk-field wv-share" type="number" min={12} max={88} value={current.grid.column} onChange={(e) => change({ ...current, grid: { ...current.grid!, column: Number(e.target.value) } })} />
                  </label>
                  <label className="wv-share-label">
                    {t('work-view.rangee-du-haut')}
                    <input className="tk-field wv-share" type="number" min={12} max={88} value={current.grid.row} onChange={(e) => change({ ...current, grid: { ...current.grid!, row: Number(e.target.value) } })} />
                  </label>
                </>
              ) : (
                current.percents.map((percent, at) => (
                  <label key={at} className="wv-share-label">
                    {t('work-view.part-du-site', { n: at + 1 })}
                    <input className="tk-field wv-share" type="number" min={12} max={88} value={percent} onChange={(e) => change({ ...current, percents: current.percents.map((each, i) => (i === at ? Number(e.target.value) : each)) })} />
                  </label>
                ))
              )}
              <button type="button" className="tk-btn quiet" onClick={() => change(current.grid ? { ...current, grid: { ...current.grid, column: 50, row: 50 } } : { ...current, percents: equalPercents(count) })}>
                {t('work-view.parts-egales')}
              </button>
            </div>
          </div>
          <div className="sh-field" role="radiogroup" aria-label={t('work-view.ou-l-ouvrir')}>
            <span>{t('work-view.ou-l-ouvrir')}</span>
            {(['shown', 'space', 'new-space', 'window'] as const).map((place) => (
              <label key={place} className="wv-choice">
                <input type="radio" name="wv-place" checked={current.place === place} disabled={place === 'space' && spacesOfProfile.length === 0} onChange={() => change({ ...current, place })} />
                {t(PLACE_LABELS[place])}
                {place === 'space' && (
                  <select className="tk-field" aria-label={t('work-view.toujours-dans-l-espace')} value={current.spaceId} disabled={current.place !== 'space'} onChange={(e) => change({ ...current, spaceId: e.target.value })}>
                    {spacesOfProfile.map((space) => (
                      <option key={space.id} value={space.id}>{`${space.emoji} ${space.name}`}</option>
                    ))}
                  </select>
                )}
              </label>
            ))}
            <p className="wv-note">{t('work-view.aide-ou-l-ouvrir')}</p>
          </div>
        </>
      )}
      {error && (
        <p className="sh-error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  )
}

const PLACE_LABELS = {
  shown: 'work-view.dans-l-espace-affiche',
  space: 'work-view.toujours-dans-l-espace',
  'new-space': 'work-view.dans-un-nouvel-espace',
  window: 'work-view.dans-une-nouvelle-fenetre'
} as const satisfies Record<Place, string>
