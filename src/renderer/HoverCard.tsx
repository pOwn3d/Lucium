import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { tabName, type TabItem, type TabRuntime } from '@shared/model'
import { cardStatus, pollResources, resourcesLine, splitAddress, type ResourcesReading } from '@shared/hover-card'
import { TAB_STATE_ORDER, tabStateLabel, tabStateNotes, tabStates, type TabStateId } from '@shared/tab-state'
import { FrozenGlyph } from './sidebar-icons'
import { api } from './api'
import { t } from '@shared/i18n'

/** How long the pointer rests on a tab before its card appears (1.5 s). */
export const HOVER_DELAY_MS = 1500
/** Moving to the next tab soon after a card disappeared shows the next card almost at once, like a tooltip that is already "warm". */
const WARM_DELAY_MS = 120
const WARM_WINDOW_MS = 450
/** The card's corner is 11 px right of the pointer, and it covers the last 11 px of the row it is for. */
export const CARD_OFFSET = 11
const CARD_MARGIN = 6
/** How long the card stays after the pointer leaves its row, so that it can be reached (its buttons). */
const CARD_LEAVE_GRACE_MS = 220

interface Anchor {
  tabId: string
  top: number
  bottom: number
  /** Where the pointer was when the card was due. */
  x: number
}

/**
 * The card that follows the tab under the pointer. `start` is called when the pointer enters a row and `hide` when it
 * leaves or does something else (a click, a drag, a key, a scroll): the card is only ever for a pointer that rests.
 */
export function useHoverCard() {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const visible = useRef(false)
  const hiddenAt = useRef(0)
  const pointerX = useRef(0)
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (closing.current) clearTimeout(closing.current)
    closing.current = null
    if (visible.current) hiddenAt.current = Date.now()
    visible.current = false
    setAnchor(null)
  }, [])

  // The pointer left the row: the card stays a moment, long enough to reach it (the card keeps itself open while the pointer is on it).
  const leave = useCallback(() => {
    if (!visible.current) return hide()
    if (closing.current) clearTimeout(closing.current)
    closing.current = setTimeout(hide, CARD_LEAVE_GRACE_MS)
  }, [hide])
  const keep = useCallback(() => {
    if (closing.current) clearTimeout(closing.current)
    closing.current = null
  }, [])

  const start = useCallback((tabId: string, row: HTMLElement, x: number) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    pointerX.current = x
    const warm = visible.current || Date.now() - hiddenAt.current < WARM_WINDOW_MS
    timer.current = setTimeout(
      () => {
        const rect = row.getBoundingClientRect()
        visible.current = true
        setAnchor({ tabId, top: rect.top, bottom: rect.bottom, x: pointerX.current })
      },
      warm ? WARM_DELAY_MS : HOVER_DELAY_MS
    )
  }, [])

  // Anything the user does elsewhere dismisses the card; a scroll moves the row away from where the card was placed.
  useEffect(() => {
    // A click or a wheel on the card itself is its own: only what happens elsewhere dismisses it.
    const dismiss = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.hover-card')) return
      hide()
    }
    const events = ['mousedown', 'keydown', 'wheel', 'blur', 'dragstart', 'contextmenu'] as const
    for (const name of events) window.addEventListener(name, dismiss, true)
    window.addEventListener('scroll', hide, true)
    // The card opens where the pointer is when it is due, not where it entered the row.
    const follow = (event: MouseEvent) => {
      pointerX.current = event.clientX
    }
    window.addEventListener('mousemove', follow, true)
    return () => {
      for (const name of events) window.removeEventListener(name, dismiss, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('mousemove', follow, true)
    }
  }, [hide])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  return { anchor, start, hide, leave, keep }
}

interface CardProps {
  tab: TabItem
  anchor: Anchor
  runtime: TabRuntime | undefined
  sidebarWidth: number
  /** Where the sidebar starts in the window: 0 with the sidebar at the left, further in when it is at the right. */
  sidebarLeft?: number
  /** "Show Hover Preview": the picture of the page, its address and its state join the name. */
  preview: boolean
  /** "Afficher la mémoire de chaque onglet": a line with the memory and processor of the tab's page. Off, nothing is measured. */
  resources: boolean
  /** Setting `tabStateBadges`: the card tells what the page is doing and carries the legend of the marks of the rows. Off, the card is what it was. */
  badges?: boolean
  /** The card's buttons: pin or unpin, sleep, close, copy the address. The sidebar does them and closes the card. */
  onAction?: (action: CardAction) => void
  /** The pointer is on the card (it stays open) or has left it. */
  onEnter?: () => void
  onLeave?: () => void
}

export type CardAction = 'pin' | 'sleep' | 'close' | 'copy'

/** The mark of a state in the legend: the same figure the row draws, small. */
function LegendMark({ state }: { state: TabStateId }) {
  switch (state) {
    case 'loading':
      return <span className="lg-ring" aria-hidden="true" />
    case 'asleep':
      return <span className="lg-zz" aria-hidden="true">zz</span>
    case 'frozen':
      return <span className="lg-frozen" aria-hidden="true"><FrozenGlyph /></span>
    case 'sound':
      return (
        <svg className="lg-sound" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 6h2l3-3v10l-3-3H3zM10.500 6a3 3 0 0 1 0 4" />
        </svg>
      )
    case 'error':
      return <span className="lg-dot" aria-hidden="true" />
  }
}

/** The memory and processor of a tab, measured only while its card is open and only when asked for (see `pollResources`). */
function useTabResources(tabId: string, enabled: boolean): ResourcesReading {
  const [reading, setReading] = useState<ResourcesReading>({ state: 'waiting' })
  useEffect(() => {
    if (!enabled) return
    setReading({ state: 'waiting' })
    return pollResources(
      () => api().tabResources(tabId),
      setReading,
      (error) => console.warn('[hover card] no resources for the tab:', error)
    )
  }, [tabId, enabled])
  return reading
}

/**
 * The bubble of a tab: its name and a hint to rename it. With the preview on it also has a picture of the page,
 * the address and the state. It stays inside the sidebar (a page view would hide anything beyond it).
 */
export function HoverCard({ tab, anchor, runtime, sidebarWidth, sidebarLeft = 0, preview, resources, badges = false, onAction, onEnter, onLeave }: CardProps) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  // The picture of the page is asked for when the card shows; most tabs have one, a tab never shown since the launch has none.
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  const reading = useTabResources(tab.id, resources)
  const states = tabStates(badges, runtime)
  // A sleeping tab has no process: the card says so in words ("Mémoire libérée") rather than with dashes.
  const resourcesText = resources ? (states.includes('asleep') ? t('tab-state.memoire-liberee') : resourcesLine(reading)) : ''
  useEffect(() => {
    if (!preview) return
    let live = true
    api()
      .tabThumbnail(tab.id)
      .then((picture) => live && setThumbnail(picture))
      .catch((error: unknown) => console.warn('[hover card] no picture:', error))
    return () => {
      live = false
    }
  }, [tab.id, preview])

  // Right of the pointer, pulled back inside the sidebar; below the row unless it would run into the footer: then above.
  // The coordinates are the window's; the card is placed in the sidebar, which may itself be moved (the floating copy is inset 5 px).
  useLayoutEffect(() => {
    const box = ref.current
    const parent = box?.offsetParent
    if (!box || !parent) return
    const origin = parent.getBoundingClientRect()
    const left = Math.max(sidebarLeft + CARD_MARGIN, Math.min(anchor.x + CARD_OFFSET, sidebarLeft + sidebarWidth - box.offsetWidth - CARD_MARGIN))
    const below = anchor.bottom - CARD_OFFSET
    const above = anchor.top + CARD_OFFSET - box.offsetHeight
    const top = below + box.offsetHeight > window.innerHeight - 52 ? above : below
    setPlace({ left: left - origin.left - parent.clientLeft, top: top - origin.top - parent.clientTop })
  }, [anchor, tab.title, tab.url, thumbnail, sidebarWidth, sidebarLeft, preview, resourcesText])

  const status = preview ? cardStatus(tab, runtime, badges) : ''
  const notes = tabStateNotes(states, resources)
  const address = splitAddress(tab.url)
  const name = tabName(tab)

  return (
    // A group named by the tab, not a tooltip: a tooltip holds no control, and the card has its buttons.
    <div ref={ref} className={`hover-card ${preview ? 'preview' : ''} ${onAction ? 'actionable' : ''}`} role="group" aria-labelledby={titleId} onMouseEnter={onEnter} onMouseLeave={onLeave} style={{ left: place?.left ?? CARD_MARGIN, top: place?.top ?? 0, visibility: place ? 'visible' : 'hidden' }}>
      {preview && thumbnail && <img className="hover-card-thumb" src={thumbnail} alt="" draggable={false} />}
      <div id={titleId} className="hover-card-title">{name}</div>
      {preview && (
        <div className="hover-card-url" title={tab.url}>
          <strong>{address.host}</strong>
          {address.rest}
        </div>
      )}
      {status && <div className="hover-card-status">{status}</div>}
      {notes.map((note, i) => (
        <div key={note} className={`hover-card-note ${i === 0 && states.includes('error') ? 'error' : ''}`}>
          {note}
        </div>
      ))}
      {resources && <div className="hover-card-resources">{resourcesText}</div>}
      <div className="hover-card-hint">{t('hover-card.double-cliquez-pour-renommer')}</div>
      {onAction && (
        <div className="hover-card-actions">
          <button type="button" onClick={() => onAction('pin')}>{tab.pinned ? t('ctx.desepingler') : t('ctx.epingler')}</button>
          <button type="button" onClick={() => onAction('sleep')} disabled={states.includes('asleep')}>{t('ctx.mettre-en-veille')}</button>
          <button type="button" onClick={() => onAction('copy')}>{t('hover-card.copier-l-adresse')}</button>
          <button type="button" onClick={() => onAction('close')}>{t('ctx.fermer-l-onglet')}</button>
        </div>
      )}
      {badges && (
        <div className="hover-card-legend" role="group" aria-label={t('tab-state.legende-des-etats')}>
          {TAB_STATE_ORDER.map((state) => (
            <span key={state}>
              <LegendMark state={state} />
              {tabStateLabel(state)}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
