import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { t, tp } from '@shared/i18n'
import { isLeaveKey } from '@shared/panel-keys'
import { iconSource } from '@shared/site-icon'
import { hostOf } from '@shared/url'
import { NO_FILTERS, choiceActions, searchTabs, type TabSearchRow } from '@shared/tab-search'
import { isGridKey, moveGridSelection, selectionAfterClose } from '@shared/tab-grid'
import { api, useSnapshot } from './api'
import { SearchGlyph, activeSpaceHue, hueProps, useFocusScope } from './templates'
import './tab-grid.css'

/** How many cards sit on a row: the cards that share the top of the first one (the grid wraps by itself, the keys follow what is drawn). */
function columnsOf(list: HTMLElement | null): number {
  const cards = list ? Array.from(list.children).filter((el): el is HTMLElement => el instanceof HTMLElement) : []
  const first = cards[0]
  if (!first) return 1
  return Math.max(1, cards.filter((card) => card.offsetTop === first.offsetTop).length)
}

/**
 * The overview of the open tabs (setting `tabGrid`): a grid of cards, one per tab, with the picture of the page when the main process has one (it hands them over in
 * `pictures`: none for a private or a locked tab), its title and its site. A search narrows the cards, the chips choose the Space (the one on screen first, or all of them),
 * a card goes to its tab, its button (or ⌫) closes the tab and the panel stays for the next one, and the menu of the tab (a right click, the menu key) moves it to another Space.
 * The side column is not touched. The keys are in `shared/tab-grid.ts`.
 */
export function TabGrid({ pictures }: { pictures: Record<string, string> }) {
  const act = api()
  const snapshot = useSnapshot()
  const [query, setQuery] = useState('')
  // null: every Space; else one. The Space on screen at first.
  const [space, setSpace] = useState<string | null | undefined>(undefined)
  const [selected, setSelected] = useState(0)
  // The line read out after a tab is closed: the count is in the status already, this names what went.
  const [said, setSaid] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const input = useRef<HTMLInputElement>(null)
  // The index of the card that must take the focus after a render (a key moved the selection, or a tab was closed).
  const [focusCard, setFocusCard] = useState<number | null>(null)
  const titleId = useId()
  useFocusScope(root, { trap: true })

  const state = snapshot?.state
  const scope = space === undefined ? (state?.activeSpaceId ?? null) : space
  const result = useMemo(() => (snapshot ? searchTabs(snapshot.state, snapshot.runtime, query, { ...NO_FILTERS, space: scope }) : null), [snapshot, query, scope])
  // The archive is not an open tab: a text typed adds some of its lines to the search, the overview shows tabs only.
  const rows = useMemo(() => (result ? result.rows.filter((row): row is TabSearchRow => row.kind === 'tab') : []), [result])
  const current = Math.min(selected, Math.max(0, rows.length - 1))

  useEffect(() => {
    if (focusCard === null) return
    list.current?.querySelector<HTMLElement>(`[data-index="${focusCard}"] .tg-go`)?.focus()
    setFocusCard(null)
  }, [focusCard, rows.length])

  if (!snapshot || !state || !result) return null
  const { className: hueClass, style } = hueProps(activeSpaceHue(state.spaces, state.activeSpaceId))
  const chips = [{ id: null as string | null, label: t('tabgrid.tous-les-espaces'), count: result.allSpacesCount }, ...state.spaces.map((s) => ({ id: s.id as string | null, label: `${s.emoji} ${s.name}`.trim(), count: result.spaceCounts[s.id] ?? 0 }))]
  const spaceOf = (id: string) => state.spaces.find((s) => s.id === id)

  const go = (row: TabSearchRow): void => {
    for (const action of choiceActions(state, row, 'go')) void act.dispatch(action)
    act.closeOverlay()
  }
  const close = (row: TabSearchRow, index: number): void => {
    void act.dispatch({ type: 'tab/close', id: row.id })
    setSaid(t('tabgrid.onglet-ferme', { title: row.title }))
    const next = selectionAfterClose(index, rows.length - 1)
    setSelected(next)
    setFocusCard(rows.length > 1 ? next : null)
    if (rows.length <= 1) input.current?.focus()
  }
  const move = (to: number): void => {
    setSelected(to)
    setFocusCard(to)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isLeaveKey(e.nativeEvent)) {
      e.stopPropagation()
      if (query) {
        setQuery('')
        setSelected(0)
      } else act.closeOverlay()
    }
  }
  const onFieldKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown' && rows.length > 0) {
      e.preventDefault()
      move(current)
    } else if (e.key === 'Enter' && rows[0]) {
      e.preventDefault()
      go(rows[0])
    }
  }
  const onCardKeyDown = (e: KeyboardEvent, row: TabSearchRow, index: number): void => {
    if (isGridKey(e.key)) {
      e.preventDefault()
      move(moveGridSelection(index, rows.length, columnsOf(list.current), e.key))
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && e.target === e.currentTarget) {
      e.preventDefault()
      close(row, index)
    }
  }
  const showMenu = (row: TabSearchRow, element: Element): void => {
    const r = element.getBoundingClientRect()
    act.showMenu({ kind: 'tab', id: row.id, anchor: { x: r.left, y: r.top, width: r.width, height: r.height } })
  }

  return (
    <div ref={root} className={`tg tk-panel ${hueClass}`.trim()} style={style} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <header className="tg-head">
        <div className="tg-title">
          <h2 id={titleId}>{t('tabgrid.titre')}</h2>
          <span className="tg-count" role="status" aria-live="polite">
            {tp('tabgrid.compte', rows.length)}
            {said ? ` · ${said}` : ''}
          </span>
          <button type="button" className="tk-btn quiet icon" aria-label={t('tabgrid.fermer-echap')} title={t('tabgrid.fermer-echap')} onClick={() => act.closeOverlay()}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="tk-search" role="search">
          <SearchGlyph />
          <input
            ref={input}
            className="tk-field"
            type="search"
            data-autofocus
            value={query}
            placeholder={t('tabgrid.chercher-placeholder')}
            aria-label={t('tabgrid.chercher-label')}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(0)
              setSaid('')
            }}
            onKeyDown={onFieldKeyDown}
          />
        </div>
        {state.spaces.length > 1 && (
          <div className="tg-chips" role="group" aria-label={t('tabgrid.espace-label')}>
            {chips.map((chip) => (
              <button key={chip.id ?? 'all'} type="button" className="tk-chip" aria-pressed={scope === chip.id} onClick={() => { setSpace(chip.id); setSelected(0) }}>
                {chip.label}
                <span className="tg-n" aria-hidden="true">{chip.count}</span>
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="tg-body">
        {rows.length > 0 ? (
          <ul className="tg-grid" ref={list} aria-label={t('tabgrid.liste-label')}>
            {rows.map((row, i) => {
              const picture = pictures[row.id]
              const iconUrl = iconSource(row.faviconUrl)
              const site = hostOf(row.url) || row.url
              const owner = scope === null ? spaceOf(row.spaceId) : undefined
              return (
                <li key={row.id} data-index={i} className={`tg-card${row.current ? ' current' : ''}${row.asleep ? ' asleep' : ''}`} onContextMenu={(e) => { e.preventDefault(); showMenu(row, e.currentTarget) }}>
                  <button
                    type="button"
                    className="tg-go"
                    tabIndex={i === current ? 0 : -1}
                    aria-current={row.current ? 'true' : undefined}
                    aria-label={t('tabgrid.aller-a', { title: row.title })}
                    onClick={() => go(row)}
                    onFocus={() => setSelected(i)}
                    onKeyDown={(e) => onCardKeyDown(e, row, i)}
                  >
                    <span className="tg-pic" aria-hidden="true">
                      {picture ? <img src={picture} alt="" draggable={false} /> : iconUrl ? <img className="tg-icon" src={iconSource(row.faviconUrl)} alt="" draggable={false} /> : <span className="tg-letter">{(site[0] ?? '·').toUpperCase()}</span>}
                    </span>
                    <span className="tg-line">
                      {iconUrl && <img className="tg-fav" src={iconSource(row.faviconUrl)} alt="" draggable={false} />}
                      <span className="tg-name">{row.title}</span>
                    </span>
                    <span className="tg-site">
                      {site}
                      {owner ? ` · ${owner.emoji}` : ''}
                      {row.asleep ? ` · ${t('tabsearch.en-veille')}` : ''}
                    </span>
                  </button>
                  <button type="button" className="tg-close" tabIndex={i === current ? 0 : -1} aria-label={t('tabgrid.fermer-l-onglet', { title: row.title })} title={t('tabgrid.fermer-l-onglet', { title: row.title })} onClick={() => close(row, i)}>
                    <svg viewBox="0 0 12 12" aria-hidden="true">
                      <path d="m2 2 8 8m0-8-8 8" />
                    </svg>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="tk-empty tg-empty">
            <b>{t('tabgrid.vide-titre')}</b>
            <p>{query.trim() ? t('tabgrid.vide-recherche', { query: query.trim() }) : t('tabgrid.vide-texte')}</p>
            {query && (
              <button type="button" className="tk-btn" onClick={() => { setQuery(''); setSelected(0) }}>
                {t('tabgrid.effacer')}
              </button>
            )}
          </div>
        )}
      </div>
      <footer className="tg-foot">
        <span>{t('tabgrid.pied-touches')}</span>
        <span>{t('tabgrid.pied-vie-privee')}</span>
      </footer>
    </div>
  )
}
