import { Fragment, useEffect, useState } from 'react'
import { mountRoot } from './root'
import type { ProcessRow } from '@shared/ipc'
import { PROCESS_KIND_LABEL, filterProcessRows, memoryShare, processSummary, rowsBySpace, sleepTargetOf, sortProcessRows, stepProcessRow, type ProcessSortKey } from '@shared/processes'
import { ipcErrorText } from '@shared/ipc-error'
import { api, useSnapshot } from './api'
import './styles.css'
import './settings.css'
import { lockDocumentDrops } from './surface'
import { t, tp } from '@shared/i18n'
import { formatPercent } from '@shared/resources'
import { useWindowTitle } from './window-title'
import { useActionNotice } from './notice-hold'

lockDocumentDrops()

const REFRESH_MS = 2000
const COLUMNS: Array<{ key: ProcessSortKey; label: string; numeric?: boolean }> = [
  { key: 'name', get label() { return t('taskmanager.tache') } },
  { key: 'kind', get label() { return t('taskmanager.type') } },
  { key: 'memoryMb', get label() { return t('taskmanager.memoire') }, numeric: true },
  { key: 'cpu', get label() { return t('taskmanager.processeur') }, numeric: true },
  { key: 'pid', get label() { return t('taskmanager.id-du-processus') }, numeric: true }
]

export function TaskManager() {
  const [rows, setRows] = useState<ProcessRow[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [grouped, setGrouped] = useState(false)
  // What the footer can undo for ACTION_NOTICE_MS (while the pointer or the focus is on it, it waits) after a tab was put to sleep or closed: the label, and what brings the tab back.
  const [undo, setUndo] = useState<{ label: string; run: () => void } | null>(null)
  const undoNotice = useActionNotice(undo, () => setUndo(null))
  const [sort, setSort] = useState<{ key: ProcessSortKey | null; direction: 'asc' | 'desc' }>({ key: null, direction: 'desc' })
  // Why the list could not be read, or a process ended: said above the list, which else stays empty or out of date with no word.
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const refresh = () =>
      void api()
        .listProcesses()
        .then(
          (next) => {
            if (!live) return
            setRows(next)
            setFailure(null)
          },
          (error: unknown) => {
            console.error('[task manager] the processes could not be listed:', error)
            if (live) setFailure(t('taskmanager.liste-illisible', { error: ipcErrorText(error) }))
          }
        )
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  const total = rows.reduce((sum, r) => sum + r.memoryMb, 0)
  const summary = processSummary(rows)
  const sorted = sortProcessRows(filterProcessRows(rows, query), sort.key, sort.direction)
  // Grouped by space: a stable sort, so the order of the column stays inside each space; the rows without a space (browser, GPU…) come last.
  const shown = grouped ? rowsBySpace(sorted) : sorted
  // The grid is one stop of Tab, as a grid is: the selected row, or the first while none is (or the selected one is no longer listed); the arrows do the rest.
  const tabbable = shown.some((r) => r.pid === selected) ? selected : (shown[0]?.pid ?? null)
  const picked = rows.find((r) => r.pid === selected)
  const sleepTarget = sleepTargetOf(picked)
  const sortBy = (key: ProcessSortKey) => setSort((s) => ({ key, direction: s.key === key && s.direction === 'asc' ? 'desc' : 'asc' }))

  return (
    <div className="task-manager">
      {/* What the browser uses in all, and a filter on the list. */}
      <div className="task-summary" aria-live="polite">
        <div>
          <b>{t('taskmanager.mb-mo', { mb: summary.memoryMb })}</b>
          {t('taskmanager.memoire-totale')}
        </div>
        <div>
          <b>{tp('taskmanager.tabs', summary.tabs)}</b>
        </div>
        <div>
          <b>{formatPercent(summary.cpu)}</b>
          {t('taskmanager.processeur')}
        </div>
        <label className="task-group-toggle">
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> {t('taskmanager.grouper-par-espace')}
        </label>
        <input className="task-filter" type="search" value={query} placeholder={t('taskmanager.filtrer')} aria-label={t('taskmanager.filtrer-les-processus')} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {failure && (
        <p className="task-empty" role="alert">
          {failure}
        </p>
      )}
      <div className="rows">
        <table role="grid" aria-label={t('taskmanager.processus')}>
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th key={column.key} className={column.numeric ? 'num' : undefined} aria-sort={sort.key === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button className="task-sort" onClick={() => sortBy(column.key)}>
                    {column.label}
                    {sort.key === column.key && <span aria-hidden="true">{sort.direction === 'asc' ? ' ▲' : ' ▼'}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <Fragment key={row.pid}>
              {grouped && row.space !== shown[index - 1]?.space && (
                <tr className="task-group">
                  <td colSpan={COLUMNS.length}>{row.space ?? t('taskmanager.sans-espace')}</td>
                </tr>
              )}
              <tr
                data-kind={row.kind}
                data-pid={row.pid}
                tabIndex={row.pid === tabbable ? 0 : -1}
                aria-selected={row.pid === selected}
                className={row.pid === selected ? 'selected' : ''}
                onClick={() => setSelected(row.pid)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelected(row.pid)
                  else {
                    const target = stepProcessRow(shown.map((r) => r.pid), row.pid, e.key)
                    if (target === null) return
                    setSelected(target)
                    e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-pid="${target}"]`)?.focus()
                  }
                  e.preventDefault()
                }}
              >
                <td className="name" title={row.name}>
                  {row.name}
                  {row.asleep && <span className="task-chip">{t('taskmanager.en-veille')}</span>}
                  {grouped && row.space && <span className="task-space">{row.space}</span>}
                </td>
                <td>{PROCESS_KIND_LABEL[row.kind]}</td>
                <td className="num task-mem" style={{ '--share': memoryShare(row, rows) } as React.CSSProperties}>
                  {row.asleep ? '—' : t('taskmanager.mb-mo', { mb: row.memoryMb })}
                </td>
                <td className="num">{row.asleep ? '—' : formatPercent(row.cpu)}</td>
                <td className="num">{row.pid}</td>
              </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && rows.length > 0 && <p className="task-empty">{t('taskmanager.aucun-processus-ne-correspond-query', { query })}</p>}
      </div>
      <div className="task-total">
        <span>
          {undo ? (
            <span role="status" {...undoNotice.props}>
              {undo.label} ·{' '}
              <button className="link-button" onClick={() => { undo.run(); setUndo(null) }}>
                {t('menu.annuler')}
              </button>
            </span>
          ) : (
            <>{tp('taskmanager.processus-mo', rows.length, { mb: total })}</>
          )}
        </span>
        <span className="task-actions">
          {/* The tab of a page, or the one the frames of another site of the row are in. */}
          <button className="button" disabled={sleepTarget === null} onClick={() => sleepTarget && (api().sleepTab(sleepTarget), setUndo({ label: t('taskmanager.onglet-mis-en-veille'), run: () => void api().dispatch({ type: 'tab/select', id: sleepTarget }) }))}>
            {t('taskmanager.mettre-en-veille')}
          </button>
          <button
            className="button"
            disabled={picked?.kind !== 'tab' || picked.tabId === undefined}
            onClick={() => {
              const tabId = picked?.tabId
              if (!tabId) return
              // The rule of the sidebar's cross (shared/tab-close.ts): an open pinned tab is only put to sleep, and stays pinned.
              const action = picked?.closeAction ?? 'tab/archive'
              void api().dispatch({ type: action, id: tabId })
              setUndo(
                action === 'tab/close'
                  ? { label: t('taskmanager.onglet-epingle-ferme'), run: () => void api().dispatch({ type: 'tab/select', id: tabId }) }
                  : { label: t('taskmanager.onglet-ferme'), run: () => void api().dispatch({ type: 'archive/restore-last' }) }
              )
            }}
          >
            {t('taskmanager.fermer-l-onglet')}
          </button>
          <button
            className="button"
            disabled={picked?.kind !== 'tab' || picked.asleep === true}
            title={picked && picked.kind !== 'tab' ? t('taskmanager.seuls-les-processus-d-onglets-peuvent-etre') : undefined}
            onClick={() =>
              picked &&
              void api()
                .killProcess(picked.pid)
                .then(
                  () => setSelected(null),
                  (error: unknown) => {
                    console.error(`[task manager] the process ${picked.pid} could not be ended:`, error)
                    setFailure(t('taskmanager.arret-impossible', { error: ipcErrorText(error) }))
                  }
                )
            }
          >
            {t('taskmanager.mettre-fin-au-processus')}
          </button>
        </span>
      </div>
    </div>
  )
}

/** The window once the snapshot has set the language of the interface (as the Settings window does): before it, every text would be read in French. */
function TaskManagerPage() {
  const snapshot = useSnapshot()
  useWindowTitle(snapshot ? t('app.gestionnaire-de-taches') : null)
  if (!snapshot) return null
  return <TaskManager />
}

mountRoot(<TaskManagerPage />)
