// The bubble hung from the element that opened a panel: the panel itself is drawn by its template
// (Sheet, Invite), this puts it next to the element, with a small arrow pointing at the middle of it, and keeps it inside the window.
//
//   <AnchoredBubble anchor={request.anchor} side="right">{panel}</AnchoredBubble>
//
// The place is worked out by `bubblePlacement` (src/shared/anchored-bubble.ts) from the size the bubble has once drawn, so it follows a panel that grows
// (an error line appears) and a window that is resized. Until it is measured the bubble is transparent (not hidden: a hidden part cannot take the focus the panel asks for as it opens).

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { bubblePlacement, type BubbleAlign, type BubblePlacement, type BubbleSide } from '@shared/anchored-bubble'
import type { PlusAnchor } from '@shared/plus-menu'
import './anchored-bubble.css'

// `useLayoutEffect` warns when a panel is rendered to markup (the tests), where nothing can be measured anyway.
const useMeasure = typeof window === 'undefined' ? useEffect : useLayoutEffect

export interface AnchoredBubbleProps {
  /** The element that opened the panel, in window coordinates. */
  anchor: PlusAnchor
  /** The side of the element the bubble is on, when it has room: below by default. */
  side?: BubbleSide
  align?: BubbleAlign
  children: ReactNode
}

export function AnchoredBubble({ anchor, side = 'bottom', align = 'start', children }: AnchoredBubbleProps) {
  const host = useRef<HTMLDivElement>(null)
  const [placed, setPlaced] = useState<BubblePlacement | null>(null)

  useMeasure(() => {
    const element = host.current
    if (!element) return
    const place = (): void => {
      const next = bubblePlacement(anchor, { width: element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, side, align)
      setPlaced((previous) => (previous && previous.side === next.side && previous.left === next.left && previous.top === next.top && previous.arrow === next.arrow ? previous : next))
    }
    place()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null
    observer?.observe(element)
    window.addEventListener('resize', place)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [anchor.x, anchor.y, anchor.width, anchor.height, side, align])

  const style: CSSProperties = placed ? { left: placed.left, top: placed.top } : { left: 0, top: 0, opacity: 0 }
  const arrow: CSSProperties | undefined = placed ? (placed.side === 'right' || placed.side === 'left' ? { top: placed.arrow } : { left: placed.arrow }) : undefined
  return (
    <div ref={host} className={`ab ab-${placed?.side ?? side}`} style={style} data-side={placed?.side}>
      {children}
      <span className="ab-arrow" style={arrow} aria-hidden="true" />
    </div>
  )
}
