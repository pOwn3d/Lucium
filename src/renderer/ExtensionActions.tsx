// The extension icons of the toolbar, and the menu that takes the ones that do not fit. The icons themselves are the library's
// <browser-action-list> (badges, popups, the activeTab hand-over); this component only hides the ones the plan sends to the menu, and
// draws the button. With the setting off nothing here measures or observes anything: the list is the library's, as it always was.

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ACTION_ICON_WIDTH, actionListKey, planActionBar, rightGroupRoom, samePlan, type ActionBarPlan } from '@shared/extension-overflow'
import { api, useSnapshot } from './api'
import { tipProps } from './tooltip'
import { t } from '@shared/i18n'

/** The library's list leaves 4 px on its right (toolbar.css). */
const LIST_MARGIN = 4
const NOTHING: readonly string[] = []
const NO_EXTENSIONS: ReadonlyArray<{ profileId: string; enabled: boolean }> = []

interface Props {
  partition: string
  /** The profile of the partition (the list is made again when its first extension is loaded, see `actionListKey`). */
  profileId: string
  /** The bar, its left group and its right group: the room left for the icons is what the address does not need. */
  bar: RefObject<HTMLDivElement | null>
  left: RefObject<HTMLDivElement | null>
  right: RefObject<HTMLDivElement | null>
}

/** `»`: two chevrons, in the line style of the other toolbar glyphs. */
const OverflowIcon = (): ReactNode => (
  <svg viewBox="0 0 20 20" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.500 5l5 5-5 5M10.500 5l5 5-5 5" />
  </svg>
)

export function ExtensionActions({ partition, profileId, bar, left, right }: Props) {
  const snapshot = useSnapshot()
  const listKey = actionListKey(partition, profileId, snapshot?.extensions ?? NO_EXTENSIONS)
  const enabled = snapshot?.state.settings.extensionOverflow === true
  const unpinned = snapshot?.state.settings.unpinnedExtensions ?? NOTHING
  // A new array each time would restart the observers: the key is the content.
  const unpinnedKey = unpinned.join(',')
  const wrapper = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLElement>(null)
  const [overflow, setOverflow] = useState<string[]>([])
  // The bar and its right group are ancestors of this component: React attaches their refs after this component's own layout effect has run, so the first
  // run finds them empty and measures nothing. One more render, right after the commit and before the paint, finds them. (Until the snapshot
  // arrived late, a second render came by itself when the list changed; a snapshot already there at the first render left the bar without its plan.)
  const [committed, setCommitted] = useState(false)
  useLayoutEffect(() => setCommitted(true), [])

  useLayoutEffect(() => {
    const [host, root, leftGroup, rightGroup, wrap] = [list.current, bar.current, left.current, right.current, wrapper.current]
    if (!enabled) {
      setOverflow((now) => (now.length > 0 ? [] : now))
      return
    }
    // A private window defines no such element: it has no extension icons.
    const shadow = host?.shadowRoot
    if (!shadow || !root || !leftGroup || !rightGroup || !wrap) return
    const hiddenIds = unpinnedKey === '' ? [] : unpinnedKey.split(',')
    let plan: ActionBarPlan | null = null

    const apply = () => {
      const nodes = Array.from(shadow.querySelectorAll<HTMLElement>('.action'))
      // What the right group holds besides the icons: the site control centre, the split button, the gaps.
      const fixed = rightGroup.offsetWidth - wrap.offsetWidth
      const room = rightGroupRoom(root.offsetWidth, leftGroup.offsetWidth) - fixed - LIST_MARGIN
      const next = planActionBar(
        nodes.map((node) => node.id),
        hiddenIds,
        room,
        ACTION_ICON_WIDTH
      )
      const shown = new Set(next.shown)
      // Always written: the library makes a new button for an extension that was reloaded, and it has not been hidden yet.
      for (const node of nodes) node.hidden = !shown.has(node.id)
      if (samePlan(plan, next)) return
      plan = next
      setOverflow(next.overflow)
    }

    apply()
    const resize = new ResizeObserver(apply)
    resize.observe(root)
    resize.observe(leftGroup)
    // The buttons beside the icons come and go with the page (« Contraste de la page » is only for a web page): the room they leave is measured again.
    resize.observe(rightGroup)
    const mutations = new MutationObserver(apply)
    mutations.observe(shadow, { childList: true })
    return () => {
      resize.disconnect()
      mutations.disconnect()
      for (const node of Array.from(shadow.querySelectorAll<HTMLElement>('.action'))) node.hidden = false
    }
  }, [enabled, unpinnedKey, partition, listKey, bar, left, right, committed])

  return (
    <div className="tb-actions" ref={wrapper}>
      {/* Keyed by the partition (and by whether the profile has an extension, see actionListKey): the element keeps its buttons while it fetches another profile's list, which showed (and let click) the icons of the previous profile for a moment. */}
      <browser-action-list key={listKey} ref={list} partition={partition} alignment="bottom left" />
      {enabled && overflow.length > 0 && (
        <button className="tb-button tb-overflow" aria-label={t('extension-actions.autres-extensions')} {...tipProps(t('extension-actions.autres-extensions'))} onClick={() => api().showMenu({ kind: 'extensions', id: 'overflow', hidden: overflow })}>
          <OverflowIcon />
        </button>
      )}
    </div>
  )
}
