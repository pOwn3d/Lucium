// The rows of the sidebar: tabs, the row of a split view, folders and favourites' icons. They share a small context with the
// selection, the drag in progress, the insertion mark and the hover card (see Sidebar.tsx, which owns that state).

import { monogramFor, monogramGround } from '@shared/favicon'
import { Fragment, createContext, memo, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { tabName, type Folder, type RuntimeState, type TabItem } from '@shared/model'
import type { Container } from '@shared/containers'
import type { ProxyMarkReason } from '@shared/proxy-mark'
import type { Located } from '@shared/dnd'
import { compactAddress } from '@shared/compact'
import type { TreeRow } from '@shared/tab-tree'
import { rowsContextKey, sameSplitRow, sameTabRow } from '@shared/row-equality'
import { CONNECTION_MARKS, connectionState } from '@shared/url'
import { isDeveloperUrl } from '@shared/developer-mode'
import { tabStateClasses, tabStateLabel, tabStates } from '@shared/tab-state'
import { splitCloseActions, tabCloseAction } from '@shared/tab-close'
import { api } from './api'
import { rectOf } from './anchor'
import { BackToPinGlyph, CapturedGlyph, ChevronGlyph, CloseGlyph, ContainerBadge, DeveloperBadge, FloatingVideoGlyph, FolderIcon, FrozenGlyph, LoadingRing, MoonGlyph, PrivateBadge, ProxyBadge, ReloadedGlyph, SpeakerGlyph, ThawGlyph } from './sidebar-icons'
import { AutoReloadMark } from './AutoReloadMark'
import { TabMark } from './TabPicture'
import { ExtensionsFaviconIcon, FaviconIcon } from './components/favicon-icon'
import { isInternalPageUrl } from '@shared/internal-page'
import { t, tp } from '@shared/i18n'
import { iconSource } from '@shared/site-icon'

/** The words a row's mark of « Actualiser tous les onglets » adds to its name. */
export function reloadMarkWords(mark: 'pending' | 'running' | 'reloaded' | undefined): string[] {
  if (mark === 'pending') return [t('sidebar.a-actualiser')]
  if (mark === 'running') return [t('sidebar.actualisation-en-cours')]
  if (mark === 'reloaded') return [t('sidebar.actualise')]
  return []
}

/** A folder opens and closes in about 0.2 s. */
export const FOLDER_ANIMATION_MS = 200


/** What the rows share: the selection, the drag in progress, the insertion mark and the hover card. */
export interface SidebarUi {
  selected: ReadonlySet<string>
  dragging: ReadonlySet<string>
  mark: Located | null
  /** Sites marked as developer sites (Developer Mode): their tabs wear a badge. */
  developerHosts: readonly string[]
  /** The tab containers: a tab in one wears a badge in its colour. */
  containers: readonly Container[]
  /** The tabs whose profile has a proxy they do not go through (a container, a private tab): each wears a mark that says why. Absent: none does. */
  proxyMarks?: ReadonlyMap<string, ProxyMarkReason>
  /** Setting `tabStateBadges`: the rows say what their page is doing (loading, asleep, frozen, sound, failed). Off: the rows are the default ones, nothing is computed for the badges. */
  badges: boolean
  clickRow(tab: TabItem, event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>): void
  menuRow(tab: TabItem, event: MouseEvent): void
  /** `together`: the tabs of the split view the row is, which go with it. */
  dragStartRow(tab: TabItem, event: DragEvent<HTMLElement>, together?: readonly string[]): void
  dragStartFolder(folder: Folder, event: DragEvent<HTMLElement>): void
  dragEnd(): void
  /** ⌥↑ / ⌥↓ on a focused row: its tab one place up or down its group, the focus staying on it. Absent: the keys do nothing more than the arrows. */
  moveRow?(tab: TabItem, direction: -1 | 1): void
  clearSelection(): void
  /** The card of a row: `point` is where the pointer rests, or the middle of the row when the keyboard brought the focus to it. */
  hoverStart(tab: TabItem, row: HTMLElement, point: { clientX: number }): void
  hoverEnd(): void
  /** The tab tree is on: the rows say whether they are pinned (a drop on a pinned tab never means "under it"). Absent: the rows are the default ones. */
  tree?: boolean
  /** Mode compact, in the floating sidebar: the tab on screen shows its address in place of its title, and a click on it edits the address. Absent: the rows are the default ones. */
  compact?: { fullUrl: boolean; edit(tab: TabItem): void; siteInfo(): void }
}

export const SidebarUiContext = createContext<SidebarUi | null>(null)

export function useSidebarUi(): SidebarUi {
  const ui = useContext(SidebarUiContext)
  if (!ui) throw new Error('sidebar row rendered outside the sidebar')
  return ui
}

/**
 * The context the rows read, kept the same object for as long as what it holds is the same. The sidebar builds a new one at each render
 * (its functions close over that render's state); handed to the rows as it is, it would redraw every row at every snapshot and make
 * their `memo` worthless. The functions here are fixed ones that call the latest of the sidebar's; the data decides when it is a new object.
 */
export function useStableUi(next: SidebarUi): SidebarUi {
  const latest = useRef(next)
  latest.current = next
  const calls = useRef<Pick<SidebarUi, 'clickRow' | 'menuRow' | 'dragStartRow' | 'dragStartFolder' | 'dragEnd' | 'moveRow' | 'clearSelection' | 'hoverStart' | 'hoverEnd'> | null>(null)
  calls.current ??= {
    clickRow: (tab, event) => latest.current.clickRow(tab, event),
    menuRow: (tab, event) => latest.current.menuRow(tab, event),
    dragStartRow: (tab, event, together) => latest.current.dragStartRow(tab, event, together),
    dragStartFolder: (folder, event) => latest.current.dragStartFolder(folder, event),
    dragEnd: () => latest.current.dragEnd(),
    moveRow: (tab, direction) => latest.current.moveRow?.(tab, direction),
    clearSelection: () => latest.current.clearSelection(),
    hoverStart: (tab, row, event) => latest.current.hoverStart(tab, row, event),
    hoverEnd: () => latest.current.hoverEnd()
  }
  const key = rowsContextKey(next)
  return useMemo(() => {
    const now = latest.current
    return {
      selected: now.selected,
      dragging: now.dragging,
      mark: now.mark,
      developerHosts: now.developerHosts,
      containers: now.containers,
      ...(now.proxyMarks ? { proxyMarks: now.proxyMarks } : {}),
      badges: now.badges,
      ...calls.current!,
      ...(now.tree ? { tree: true } : {}),
      ...(now.compact ? { compact: { fullUrl: now.compact.fullUrl, edit: (tab: TabItem) => latest.current.compact?.edit(tab), siteInfo: () => latest.current.compact?.siteInfo() } } : {})
    }
    // The key is the content of everything but the functions.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the key is the content of everything but the functions
  }, [key])
}

/** The class that draws the insertion mark or highlight on the row named `key`. */
export const markClass = (mark: Located | null, key: string): string => (mark?.at === key ? `drop-${mark.edge}` : '')

export function Favicon({ tab }: { tab: Pick<TabItem, 'faviconUrl' | 'url' | 'title'> }) {
  // An icon that cannot be loaded (gone, blocked, not an image) shows the globe icon, not the browser's broken-image mark.
  const [failed, setFailed] = useState<string | null>(null)
  // The picture is the copy the main process keeps of the icon, never the site's address (shared/site-icon.ts).
  const source = iconSource(tab.faviconUrl)
  if (source && failed !== tab.faviconUrl) return <img className="favicon" src={source} alt="" draggable={false} onError={() => setFailed(tab.faviconUrl ?? null)} />
  // The Extensions page has no site, so no letter to stand for it: a puzzle piece.
  if (isInternalPageUrl(tab.url)) return <ExtensionsFaviconIcon className="favicon favicon-icon-fallback" />
  // No icon of its own: the first letter of its domain on a colour of its own; the globe only for a page without an address.
  const stand = monogramFor(tab.url)
  if (stand) return <span className="favicon monogram" aria-hidden="true" style={{ background: monogramGround(stand.hue) }}>{stand.letter}</span>
  return <FaviconIcon className="favicon favicon-icon-fallback" />
}

/** The icon of a tab: its picture or its emoji when the user chose one, else its favicon (TabPicture.tsx); a developer tab wears a badge. */
function TabIcon({ tab, developer, container, proxy, failed = false }: { tab: TabItem; developer: boolean; container?: Container | undefined; proxy?: ProxyMarkReason | undefined; failed?: boolean }) {
  return (
    <span className="tab-icon">
      <TabMark tab={tab} />
      {developer && <DeveloperBadge />}
      {tab.private && <PrivateBadge />}
      {container && <ContainerBadge name={container.name} color={container.color} />}
      {proxy && <ProxyBadge reason={proxy} />}
      {/* A red dot on the icon of a page that did not load. The words are in the label of the row, so the colour is not the only signal. */}
      {failed && <span className="tab-error-dot" aria-hidden="true" />}
    </span>
  )
}

/** The container a tab is in, for its badge (a private tab has none). */
const containerOf = (ui: SidebarUi, tab: TabItem): Container | undefined => (tab.container !== undefined && tab.private !== true ? ui.containers.find((c) => c.id === tab.container) : undefined)

/** Puts the cursor in a field that has just appeared, with its text selected, so that typing replaces the name. */
function useSelectOnMount(field: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [field])
}

/** Renames in place (double-click): Enter or leaving the field keeps the name, Escape drops it, an empty name gives the page's title back. */
function RenameField({ tab, onDone }: { tab: TabItem; onDone: () => void }) {
  const act = api()
  const field = useRef<HTMLInputElement>(null)
  useSelectOnMount(field)
  const finish = (name: string | null) => {
    if (name !== null && name !== tabName(tab)) void act.dispatch({ type: 'tab/rename', id: tab.id, title: name })
    onDone()
  }
  return (
    <input
      ref={field}
      className="tab-input"
      aria-label={t('sidebar.nom-de-l-onglet')}
      defaultValue={tabName(tab)}
      maxLength={120}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(e.currentTarget.value)
        if (e.key === 'Escape') finish(null)
      }}
    />
  )
}

interface RowProps {
  tab: TabItem
  active: boolean
  inSplit: boolean
  runtime: RuntimeState
  /** The row is a stop of the Tab key: the selected one, or (when none is on screen) every one. The arrow keys move between rows. */
  tabbable?: boolean
  /** The tab is part of the tab tree (it has a parent or children): how it is drawn. Absent for a flat row. */
  tree?: TreeRow
}

/** Moves the focus to the previous or next tab row of the sidebar (the rows of every section, in the order they are drawn). `row` is the button of a row. */
export function focusSibling(row: HTMLElement, step: 1 | -1): boolean {
  const rows = [...(row.closest('.sidebar')?.querySelectorAll<HTMLElement>('.tab > .tab-main') ?? [])]
  const target = rows[rows.indexOf(row) + step]
  target?.focus()
  return target !== undefined
}

/** The middle of a row, where the card of a row the keyboard focused is placed (a pointer gives its own place). */
export const middleOf = (row: Element): { clientX: number } => {
  const box = row.getBoundingClientRect()
  return { clientX: box.left + box.width / 2 }
}

/** Opens the card of a row for a focus the keyboard gave (`:focus-visible`): a click focuses the row too, and the pointer already has its card. */
export function focusCard(event: { target: EventTarget | null }, open: () => void): void {
  if (event.target instanceof Element && event.target.matches(':focus-visible')) open()
}

function TabRowView({ tab, active, inSplit, runtime, tabbable = active, tree }: RowProps) {
  const act = api()
  const ui = useSidebarUi()
  const info = runtime.tabs[tab.id]
  const row = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  // The selected tab stays in view when it changes (next tab, reveal in sidebar, restored tab).
  useEffect(() => {
    if (active) row.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const asleep = !info?.awake
  // Setting `tabStateBadges`: what the page is doing, as classes the CSS draws and a few marks. Off, `states` is empty and the row is the default one.
  const states = tabStates(ui.badges, info)
  // A frozen page is not awake either, but it keeps its document and is not dimmed like a sleeping one.
  const dimmed = asleep && !(ui.badges && info?.frozen === true)
  // What the cross does (shared/tab-close.ts): a Today tab is archived, an open pinned tab is put to sleep, a sleeping one leaves the pinned ones.
  const dismiss = () => void act.dispatch({ type: tabCloseAction(tab, asleep), id: tab.id })
  const dismissLabel = tab.pinned ? (asleep ? t('sidebar.retirer-cet-onglet-epingle') : t('sidebar.fermer-et-garder-epingle')) : t('sidebar.archiver-cet-onglet')
  const away = tab.pinned && !!tab.anchorUrl && tab.url !== tab.anchorUrl
  // A frozen page can run again from its row (« Dégeler l'onglet »), without being shown or reloaded.
  const frozen = info?.frozen === true
  // With a speaker, a "back" or a thaw button on the row, the cross keeps its place (hidden) so nothing moves under the pointer when it arrives.
  const aux = !!(info?.audible || info?.muted) || info?.capturedBy !== undefined || away || frozen
  // Compact mode: the tab on screen is the address (its title is a click away in the menu: Renommer…).
  const address = active ? ui.compact : undefined
  const classes = ['tab', tree && tree.depth > 0 && 'tree-child', address && 'address', aux && 'has-aux', tab.private && 'private-tab tk-dark', active && 'active', ui.selected.has(tab.id) && 'selected', inSplit && 'in-split', dimmed && !active && 'asleep', ...tabStateClasses(states), ui.dragging.has(tab.id) && 'dragging', editing && 'editing', markClass(ui.mark, `tab:${tab.id}`)]
  // « Actualiser tous les onglets » marks the rows it covers: to come (a quiet ring), under way (the loading ring, from the start of its turn), and
  // « Actualisé » a moment after (a sleeping tab is asleep again by then: the mark is what says it was reloaded). Not on a page still loading or that failed.
  const reloadMark = runtime.reloadMarks?.[tab.id]
  const reloading = reloadMark === 'running' && !info?.loading
  const reloadedMark = reloadMark === 'reloaded' && !info?.loading && info?.failed !== true
  const markSaid = reloadMark === 'reloaded' && !reloadedMark ? undefined : reloadMark
  // The words of the states join the name of the row (a page that failed, one that sleeps, its turn in a reload): the loading ring and the sound button have names of their own.
  const spoken = states.filter((state) => state === 'error' || state === 'asleep' || state === 'frozen')
  const said = [...spoken.map(tabStateLabel), ...reloadMarkWords(markSaid)]
  const rowName = said.length > 0 ? [tabName(tab), ...said].join(', ') : tabName(tab)

  // The keys of the row's button, the one stop of the Tab key on it (the way a list of tabs does). Return and Space click the button, as any button does
  // (the click reaches the row); the arrows move between the rows, ⌥↑ / ⌥↓ move the row itself (as in Gérer les espaces), Delete archives it, F2 renames
  // it. The row itself is not a button: it holds one, and the buttons beside that one (the sound, the back, the close) keep their own.
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault()
      ui.moveRow?.(tab, e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      focusSibling(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1)
    } else if (tree && tree.below > 0 && (e.key === (tree.folded ? 'ArrowRight' : 'ArrowLeft'))) {
      // The arrows fold and open a branch, as they do in a tree: left folds an open one, right opens a folded one.
      e.preventDefault()
      void act.dispatch({ type: 'tab/tree-collapse', id: tab.id, collapsed: !tree.folded })
    } else if (e.key === 'Delete') {
      e.preventDefault()
      // The focus goes to a neighbour first: the row is about to leave.
      if (!focusSibling(e.currentTarget, 1)) focusSibling(e.currentTarget, -1)
      dismiss()
    } else if (e.key === 'F2') {
      e.preventDefault()
      ui.hoverEnd()
      setEditing(true)
    }
  }
  const icon = (
    <>
      <TabIcon tab={tab} developer={isDeveloperUrl(tab.url, ui.developerHosts)} container={containerOf(ui, tab)} proxy={ui.proxyMarks?.get(tab.id)} failed={states.includes('error')} />
      {inSplit && <span className="split-mark" title={t('sidebar.dans-une-vue-scindee')}>⫼</span>}
    </>
  )
  return (
    <div
      ref={row}
      className={classes.filter(Boolean).join(' ')}
      style={tree && tree.depth > 0 ? ({ '--tree-depth': tree.depth } as CSSProperties) : undefined}
      draggable={!editing}
      data-drop="tab"
      data-id={tab.id}
      data-pinned={ui.tree ? String(tab.pinned) : undefined}
      onDragStart={(e) => ui.dragStartRow(tab, e)}
      onDragEnd={ui.dragEnd}
      onClick={(e) => {
        // The tab on screen is the address: a plain click edits it (the command bar, on the address); with a modifier it is a row like the others.
        if (address && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
          ui.hoverEnd()
          address.edit(tab)
        } else ui.clickRow(tab, e)
      }}
      onDoubleClick={(e) => {
        if (address) return
        if ((e.target as HTMLElement).closest('.tab-button')) return
        e.preventDefault()
        ui.hoverEnd()
        setEditing(true)
      }}
      onAuxClick={(e) => e.button === 1 && dismiss()}
      onContextMenu={(e) => ui.menuRow(tab, e)}
      onMouseEnter={(e) => ui.hoverStart(tab, e.currentTarget, e)}
      onMouseLeave={ui.hoverEnd}
      // The card also comes to a focus the keyboard gave (the arrows, Tab), not only to a pointer that rests.
      onFocus={(e) => focusCard(e, () => ui.hoverStart(tab, e.currentTarget, middleOf(e.currentTarget)))}
      onBlur={ui.hoverEnd}
    >
      {editing ? (
        <>
          {icon}
          <RenameField tab={tab} onDone={() => setEditing(false)} />
        </>
      ) : (
        <button type="button" className="tab-main" tabIndex={tabbable ? 0 : -1} aria-label={rowName} aria-current={active ? 'true' : undefined} onKeyDown={onKey}>
          {icon}
          <span className="tab-title">{address ? compactAddress(tab.url, address.fullUrl) : tabName(tab)}</span>
        </button>
      )}
      {tab.autoReload && <AutoReloadMark tabId={tab.id} autoReload={tab.autoReload} reloadAt={info?.reloadAt} />}
      {tree && tree.below > 0 && (
        <button
          className={`tab-button tree-toggle ${tree.folded ? 'folded' : ''}`}
          title={tree.folded ? t('ctx.deplier-les-onglets-enfants') : t('ctx.replier-les-onglets-enfants')}
          aria-label={tree.folded ? t('sidebar-rows.deplier-les-onglets-enfants-below', { below: tree.below }) : t('ctx.replier-les-onglets-enfants')}
          aria-expanded={!tree.folded}
          onClick={(e) => {
            e.stopPropagation()
            void act.dispatch({ type: 'tab/tree-collapse', id: tab.id })
          }}
        >
          <ChevronGlyph folded={tree.folded} />
          {tree.folded && <span className="tree-count">{tree.below}</span>}
        </button>
      )}
      {address && (
        <button
          className="tab-button site-info"
          title={t('toolbar.infos-et-reglages-du-site')}
          aria-label={t('toolbar.infos-et-reglages-du-site')}
          onClick={(e) => {
            e.stopPropagation()
            address.siteInfo()
          }}
        >
          {CONNECTION_MARKS[connectionState(tab.url, info?.untrustedCertificate === true)]}
        </button>
      )}
      {(info?.loading || reloading) && (
        <span className="spinner" role="img" aria-label={t('sidebar.chargement')}>
          <LoadingRing arc />
        </span>
      )}
      {reloadMark === 'pending' && (
        <span className="tab-reload-mark pending" role="img" title={t('sidebar.a-actualiser')} aria-label={t('sidebar.a-actualiser')}>
          <LoadingRing arc={false} />
        </span>
      )}
      {reloadedMark && (
        <span className="tab-reload-mark reloaded" role="img" title={t('sidebar.actualise')} aria-label={t('sidebar.actualise')}>
          <ReloadedGlyph />
        </span>
      )}
      {info?.unread !== undefined && (
        <span className="tab-message-badge" role="img" title={t('sidebar.messages-non-lus')} aria-label={tp('sidebar.messages-non-lus-count', info.unread)}>
          {info.unread}
        </span>
      )}
      {/* A site that says it has something to read without a number (Slack: "!" a mention or a direct message, "*" any unread message): the same badge, with the mark. */}
      {info?.unread === undefined && info?.unreadMark !== undefined && (
        <span className="tab-message-badge" role="img" title={t('sidebar.messages-non-lus')} aria-label={t('sidebar.messages-non-lus')}>
          {info.unreadMark === '!' ? '!' : '•'}
        </span>
      )}
      {/* The icon of the page changed while the tab was in the background (shared/icon-mark.ts): a dot, with the switch on. */}
      {ui.badges && info?.changedIcon === true && <span className="tab-icon-dot" role="img" title={t('sidebar.icone-changee')} aria-label={t('sidebar.icone-changee')} />}
      {/* "zz" shows when the pointer or the focus is on a sleeping row (CSS). Neither it nor the snowflake of a frozen page exists with the switch off. */}
      {states.includes('asleep') && <span className="tab-zz" aria-hidden="true">zz</span>}
      {/* « Dégeler l'onglet »: with the switch on, the snowflake of the frozen page is the button, and turns into a drop under the pointer or the
          focus; with it off, the button shows only then, like the cross. A 28 px target either way. */}
      {frozen && (
        <button
          type="button"
          className={`tab-button tab-thaw ${states.includes('frozen') ? 'marked' : 'hover-only'}`}
          title={t('sidebar.degeler-l-onglet')}
          aria-label={t('sidebar.degeler-l-onglet')}
          onClick={(e) => {
            e.stopPropagation()
            act.thawTab(tab.id)
          }}
        >
          {states.includes('frozen') && (
            <span className="tab-frozen" aria-hidden="true">
              <FrozenGlyph />
            </span>
          )}
          <span className="tab-thaw-glyph" aria-hidden="true">
            <ThawGlyph />
          </span>
        </button>
      )}
      {/* Its video floats in Lucium's window: the mark brings that window to the front (the place of its page offers to bring the video back). */}
      {info?.floating === true && (
        <button
          type="button"
          className="tab-button tab-floating"
          title={t('sidebar.video-flottante-montrer-la-fenetre')}
          aria-label={t('sidebar.video-flottante-montrer-la-fenetre')}
          onClick={(e) => {
            e.stopPropagation()
            act.floatingVideoTab(tab.id, 'show')
          }}
        >
          <FloatingVideoGlyph />
        </button>
      )}
      {/* An extension captures the sound of this tab: the mark says who, and a click stops the capture. */}
      {info?.capturedBy !== undefined && (
        <button
          type="button"
          className="tab-button tab-captured"
          title={t('tab-capture.name-capte-le-son-de-cet-onglet', { name: info.capturedBy })}
          aria-label={t('tab-capture.arreter-la-capture-du-son-par-name', { name: info.capturedBy })}
          onClick={(e) => {
            e.stopPropagation()
            act.stopTabCapture(tab.id)
          }}
        >
          <CapturedGlyph />
        </button>
      )}
      {(info?.audible || info?.muted) && (
        <button
          className="tab-button tab-sound"
          data-label={ui.badges ? (info.muted ? t('sidebar.reactiver-le-son-de-l-onglet') : t('sidebar.couper-le-son-de-l-onglet')) : undefined}
          title={ui.badges ? undefined : info.muted ? t('sidebar.reactiver-le-son-de-l-onglet') : t('sidebar.couper-le-son-de-l-onglet')}
          // Named by what it does, with its state beside: named by the state alone ("Son coupé"), nothing said that pressing it brings the sound back.
          aria-label={t('sidebar.couper-le-son-de-l-onglet')}
          aria-pressed={!!info.muted}
          onClick={(e) => {
            e.stopPropagation()
            act.toggleMute(tab.id)
          }}
        >
          <SpeakerGlyph muted={!!info.muted} />
        </button>
      )}
      {away && (
        <button
          className="tab-button hover-only"
          title={t('sidebar.revenir-a-l-adresse-epinglee')}
          aria-label={t('sidebar.revenir-a-l-adresse-epinglee')}
          onClick={(e) => {
            e.stopPropagation()
            void act.dispatch({ type: 'tab/back-to-anchor', id: tab.id })
          }}
        >
          <BackToPinGlyph />
        </button>
      )}
      <button
        className="tab-button tab-close hover-only"
        title={dismissLabel}
        aria-label={dismissLabel}
        onClick={(e) => {
          e.stopPropagation()
          dismiss()
        }}
      >
        <CloseGlyph />
      </button>
    </div>
  )
}

/** A row is drawn again only when what it draws changed (see row-equality.ts), not at every snapshot. */
export const TabRow = memo(TabRowView, sameTabRow)

/** The tabs to take out of a split view to undo it: all but the last, which is left alone in a view of one (that is no view). */
export function unsplitOrder<T>(tabs: readonly T[]): T[] {
  return tabs.slice(0, -1)
}

/** Undoes a split view from its handle: the tabs stay, one beside the other in the list. */
function undoSplit(act: ReturnType<typeof api>, tabs: readonly TabItem[]): void {
  for (const tab of unsplitOrder(tabs)) void act.dispatch({ type: 'split/remove', tabId: tab.id })
}

/** The tabs of a split view as one sidebar row, with a pill for each. */
function SplitRowView({ tabs, anchor, activeId, runtime, view }: { tabs: TabItem[]; anchor: string; activeId: string | null | undefined; runtime: RuntimeState; view?: { emoji: string; name: string } | undefined }) {
  const act = api()
  const ui = useSidebarUi()
  const current = tabs.some((t) => t.id === activeId)
  // The cross at the end of the row closes every tab of the view at once, each the way its own cross would (shared/tab-close.ts).
  const archives = tabs.every((tab) => !tab.pinned && !tab.private)
  const closeLabel = archives ? t('sidebar.archiver-les-onglets-de-la-vue-scindee', { count: tabs.length }) : t('sidebar.fermer-les-onglets-de-la-vue-scindee', { count: tabs.length })
  const closeAll = () => {
    ui.hoverEnd()
    for (const action of splitCloseActions(tabs, (id) => !runtime.tabs[id]?.awake)) void act.dispatch(action)
  }
  // The row stands where `anchor` (the first of its tabs in the list) is: a mark before or after the row is one before or after that tab.
  return (
    <div
      className={`split-row ${current ? 'current' : ''} ${tabs.every((t) => ui.dragging.has(t.id)) ? 'dragging' : ''} ${markClass(ui.mark, `tab:${anchor}`)}`}
      data-drop="tab"
      data-id={anchor}
      draggable
      onDragStart={(e) => ui.dragStartRow(tabs[0]!, e, tabs.map((t) => t.id))}
      onDragEnd={ui.dragEnd}
    >
      {/* The split view of a work view wears its icon, named for a screen reader: the tile after the favourites is lit while it is on screen. */}
      {view && (
        <span className="split-view-mark" role="img" aria-label={t('work-view.marque-de-la-rangee', { name: view.name })}>
          {view.emoji}
        </span>
      )}
      {tabs.map((tab, i) => (
        <Fragment key={tab.id}>
          {/* The handle between two panes. A click undoes the view (the tabs stay, one beside the other in the list), ← → trade the pane with its neighbour. */}
          {i > 0 && (
            <button
              type="button"
              className="split-grip"
              title={t('sidebar.poignee-de-la-vue-scindee')}
              aria-label={t('sidebar.poignee-de-la-vue-scindee')}
              onClick={(e) => {
                e.stopPropagation()
                undoSplit(act, tabs)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') undoSplit(act, tabs)
                else if (e.key === 'ArrowLeft') void act.dispatch({ type: 'split/move', tabId: tab.id, direction: -1 })
                else if (e.key === 'ArrowRight') void act.dispatch({ type: 'split/move', tabId: tabs[i - 1]!.id, direction: 1 })
                else return
                e.preventDefault()
              }}
            >
              <svg viewBox="0 0 8 16" width="8" height="16" fill="currentColor" aria-hidden="true">
                <circle cx="2.500" cy="4" r="1.100" />
                <circle cx="5.500" cy="4" r="1.100" />
                <circle cx="2.500" cy="8" r="1.100" />
                <circle cx="5.500" cy="8" r="1.100" />
                <circle cx="2.500" cy="12" r="1.100" />
                <circle cx="5.500" cy="12" r="1.100" />
              </svg>
            </button>
          )}
          <button
            className={`split-pill ${tab.id === activeId ? 'active' : ''} ${runtime.tabs[tab.id]?.awake === false && tab.id !== activeId ? 'asleep' : ''}`}
            aria-current={tab.id === activeId ? 'true' : undefined}
            onClick={() => {
              ui.clearSelection()
              void act.dispatch({ type: 'tab/select', id: tab.id })
            }}
            onMouseEnter={(e) => ui.hoverStart(tab, e.currentTarget, e)}
            onMouseLeave={ui.hoverEnd}
            onFocus={(e) => focusCard(e, () => ui.hoverStart(tab, e.currentTarget, middleOf(e.currentTarget)))}
            onBlur={ui.hoverEnd}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              ui.hoverEnd()
              act.showMenu({ kind: 'tab', id: tab.id, anchor: rectOf(e.currentTarget) })
            }}
          >
            <TabIcon tab={tab} developer={isDeveloperUrl(tab.url, ui.developerHosts)} container={containerOf(ui, tab)} proxy={ui.proxyMarks?.get(tab.id)} />
            <span className="tab-title">{tabName(tab)}</span>
          </button>
        </Fragment>
      ))}
      <button
        type="button"
        className="tab-button tab-close split-close"
        title={closeLabel}
        aria-label={closeLabel}
        onClick={(e) => {
          e.stopPropagation()
          closeAll()
        }}
      >
        <CloseGlyph />
      </button>
    </div>
  )
}

export const SplitRow = memo(SplitRowView, sameSplitRow)

export function Section({ children }: { children: ReactNode }) {
  return <section>{children}</section>
}

/**
 * The children of a folder. They stay mounted while the folder closes, so that it can close in about 0.2 s (a slide of the rows
 * under it, no fade) and go away once it has; a folder that is open when the sidebar appears does not animate.
 */
function FolderBody({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open)
  const [expanded, setExpanded] = useState(open)
  // Settled: fully open and still, so what sticks out of the rows (the insertion mark, the focus ring) is no longer clipped.
  const [settled, setSettled] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      // Two frames: the closed state must have been painted for the transition to have something to start from.
      let second = 0
      const first = requestAnimationFrame(() => (second = requestAnimationFrame(() => setExpanded(true))))
      const done = setTimeout(() => setSettled(true), FOLDER_ANIMATION_MS + 60)
      return () => {
        cancelAnimationFrame(first)
        cancelAnimationFrame(second)
        clearTimeout(done)
      }
    }
    setExpanded(false)
    setSettled(false)
    const timer = setTimeout(() => setMounted(false), FOLDER_ANIMATION_MS + 40)
    return () => clearTimeout(timer)
  }, [open])
  if (!mounted) return null
  return (
    <div className={`folder-body ${expanded ? 'expanded' : ''} ${settled ? 'settled' : ''}`}>
      <div className="folder-body-inner">{children}</div>
    </div>
  )
}

/** The field that renames a folder in place: Enter or leaving it keeps the name, Escape drops it. */
function FolderField({ name, onCommit }: { name: string; onCommit: (name: string | null) => void }) {
  const field = useRef<HTMLInputElement>(null)
  useSelectOnMount(field)
  return (
    <input
      ref={field}
      className="folder-input"
      aria-label={t('sidebar.nom-du-dossier')}
      defaultValue={name}
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(e.currentTarget.value)
        if (e.key === 'Escape') onCommit(null)
      }}
    />
  )
}

/** A folder: its row (the state is the icon, no chevron), then its tabs and the folders inside it, 16 px deeper. */
export function FolderBlock({ folder, first, side, children }: { folder: Folder; first: boolean; /** A root folder at the start of Today or under its tabs (it says so to the drop code, see `RowBox.side`). */ side?: 'today-start' | 'bottom'; children: ReactNode }) {
  const [editing, setEditing] = useState(false)
  const act = api()
  const ui = useSidebarUi()
  const commit = (name: string | null) => {
    setEditing(false)
    if (name !== null && name.trim() && name !== folder.name) void act.dispatch({ type: 'folder/rename', id: folder.id, name })
  }
  const mark = markClass(ui.mark, `folder:${folder.id}`)
  return (
    <div className="folder">
      {editing ? (
        <div className="folder-title editing">
          <span className="folder-icon">
            <FolderIcon open={!folder.collapsed} />
          </span>
          <FolderField name={folder.name} onCommit={commit} />
        </div>
      ) : (
        <button
          className={`folder-title ${folder.collapsed ? '' : 'open'} ${ui.dragging.has(`folder:${folder.id}`) ? 'dragging' : ''} ${mark}`}
          draggable
          data-drop="folder"
          data-id={folder.id}
          data-parent={folder.parentId ?? ''}
          data-first={first}
          data-side={side}
          aria-expanded={!folder.collapsed}
          onClick={() => void act.dispatch({ type: 'folder/toggle', id: folder.id })}
          onDoubleClick={() => setEditing(true)}
          // F2 renames it too, from the keyboard (the double-click and the menu are the pointer's and the menu's).
          onKeyDown={(e) => {
            if (e.key !== 'F2') return
            e.preventDefault()
            setEditing(true)
          }}
          onDragStart={(e) => ui.dragStartFolder(folder, e)}
          onDragEnd={ui.dragEnd}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            act.showMenu({ kind: 'folder', id: folder.id })
          }}
        >
          <span className="folder-icon">
            <FolderIcon open={!folder.collapsed} />
          </span>
          <span className="folder-name">{folder.name}</span>
          {/* A folder whose tabs are never woken by themselves (the menu's tick): a moon at the end of its row. */}
          {folder.noWake === true && (
            <span className="folder-asleep" role="img" title={t('sidebar.dossier-endormi')} aria-label={t('sidebar.dossier-endormi')}>
              <MoonGlyph size={13} />
            </span>
          )}
        </button>
      )}
      <FolderBody open={!folder.collapsed}>{children}</FolderBody>
    </div>
  )
}
