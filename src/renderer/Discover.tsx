import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  DISCOVER_LEVELS,
  DISCOVER_TASKS,
  TASK_LABELS,
  discoverKeys,
  discoverName,
  discoverOff,
  discoverSettingsRequest,
  discoverSummary,
  discoverWhere,
  filterDiscover,
  otherFeatures,
  taskCounts,
  type DiscoverCall,
  type DiscoverEntry,
  type DiscoverFilter,
  type OtherFeature
} from '@shared/discover'
import { t, tp } from '@shared/i18n'
import type { OverlayRequest } from '@shared/ipc'
import { isLeaveKey } from '@shared/panel-keys'
import { platformOf } from '@shared/platform'
import { api, useSnapshot } from './api'
import { SearchGlyph, activeSpaceHue, hueProps, useFocusScope } from './templates'
import './discover.css'

/** What each call a card may make does, through the API the interface already has (a missing one does not compile). */
const CALLS: Record<DiscoverCall, (act: ReturnType<typeof api>) => void> = {
  captureFullPage: (act) => act.captureFullPage(),
  saveMarkdown: (act) => act.markdownExport('save'),
  newPrivateTab: (act) => act.newPrivateTab()
}

const LEVEL_LABELS = { beginner: 'discover.niveau-debut', advanced: 'discover.niveau-avance' } as const

/**
 * « Découvrir Lucium »: what Lucium can do by what a person wants to do (shared/discover.ts holds the catalogue and the search). A search, chips for the
 * task and for the level, then cards: name, one line, where to find the function, its shortcut as it is set now, « Essayer » (the real action) and « Régler »
 * (the real setting). The functions that have no card follow in a list, with their setting. Escape empties the search, then closes the panel.
 * Nothing moves by itself, so there is no motion to reduce; nothing is counted or sent.
 */
export function Discover() {
  const act = api()
  const snapshot = useSnapshot()
  const [filter, setFilter] = useState<DiscoverFilter>({ query: '', task: 'all', level: 'all' })
  const root = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useFocusScope(root, { trap: true })
  const settings = snapshot?.state.settings
  const platform = platformOf(snapshot?.platform)

  const cards = useMemo(() => filterDiscover(filter), [filter])
  const others = useMemo(() => otherFeatures(filter), [filter])
  // The chips count what the words and the level would show, whatever task is chosen.
  const counts = useMemo(() => taskCounts(filterDiscover({ ...filter, task: 'all' })), [filter])
  if (!snapshot || !settings) return null
  const { className: hueClass, style } = hueProps(activeSpaceHue(snapshot.state.spaces, snapshot.state.activeSpaceId))

  const shown = cards.length + others.length
  const leave = (): void => act.closeOverlay()
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!isLeaveKey(e.nativeEvent)) return
    e.stopPropagation()
    if (filter.query) setFilter({ ...filter, query: '' })
    else leave()
  }
  /** Leaves the panel for the place: a panel replaces it, the Settings window opens beside the window. */
  const go = (request: OverlayRequest): void => {
    act.closeOverlay()
    act.openOverlay(request)
  }

  const card = (entry: DiscoverEntry) => {
    const id = `${titleId}-${entry.id}`
    const name = discoverName(entry)
    const shortcut = discoverKeys(entry, settings.keyBindings, platform)
    const off = discoverOff(entry, settings)
    const kind = entry.try.kind
    const adjust = discoverSettingsRequest(entry)
    return (
      <li key={entry.id}>
        <article className="dv-card" aria-labelledby={id}>
          <div className="dv-badges">
            <span className="dv-badge level">{t(LEVEL_LABELS[entry.level])}</span>
            {entry.isNew && (
              <span className="dv-badge">
                <span aria-hidden="true">★ </span>
                {t('discover.nouveau')}
              </span>
            )}
            {off && <span className="dv-badge off">{t('discover.coupee')}</span>}
          </div>
          <h4 id={id}>{name}</h4>
          <p className="dv-summary">{discoverSummary(entry)}</p>
          <p className="dv-where">
            <b>{t('discover.ou-label')}</b> {discoverWhere(entry)}
          </p>
          {off && <p className="dv-note">{t('discover.coupee-aide')}</p>}
          {kind === 'hint' && !off && <p className="dv-note">{t('discover.consigne')}</p>}
          <div className="dv-foot">
            {shortcut ? (
              <span className="dv-keys" role="group" aria-label={t('discover.raccourci-label', { keys: shortcut.keys.join(' ') })}>
                {shortcut.keys.map((key, i) => (
                  <kbd key={`${key}${i}`} className="tk-kbd" aria-hidden="true">
                    {key}
                  </kbd>
                ))}
              </span>
            ) : (
              <span className="dv-nokey">{t('discover.sans-raccourci')}</span>
            )}
            <span className="dv-actions">
              {!off && (kind === 'open' || kind === 'call') && (
                <button
                  type="button"
                  className="tk-btn primary"
                  aria-describedby={id}
                  onClick={() => (entry.try.kind === 'open' ? go(entry.try.request) : entry.try.kind === 'call' ? CALLS[entry.try.call](act) : undefined)}
                >
                  {t('discover.essayer')}
                </button>
              )}
              <button type="button" className={`tk-btn${kind === 'setting' || off ? ' primary' : ''}`} aria-describedby={id} onClick={() => go(adjust)}>
                {t('discover.regler')}
              </button>
            </span>
          </div>
        </article>
      </li>
    )
  }

  const other = (row: OtherFeature) => {
    const id = `${titleId}-o-${row.feature.id}`
    return (
      <li key={row.feature.id} className="dv-other">
        <div>
          <b id={id}>{row.name}</b>
          <span>{row.line}</span>
        </div>
        <button type="button" className="tk-btn" aria-describedby={id} onClick={() => go(row.request)}>
          {t('discover.regler')}
        </button>
      </li>
    )
  }

  const chip = (pressed: boolean, label: string, onClick: () => void, count?: number) => (
    <button key={label} type="button" className="tk-chip" aria-pressed={pressed} onClick={onClick}>
      {label}
      {count !== undefined && <span className="dv-n" aria-hidden="true">{count}</span>}
    </button>
  )

  return (
    <div ref={root} className={`dv tk-panel ${hueClass}`.trim()} style={style} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <header className="dv-head">
        <div className="dv-title">
          <h2 id={titleId}>{t('discover.titre')}</h2>
          <button type="button" className="tk-btn quiet icon" aria-label={t('shortcut-help.fermer-echap')} title={t('shortcut-help.fermer-echap')} onClick={leave}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <p className="dv-lead">{t('discover.intro')}</p>
        <div className="tk-search" role="search">
          <SearchGlyph />
          <input
            className="tk-field"
            type="search"
            data-autofocus
            value={filter.query}
            placeholder={t('discover.chercher-placeholder')}
            aria-label={t('discover.chercher-label')}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setFilter({ ...filter, query: e.target.value })}
          />
        </div>
        <div className="dv-filters">
          <div className="dv-chips" role="group" aria-label={t('discover.taches-label')}>
            {chip(filter.task === 'all', t('discover.tache-tout'), () => setFilter({ ...filter, task: 'all' }), counts.all)}
            {DISCOVER_TASKS.map((task) => chip(filter.task === task, t(TASK_LABELS[task]), () => setFilter({ ...filter, task }), counts[task]))}
          </div>
          <div className="dv-chips" role="group" aria-label={t('discover.niveau-label')}>
            <span className="dv-label" aria-hidden="true">
              {t('discover.niveau-label')}
            </span>
            {chip(filter.level === 'all', t('discover.niveau-tous'), () => setFilter({ ...filter, level: 'all' }))}
            {DISCOVER_LEVELS.map((level) => chip(filter.level === level, t(LEVEL_LABELS[level]), () => setFilter({ ...filter, level })))}
          </div>
        </div>
        <p className="dv-status" role="status" aria-live="polite">
          {shown === 0 ? t('discover.statut-zero') : tp('discover.statut', shown)}
        </p>
      </header>

      {/* One stop of Tab for the whole list, which the arrows then scroll; the cards and their buttons are stops of their own. */}
      <div className="dv-body" tabIndex={0} role="region" aria-labelledby={titleId}>
        {DISCOVER_TASKS.map((task) => {
          const group = cards.filter((entry) => entry.task === task)
          if (group.length === 0) return null
          return (
            <section key={task} className="dv-group" aria-labelledby={`${titleId}-${task}`}>
              <h3 id={`${titleId}-${task}`}>{t(TASK_LABELS[task])}</h3>
              <ul className="dv-grid">{group.map(card)}</ul>
            </section>
          )
        })}
        {others.length > 0 && (
          <section className="dv-group" aria-labelledby={`${titleId}-others`}>
            <h3 id={`${titleId}-others`}>{t('discover.autres-titre')}</h3>
            <p className="dv-lead">{t('discover.autres-intro')}</p>
            <ul className="dv-others">{others.map(other)}</ul>
          </section>
        )}
        {shown === 0 && (
          <div className="tk-empty dv-empty">
            <b>{t('discover.vide-titre')}</b>
            <p>{t('discover.vide-texte')}</p>
            <button type="button" className="tk-btn" onClick={() => setFilter({ query: '', task: 'all', level: 'all' })}>
              {t('discover.effacer')}
            </button>
          </div>
        )}
      </div>
      <footer className="dv-foot-note">{t('discover.vie-privee')}</footer>
    </div>
  )
}
