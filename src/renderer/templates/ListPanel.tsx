// The template of the panels of a list. Six panels are built on it: history, archive, spaces, notes, sessions and bookmarks. The frame is the same
// in each; a panel brings its rows. The other panels of a list (downloads, passwords, cookies, read later, site data) still draw their own
// frame: they have none of what is listed below unless they do it themselves.
//
//   <ListPanel
//     icon={<ArchiveGlyph />} title="Archive" count={items.length} onDone={close}
//     search={{ value: filter, onChange: setFilter, label: 'Filtrer l’archive' }}
//     footStart={<button className="tk-btn quiet danger" …>Vider l’archive</button>}
//     undo={undo.panel}
//   >
//     <ListGroup title="Aujourd’hui"><ListRow title="…" subtitle="…" onOpen={…} actions={<button …/>} /></ListGroup>
//   </ListPanel>
//
// What the frame does for every panel built on it: Escape and "Terminé" close it, ⌘Z takes the last deletion back (useUndoQueue), the arrows go from row to row,
// Return in the search opens the first result (`search.onSubmit`), the hue of the space is the accent (`hue`).

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { listPanelKey, nextRowIndex } from '@shared/panel-keys'
import { useNoticeHold } from '../notice-hold'
import { radioGroupKeys } from '../radio-keys'
import { SearchGlyph } from './glyphs'
import { hueProps } from './hue'
import './primitives.css'
import './list-panel.css'

export interface ListSearch {
  value: string
  onChange: (value: string) => void
  /** The name of the field for assistive technology: the full sentence, where the placeholder is short. */
  label: string
  placeholder?: string
  /** Return in the field: open the first result. `modified` is ⌘Return (Ctrl on other systems), a different way of opening it. */
  onSubmit?: (modified: boolean) => void
}

export interface ListPanelProps {
  title: string
  /** The glyph of the panel, drawn in the pastille of the accent. */
  icon: ReactNode
  count?: number | string
  /** The hue of the space (see useSpaceHue): the accent of the panel. */
  hue?: number
  /** A class of the panel itself, for what is its own. */
  className?: string
  search?: ListSearch
  /** One action in the header, next to the search ("Ajouter la page"). */
  action?: ReactNode
  /** The filter chips under the header (`tk-chip` buttons with `aria-pressed`), and their name. */
  filters?: ReactNode
  filtersLabel?: string
  /**
   * `radiogroup` when exactly one chip is chosen at a time (« Cette page / Cet espace / Toutes »): the chips are then `role="radio"` with
   * `aria-checked`, one stop of Tab, and the arrows (Home, End) move and choose, as in any group of radios.
   */
  filtersRole?: 'radiogroup'
  /** `loading` shows a static skeleton and says so; `error` says what went wrong, with a retry. */
  state?: 'ready' | 'loading' | 'error'
  statusText?: string
  onRetry?: () => void
  /** The destructive action of the panel, on the left of the foot, in discreet red. */
  footStart?: ReactNode
  /** An option that belongs to the foot, before "Terminé" ("Restaurer dans un nouvel espace"). */
  footOption?: ReactNode
  doneLabel?: string
  /** "Terminé" and Escape. */
  onDone: () => void
  /** The notice that takes the last deletion back, for eight seconds (`onHold`: the time stops while the pointer or the focus is on it). */
  undo?: { message: string; onUndo: () => void; onHold?: (held: boolean) => void } | null
  children?: ReactNode
}

/** The notice of the last deletion: its time is kept by whoever made the deletion, and waits while the pointer or the focus is on it. */
function UndoNotice({ undo }: { undo: { message: string; onUndo: () => void; onHold?: (held: boolean) => void } }) {
  const hold = useNoticeHold(undo.onHold)
  return (
    <div className="lp-undo" role="status" {...hold}>
      <span>{undo.message}</span>
      <button type="button" className="tk-btn" onClick={undo.onUndo}>
        {t('templates.annuler')} <kbd className="tk-kbd">⌘Z</kbd>
      </button>
    </div>
  )
}

/** The rows of the panel that the arrows go through: the main button of each. */
const rowButtons = (root: HTMLElement): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>('.lp-main:not(:disabled)'))

const isField = (target: EventTarget): boolean => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement

export function ListPanel({ title, icon, count, hue, className, search, action, filters, filtersLabel, filtersRole, state = 'ready', statusText, onRetry, footStart, footOption, doneLabel, onDone, undo, children }: ListPanelProps) {
  const root = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const { className: hueClass, style } = hueProps(hue)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const action = listPanelKey(event.nativeEvent, isField(event.target), undo != null)
    if (!action) return
    if (action.type === 'close') {
      // The panel owns Escape while it is open: the host must not close it a second time.
      event.stopPropagation()
      return onDone()
    }
    if (action.type === 'undo') {
      event.preventDefault()
      return undo?.onUndo()
    }
    if (!root.current) return
    const rows = rowButtons(root.current)
    const target = rows[nextRowIndex(rows.indexOf(document.activeElement as HTMLElement), rows.length, action.key)]
    if (!target) return
    event.preventDefault()
    target.focus()
    target.scrollIntoView?.({ block: 'nearest' })
  }

  return (
    <div
      ref={root}
      className={['lp tk-panel', hueClass, className].filter(Boolean).join(' ')}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-busy={state === 'loading' ? true : undefined}
      onKeyDown={onKeyDown}
    >
      <header className="lp-head">
        <span className="tk-glyph" aria-hidden="true">
          {icon}
        </span>
        <h2 id={titleId}>
          {title}
          {count !== undefined && <span className="lp-count">{count}</span>}
        </h2>
        {search && (
          <div className="tk-search">
            <SearchGlyph />
            <input
              className="tk-field"
              type="search"
              autoFocus
              spellCheck={false}
              aria-label={search.label}
              placeholder={search.placeholder ?? t('templates.rechercher')}
              value={search.value}
              onChange={(event) => search.onChange(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && search.onSubmit?.(event.metaKey || event.ctrlKey)}
            />
          </div>
        )}
        {action && <span className="lp-action">{action}</span>}
      </header>
      {filters && (
        <div className="lp-filters" role={filtersRole ?? 'group'} aria-label={filtersLabel} onKeyDown={filtersRole === 'radiogroup' ? radioGroupKeys : undefined}>
          {filters}
        </div>
      )}
      <div className="lp-body">
        {state === 'loading' && (
          <>
            <p className="tk-status" role="status">
              {statusText ?? t('templates.chargement')}
            </p>
            <ListSkeleton />
          </>
        )}
        {state === 'error' && (
          <p className="tk-status error" role="alert">
            {statusText}{' '}
            {onRetry && (
              <button type="button" className="tk-btn small" onClick={onRetry}>
                {t('templates.reessayer')}
              </button>
            )}
          </p>
        )}
        {state !== 'loading' && children}
      </div>
      {undo && <UndoNotice undo={undo} />}
      <footer className="lp-foot">
        {footStart}
        <span className="lp-spacer" />
        {footOption}
        <button type="button" className="tk-btn primary" onClick={onDone}>
          {doneLabel ?? t('templates.termine')}
        </button>
      </footer>
    </div>
  )
}

/** Rows grouped under a small title ("Aujourd’hui", "Hier"); a group without a title is the plain list. */
export function ListGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="lp-group">
      {title && <h3>{title}</h3>}
      <ul className="lp-list">{children}</ul>
    </section>
  )
}

export interface ListRowProps {
  /** What stands at the left: a favicon, a file glyph, a letter. It is decorative. */
  icon?: ReactNode
  title: string
  /** The line under the title: address · date. */
  subtitle?: ReactNode
  /** What stands at the right, always visible: a size, an hour, a status. */
  meta?: ReactNode
  /** The actions of the row, shown on hover and on focus (and always where there is no hover). Each is a 28 px button with a name. */
  actions?: ReactNode
  /** The row opens something: it is then a button. Without it the row is plain text. */
  onOpen?: () => void
  /** The full text of the row for the tooltip, when the title is cut. */
  hint?: string
  pinned?: boolean
}

export function ListRow({ icon, title, subtitle, meta, actions, onOpen, hint, pinned }: ListRowProps) {
  const content = (
    <>
      {icon !== undefined && (
        <span className="lp-ico" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="lp-text">
        <span className="lp-title">{title}</span>
        {subtitle !== undefined && <span className="lp-sub">{subtitle}</span>}
      </span>
    </>
  )
  return (
    <li className={`lp-row${pinned ? ' pinned' : ''}`}>
      {onOpen ? (
        <button type="button" className="lp-main" title={hint} onClick={onOpen}>
          {content}
        </button>
      ) : (
        <div className="lp-main" title={hint}>
          {content}
        </div>
      )}
      {meta !== undefined && <span className="lp-meta">{meta}</span>}
      {actions && <span className="lp-actions">{actions}</span>}
    </li>
  )
}

/** The state of a list with nothing in it: what it is for, and what to do. Not a blank. */
export function ListEmpty({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="tk-empty">
      <span className="tk-empty-ico" aria-hidden="true">
        {icon}
      </span>
      <b>{title}</b>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  )
}

/** Three rows of grey bars while the list is read: still, with the sentence above to say what is going on. */
export function ListSkeleton() {
  return (
    <ul className="lp-list lp-skeleton" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <li key={index} className="lp-row">
          <span className="lp-main">
            <span className="lp-ico" />
            <span className="lp-text">
              <span className="lp-line" style={{ width: `${70 - index * 12}%` }} />
              <span className="lp-line" style={{ width: `${40 + index * 5}%` }} />
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}
