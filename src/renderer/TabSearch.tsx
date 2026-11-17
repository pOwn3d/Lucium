import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { cardSurface, pageColorBehind } from '@shared/command-bar'
import { commandHeld, effectiveAccelerator, formatAccelerator } from '@shared/keybindings'
import { commandPress, platformOf } from '@shared/platform'
import { activeTab } from '@shared/sidebar'
import { t, tp } from '@shared/i18n'
import { hostOf } from '@shared/url'
import {
  NO_FILTERS,
  TAB_STATES,
  canArchiveRow,
  choiceActions,
  closeDuplicatesAction,
  hasFilters,
  isArchiveKey,
  reopenActions,
  searchTabs,
  toggleSpaceFilter,
  toggleStateFilter,
  type TabSearchFilters,
  type TabSearchRow,
  type TabStateFilter
} from '@shared/tab-search'
import { api, useSnapshot } from './api'
import { ICONS } from './command-icons'
import './command-bar.css'
import { iconSource } from '@shared/site-icon'
import { ACTION_NOTICE_MS } from '@shared/toast'
import { useActionNotice } from './notice-hold'

const STATE_LABEL: Record<TabStateFilter, () => string> = {
  asleep: () => t('tabsearch.en-veille'),
  audio: () => t('tabsearch.son'),
  pinned: () => t('tabsearch.epingles'),
  split: () => t('tabsearch.scindes'),
  archived: () => t('tabsearch.archives')
}

interface Undo {
  /** What the notice says. */
  message: string
  /** The tabs that went to the archive, which "Annuler" brings back. */
  ids: string[]
}

/**
 * The command bar in "Onglets" mode (⌘⇧A): one field over the open tabs of every space, grouped by space, with filters by space and by state that
 * say how many lines they leave, the archive on request, and the closing of duplicates (what would close is shown first, and "Annuler" takes it back for
 * five seconds). It opens no page: a line goes to a tab (its space comes with it) or brings a page back from the archive. Keys are in `shared/tab-search.ts`.
 */
export function TabSearch() {
  const snapshot = useSnapshot()
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<TabSearchFilters>(NO_FILTERS)
  const [selected, setSelected] = useState(0)
  const [dupOpen, setDupOpen] = useState(false)
  const [undo, setUndo] = useState<Undo | null>(null)
  // The line read out after a key (a tab archived, the duplicates closed): the bar has no toast of its own.
  const [said, setSaid] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus())
  }, [])

  // "Annuler" lasts as long as every notice with an action (and waits while the pointer is on it), then the tabs are gone from here (they stay in the archive).
  const undoNotice = useActionNotice(undo, () => setUndo(null))

  const result = useMemo(() => (snapshot ? searchTabs(snapshot.state, snapshot.runtime, query, filters) : null), [snapshot, query, filters])
  const rows = result?.rows ?? []
  const current = Math.min(selected, Math.max(0, rows.length - 1))
  useEffect(() => {
    list.current?.querySelector(`#ts-option-${current}`)?.scrollIntoView({ block: 'nearest' })
  }, [current, rows.length])
  if (!snapshot || !result) return null
  const { state } = snapshot
  const platform = platformOf(snapshot.platform)
  const act = api()
  const space = (id: string) => state.spaces.find((s) => s.id === id)
  const helpKey = effectiveAccelerator('shortcutHelp', state.settings.keyBindings, platform)
  const plan = result.duplicates
  const duplicates = plan.closeIds.length
  // The same dark glass as the command bar, over the page behind (command-bar.css reads it with the dark values of the tokens).
  const shown = activeTab(state)
  const surface = cardSurface(pageColorBehind(shown ? (snapshot.runtime.tabs[shown.id]?.color ?? null) : undefined))

  const choose = (row: TabSearchRow, choice: 'go' | 'beside') => {
    for (const action of choiceActions(state, row, choice)) void act.dispatch(action)
    act.closeOverlay()
  }

  // ⌫ on an empty field (⌘⌫, Ctrl+⌫ away from macOS, with a text): the tab goes to the archive; "Annuler" brings it back like the duplicates.
  const archive = (row: TabSearchRow) => {
    if (!canArchiveRow(row, state)) return
    void act.dispatch({ type: 'tab/archive', id: row.id })
    setUndo({ message: t('tabsearch.onglet-archive', { title: row.title }), ids: [row.id] })
    setSaid(t('tabsearch.onglet-archive', { title: row.title }))
  }

  const closeDuplicates = () => {
    const action = closeDuplicatesAction(plan)
    if (!action) return
    void act.dispatch(action)
    setUndo({ message: tp('tabsearch.doublons-fermes', duplicates), ids: plan.closeIds })
    setDupOpen(false)
    setSaid('')
  }

  const takeBack = () => {
    if (!undo) return
    for (const action of reopenActions(undo.ids, state.archive)) void act.dispatch(action)
    setSaid(tp('tabsearch.onglets-rouverts', undo.ids.length))
    setUndo(null)
  }

  const clearAll = () => {
    setQuery('')
    setFilters(NO_FILTERS)
    setDupOpen(false)
    setSelected(0)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const row = rows[current]
    if (e.key === 'Escape') {
      // Escape lets go of the duplicates' preview, then of the text and the filters, and only then closes the bar.
      if (dupOpen) setDupOpen(false)
      else if (query || hasFilters(filters)) clearAll()
      else act.closeOverlay()
    } else if (e.key === 'ArrowDown') setSelected(Math.min(current + 1, rows.length - 1))
    else if (e.key === 'ArrowUp') setSelected(Math.max(current - 1, 0))
    else if (e.key === 'Enter') {
      if (row) choose(row, commandHeld(e, platform) ? 'beside' : 'go')
    } else if (isArchiveKey(e.nativeEvent, query, platform)) {
      if (row) archive(row)
    } else return
    e.preventDefault()
  }

  const spaceChips = state.spaces.map((s) => ({ id: s.id, label: `${s.emoji} ${s.name}`.trim(), count: result.spaceCounts[s.id] ?? 0 }))
  let index = 0
  return (
    <div className="palette cb-tabs cb-wide" role="dialog" aria-label={t('tabsearch.rechercher-un-onglet')} style={{ '--cb-fill': surface.fill, '--cb-edge': surface.edge, '--cb-ring': surface.ring } as React.CSSProperties}>
      <div className="cb-strip">
        <span className="ts-mode">
          {ICONS.tab}
          {t('tabsearch.onglets')}
        </span>
        {/* The counts are read out when they change (a tab archived, the duplicates closed). */}
        <span className="ts-count" aria-live="polite">
          {tp('tabsearch.ouverts', result.open)} · {tp('tabsearch.archives-compte', result.archived)}
          {said ? ` · ${said}` : ''}
        </span>
        <span className="cb-strip-spacer" />
        <button type="button" className="cb-strip-close" aria-label={t('tabsearch.fermer-echap')} title={t('tabsearch.fermer-echap')} onMouseDown={(e) => e.preventDefault()} onClick={() => act.closeOverlay()}>
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.600" strokeLinecap="round" aria-hidden="true">
            <path d="m2 2 8 8m0-8-8 8" />
          </svg>
        </button>
      </div>
      <div className="palette-head">
        <span className="palette-search">{ICONS.suggestion}</span>
        <input
          ref={input}
          className="palette-input"
          value={query}
          placeholder={t('tabsearch.rechercher-un-onglet-2')}
          role="combobox"
          aria-label={t('tabsearch.rechercher-un-onglet')}
          aria-autocomplete="list"
          aria-expanded={rows.length > 0}
          aria-controls="ts-results"
          aria-activedescendant={rows[current] ? `ts-option-${current}` : undefined}
          spellCheck={false}
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
            setSaid('')
          }}
          onKeyDown={onKeyDown}
        />
        {state.settings.shortcutHelp && (
          <button type="button" className="palette-info" aria-label={t('cmd.aide-de-la-barre-de-commandes')} title={t('cmd.aide-de-la-barre-de-commandes')} onMouseDown={(e) => e.preventDefault()} onClick={() => act.openOverlay({ panel: 'shortcuts' })}>
            {t('cmd.raccourcis')}
            {helpKey && <kbd aria-hidden="true">{formatAccelerator(helpKey, platform)}</kbd>}
          </button>
        )}
      </div>
      <div className="ts-filters">
        <div className="ts-group" role="group" aria-label={t('tabsearch.espace')}>
          <span className="ts-lab">{t('tabsearch.espace')}</span>
          <button type="button" aria-pressed={filters.space === null} onMouseDown={(e) => e.preventDefault()} onClick={() => { setFilters(toggleSpaceFilter(filters, null)); setSelected(0) }}>
            {t('tabsearch.tous')}
          </button>
          {spaceChips.map((chip) => (
            <button key={chip.id} type="button" aria-pressed={filters.space === chip.id} onMouseDown={(e) => e.preventDefault()} onClick={() => { setFilters(toggleSpaceFilter(filters, chip.id)); setSelected(0) }}>
              {chip.label} <span className="ts-n">{chip.count}</span>
            </button>
          ))}
        </div>
        <div className="ts-group" role="group" aria-label={t('tabsearch.etat')}>
          <span className="ts-lab">{t('tabsearch.etat')}</span>
          {TAB_STATES.map((wanted) => (
            <button key={wanted} type="button" aria-pressed={filters.states.includes(wanted)} onMouseDown={(e) => e.preventDefault()} onClick={() => { setFilters(toggleStateFilter(filters, wanted)); setSelected(0) }}>
              {STATE_LABEL[wanted]()} <span className="ts-n">{result.stateCounts[wanted]}</span>
            </button>
          ))}
        </div>
        <button type="button" className="ts-dup" aria-expanded={dupOpen} disabled={duplicates === 0} onMouseDown={(e) => e.preventDefault()} onClick={() => setDupOpen(!dupOpen)}>
          {t('tabsearch.fermer-les-doublons', { count: duplicates })}
        </button>
      </div>
      <div className="cb-body">
        <ul className="results" ref={list} id="ts-results" role="listbox" aria-label={t('tabsearch.onglets')}>
          {dupOpen && duplicates > 0 && (
            <li className="ts-dupbox" role="presentation">
              <section aria-labelledby="ts-dup-title">
                <h3 id="ts-dup-title">{tp('tabsearch.onglets-seront-fermes', duplicates)}</h3>
                <p>{t('tabsearch.regle-des-doublons')}</p>
                <ul>
                  {plan.groups.flatMap((group) => {
                    const kept = state.tabs.find((x) => x.id === group.keep)
                    return group.close.map((id) => {
                      const tab = state.tabs.find((x) => x.id === id)
                      if (!tab) return null
                      const where = space(tab.spaceId)
                      return (
                        <li key={id}>
                          <span className="ts-d-title">{tab.customTitle?.trim() || tab.title || hostOf(tab.url)}</span>
                          <span className="ts-d-where">{where ? `${where.emoji} ${where.name}`.trim() : ''}</span>
                          <span className="ts-d-keep">{`${keepReason(group.reason)} ${space(kept?.spaceId ?? '')?.emoji ?? ''}`.trim()}</span>
                        </li>
                      )
                    })
                  })}
                </ul>
                <div className="ts-d-actions">
                  <button type="button" className="ts-primary" onMouseDown={(e) => e.preventDefault()} onClick={closeDuplicates}>
                    {tp('tabsearch.fermer-n-onglets', duplicates)}
                  </button>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setDupOpen(false)}>
                    {t('tabsearch.tout-garder')}
                  </button>
                </div>
              </section>
            </li>
          )}
          {result.groups.map((group) => {
            const where = group.kind === 'space' ? space(group.id) : undefined
            const title = group.kind === 'archive' ? t('tabsearch.archives') : where ? `${where.emoji} ${where.name}`.trim() : group.id
            const count = group.kind === 'archive' && group.total > group.rows.length ? t('tabsearch.recents-sur', { shown: group.rows.length, total: group.total }) : String(group.total)
            return (
              <Fragment key={group.id}>
                <li className="group-title" role="presentation" aria-hidden="true">
                  {title}
                  <span className="ts-n">· {count}</span>
                </li>
                {group.rows.map((row) => {
                  const i = index++
                  const owner = space(row.spaceId)
                  return (
                    <li
                      key={`${row.kind}:${row.id}`}
                      id={`ts-option-${i}`}
                      role="option"
                      aria-selected={i === current}
                      className={`${i === current ? 'selected' : ''}${row.asleep ? ' asleep' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        choose(row, 'go')
                      }}
                    >
                      <span className="kind">{iconSource(row.faviconUrl) ? <img className="result-favicon" src={iconSource(row.faviconUrl)} alt="" draggable={false} /> : row.kind === 'archived' ? ICONS.archived : ICONS.tab}</span>
                      <span className="label">{row.title}</span>
                      <span className="detail">— {hostOf(row.url) || row.url}</span>
                      <span className="ts-states">
                        {row.asleep && <span className="ts-st">{t('tabsearch.en-veille')}</span>}
                        {row.audible && <span className="ts-st">{row.muted ? t('tabsearch.son-coupe') : t('tabsearch.son')}</span>}
                        {row.pinned && row.kind === 'tab' && <span className="ts-st">{t('tabsearch.epingle')}</span>}
                        {row.split && <span className="ts-st">{t('tabsearch.scinde')}</span>}
                        {row.duplicate && <span className="ts-st dup">{t('tabsearch.doublon')}</span>}
                      </span>
                      {/* Under a space's title the space is known; in the archive and with one space chosen it is the title or the filter that says it. */}
                      {group.kind === 'archive' && owner && state.spaces.length > 1 && <span className="where" title={owner.name}>{owner.emoji}</span>}
                      <span className="chip">{row.kind === 'archived' ? t('tabsearch.rouvrir') : row.current ? t('tabsearch.onglet-courant') : t('cmd.aller-a-l-onglet')}</span>
                      {i === current && (
                        <span className="keycap" aria-hidden="true">
                          ↵
                        </span>
                      )}
                    </li>
                  )
                })}
              </Fragment>
            )
          })}
          {rows.length === 0 && (
            <li className="ts-empty" role="presentation">
              <b>{t('tabsearch.aucun-onglet-ne-correspond')}</b>
              <span>
                {query.trim() ? t('tabsearch.rien-pour', { query: query.trim() }) : t('tabsearch.aucun-onglet-dans-cette-selection')}
                {hasFilters(filters) ? ` ${t('tabsearch.avec-ces-filtres')}` : ''}
              </span>
              {(hasFilters(filters) || query) && (
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={clearAll}>
                  {t('tabsearch.effacer-les-filtres')}
                </button>
              )}
            </li>
          )}
        </ul>
      </div>
      {undo && (
        <div className="ts-undo" role="status" aria-live="polite" key={undo.message + undo.ids.join()} style={{ '--notice-ms': `${ACTION_NOTICE_MS}ms` } as CSSProperties} {...undoNotice.props}>
          <b>{undo.message}</b>
          <span className="ts-undo-spacer" />
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={takeBack}>
            {t('tabsearch.annuler')}
          </button>
        </div>
      )}
      <div className="cb-foot">
        <span><kbd>↑↓</kbd> {t('cmd.pied-parcourir')}</span>
        <span><kbd>↵</kbd> {t('tabsearch.pied-aller-a-l-onglet')}</span>
        <span><kbd>{commandPress('↵', platform)}</kbd> {t('tabsearch.pied-ouvrir-a-cote')}</span>
        <span><kbd>⌫</kbd> {t('tabsearch.pied-archiver')}</span>
        <span className="cb-foot-spacer" />
        <span><kbd>{t('cmd.echap')}</kbd> {t('cmd.pied-fermer')}</span>
      </div>
    </div>
  )
}

function keepReason(reason: 'favorite' | 'pinned' | 'split' | 'current' | 'oldest'): string {
  switch (reason) {
    case 'favorite':
      return t('tabsearch.garde-le-favori')
    case 'pinned':
      return t('tabsearch.garde-l-epingle')
    case 'split':
      return t('tabsearch.garde-la-vue-scindee')
    case 'current':
      return t('tabsearch.garde-l-onglet-courant')
    case 'oldest':
      return t('tabsearch.garde-le-plus-ancien')
  }
}
