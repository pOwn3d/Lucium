// The media player at the foot of the sidebar: a navy bar that shows the controls of a tab that plays sound while
// another tab is on screen. Folded it is one row (the site, previous, play or pause, next, volume); the pointer unfolds the title row
// above it, and the speaker opens the volume slider below the title. Measures: media player series (see shared/media-player.ts).

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { tabName, type RuntimeState, type SidebarState, type TabItem, type TabRuntime } from '@shared/model'
import { MEDIA_PLAYER, isPlaying, mediaLabels, tabVolume, thumbLeft, volumeAt, type MediaCommand, type MediaRequest } from '@shared/media-player'
import { api } from './api'
import { Favicon } from './SidebarRows'
import { hideTooltip, tipProps } from './tooltip'
import { PauseGlyph, PlayGlyph } from './media-glyphs'
import './media-player.css'

/** The slider sends a value at most this often while it is dragged (each one reaches every frame of the page), and the last one always. */
const SEND_EVERY_MS = 40
/** After the pointer let go, the thumb stays where it was dropped this long: the shell's answer (the new level) comes back a moment later. */
const SETTLE_MS = 300
const VOLUME_STEP = 0.05

// The pictograms are drawn here, at these sizes: previous and next 14 x 11, the speaker 19 x 14 (crossed 13 x 13), picture in picture 16 x 13,
// the cross 11 x 11. Play (11 x 12) and pause (9 x 12) are in media-glyphs.tsx: every play and pause of Lucium is this one.
const fill = { fill: 'currentColor', stroke: 'currentColor', strokeLinejoin: 'round', strokeWidth: 1.5, 'aria-hidden': true } as const
const line = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

function PreviousGlyph() {
  return (
    <svg viewBox="0 0 14 11" width="14" height="11" {...fill} strokeWidth="1.2">
      <rect x="0.6" y="0.6" width="1.7" height="9.8" rx="0.5" />
      <path d="M12.9 1.4v8.2L4.6 5.5z" />
    </svg>
  )
}
function NextGlyph() {
  return (
    <svg viewBox="0 0 14 11" width="14" height="11" {...fill} strokeWidth="1.2">
      <rect x="11.7" y="0.6" width="1.7" height="9.8" rx="0.5" />
      <path d="M1.1 1.4v8.2l8.3-4.1z" />
    </svg>
  )
}
function SpeakerGlyph({ crossed }: { crossed: boolean }) {
  const body = 'M.5 4.7h2.6L7 1.2c.5-.4 1.2-.1 1.2.5v10.6c0 .6-.7.9-1.2.5L3.1 9.3H.5c-.3 0-.5-.2-.5-.5V5.2c0-.3.2-.5.5-.5z'
  return crossed ? (
    <svg viewBox="0 0 13 13" width="13" height="13" aria-hidden="true">
      <path d="M.4 4.2h2.4L6.2 1.1c.5-.4 1.1-.1 1.1.5v9.8c0 .6-.6.9-1.1.5L2.8 8.8H.4c-.3 0-.4-.2-.4-.5V4.7c0-.3.1-.5.4-.5z" fill="currentColor" />
      <path d="M2.2 1.2 12 11.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </svg>
  ) : (
    <svg viewBox="0 0 19 14" width="19" height="14" aria-hidden="true">
      <path d={body} fill="currentColor" transform="translate(0 0)" />
      <path d="M11.4 3.7a4.6 4.6 0 0 1 0 6.6M14.4 1.7a7.6 7.6 0 0 1 0 10.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
    </svg>
  )
}
function PipGlyph() {
  return (
    <svg viewBox="0 0 16 13" width="16" height="13" {...line} strokeWidth="1.3">
      <path d="M1.4 8.6V2.7c0-.8.6-1.4 1.4-1.4h8.4c.8 0 1.4.6 1.4 1.4v2.2" />
      <rect x="5.1" y="5.6" width="9.6" height="6.2" rx="1.4" />
    </svg>
  )
}
function CrossGlyph() {
  return (
    <svg viewBox="0 0 11 11" width="11" height="11" {...line} strokeWidth="1.3">
      <path d="M1 1l9 9M10 1 1 10" />
    </svg>
  )
}
/** A note that flies off the site's icon while the tab plays. */
function NoteGlyph() {
  return (
    <svg viewBox="0 0 6 10" width="6" height="10" fill="currentColor" aria-hidden="true">
      <path d="M3.6 0v6.6A2 1.6 0 1 0 4.8 8V2.4l1.2.5V1.4z" />
    </svg>
  )
}

interface ButtonProps {
  label: string
  className?: string
  /** Dimmed, and it says why in its bubble. The button stays a button (not `disabled`): a disabled one would not show the bubble. */
  dim?: boolean
  /** Toned down but still at work (the pause of a tab that cannot be heard): neither said to be unavailable nor drawn as faint as one that is. */
  quiet?: boolean
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}

/** A 24 x 24 button of the bar, with the bubble that shows after a wait. */
function BarButton({ label, className, dim, quiet, pressed, onClick, children }: ButtonProps) {
  return (
    <button
      type="button"
      className={['mp-button', className, dim && 'dim', quiet && 'quiet', pressed && 'pressed'].filter(Boolean).join(' ')}
      aria-label={label}
      aria-disabled={dim || undefined}
      aria-pressed={pressed}
      {...tipProps(label, undefined, 'media')}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** The slider: a track of 6 px, a thumb of 20 x 16 whose centre follows the pointer. Drag, click and arrow keys. */
function VolumeSlider({ volume, onChange }: { volume: number; onChange: (volume: number) => void }) {
  const zone = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const lastSent = useRef(0)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => (settle.current ? clearTimeout(settle.current) : undefined), [])
  const width = zone.current?.clientWidth ?? 291
  const shown = drag ?? volume

  const send = (next: number, final: boolean) => {
    const now = Date.now()
    if (!final && now - lastSent.current < SEND_EVERY_MS) return
    lastSent.current = now
    onChange(next)
  }
  const follow = (event: PointerEvent<HTMLDivElement>, final: boolean) => {
    const box = zone.current?.getBoundingClientRect()
    if (!box) return
    const next = volumeAt(event.clientX - box.left, box.width)
    setDrag(next)
    send(next, final)
  }
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? VOLUME_STEP : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -VOLUME_STEP : 0
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : step === 0 ? null : Math.min(1, Math.max(0, Math.round((shown + step) * 100) / 100))
    if (next === null) return
    event.preventDefault()
    onChange(next)
  }

  return (
    <div
      ref={zone}
      className="mp-slider"
      role="slider"
      tabIndex={0}
      aria-label={t('media-player.volume-de-l-onglet')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown * 100)}
      onPointerDown={(event) => {
        if (settle.current) clearTimeout(settle.current)
        event.currentTarget.setPointerCapture(event.pointerId)
        follow(event, false)
      }}
      onPointerMove={(event) => event.currentTarget.hasPointerCapture(event.pointerId) && follow(event, false)}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        follow(event, true)
        event.currentTarget.releasePointerCapture(event.pointerId)
        settle.current = setTimeout(() => setDrag(null), SETTLE_MS)
      }}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={key}
    >
      <span className="mp-track" />
      <span className="mp-fill" style={{ width: thumbLeft(shown, width) + MEDIA_PLAYER.thumbWidth / 2 }} />
      <span className="mp-thumb" style={{ left: thumbLeft(shown, width) }} />
    </div>
  )
}

export function MediaPlayer({ tab, info }: { tab: TabItem; info: TabRuntime | undefined }) {
  const act = api()
  // The title row opens while the pointer is on the bar; the slider row when the speaker is pressed, and it holds the bar open a while after the pointer left.
  // It opens too while the keyboard has the focus on one of its buttons: the first two Tab stops of the bar are in the title row, and a button
  // that has the focus must be on screen. A focus a click gave opens nothing (the pointer is on the bar already).
  const [inside, setInside] = useState(false)
  const [keyboard, setKeyboard] = useState(false)
  const [slider, setSlider] = useState(false)
  const [foldMs, setFoldMs] = useState<number>(MEDIA_PLAYER.unfoldMs)
  const grace = useRef<ReturnType<typeof setTimeout> | null>(null)
  const playing = isPlaying(info)
  const muted = info?.muted === true
  const labels = mediaLabels({ playing, previous: info?.previous === true, next: info?.next === true, video: info?.video === true })
  const send = (order: { command: MediaCommand } | { command: 'volume'; volume: number }) => act.media({ tabId: tab.id, ...order } as MediaRequest)
  const cancelGrace = () => {
    if (grace.current) clearTimeout(grace.current)
    grace.current = null
  }
  useEffect(() => cancelGrace, [])

  const closeSlider = () => {
    // The row folds in a little longer than the title row does.
    setFoldMs(MEDIA_PLAYER.foldFromSliderMs)
    setSlider(false)
  }
  const state = slider ? 'volume' : inside || keyboard ? 'open' : 'folded'

  return (
    <div
      className={`media-player ${state}`}
      data-media-player={tab.id}
      data-state={state}
      data-playing={playing && !muted ? 'true' : 'false'}
      style={{ '--mp-ms': `${foldMs}ms` } as CSSProperties}
      onFocus={(event) => {
        if (!event.target.matches(':focus-visible')) return
        setFoldMs(MEDIA_PLAYER.unfoldMs)
        setKeyboard(true)
      }}
      onBlur={(event) => {
        // A focus that goes from one button of the bar to another stays in the bar.
        if (!event.currentTarget.contains(event.relatedTarget)) setKeyboard(false)
      }}
      onPointerEnter={() => {
        cancelGrace()
        setFoldMs(MEDIA_PLAYER.unfoldMs)
        setInside(true)
      }}
      onPointerLeave={() => {
        hideTooltip()
        cancelGrace()
        if (!slider) return setInside(false)
        grace.current = setTimeout(() => {
          grace.current = null
          setInside(false)
          closeSlider()
        }, MEDIA_PLAYER.sliderGraceMs)
      }}
    >
      <div className="mp-notes" aria-hidden="true">
        <span className="mp-note n1"><NoteGlyph /></span>
        <span className="mp-note n2"><NoteGlyph /></span>
        <span className="mp-note n3"><NoteGlyph /></span>
      </div>
      <div className="mp-clip">
        <div className="mp-header">
          {/* The title of the tab (renamed or not: what its row says), not the track name of the MediaSession: it is the same on every site and needs no question to the page. */}
          <span className="mp-title">{tabName(tab)}</span>
          <BarButton label={labels.pip} className="mp-pip" dim={info?.video !== true} onClick={() => info?.video === true && send({ command: 'pip' })}>
            <PipGlyph />
          </BarButton>
          <BarButton label={labels.close} className="mp-close" onClick={() => send({ command: 'close' })}>
            <CrossGlyph />
          </BarButton>
        </div>
        <div className="mp-controls">
          <BarButton label={labels.back} className="mp-site" onClick={() => send({ command: 'back' })}>
            <Favicon tab={tab} />
          </BarButton>
          <div className="mp-transport">
            <BarButton label={labels.previous} className="mp-previous" dim={info?.previous !== true} onClick={() => info?.previous === true && send({ command: 'previous' })}>
              <PreviousGlyph />
            </BarButton>
            {/* Muted: the button is toned down but still works, so a tab that cannot be heard can still be paused. */}
            <BarButton label={labels.toggle} className="mp-toggle" quiet={muted} onClick={() => send({ command: 'toggle' })}>
              {playing ? <PauseGlyph /> : <PlayGlyph />}
            </BarButton>
            <BarButton label={labels.next} className="mp-next" dim={info?.next !== true} onClick={() => info?.next === true && send({ command: 'next' })}>
              <NextGlyph />
            </BarButton>
          </div>
          <BarButton
            label={labels.volume}
            className="mp-volume-button"
            pressed={slider}
            onClick={() => {
              cancelGrace()
              if (slider) return closeSlider()
              setFoldMs(MEDIA_PLAYER.unfoldMs)
              setSlider(true)
            }}
          >
            <SpeakerGlyph crossed={muted} />
          </BarButton>
        </div>
        <div className="mp-volume-row">
          <VolumeSlider volume={tabVolume(info)} onChange={(volume) => send({ command: 'volume', volume })} />
        </div>
      </div>
    </div>
  )
}

/** The players of the tabs the shell opened one for, oldest first. Nothing when there is none. */
export function MediaPlayers({ state, runtime }: { state: SidebarState; runtime: RuntimeState }) {
  const players = (runtime.media ?? []).map((id) => state.tabs.find((t) => t.id === id)).filter((t): t is TabItem => t !== undefined)
  if (players.length === 0) return null
  return (
    <div className="media-players">
      {players.map((tab) => (
        <MediaPlayer key={tab.id} tab={tab} info={runtime.tabs[tab.id]} />
      ))}
    </div>
  )
}

import { t } from '@shared/i18n'