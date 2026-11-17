// The ring of the resources at the foot of the sidebar and the panel of glass that slides up from it (shared/resources.ts, the function
// `resource-gauge`). Off, nothing of it is mounted. Closed, the ring only draws what the snapshot carries: no timer,
// no listener, no request. Open, the main process sends its figures every 2 s (one measure for every panel open, in any window), and Escape, a
// press outside it or the window losing the focus closes it.

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { t } from '@shared/i18n'
import { stepProcessRow } from '@shared/processes'
import { formatMemory, formatPercent, gaugeTip, heldReport, isHot, meterShare, resourceActionDone, type MemoryGauge, type ResourceAction, type ResourceActionReply, type ResourceReport, type ResourceTab } from '@shared/resources'
import { sleepToastMessage } from '@shared/sleep'
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
    ;(rows === 0 ? panel.current?.querySelector<HTMLElement>('.rp-sleep-all:not(:disabled), .rp-link') : cell(Math.min(wanted.row, rows - 1), wanted.column))?.focus()
  }, [report])

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
  const sleepHidden = (): void => {
    void ask({ kind: 'sleep-hidden' }).then((reply) => setNotice(reply && 'slept' in reply && reply.slept > 0 ? sleepToastMessage(reply.slept) : t('resources.rien-a-endormir')))
  }
  return (
    <div id={PANEL_ID} ref={panel} className={`rp-panel ${closing ? 'closing' : ''}`} role="dialog" aria-label={t('resources.ressources')} tabIndex={-1} onKeyDown={keys}>
      <ResourcePanelBody
        report={report}
        notice={notice}
        onShow={show}
        onSleep={sleep}
        onClose={close}
        onSleepHidden={sleepHidden}
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
  onSleepHidden(): void
  onTaskManager(): void
  /** The pointer comes on the rows, or leaves them: while it is there, the rows keep their places. */
  onHold?(held: boolean): void
}

/** What the panel draws from its figures: the totals, the share of the Mac's memory, the heaviest tabs, the notice and the two buttons of the foot. */
export function ResourcePanelBody({ report, notice, onShow, onSleep, onClose, onSleepHidden, onTaskManager, onHold }: ResourcePanelBodyProps) {
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
      <p className="rp-notice" role="status" aria-live="polite">
        {notice}
      </p>
      <div className="rp-foot">
        <button type="button" className="rp-link" onClick={onTaskManager}>
          {t('resources.gestionnaire-complet')}
        </button>
        <button type="button" className="rp-sleep-all" title={t('resources.tout-endormir-hint')} disabled={!report || report.hidden === 0} onClick={onSleepHidden}>
          <MoonGlyph />
          {t('resources.tout-endormir')}
        </button>
      </div>
    </>
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
