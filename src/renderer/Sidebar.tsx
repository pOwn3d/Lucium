// The sidebar: toolbar corner, favourites, the space header, pinned tabs and folders, Today, the media player, toasts and the
// footer (downloads, spaces, "+").

import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { isListedTab, type Folder, type Space, type TabItem } from '@shared/model'
import { NO_DROP, canDrop, draggedIds, planDrop, showsFolderBottomZone, type DragSource, type DropPlan, type Located } from '@shared/dnd'
import { sideOfFolder } from '@shared/folders'
import { NO_SELECTION, clickSelection, pruneSelection, selectedInOrder, tabStop, type Selection } from '@shared/selection'
import { stepSpace, visibleTabOrder } from '@shared/sidebar'
import { splitRows, type DrawnList } from '@shared/split-place'
import { SWIPE_IDLE, swipeStep } from '@shared/space-swipe'
import { tabStep } from '@shared/tab-step'
import { TIDY_GROUP_MIN, tidyCandidates } from '@shared/tab-grouping'
import { favoritesOfSpace } from '@shared/favorite-scope'
import { shownWorkViews } from '@shared/work-views'
import { isCompact } from '@shared/compact'
import { foldedAway, treeRows } from '@shared/tab-tree'
import { CONNECTION_MARKS, addressLabel, connectionState, hostOf } from '@shared/url'
import { displayAddress } from '@shared/internal-page'
import { sidebarLeft } from '@shared/frame-layout'
import { actionListKey } from '@shared/extension-overflow'
import { acceleratorKeys, effectiveAccelerator, formatAccelerator } from '@shared/keybindings'
import { platformOf } from '@shared/platform'
import { sidebarPlacement } from '@shared/window-sidebar'
import { stepSpaceTab } from '@shared/space-menu'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import { api } from './api'
import { useNoticeHold } from './notice-hold'
import { rectOf } from './anchor'
import { FoldSidebarIcon, ReloadAllIcon, ReloadSpaceIcon, SidebarIcon } from './Toolbar'
import { DockedSidebar } from './DockedSidebar'
import { HostText } from './HostText'
import { menuCloseAction } from '@shared/tab-close'
import { tipProps } from './tooltip'
import { ResizeHandle } from './SidebarResizeHandle'
import { HoverCard, useHoverCard, type CardAction } from './HoverCard'
import { backgroundFileToRead, backgroundObjectPosition, backgroundVideoOnChoice, backgroundVideoOnView, veilIsDark, videoBackgroundPaused, type SpaceBackground } from '@shared/space-media'
import { useSystemReducedMotion } from './reduced-motion'
import { BackgroundVideoControls } from './BackgroundVideoControls'
import { DRAG_FAVORITE_TYPE, DRAG_FOLDER_TYPE, DRAG_TYPE, locateInFavorites, locateInFolders, locateInList, setDragGhost } from './sidebar-dnd'
import { ArchiveBoxGlyph, ChevronDownGlyph, PlusGlyph, ReadLaterGlyph, TidyGlyph } from './sidebar-icons'
import { FooterDownloads } from './DownloadStatus'
import { FooterResources } from './ResourcePanel'
import { MediaPlayers } from './MediaPlayer'
import { AppMenuButton } from './AppMenuButton'
import { SpaceMark } from './SpaceMark'
import { useControlsOverlay } from './window-controls'
import { LiveItems } from './LiveRows'
import { WorkViewTiles } from './WorkViewTiles'
import { Favicon, FolderBlock, Section, SidebarUiContext, SplitRow, TabRow, markClass, useStableUi, type SidebarUi } from './SidebarRows'
import { getLanguage, t, tp } from '@shared/i18n'
import { reloadButtonBusy, reloadButtonBusyLabel, type ReloadRunView } from '@shared/reload-all'
import { proxyMarkedTabs } from '@shared/proxy-mark'
import './sidebar.css'
import './sidebar-interactions.css'
import './sidebar-states.css'
import './space-image.css'
import './tabs-ui.css'

/** The floating copy of the sidebar (shown over the page while the real one is hidden) is loaded with `#float`. */
export const FLOATING = typeof location !== 'undefined' && location.hash === '#float'
/** A dragged tab hovering a collapsed folder opens it after this long, to drop into it. */
const FOLDER_OPEN_DELAY_MS = 700
/** Dragover repeats while the pointer is over a target: when it stops, the pointer has left and the mark goes. */
const MARK_IDLE_MS = 400

/** Whether the list runs under the footer: only then does the footer draw the line that marks the edge of the list. */
function useScrolls(list: React.RefObject<HTMLDivElement | null>, content: React.RefObject<HTMLDivElement | null>): boolean {
  const [scrolls, setScrolls] = useState(false)
  useEffect(() => {
    const box = list.current
    const inner = content.current
    if (!box || !inner) return
    const measure = () => setScrolls(inner.offsetHeight > box.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [list, content])
  return scrolls
}

/** The sidebar slides out to the left in about 0.1 s when it is hidden, and back in when it is shown (ease-out; the page card slides with it). */
export const SIDEBAR_SLIDE_MS = 110

/**
 * Holds the sidebar: it stays in the page while it slides away, and goes once it has; a strip at the left edge takes its place and
 * opens the floating copy. Nothing is animated when the page opens, or when the system asks for less motion (the CSS sees to that).
 */
function SidebarSlot({ visible, children }: { visible: boolean; children: ReactNode }) {
  const act = api()
  const [mounted, setMounted] = useState(visible)
  const [open, setOpen] = useState(visible)
  const [sliding, setSliding] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    setSliding(true)
    const settled = setTimeout(() => setSliding(false), SIDEBAR_SLIDE_MS + 60)
    if (visible) {
      setMounted(true)
      // Two frames: the sidebar must have been painted out of the way for the slide in to have somewhere to start from.
      let second = 0
      const firstFrame = requestAnimationFrame(() => (second = requestAnimationFrame(() => setOpen(true))))
      return () => {
        clearTimeout(settled)
        cancelAnimationFrame(firstFrame)
        cancelAnimationFrame(second)
      }
    }
    setOpen(false)
    const timer = setTimeout(() => setMounted(false), SIDEBAR_SLIDE_MS + 40)
    return () => {
      clearTimeout(settled)
      clearTimeout(timer)
    }
  }, [visible])
  return (
    <>
      {mounted && <div className={`sidebar-slot ${open ? 'open' : ''} ${sliding ? 'sliding' : ''}`}>{children}</div>}
      {!mounted && <div className="hot-edge" onMouseEnter={() => act.hotEdge(true)} />}
    </>
  )
}

/**
 * The sidebar of the window, at its side (this window's own choice, else the setting: `sidebarPlacement`). A window that docked it shows the column of site
 * icons (« barre collée », DockedSidebar.tsx) in its place while the sidebar is shown; the floating copy is always the full sidebar.
 */
export function Sidebar({ snapshot, space }: { snapshot: UiSnapshot; space: Space }) {
  const { right, docked } = sidebarPlacement(snapshot.state.settings, snapshot.windowSidebar)
  if (FLOATING) return <SidebarBody snapshot={snapshot} space={space} right={right} />
  return (
    <SidebarSlot visible={snapshot.state.settings.sidebarVisible}>
      {docked ? <DockedSidebar snapshot={snapshot} space={space} right={right} /> : <SidebarBody snapshot={snapshot} space={space} right={right} />}
    </SidebarSlot>
  )
}

function useSpaceBackgroundMedia(background: Space['background'], drawn: boolean) {
  const [src, setSrc] = useState<string | null>(null)
  const filename = backgroundFileToRead(background, drawn)
  const type = drawn ? background?.type : undefined
  useEffect(() => {
    if (filename === null) {
      setSrc(null)
      return
    }
    let live = true
    // The blob URL of the bytes read is released when the background changes or the sidebar goes.
    let url: string | null = null
    void api()
      .spaceBackgroundMedia({ op: 'read', filename })
      .then((reply) => {
        if (!live || !reply.ok || !reply.data) return setSrc(null)
        url = URL.createObjectURL(new Blob([reply.data], { type: reply.mimeType ?? '' }))
        setSrc(url)
      })
      .catch((error: unknown) => {
        console.warn('[sidebar background] cannot read space background:', error)
        if (live) setSrc(null)
      })
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [type, filename])
  return src
}

/** Whether the window has the focus, as the main process tells it (at once if it has already, else once the page has loaded); the video starts by itself until then. */
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true)
  useEffect(() => api().onWindowFocus(setFocused), [])
  return focused
}

/**
 * The video behind a space: it pauses while the window is hidden, so a sidebar nobody sees costs no decoding. The pause of the space (its Pause / Lire
 * control, remembered per space) holds it still whatever the window does, and under reduced motion (the system's or Lucium's) it is still until the
 * user plays it (`videoBackgroundPaused`, space-media.ts). A click on « Lire » resumes it at once. `saving`: the battery saver is on, which holds it
 * still whatever the space says, until the mode ends.
 */
export function BackgroundVideo({ src, choice, forceReduceMotion, saving = false }: { src: string; choice: SpaceBackground; forceReduceMotion: boolean; saving?: boolean }) {
  const video = useRef<HTMLVideoElement>(null)
  const paused = videoBackgroundPaused(choice, useSystemReducedMotion() || forceReduceMotion)
  useEffect(() => {
    const element = video.current
    if (!element) return
    // The choice of the space: held still, or played again at once after a click on « Lire » (made in a panel, so the sidebar has not the focus then).
    // It runs when the choice changes only: the battery saver coming on or going off is the business of the effect below, which knows the focus too.
    const step = backgroundVideoOnChoice(paused, { hidden: document.hidden, videoPaused: element.paused, saving })
    if (step === 'pause') element.pause()
    else if (step === 'play') void element.play().catch((error: unknown) => console.warn('[sidebar] the background video could not play:', error))
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs when the choice changes only; the battery saver is the business of the next effect
  }, [paused])
  const playUnfocused = choice.playUnfocused === true
  const windowFocused = useWindowFocused()
  useEffect(() => {
    // Paused while the window is hidden or another window is in front: nobody is looking at the background then. Unless its space keeps it playing behind
    // other windows (« Toujours lire », above the footer); a hidden window still stops it. A click in a page of the window changes nothing: the window keeps
    // the focus, and the main process tells it (main/shell/window-focus.ts), where the sidebar's own document would say it lost it.
    const onVisibility = () => {
      const element = video.current
      if (!element) return
      const step = backgroundVideoOnView({ hidden: document.hidden, focused: windowFocused, saving }, paused, playUnfocused)
      if (step === 'pause') element.pause()
      else if (step === 'play') void element.play().catch((error: unknown) => console.warn('[sidebar] the background video could not resume:', error))
    }
    document.addEventListener('visibilitychange', onVisibility)
    // The focus or the choice changed: it applies at once.
    onVisibility()
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [paused, playUnfocused, windowFocused, saving])
  // The part of the video the space chose to show (the frame of the Fond panel); without one the stylesheet's centre holds.
  const objectPosition = backgroundObjectPosition(choice)
  return <video ref={video} src={src} autoPlay={!paused && !saving} muted loop playsInline style={objectPosition ? { objectPosition } : undefined} />
}

function SpaceBackgroundLayer({ space, className = 'space-background', enabled = true, forceReduceMotion = false, saving = false }: { space: Space; className?: string; enabled?: boolean; forceReduceMotion?: boolean; saving?: boolean }) {
  const background = space.background
  // A layer that is not drawn (the footer's buttons) does not load its picture or video: the file is read only when it shows.
  const src = useSpaceBackgroundMedia(background, enabled)
  if (!enabled || !background) return null
  const style = background.type === 'color' ? { backgroundColor: background.value } : background.veil !== undefined ? ({ '--veil': `${background.veil}%` } as CSSProperties) : undefined
  // The text of the tabs: the space's choice (Clair / Sombre), else the one that reads over the veil colour, else the theme's.
  const text = background.tone && background.tone !== 'auto' ? background.tone : background.veilColor ? (veilIsDark(background.veilColor) ? 'light' : 'dark') : 'auto'
  return (
    <span className={`${className} ${background.type} ${background.veilColor ? 'veil' : ''} ${background.veilColor && background.veilShape === 'text' ? 'veil-text' : ''} text-${text}`} style={background.veilColor ? ({ ...(style ?? {}), '--veil-color': background.veilColor } as CSSProperties) : style} aria-hidden="true">
      {/* macOS « Réduire les animations » (or Lucium's): the video of a space is not started by itself, unless the user played it. */}
      {background.type === 'video' && src ? <BackgroundVideo src={src} choice={background} forceReduceMotion={forceReduceMotion} saving={saving} /> : null}
      {(background.type === 'image' || background.type === 'gif') && src ? <img src={src} alt="" draggable={false} /> : null}
    </span>
  )
}

/** How far a job is, from 0 to 1, for the bar of its notice or of its button. */
export function progressShare(progress: { done: number; total: number }): number {
  if (!(progress.total > 0)) return 0
  return Math.min(1, Math.max(0, progress.done / progress.total))
}

/** What a notice of the sidebar asks of the window: the buttons it carries, its pause and its end (`LuciumApi` has them all). */
export type ToastActions = Pick<LuciumApi, 'toastHold' | 'toastDismiss' | 'toastAction'>

/**
 * The notice at the foot of the sidebar. Its time is the main process's (shared/toast.ts: 5 s, 8 s with an action, longer when the caller asked), and the
 * clock waits while the pointer or the focus is on it: they are kept apart (the rule of every notice with an action, renderer/notice-hold.ts), so that the
 * pointer leaving a notice that still has the focus does not start it again. It closes with its ✕ or Escape. The line under it shows the time (the CSS stops it
 * on :hover and :focus-within, as the clock does). One component for each notice (`key`): what held the one before does not hold the next.
 */
export function SidebarToast({ toast, act }: { toast: NonNullable<UiSnapshot['toast']>; act: ToastActions }) {
  const hold = useNoticeHold((held) => act.toastHold(toast.id, held))
  return (
    <div className={`toast ${toast.secondAction ? 'has-second' : ''}`} style={{ '--toast-ms': `${toast.durationMs}ms` } as CSSProperties} {...hold} onKeyDown={(e) => e.key === 'Escape' && act.toastDismiss(toast.id)}>
      <span className="toast-text">
        {toast.message}
        {toast.detail && <span className="toast-detail">{toast.detail}</span>}
      </span>
      {toast.action && (
        <button className="toast-action" onClick={() => act.toastAction(toast.id)}>
          {toast.action}
        </button>
      )}
      {toast.secondAction && (
        <button className="toast-action" onClick={() => act.toastAction(toast.id, true)}>
          {toast.secondAction}
        </button>
      )}
      <button className="toast-close" aria-label={t('translate.close')} onClick={() => act.toastDismiss(toast.id)}>
        <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.600" strokeLinecap="round" aria-hidden="true">
          <path d="m2.500 2.500 7 7m0-7-7 7" />
        </svg>
      </button>
      {/* A job that goes on fills a bar in place of the time line (the words above say the same, for a screen reader). */}
      {toast.progress ? (
        <span className="toast-progress" aria-hidden="true" style={{ '--toast-progress': progressShare(toast.progress) } as CSSProperties} />
      ) : (
        <span className="toast-timer" aria-hidden="true" />
      )}
    </div>
  )
}

/**
 * A button of « Actualiser tous les onglets ». `run`: its run goes on; the button says so (`busy`, its name says how far and that a click offers to
 * stop it), turns its icon and fills the bar under it.
 */
export function ReloadButton({ className, label, run, onClick, children }: { className: string; label: string; run: ReloadRunView | undefined; onClick: () => void; children: ReactNode }) {
  const name = run ? reloadButtonBusyLabel(run) : label
  return (
    <button className={run ? `${className} busy` : className} title={name} aria-label={name} onClick={onClick} style={run ? ({ '--reload-progress': progressShare(run) } as CSSProperties) : undefined}>
      {children}
    </button>
  )
}

function SidebarBody({ snapshot, space, right }: { snapshot: UiSnapshot; space: Space; right: boolean }) {
  const { state, runtime, downloads, toast } = snapshot
  const act = api()
  // The buttons of a hover card: the same actions as the row's menu, and the card closes after them.
  const cardAction = (tab: TabItem, action: CardAction) => {
    if (action === 'pin') void act.dispatch({ type: tab.pinned ? 'tab/unpin' : 'tab/pin', id: tab.id })
    else if (action === 'sleep') act.sleepTab(tab.id)
    else if (action === 'close') void act.dispatch(menuCloseAction(tab))
    else void navigator.clipboard.writeText(displayAddress(tab.url)).catch((error: unknown) => console.warn('[hover card] the address could not be copied:', error))
    hover.hide()
  }

  // Interface state, never saved: which tabs are selected, what is being dragged and where it would land.
  const [selection, setSelection] = useState<Selection>(NO_SELECTION)
  const [drag, setDrag] = useState<DragSource | null>(null)
  // Tabs another window is dragging (the main process tells: the data of a drag is not trusted). The drag we dismissed (a press or a key after it ended) is not shown again.
  const [dismissedDrag, setDismissedDrag] = useState(0)
  const [foreignOver, setForeignOver] = useState(false)
  const [mark, setMark] = useState<Located | null>(null)
  const markKey = useRef('')
  const markTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const foreign = snapshot.foreignDrag !== undefined && snapshot.foreignDrag.token !== dismissedDrag ? snapshot.foreignDrag : null
  const hover = useHoverCard()
  const list = useRef<HTMLDivElement>(null)
  const listContent = useRef<HTMLDivElement>(null)
  const scrolls = useScrolls(list, listContent)
  const spacesRow = useRef<HTMLDivElement>(null)

  const tabs = state.tabs.filter((t) => t.spaceId === space.id)
  // The page of a favourite is not a row: its tile stands for it.
  const listed = tabs.filter(isListedTab)
  const pinned = listed.filter((t) => t.pinned)
  const today = listed.filter((t) => !t.pinned)
  const folders = state.folders.filter((f) => f.spaceId === space.id)
  const activeId = state.activeTabBySpace[space.id]
  const current = tabs.find((t) => t.id === activeId)
  // The favourites of this space's profile: another profile's are not on this row.
  const favorites = favoritesOfSpace(state, space.id)
  // The work views of this profile: their tiles come after the favourites, in the same grid (none in a private window, whose state keeps none).
  const workViews = shownWorkViews(state, space.id)
  const isFavorite = !!current && favorites.some((f) => f.url === current.url)
  // What is being dragged over this list: its own rows, or tabs of another window (which land in the space shown here).
  const active: DragSource | null = drag ?? (foreign ? { kind: 'window-tabs', tabs: foreign.tabs, spaceId: space.id } : null)
  const splitTabIds = new Set(state.splits.flatMap((sp) => sp.tabIds))
  const sidebarVisible = state.settings.sidebarVisible
  const showToolbar = state.settings.showToolbar
  // Windows: the window has no menu bar, and with the toolbar hidden the button ☰ lives in the first row of the sidebar.
  const controls = useControlsOverlay()
  const isMac = snapshot.platform === 'darwin'
  // The keys of ⌃⌘S (« Coller ou déplier la barre latérale »), as the user set them, for the bubble of « Plier la barre ».
  const platform = platformOf(snapshot.platform)
  const dockKeys = acceleratorKeys(effectiveAccelerator('dockSidebar', state.settings.keyBindings, platform), platform)
  // The tab tree (off: none of this is computed and the rows are the default ones): how the Today rows are drawn, and the ones a folded branch hides.
  const tree = state.settings.tabTree
  const treeInfo = tree ? treeRows(today) : null
  const folded = tree ? foldedAway(today) : null
  const shownToday = folded && folded.size > 0 ? today.filter((t) => !folded.has(t.id)) : today
  // A normal window with private tabs: they go last, under their own title (not with the tab tree, whose order is its own; not in a private window, which is all private).
  const groupPrivate = !tree && !snapshot.private && shownToday.some((t) => t.private === true) && shownToday.some((t) => t.private !== true)
  const todayNormal = groupPrivate ? shownToday.filter((t) => t.private !== true) : shownToday
  const todayPrivate = groupPrivate ? shownToday.filter((t) => t.private === true) : []
  const firstToday = groupPrivate ? todayNormal[0] ?? todayPrivate[0] : today[0]
  // Mode compact, in the floating sidebar (the real one is hidden then): the tab on screen is the address.
  const compact = FLOATING && isCompact(state.settings)

  // The rows on screen, top to bottom: a ⇧-click ranges over these, not over tabs hidden in a collapsed folder.
  const order = visibleTabOrder(state, space.id).map((t) => t.id)
  // The address takes the place of the tab on screen only when that tab has a row of its own on screen (not in a split view, a closed folder or a folded branch): else the bar stays.
  const addressRow = compact && current !== undefined && order.includes(current.id) && !splitTabIds.has(current.id)
  const live = pruneSelection(selection, new Set(order))
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- checked after every draw on purpose; it sets the state only when the selection lost a row
  useEffect(() => {
    if (live !== selection) setSelection(live)
  })
  // A row moved with ⌥↑ / ⌥↓ keeps the focus once the list shows it in its new place: the list may take the row out of the document to put it back, which drops
  // the focus. A move that never comes (refused) is forgotten after a second.
  const refocus = useRef<{ id: string; from: string; until: number } | null>(null)
  useEffect(() => {
    const wanted = refocus.current
    if (!wanted) return
    if (Date.now() > wanted.until) refocus.current = null
    else if (order.join() !== wanted.from) {
      refocus.current = null
      list.current?.querySelector<HTMLElement>(`.tab[data-id="${wanted.id}"] > .tab-main`)?.focus()
    }
  })
  useEffect(() => {
    if (live.ids.length === 0) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setSelection(NO_SELECTION)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [live.ids.length])

  // The row of spaces is 239 px wide and shows about seven: with more, the one that becomes current (created, picked by a shortcut) must not stay out of view.
  useEffect(() => {
    spacesRow.current?.querySelector<HTMLElement>('.space.current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [space.id, state.spaces.length])

  // Two fingers across the list of tabs go to the space before or after, one per gesture (setting `spaceSwipe`, rules: space-swipe.ts), with the step the
  // menu and the keys take (`stepSpace`). Only the list listens: the row of spaces keeps its own sideways scrolling. No listener at all while the setting is
  // off, in a private window (a single space) or with a single space; a passive one otherwise, so that the list scrolls as it always did.
  const swipeLive = state.settings.spaceSwipe && !snapshot.private && state.spaces.length > 1
  const swipeNow = useRef({ state, privateWindow: snapshot.private === true, busy: false })
  swipeNow.current = { state, privateWindow: snapshot.private === true, busy: drag !== null || foreign !== null }
  useEffect(() => {
    const box = list.current
    if (!box || !swipeLive) return
    let tracker = SWIPE_IDLE
    const onWheel = (event: WheelEvent) => {
      // A field of the list (a tab being renamed) scrolls its own text.
      if (event.target instanceof Element && event.target.closest('input, textarea')) return
      const now = swipeNow.current
      const outcome = swipeStep(tracker, event, { enabled: now.state.settings.spaceSwipe, privateWindow: now.privateWindow, spaceCount: now.state.spaces.length, busy: now.busy })
      tracker = outcome.tracker
      const id = outcome.step === 0 ? null : stepSpace(now.state, outcome.step)
      if (id) void act.dispatch({ type: 'space/select', id })
    }
    box.addEventListener('wheel', onWheel, { passive: true })
    return () => box.removeEventListener('wheel', onWheel)
  }, [swipeLive, act])

  // ---- drag and drop ----

  const updateMark = (next: Located | null) => {
    if (markTimer.current) clearTimeout(markTimer.current)
    markTimer.current = next ? setTimeout(() => updateMark(null), MARK_IDLE_MS) : null
    const key = next ? `${next.at}|${next.edge}` : ''
    if (key === markKey.current) return
    markKey.current = key
    setMark(next)
  }
  // Whether the page was told about this drag (a tab row dragged alone, with the setting on): it shows where a split view would put the tab.
  const toldPage = useRef(false)
  const releasePage = () => {
    if (!toldPage.current) return
    toldPage.current = false
    act.splitDrag('end')
  }
  // Whether the main process was told about this drag (tab rows): the other windows take a drop of it until it ends.
  const toldWindows = useRef(false)
  const releaseWindows = () => {
    if (!toldWindows.current) return
    toldWindows.current = false
    act.tabDrag('end')
  }
  const endDrag = () => {
    updateMark(null)
    setDrag(null)
    releasePage()
    releaseWindows()
  }
  const runPlan = (plan: DropPlan) => {
    for (const action of plan.actions) void act.dispatch(action)
    if (plan.moveToSpace) act.moveTabsToSpace(plan.moveToSpace.ids, plan.moveToSpace.spaceId)
    if (plan.fromWindow) act.dropWindowTabs(plan.fromWindow)
  }
  /** Shows the mark where a drop at `found` would land, and lets the browser accept the drop there. Returns whether it would. */
  const hoverTarget = (event: DragEvent, found: Located | null): boolean => {
    const plan = active && found ? planDrop(state, active, found.target) : NO_DROP
    if (!found || !canDrop(plan)) {
      updateMark(null)
      return false
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    updateMark(found)
    return true
  }
  const dropOn = (event: DragEvent, found: Located | null) => {
    if (!active || !found) return
    event.preventDefault()
    const source = active
    // The dragged row may be replaced by a new one in its new place: no dragend would reach it, so clean up here.
    endDrag()
    // Tabs of another window: the drag is over for this list whatever happens next (the main process answers with the new state).
    if (source.kind === 'window-tabs' && foreign) setDismissedDrag(foreign.token)
    runPlan(planDrop(state, source, found.target))
  }
  /** Where the pointer is in the list: the rows for tabs, only the folders for a dragged folder. */
  const locateList = (element: HTMLElement, y: number): Located | null => (!active ? null : active.kind === 'folder' ? locateInFolders(element, y) : locateInList(element, y, tree))

  // The browser ends every drag on its source row, but a row replaced during the drag never hears of it: the next press or key ends it.
  // (Not `drop` or `dragend`: ending the state before the row's own handlers ran would make them see no drag.)
  useEffect(() => {
    if (!drag) return
    const stop = () => {
      updateMark(null)
      setDrag(null)
      releasePage()
      releaseWindows()
    }
    const events = ['mousedown', 'keydown'] as const
    for (const name of events) window.addEventListener(name, stop, true)
    return () => {
      for (const name of events) window.removeEventListener(name, stop, true)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the listeners follow the drag; the functions they call read the latest values
  }, [drag])

  // The pointer of a drag from another window is over this sidebar while dragover keeps coming (as for the marks): when it stops, it has left.
  const overTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchForeign = () => {
    if (overTimer.current) clearTimeout(overTimer.current)
    overTimer.current = setTimeout(() => setForeignOver(false), MARK_IDLE_MS)
    setForeignOver(true)
  }
  // A drag of another window that nobody ended (a message lost) must not keep its marks here: the next press or key dismisses it.
  const foreignToken = foreign?.token
  useEffect(() => {
    if (foreignToken === undefined) {
      setForeignOver(false)
      return
    }
    const dismiss = () => setDismissedDrag(foreignToken)
    const events = ['mousedown', 'keydown'] as const
    for (const name of events) window.addEventListener(name, dismiss, true)
    return () => {
      for (const name of events) window.removeEventListener(name, dismiss, true)
      if (overTimer.current) clearTimeout(overTimer.current)
    }
  }, [foreignToken])

  // A dragged tab resting on a collapsed folder opens it.
  const hoveredFolderId = mark?.edge === 'inside' && mark.target.kind === 'folder' ? mark.target.id : null
  const folderToOpen = (active?.kind === 'tabs' || active?.kind === 'window-tabs') && hoveredFolderId && state.folders.find((f) => f.id === hoveredFolderId)?.collapsed ? hoveredFolderId : null
  useEffect(() => {
    if (!folderToOpen) return
    const timer = setTimeout(() => void act.dispatch({ type: 'folder/toggle', id: folderToOpen }), FOLDER_OPEN_DELAY_MS)
    return () => clearTimeout(timer)
  }, [folderToOpen, act])

  const proxyMarks = proxyMarkedTabs(state, snapshot.private === true)
  const ui: SidebarUi = {
    selected: new Set(live.ids),
    dragging: new Set(drag?.kind === 'tabs' ? drag.ids : drag?.kind === 'folder' ? [`folder:${drag.id}`] : []),
    mark,
    developerHosts: state.settings.developerHosts,
    containers: state.settings.containers,
    // The tabs of a profile that has a proxy, which they do not go through (a container, a private tab): nothing is computed while no profile has one of its own.
    ...(proxyMarks.size > 0 ? { proxyMarks } : {}),
    badges: state.settings.tabStateBadges,
    clickRow(tab, event) {
      hover.hide()
      const outcome = clickSelection(live, tab.id, { toggle: event.metaKey || (!isMac && event.ctrlKey), range: event.shiftKey }, order, activeId ?? null)
      setSelection(outcome.selection)
      if (outcome.activate) void act.dispatch({ type: 'tab/select', id: tab.id })
    },
    menuRow(tab, event) {
      event.preventDefault()
      event.stopPropagation()
      hover.hide()
      // Inside the selection the menu is the group's; anywhere else it is the tab's own, and the selection goes away.
      // The row is passed with the menu: the sheets it opens (rename, automatic reload) hang from it.
      const anchor = rectOf(event.currentTarget)
      if (live.ids.includes(tab.id)) act.showMenu({ kind: 'tab', id: tab.id, selection: selectedInOrder(live, order), anchor })
      else {
        setSelection(NO_SELECTION)
        act.showMenu({ kind: 'tab', id: tab.id, anchor })
      }
    },
    dragStartRow(tab, event, together) {
      hover.hide()
      // Dragging a selected row takes the whole selection; a split view takes both its tabs; any other row goes alone.
      const ids = draggedIds(tab.id, live.ids.includes(tab.id) ? selectedInOrder(live, order) : [], together)
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(DRAG_TYPE, ids.join(','))
      setDragGhost(event, ids.length, 'tab')
      // One tab dragged toward the page makes a split view: the page (not this surface) draws where it would go, so it is told now.
      if (state.settings.dragToSplit && ids.length === 1) {
        toldPage.current = true
        act.splitDrag('start', tab.id)
      }
      // The other windows take a drop of these tabs: the main process keeps the drag, the drop only names a place.
      toldWindows.current = true
      act.tabDrag('start', ids)
      // Changing the page inside dragstart can cancel the drag: the state follows a moment later.
      setTimeout(() => setDrag({ kind: 'tabs', ids }), 0)
    },
    dragStartFolder(folder: Folder, event) {
      hover.hide()
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(DRAG_FOLDER_TYPE, folder.id)
      setDragGhost(event, 1, 'folder')
      setTimeout(() => setDrag({ kind: 'folder', id: folder.id }), 0)
    },
    dragEnd: endDrag,
    moveRow(tab, direction) {
      // One place up or down its group, as "Déplacer vers le haut / le bas" in its menu: at either end, nothing.
      const step = tabStep(state, tab.id, direction)
      if (!step) return
      hover.hide()
      refocus.current = { id: tab.id, from: order.join(), until: Date.now() + 1000 }
      void act.dispatch({ type: 'tab/move', id: tab.id, ...step })
    },
    clearSelection: () => setSelection(NO_SELECTION),
    hoverStart: (tab: TabItem, row: HTMLElement, event: MouseEvent) => hover.start(tab.id, row, event.clientX),
    hoverEnd: hover.leave,
    ...(tree ? { tree: true } : {}),
    ...(compact
      ? {
          compact: {
            fullUrl: state.settings.fullUrlInToolbar,
            edit: (tab: TabItem) => act.openOverlay({ panel: 'commandbar', mode: 'current', initial: displayAddress(tab.url) }),
            siteInfo: () => act.openOverlay({ panel: 'site' })
          }
        }
      : {})
  }
  const rowsUi = useStableUi(ui)
  const hoveredTab = hover.anchor ? state.tabs.find((t) => t.id === hover.anchor!.tabId) : undefined

  // The Tab key stops on the selected row; when that one is not on screen (a closed folder, no tab) it stops on the first row, and the arrows reach the others.
  const stop = tabStop(order, activeId)
  // The rows are memoized by what they draw (row-equality.ts): the language of the interface is read by `t()`, so a change of it has to rebuild them (the key).
  const row = (tab: TabItem) => <TabRow key={`${tab.id}:${getLanguage()}`} tab={tab} active={tab.id === activeId} inSplit={splitTabIds.has(tab.id)} runtime={runtime} tabbable={tab.id === stop} tree={treeInfo?.get(tab.id)} />
  /** Rows for a list of tabs; the tabs of one split view become a single row at the place of its anchor (`splitPlan`), and its other tabs have none. */
  const rowsOf = (list: TabItem[]) =>
    list.flatMap((tab) => {
      if (splitPlan.covered.has(tab.id)) return []
      const split = splitPlan.rows.get(tab.id)
      if (!split) return [row(tab)]
      const view = viewMarks.get(split.id)
      return [<SplitRow key={`${split.id}:${getLanguage()}`} tabs={split.tabs} anchor={tab.id} activeId={activeId} runtime={runtime} view={view} />]
    })
  /** A folder with its own tabs, then the folders inside it. `side`: a root folder at the start of Today or under its tabs. */
  const folderTree = (folder: Folder, first: boolean, side?: 'today-start' | 'bottom'): ReactNode => (
    <FolderBlock key={folder.id} folder={folder} first={first} side={side}>
      {rowsOf(pinned.filter((t) => t.folderId === folder.id))}
      {folders.filter((f) => f.parentId === folder.id).map((child, i) => folderTree(child, i === 0))}
      {/* Live folders (setting `liveFolders`, off by default): nothing is drawn for them while it is off, so the sidebar is unchanged. */}
      {state.settings.liveFolders && folder.live && <LiveItems folder={{ ...folder, live: folder.live }} />}
    </FolderBlock>
  )
  // A folder whose parent is missing is shown at the root rather than lost (the state is repaired when it is loaded).
  const rootFolders = folders.filter((f) => !f.parentId || !folders.some((p) => p.id === f.parentId))
  // The folders put under the Today tabs (a folder's menu, or dropping it there) are drawn after them, those put at the start of Today before them; the others,
  // with the loose pinned tabs, above its header.
  const topFolders = rootFolders.filter((f) => sideOfFolder(f) === 'top')
  const startFolders = rootFolders.filter((f) => sideOfFolder(f) === 'today-start')
  const bottomFolders = rootFolders.filter((f) => sideOfFolder(f) === 'bottom')
  const looseSplit = (list: TabItem[]) => list.filter((t) => !t.folderId || !folders.some((f) => f.id === t.folderId))
  const hasPinned = looseSplit(pinned).length > 0 || topFolders.length > 0
  // The lists as `rowsOf` draws them, top to bottom: a split view whose tabs sit in two of them is still one row, at the place of its tab in a folder, else of
  // its first tab (split-place.ts; a state saved before the reducer put the tabs of a new split view together).
  const folderLists = (folder: Folder): DrawnList<TabItem>[] => [{ tabs: pinned.filter((t) => t.folderId === folder.id), folder: true }, ...folders.filter((f) => f.parentId === folder.id).flatMap(folderLists)]
  const todayLists = (groupPrivate ? [todayNormal, todayPrivate] : [shownToday]).map((tabs): DrawnList<TabItem> => ({ tabs, folder: false }))
  // The split views opened from a work view of this profile: their row wears the view's icon.
  const viewMarks = new Map(workViews.flatMap((view) => state.splits.filter((split) => split.viewId === view.id && split.spaceId === space.id).map((split) => [split.id, { emoji: view.emoji, name: view.name }] as const)))
  const splitPlan = splitRows([{ tabs: looseSplit(pinned), folder: false }, ...topFolders.flatMap(folderLists), ...startFolders.flatMap(folderLists), ...todayLists, ...bottomFolders.flatMap(folderLists)], state.splits)
  // "Ranger les onglets…" has something to work on when two Today tabs can be put in order (the proposal itself says what it makes of them). Not in a private window: it has no folder.
  const tidyable = !snapshot.private && tidyCandidates(state, space.id).length >= TIDY_GROUP_MIN
  const draggingTabs = drag?.kind === 'tabs'
  // Tabs of another window only show the zone to pin while the pointer is over this list: nothing here moves for a drag that never comes this way.
  const showPinZone = draggingTabs || (foreign !== null && foreignOver)

  // Today has a line of its own, "Aujourd’hui · 5" with "Tout archiver" always in view (it was the broom that showed at the pointer on the line between the pinned tabs and Today).
  const key = (command: string): string | undefined => effectiveAccelerator(command, state.settings.keyBindings, platform)
  const newTabKeys = key('newTab')
  const archiveKeys = key('archive')
  const readLaterKeys = key('readLaterList')
  const hint = (accelerator: string | undefined): string => (accelerator ? formatAccelerator(accelerator, platform) : '')
  const tip = (label: string, accelerator: string | undefined): string => (accelerator ? `${label} · ${hint(accelerator)}` : label)
  // The footer's spaces are tabs of one list: the arrows move between them, the focus follows the one that is current.
  const spaceIndex = Math.max(0, state.spaces.findIndex((s) => s.id === space.id))

  // The text of the tabs over a media background: set on the sidebar itself, so that no stylesheet rule can keep the theme's colours.
  const bg = space.background
  const textTone = bg && bg.type !== 'color' ? (bg.textColor ? undefined : bg.tone && bg.tone !== 'auto' ? bg.tone : bg.veilColor ? (veilIsDark(bg.veilColor) ? 'light' : 'dark') : undefined) : undefined
  // The rows read --sb-text and friends, which the shell (an ancestor) has already resolved: they are set here, on the sidebar itself.
  const ink = bg?.textColor ? [bg.textColor, bg.textColor] : textTone === 'light' ? ['var(--tone-on-dark)', 'var(--tone-on-dark-2)'] : textTone === 'dark' ? ['var(--tone-on-light)', 'var(--tone-on-light-2)'] : null
  const textVars = ink ? { '--text-on-space': ink[0], '--text-on-space-2': ink[1], '--text-on-tile-2': ink[1], '--sb-text': ink[0], '--sb-text-hover': ink[0], '--sb-dim': ink[1], '--sb-dim-tile': ink[1], '--sb-dim-hover': ink[1], '--sb-faint': ink[1], '--sb-glyph': ink[1] } : {}
  const style = { '--sidebar-width': `${state.settings.sidebarWidth}px`, ...textVars } as unknown as CSSProperties
  const systemReduceMotion = useSystemReducedMotion()

  return (
    <SidebarUiContext.Provider value={rowsUi}>
      <aside
        className={`sidebar ${FLOATING ? 'floating' : ''} ${space.background?.textHalo ? 'text-halo' : ''} ${ink ? 'custom-text' : ''}`}
        style={style}
        // The floating copy keeps itself open while the pointer is in its view, not only on its panel (App.tsx, `FloatingShell`): the panel is inset from the
        // window's edge and slides in under a pointer resting there, which would have left it and hidden the copy over and over.
        onDragOver={foreign ? touchForeign : undefined}
        // A right click on the sidebar itself (not on a tab, folder, button or field) opens the menu of the current space, after « Barre de cette fenêtre ».
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('button, input, textarea, browser-action-list')) return
          e.preventDefault()
          act.showMenu({ kind: 'space', id: space.id, sidebar: true })
        }}
      >
        <SpaceBackgroundLayer space={space} className="sidebar-background" forceReduceMotion={state.settings.forceReduceMotion} saving={snapshot.batterySaverOn === true} />
        <div className="toolbar">
          {/* Windows, with the toolbar of the pages hidden: the button ☰ is not in a toolbar, so it starts this row (the menu bar is not there either). */}
          {controls && !showToolbar && <AppMenuButton className="icon sidebar-menu" />}
          <button
            className="icon sidebar-toggle"
            title={tip(t('sidebar.masquer-la-barre-laterale'), key('toggleSidebar'))}
            aria-label={t('sidebar.masquer-la-barre-laterale')}
            onClick={() => void act.dispatch({ type: 'settings/update', patch: { sidebarVisible: false } })}
          >
            <SidebarIcon />
          </button>
          {state.settings.showReloadAllButton && (
            <>
              {/* The buttons reload every tab of their scope, the sleeping ones too (ipc.ts). While a run goes on, its button turns and fills a bar under the
                  icon (still, with less motion: the bar alone); a click on it brings back its notice with « Arrêter ». */}
              <ReloadButton className="icon sidebar-reload-all" label={t('sidebar.actualiser-tous-les-onglets-de-tous-les-espaces')} run={reloadButtonBusy(snapshot.reloadRun) ? snapshot.reloadRun : undefined} onClick={() => act.reloadAllTabs(true)}>
                <ReloadAllIcon />
              </ReloadButton>
              <ReloadButton className="icon sidebar-reload-all sidebar-reload-space" label={t('sidebar.actualiser-les-onglets-de-cet-espace')} run={reloadButtonBusy(snapshot.reloadRun, space.id) ? snapshot.reloadRun : undefined} onClick={() => act.reloadSpaceTabs()}>
                <ReloadSpaceIcon />
              </ReloadButton>
            </>
          )}
          {!showToolbar && (
            <>
              <browser-action-list key={actionListKey(`persist:profile-${space.profileId}`, space.profileId, snapshot.extensions)} partition={`persist:profile-${space.profileId}`} alignment="bottom right" />
              <div className="nav-buttons">
                <button className="icon" title={t('sidebar.precedent')} aria-label={t('sidebar.precedent')} disabled={!runtime.canGoBack && !runtime.backCloses} onClick={() => act.nav('back')}>
                  <span aria-hidden="true">‹</span>
                </button>
                <button className="icon" title={t('sidebar.suivant')} aria-label={t('sidebar.suivant')} disabled={!runtime.canGoForward} onClick={() => act.nav('forward')}>
                  <span aria-hidden="true">›</span>
                </button>
                <button className="icon" title={t('sidebar.recharger')} aria-label={t('sidebar.recharger')} onClick={() => act.nav('reload')}>
                  <span aria-hidden="true">↻</span>
                </button>
              </div>
            </>
          )}
          {/* « Plier la barre »: the sidebar of this window becomes a column of site icons (« Déplier » at its foot gives it back), at the top corner that faces the page. */}
          <button className="icon sidebar-dock" aria-label={t('sidebar.plier-la-barre')} {...tipProps(t('sidebar.plier-la-barre'), dockKeys)} onClick={() => act.windowSidebar({ op: 'dock', docked: true })}>
            <FoldSidebarIcon />
          </button>
        </div>

        {!showToolbar && !addressRow && (
          <div className="urlbar">
            <button className="url-pill" aria-label={current && addressLabel(current.url) ? t('toolbar.modify-address', { host: addressLabel(current.url) }) : undefined} onClick={() => act.openOverlay({ panel: 'commandbar', mode: 'current', initial: current ? displayAddress(current.url) : '' })}>
              {current ? hostOf(current.url) ? <HostText host={hostOf(current.url)} /> : addressLabel(current.url) : t('sidebar.rechercher-ou-saisir-une-adresse')}
            </button>
            {current && (
              <button className="icon" title={tip(t('toolbar.infos-et-reglages-du-site'), key('siteInfo'))} aria-label={t('toolbar.infos-et-reglages-du-site')} onClick={() => act.openOverlay({ panel: 'site' })}>
                {CONNECTION_MARKS[connectionState(current.url, runtime.tabs[current.id]?.untrustedCertificate === true)]}
              </button>
            )}
            {current && (
              <button
                className="icon"
                title={isFavorite ? t('sidebar.retirer-des-favoris') : t('sidebar.ajouter-aux-favoris')}
                aria-label={isFavorite ? t('sidebar.retirer-des-favoris') : t('sidebar.ajouter-aux-favoris')}
                onClick={() => {
                  const existing = favorites.find((f) => f.url === current.url)
                  void act.dispatch(existing ? { type: 'favorite/remove', id: existing.id } : { type: 'favorite/add', url: current.url, title: current.title, faviconUrl: current.faviconUrl, spaceId: space.id })
                }}
              >
                {isFavorite ? '★' : '☆'}
              </button>
            )}
          </div>
        )}

        {(favorites.length > 0 || workViews.length > 0 || draggingTabs) && (
          <div
            className={`favorites ${state.settings.favoriteNames ? 'named' : ''} ${favorites.length === 0 && workViews.length === 0 ? 'empty-drop' : ''} ${favorites.length === 0 ? markClass(mark, 'favorites') : ''}`}
            onDragOver={(e) => hoverTarget(e, drag ? locateInFavorites(e.currentTarget, e.clientX, e.clientY) : null)}
            onDrop={(e) => dropOn(e, drag ? locateInFavorites(e.currentTarget, e.clientX, e.clientY) : null)}
          >
            {favorites.length === 0 && workViews.length === 0 && t('sidebar.ajouter-aux-favoris')}
            {favorites.map((f) => (
              <button
                key={f.id}
                className={`favorite ${current?.favoriteId === f.id ? 'active' : ''} ${drag?.kind === 'favorite' && drag.id === f.id ? 'dragging' : ''} ${markClass(mark, `favorite:${f.id}`)}`}
                // The tile holds the icon, or the first letter of the site when it has none; the name is the favourite's title, a bubble at once on the pointer and the focus
                // (CSS, `.favorite-name`), or under the icon with the setting `favoriteNames`. No `title`: a second, slow bubble would sit on top of it.
                aria-label={f.title}
                draggable
                data-favorite={f.id}
                onClick={() => void act.dispatch({ type: 'favorite/open', id: f.id, spaceId: space.id })}
                onDragStart={(e) => {
                  hover.hide()
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData(DRAG_FAVORITE_TYPE, f.id)
                  setDragGhost(e, 1, 'favorite')
                  setTimeout(() => setDrag({ kind: 'favorite', id: f.id }), 0)
                }}
                onDragEnd={endDrag}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  act.showMenu({ kind: 'favorite', id: f.id, anchor: rectOf(e.currentTarget) })
                }}
              >
                <Favicon tab={{ faviconUrl: f.faviconUrl, url: f.url, title: f.title }} />
                <span className="favorite-name" aria-hidden="true">
                  {f.title}
                </span>
              </button>
            ))}
            {workViews.length > 0 && <WorkViewTiles state={state} space={space} views={workViews} />}
          </div>
        )}

        <div
          ref={list}
          className="scroll"
          onDragOver={(e) => hoverTarget(e, locateList(e.currentTarget, e.clientY))}
          onDrop={(e) => dropOn(e, locateList(e.currentTarget, e.clientY))}
          onClick={(e) => {
            // A click on the empty part of the list ends a multiple selection.
            if (live.ids.length > 0 && !(e.target as HTMLElement).closest('.tab, .split-row')) setSelection(NO_SELECTION)
          }}
        >
          <div ref={listContent} className="scroll-content">
            {!space.hideHeader &&
              (snapshot.private ? (
                // A private window has a single space and keeps nothing: no menu to offer.
                <div className="space-header">
                  <span className="space-header-emoji">
                    <SpaceMark space={space} className="header" />
                  </span>
                  <span className="space-header-name">{space.name}</span>
                </div>
              ) : (
                // The header is the button of the menu of the space (rename, customise, new folder, empty Today, hide the header, manage the spaces).
                <button
                  className="space-header space-header-button"
                  aria-haspopup="menu"
                  onClick={(e) => {
                    const { x, y, width, height } = e.currentTarget.getBoundingClientRect()
                    act.openOverlay({ panel: 'spacemenu', spaceId: space.id, anchor: { x, y, width, height } })
                  }}
                  // As on the rest of the sidebar, a right click opens the native menu of the space (the button would otherwise keep it from the sidebar's own handler).
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    act.showMenu({ kind: 'space', id: space.id })
                  }}
                >
                  <span className="space-header-emoji">
                    <SpaceMark space={space} className="header" />
                  </span>
                  <span className="space-header-name">{space.name}</span>
                  <ChevronDownGlyph />
                </button>
              ))}
            {/* The private window says what it does not keep, in three lines (the last one reassures: the downloads stay). */}
            {snapshot.private && (
              <div className="private-note" role="note" aria-label={t('sidebar.ce-que-cette-fenetre-ne-garde-pas')}>
                <span>{t('sidebar.l-historique-n-est-pas-enregistre')}</span>
                <span>{t('sidebar.les-cookies-sont-effaces-a-la-fermeture')}</span>
                <span className="keep">{t('sidebar.les-telechargements-restent-sur-le-disque')}</span>
              </div>
            )}
            {hasPinned && (
              <Section>
                <div className="pinned-rows">{rowsOf(looseSplit(pinned))}</div>
                {topFolders.map((folder, i) => folderTree(folder, i === 0))}
              </Section>
            )}
            {/* While dragging, with nothing pinned yet, a zone to pin by dropping. */}
            {showPinZone && !hasPinned && (
              <div className={`pin-drop ${markClass(mark, 'pin-zone')}`} data-drop="pin-zone" data-id="pin">
                {t('sidebar.epingler-ici')}
              </div>
            )}

            <Section>
              <div className="today-head">
                <span>{t('sidebar.aujourd-hui-count', { count: today.length })}</span>
                {tidyable && (
                  <button className="today-tidy" title={t('sidebar.ranger-les-onglets')} aria-label={t('sidebar.ranger-les-onglets')} onClick={() => act.openOverlay({ panel: 'tidy', spaceId: space.id })}>
                    <TidyGlyph small />
                  </button>
                )}
                {today.length > 0 && (
                  <button className="today-all" title={tip(t('cmd.vider-les-onglets-du-jour'), key('clearToday'))} onClick={() => void act.dispatch({ type: 'today/clear' })}>
                    <ArchiveBoxGlyph small />
                    {t('sidebar.tout-archiver')}
                  </button>
                )}
              </div>
              <button
                className={`new-tab ${markClass(mark, 'today-start')}`}
                data-drop="today-start"
                data-id="today"
                data-before={firstToday?.id ?? ''}
                onClick={() => act.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })}
              >
                <span className="plus">
                  <PlusGlyph size={14} />
                </span>
                <span className="new-tab-label">{t('sidebar.nouvel-onglet')}</span>
                {newTabKeys && (
                  <kbd className="new-tab-key" aria-hidden="true">
                    {hint(newTabKeys)}
                  </kbd>
                )}
              </button>
              {/* The folders put at the start of Today (`atTodayStart`: dropping a folder on the "New tab" row, the folder's menu): under that row, before the tabs. */}
              {startFolders.map((folder, i) => folderTree(folder, i === 0, 'today-start'))}
              {groupPrivate ? (
                <>
                  {rowsOf(todayNormal)}
                  <div className="today-group" role="heading" aria-level={3}>
                    {t('sidebar.onglets-prives-titre', { count: todayPrivate.length })}
                  </div>
                  {rowsOf(todayPrivate)}
                </>
              ) : (
                rowsOf(shownToday)
              )}
              {today.length === 0 && (
                <div className="today-empty">
                  <b>{t('sidebar.aucun-onglet-du-jour')}</b>
                  <span>{t('sidebar.les-onglets-archives-restent-dans-l-archive')}{archiveKeys ? ` (${hint(archiveKeys)})` : ''}</span>
                </div>
              )}
              {/* One button that closes every tab of the private window, and says how many; no confirmation and no undo (bringing private tabs back would break the promise). */}
              {snapshot.private && today.length > 0 && (
                <button className="private-closeall" onClick={() => void Promise.all(state.tabs.filter((tab) => tab.spaceId === space.id).map((tab) => act.dispatch({ type: 'tab/close', id: tab.id })))}>
                  {tp('sidebar.close-private-tabs', state.tabs.filter((tab) => tab.spaceId === space.id).length)}
                </button>
              )}
              {/* The folders put under the Today tabs (`atBottom`: the folder's menu, dropping it there, "Ranger les onglets…"). */}
              {bottomFolders.map((folder, i) => folderTree(folder, i === 0, 'bottom'))}
              {/* While a folder is dragged, a zone under everything to drop it there (the other places are its neighbours). */}
              {showsFolderBottomZone(drag) && (
                <div className={`folder-bottom-drop ${markClass(mark, 'folder-bottom')}`} data-drop="folder-bottom" data-id="folder-bottom">
                  {t('sidebar.placer-le-dossier-sous-les-onglets')}
                </div>
              )}
            </Section>
          </div>
        </div>

        <MediaPlayers state={state} runtime={runtime} />

        {/* A video behind the space: Pause / Lire, and whether it goes on behind another window (or stands still for the battery saver). */}
        <BackgroundVideoControls space={space} reduceMotion={systemReduceMotion || state.settings.forceReduceMotion} saving={snapshot.batterySaverOn === true} />

        {/* The region is always there: a screen reader announces a change inside a live region, not one that arrives with its text. */}
        <div className="toast-region" role="status" aria-live="polite" aria-atomic="true">
          {toast && <SidebarToast key={toast.id} toast={toast} act={act} />}
        </div>
        <footer className={`footer ${scrolls ? 'edge' : ''}`}>
          {/* The archive had no button (only the menu and ⌥⌘A); the tooltips are immediate and name the shortcut. */}
          <button className="footer-side footer-archive" data-tip={tip(t('menu.archive'), archiveKeys)} aria-label={tip(t('menu.archive'), archiveKeys)} onClick={() => act.openOverlay({ panel: 'archive' })}>
            <ArchiveBoxGlyph />
          </button>
          {/* "Lire plus tard" had no way in but the menu: the list opens from here (a private window keeps none). */}
          {!snapshot.private && (
            <button className="footer-side footer-readlater" data-tip={tip(t('menu.lire-plus-tard'), readLaterKeys)} aria-label={tip(t('menu.lire-plus-tard'), readLaterKeys)} onClick={() => act.openOverlay({ panel: 'readlater' })}>
              <ReadLaterGlyph />
            </button>
          )}
          <FooterDownloads
            enabled={state.settings.downloadStatusChip}
            downloads={downloads}
            buttons={{ pause: state.settings.downloadPause === true, resumeRecorded: state.settings.downloadResume === true }}
            panelLabel={tip(t('sidebar.telechargements'), key('downloads'))}
            onOpenPanel={() => act.openOverlay({ panel: 'downloads' })}
            onAction={(id, command) => act.downloadAction(id, command)}
          />
          {/* The ring of the memory the browser holds; a click slides up the heaviest tabs (a private window has none: its tabs are its own). */}
          {!snapshot.private && (
            <FooterResources enabled={state.settings.resourceGauge} gauge={snapshot.memoryGauge} shown={!FLOATING || snapshot.floating === 'in'} forceReduceMotion={state.settings.forceReduceMotion} />
          )}
          <div
            ref={spacesRow}
            className="spaces"
            role="tablist"
            aria-label={t('menu.espaces')}
            onKeyDown={(e) => {
              // The spaces are tabs: ← and → move between them (and select, as clicking does); the Tab key stops on the current one only.
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              const next = state.spaces[stepSpaceTab(state.spaces.length, spaceIndex, e.key)]
              if (!next) return
              e.preventDefault()
              void act.dispatch({ type: 'space/select', id: next.id })
              requestAnimationFrame(() => spacesRow.current?.querySelector<HTMLElement>(`[data-space="${next.id}"]`)?.focus())
            }}
          >
            {state.spaces.map((s, n) => (
              <button
                key={s.id}
                className={`space ${s.id === space.id ? 'current' : ''} ${markClass(mark, `space:${s.id}`)}`}
                // A native `title`, not the CSS bubble of the other buttons: the row of spaces scrolls, and a bubble inside it would be cut.
                title={tip(t('sidebar.space-options', { name: s.name }), n < 9 ? key(`space${n + 1}`) : undefined)}
                role="tab"
                // The button shows the space's emoji: the name read aloud is the space's, not the emoji's.
                aria-label={s.name}
                aria-selected={s.id === space.id}
                tabIndex={s.id === space.id ? 0 : -1}
                data-space={s.id}
                onClick={() => void act.dispatch({ type: 'space/select', id: s.id })}
                onDoubleClick={() => act.openOverlay({ panel: 'space', spaceId: s.id })}
                // A dragged tab dropped on a space goes there.
                onDragOver={(e) => hoverTarget(e, drag?.kind === 'tabs' ? { target: { kind: 'space', id: s.id }, at: `space:${s.id}`, edge: 'inside' } : null)}
                onDrop={(e) => dropOn(e, drag?.kind === 'tabs' ? { target: { kind: 'space', id: s.id }, at: `space:${s.id}`, edge: 'inside' } : null)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  act.showMenu({ kind: 'space', id: s.id })
                }}
              >
                <SpaceBackgroundLayer space={s} enabled={false} />
                <span className="space-mark">
                  <SpaceMark space={s} className="footer" />
                </span>
              </button>
            ))}
          </div>
          <button
            className={`footer-side footer-plus ${snapshot.plusOpen ? 'open' : ''}`}
            data-tip={snapshot.private ? tip(t('sidebar.nouvel-onglet'), newTabKeys) : t('sidebar.nouveau')}
            aria-label={t('sidebar.nouveau-2')}
            aria-expanded={snapshot.plusOpen === true}
            // A private window has no popover behind the plus: it opens the command bar. Elsewhere the popover hangs from this button.
            onClick={(e) => {
              if (snapshot.private) return act.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })
              const { x, y, width, height } = e.currentTarget.getBoundingClientRect()
              act.openOverlay({ panel: 'plus', anchor: { x, y, width, height } })
            }}
          >
            <PlusGlyph />
          </button>
        </footer>
        {hoveredTab && hover.anchor && !drag && (
          <HoverCard key={hoveredTab.id} tab={hoveredTab} anchor={hover.anchor} runtime={runtime.tabs[hoveredTab.id]} onEnter={hover.keep} onLeave={hover.hide} onAction={(action) => cardAction(hoveredTab, action)} sidebarWidth={state.settings.sidebarWidth} sidebarLeft={sidebarLeft({ width: window.innerWidth, sidebarWidth: state.settings.sidebarWidth, sidebarRight: right, floating: FLOATING })} preview={state.settings.hoverCards} resources={state.settings.showTabMemory} badges={state.settings.tabStateBadges} />
        )}
        {!FLOATING && sidebarVisible && <ResizeHandle right={right} width={state.settings.sidebarWidth} />}
      </aside>
    </SidebarUiContext.Provider>
  )
}
