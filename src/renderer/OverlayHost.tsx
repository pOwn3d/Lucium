import { Component, useEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react'
import { SITE_POPOVER_MOTION } from '@shared/command-bar'
import { paneRightInset, popoverRightInset, shownSidebarWidth, sidebarLeft } from '@shared/frame-layout'
import { sidebarPlacement } from '@shared/window-sidebar'
import type { OverlayRequest } from '@shared/ipc'
import { api, followSnapshots, useSnapshot } from './api'
import { CommandBar } from './CommandBar'
import { ShortcutHelp } from './ShortcutHelp'
import { TabSearch } from './TabSearch'
import { FindReplace } from './FindReplace'
import { ImportSheet } from './ImportSheet'
import { FirstLaunchSheet } from './FirstLaunchSheet'
import { LeaveSheet } from './LeaveSheet'
import { WelcomeSheet } from './WelcomeSheet'
import { WhatsNewSheet } from './WhatsNewSheet'
import { ArcGuide } from './ArcGuide'
import { Discover } from './Discover'
import { RestoreSheet } from './RestoreSheet'
import { ProblemReport } from './ProblemReport'
import { NoticesPanel } from './NoticesPanel'
import { HistoryPanel, SpacesPanel, TabEditor } from './ManagePanels'
import { PassphrasePrompt } from './PassphrasePrompt'
import { PlusMenu } from './PlusMenu'
import { SpaceMenu } from './SpaceMenu'
import { TidyPanel } from './TidyPanel'
import { DeadTabsSheet } from './DeadTabsSheet'
import { FavoriteEditor } from './FavoriteEditor'
import { WorkViewSheet } from './WorkViewSheet'
import { ReadLater } from './ReadLater'
import { Bookmarks } from './Bookmarks'
import { LiveFolderSheet } from './LiveFolderSheet'
import { FolderIconSheet } from './FolderIconSheet'
import { ExtensionReview } from './ExtensionReview'
import { Sessions } from './Sessions'
import { WindowName } from './WindowName'
import { SiteData } from './SiteData'
import { CookieManager } from './CookieManager'
import { SpaceCreate } from './SpaceCreate'
import { SplitDrop } from './SplitDrop'
import { TabCycle } from './TabCycle'
import { TabGrid } from './TabGrid'
import { AutoReloadPanel } from './AutoReloadPanel'
import { QrPanel } from './QrPanel'
import { AnnotateSheet } from './AnnotateSheet'
import { TranslatePanel } from './TranslatePanel'
import { TranslatePopover } from './TranslatePopover'
import { PasswordsPanel } from './PasswordsPanel'
import { NotesPanel } from './NotesPanel'
import { ThemeEditor } from './ThemeEditor'
import { ArchivePanel, AuthPrompt, BoostEditor, RegionCapture, DownloadsPanel, FindBar, PeekHeader, PermissionPrompt, PromptDialog, SitePanel } from './Panels'
import { SpaceCustomize } from './SpaceCustomize'
import { ShortcutSheet } from './ShortcutSheet'
import { keepPanelFocus, panelIsBusy } from './overlay-focus'
import { overlayHeld } from './overlay-hold'
import './popovers.css'

/**
 * Panels that dim the window; a click outside closes them. The others are small and leave the page usable.
 * The Tweak editor and Glance are not in the set: they cover the window like modal panels, but draw (or do not draw) their own dimming.
 */
const MODAL = new Set<OverlayRequest['panel']>(['commandbar', 'shortcuts', 'downloads', 'shortcut', 'space', 'spacecreate', 'plus', 'spacemenu', 'tidy', 'deadtabs', 'archive', 'site', 'sitedata', 'cookies', 'sessions', 'readlater', 'history', 'spaces', 'tab', 'autoreload', 'import', 'firstlaunch', 'qr', 'windowname', 'translate', 'translatepop', 'passwords', 'bookmarks', 'livefolder', 'foldericon', 'welcome', 'whatsnew', 'arcguide', 'discover', 'restore', 'problemreport', 'notices', 'notes', 'workview', 'tabgrid'])

/** Modal panels drawn as a popover next to what opened them (or, for the command bar, over the page): no dimming, and where they sit decides the variant. */
const POPOVER_CLASS: Partial<Record<OverlayRequest['panel'], string>> = { site: 'popover', downloads: 'popover popover-left', commandbar: 'cb-backdrop', plus: 'plus-host', spacemenu: 'plus-host' }

/** Small editors that hang from the element that opened them when the request carries it: their layer is not dimmed, and a click on it closes them. */
const BUBBLE_PANELS = new Set<OverlayRequest['panel']>(['tab', 'favorite', 'autoreload', 'windowname', 'translatepop', 'workview'])

/**
 * The backdrop of a popover that hangs from the toolbar (the site control centre) or from the downloads button of the sidebar's footer. With
 * the sidebar at the right those two are not where the default layout puts them: the numbers that place the popover come from the window's
 * geometry (the side of this window, and the width of its docked column when it has one). In the default layout no variable is set, and the
 * stylesheets' own values apply.
 */
export function SideBackdrop({ className, onKeyDown, onMouseDown, strip, backdrop, children }: { className: string; onKeyDown: (e: React.KeyboardEvent) => void; onMouseDown: (e: React.MouseEvent) => void; strip?: { x: number; width: number }; backdrop?: Ref<HTMLDivElement>; children: ReactNode }) {
  const snapshot = useSnapshot()
  const settings = snapshot?.state.settings
  const placement = settings ? sidebarPlacement(settings, snapshot?.windowSidebar) : null
  const width = settings && placement ? shownSidebarWidth({ docked: placement.docked, sidebarWidth: settings.sidebarWidth }) : 0
  const style = settings && placement?.right
    ? ({
        '--popover-right': `${popoverRightInset({ sidebarRight: true, sidebarVisible: settings.sidebarVisible, sidebarWidth: width })}px`,
        '--sb-left': `${settings.sidebarVisible ? sidebarLeft({ width: window.innerWidth, sidebarWidth: width, sidebarRight: true, floating: false }) : 0}px`
      } as CSSProperties)
    : undefined
  // Opened from the strip of a split pane: it hangs from that pane's right edge, not the window's (which is the other pane's).
  const paneInset = paneRightInset(strip, window.innerWidth)
  const placed = paneInset === null ? style : ({ ...style, '--popover-right': `${paneInset}px` } as CSSProperties)
  return (
    <div ref={backdrop} className={className} style={placed} onKeyDown={onKeyDown} onMouseDown={onMouseDown}>
      {children}
    </div>
  )
}

/**
 * A panel that fails to draw leaves the layer empty until the next request, not for good: React unmounts a whole tree whose render throws, and
 * the layer is one tree for every panel. The failure is logged with the panel's name (the engine test reads it), and the layer is closed: an
 * empty layer left over the window would have no way out (a small panel has no backdrop to click), and a question it carried (a permission,
 * a login) would wait for good. Closing answers it as a refusal.
 */
export class PanelBoundary extends Component<{ panel: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  override componentDidCatch(error: Error): void {
    console.error(`[overlay] the ${this.props.panel} panel failed to draw:`, error.message)
    api().closeOverlay()
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

export function OverlayHost() {
  const [request, setRequest] = useState<OverlayRequest | null>(null)
  // Panels remount on every request so their inputs reset and refocus.
  const [version, setVersion] = useState(0)
  // The site popover folds back to its button before it goes away (0.15 s); the other panels leave at once.
  const [closing, setClosing] = useState(false)

  // The closing of the site popover that is waiting for its fold to end. It closes whatever panel is shown when it fires, so it is given up as
  // soon as the layer is told anything else (another panel opened meanwhile, or the popover was closed by the main process).
  const closeTimer = useRef<number | null>(null)
  const forgetCloseTimer = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }

  useEffect(() => {
    // A panel is drawn from its first frame over the state the layer was sent before the request (api.ts).
    const unfollow = followSnapshots()
    // `null` is the main process saying that the panel is closed: the layer draws nothing, so the panel is unmounted (its state, its listeners
    // and its timers go, and its clean-up runs) instead of staying there, out of sight, until the next panel.
    const off = api().onShowOverlay((next) => {
      forgetCloseTimer()
      setRequest(next)
      setVersion((v) => v + 1)
      setClosing(false)
    })
    return () => {
      forgetCloseTimer()
      off()
      unfollow()
    }
  }, [])

  // A panel with no field leaves the focus on nothing, and then Escape and Tab reach no one: the panel itself (a dialog or a menu) takes the focus.
  // Some panels draw nothing until the first snapshot has arrived, and a row that is removed takes the focus away with it: the panel is watched
  // for as long as it is open (overlay-focus.ts).
  const backdrop = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = backdrop.current
    if (!root) return
    return keepPanelFocus(root, document, (changed) => {
      const observer = new MutationObserver(changed)
      observer.observe(root, { childList: true, subtree: true })
      return () => observer.disconnect()
    })
  }, [request, version])

  const dismiss = () => {
    // A panel in the middle of a write that cannot be stopped keeps the layer (overlay-hold.ts).
    if (overlayHeld()) return
    if (request?.panel !== 'site') return api().closeOverlay()
    if (closing) return
    setClosing(true)
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      api().closeOverlay()
    }, SITE_POPOVER_MOTION.closeMs)
  }

  // The popover holds no field: without a focused element the keys reach the page, not the backdrop, so Escape is heard on the window.
  // The listener follows `popover` only: `dismiss` is read through a ref, since it is a new function at each render.
  const popover = request?.panel === 'site'
  const dismissLatest = useRef(dismiss)
  dismissLatest.current = dismiss
  useEffect(() => {
    if (!popover) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && dismissLatest.current()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [popover])

  if (!request) return null

  const panel = (() => {
    switch (request.panel) {
      case 'commandbar':
        // ⌘⇧A: the same card, over the open tabs of every space.
        return request.mode === 'tabs' ? <TabSearch key={version} /> : <CommandBar key={version} mode={request.mode} initial={request.initial} />
      case 'shortcuts':
        return <ShortcutHelp key={version} />
      case 'find':
        return <FindBar key={version} />
      case 'findreplace':
        return <FindReplace key={version} />
      case 'import':
        return <ImportSheet key={version} />
      case 'firstlaunch':
        return <FirstLaunchSheet key={version} />
      case 'downloads':
        return <DownloadsPanel key={version} />
      case 'space':
        return <SpaceCustomize key={version} spaceId={request.spaceId} focus={request.focus} />
      case 'spacecreate':
        return <SpaceCreate key={version} />
      case 'plus':
        return <PlusMenu key={version} anchor={request.anchor} />
      case 'spacemenu':
        return <SpaceMenu key={version} spaceId={request.spaceId} anchor={request.anchor} />
      case 'tidy':
        return <TidyPanel key={version} spaceId={request.spaceId} />
      case 'deadtabs':
        return <DeadTabsSheet key={version} entries={request.entries} />
      case 'theme':
        return <ThemeEditor key={version} spaceId={request.spaceId} from={request.from} />
      case 'archive':
        return <ArchivePanel key={version} />
      case 'tab':
        return <TabEditor key={version} tabId={request.tabId} focus={request.focus} anchor={request.anchor} />
      case 'autoreload':
        return <AutoReloadPanel key={version} tabId={request.tabId} anchor={request.anchor} />
      case 'windowname':
        return <WindowName key={version} anchor={request.anchor} />
      case 'favorite':
        return <FavoriteEditor key={version} favoriteId={request.favoriteId} anchor={request.anchor} />
      case 'workview':
        return <WorkViewSheet key={version} splitId={request.splitId} viewId={request.viewId} full={request.full} anchor={request.anchor} />
      case 'history':
        return <HistoryPanel key={version} />
      case 'spaces':
        return <SpacesPanel key={version} />
      case 'capture':
        return <RegionCapture key={version} />
      case 'annotate':
        return <AnnotateSheet key={version} id={request.id} width={request.width} height={request.height} />
      case 'site':
        return <SitePanel key={version} closing={closing} />
      case 'sitedata':
        return <SiteData key={version} />
      case 'cookies':
        return <CookieManager key={version} />
      case 'sessions':
        return <Sessions key={version} focus={request.focus} tabIds={request.tabIds} />
      case 'readlater':
        return <ReadLater key={version} />
      case 'bookmarks':
        return <Bookmarks key={version} />
      case 'livefolder':
        return <LiveFolderSheet key={version} folderId={request.folderId} />
      case 'foldericon':
        return <FolderIconSheet key={version} folderId={request.folderId} />
      case 'settings':
        // The Settings window is a window of its own: the overlay never receives this request.
        return null
      case 'boost':
        return <BoostEditor key={version} host={request.host} id={request.id} zap={request.zap === true} />
      case 'peek':
        return <PeekHeader key={version} rect={request.rect} stage={request.stage} />
      case 'permission':
        return <PermissionPrompt key={version} request={request.request} />
      case 'auth':
        return <AuthPrompt key={version} request={request.request} />
      case 'extreview':
        return <ExtensionReview key={version} request={request.request} />
      case 'dialog':
        return <PromptDialog key={version} request={request.request} />
      case 'leave':
        return <LeaveSheet key={version} request={request.request} />
      case 'welcome':
        return <WelcomeSheet key={version} />
      case 'whatsnew':
        return <WhatsNewSheet key={version} sheet={request.sheet} />
      case 'arcguide':
        return <ArcGuide key={version} imported={request.imported} />
      case 'discover':
        return <Discover key={version} />
      case 'restore':
        return <RestoreSheet key={version} />
      case 'problemreport':
        return <ProblemReport key={version} />
      case 'notices':
        return <NoticesPanel key={version} items={request.items ?? []} />
      case 'passphrase':
        return <PassphrasePrompt key={version} request={request.request} />
      case 'qr':
        return <QrPanel key={version} text={request.text} />
      case 'shortcut':
        return <ShortcutSheet key={version} url={request.url} title={request.title} />
      case 'translate':
        return <TranslatePanel key={version} />
      case 'translatepop':
        return <TranslatePopover key={version} anchor={request.anchor} />
      case 'passwords':
        return <PasswordsPanel key={version} />
      case 'notes':
        return <NotesPanel key={version} compose={request.compose === true} scope={request.scope} />
      case 'splitdrop':
        return <SplitDrop key={version} size={request.size} snapshot={request.snapshot} sidebarRight={request.sidebarRight} split={request.split} />
      case 'tabgrid':
        return <TabGrid key={version} pictures={request.pictures ?? {}} />
      case 'tabcycle':
        return <TabCycle key={version} cards={request.cards} index={request.index} />
    }
  })()

  // The selection surface draws its own dimming: it must not sit inside the centred modal backdrop.
  if (!MODAL.has(request.panel)) return <PanelBoundary key={version} panel={request.panel}>{panel}</PanelBoundary>

  const bubble = BUBBLE_PANELS.has(request.panel) && 'anchor' in request && request.anchor !== undefined
  const className = `backdrop ${POPOVER_CLASS[request.panel] ?? ''}${bubble ? ' bubble-host' : ''}`
  const onKeyDown = (e: React.KeyboardEvent) =>
    e.key === 'Escape' && !popover && !overlayHeld() && !panelIsBusy(e.currentTarget) && api().closeOverlay()
  const onMouseDown = (e: React.MouseEvent) => e.target === e.currentTarget && !panelIsBusy(e.currentTarget) && dismiss()
  if (request.panel === 'site' || request.panel === 'downloads') {
    return (
      <SideBackdrop backdrop={backdrop} className={className} onKeyDown={onKeyDown} onMouseDown={onMouseDown} strip={request.panel === 'site' ? request.anchor : undefined}>
        <PanelBoundary key={version} panel={request.panel}>
          {panel}
        </PanelBoundary>
      </SideBackdrop>
    )
  }
  return (
    <div ref={backdrop} className={className} onKeyDown={onKeyDown} onMouseDown={onMouseDown}>
      <PanelBoundary key={version} panel={request.panel}>
        {panel}
      </PanelBoundary>
    </div>
  )
}
