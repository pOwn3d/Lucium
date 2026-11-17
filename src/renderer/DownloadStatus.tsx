// The downloads button at the foot of the sidebar, and what it grows into with the setting `downloadStatusChip`: a ring and a count while a
// file comes, a bubble when it ends or fails. With the setting off `FooterDownloads` is the button it always was and nothing below it is mounted:
// no state, no timer, no key listener.

import { useEffect, useRef, useState } from 'react'
import type { DownloadCommand } from '@shared/ipc'
import type { DownloadInfo } from '@shared/model'
import { offersResume, shownDownload, type DownloadButtons } from '@shared/downloads-view'
import { nextSpeedBook, speedOf, withSpeed, type SpeedBook } from '@shared/download-speed'
import { bubbleDelay, bubbleView, chipAnnouncement, chipLabel, chipView, dismiss, holdBubble, initialStatus, observe, releaseBubble, sameStatus, type BubbleView, type ChipView, type StatusState } from '@shared/download-status'
import { t } from '@shared/i18n'
import { ArrowDownGlyph, CloseGlyph, DownloadsIcon, RetryGlyph, TickGlyph, WarnGlyph } from './sidebar-icons'

export interface FooterDownloadsProps {
  /** Setting `downloadStatusChip`. */
  enabled: boolean
  downloads: DownloadInfo[]
  buttons: DownloadButtons
  /** The name of the panel as the tooltip of the button says it at rest: « Téléchargements », with the shortcut that opens it as it is set now. */
  panelLabel?: string | undefined
  /** Opens the panel Téléchargements. */
  onOpenPanel(): void
  onAction(id: string, command: DownloadCommand): void
}

/**
 * The speed of the downloads that run, measured between the snapshots (see download-speed.ts). Switched off, it keeps nothing and measures nothing: the
 * downloads are only drawn, as they were.
 */
export function useDownloadSpeeds(downloads: readonly DownloadInfo[], enabled: boolean): SpeedBook {
  const [book, setBook] = useState<SpeedBook>({})
  useEffect(() => {
    setBook((previous) => nextSpeedBook(previous, downloads, enabled, Date.now()))
  }, [downloads, enabled])
  return book
}

function progressing(downloads: readonly DownloadInfo[]): number {
  return downloads.filter((d) => d.state === 'progressing').length
}

/** The button the footer had before the chip: the icon of the downloads and the count of those that run. */
export function PlainDownloadsButton({ downloads, panelLabel, onOpenPanel }: Pick<FooterDownloadsProps, 'downloads' | 'panelLabel' | 'onOpenPanel'>) {
  const running = progressing(downloads)
  return (
    <button className="footer-side footer-downloads" data-tip={panelLabel ?? t('sidebar.telechargements')} aria-label={t('sidebar.telechargements')} onClick={onOpenPanel}>
      <DownloadsIcon />
      {running > 0 && <span className="footer-count">{running}</span>}
    </button>
  )
}

export function FooterDownloads(props: FooterDownloadsProps) {
  if (!props.enabled) return <PlainDownloadsButton downloads={props.downloads} panelLabel={props.panelLabel} onOpenPanel={props.onOpenPanel} />
  return <DownloadStatus {...props} />
}

/** The chip, from its view: the icon alone at rest, an arrow in a ring while a file comes, a tick or a warning once the bubble speaks of its end. */
export function DownloadChip({ view, speed = null, panelLabel, onOpenPanel, onCancel }: { view: ChipView; speed?: number | null; panelLabel?: string | undefined; onOpenPanel(): void; onCancel(id: string): void }) {
  const label = chipLabel(view, panelLabel)
  const idle = view.state === 'none'
  const percent = view.percent ?? 0
  return (
    <div className={`dlc-group ${view.state}`}>
      <button
        type="button"
        className={`footer-side footer-downloads dlc ${idle ? 'idle' : 'busy'} ${view.state}`}
        // At rest the name is the one the button always had; the tooltip adds the shortcut. While a file comes the name is the file and how far it is.
        aria-label={idle ? t('sidebar.telechargements') : label}
        data-tip={view.state === 'progress' ? withSpeed(label, speed) : label}
        // The ring is the share of the file that has come; with an unknown size it turns instead.
        style={view.state === 'progress' && view.percent !== null ? ({ '--p': percent } as React.CSSProperties) : undefined}
        onClick={onOpenPanel}
      >
        {idle ? (
          <DownloadsIcon />
        ) : (
          <>
            <span className="dlc-ic">
              <ArrowDownGlyph size={13} />
              <i className={`dlc-arc ${view.state} ${view.state === 'progress' && view.percent === null ? 'unknown' : ''}`} />
            </span>
            {view.state === 'progress' && <span className="dlc-n">{view.count}</span>}
            {view.state === 'done' && <TickGlyph size={12} />}
            {view.state === 'fail' && <WarnGlyph size={12} />}
          </>
        )}
      </button>
      {view.state === 'progress' && view.subject && (
        <button type="button" className="dlc-cancel" aria-label={t('download-status.annuler-name', { name: view.subject.filename })} onClick={() => onCancel(view.subject!.id)}>
          <CloseGlyph />
          <span>{t('download-status.annuler-le-telechargement')}</span>
        </button>
      )}
      {/* Said once at the start, at each quarter and at the end (not at each percent: it would talk all through the download). */}
      <span className="st-live" role="status" aria-live="polite">
        {chipAnnouncement(view)}
      </span>
    </div>
  )
}

/** The bubble above the foot: the end of a file, its failure with "Reprendre / Ignorer", or its cancellation. */
export function DownloadBubble({ view, canResume, onOpen, onReveal, onResume, onClose, onHold, onRelease }: { view: BubbleView; canResume: boolean; onOpen(): void; onReveal(): void; onResume(): void; onClose(): void; onHold(): void; onRelease(): void }) {
  return (
    <div className={`dl-bubble ${view.kind}`} role={view.kind === 'fail' ? 'alert' : 'status'} onPointerEnter={onHold} onPointerLeave={onRelease} onFocus={onHold} onBlur={onRelease}>
      <div className="dl-head">
        <span className="dl-ic" aria-hidden="true">
          {view.kind === 'done' ? <TickGlyph size={16} /> : view.kind === 'fail' ? <WarnGlyph size={16} /> : <CloseGlyph />}
        </span>
        <span className="dl-text">
          <b>{view.title}</b>
          <small>{view.detail}</small>
        </span>
        <button type="button" className="dl-x" aria-label={`${t('templates.fermer')} (${t('download-status.echap')})`} onClick={onClose}>
          <CloseGlyph />
        </button>
      </div>
      {view.kind === 'done' && (
        <div className="dl-acts">
          <button type="button" className="dl-btn primary" onClick={onOpen}>
            {t('panels.ouvrir')}
          </button>
          <button type="button" className="dl-btn" onClick={onReveal}>
            {t('panels.afficher-dans-le-finder')}
          </button>
        </div>
      )}
      {view.kind === 'fail' && (
        <div className="dl-acts">
          {canResume && (
            <button type="button" className="dl-btn primary" onClick={onResume}>
              <RetryGlyph size={13} />
              {t('download-status.reprendre')}
            </button>
          )}
          <button type="button" className="dl-btn" onClick={onClose}>
            {t('download-status.ignorer')}
          </button>
        </div>
      )}
      {view.timed && <i key={view.until ?? 'held'} className="dl-timer" aria-hidden="true" />}
    </div>
  )
}

/** The chip and its bubble. It reads the downloads the snapshot carries, and starts a timer only while a bubble that goes by itself is up. */
function DownloadStatus({ downloads, buttons, panelLabel, onOpenPanel, onAction }: Omit<FooterDownloadsProps, 'enabled'>) {
  const mountedAt = useRef(Date.now())
  // The downloads the user asked to cancel from the chip: only their end is told as "annulé".
  const cancelled = useRef(new Set<string>())
  const [status, setStatus] = useState<StatusState>(() => initialStatus(downloads))

  useEffect(() => {
    setStatus((previous) => {
      const next = observe(previous, downloads, { now: Date.now(), mountedAt: mountedAt.current, cancelled: cancelled.current })
      return sameStatus(previous, next) ? previous : next
    })
  }, [downloads])

  // The bubble goes by itself after its time (it holds still while the pointer is on it, and a failure waits for an answer).
  const until = status.bubble?.until ?? null
  useEffect(() => {
    if (until === null) return
    const timer = setTimeout(() => setStatus((current) => (current.bubble?.until === until ? dismiss(current) : current)), bubbleDelay(status, Date.now()) ?? 0)
    return () => clearTimeout(timer)
    // `status` is read once to work out the delay; the bubble and its time are what re-arm the timer.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [status.bubble?.id, until])

  // Escape puts the bubble away (heard only while one is up).
  const open = status.bubble !== null
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setStatus(dismiss)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const speeds = useDownloadSpeeds(downloads, true)
  const view = chipView(downloads, status)
  const subject = status.bubble ? downloads.find((d) => d.id === status.bubble!.id) : undefined
  const bubble = status.bubble && subject ? bubbleView(status.bubble, subject) : null
  const act = (id: string, command: DownloadCommand) => {
    onAction(id, command)
    setStatus(dismiss)
  }
  return (
    <>
      <DownloadChip
        view={view}
        speed={view.subject ? speedOf(speeds, view.subject.id) : null}
        panelLabel={panelLabel}
        onOpenPanel={onOpenPanel}
        onCancel={(id) => {
          cancelled.current.add(id)
          onAction(id, 'cancel')
        }}
      />
      {bubble && subject && (
        <DownloadBubble
          view={bubble}
          canResume={offersResume(shownDownload(subject, buttons), buttons)}
          onOpen={() => act(bubble.id, 'open')}
          onReveal={() => act(bubble.id, 'reveal')}
          onResume={() => onAction(bubble.id, 'resume')}
          onClose={() => setStatus(dismiss)}
          onHold={() => setStatus(holdBubble)}
          onRelease={() => setStatus((current) => releaseBubble(current, Date.now()))}
        />
      )}
    </>
  )
}
