import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { RuntimeState, Settings, Space, SplitGrid, SplitView, TabItem } from '@shared/model'
import { getLanguage } from '@shared/i18n'
import { SPLIT_GAP, balancePair, dividerKeyRatios, dividerValues, gridDividerValues, gridDividers, gridKeyShare, gridRoom, isGridCount, resizeRatios, resizeShare, splitBarRect, splitDividers, splitLayout, splitPaneStage, type GridAxis } from '@shared/split'
import { TOOLBAR_BAR_HEIGHT, type UiSnapshot } from '@shared/ipc'
import { DOCK_WIDTH, cardLeftUnderLights, cardRightGap, lightsRoom, toolbarLeading } from '@shared/frame-layout'
import { sidebarPlacement } from '@shared/window-sidebar'
import { isTranslucent, pageMargin, windowLookVars } from '@shared/window-look'
import { zoomMark } from '@shared/site-zoom'
import { resolveAppearance, themeVars } from '@shared/theme'
import { acceleratorKeys, effectiveAccelerator, formatAccelerator, toolbarKeys, type ToolbarKeys } from '@shared/keybindings'
import { showsNotesListButton } from '@shared/notes'
import { readableButtonMode, type ReadableMode } from '@shared/readable-mode'
import { targetLanguage } from '@shared/translate-local'
import { translateOffer, type TranslateOffer } from '@shared/translate-quick'
import { PLATFORM_FACTS, platformOf } from '@shared/platform'
import { api, useSnapshot } from './api'
import { Toolbar } from './Toolbar'
import { startDrag } from './drag'
import { SidePanelFrame } from './SidePanelFrame'
import { LockScreen } from './LockScreen'
import { spaceGlyph } from '@shared/space-icon'
import { SplitBar, SyncGlyph } from './SplitBar'
import { FLOATING, Sidebar } from './Sidebar'
import './window.css'
import './sidebar-right.css'
import { useSystemDark } from './system-dark'
import { useControlsOverlay } from './window-controls'
import { stripHoldsMenu, stripUnderControls } from '@shared/window-controls'
import './window-controls.css'

/**
 * The two dividers of a grid (shared/split.ts `gridDividers`): the column one sets the width of the left column, the row one the height of the top
 * row, for every pane at once. Dragged, or from the keyboard (← → for the columns, ↑ ↓ for the rows, Home, End, Enter); a double-click shares equally.
 */
function GridDividers({ split, grid, room, linked }: { split: SplitView; grid: SplitGrid; room: { width: number; height: number }; linked: boolean }) {
  const send = (axis: GridAxis, share: number) => void api().dispatch({ type: 'split/grid', id: split.id, column: axis === 'column' ? share : grid.column, row: axis === 'row' ? share : grid.row })
  return (
    <>
      {gridDividers(room, grid, split.tabIds.length, SPLIT_GAP, TOOLBAR_BAR_HEIGHT).map((d) => {
        const column = d.axis === 'column'
        const share = column ? grid.column : grid.row
        const values = gridDividerValues(share)
        return (
          <div
            key={d.axis}
            // The same splitter as between two panes: a column divider is a vertical line that moves sideways.
            className={`divider ${column ? 'horizontal' : 'vertical'}`}
            role="separator"
            tabIndex={0}
            aria-orientation={column ? 'vertical' : 'horizontal'}
            aria-label={t(column ? 'split-bar.redimensionner-les-colonnes' : 'split-bar.redimensionner-les-rangees')}
            aria-valuenow={values.now}
            aria-valuemin={values.min}
            aria-valuemax={values.max}
            aria-valuetext={t(column ? 'split-bar.valeur-des-colonnes' : 'split-bar.valeur-des-rangees', { a: values.first, b: values.second })}
            // Its grip sits in the middle of its first stretch: in 2 × 2 the two dividers cross in the middle.
            style={{ left: d.rect.x, top: d.rect.y, width: d.rect.width, height: d.rect.height, [column ? '--grip-y' : '--grip-x']: `${d.grip}px` } as CSSProperties}
            onPointerDown={(e) => {
              e.preventDefault()
              e.currentTarget.focus({ preventScroll: true })
              const origin = column ? e.clientX : e.clientY
              const available = gridRoom(room, d.axis, SPLIT_GAP, TOOLBAR_BAR_HEIGHT)
              startDrag((event) => {
                if (available <= 0) return
                send(d.axis, resizeShare(share, ((column ? event.clientX : event.clientY) - origin) / available))
              })
            }}
            onDoubleClick={() => send(d.axis, 0.5)}
            onKeyDown={(e) => {
              const next = gridKeyShare(share, e.key, d.axis, e.metaKey || e.ctrlKey || e.altKey)
              if (next === null) return
              e.preventDefault()
              send(d.axis, next)
            }}
          >
            {linked && (
              <span className="divider-sync" aria-hidden="true">
                <SyncGlyph size={12} />
              </span>
            )}
          </div>
        )
      })}
    </>
  )
}

/**
 * Drag handles in the gaps between the panes of a split view, and under the panes the layout bar of a split view of two. The panes
 * themselves are native views above this layer; the strip of the bar is the part of the stage they leave free.
 */
export function SplitDividers({ split, tabs, activeId, space, runtime, sidebarVisible, fullUrl, draggable, stageLeft, lights = true, controls = false, zoom, scrollSync, synced, annotate, notesList, keys, readable, translate }: { split: SplitView; tabs: TabItem[]; activeId: string | undefined; space: Space; runtime: RuntimeState; sidebarVisible: boolean; fullUrl: boolean; draggable: boolean; stageLeft: number | null; lights?: boolean; controls?: boolean; zoom: Pick<Settings, 'showZoomIndicator' | 'siteZoom'>; scrollSync: boolean; synced: boolean; annotate: boolean; notesList?: readonly string[]; keys?: ToolbarKeys | undefined; readable?: ReadableMode; translate?: TranslateOffer }) {
  const act = api()
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const horizontal = split.orientation === 'horizontal'
  // The shell lays the panes out in the same room: the stage less the strip of the bar (shared/split.ts).
  const room = splitPaneStage(size, split)
  const panes = splitLayout(room, split, undefined, TOOLBAR_BAR_HEIGHT)
  // A grid has its own two dividers, which each move a whole column or row.
  const grid = split.grid && isGridCount(split.tabIds.length) ? split.grid : null
  const dividers = grid ? [] : splitDividers(panes, split.orientation)
  const available = (horizontal ? room.width : room.height) - (horizontal ? SPLIT_GAP : SPLIT_GAP + TOOLBAR_BAR_HEIGHT) * (split.ratios.length - 1)
  const strip = splitBarRect(size, split)
  // Linked scrolling shows as a badge on the divider, but only while the setting that offers it is on.
  const linked = scrollSync && synced

  return (
    <div ref={ref} className="split-layer">
      {panes.map((pane, i) => {
        const tab = tabs.find((t) => t.id === split.tabIds[i])
        return (
          <Toolbar
            key={`${split.tabIds[i]}:${getLanguage()}`}
            space={space}
            current={tab}
            runtime={runtime}
            sidebarVisible={sidebarVisible}
            canSplit={false}
            fullUrl={fullUrl}
            draggable={draggable}
            // With the sidebar at the right the traffic lights are over the page card: the strip that starts under them keeps clear (a bar of a
            // lower row, in a stack or a grid, is not under them).
            leading={stageLeft === null || pane.y > 0 ? 0 : lightsRoom({ sidebarRight: true, x: stageLeft + pane.x, lights })}
            // Windows: the strip at the window's top left holds the button ☰, the one at the top right leaves the buttons of the system room (a strip of a lower row is under neither).
            menu={controls && stripHoldsMenu(pane)}
            underControls={controls && stripUnderControls(pane, room)}
            zoomMark={zoomMark(zoom, tab?.url)}
            // The panes' strips carry the button « Annoter » too (the focused one): the flag must reach them, or a split view has none.
            annotate={annotate}
            // And the button « Nouvelle note », for the page that has the focus.
            notesList={notesList} keys={keys}
            // And the button « Contraste de la page »: the mode of the page that has the focus (the strip of the focused pane draws it).
            readable={readable}
            // And the button « Traduction de la page », for the page that has the focus.
            translate={translate}
            pane={{
              // Side by side the bars share the row above the stage; stacked, each sits right above its own page.
              style: { left: pane.x, width: pane.width, right: 'auto', top: pane.y - TOOLBAR_BAR_HEIGHT },
              focused: tab?.id === activeId,
              onSelect: () => tab && void act.dispatch({ type: 'tab/select', id: tab.id }),
              onClose: () => tab && void act.dispatch({ type: 'split/remove', tabId: tab.id })
            }}
          />
        )
      })}
      {/* The ring is the focused card's own edge: the bar and the page, 2 px in (the shell insets that page by the same 2 px). */}
      {panes.map((pane, i) => (
        <div key={`ring-${split.tabIds[i]}`} className="pane-ring" style={{ left: pane.x, top: pane.y - TOOLBAR_BAR_HEIGHT, width: pane.width, height: pane.height + TOOLBAR_BAR_HEIGHT, visibility: split.tabIds[i] === activeId ? 'visible' : 'hidden' }} />
      ))}
      {dividers.map((d, i) => {
        const values = dividerValues(split.ratios, i)
        return (
          <div
            key={i}
            // A divider is a window splitter: it takes the keyboard (← → side by side, ↑ ↓ stacked), double-click shares equally, and a screen reader reads both shares.
            className={`divider ${split.orientation}`}
            role="separator"
            tabIndex={0}
            aria-orientation={horizontal ? 'vertical' : 'horizontal'}
            aria-label={t('split-bar.redimensionner-les-volets')}
            {...(values ? { 'aria-valuenow': values.now, 'aria-valuemin': values.min, 'aria-valuemax': values.max, 'aria-valuetext': t('split-bar.valeur-des-volets', { first: i + 1, second: i + 2, a: values.first, b: values.second }) } : {})}
            style={{ left: d.x, top: d.y, width: d.width, height: d.height }}
            onPointerDown={(e) => {
              e.preventDefault()
              e.currentTarget.focus({ preventScroll: true })
              const origin = horizontal ? e.clientX : e.clientY
              const startRatios = split.ratios
              startDrag((event) => {
                if (available <= 0) return
                const delta = ((horizontal ? event.clientX : event.clientY) - origin) / available
                void api().dispatch({ type: 'split/ratios', id: split.id, ratios: resizeRatios(startRatios, i, delta) })
              })
            }}
            onDoubleClick={() => void api().dispatch({ type: 'split/ratios', id: split.id, ratios: balancePair(split.ratios, i) })}
            onKeyDown={(e) => {
              const next = dividerKeyRatios(split.ratios, i, e.key, split.orientation, e.metaKey || e.ctrlKey || e.altKey)
              if (!next) return
              e.preventDefault()
              void api().dispatch({ type: 'split/ratios', id: split.id, ratios: next })
            }}
          >
            {linked && (
              <span className="divider-sync" aria-hidden="true">
                <SyncGlyph size={12} />
              </span>
            )}
          </div>
        )
      })}
      {grid && <GridDividers split={split} grid={grid} room={room} linked={linked} />}
      {strip && <SplitBar split={split} scrollSync={scrollSync} synced={synced} style={{ left: strip.x, top: strip.y, width: strip.width, height: strip.height }} />}
    </div>
  )
}

const EXTENSION_ID = /^[a-p]{32}$/

/**
 * A click on an extension icon of the toolbar opens that extension's side panel when it asked for it
 * (`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`). The click is caught before it reaches the
 * icon, so the extension does not also get an `action.onClicked` it never meant to handle.
 */
function useActionClickPanels(panelOnClick: Record<string, boolean> | undefined): void {
  const behavior = useRef(panelOnClick)
  behavior.current = panelOnClick
  useEffect(() => {
    const onClick = (event: globalThis.MouseEvent) => {
      const path = event.composedPath() as HTMLElement[]
      if (!path.some((el) => el.tagName === 'BROWSER-ACTION-LIST')) return
      const id = path.find((el) => typeof el.id === 'string' && EXTENSION_ID.test(el.id))?.id
      if (!id || behavior.current?.[id] !== true) return
      event.stopPropagation()
      event.preventDefault()
      api().openSidePanel(id)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])
}

export function App() {
  const snapshot = useSnapshot()
  const systemDark = useSystemDark()
  useActionClickPanels(snapshot?.state.sidePanelBehavior)
  if (!snapshot || snapshot.state.spaces.length === 0) return null
  // Locked, the window is the lock screen and nothing else (the state it was given is a skeleton). The floating sidebar's own surface stays empty.
  if (snapshot.lock?.appLocked) return FLOATING ? null : <LockScreen snapshot={snapshot} kind="app" systemDark={systemDark} />
  return <Shell snapshot={snapshot} systemDark={systemDark} />
}

function Shell({ snapshot, systemDark }: { snapshot: UiSnapshot; systemDark: boolean }) {
  const { state, runtime, sidePanel } = snapshot
  const act = api()
  // Windows: the buttons of the system lie over the window's top right and the window has no menu bar (window-controls.ts); false on every other system, and on the
  // floating copy of the sidebar, which is a surface of its own.
  const controls = useControlsOverlay(true)
  const lights = PLATFORM_FACTS[platformOf(snapshot.platform)].trafficLights
  const space = state.spaces.find((s) => s.id === state.activeSpaceId) ?? state.spaces[0]!
  const activeId = state.activeTabBySpace[space.id]
  const current = state.tabs.find((t) => t.spaceId === space.id && t.id === activeId)
  const activeSplit = current ? state.splits.find((sp) => sp.tabIds.includes(current.id)) : undefined
  const sidebarVisible = state.settings.sidebarVisible
  // A locked space shows its lock instead of its page, with no toolbar over it.
  const spaceLocked = snapshot.lock?.lockedSpaces.includes(space.id) === true
  const showToolbar = state.settings.showToolbar && !spaceLocked
  // The side and the shape of this window's sidebar: its own choice (« Barre de cette fenêtre »), else the setting, which is the side of new windows.
  const { right, docked } = sidebarPlacement(state.settings, snapshot.windowSidebar)
  const appearance = resolveAppearance(space.theme, systemDark)
  const style = { ...themeVars(space.theme, appearance), '--sidebar-width': `${docked ? DOCK_WIDTH : state.settings.sidebarWidth}px`, ...windowLookVars(state.settings) } as CSSProperties
  const margin = pageMargin(state.settings)
  // Classes only for a window that was changed: the default window has none of them.
  const look = `${isTranslucent(state.settings) ? ' translucent' : ''}${state.settings.cardOutline ? ' outlined' : ''}`
  const sidebar = <Sidebar snapshot={snapshot} space={space} />

  if (FLOATING) {
    // Kept out of the page while nothing floats: the hidden copy would otherwise draw the whole sidebar again at every snapshot.
    return (
      // The pointer is « in » the floating sidebar as long as it is over its view: the panel and the transparent margin around it (the 5 px of its inset, where a
      // pointer resting at the window's edge is, and its shadow). Only leaving the view lets the main process hide it (Browser.hotEdge).
      <div
        className={`shell floating-shell ${appearance} ${snapshot.floating ?? ''} ${right ? 'sidebar-right' : ''}`}
        style={style}
        onMouseEnter={() => act.hotEdge(true)}
        onMouseLeave={() => act.hotEdge(false)}
      >
        {snapshot.floating ? sidebar : null}
      </div>
    )
  }

  // The panel docked beside the page: an extension's side panel, or one of the sites of the space (a web panel). One at a time.
  const dock = sidePanel ? { name: sidePanel.name } : snapshot.webPanel ? { name: snapshot.webPanel.title } : null
  const panelWidth = state.settings.sidePanelWidth
  // The card gives up the window border (`margin`) on the side away from the sidebar, or the panel with a margin on each side of it; on the sidebar's side
  // it gives up nothing while the sidebar is shown (the sidebar is its neighbour) and the border while it is hidden.
  const outer = dock ? panelWidth + margin * 2 : margin
  const inner = sidebarVisible ? 0 : margin
  // Where the page card starts, in window coordinates, when the traffic lights are over its toolbar: the sidebar at the right, or docked to a column
  // at the left (the lights stay at the window's top left corner whatever the side of the column).
  const stageLeft = cardLeftUnderLights({ sidebarRight: right, docked, outer, lights })
  const leading = toolbarLeading({ sidebarRight: right, docked, outer, lights })
  // The buttons of the system start `--controls-w` from the window's right edge (window-controls.css); the card ends this far from it, so the toolbar leaves
  // the difference empty. In the style of the shell: the sidebar's row and the panel's header read it too.
  const cardGap = cardRightGap({ sidebarRight: right, sidebarVisible, docked, sidebarWidth: state.settings.sidebarWidth, outer, margin })
  const platform = platformOf(snapshot.platform)
  // The button « Toutes les notes », with the keys of File › Notes as they are set now; none in a private window.
  const notesList = showsNotesListButton(state.settings, snapshot.private === true) ? acceleratorKeys(effectiveAccelerator('notes', state.settings.keyBindings, platform), platform) : undefined
  const newTabKeys = effectiveAccelerator('newTab', state.settings.keyBindings, platform)
  // The keys the tooltips of the toolbar show: the shortcuts as they are set now.
  const keys = toolbarKeys(state.settings.keyBindings, platform)
  // The button « Contraste de la page »: the mode the page on screen has, none where it does not apply (a split view's focused pane is the page on screen).
  const readable = readableButtonMode(state.settings, current, snapshot.private === true, systemDark) ?? undefined
  // The button « Traduction de la page »: a web page in another language than the target, or translated (a private window translates too: it writes nothing).
  const translate = translateOffer(state.settings.translateLocal, current?.url, current ? runtime.tabs[current.id] : undefined, targetLanguage(state.settings, getLanguage())) ?? undefined

  return (
    <div className={`shell ${appearance}${look} ${right ? 'sidebar-right' : ''}`} style={controls ? ({ ...style, '--card-gap-right': `${cardGap}px` } as CSSProperties) : style}>
      {sidebar}
      {dock && (
        <SidePanelFrame lights={lights} name={dock.name} width={panelWidth} margin={margin} panelAtLeft={right} onClose={() => act.closeSidePanel()} onWidth={(sidePanelWidth) => void act.dispatch({ type: 'settings/update', patch: { sidePanelWidth } })} />
      )}
      <main
        className={`stage ${showToolbar || right || docked || controls ? 'with-toolbar' : ''}`}
        style={right ? { marginLeft: outer, marginRight: inner } : { marginLeft: inner, marginRight: outer }}
      >
        {/* Windows, toolbar hidden: the strip above the card is bare, and it drags the window (window-controls.css). */}
        {controls && !showToolbar && !activeSplit && <div className="stage-strip" aria-hidden="true" />}
        {showToolbar && !activeSplit && (
          <Toolbar key={getLanguage()} space={space} current={current} runtime={runtime} sidebarVisible={sidebarVisible} fullUrl={state.settings.fullUrlInToolbar} draggable={state.settings.dragWindowFromToolbar} zoomMark={zoomMark(state.settings, current?.url)} canSplit={!!current} sidebarRight={right} leading={leading} menu={controls} underControls={controls} badges={state.settings.tabStateBadges} annotate={snapshot.annotateEnabled === true} notesList={notesList} keys={keys} readable={readable} translate={translate} />
        )}
        {activeSplit && (
          <SplitDividers split={activeSplit} tabs={state.tabs} activeId={current?.id} space={space} runtime={runtime} sidebarVisible={sidebarVisible} fullUrl={state.settings.fullUrlInToolbar} draggable={state.settings.dragWindowFromToolbar} stageLeft={stageLeft} lights={lights} controls={controls} zoom={state.settings} scrollSync={state.settings.scrollSync} synced={snapshot.scrollSyncedSplits?.includes(activeSplit.id) === true} annotate={snapshot.annotateEnabled === true} notesList={notesList} keys={keys} readable={readable} translate={translate} />
        )}
        {spaceLocked && <LockScreen snapshot={snapshot} kind="space" space={space} systemDark={systemDark} />}
        {/* The page of the tab is in Lucium's floating window: its place says so, and brings the video back or the window to the front. */}
        {current && !spaceLocked && !activeSplit && runtime.tabs[current.id]?.floating === true && (
          <div className="empty floating-away" role="status">
            <p>{t('app.la-video-de-cet-onglet-flotte')}</p>
            <div className="floating-away-actions">
              <button type="button" onClick={() => act.floatingVideoTab(current.id, 'back')}>
                {t('app.ramener-la-video-ici')}
              </button>
              <button type="button" onClick={() => act.floatingVideoTab(current.id, 'show')}>
                {t('app.montrer-la-fenetre')}
              </button>
            </div>
          </div>
        )}
        {!current && !spaceLocked && (
          <div className="empty">
            <h1>
              {spaceGlyph(space)} {space.name}
            </h1>
            {/* The key that opens a tab, as it is set now; no line for a command left without a shortcut. */}
            {newTabKeys && <p>{t('app.t-pour-ouvrir-un-onglet', { keys: formatAccelerator(newTabKeys, platform) })}</p>}
          </div>
        )}
      </main>
    </div>
  )
}

import { t } from '@shared/i18n'
