// The ring of the resources at the foot of the sidebar and the panel of glass that slides up from it (shared/resources.ts, the function
// `resource-gauge`). Off, nothing of it is mounted. Closed, the ring only draws what the snapshot carries: no timer,
// no listener, no request. Open, the main process sends its figures every 2 s (one measure for every panel open, in any window), and Escape, a
// press outside it or the window losing the focus closes it.

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { t, tp } from '@shared/i18n'
import { stepProcessRow } from '@shared/processes'
import {
  RELEASE_MEASURE_MS,
  RELEASE_UNDO_MS,
  formatMemory,
  formatPercent,
  gaugeTip,
  heldReport,
  isHot,
  measuredGain,
  meterShare,
  releaseFigures,
  releaseLevelHint,
  releaseLevelName,
  releaseNotice,
  releaseSitesWarning,
  resourceActionDone,
  undoNotice,
  type MemoryGauge,
  type ReleaseOutcome,
  type ReleasePreview,
  type ResourceAction,
  type ResourceActionReply,
  type ResourceReport,
  type ResourceTab
} from '@shared/resources'
import { RELEASE_LEVELS, type ReleaseLevel } from '@shared/sleep'
import { api } from './api'
import { useSystemReducedMotion } from './reduced-motion'
import { Favicon } from './SidebarRows'
import { CloseGlyph, MoonGlyph } from './sidebar-icons'
import './resource-panel.css'

/** How long the panel takes to go (`rp-out` in resource-panel.css): it leaves the page once it has. */
export const PANEL_CLOSE_MS = 140
const PANEL_ID = 'resource-panel'

export interface FooterResourcesProps {
  /** Setting `resourceGauge`. */
  enabled: boolean
  /** What the snapshot carries (absent before the first reading). */
  gauge: MemoryGauge | undefined
  /** The sidebar is on screen: the floating copy is not while it is slid away, and a panel left open there closes. */
  shown: boolean
  /** Setting `forceReduceMotion`, added to what the system asks for. */
  forceReduceMotion: boolean
}

/** The ring, and its panel while it is open. With the setting off, nothing. */
export function FooterResources(props: FooterResourcesProps) {
  if (!props.enabled) return null
  return <ResourceGauge gauge={props.gauge} shown={props.shown} forceReduceMotion={props.forceReduceMotion} />
}

type Phase = 'closed' | 'open' | 'closing'

function ResourceGauge({ gauge, shown, forceReduceMotion }: Omit<FooterResourcesProps, 'enabled'>) {
  const [phase, setPhase] = useState<Phase>('closed')
  const group = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const reduced = useRef(false)
  reduced.current = useSystemReducedMotion() || forceReduceMotion
  /** The panel goes: with its animation, or at once when less motion is asked for. `refocus`: the focus comes back to the ring (Escape). */
  const close = (refocus = false): void => {
    setPhase((now) => (now !== 'open' ? now : reduced.current ? 'closed' : 'closing'))
    if (refocus) button.current?.focus()
  }
  useEffect(() => {
    if (phase !== 'closing') return
    const timer = setTimeout(() => setPhase('closed'), PANEL_CLOSE_MS)
    return () => clearTimeout(timer)
  }, [phase])
  useEffect(() => {
    if (!shown) setPhase('closed')
  }, [shown])
  // Only while it is open: a press outside it, or the window losing the focus (a click on the page, another window), closes it.
  useEffect(() => {
    if (phase !== 'open') return
    const outside = (event: PointerEvent): void => {
      if (!group.current?.contains(event.target as Node)) close()
    }
    const blur = (): void => close()
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', blur)
    }
  }, [phase])
  const open = phase === 'open'
  const tip = gaugeTip(gauge)
  return (
    <div className="rg-group" ref={group}>
      <button
        ref={button}
        type="button"
        className={`footer-side rg-gauge ${gauge?.warn ? 'warn' : ''} ${open ? 'open' : ''}`}
        data-tip={open ? undefined : tip}
        aria-label={tip}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={phase === 'closed' ? undefined : PANEL_ID}
        style={{ '--p': gauge?.percent ?? 0 } as CSSProperties}
        onClick={() => (open ? close() : setPhase('open'))}
      >
        <span className="rg-ring" aria-hidden="true" />
      </button>
      {phase !== 'closed' && <ResourcePanel closing={phase === 'closing'} onClose={close} />}
    </div>
  )
}

/** The button of a row that has the focus: the row itself (it shows the tab), ☾ or ✕. */
type Column = 0 | 1 | 2

/** Asks the main process; a request that fails is said in the console (the panel stays as it is, the next figures tell the truth). */
export function ask(action: ResourceAction): Promise<ResourceActionReply> {
  return api()
    .resourceAction(action)
    .catch((error: unknown) => {
      console.warn(`[resources] the action ${action.kind} of the panel failed:`, error instanceof Error ? error.message : String(error))
      return null
    })
}

export function ResourcePanel({ closing, onClose }: { closing: boolean; onClose: (refocus?: boolean) => void }) {
  const [report, setReport] = useState<ResourceReport | null>(null)
  const [notice, setNotice] = useState('')
  // « Libérer maintenant »: the strength that runs (its buttons wait meanwhile), and the last run, which « Annuler » can still take back.
  const [running, setRunning] = useState<{ level: ReleaseLevel; count: number } | null>(null)
  const [done, setDone] = useState<{ outcome: ReleaseOutcome; before: number | null; freedMb: number | null; undoable: boolean } | null>(null)
  const latest = useRef<ResourceReport | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  // A row that went (put to sleep, closed) gives the focus to the row that takes its place, once the figures without it come.
  const refocus = useRef<{ tabId: string; row: number; column: Column } | null>(null)
  // While the pointer is on the rows they keep their places (`heldReport`): the figures come every 2 s, sorted, and a row must not change under a press.
  const held = useRef(false)
  const acted = useRef(new Set<string>())
  const hold = (on: boolean): void => {
    held.current = on
    if (!on) acted.current.clear()
  }
  useEffect(() => {
    const act = api()
    const off = act.onResources((next) => setReport((shown) => (held.current ? heldReport(shown, next, acted.current) : next)))
    act.resourcePanel(true)
    panel.current?.focus()
    return () => {
      off()
      act.resourcePanel(false)
    }
  }, [])
  const cell = (row: number, column: Column): HTMLElement | null | undefined => panel.current?.querySelector<HTMLElement>(`[data-row="${row}"] [data-col="${column}"]`)
  useEffect(() => {
    const wanted = refocus.current
    if (!wanted || !report || report.tabs.some((tab) => tab.tabId === wanted.tabId)) return
    refocus.current = null
    const rows = report.tabs.length
    ;(rows === 0 ? panel.current?.querySelector<HTMLElement>('.rp-level:not(:disabled), .rp-link') : cell(Math.min(wanted.row, rows - 1), wanted.column))?.focus()
  }, [report])

  latest.current = report
  // What the run really freed is measured a few seconds after it (the processes need a moment to go); « Annuler » is offered for a while.
  const ran = done?.outcome
  useEffect(() => {
    if (!ran || ran.slept === 0) return
    const measure = setTimeout(() => setDone((now) => (now && now.outcome === ran ? { ...now, freedMb: now.before !== null && latest.current ? measuredGain(now.before, latest.current.memoryMb) : null } : now)), RELEASE_MEASURE_MS)
    const expire = setTimeout(() => setDone((now) => (now && now.outcome === ran ? { ...now, undoable: false } : now)), RELEASE_UNDO_MS)
    return () => {
      clearTimeout(measure)
      clearTimeout(expire)
    }
  }, [ran])
  const tabs = report?.tabs ?? []
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      return onClose(true)
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    const target = event.target as HTMLElement
    const at = target.closest<HTMLElement>('[data-row]')
    const from = at ? Number(at.dataset['row']) : null
    const to = stepProcessRow(tabs.map((_, index) => index), from, event.key)
    if (to === null) return
    event.preventDefault()
    cell(to, from === null ? 0 : (Number(target.dataset['col'] ?? 0) as Column))?.focus()
  }
  /**
   * ☾ and ✕ of a row. What was done is said once the main process answered that it was: said at the click, a screen reader heard « Onglet mis
   * en veille » for a tab that was refused or a request that was lost. A tab left as it is keeps its row, and nothing waits for it to go.
   */
  const actOn = (tab: ResourceTab, row: number, column: 1 | 2, kind: 'sleep' | 'close', done: string, failed: string): void => {
    refocus.current = { tabId: tab.tabId, row, column }
    acted.current.add(tab.tabId)
    setNotice('')
    setDone(null)
    void ask({ kind, tabId: tab.tabId }).then((reply) => {
      if (resourceActionDone(reply)) return setNotice(done)
      if (refocus.current?.tabId === tab.tabId) refocus.current = null
      acted.current.delete(tab.tabId)
      setNotice(failed)
    })
  }
  const sleep = (tab: ResourceTab, row: number): void => actOn(tab, row, 1, 'sleep', t('taskmanager.onglet-mis-en-veille'), t('resources.veille-impossible'))
  // The rule of the sidebar's cross: an awake pinned tab is put back on its anchor and stays pinned.
  const close = (tab: ResourceTab, row: number): void => actOn(tab, row, 2, 'close', tab.pinned ? t('taskmanager.onglet-epingle-ferme') : t('taskmanager.onglet-ferme'), t('resources.fermeture-impossible'))
  const show = (tab: ResourceTab): void => {
    void ask({ kind: 'show', tabId: tab.tabId })
    onClose()
  }
  /** One run at a time: the buttons wait, and a second click is ignored. Closing the panel does not stop the run (the main process finishes it). */
  const release = (preview: ReleasePreview): void => {
    if (running) return
    setNotice('')
    setDone(null)
    setRunning({ level: preview.level, count: preview.count })
    const before = latest.current?.memoryMb ?? null
    void ask({ kind: 'sleep-level', level: preview.level }).then((reply) => {
      setRunning(null)
      if (!reply || !('released' in reply)) return setNotice(t('resources.liberer-impossible'))
      setDone({ outcome: reply.released, before, freedMb: null, undoable: reply.released.slept > 0 })
    })
  }
  /** « Annuler »: the tabs of the last run load again from their address, in the background. */
  const undo = (): void => {
    setDone(null)
    void ask({ kind: 'undo-level' }).then((reply) => setNotice(reply && 'woken' in reply ? undoNotice(reply.woken) : t('resources.annulation-impossible')))
  }
  return (
    <div id={PANEL_ID} ref={panel} className={`rp-panel ${closing ? 'closing' : ''}`} role="dialog" aria-label={t('resources.ressources')} tabIndex={-1} onKeyDown={keys}>
      <ResourcePanelBody
        report={report}
        notice={done ? releaseNotice(done.outcome, done.freedMb) : running ? tp('resources.liberer-en-cours', running.count) : notice}
        onShow={show}
        onSleep={sleep}
        onClose={close}
        running={running}
        undoable={done?.undoable === true}
        onRelease={release}
        onUndo={undo}
        onHold={hold}
        onTaskManager={() => {
          void ask({ kind: 'task-manager' })
          onClose()
        }}
      />
    </div>
  )
}

export interface ResourcePanelBodyProps {
  /** Null until the first figures come. */
  report: ResourceReport | null
  /** What the last button did. */
  notice: string
  onShow(tab: ResourceTab): void
  onSleep(tab: ResourceTab, row: number): void
  onClose(tab: ResourceTab, row: number): void
  /** The strength that runs, or null: its buttons wait. */
  running?: { level: ReleaseLevel; count: number } | null
  /** « Annuler » is offered (the last run freed tabs a short while ago). */
  undoable?: boolean
  onRelease(preview: ReleasePreview): void
  onUndo?(): void
  onTaskManager(): void
  /** The pointer comes on the rows, or leaves them: while it is there, the rows keep their places. */
  onHold?(held: boolean): void
}

/** What the panel draws from its figures: the totals, the share of the Mac's memory, the heaviest tabs, the notice and the two buttons of the foot. */
export function ResourcePanelBody({ report, notice, running = null, undoable = false, onShow, onSleep, onClose, onRelease, onUndo, onTaskManager, onHold }: ResourcePanelBodyProps) {
  const tabs = report?.tabs ?? []
  const summary = report ? `${formatMemory(report.memoryMb)} · ${t('resources.d-un-coeur', { cpu: formatPercent(report.cpu) })}` : ''
  return (
    <>
      <div className="rp-head">
        <b>{t('resources.ressources')}</b>
        <span>{summary}</span>
      </div>
      {report && (
        <div className="rp-memory">
          <span>{t('taskmanager.memoire')}</span>
          <span className="rp-bar" role="meter" aria-label={t('resources.part-de-la-memoire-du-mac')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={report.gauge.percent}>
            <i className={report.gauge.warn ? 'warn' : ''} style={{ '--w': report.gauge.percent / 100 } as CSSProperties} />
          </span>
          <span className="rp-percent">{t('resources.pourcent', { n: report.gauge.percent })}</span>
        </div>
      )}
      {!report ? (
        <p className="rp-empty">{t('resources.mesure')}</p>
      ) : tabs.length === 0 ? (
        <p className="rp-empty">{t('resources.aucun-onglet-eveille')}</p>
      ) : (
        <ul className="rp-rows" aria-label={t('resources.onglets-qui-consomment-le-plus')} onPointerEnter={() => onHold?.(true)} onPointerLeave={() => onHold?.(false)}>
          {tabs.map((tab, row) => (
            <ResourceRow key={tab.tabId} tab={tab} row={row} tabs={tabs} onShow={() => onShow(tab)} onSleep={() => onSleep(tab, row)} onClose={() => onClose(tab, row)} />
          ))}
        </ul>
      )}
      <ReleaseLevels levels={report?.levels ?? null} running={running} onRelease={onRelease} />
      <div className="rp-result">
        <p className="rp-notice" role="status" aria-live="polite">
          {notice}
        </p>
        {undoable && (
          <button type="button" className="rp-undo" title={t('resources.annuler-hint')} onClick={onUndo}>
            {t('resources.annuler')}
          </button>
        )}
      </div>
      <div className="rp-foot">
        <button type="button" className="rp-link" onClick={onTaskManager}>
          {t('resources.gestionnaire-complet')}
        </button>
      </div>
    </>
  )
}

const WARN_ID = 'rp-release-warn'

/**
 * « Libérer maintenant »: the three strengths one under the other, each with what it takes (the tabs, and the memory of the processes that would go),
 * as the panel measured it; the warning of the strongest one stays on screen, not only on a hover. A strength with nothing to take is greyed; while a
 * run goes the buttons are `aria-disabled` rather than `disabled`, so that the one that was pressed keeps the keyboard focus.
 */
export function ReleaseLevels({ levels, running, onRelease }: { levels: readonly ReleasePreview[] | null; running: { level: ReleaseLevel } | null; onRelease(preview: ReleasePreview): void }) {
  const high = levels?.find((preview) => preview.level === 'high')
  const warning = high ? releaseSitesWarning(high) : null
  const nothing = levels !== null && levels.every((preview) => preview.count === 0)
  return (
    <section className="rp-release" aria-labelledby="rp-release-title" aria-busy={running !== null}>
      <h3 id="rp-release-title" className="rp-release-title">
        {t('resources.liberer-titre')}
      </h3>
      <div className="rp-levels" role="group" aria-labelledby="rp-release-title">
        {RELEASE_LEVELS.map((level) => {
          const preview = levels?.find((one) => one.level === level)
          const empty = preview === undefined || preview.count === 0
          return (
            <button
              key={level}
              type="button"
              className={`rp-level ${running?.level === level ? 'running' : ''}`}
              data-level={level}
              disabled={empty}
              aria-disabled={running !== null || undefined}
              aria-describedby={level === 'high' && warning ? WARN_ID : undefined}
              onClick={() => preview && !running && onRelease(preview)}
            >
              <span className="rp-level-text">
                <b>{releaseLevelName(level)}</b>
                <span>{releaseLevelHint(level)}</span>
              </span>
              <span className="rp-level-figures">{preview ? releaseFigures(preview) : t('resources.mesure')}</span>
            </button>
          )
        })}
      </div>
      {warning && (
        <p id={WARN_ID} className="rp-warn">
          {warning}
        </p>
      )}
      {nothing && <p className="rp-empty">{t('resources.rien-a-endormir')}</p>}
      <p className="rp-protected">{t('resources.liberer-protege')}</p>
    </section>
  )
}

/** One tab: its icon, its name and where it is, a meter against the heaviest of the list, its figures, then ☾ and ✕. */
export function ResourceRow({ tab, row, tabs, onShow, onSleep, onClose }: { tab: ResourceTab; row: number; tabs: readonly ResourceTab[]; onShow(): void; onSleep(): void; onClose(): void }) {
  const memory = formatMemory(tab.memoryMb)
  const cpu = formatPercent(tab.cpu)
  const named = [t('resources.afficher-name', { name: tab.name }), memory, cpu, ...(tab.where ? [tab.where] : [])].join(' · ')
  return (
    <li className="rp-row" data-row={row}>
      <button type="button" className="rp-show" data-col={0} aria-label={named} title={tab.shared ? t('resources.processus-partage') : undefined} onClick={onShow}>
        <span className="rp-icon">{tab.icon ? <span className="favicon emoji-icon">{tab.icon}</span> : <Favicon tab={{ url: tab.url, title: tab.name, ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}) }} />}</span>
        <span className="rp-text">
          <span className="rp-line">
            <span className="rp-name">{tab.name}</span>
            {tab.where && <span className="rp-where">{tab.where}</span>}
          </span>
          <span className="rp-meter" aria-hidden="true">
            <i className={isHot(tab) ? 'hot' : ''} style={{ '--w': meterShare(tab, tabs) } as CSSProperties} />
          </span>
        </span>
        <span className="rp-num" aria-hidden="true">
          <span>{memory}</span>
          <span>{cpu}</span>
        </span>
      </button>
      <button type="button" className="rp-act" data-col={1} aria-label={t('resources.mettre-en-veille-name', { name: tab.name })} title={t('taskmanager.mettre-en-veille')} onClick={onSleep}>
        <MoonGlyph />
      </button>
      <button type="button" className="rp-act" data-col={2} aria-label={t('resources.fermer-name', { name: tab.name })} title={tab.pinned ? t('sidebar.fermer-et-garder-epingle') : t('sidebar.archiver-cet-onglet')} onClick={onClose}>
        <CloseGlyph />
      </button>
    </li>
  )
}
