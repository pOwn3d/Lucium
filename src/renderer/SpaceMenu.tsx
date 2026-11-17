import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { isListedTab } from '@shared/model'
import { SPACE_MENU_ENTRIES, spaceMenuEnabled, spaceMenuGroups, spaceMenuPlacement, spaceMenuRefusal, spaceMenuRun, spaceMenuShortcut, stepSpaceMenu, type SpaceMenuEntryId } from '@shared/space-menu'
import type { PlusAnchor } from '@shared/plus-menu'
import { themeHue } from '@shared/theme'
import { t } from '@shared/i18n'
import { api, useSnapshot } from './api'
import './space-menu.css'

/** Narrowest the card is drawn (236 px); a longer label or shortcut widens it. */
const MENU_WIDTH = 236

/**
 * The menu of a space, hung from the header of the sidebar. The rows that open the editor of the space ask for the `space` panel
 * as the right-click menu does; the others run an action of the store and close the card. The first enabled row has the focus, the arrows, Home
 * and End move between rows, Escape and Tab close it (the host closes it on a click outside).
 */
export function SpaceMenu({ spaceId, anchor }: { spaceId: string; anchor: PlusAnchor }) {
  const snapshot = useSnapshot()
  const act = api()
  const items = useRef<Array<HTMLButtonElement | null>>([])
  const [width, setWidth] = useState(MENU_WIDTH)
  const card = useRef<HTMLDivElement>(null)
  const state = snapshot?.state
  const space = state?.spaces.find((s) => s.id === spaceId)
  const todayCount = state ? state.tabs.filter((tab) => tab.spaceId === spaceId && isListedTab(tab) && !tab.pinned).length : 0
  const entries = useMemo(() => SPACE_MENU_ENTRIES(), [])
  const context = { todayCount, locked: snapshot?.lock?.lockedSpaces.includes(spaceId) === true }
  const enabled = entries.map((entry) => spaceMenuEnabled(entry.id, context))

  useEffect(() => {
    const first = enabled.indexOf(true)
    if (first >= 0) items.current[first]?.focus()
    // The card is measured once it is drawn: a long label widens it, and its place is worked out from that width.
    if (card.current) setWidth(Math.max(MENU_WIDTH, card.current.offsetWidth))
    // Opened once; the rows do not change under the pointer.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!state || !space) return null

  const run = (id: SpaceMenuEntryId) => {
    const outcome = spaceMenuRun(id, spaceId)
    if (outcome.kind === 'overlay') return act.openOverlay(outcome.request)
    act.closeOverlay()
    void act.dispatch(outcome.action)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      return act.closeOverlay()
    }
    if (e.key === 'Tab') return act.closeOverlay()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const from = items.current.findIndex((item) => item === document.activeElement)
      const next = stepSpaceMenu(enabled, from, e.key)
      if (next >= 0) items.current[next]?.focus()
    }
  }

  const place = spaceMenuPlacement(anchor, { width: window.innerWidth }, width)
  const style = { left: place.left, top: place.top, '--hue': String(themeHue(space.theme)) } as CSSProperties
  let index = -1
  return (
    <div ref={card} className="space-menu" role="menu" aria-label={t('sidebar.menu-de-l-espace-name', { name: space.name })} style={style} onKeyDown={onKeyDown}>
      {spaceMenuGroups().map((group, g) => (
        <Fragment key={g}>
          {g > 0 && <div className="sm-separator" role="separator" />}
          {group.map((entry) => {
            const i = ++index
            const shortcut = spaceMenuShortcut(entry, state.settings.keyBindings)
            // A row the lock greys out says why under the pointer.
            const refusal = spaceMenuRefusal(entry.id, context)
            return (
              <button
                key={entry.id}
                ref={(node) => {
                  items.current[i] = node
                }}
                type="button"
                role="menuitem"
                className="sm-row"
                data-entry={entry.id}
                // Not `disabled`: a disabled button swallows the pointer, and the click would fall through to the host and close the card.
                aria-disabled={!enabled[i]}
                title={refusal ?? undefined}
                onClick={() => enabled[i] && run(entry.id)}
              >
                <span className="sm-label">{entry.label}</span>
                {entry.hint && <span className="sm-hint">{entry.hint}</span>}
                {shortcut && <kbd className="sm-key">{shortcut}</kbd>}
              </button>
            )
          })}
        </Fragment>
      ))}
    </div>
  )
}
