import { memo, useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { RuntimeState, Space, TabItem } from '@shared/model'
import { siteRequest } from '@shared/site-request'
import { toolbarTint } from '@shared/theme'
import { toolbarAddress } from '@shared/toolbar'
import { sameToolbar } from '@shared/row-equality'
import { addressLabel, saysNotSecure } from '@shared/url'
import { displayAddress } from '@shared/internal-page'
import type { ToolbarKeys } from '@shared/keybindings'
import { NOTES_LIST_REQUEST } from '@shared/notes'
import { READABLE_LABELS, READABLE_NEXT, type ReadableMode } from '@shared/readable-mode'
import { translateSentence, type TranslateOffer } from '@shared/translate-quick'
import { api } from './api'
import { AppMenuButton } from './AppMenuButton'
import { ExtensionActions } from './ExtensionActions'
import { HostText } from './HostText'
import { hideTooltip, tipProps } from './tooltip'
import { rectOf } from './anchor'
import { t } from '@shared/i18n'
import './toolbar.css'
import { COPIED_MS, useTransient } from './transient'

/** Line icons on a 20 px grid with a 1.5 px stroke: the weight and size of SF Symbols in a toolbar. */
function Icon({ children, size = 20, stroke = 1.5 }: { children: ReactNode; size?: number; stroke?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

/** SF Symbols' `sidebar.left`: a rounded frame, a divider, three ticks in the narrow part. */
export const SidebarIcon = () => (
  <Icon size={20}>
    <rect x="2.500" y="3.500" width="15" height="13" rx="3" />
    <path d="M8 3.500v13M4.800 7h1.400M4.800 10h1.400M4.800 13h1.400" />
  </Icon>
)

/** « Plier la barre »: the frame of the window with its sidebar, and a chevron that folds it towards the sidebar's edge (mirrored with the window). */
export const FoldSidebarIcon = () => (
  <Icon>
    <rect x="3" y="3.500" width="14" height="13" rx="2.500" />
    <path d="M8 3.500v13M13.500 8l-2 2 2 2" />
  </Icon>
)

/** « Déplier la barre », at the foot of the docked column: two chevrons towards the page (drawn for a column at the left; mirrored at the right). */
export const UnfoldSidebarIcon = () => (
  <Icon>
    <path d="M5 5l5 5-5 5M10 5l5 5-5 5" />
  </Icon>
)

// Two arrows chasing each other: it lives in the sidebar header (next to the sidebar button), the icon is kept with the others.
export const ReloadAllIcon = () => (
  <Icon>
    <path d="M4 9.500a6 6 0 0 1 10.500-3.600M16 3.500v3.400h-3.400M16 10.500a6 6 0 0 1-10.500 3.600M4 16.500v-3.400h3.400" />
  </Icon>
)

// One arrow with a dot in it: the tabs of this space only (the other icon, two arrows, is every space).
export const ReloadSpaceIcon = () => (
  <Icon>
    <path d="M16 10a6 6 0 1 1-1.800-4.300M16 3.500v3.400h-3.400" />
    <circle cx="10" cy="10" r="1.200" fill="currentColor" />
  </Icon>
)

// "Annoter la page": a pencil with its tip, the band by its eraser and the stroke it is drawing, inside the grid like the other icons.
const PencilIcon = () => (
  <Icon>
    <path className="tb-tint-pen" d="M3.5 15.75L4.77 12.22L11.84 5.15A1.6 1.6 0 0 1 14.1 7.41L7.03 14.48Z" />
    <path d="M4.77 12.22L7.03 14.48M10.71 6.28L12.97 8.54" />
    <path d="M10 16c1-1 2-1 3 0s2 1 3 0" />
  </Icon>
)

// "Toutes les notes": two sheets one behind the other, the one in front with two lines of text and its sheet tinted as the note's, the other showing its edge above and at the right.
export const NotesListIcon = () => (
  <Icon>
    <path d="M6 5.250V4.500A1.750 1.750 0 0 1 7.750 2.750H15A1.750 1.750 0 0 1 16.750 4.500V13A1.750 1.750 0 0 1 15 14.750h-.750" />
    <path className="tb-tint-note" d="M5 5.250h7.500A1.750 1.750 0 0 1 14.250 7v8.500A1.750 1.750 0 0 1 12.500 17.250H5A1.750 1.750 0 0 1 3.250 15.500V7A1.750 1.750 0 0 1 5 5.250Z" />
    <path d="M6 9.250h5.500M6 12.250h3.500" />
  </Icon>
)

/**
 * The button « Toutes les notes », the only button of the notes in the toolbar (a new note is made from the panel it opens, from File › Nouvelle note and
 * with ⌥⌘E): it asks for the panel on « Toutes » (NOTES_LIST_REQUEST: File › Notes and ⇧⌘E ask
 * without a scope, and get the page's notes when it has some). `keys`: the shortcut of File › Notes as it is set now (Réglages › Raccourcis), for the tooltip. No hook: a test calls it as a function.
 */
export function NotesListButton({ keys }: { keys: readonly string[] }) {
  return (
    <button className="tb-button tb-note tb-note-all" aria-label={t('toolbar.toutes-les-notes')} {...tipProps(t('toolbar.toutes-les-notes'), keys.length > 0 ? [...keys] : undefined)} onClick={() => api().openOverlay(NOTES_LIST_REQUEST)}>
      <NotesListIcon />
    </button>
  )
}

/**
 * The icon of a readable mode, on the 20 px grid: Original is a painter's palette with four dots of paint (the site's own colours), Dark a
 * crescent moon, Light a sun with its eight rays. Each is one simple shape that tells the others apart at 20 px.
 */
export function ReadableIcon({ mode }: { mode: ReadableMode }) {
  switch (mode) {
    case 'dark':
      return (
        <Icon>
          <path className="tb-readable-tint" d="M17.5 10.66A7.5 7.5 0 1 1 9.34 2.5a5.83 5.83 0 0 0 8.16 8.16z" />
        </Icon>
      )
    case 'light':
      return (
        <Icon>
          <circle className="tb-readable-tint" cx="10" cy="10" r="3.2" />
          <path d="M10 2.4v2M10 15.6v2M2.4 10h2M15.6 10h2M4.63 4.63l1.41 1.41M13.96 13.96l1.41 1.41M15.37 4.63l-1.41 1.41M6.04 13.96l-1.41 1.41" />
        </Icon>
      )
    case 'original':
      return (
        <Icon>
          <path d="M10 2.75a7.25 7.25 0 0 0 0 14.5c0.9 0 1.5-0.6 1.5-1.4 0-0.4-0.15-0.7-0.4-1-0.25-0.3-0.4-0.6-0.4-1 0-0.8 0.6-1.4 1.4-1.4h1.6a3.55 3.55 0 0 0 3.55-3.55C17.25 5.75 14 2.75 10 2.75z" />
          <circle className="tb-paint-1" cx="6.4" cy="9.6" r="1.1" fill="currentColor" />
          <circle className="tb-paint-2" cx="7.9" cy="6.4" r="1.1" fill="currentColor" />
          <circle className="tb-paint-3" cx="11.4" cy="5.6" r="1.1" fill="currentColor" />
          <circle className="tb-paint-4" cx="14.2" cy="7.7" r="1.1" fill="currentColor" />
        </Icon>
      )
  }
}

/**
 * The button « Contraste de la page », before the site control center. Its icon is the mode the page's site has (its own choice, else the default; see
 * `readableButtonMode`). A click moves the page to the next mode: Original, Dark, Light, then Original again (`toggleReadable`, decided in the main
 * process by `readableToggle`). A right click, the Menu key or Shift+F10 open the native menu of every mode (context-menus.ts, kind
 * `readable`). Its name is the current mode; what a click does is its tooltip and its description. No hook: a test calls it as a function.
 */
export function ReadableButton({ mode, tabId }: { mode: ReadableMode; tabId: string }) {
  const label = t('toolbar.contraste-de-la-page-name', { name: READABLE_LABELS[mode].name })
  // What a click does: the next mode of the cycle (READABLE_NEXT), said as an action.
  const action = { dark: t('toolbar.passer-en-sombre'), light: t('toolbar.passer-en-clair'), original: t('toolbar.revenir-a-l-original') }[READABLE_NEXT[mode]]
  const openMenu = () => api().showMenu({ kind: 'readable', id: tabId })
  return (
    <button
      className="tb-button tb-readable"
      data-mode={mode}
      aria-label={label}
      aria-description={t('toolbar.contraste-de-la-page-description', { action })}
      {...tipProps(t('toolbar.contraste-de-la-page-tip', { action }))}
      onClick={() => api().toggleReadable(tabId)}
      onContextMenu={(event) => {
        event.preventDefault()
        openMenu()
      }}
      // The key that opens a context menu from the keyboard: Chromium does not do it on every system, so it is asked for here (once: the key is handled).
      onKeyDown={(event) => {
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
        event.preventDefault()
        openMenu()
      }}
    >
      <ReadableIcon mode={mode} />
    </button>
  )
}

/**
 * « Traduction de la page »: the 文 and the A of a translation, the A on a small card of colour (a fill: the strokes keep the ink of the bar, like the other
 * glyphs). The card is fuller once the page is translated, and breathes while it is being translated.
 */
export const TranslateIcon = () => (
  <Icon>
    <rect className="tb-tint-lang" x="10" y="8" width="8.5" height="10" rx="2" stroke="none" />
    <path d="M3 5h8M7 3v2M5 5c0 3 2 5 5 6M9 5c0 2-2 5-5 6M11 17l3.5-8L18 17M12.2 14.5h4.6" />
  </Icon>
)

/**
 * The button « Traduction de la page », shown for a page in another language than the target (offered), a page being translated (busy) and a translated one
 * (pressed). A click opens its popover, hung from it (TranslatePopover.tsx): translate or show the original, « Toujours traduire… », « Ne jamais traduire ce
 * site », another language, the full panel. Its name says what it is; its state, the sentence of the popover. No hook: a test calls it as a function.
 */
export function TranslateButton({ offer }: { offer: TranslateOffer }) {
  const sentence = translateSentence(offer)
  return (
    <button
      className="tb-button tb-translate"
      data-state={offer.state}
      aria-label={t('translate.button-name')}
      aria-description={sentence}
      aria-haspopup="dialog"
      aria-busy={offer.state === 'working' ? true : undefined}
      {...tipProps(sentence)}
      onClick={(event) => api().openOverlay({ panel: 'translatepop', anchor: rectOf(event.currentTarget) })}
    >
      <TranslateIcon />
    </button>
  )
}

const SplitIcon = () => (
  <Icon>
    <rect className="tb-tint-pane" x="3.75" y="3.75" width="6.25" height="12.5" rx="1.75" stroke="none" />
    <rect x="3" y="3" width="14" height="14" rx="2.500" />
    <path d="M10 3v14" />
  </Icon>
)

interface ToolbarProps {
  space: Space
  current: TabItem | undefined
  runtime: RuntimeState
  sidebarVisible: boolean
  /** What the settings change about how the bar looks and behaves. */
  fullUrl: boolean
  draggable: boolean
  /** "125 %" while the page of this strip is zoomed (and the setting is on): a mark that puts the page back to 100 % when clicked. */
  zoomMark?: string | null
  /** Opens the command bar on the current address (clicking the address) or on a new split pane. */
  canSplit: boolean
  /** One strip of a split view: placed over its own pane. */
  pane?: { style: CSSProperties; focused: boolean; onSelect: () => void; onClose: () => void }
  /** The sidebar is at the right of the window: its button (when it is hidden) ends the bar instead of starting it. */
  sidebarRight?: boolean
  /** Room kept empty at the start of the bar for the traffic lights, which stay at the window's left edge when the sidebar is at the right. */
  leading?: number
  /** Setting `tabStateBadges`: a thin line at the foot of the bar while the page loads. Off, the bar draws nothing for it. */
  badges?: boolean
  /** The page annotation is on (by default; LUCIUM_ANNOTATE=0 turns it off, from the sources or in a smoke run only): the button « Annoter » is shown. */
  annotate?: boolean
  /**
   * The button « Toutes les notes » (see `showsNotesListButton`: the notes and this button on, not a private window), with
   * the keys of the shortcut of File › Notes for the tooltip (empty without one). Absent: no button.
   */
  notesList?: readonly string[]
  /** The keys the tooltips show, as the shortcuts are set now (Réglages › Raccourcis). Absent: tooltips without keys. */
  keys?: ToolbarKeys | undefined
  /**
   * The button « Contraste de la page »: the mode the page on screen has (see `readableButtonMode`: a web page that is not a PDF, the setting on, not a private tab or
   * window). Absent: no button. In a split view only the focused pane's strip draws it; the page it is for is the one that has the focus.
   */
  readable?: ReadableMode
  /**
   * The button « Traduction de la page »: what is offered for the page on screen (shared/translate-quick.ts `translateOffer`: a web page in another language
   * than the target, or translated). Absent: no button. In a split view only the focused pane's strip draws it.
   */
  translate?: TranslateOffer
  /** The button ☰ starts the bar: the window has no menu bar (Windows), so the menu of the application is opened from here. */
  menu?: boolean
  /** The buttons of the system lie over the end of this bar (the window's top right): its last group leaves them room (the stylesheet reads their width from the system). */
  underControls?: boolean
}

/** A bar that is not told the shortcuts in force draws its tooltips without keys: no system is assumed, so no glyph of another one is shown. */
const DEFAULT_KEYS: ToolbarKeys = { toggleSidebar: [], back: [], forward: [], reload: [], copyUrl: [], siteInfo: [], closeSplitPane: [], addSplit: [], zoomReset: [], annotate: [] }

/** How long a press on back or forward lasts before the page history opens (the button then does not navigate). */
const LONG_PRESS_MS = 500
/** Whether a press on Back or Forward may become a long press: the main button alone, and not with Control, which macOS reads as a right click. */
const armsLongPress = (e: { button: number; ctrlKey: boolean }): boolean => e.button === 0 && !e.ctrlKey

/**
 * The bar above the page (the toolbar): navigation on the left, the address in the middle, extensions and page
 * controls on the right. Its height is TOOLBAR_BAR_HEIGHT; the page view sits right below it.
 */
function ToolbarView({ space, current, runtime, sidebarVisible, fullUrl, draggable, canSplit, zoomMark = null, pane, sidebarRight = false, leading = 0, badges = false, annotate = false, notesList, keys = DEFAULT_KEYS, readable, translate, menu = false, underControls = false }: ToolbarProps) {
  const act = api()
  // A tooltip with the keys of its command as they are set now; a command the user left without a shortcut shows its text alone.
  const tip = (text: string, command: keyof ToolbarKeys) => tipProps(text, keys[command].length > 0 ? [...keys[command]] : undefined)
  const [copied, showCopied] = useTransient(false, COPIED_MS)
  const rootRef = useRef<HTMLDivElement>(null)
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)

  // The address is centred on the bar and may not run into either group: it gets the room left by the wider of the two.
  useLayoutEffect(() => {
    const [root, left, right] = [rootRef.current, leftRef.current, rightRef.current]
    if (!root || !left || !right) return
    const measure = () => root.style.setProperty('--tb-side', `${Math.ceil(Math.max(left.offsetWidth + leading, right.offsetWidth))}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(left)
    observer.observe(right)
    return () => observer.disconnect()
  }, [leading])

  // A long press (or a right click) on back or forward lists the pages this tab went through.
  const press = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressed = useRef(false)
  const disarm = () => {
    if (press.current) clearTimeout(press.current)
    press.current = null
  }
  const history = (id: 'back' | 'forward') => ({
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault()
      // The native menu takes the pointer: the page may never see the button come up, and a press still armed would open the menu a second time.
      disarm()
      act.showMenu({ kind: 'nav', id })
    },
    // The same list from the keyboard, with the Menu key or Shift+F10: a long press and a right click are the pointer's alone.
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return
      e.preventDefault()
      act.showMenu({ kind: 'nav', id })
    },
    // These replace the tooltip's own mouse handlers on the same button, so they put the tooltip away themselves.
    onMouseDown: (e: MouseEvent) => {
      hideTooltip()
      longPressed.current = false
      disarm()
      // A right click and a Control-click open the menu at once (onContextMenu): only a plain press of the main button can become a long press.
      if (!armsLongPress(e)) return
      press.current = setTimeout(() => {
        press.current = null
        longPressed.current = true
        act.showMenu({ kind: 'nav', id })
      }, LONG_PRESS_MS)
    },
    onMouseUp: disarm,
    onMouseLeave: () => {
      hideTooltip()
      disarm()
    }
  })
  // A press still armed when the toolbar goes would open a menu for a button that is no longer there.
  useEffect(() => disarm, [])
  const go = (command: 'back' | 'forward' | 'reload') => () => {
    // The press that opened the history menu is not a click on the button.
    if (longPressed.current && command !== 'reload') {
      longPressed.current = false
      return
    }
    act.nav(command)
  }

  // In a split view each strip shows its own page's state; a pane that is not the focused one takes focus on the first press.
  const tabInfo = current ? runtime.tabs[current.id] : undefined
  // Back on the first page of a tab opened from a link closes the tab: the button stays enabled.
  const canGoBack = pane ? tabInfo?.canGoBack === true || tabInfo?.backCloses === true : runtime.canGoBack || runtime.backCloses === true
  const canGoForward = pane ? tabInfo?.canGoForward === true : runtime.canGoForward
  const address = current ? toolbarAddress(current.url, fullUrl) : { host: '', rest: '' }
  // What stands where the host is read is taken from the address alone, never from the title, which the page writes (`addressLabel`).
  const addressName = current ? address.host || addressLabel(current.url) : ''
  const insecure = current ? saysNotSecure(current.url, tabInfo?.untrustedCertificate === true) : false
  // A split view's strips are always dark; a single page's bar takes the colour the page declares.
  const color = !pane && current ? tabInfo?.color : undefined
  const tint = color ? toolbarTint(color) : {}
  // The main process copies (it does not depend on this window having the focus) and says so in a toast; the glyph confirms it too.
  const copy = () => {
    if (!current) return
    act.copyUrl()
    showCopied(true)
  }

  return (
    <div
      ref={rootRef}
      className={`page-toolbar ${pane ? 'pane tk-dark' : ''} ${pane?.focused ? 'focused' : ''} ${draggable ? 'draggable' : ''}`}
      style={{ ...tint, ...(leading > 0 ? { paddingLeft: 5 + leading } : {}), ...pane?.style } as CSSProperties}
      onMouseDown={pane && !pane.focused ? pane.onSelect : undefined}
    >
      <div className="tb-left" ref={leftRef}>
        {menu && <AppMenuButton className="tb-button" />}
        {!sidebarVisible && !pane && !sidebarRight && (
          <button className="tb-button" aria-label={t('toolbar.afficher-la-barre-laterale')} {...tip(t('toolbar.afficher-la-barre-laterale'), 'toggleSidebar')} onClick={() => void act.dispatch({ type: 'settings/update', patch: { sidebarVisible: true } })}>
            <SidebarIcon />
          </button>
        )}
        <button className="tb-button" aria-label={t('toolbar.precedent')} {...tip(t('toolbar.page-precedente'), 'back')} disabled={!canGoBack} onClick={go('back')} {...history('back')}>
          <Icon>
            <path d="M16 10H4.500M9 5l-4.500 5L9 15" />
          </Icon>
        </button>
        <button className="tb-button" aria-label={t('toolbar.suivant')} {...tip(t('toolbar.page-suivante'), 'forward')} disabled={!canGoForward} onClick={go('forward')} {...history('forward')}>
          <Icon>
            <path d="M4 10h11.500M11 5l4.500 5L11 15" />
          </Icon>
        </button>
        <button className="tb-button" aria-label={t('toolbar.actualiser')} {...tip(t('toolbar.actualiser-la-page'), 'reload')} onClick={go('reload')}>
          <Icon>
            <path d="M16 10a6 6 0 1 1-1.900-4.400M16 3.500v3.600h-3.600" />
          </Icon>
        </button>
      </div>

      <div className="tb-address">
        <div className="tb-address-inner">
          {/* The link glyph is the "copy the URL" button, the text opens the command bar on the address. */}
          <button className="tb-link" aria-label={t('toolbar.copier-l-adresse')} disabled={!current} {...tip(t('toolbar.copier-l-adresse'), 'copyUrl')} onClick={copy}>
            {copied ? (
              <Icon size={16}>
                <path d="M4.500 10.500l3.500 3.500 7.500-8" />
              </Icon>
            ) : (
              <Icon size={16}>
                <path d="M8.500 11.500a3.500 3.500 0 0 0 5 0l2.500-2.500a3.500 3.500 0 0 0-5-5L9.500 5M11.500 8.500a3.500 3.500 0 0 0-5 0L4 11a3.500 3.500 0 0 0 5 5l1-1" />
              </Icon>
            )}
          </button>
          <button className="tb-url" aria-label={addressName ? t('toolbar.modify-address', { host: addressName }) : t('toolbar.saisir-une-adresse')} onClick={() => act.openOverlay({ panel: 'commandbar', mode: 'current', initial: current ? displayAddress(current.url) : '' })}>
            {addressName ? (
              <>
                {address.host ? <HostText host={address.host} className="tb-host" /> : <span className="tb-host">{addressName}</span>}
                {address.rest && <span className="tb-rest">{address.rest}</span>}
              </>
            ) : (
              <span className="tb-host tb-placeholder">{t('toolbar.rechercher-ou-saisir-une-adresse')}</span>
            )}
          </button>
          {/* The "Privé" chip, in a private window (shown by `html.private`) and on a private tab of a normal one. */}
          <span className={`tb-chip ${current?.private ? 'on' : ''}`}>{t('toolbar.prive')}</span>
          {/* A page that came without encryption from another machine, or over a certificate that was let through although it was not valid (`saysNotSecure`): said in words, never a padlock. */}
          {insecure && (
            <span className="tb-insecure" title={tabInfo?.untrustedCertificate === true ? t('toolbar.certificat-non-valide-accepte') : t('toolbar.connexion-http-sans-chiffrement')}>
              {t('toolbar.non-securise')}
            </span>
          )}
          {/* An empty 24 px slot on the right of the text, so that the text itself is centred on the bar. */}
          {/* A private tab wears the glasses of the private window in that slot. */}
          <span className={`tb-slot ${current?.private ? 'tb-private' : ''}`} aria-hidden={current?.private ? undefined : true} role={current?.private ? 'img' : undefined} aria-label={current?.private ? t('toolbar.onglet-prive') : undefined} title={current?.private ? t('toolbar.onglet-prive-rien-n-est-enregistre') : undefined}>
            {current?.private && (
              <Icon size={16}>
                <circle cx="6" cy="12.500" r="3" />
                <circle cx="14" cy="12.500" r="3" />
                <path d="M9 12h2M3.200 12 4.500 5.500H7M16.800 12 15.500 5.500H13" />
              </Icon>
            )}
          </span>
        </div>
      </div>

      <div className="tb-right" ref={rightRef}>
        {pane ? (
          <>
            {/* Only the focused pane's strip carries the extension icons and the page controls (the other one has the address and ✕ only). */}
            {/* An extension captures the sound of the page of this strip: said here, and a click stops it. */}
            {pane.focused && current && tabInfo?.capturedBy !== undefined && <CaptureMark by={tabInfo.capturedBy} tabId={current.id} />}
            {pane.focused && zoomMark && <ZoomMark mark={zoomMark} keys={keys.zoomReset} />}
            {pane.focused && <ExtensionActions partition={`persist:profile-${space.profileId}`} profileId={space.profileId} bar={rootRef} left={leftRef} right={rightRef} />}
            {/* The page annotation belongs to the focused pane's strip: the page that has the focus is the one it annotates (browser.ts annotationTarget). */}
            {pane.focused && annotate && (
              <button className="tb-button" aria-label={t('toolbar.annoter-la-page')} {...tip(t('toolbar.annoter-la-page-titre'), 'annotate')} onClick={() => api().annotatePage()}>
                <PencilIcon />
              </button>
            )}
            {/* The list of the notes is the same whichever pane has the focus: one button for the window, in the focused strip. */}
            {pane.focused && notesList && <NotesListButton keys={notesList} />}
            {/* The translation is the focused page's: the button belongs to the focused pane's strip. */}
            {pane.focused && translate && <TranslateButton offer={translate} />}
            {/* The mode is the focused page's, as the control center's is: the button belongs to the focused pane's strip, before it. */}
            {pane.focused && readable && current && <ReadableButton mode={readable} tabId={current.id} />}
            {pane.focused && (
              <button className="tb-button tb-control" aria-label={t('toolbar.infos-et-reglages-du-site')} {...tip(t('toolbar.infos-et-reglages-du-site'), 'siteInfo')} disabled={!current} onClick={() => act.openOverlay(siteRequest(rootRef.current))}>
                <ControlIcon />
              </button>
            )}
            {pane.focused && (
              <button className="tb-button" aria-label={t('toolbar.options-de-la-vue-scindee')} {...tipProps(t('toolbar.options-de-la-vue-scindee'))} disabled={!current} onClick={() => current && act.showMenu({ kind: 'split', id: current.id })}>
                <SplitIcon />
              </button>
            )}
            <button className="tb-button tb-close" aria-label={t('toolbar.fermer-ce-volet')} {...tip(t('toolbar.fermer-ce-volet'), 'closeSplitPane')} onClick={pane.onClose}>
              <Icon stroke={2}>
                <path d="M5.500 5.500l9 9M14.500 5.500l-9 9" />
              </Icon>
            </button>
          </>
        ) : (
          <>
            {/* An extension captures the sound of the page on screen: said here, and a click stops it. */}
            {current && tabInfo?.capturedBy !== undefined && <CaptureMark by={tabInfo.capturedBy} tabId={current.id} />}
            {zoomMark && <ZoomMark mark={zoomMark} keys={keys.zoomReset} />}
            <ExtensionActions partition={`persist:profile-${space.profileId}`} profileId={space.profileId} bar={rootRef} left={leftRef} right={rightRef} />
            {annotate && (
              <button className="tb-button" aria-label={t('toolbar.annoter-la-page')} {...tip(t('toolbar.annoter-la-page-titre'), 'annotate')} onClick={() => api().annotatePage()}>
                <PencilIcon />
              </button>
            )}
            {notesList && <NotesListButton keys={notesList} />}
            {translate && <TranslateButton offer={translate} />}
            {readable && current && <ReadableButton mode={readable} tabId={current.id} />}
            <button className="tb-button tb-control" aria-label={t('toolbar.infos-et-reglages-du-site')} {...tip(t('toolbar.infos-et-reglages-du-site'), 'siteInfo')} disabled={!current} onClick={() => act.openOverlay({ panel: 'site' })}>
              <ControlIcon />
            </button>
            <button className="tb-button" aria-label={t('toolbar.ajouter-une-vue-scindee')} {...tip(t('toolbar.ajouter-une-vue-scindee'), 'addSplit')} disabled={!canSplit} onClick={() => act.openOverlay({ panel: 'commandbar', mode: 'split', initial: '' })}>
              <SplitIcon />
            </button>
            {!sidebarVisible && sidebarRight && (
              <button className="tb-button show-sidebar" aria-label={t('toolbar.afficher-la-barre-laterale')} {...tip(t('toolbar.afficher-la-barre-laterale'), 'toggleSidebar')} onClick={() => void act.dispatch({ type: 'settings/update', patch: { sidebarVisible: true } })}>
                <SidebarIcon />
              </button>
            )}
          </>
        )}
        {/* The room for the buttons of the system over the end of the bar: empty, as wide as what of them lies over this bar (the stylesheet knows it). It is in the group so that the address, which is centred, keeps clear of it too. */}
        {underControls && <span className="tb-controls-room" aria-hidden="true" />}
      </div>
      {/* A line of 2 px under the bar while this page loads: it has no figure to show (the shell knows loading or not), so it moves. Only with the marks of `tabStateBadges` on. */}
      {badges && current !== undefined && runtime.tabs[current.id]?.loading === true && <div className="tb-progress" role="progressbar" aria-label={t('tab-state.chargement')} />}
    </div>
  )
}

/** Drawn again only when what it shows changed (see row-equality.ts): a background tab that retitles itself does not touch the bar of the page on screen. */
export const Toolbar = memo(ToolbarView, sameToolbar)

/** An extension is capturing the sound of this page: the ring of a recording, with the name of the extension in its tooltip. A click is « Arrêter la capture du son ». */
function CaptureMark({ by, tabId }: { by: string; tabId: string }) {
  return (
    <button className="tb-button tb-capture" aria-label={t('tab-capture.arreter-la-capture-du-son-par-name', { name: by })} {...tipProps(t('tab-capture.name-capte-le-son-de-cet-onglet', { name: by }))} onClick={() => api().stopTabCapture(tabId)}>
      <Icon size={16}>
        <circle cx="10" cy="10" r="6.500" />
        <circle cx="10" cy="10" r="2.500" fill="currentColor" stroke="none" />
      </Icon>
    </button>
  )
}

/** The page is not at 100 %: its zoom, small and quiet, in the right group; a click is « Taille réelle » (the zoom of the site is forgotten), whose keys the tooltip shows. */
function ZoomMark({ mark, keys }: { mark: string; keys: readonly string[] }) {
  return (
    <button className="tb-zoom" aria-label={t('toolbar.zoom-aria', { mark })} {...tipProps(t('toolbar.zoom-tip', { mark }), keys.length > 0 ? [...keys] : undefined)} onClick={() => api().resetZoom()}>
      {mark}
    </button>
  )
}

const ControlIcon = () => (
  <Icon>
    <rect x="2.500" y="2.500" width="15" height="15" rx="4" />
    <path d="M6 7h8M6 13h8" />
    <circle className="tb-knob-1" cx="8.500" cy="7" r="1.300" fill="currentColor" />
    <circle className="tb-knob-2" cx="11.500" cy="13" r="1.300" fill="currentColor" />
  </Icon>
)
