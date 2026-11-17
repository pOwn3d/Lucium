import { useEffect, useId, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import { pageColorBehind, popoverSurface } from '@shared/command-bar'
import { activeTab } from '@shared/sidebar'
import type { Boost, PermissionDecision, Settings } from '@shared/model'
import type { ExtensionInfo } from '@shared/ipc'
import type { ExtensionsRequest } from '@shared/extension-page'
import { ipcErrorText } from '@shared/ipc-error'
import { profileLabel } from '@shared/profiles'
import { connectionState, hostnameOf } from '@shared/url'
import { isDeveloperUrl } from '@shared/developer-mode'
import { MEDIA_PERMISSION, mayRemember, sitePermissionRows } from '@shared/permissions'
import { AUTOPLAY_LABELS, autoplayHostOf, autoplayModeFor, siteAutoplayOf, type AutoplayMode } from '@shared/autoplay'
import { BOOST_NAME_MAX } from '@shared/boost-share'
import { renamedBoost } from '@shared/boost-rows'
import { clearHostOfUrl, isClearedOnClose } from '@shared/site-clear'
import { READABLE_LABELS, isReadableWebPage, siteReadableOf, type ReadableMode } from '@shared/readable-mode'
import { blockingFacts, pageStorage, readSections, sectionSummary, sectionTitle, toggleSection, writeSections, type SectionSummary, type SiteFacts, type SiteSectionId } from '@shared/site-sections'
import { api, useSnapshot } from './api'
import { EXTENSIONS_PUZZLE_PATH } from './components/favicon-icon'
import { Shields } from './Shields'
import { SitePermissionRows } from './SitePermissions'
import './site-panel.css'
import { settingsPath } from '@shared/settings-path'

const GLYPH = { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

const SCC_TILES: Array<{ id: string; title: string; path: string }> = [
  { id: 'share', get title() { return t('keybindings.partager') }, path: 'M10 12.500V3.500M6.500 6.500 10 3l3.500 3.500M4.500 10v6a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-6' },
  { id: 'boost', get title() { return t('site-panel.retoucher-ce-site') }, path: 'M4 16 12 8M11 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM15 11l.6 1.200L17 13l-1.400.8L15 15l-.6-1.200L13 13l1.400-.8z' },
  { id: 'capture', get title() { return t('menu.capturer') }, path: 'M3 6.500h2.500L7 4.500h6l1.500 2H17a0 0 0 0 1 0 0V15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1ZM10 13.500a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z' },
  { id: 'find', get title() { return t('cmd.rechercher-dans-la-page') }, path: 'M4 7V5a1 1 0 0 1 1-1h2M13 4h2a1 1 0 0 1 1 1v2M16 13v2a1 1 0 0 1-1 1h-2M7 16H5a1 1 0 0 1-1-1v-2M7 8.500h6M7 11.500h4' }
]

/** The actions of the web tools, shown beside the four above only while their function is on (Réglages › Outils web, Traduction): the main process refuses their panels when the function is off, whoever asks. */
const TRANSLATE_TILE = { id: 'translate', get title() { return t('translate.translate') }, path: 'M3 5h8M7 3v2M5 5c0 3 2 5 5 6M9 5c0 2-2 5-5 6M11 17l3.500-8L18 17M12.200 14.500h4.600' }
const QR_TILE = { id: 'qr', get title() { return t('qr-panel.code-qr') }, path: 'M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h2v2h-2zM16 12v5M12 16h2' }

/** Glyphs of the setting rows, drawn in the disc: a hammer, a gear, an eraser, a moon and a speaker. */
const ROW_GLYPHS = {
  developer: 'm4 16 7.500-7.500M9 5l3-2 4.500 4.500-2 3-2.500-.500L9.500 7.500z',
  pip: 'M10 12.500a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5ZM10 2.500v2M10 15.500v2M2.500 10h2M15.500 10h2M4.700 4.700l1.400 1.400M13.900 13.900l1.400 1.400M4.700 15.300l1.400-1.400M13.900 6.100l1.400-1.400',
  erase: 'M3.500 12.500 10 6l5 5-4.500 4.500H7zM7 15.500h8M8 8l5 5',
  sound: 'M4 8.500h2.500L10 5.500v9l-3.500-3H4zM13 7.500a3.500 3.500 0 0 1 0 5',
  moon: 'M16 11.500A6.500 6.500 0 1 1 8.500 4a5.200 5.200 0 0 0 7.500 7.500z'
} as const

/**
 * The buttons of a Tweak's row, each a picture of what it does: a pencil with its band near the end, a tray with an arrow leaving it, and a bin
 * with its lid, its handle and two lines on its side. Drawn on the grid of the panel, side by side, never on top of one another.
 */
const BOOST_ACTION_GLYPHS = {
  edit: 'M4 16l.5-3.180 9.360-9.360a1.900 1.900 0 0 1 2.680 2.680L7.180 15.500zM12.160 5.160l2.680 2.680',
  export: 'M10 3.500v9M6.500 7 10 3.500 13.500 7M4 12v2.500A1.500 1.500 0 0 0 5.500 16h9a1.500 1.500 0 0 0 1.500-1.500V12',
  delete: 'M4 6h12M8 6V4.500a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V6M5.500 6l.750 9.600A1.500 1.500 0 0 0 7.750 17h4.500a1.500 1.500 0 0 0 1.500-1.400L14.500 6M8.500 9.200v4.600M11.500 9.200v4.600'
} as const

/** How long a click on the name of a Tweak waits for a second one before it flips the switch: a double-click there renames the Tweak. */
export const NAME_DOUBLE_CLICK_MS = 300

const Disc = ({ on, children }: { on?: boolean; children: ReactNode }) => <span className={`scc-badge ${on ? 'on' : ''}`}>{children}</span>
const RowGlyph = ({ path }: { path: string }) => (
  <svg {...GLYPH} width="16" height="16">
    <path d={path} />
  </svg>
)

/** The glyph of the footer for each state of the connection: a padlock, a warning triangle, and the "i" of a page that has none. */
const CONNECTION_GLYPHS = {
  secure: 'M5.500 9V6.500a4.500 4.500 0 0 1 9 0V9M4.500 9h11v7.500h-11z',
  insecure: 'M10 3 18 16.500H2zM10 8.500v4M10 14.500v.01',
  none: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM10 9.500v4M10 6.500v.01'
} as const

/**
 * The glyphs of the row of the extensions: a folder with the brackets of code in it (an extension loaded from a folder, which reads apart from
 * the « + » beside it and from the picture of an extension), and the barred disc of an extension that is off.
 */
const EXTENSION_GLYPHS = {
  folder: 'M2 15V5a1.500 1.500 0 0 1 1.500-1.500h3.300a1.500 1.500 0 0 1 1.100.500L9.400 5.500h7.100A1.500 1.500 0 0 1 18 7v8a1.500 1.500 0 0 1-1.500 1.500h-13A1.500 1.500 0 0 1 2 15ZM8.300 8.800 6 11l2.300 2.200M11.700 8.800 14 11l-2.300 2.200',
  off: 'M10 16.500a6.500 6.500 0 1 0 0-13 6.500 6.500 0 0 0 0 13ZM5.400 14.600l9.200-9.200'
} as const

/** The keys that open the menu of the tile that has the focus, as a right click does: the Menu key, and Shift+F10. */
const opensMenu = (event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean => event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)

/**
 * The extensions of the profile of the tab, each a tile, then « + » and, while the Chrome Web Store is on, the folder that loads an unpacked
 * extension (with the Store off, « + » does that already). A tile has a menu, opened by a right click, by its ⋯ (in view under the pointer and
 * with the focus of the keyboard) or by the Menu key or Shift+F10: switch the extension off or on, remove it after a question, reload a folder,
 * open its page of the Extensions window. An extension that is off stays in the row, faded, with a barred disc; a click on it opens that menu
 * instead of its action, which does not run while it is off. Each action is a request of the Extensions page (shared/extension-page.ts), checked
 * by the main process, whose refusal is said under the row.
 */
function SiteExtensions({ extensions, profileId, settings }: { extensions: ExtensionInfo[]; profileId: string; settings: Settings }) {
  const act = api()
  // The extension whose menu is open, or whose « Retirer ? » is asked (one at a time).
  const [menu, setMenu] = useState<{ id: string; confirm: boolean } | null>(null)
  // What the main process could not do, in words; and what it did, when it says so (reloaded, removed).
  const [problem, setProblem] = useState('')
  const [done, setDone] = useState('')
  // The tile whose menu was just left (Escape, an answer): it takes back the focus the menu had.
  const refocus = useRef<string | null>(null)
  const add = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const shown = menu ? extensions.find((e) => e.id === menu.id) : undefined
  const close = (id: string) => {
    refocus.current = id
    setMenu(null)
  }
  const open = (id: string) => {
    setProblem('')
    setMenu({ id, confirm: false })
  }
  const toggle = (id: string) => (menu?.id === id ? close(id) : open(id))
  const loadFolder = () => {
    setProblem('')
    setDone('')
    act.loadExtension().catch((error: unknown) => {
      console.warn('[extensions] the extension could not be added from the panel of the site:', error)
      setProblem(t('site-panel.l-extension-n-a-pas-pu-etre-ajoutee'))
    })
  }
  /** One request of the Extensions page; true when it was done. A refusal or a failure of the channel is said under the row and written to the log. */
  const send = async (request: ExtensionsRequest, extensionId: string): Promise<boolean> => {
    setProblem('')
    setDone('')
    try {
      const reply = await act.extensionsPage(request)
      if (reply.ok) {
        if (reply.message) setDone(reply.message)
        return true
      }
      console.warn(`[extensions] « ${request.op} » of ${extensionId} was refused from the panel of the site:`, reply.message)
      setProblem(reply.message ?? t('extpage.l-action-a-echoue-message', { message: t('errors.erreur-inattendue') }))
    } catch (error) {
      console.warn(`[extensions] « ${request.op} » of ${extensionId} failed from the panel of the site:`, error)
      setProblem(t('extpage.l-action-a-echoue-message', { message: (ipcErrorText(error) || t('errors.erreur-inattendue')).slice(0, 200) }))
    }
    return false
  }
  const switchTo = (extension: ExtensionInfo, enabled: boolean) => {
    close(extension.id)
    void send({ op: 'set-enabled', profileId, extensionId: extension.id, enabled }, extension.id)
  }
  const reload = (extension: ExtensionInfo) => {
    close(extension.id)
    void send({ op: 'reload', profileId, extensionId: extension.id }, extension.id)
  }
  const manage = (extension: ExtensionInfo) => {
    act.closeOverlay()
    act.openOverlay({ panel: 'extensions', target: { view: 'detail', extensionId: extension.id, profileId } })
  }
  // The same road as « Gérer… », without a target: the whole page, which the main process opens as a tab (or selects the tab that already has it).
  const openPage = () => {
    act.closeOverlay()
    act.openOverlay({ panel: 'extensions' })
  }
  // An extension of the Web Store leaves this profile with its data (the question was asked here: the box does not ask it again); a folder
  // leaves every profile and its files stay. The tile goes with it: the focus goes to « + », the next thing of the row.
  const remove = async (extension: ExtensionInfo) => {
    close(extension.id)
    const request: ExtensionsRequest = extension.source === 'store' ? { op: 'uninstall', profileId, extensionId: extension.id, asked: true } : { op: 'remove-folder', extensionId: extension.id }
    if (await send(request, extension.id)) add.current?.focus()
  }
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!shown) return
    if (event.key === 'Escape') {
      // The menu closes, not the panel: the key goes no further.
      event.preventDefault()
      event.stopPropagation()
      close(shown.id)
      return
    }
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown' ? (at + 1) % items.length : event.key === 'ArrowUp' ? (at - 1 + items.length) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null
    if (next === null) return
    event.preventDefault()
    items[next]?.focus()
  }
  // The focus given to anything else of the panel closes the menu; the tile and its ⋯ have their own way. A focus given to nothing (a click on the
  // card, a button of the menu that goes away) leaves it as it is.
  const onMenuBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Element | null
    if (!shown || !next || event.currentTarget.contains(next) || next.closest(`[data-extension="${shown.id}"]`)) return
    setMenu(null)
  }
  const question = shown ? t('site-panel.retirer-name-question', { name: shown.name }) : ''
  return (
    <>
      <div className="scc-extensions">
        {extensions.map((extension) => {
          const opened = menu?.id === extension.id
          const name = extension.enabled ? extension.name : t('site-panel.name-desactivee', { name: extension.name })
          const actions = t('site-panel.actions-de-name', { name: extension.name })
          return (
            <div key={extension.id} className={`scc-ext ${extension.enabled ? '' : 'off'} ${opened ? 'open' : ''}`} data-extension={extension.id}>
              <button
                type="button"
                ref={(tile) => {
                  if (!tile || refocus.current !== extension.id) return
                  refocus.current = null
                  tile.focus()
                }}
                className="scc-tile small"
                title={name}
                aria-label={name}
                // A tile that is off opens the menu (whose first entry is « Activer ») instead of an action that would not run.
                {...(extension.enabled ? {} : { 'aria-haspopup': 'menu' as const, 'aria-expanded': opened })}
                onClick={() => {
                  if (!extension.enabled) return toggle(extension.id)
                  setMenu(null)
                  act.activateExtension(extension.id)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  open(extension.id)
                }}
                onKeyDown={(event) => {
                  if (!opensMenu(event)) return
                  event.preventDefault()
                  open(extension.id)
                }}
              >
                <img
                  className="scc-ext-icon"
                  alt=""
                  src={`crx://extension-icon/${extension.id}/32/2?partition=${encodeURIComponent(`persist:profile-${profileId}`)}`}
                  onError={(e) => {
                    // An extension without an icon shows its initial instead.
                    e.currentTarget.replaceWith(document.createTextNode(extension.name.charAt(0).toUpperCase()))
                  }}
                />
                {!extension.enabled && (
                  <svg className="scc-ext-off" {...GLYPH} width="12" height="12" strokeWidth={2}>
                    <path d={EXTENSION_GLYPHS.off} />
                  </svg>
                )}
              </button>
              <button type="button" className="scc-ext-more" title={actions} aria-label={actions} aria-haspopup="menu" aria-expanded={opened} aria-controls={opened ? menuId : undefined} onClick={() => toggle(extension.id)}>
                <svg viewBox="0 0 20 20" width="12" height="12" fill="currentColor" aria-hidden="true">
                  <circle cx="4" cy="10" r="1.700" />
                  <circle cx="10" cy="10" r="1.700" />
                  <circle cx="16" cy="10" r="1.700" />
                </svg>
              </button>
            </div>
          )
        })}
        {/* The + opens the Chrome Web Store; with the installation from it switched off, it loads an unpacked extension as before. */}
        <button
          type="button"
          ref={add}
          className="scc-tile small"
          title={settings.webStoreInstall ? t('site-panel.ajouter-une-extension-depuis-le-chrome-web-store') : t('menu.ajouter-une-extension')}
          aria-label={t('site-panel.ajouter-une-extension')}
          onClick={() => {
            setProblem('')
            setDone('')
            if (settings.webStoreInstall) return act.openWebStore()
            loadFolder()
          }}
        >
          <svg {...GLYPH} width="16" height="16">
            <path d="M10 4v12M4 10h12" />
          </svg>
        </button>
        {settings.webStoreInstall && (
          <button type="button" className="scc-tile small scc-ext-folder" title={t('site-panel.charger-une-extension-non-empaquetee')} aria-label={t('site-panel.charger-une-extension-non-empaquetee')} onClick={loadFolder}>
            <svg {...GLYPH} width="16" height="16">
              <path d={EXTENSION_GLYPHS.folder} />
            </svg>
          </button>
        )}
        {/* The page of the extensions (the address chrome://extensions stands for): always there, whether or not the Web Store is on. The puzzle piece is drawn on a wider grid than the 20 of the others, so that its knobs are not cut. */}
        <button type="button" className="scc-tile small scc-ext-page" title={t('site-panel.ouvrir-la-page-extensions')} aria-label={t('site-panel.ouvrir-la-page-extensions')} onClick={openPage}>
          <svg {...GLYPH} viewBox="1 1 22 22" strokeWidth={1.75} width="16" height="16">
            <path d={EXTENSIONS_PUZZLE_PATH} />
          </svg>
        </button>
      </div>
      {/* Under the row, in the flow of the panel: never cut by the edge of the card, never over a tile. */}
      {shown && menu && (
        <div key={`${shown.id}:${menu.confirm ? 'confirm' : 'menu'}`} className="scc-ext-pop" onKeyDown={onMenuKey} onBlur={onMenuBlur}>
          {menu.confirm ? (
            <div className="scc-ext-confirm" role="group" aria-label={question}>
              <strong>{question}</strong>
              <p>{shown.source === 'store' ? t('extpage.l-extension-et-ses-donnees-seront-supprimees-du-profil', { profile: profileLabel(settings, profileId) }) : t('extpage.sort-l-extension-de-tous-les-profils-le-dossier-n-est-pas-touche')}</p>
              <div className="scc-ext-answers">
                {/* « Annuler » has the focus: a Return typed at once removes nothing. */}
                <button type="button" className="scc-ext-answer" autoFocus onClick={() => close(shown.id)}>
                  {t('confirm-box.annuler')}
                </button>
                <button type="button" className="scc-ext-answer danger" onClick={() => void remove(shown)}>
                  {t('site-panel.retirer')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="scc-ext-pop-name" aria-hidden="true">
                {shown.name}
              </p>
              <div id={menuId} className="scc-ext-menu" role="menu" aria-label={t('site-panel.actions-de-name', { name: shown.name })}>
                <button type="button" role="menuitem" className="scc-ext-item" autoFocus onClick={() => switchTo(shown, !shown.enabled)}>
                  {shown.enabled ? t('site-panel.desactiver') : t('site-panel.activer')}
                </button>
                {shown.source === 'unpacked' && shown.enabled && (
                  <button type="button" role="menuitem" className="scc-ext-item" onClick={() => reload(shown)}>
                    {t('extpage.recharger')}
                  </button>
                )}
                <button type="button" role="menuitem" className="scc-ext-item" onClick={() => manage(shown)}>
                  {t('site-panel.gerer')}
                </button>
                <div className="scc-ext-sep" role="separator" />
                <button type="button" role="menuitem" className="scc-ext-item danger" onClick={() => setMenu({ id: shown.id, confirm: true })}>
                  {t('site-panel.retirer-points')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {problem && (
        <p className="muted" role="alert">
          {problem}
        </p>
      )}
      {/* Always there, so that what is written in it is read out. */}
      <p className="muted scc-ext-done" role="status">
        {done}
      </p>
    </>
  )
}

/** The choices of the autoplay row, in the order a click goes through them: the general choice, then the site's own. */
const AUTOPLAY_CYCLE: Array<AutoplayMode | null> = [null, 'allow', 'block']

/** The choices of the readable-mode row, in the order a click goes through them: the default, then the site's own. */
const READABLE_CYCLE: Array<ReadableMode | null> = [null, 'dark', 'light', 'original']

/**
 * A section of the panel: a title that says what is inside, folds on a click, and keeps nothing mounted while it is folded. Its header has no tooltip:
 * it shows its name and its chevron already, and a tooltip under the pointer only hid the top of the line below (tooltip-repeats.test.ts).
 */
export function SiteSection({ id, open, summary, onToggle, children }: { id: SiteSectionId; open: boolean; summary: SectionSummary | null; onToggle(): void; children?: ReactNode }) {
  const title = sectionTitle(id)
  const body = `scc-section-${id}`
  return (
    <section className={`scc-section ${open ? 'open' : ''}`}>
      <button type="button" className="scc-section-head" aria-expanded={open} aria-controls={open ? body : undefined} onClick={onToggle}>
        <svg className="scc-section-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 3 5 5-5 5" />
        </svg>
        <span className="scc-section-title">{title}</span>
        {summary && <span className={`scc-section-sum ${summary.tone ?? ''}`}>{summary.text}</span>}
      </button>
      {open && (
        <div id={body} className="scc-section-body" role="group" aria-label={title}>
          {children}
        </div>
      )}
    </section>
  )
}

/**
 * The site control center: a popover under the toolbar button with the page
 * actions, the extensions, the Tweaks of the site, the settings of the site and the state of the connection. `closing` plays the
 * fold back to the button before the layer goes away (the host removes the panel once it is over).
 */
export function SitePanel({ closing = false }: { closing?: boolean }) {
  const snapshot = useSnapshot()
  const [confirmClear, setConfirmClear] = useState(false)
  // A Tweak of the list being renamed in place, or waiting for the answer to "Supprimer ?" (one at a time).
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  // Which sections are open: remembered between two openings of the panel (the page's own storage; unreadable or full, the panel opens on the defaults).
  const [sections, setSections] = useState(() => readSections(pageStorage()))
  // The Tweak whose « Supprimer ? » was answered « Annuler »: its bin comes back in place of the question, and takes the focus the answer had.
  const refocusDelete = useRef<string | null>(null)
  // The Tweak whose name was just given (Return) or left (Escape) from the keyboard: its switch takes the focus back, which the field had.
  const refocusSwitch = useRef<string | null>(null)
  // A click on the name of a Tweak may be the first of a double-click, which renames it: the switch waits that long before it flips, so
  // that a double-click never turns the Tweak off and on again (each flip of a Tweak with a script reloads the pages of its site).
  const pendingFlip = useRef<{ timer: ReturnType<typeof setTimeout>; flip: () => void } | null>(null)
  useEffect(
    () => () => {
      // The panel closed during the wait: the click still flips the Tweak.
      const pending = pendingFlip.current
      pendingFlip.current = null
      if (!pending) return
      clearTimeout(pending.timer)
      pending.flip()
    },
    []
  )
  const act = api()
  if (!snapshot) return null
  const { state, extensions } = snapshot
  const tab = activeTab(state)
  const surface = popoverSurface(pageColorBehind(tab ? (snapshot.runtime.tabs[tab.id]?.color ?? null) : undefined))
  const style = { '--scc-fill': surface.fill, '--scc-tile': surface.tile } as CSSProperties
  const arrow = (
    <svg className="scc-arrow" width="30" height="9" viewBox="0 0 30 9" aria-hidden="true">
      <path d="M0 9C7 9 9.500 0 15 0s8 9 15 9Z" fill="currentColor" />
    </svg>
  )
  if (!tab || !URL.canParse(tab.url)) {
    return (
      <div className={`scc ${closing ? 'closing' : ''}`} style={style} role="dialog" aria-label={t('settings.site')}>
        {arrow}
        <p className="muted">{t('site-panel.aucun-site-ouvert')}</p>
      </div>
    )
  }
  const url = new URL(tab.url)
  const host = hostnameOf(tab.url)
  const untrusted = snapshot.runtime.tabs[tab.id]?.untrustedCertificate === true
  const connection = connectionState(tab.url, untrusted)
  // The answers remembered for a page of a container are the container's own: the panel shows those, and forgets those.
  const container = tab.container !== undefined && tab.private !== true ? state.settings.containers.find((c) => c.id === tab.container) : undefined
  const answers = (container ? container.permissions?.[url.origin] : state.sitePermissions[url.origin]) ?? {}
  // The camera and the microphone have a row of their own, so that they can be allowed before a page asks (a window with no place for the question never shows it).
  // A private tab keeps nothing: an answer written for it would leave its site in the settings.
  const mediaAnswer = answers[MEDIA_PERMISSION]
  const mediaRow = tab.private !== true && !snapshot.private && mayRemember(url.origin, MEDIA_PERMISSION)
  const permissions = Object.entries(answers).filter(([permission]) => permission !== MEDIA_PERMISSION)
  // A container has answers of its own and none for every site; the profile's answers hold the one for the notifications of every site.
  const permissionRows = sitePermissionRows(container ? { [url.origin]: container.permissions?.[url.origin] ?? {} } : state.sitePermissions, url.origin, mediaRow)
  const decide = (permission: string, decision: PermissionDecision | null) =>
    void act.dispatch(container ? { type: 'container/permission', id: container.id, origin: url.origin, permission, decision } : { type: 'permission/set', origin: url.origin, permission, decision })
  const boosts = state.boosts.filter((b) => host === b.host || host.endsWith(`.${b.host}`))
  const cancelPendingFlip = () => {
    if (pendingFlip.current) clearTimeout(pendingFlip.current.timer)
    pendingFlip.current = null
  }
  const rename = (b: Boost) => {
    cancelPendingFlip()
    setRenaming({ id: b.id, name: b.name })
  }
  // A key (a click of detail 0) or a click beside the name flips the Tweak at once; a click on the name waits for a possible second one.
  const flipBoost = (b: Boost, event: { detail: number; target: EventTarget | null }) => {
    const flip = () => void act.dispatch({ type: 'boost/save', boost: { ...b, enabled: !b.enabled } })
    const onName = event.detail > 0 && (event.target as Element | null)?.closest?.('.scc-boost-name') != null
    cancelPendingFlip()
    if (!onName) return flip()
    // The second click of a double-click: the double-click renames, the switch stays as it was.
    if (event.detail > 1) return
    const timer = setTimeout(() => {
      pendingFlip.current = null
      flip()
    }, NAME_DOUBLE_CLICK_MS)
    pendingFlip.current = { timer, flip }
  }
  const developer = isDeveloperUrl(tab.url, state.settings.developerHosts)
  const ownAutoplay = siteAutoplayOf(state.settings.siteAutoplay, tab.url)
  const effectiveAutoplay = autoplayModeFor(state.settings, tab.url)
  const nextAutoplay = AUTOPLAY_CYCLE[(AUTOPLAY_CYCLE.indexOf(ownAutoplay) + 1) % AUTOPLAY_CYCLE.length] ?? null
  // What a private tab visits is not written to the settings: no per-site choice is offered for it.
  const clearable = !snapshot.private && tab.private !== true && clearHostOfUrl(tab.url) !== null
  const clearOnClose = state.settings.siteDataClearOnCloseEnabled && isClearedOnClose(state.settings.siteDataClearOnClose, tab.url)
  // The readable mode of the site: its own choice, else the default. Nothing is written for a private tab or window (their sites are not kept).
  const ownReadable = siteReadableOf(state.settings.siteReadableMode, tab.url)
  const readableShown = isReadableWebPage(tab.url) && tab.private !== true && !snapshot.private
  const shownReadable = ownReadable ?? state.settings.readableMode
  const nextReadable = READABLE_CYCLE[(READABLE_CYCLE.indexOf(ownReadable) + 1) % READABLE_CYCLE.length] ?? null
  const profileId = state.spaces.find((s) => s.id === tab.spaceId)?.profileId ?? 'default'
  // The copies of the profile of the tab, the ones that run in it: an extension of the Web Store lives in one profile, and the menu of a tile
  // switches off or removes the copy of this profile.
  const profileExtensions = [...new Map(extensions.filter((e) => e.profileId === profileId).map((e) => [e.id, e])).values()]
  const toggle = (id: SiteSectionId) => {
    const next = toggleSection(sections, id)
    setSections(next)
    writeSections(pageStorage(), next)
  }
  // What the titles say of the sections, so that the state reads without opening them.
  const blocking = blockingFacts(tab.url, tab.private === true, state.settings)
  const decisions = [...permissions.map(([, decision]) => decision), ...(mediaAnswer ? [mediaAnswer] : [])]
  // The autoplay of this site is always offered (but for a private tab, whose sites are not kept).
  const autoplayShown = tab.private !== true && autoplayHostOf(tab.url) !== null
  const facts: SiteFacts = {
    blocking: blocking.state,
    allowed: decisions.filter((d) => d === 'allow').length,
    denied: decisions.filter((d) => d === 'deny').length,
    clearOnClose: clearable && clearOnClose,
    // What is on for this site. Automatic Picture in Picture is not counted: it is one setting for every site, shown here for its switch.
    displayOn: [developer, readableShown && shownReadable !== 'original', autoplayShown && ownAutoplay === 'allow'].filter(Boolean).length,
    boosts: boosts.length,
    boostsOn: boosts.filter((b) => b.enabled).length,
    extensions: profileExtensions.length
  }
  const tiles = [...SCC_TILES, ...(state.settings.translateLocal ? [TRANSLATE_TILE] : []), ...(state.settings.qrCode ? [QR_TILE] : [])]
  const run = (id: string) => {
    if (id === 'share') {
      act.closeOverlay()
      act.shareSite()
    } else if (id === 'boost') act.openOverlay({ panel: 'boost', host })
    else if (id === 'capture') act.openOverlay({ panel: 'capture' })
    else if (id === 'find') act.openOverlay({ panel: 'find' })
    else if (id === 'translate') act.openOverlay({ panel: 'translate' })
    else if (id === 'qr') act.openOverlay({ panel: 'qr', text: tab.url })
  }

  return (
    <div className={`scc ${closing ? 'closing' : ''}`} style={style} role="dialog" aria-label={t('site-panel.infos-et-reglages-du-site')}>
      {arrow}
      <div className="scc-tiles">
        {tiles.map((tile) => (
          <button key={tile.id} className="scc-tile" aria-label={tile.title} onClick={() => run(tile.id)}>
            <svg {...GLYPH} width="20" height="20">
              <path d={tile.path} />
            </svg>
            <span>{tile.title}</span>
          </button>
        ))}
      </div>

      <div className="scc-scroll">
        {blocking.shown && (
          <SiteSection id="blocking" open={sections.blocking} summary={sectionSummary('blocking', facts)} onToggle={() => toggle('blocking')}>
            <Shields url={tab.url} tabId={tab.id} />
          </SiteSection>
        )}

        {permissionRows.length > 0 && (
          <SiteSection id="permissions" open={sections.permissions} summary={sectionSummary('permissions', facts)} onToggle={() => toggle('permissions')}>
            <SitePermissionRows rows={permissionRows} onDecide={decide} />
          </SiteSection>
        )}

        <SiteSection id="data" open={sections.data} summary={sectionSummary('data', facts)} onToggle={() => toggle('data')}>
          <button className="scc-setting" onClick={() => act.openOverlay({ panel: 'sitedata' })}>
            <Disc>
              <RowGlyph path={ROW_GLYPHS.erase} />
            </Disc>
            <span className="scc-setting-text">
              <strong>{t('site-panel.effacer-les-donnees')}</strong>
              <span>{t('site-panel.cookies-cache-stockage')}</span>
            </span>
          </button>

          {clearable && (
            <button className="scc-setting" title={t('site-panel.effacer-les-cookies-et-le-stockage-de-ce-site', { settingsPath: settingsPath('clearOnClose') })} role="switch" aria-checked={clearOnClose} onClick={() => void act.dispatch({ type: 'siteclear/site', site: tab.url, on: !clearOnClose, tabId: tab.id })}>
              <Disc on={clearOnClose}>
                <RowGlyph path={ROW_GLYPHS.erase} />
              </Disc>
              <span className="scc-setting-text">
                <strong>{t('site-panel.effacer-a-la-fermeture')}</strong>
                <span>{clearOnClose ? t('site-panel.active') : t('menu.desactive')}</span>
              </span>
            </button>
          )}
        </SiteSection>

        <SiteSection id="display" open={sections.display} summary={sectionSummary('display', facts)} onToggle={() => toggle('display')}>
          <button className="scc-setting" title={t('site-panel.mode-developpeur-pour-ce-site-d', { shortcut: shortcutSuffix('developerMode', state.settings.keyBindings, platformOf(snapshot.platform)) })} role="switch" aria-checked={developer} onClick={() => void act.dispatch({ type: 'developer/site', site: host, enabled: !developer })}>
            <Disc on={developer}>
              <RowGlyph path={ROW_GLYPHS.developer} />
            </Disc>
            <span className="scc-setting-text">
              <strong>{t('sidebar.mode-developpeur')}</strong>
              <span>{developer ? t('site-panel.active') : t('menu.desactive')}</span>
            </span>
          </button>
          {readableShown && (
            <button
              className="scc-setting"
              title={t('site-panel.contraste-de-la-page-pour-ce-site-hint', { hint: READABLE_LABELS[shownReadable].hint })}
              onClick={() => void act.dispatch({ type: 'readable/site', site: tab.url, mode: nextReadable, tabId: tab.id })}
            >
              <Disc on={shownReadable !== 'original'}>
                <RowGlyph path={ROW_GLYPHS.moon} />
              </Disc>
              <span className="scc-setting-text">
                <strong>{t('site-panel.contraste-de-la-page')}</strong>
                <span>{ownReadable === null ? t('site-panel.par-defaut-name', { name: READABLE_LABELS[state.settings.readableMode].name }) : READABLE_LABELS[ownReadable].name}</span>
              </span>
            </button>
          )}
          <button className="scc-setting" role="switch" aria-checked={state.settings.autoPictureInPicture} onClick={() => void act.dispatch({ type: 'settings/update', patch: { autoPictureInPicture: !state.settings.autoPictureInPicture } })}>
            <Disc on={state.settings.autoPictureInPicture}>
              <RowGlyph path={ROW_GLYPHS.pip} />
            </Disc>
            <span className="scc-setting-text">
              <strong>{t('site-panel.image-dans-l-image-automatique')}</strong>
              {/* The only row of the section that is not about this site alone: said in the row. */}
              <span>{state.settings.autoPictureInPicture ? t('site-panel.autorisee-pour-tous-les-sites') : t('site-panel.desactivee-pour-tous-les-sites')}</span>
            </span>
          </button>
          {autoplayShown && (
            <button
              className="scc-setting"
              title={t('site-panel.lecture-automatique-pour-ce-site-hint', { hint: AUTOPLAY_LABELS[effectiveAutoplay].hint })}
              onClick={() => void act.dispatch({ type: 'autoplay/site', site: tab.url, mode: nextAutoplay, tabId: tab.id })}
            >
              <Disc on={ownAutoplay === 'allow'}>
                <RowGlyph path={ROW_GLYPHS.sound} />
              </Disc>
              <span className="scc-setting-text">
                <strong>{t('site-panel.lecture-automatique')}</strong>
                <span>{ownAutoplay === null ? t('site-panel.par-defaut-name', { name: AUTOPLAY_LABELS[effectiveAutoplay].name }) : AUTOPLAY_LABELS[ownAutoplay].name}</span>
              </span>
            </button>
          )}
        </SiteSection>

        {boosts.length > 0 && (
          <SiteSection id="boosts" open={sections.boosts} summary={sectionSummary('boosts', facts)} onToggle={() => toggle('boosts')}>
            {boosts.map((b) =>
              deleting === b.id ? (
                // A key of its own: with the row's key React would keep the buttons of the row and only change what they say. The bin that was
                // just clicked, and has the focus, would become « Supprimer », and « Annuler » would not be mounted, so never take the focus.
                <div key={`${b.id}:confirm`} className="scc-boost-row scc-boost-confirm" role="group" aria-label={t('site-panel.supprimer-name-question', { name: b.name })}>
                  <span>{t('site-panel.supprimer-name-question', { name: b.name })}</span>
                  <button
                    type="button"
                    className="scc-mini"
                    autoFocus
                    onClick={() => {
                      refocusDelete.current = b.id
                      setDeleting(null)
                    }}
                  >
                    {t('confirm-box.annuler')}
                  </button>
                  <button
                    type="button"
                    className="scc-mini danger"
                    onClick={() => {
                      setDeleting(null)
                      void act.dispatch({ type: 'boost/delete', id: b.id })
                    }}
                  >
                    {t('site-panel.supprimer')}
                  </button>
                </div>
              ) : renaming?.id === b.id ? (
                <div key={b.id} className="scc-boost-row scc-boost-rename">
                  <input
                    className="scc-rename-field"
                    autoFocus
                    maxLength={BOOST_NAME_MAX}
                    aria-label={t('site-panel.nom-de-la-retouche')}
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: b.id, name: e.target.value })}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={() => setRenaming(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        refocusSwitch.current = b.id
                        setRenaming(null)
                      } else if (e.key === 'Enter') {
                        const name = renamedBoost(renaming.name, b.name)
                        refocusSwitch.current = b.id
                        setRenaming(null)
                        if (name !== null) void act.dispatch({ type: 'boost/save', boost: { ...b, name } })
                      }
                    }}
                  />
                </div>
              ) : (
              <div
                key={b.id}
                className="scc-boost-row"
                // F2 renames the Tweak from the keyboard, wherever the focus is in its row: the double-click on the name is the pointer's way.
                onKeyDown={(e) => {
                  if (e.key !== 'F2') return
                  e.preventDefault()
                  rename(b)
                }}
              >
                <button
                  ref={(row) => {
                    if (!row || refocusSwitch.current !== b.id) return
                    refocusSwitch.current = null
                    row.focus()
                  }}
                  className="scc-setting scc-boost"
                  role="switch"
                  aria-checked={b.enabled}
                  onClick={(e) => flipBoost(b, e)}
                >
                  <Disc on={b.enabled}>
                    <svg {...GLYPH} width="16" height="16">
                      <path d="M4 16 12 8M11 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
                    </svg>
                  </Disc>
                  <span className="scc-setting-text">
                    <strong className="scc-boost-name" onDoubleClick={() => rename(b)}>
                      {b.name}
                    </strong>
                    <span>{b.enabled ? t('site-panel.activee') : t('site-panel.desactivee')}</span>
                  </span>
                </button>
                {/* After the switch, in the order of the keyboard: edit, export, delete. Each one in view, beside the others. */}
                <div className="scc-boost-actions">
                  <button
                    type="button"
                    className="scc-boost-action scc-edit"
                    title={t('site-panel.modifier-name', { name: b.name })}
                    aria-label={t('site-panel.modifier-name', { name: b.name })}
                    onClick={() => act.openOverlay({ panel: 'boost', host: b.host, id: b.id })}
                  >
                    <svg {...GLYPH} width="16" height="16" strokeWidth={1.6}>
                      <path d={BOOST_ACTION_GLYPHS.edit} />
                    </svg>
                  </button>
                  {state.settings.boostSharing && !snapshot.private && (
                    <button
                      type="button"
                      className="scc-boost-action scc-export"
                      title={t('site-panel.exporter-name', { name: b.name })}
                      aria-label={t('site-panel.exporter-name', { name: b.name })}
                      onClick={() => void act.boostShare({ kind: 'export-file', boostId: b.id }).catch((error: unknown) => console.error('[boost] sharing failed:', error))}
                    >
                      <svg {...GLYPH} width="16" height="16" strokeWidth={1.6}>
                        <path d={BOOST_ACTION_GLYPHS.export} />
                      </svg>
                    </button>
                  )}
                  <button
                    type="button"
                    ref={(bin) => {
                      if (!bin || refocusDelete.current !== b.id) return
                      refocusDelete.current = null
                      bin.focus()
                    }}
                    className="scc-boost-action scc-delete"
                    title={t('site-panel.supprimer-name', { name: b.name })}
                    aria-label={t('site-panel.supprimer-name', { name: b.name })}
                    onClick={() => setDeleting(b.id)}
                  >
                    <svg {...GLYPH} width="16" height="16" strokeWidth={1.6}>
                      <path d={BOOST_ACTION_GLYPHS.delete} />
                    </svg>
                  </button>
                </div>
              </div>
              )
            )}
          </SiteSection>
        )}

        <SiteSection id="extensions" open={sections.extensions} summary={sectionSummary('extensions', facts)} onToggle={() => toggle('extensions')}>
          <SiteExtensions extensions={profileExtensions} profileId={profileId} settings={state.settings} />
        </SiteSection>
      </div>

      <div className="scc-footer">
        {/* Only http: warns. A page with no connection to judge (a file, about:blank, a page of an extension) says what it is, not that it is unsafe. */}
        <span className={`scc-secure ${connection === 'insecure' ? 'warning' : ''}`}>
          <svg {...GLYPH} width="14" height="14" strokeWidth={1.6}>
            <path d={CONNECTION_GLYPHS[connection]} />
          </svg>
          {connection === 'secure' ? t('site-panel.securise') : untrusted && connection === 'insecure' ? t('site-panel.non-securise-certificat-accepte') : connection === 'insecure' ? t('site-panel.non-securise') : t('site-panel.page-locale')}
        </span>
        {/* The settings that are about sites (permissions, autoplay, data erased on close) are one group of Réglages: the panel leaves for it. */}
        <button
          type="button"
          className="scc-site-settings"
          onClick={() => {
            act.closeOverlay()
            act.openOverlay({ panel: 'settings', pane: 'protection', anchor: 'permissions' })
          }}
        >
          {t('site-panel.reglages-du-site')}
        </button>
        {confirmClear ? (
          // It takes the place of the button that was clicked, and its focus: the answer is one key away, not at the start of the panel again.
          // The keys say that these are two buttons: the focus is given, not left to whether React keeps the same element for both.
          <button
            key="clear-confirm"
            className="button"
            autoFocus
            title={t('site-panel.supprimer-les-cookies-et-le-stockage-de-origin', { origin: url.origin })}
            onClick={() => {
              act.clearSiteData()
              act.closeOverlay()
            }}
          >
            {t('site-panel.effacer-question')}
          </button>
        ) : (
          <button key="clear-arm" className="scc-more" title={t('site-panel.effacer-les-cookies-et-donnees-du-site')} aria-label={t('site-panel.effacer-les-cookies-et-donnees-du-site')} onClick={() => setConfirmClear(true)}>
            <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true">
              <circle cx="4.500" cy="10" r="1.300" />
              <circle cx="10" cy="10" r="1.300" />
              <circle cx="15.500" cy="10" r="1.300" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

import { t } from '@shared/i18n'
import { shortcutSuffix } from '@shared/keybindings'
import { platformOf } from '@shared/platform'