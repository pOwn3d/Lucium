// The time of a notice with an action, as a component draws it (the rule is src/shared/toast.ts: ACTION_NOTICE_MS, and a pause while the pointer or the
// focus is on the notice). Two bindings:
//
//   const notice = useActionNotice(undo, () => setUndo(null))       // the component owns the notice and its timer
//   <div role="status" {...notice.props}>…</div>
//
//   const props = useNoticeHold(queue.hold)                         // the time is kept elsewhere (an undo queue): the notice only says when it is held
//   <div role="status" {...props}>…</div>

import { useCallback, useEffect, useMemo, useRef, type FocusEvent } from 'react'
import { ACTION_NOTICE_MS, NoticeHolds, NoticeTimer } from '@shared/toast'

/** What the element of a notice listens to. `onMouseMove` is there for a notice that appeared under a pointer that does not move in or out. */
export interface NoticeHoldProps {
  onMouseEnter(): void
  onMouseMove(): void
  onMouseLeave(): void
  onFocus(): void
  onBlur(event: FocusEvent<HTMLElement>): void
}

function holdProps(holds: () => NoticeHolds, apply: (held: boolean) => void): NoticeHoldProps {
  const change = (by: 'pointer' | 'focus', inside: boolean): void => {
    const held = holds().set(by, inside)
    if (held !== null) apply(held)
  }
  return {
    onMouseEnter: () => change('pointer', true),
    onMouseMove: () => change('pointer', true),
    onMouseLeave: () => change('pointer', false),
    onFocus: () => change('focus', true),
    // The focus moving between two controls of the notice is not leaving it.
    onBlur: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) change('focus', false)
    }
  }
}

/**
 * For a notice whose time is kept somewhere else: `onHeld` hears when the pointer or the focus comes onto it and when both have left. `shown` says whether
 * the notice is on screen: one that goes while it was held lets go (so does the component that leaves), and the next one is not held by what held this one.
 */
export function useNoticeHold(onHeld?: (held: boolean) => void, shown = true): NoticeHoldProps {
  const holds = useRef(new NoticeHolds())
  const latest = useRef(onHeld)
  latest.current = onHeld
  const letGo = useCallback((): void => {
    if (holds.current.held) latest.current?.(false)
    holds.current = new NoticeHolds()
  }, [])
  useEffect(() => (shown ? undefined : letGo()), [shown, letGo])
  useEffect(() => letGo, [letGo])
  return useMemo(() => holdProps(() => holds.current, (held) => latest.current?.(held)), [])
}

export interface ActionNotice {
  /** The pointer or the focus came onto the notice (`true`) or left it: for a panel that draws the notice itself (`ListPanel`'s `undo.onHold`). */
  hold(held: boolean): void
  /** What the element of the notice listens to. */
  props: NoticeHoldProps
}

/**
 * Runs `expire` ACTION_NOTICE_MS after `notice` appears or changes (a new value is a new notice, with all its time), and not while the pointer or the focus
 * is on it. `notice` falsy: nothing runs. The notice element is new each time one appears: what held the one before does not hold this one.
 */
export function useActionNotice(notice: unknown, expire: () => void): ActionNotice {
  const timer = useRef<NoticeTimer | null>(null)
  const holds = useRef(new NoticeHolds())
  const latest = useRef(expire)
  latest.current = expire
  useEffect(() => {
    holds.current = new NoticeHolds()
    if (!notice) return
    const own = new NoticeTimer(ACTION_NOTICE_MS, () => latest.current()).start()
    timer.current = own
    return () => {
      own.cancel()
      if (timer.current === own) timer.current = null
    }
  }, [notice])
  const hold = useCallback((held: boolean): void => {
    if (held) timer.current?.hold()
    else timer.current?.release()
  }, [])
  const props = useMemo(() => holdProps(() => holds.current, hold), [hold])
  return useMemo(() => ({ hold, props }), [hold, props])
}
