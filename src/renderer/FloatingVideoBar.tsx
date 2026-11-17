// The bar of Lucium's floating video window (shell/floating-video.ts), laid over the page in the window: at the top, « EN DIRECT » for a live
// stream, the site, « Garder au premier plan » and the close button; at the foot, play or pause, the sound and its volume, −10 s and +10 s (a recorded
// video only), the time (or « En direct »), and « Revenir à l'onglet ». A small window keeps pause, the sound and « Revenir à l'onglet ». It shows as the
// pointer moves over the window and hides 2 s after it stops (shared/floating-video.ts, BarVisibility); what it shows comes from the main process.

import { useEffect, useMemo, useRef, useState, type FocusEvent } from 'react'
import { t } from '@shared/i18n'
import { api } from './api'
import { PauseGlyph, PlayGlyph } from './media-glyphs'
import {
  BarVisibility,
  FLOATING_SEEK_SECONDS,
  canSeek,
  compactBar,
  floatingKeyCommand,
  soundCut,
  timeText,
  type FloatingVideoCommand,
  type FloatingVideoState
} from '@shared/floating-video'

const GLYPH = { width: 18, height: 18, viewBox: '0 0 20 20', 'aria-hidden': true, focusable: false } as const
const LINE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const SoundGlyph = ({ cut }: { cut: boolean }) => (
  <svg {...GLYPH}>
    <path d="M3.5 8h3l4-3.5v11l-4-3.5h-3z" fill="currentColor" />
    {cut ? <path d="M13.5 7.5l5 5M18.5 7.5l-5 5" {...LINE} /> : <path d="M13.5 7.5a3.5 3.5 0 0 1 0 5M15.5 5.5a6.5 6.5 0 0 1 0 9" {...LINE} />}
  </svg>
)
const JumpGlyph = ({ forward }: { forward: boolean }) => (
  <svg {...GLYPH}>
    <path d={forward ? 'M15.5 10a5.5 5.5 0 1 1-2-4.2M15.5 4v3.5H12' : 'M4.5 10a5.5 5.5 0 1 0 2-4.2M4.5 4v3.5H8'} {...LINE} />
    <text x="10" y="12.6" fontSize="6.5" textAnchor="middle" fill="currentColor" fontWeight="700">
      {FLOATING_SEEK_SECONDS}
    </text>
  </svg>
)
const BackGlyph = () => (
  <svg {...GLYPH}>
    <rect x="3" y="4" width="14" height="12" rx="2" {...LINE} strokeWidth={1.5} />
    <path d="M12.5 13.5 8 9M8 12.5V9h3.5" {...LINE} strokeWidth={1.5} />
  </svg>
)
const PinGlyph = () => (
  <svg {...GLYPH}>
    <path d="M7 3.5h6l-1 5 3 3H5l3-3z" {...LINE} strokeWidth={1.5} />
    <path d="M10 11.5v5" {...LINE} strokeWidth={1.5} />
  </svg>
)
const CloseGlyph = () => (
  <svg {...GLYPH}>
    <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
  </svg>
)

export interface FloatingVideoViewProps {
  state: FloatingVideoState | null
  /** The bar is on screen (the pointer moved over the window, a key was pressed, or the keyboard is in it). */
  visible: boolean
  /** The width of the window, in CSS pixels: under FLOATING_COMPACT_WIDTH the bar is the small one. */
  width: number
  act: (command: FloatingVideoCommand) => void
  /** The keyboard came into the bar or left it (the bar stays while it is in). */
  onKeyboard?: (inside: boolean) => void
  /** A drag of the volume slider started or ended (the bar stays while it lasts). */
  onSliding?: (sliding: boolean) => void
}

/** What the bar draws for a state: a function of its props, so that its labels, its states and its small form are tested without a window. */
export function FloatingVideoView({ state, visible, width, act, onKeyboard, onSliding }: FloatingVideoViewProps) {
  const facts = state?.facts ?? null
  const compact = compactBar(width)
  const live = facts?.live === true
  const playing = facts !== null && !facts.paused && !facts.ended
  const cut = state !== null && soundCut(state)
  const time = facts ? timeText(facts) : null
  const keyboard = (inside: boolean) => (event: FocusEvent<HTMLElement>) => {
    // The keyboard only: a click also gives the button the focus, and the bar would then never hide.
    if (inside && !(event.target as HTMLElement).matches?.(':focus-visible')) return
    if (!inside && event.currentTarget.contains(event.relatedTarget as Node | null)) return
    onKeyboard?.(inside)
  }
  return (
    <div className={`fv${visible ? ' shown' : ''}${compact ? ' compact' : ''}`}>
      <div className="fv-top" onFocus={keyboard(true)} onBlur={keyboard(false)}>
        {live &&
          (facts?.behindLive ? (
            <button type="button" className="fv-live behind" title={t('floating-video.revenir-au-direct')} aria-label={t('floating-video.revenir-au-direct')} onClick={() => act({ kind: 'live' })}>
              {t('floating-video.en-direct-pastille')}
            </button>
          ) : (
            <span className="fv-live">{t('floating-video.en-direct-pastille')}</span>
          ))}
        {!compact && state?.site ? <span className="fv-site">{state.site}</span> : null}
        <span className="fv-spacer" />
        {!compact && (
          <button type="button" className="fv-icon" aria-pressed={state?.pinned !== false} aria-label={t('floating-video.garder-au-premier-plan')} title={t('floating-video.garder-au-premier-plan')} onClick={() => act({ kind: 'pin' })}>
            <PinGlyph />
          </button>
        )}
        <button type="button" className="fv-icon" aria-label={t('floating-video.fermer')} title={t('floating-video.fermer-w')} aria-keyshortcuts="Meta+W" onClick={() => act({ kind: 'close' })}>
          <CloseGlyph />
        </button>
      </div>
      {/* A group, not a toolbar: ← and → seek the video here (see the keys of the window), so they cannot also go from button to button. */}
      <div className="fv-bar" role="group" aria-label={t('floating-video.commandes')} onFocus={keyboard(true)} onBlur={keyboard(false)}>
        <button
          type="button"
          className="fv-icon fv-play"
          aria-label={playing ? t('floating-video.pause') : t('floating-video.lecture')}
          title={playing ? t('floating-video.pause-espace') : t('floating-video.lecture-espace')}
          aria-keyshortcuts="Space"
          disabled={facts === null}
          onClick={() => act({ kind: 'toggle' })}
        >
          {playing ? <PauseGlyph /> : <PlayGlyph />}
        </button>
        <span className="fv-sound">
          <button
            type="button"
            className="fv-icon"
            aria-label={cut ? t('floating-video.reactiver-le-son') : t('floating-video.couper-le-son')}
            title={cut ? t('floating-video.reactiver-le-son-m') : t('floating-video.couper-le-son-m')}
            aria-keyshortcuts="M"
            disabled={state === null}
            onClick={() => act({ kind: 'mute' })}
          >
            <SoundGlyph cut={cut} />
          </button>
          {!compact && (
            <input
              type="range"
              className="fv-slider"
              min={0}
              max={1}
              step={0.05}
              value={cut ? 0 : (facts?.volume ?? 1)}
              aria-label={t('floating-video.volume')}
              title={t('floating-video.volume-fleches')}
              aria-keyshortcuts="ArrowUp ArrowDown"
              disabled={facts === null}
              onChange={(event) => act({ kind: 'volume', value: Number(event.currentTarget.value) })}
              onPointerDown={() => onSliding?.(true)}
              onPointerUp={() => onSliding?.(false)}
            />
          )}
        </span>
        {!compact && canSeek(facts) && (
          <>
            <button type="button" className="fv-icon" aria-label={t('floating-video.reculer-de-10-s')} title={t('floating-video.reculer-de-10-s-fleche')} aria-keyshortcuts="ArrowLeft" onClick={() => act({ kind: 'seek', seconds: -FLOATING_SEEK_SECONDS })}>
              <JumpGlyph forward={false} />
            </button>
            <button type="button" className="fv-icon" aria-label={t('floating-video.avancer-de-10-s')} title={t('floating-video.avancer-de-10-s-fleche')} aria-keyshortcuts="ArrowRight" onClick={() => act({ kind: 'seek', seconds: FLOATING_SEEK_SECONDS })}>
              <JumpGlyph forward />
            </button>
          </>
        )}
        {!compact && (
          <span className="fv-time" role={time !== null ? 'timer' : undefined} aria-label={time !== null ? t('floating-video.temps') : undefined}>
            {time ?? (live ? t('floating-video.en-direct') : facts === null ? t('floating-video.recherche-de-la-video') : '')}
          </span>
        )}
        <span className="fv-spacer" />
        <button type="button" className="fv-icon" aria-label={t('floating-video.revenir-a-l-onglet')} title={t('floating-video.revenir-a-l-onglet')} onClick={() => act({ kind: 'back' })}>
          <BackGlyph />
        </button>
      </div>
    </div>
  )
}

/** The bar in its window: the state the main process sends, the pointer, the keys, and the size of the window. */
export function FloatingVideoBar({ act }: { act: (command: FloatingVideoCommand) => void }) {
  const [state, setState] = useState<FloatingVideoState | null>(null)
  const [visible, setVisible] = useState(false)
  const [width, setWidth] = useState(() => window.innerWidth)
  const visibility = useMemo(() => new BarVisibility(setVisible), [])
  // The keys read the latest state without the listener being made again at each one.
  const latest = useRef<FloatingVideoState | null>(null)
  latest.current = state

  useEffect(() => api().onFloatingVideoState(setState), [])
  // The video is read only while the bar is on screen: a window nobody looks at costs nothing.
  useEffect(() => act({ kind: 'watch', on: visible }), [visible, act])
  useEffect(() => {
    document.title = state?.site ? t('floating-video.titre', { site: state.site }) : t('floating-video.titre-sans-site')
  }, [state?.site])
  useEffect(() => {
    const resized = () => setWidth(window.innerWidth)
    const moved = () => visibility.moved()
    const left = () => visibility.left()
    // A button the keyboard reached, not one the pointer just clicked: after a click on « Couper le son », Space still plays or pauses.
    const keyboardOnButton = (target: HTMLElement | null): boolean => target instanceof HTMLButtonElement && target.matches(':focus-visible')
    const key = (event: KeyboardEvent) => {
      visibility.moved()
      const target = event.target as HTMLElement | null
      const command = floatingKeyCommand({ key: event.key, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, onSlider: target instanceof HTMLInputElement && target.type === 'range', onButton: keyboardOnButton(target) }, latest.current?.facts ?? null)
      if (!command) return
      // The key is the bar's: the page behind must not scroll or act on it. (Space on a button gives no command: it presses the button.)
      event.preventDefault()
      act(command)
    }
    window.addEventListener('resize', resized)
    document.addEventListener('mousemove', moved)
    document.documentElement.addEventListener('mouseleave', left)
    document.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('resize', resized)
      document.removeEventListener('mousemove', moved)
      document.documentElement.removeEventListener('mouseleave', left)
      document.removeEventListener('keydown', key)
      visibility.dispose()
    }
  }, [visibility, act])

  return <FloatingVideoView state={state} visible={visible} width={width} act={act} onKeyboard={(inside) => visibility.hold(inside)} onSliding={(sliding) => visibility.hold(sliding)} />
}
