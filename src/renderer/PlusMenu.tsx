import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  initialPlusSelection,
  plusEntryEnabled,
  plusGroups,
  plusEntryRefusal,
  plusMenuPlacement,
  plusShortcut,
  stepPlusSelection,
  type PlusAnchor,
  type PlusEntryId
} from '@shared/plus-menu'
import { activeTab } from '@shared/sidebar'
import { platformOf } from '@shared/platform'
import { themeHue } from '@shared/theme'
import { hostnameOf } from '@shared/url'
import { api, useSnapshot } from './api'
import './plus-menu.css'

const GLYPH = { viewBox: '0 0 22 22', width: 22, height: 22, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

// The pictograms are drawn here: outlines of 22 x 22, as light as the rest of the sidebar's.
const GLYPHS: Record<PlusEntryId, string[]> = {
  // Two cards, one behind the other, with a plus on the front one.
  space: ['M6.500 6V5.300a2.300 2.300 0 0 1 2.300-2.300h8.400a2.300 2.300 0 0 1 2.300 2.300v8.400a2.300 2.300 0 0 1-2.300 2.300H16.500', 'M5.100 6.500h7.800a2.100 2.100 0 0 1 2.100 2.100v8.800a2.100 2.100 0 0 1-2.100 2.100H5.100A2.100 2.100 0 0 1 3 17.400V8.600a2.100 2.100 0 0 1 2.100-2.100Z', 'M9 10.600v5.200M6.400 13.200h5.200'],
  folder: ['M2.500 6.800a2 2 0 0 1 2-2h3.700l2 2.300h7.300a2 2 0 0 1 2 2v7.100a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z'],
  // A brush: its handle, then the head and the paint it holds.
  boost: ['M12.600 11.700 18.500 5.800a1.500 1.500 0 0 0 0-2.100l-.2-.2a1.500 1.500 0 0 0-2.100 0L10.300 9.400', 'M9.800 9.900l2.300 2.300c-.4 2.800-2.500 5.100-6 5.100-.8 0-1.500-.1-2.100-.3 1-.6 1.400-1.500 1.400-2.400.1-1.900 1.300-3.800 4.400-4.700Z'],
  // Two panes, the wide one with a mark of a tile: a work view, made from nothing.
  workview: ['M4.500 4.500h7v13h-7a1.500 1.500 0 0 1-1.500-1.500V6a1.500 1.500 0 0 1 1.500-1.500Z', 'M14.500 4.500h3A1.500 1.500 0 0 1 19 6v10a1.500 1.500 0 0 1-1.500 1.500h-3Z', 'M6 8.500h3.500M6 11h3.500'],
  // A frame cut by a vertical line, with a plus in the new half.
  split: ['M5.500 3.500h11A2.500 2.500 0 0 1 19 6v10a2.500 2.500 0 0 1-2.500 2.500h-11A2.500 2.500 0 0 1 3 16V6a2.500 2.500 0 0 1 2.500-2.500Z', 'M9.500 3.500v15', 'M14.200 8.800v4.400M12 11h4.400']
}

const Glyph = ({ id }: { id: PlusEntryId }) => (
  <svg {...GLYPH}>
    {GLYPHS[id].map((d) => (
      <path key={d} d={d} />
    ))}
  </svg>
)

/**
 * The popover of the + at the foot of the sidebar: a card that opens upwards, its right edge on the button's,
 * with a space, a folder, a Tweak or a split view to create. The last row is preselected; the pointer and the arrows move the choice,
 * Return takes it, Escape (and a click outside, handled by the host) closes the card. The chosen row has the focus, so a screen reader
 * reads it as the arrows move; the other rows are out of the tab order (one stop for the menu).
 */
export function PlusMenu({ anchor }: { anchor: PlusAnchor }) {
  const snapshot = useSnapshot()
  const act = api()
  const [picked, setPicked] = useState<number | null>(null)
  const state = snapshot?.state
  const tab = state ? activeTab(state) : undefined
  const context = { tabUrl: tab?.url ?? null, spaceLocked: state !== undefined && snapshot?.lock?.lockedSpaces.includes(state.activeSpaceId) === true, workViews: state?.settings.workViewsEnabled === true }
  const groups = plusGroups(context)
  const entries = groups.flat()
  const enabled = entries.map((entry) => plusEntryEnabled(entry.id, context))
  const selected = picked ?? initialPlusSelection(enabled)
  const rows = useRef<Array<HTMLButtonElement | null>>([])
  const drawn = state !== undefined
  useEffect(() => {
    if (drawn) rows.current[selected]?.focus({ preventScroll: true })
  }, [drawn, selected])

  const run = (id: PlusEntryId) => {
    if (!state) return
    switch (id) {
      case 'space':
        return act.openOverlay({ panel: 'spacecreate' })
      case 'folder':
        act.closeOverlay()
        return void act.dispatch({ type: 'folder/create', name: t('menu.nouveau-dossier-2'), spaceId: state.activeSpaceId })
      case 'boost':
        return act.openOverlay({ panel: 'boost', host: hostnameOf(tab?.url ?? '') })
      case 'split':
        return act.openOverlay({ panel: 'commandbar', mode: 'split', initial: '' })
      case 'workview':
        return act.openOverlay({ panel: 'workview', full: true })
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return act.closeOverlay()
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const next = stepPlusSelection(enabled, selected, e.key === 'ArrowDown' ? 1 : -1)
        if (next >= 0) setPicked(next)
      } else if (e.key === 'Enter' && selected >= 0) {
        e.preventDefault()
        run(entries[selected]!.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!state) return null
  const space = state.spaces.find((s) => s.id === state.activeSpaceId)
  const placement = plusMenuPlacement(anchor, { height: window.innerHeight })
  // The card is almost black and takes a hint of the space's colour (#020303 on a green space).
  const style = { right: `calc(100% - ${placement.rightEdge}px)`, bottom: placement.bottom, '--hue': String(space ? themeHue(space.theme) : 220) } as CSSProperties

  let index = -1
  return (
    <div className="plus-menu" role="menu" aria-label={t('sidebar.nouveau-2')} style={style}>
      {groups.map((group, g) => (
        <Fragment key={g}>
          {g > 0 && <div className="plus-separator" role="separator" />}
          {group.map((entry) => {
            const i = ++index
            const shortcut = plusShortcut(entry, state.settings.keyBindings, platformOf(snapshot?.platform))
            // A row the lock greys out says why under the pointer.
            const refusal = plusEntryRefusal(entry.id, context)
            return (
              <button
                key={entry.id}
                ref={(row) => void (rows.current[i] = row)}
                role="menuitem"
                tabIndex={selected === i ? 0 : -1}
                className={`plus-row ${selected === i ? 'selected' : ''}`}
                data-entry={entry.id}
                // Not `disabled`: a disabled button swallows the pointer, and the click would fall through to the host.
                aria-disabled={!enabled[i]}
                title={refusal ?? undefined}
                onMouseMove={() => enabled[i] && selected !== i && setPicked(i)}
                onClick={() => enabled[i] && run(entry.id)}
              >
                <span className="plus-icon">
                  <Glyph id={entry.id} />
                </span>
                <span className="plus-label">{entry.label}</span>
                {shortcut && <span className="plus-key">{shortcut}</span>}
              </button>
            )
          })}
        </Fragment>
      ))}
      <svg className="plus-arrow" width="30" height="9" viewBox="0 0 30 9" aria-hidden="true">
        <path d="M0 0C7 0 9.500 9 15 9s8-9 15-9Z" fill="currentColor" />
      </svg>
    </div>
  )
}

import { t } from '@shared/i18n'