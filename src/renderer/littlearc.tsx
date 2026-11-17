import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { mountRoot } from './root'
import { LITTLE_HEADER_HEIGHT, LITTLE_STRIP_HEIGHT, WEB_APP_HEADER_HEIGHT, type LittleState, type UiSnapshot } from '@shared/ipc'
import { littleStrip, littleStripText } from '@shared/little'
import { LITTLE_PICKER, filterSpaces, moveHighlight, openInCommand } from '@shared/little-picker'
import { trayRows } from '@shared/little-tray'
import { bubbleDownload } from '@shared/little-bubble'
import { downloadProgress, downloadStatus, fileExtension } from '@shared/downloads-view'
import { addressLabel, hostOf } from '@shared/url'
import { resolveAppearance, themeVars } from '@shared/theme'
import { api } from './api'
import { CommandBar } from './CommandBar'
import { HostText } from './HostText'
import './styles.css'
import './little.css'
import { lockDocumentDrops } from './surface'
import { setKeyPlatform, t } from '@shared/i18n'
import { followLanguage } from './document-language'
import { InLanguage } from './InLanguage'
import { labelWithShortcut } from '@shared/keybindings'
import { commandPress, platformOf } from '@shared/platform'
import { useSystemDark } from './system-dark'
import { iconSource } from '@shared/site-icon'

lockDocumentDrops()

const GLYPH = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

/** The space ⌘O opens the page in: the one the main window is on, or failing that the first one. */
function targetSpace(state: LittleState | null, snapshot: UiSnapshot | null) {
  const fromSnapshot = snapshot?.state.spaces.find((s) => s.id === snapshot.state.activeSpaceId)
  return fromSnapshot ?? state?.spaces[0]
}

/** The first state of a window: the command bar alone, in a window of its own (490 x 329). */
function LittleBar({ id }: { id: string }) {
  return <CommandBar mode="little" initial="" little={{ id }} />
}

function LittleArc() {
  const id = new URLSearchParams(location.search).get('id') ?? ''
  const [state, setState] = useState<LittleState | null>(null)
  // The theme and the current space belong to the main window: read them at start and whenever this window comes back to the front.
  const [snapshot, setSnapshot] = useState<UiSnapshot | null>(null)
  const [copied, setCopied] = useState(false)
  const act = api()

  useEffect(() => {
    const off = api().onLittleState(setState)
    // Listening now: the window sends its state again. What it sent as this page loaded can come before React listens, on a busy machine: the
    // header then stayed without its title and its address until the page changed.
    api().littleAction(id, 'ready')
    return off
  }, [id])
  useEffect(() => {
    const load = () =>
      void api()
        .getSnapshot()
        .then((next) => next && setSnapshot(next))
        .catch((error: unknown) => console.error('[little] cannot read the theme of the space:', error))
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])

  // This window reads the snapshot itself (not through useSnapshot), so it sets the language of the interface itself, before any text is read.
  if (snapshot) {
    followLanguage(document.documentElement, snapshot.state.settings, navigator.language)
    setKeyPlatform(platformOf(snapshot.platform))
  }
  const space = targetSpace(state, snapshot)
  // The keys of this window are those of the menu bar as the user set them (shared/little-bar.ts): its tooltips say the same.
  const withKey = (label: string, command: string): string => labelWithShortcut(label, command, snapshot?.state.settings.keyBindings, platformOf(snapshot?.platform))
  // The name of the window (Mission Control, the Window menu) follows the language, which is known once the first snapshot has come, and says where the page will go.
  useEffect(() => {
    document.title = space ? t('littlearc.titre-avec-espace', { space: `${space.emoji} ${space.name}`.trim() }) : t('littlearc.window-title')
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the title reads these three fields of the space, a new object at each snapshot
  }, [snapshot, space?.id, space?.name, space?.emoji])
  const full = snapshot?.state.spaces.find((s) => s.id === space?.id)
  const dark = useSystemDark()
  const appearance = full ? resolveAppearance(full.theme, dark) : 'dark'
  const vars = full ? themeVars(full.theme, appearance) : {}

  // Where the address is read, only the address speaks (`addressLabel`): the title is the page's own words. This header is the one place of this window
  // that says whose page it is, so the host is always drawn, at every width.
  const webHost = state ? hostOf(state.url) : ''
  const host = state ? webHost || addressLabel(state.url) : ''
  // The page's own title leads the header, the address follows (the title is the address until the page has one).
  const title = state && state.title && state.title !== state.url ? state.title : host
  const kept = state?.kept === true
  // The delay of the archiving is a setting of the main window: read with the theme, whenever this window comes back to the front.
  const archiveHours = snapshot?.state.settings.littleArcArchiveHours
  const strip = archiveHours === undefined ? null : littleStripText(littleStrip(kept, archiveHours))
  // The main process copies, as it does for the shortcut: `navigator.clipboard` only answers a document that has the keyboard focus, which this
  // window does not always have when the button is pressed. The tick comes back with `copiedAt`, once the address is really on the clipboard.
  const copy = () => act.littleAction(id, 'copy-url')
  const openHere = () => act.littleAction(id, 'open-in-main')

  // The shortcuts (⌘O, ⇧⌘C, ⌘R, ⌘[, ⌘]) are the window's, whoever has the focus: main takes them before the menu bar (shared/little-bar.ts).
  // Copying by shortcut shows the same tick as the button.
  const copiedAt = state?.copiedAt
  useEffect(() => {
    if (!copiedAt) return
    setCopied(true)
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copiedAt])

  // The bar is the window until an address is chosen; the query already says so before the first state arrives.
  if (state ? state.bar : barFromQuery) return <LittleBar id={id} />

  return (
    <div className={['la', appearance === 'light' && 'light', full && 'themed'].filter(Boolean).join(' ')} style={vars as CSSProperties}>
      <header className="la-header" style={{ height: LITTLE_HEADER_HEIGHT }}>
        <div className="la-field" title={state?.url}>
          <AppIcon name={host} icon={state?.faviconUrl} />
          <span className="la-title">{title}</span>
          {host && title !== host && (webHost ? <HostText host={webHost} className="la-host" /> : <span className="la-host">{host}</span>)}
          <div className="la-nav">
            {state?.canGoBack && (
              <button className="la-sq" title={withKey(t('toolbar.precedent'), 'back')} aria-label={t('toolbar.precedent')} onClick={() => act.littleAction(id, 'back')}>
                <svg viewBox="0 0 16 16" width="13" height="13" {...GLYPH} strokeWidth={1.8}>
                  <path d="M10 3 5 8l5 5" />
                </svg>
              </button>
            )}
            {state?.canGoForward && (
              <button className="la-sq" title={withKey(t('toolbar.suivant'), 'forward')} aria-label={t('toolbar.suivant')} onClick={() => act.littleAction(id, 'forward')}>
                <svg viewBox="0 0 16 16" width="13" height="13" {...GLYPH} strokeWidth={1.8}>
                  <path d="m6 3 5 5-5 5" />
                </svg>
              </button>
            )}
            <button className="la-sq la-reload" title={withKey(t('sidebar.recharger'), 'reload')} aria-label={t('sidebar.recharger')} onClick={() => act.littleAction(id, 'reload')}>
              <svg viewBox="0 0 16 16" width="13" height="13" {...GLYPH} strokeWidth={1.8}>
                <path d="M13 8a5 5 0 1 1-1.500-3.500M13 2.500v3h-3" />
              </svg>
            </button>
          </div>
          <button className="la-sq la-copy" title={copied ? t('panels.adresse-copiee') : withKey(t('panels.copier-l-adresse'), 'copyUrl')} aria-label={t('panels.copier-l-adresse')} onClick={copy}>
            <svg viewBox="0 0 16 16" width="14" height="14" {...GLYPH}>
              {copied ? <path d="m3 8.500 3.200 3.200L13 4.800" /> : <path d="M7 9a3 3 0 0 0 4.200 0l2-2A3 3 0 0 0 9 2.800l-.800.800M9 7a3 3 0 0 0-4.200 0l-2 2A3 3 0 0 0 7 13.200l.800-.800" />}
            </svg>
          </button>
        </div>

        <div className="la-open">
          <button className="la-open-main" title={space ? t('littlearc.ouvrir-dans-name-o', { name: space.name }) : t('littlearc.ouvrir-dans-la-fenetre-principale-o')} onClick={openHere}>
            <span className="la-open-label">{t('littlearc.ouvrir-dans')}</span>
            <span className="la-open-space">{space ? `${space.emoji} ${space.name}`.trim() : ''}</span>
            <kbd>{commandPress('O', platformOf(snapshot?.platform))}</kbd>
          </button>
          <span className="la-open-sep" />
          <button className="la-open-more" title={t('littlearc.autres-espaces')} aria-label={t('littlearc.autres-espaces')} aria-haspopup="menu" onClick={() => act.littleAction(id, 'move-menu')}>
            <svg viewBox="0 0 16 16" width="16" height="16" {...GLYPH} strokeWidth={1.8}>
              <path d="m4 6.500 4 4 4-4" />
            </svg>
          </button>
        </div>

        {/* The pin: "Garder ouvert" leaves this window out of the archiving of the forgotten ones. */}
        <button className="la-pin" aria-pressed={kept} title={t('littlearc.garder-ouvert')} aria-label={t('littlearc.garder-ouvert-aide')} onClick={() => act.littleAction(id, kept ? 'keep:off' : 'keep:on')}>
          <svg viewBox="0 0 16 16" width="16" height="16" {...GLYPH}>
            <path d="M10 2 14 6l-3 1-2.500 2.500L9 13l-3-3-4 4 4-4-3-3 3.500.5L9 5l1-3Z" />
          </svg>
        </button>
      </header>
      {/* What becomes of the window if it is forgotten: the delay of the setting, or "kept" while the pin is on. */}
      <div className={`la-strip ${kept ? 'kept' : ''}`} style={{ height: LITTLE_STRIP_HEIGHT }} role="status">
        <svg className="la-strip-icon" viewBox="0 0 16 16" width="14" height="14" {...GLYPH}>
          <circle cx="8" cy="8" r="5.500" />
          <path d="M8 5v3l2 1.500" />
        </svg>
        <span className="la-strip-text">{strip ?? ''}</span>
        <button className="la-strip-link" onClick={() => act.littleAction(id, 'archive-delay')}>
          {t('littlearc.modifier-le-delai')}
        </button>
      </div>
    </div>
  )
}

// ---------- Application window (setting webAppWindows) ----------

/** The icon of the site, or the initial of its name when it has none (or the image cannot be shown). */
function AppIcon({ name, icon }: { name: string; icon?: string }) {
  const [failed, setFailed] = useState(false)
  const source = iconSource(icon)
  if (source && !failed) return <img className="wa-icon" src={source} alt="" draggable={false} onError={() => setFailed(true)} />
  return <span className="wa-icon fallback" aria-hidden="true">{(name || '?').charAt(0).toUpperCase()}</span>
}

/**
 * The header of a site opened as an application: its icon and its name, and back, forward, reload, and "Ouvrir dans un onglet". No address
 * field and no sidebar: the window shows one site. It only sends commands (`back`, `forward`, `reload`, `open-in-main`).
 */
function WebAppHeader() {
  const id = new URLSearchParams(location.search).get('id') ?? ''
  const [state, setState] = useState<LittleState | null>(null)
  const act = api()
  useEffect(() => {
    const off = api().onLittleState(setState)
    // Listening now: the window sends its state again (what it sent as this page loaded may have come too early).
    api().littleAction(id, 'ready')
    return off
  }, [id])
  const app = state?.app
  return (
    <div className="wa">
      <header className="wa-header" style={{ height: WEB_APP_HEADER_HEIGHT }}>
        <div className="wa-id" title={state?.url}>
          <AppIcon name={app?.name ?? ''} icon={app?.icon} />
          <span className="wa-name">{app?.name ?? ''}</span>
        </div>
        <div className="wa-nav">
          <button className="la-sq" title={t('toolbar.precedent')} aria-label={t('toolbar.precedent')} disabled={!state?.canGoBack} onClick={() => act.littleAction(id, 'back')}>
            <svg viewBox="0 0 16 16" width="13" height="13" {...GLYPH} strokeWidth={1.8}>
              <path d="M10 3 5 8l5 5" />
            </svg>
          </button>
          <button className="la-sq" title={t('toolbar.suivant')} aria-label={t('toolbar.suivant')} disabled={!state?.canGoForward} onClick={() => act.littleAction(id, 'forward')}>
            <svg viewBox="0 0 16 16" width="13" height="13" {...GLYPH} strokeWidth={1.8}>
              <path d="m6 3 5 5-5 5" />
            </svg>
          </button>
          <button className="la-sq" title={t('sidebar.recharger')} aria-label={t('sidebar.recharger')} onClick={() => act.littleAction(id, 'reload')}>
            <svg viewBox="0 0 16 16" width="13" height="13" {...GLYPH} strokeWidth={1.8}>
              <path d="M13 8a5 5 0 1 1-1.500-3.500M13 2.500v3h-3" />
            </svg>
          </button>
          <button className="la-sq" title={t('littlearc.ouvrir-dans-un-onglet-o')} aria-label={t('littlearc.ouvrir-dans-un-onglet')} onClick={() => act.littleAction(id, 'open-in-main')}>
            <svg viewBox="0 0 16 16" width="14" height="14" {...GLYPH}>
              <path d="M9.500 2.500h4v4M13.500 2.500 8 8M6.500 3.500h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" />
            </svg>
          </button>
        </div>
      </header>
    </div>
  )
}

// ---------- Space picker ----------

/**
 * The popover of the chevron: a search field and one row per space, 244 x 230 in the top right corner of a transparent layer
 * that covers the window (a click on the layer puts it away). Main shows it as a view of its own, above the page, with the
 * same `id` and `picker` in the query; it only sends commands (`open-in:<space>`, `picker-close`).
 */
function SpacePicker() {
  const id = new URLSearchParams(location.search).get('id') ?? ''
  const [spaces, setSpaces] = useState<Array<{ id: string; name: string; emoji: string; color: string }>>([])
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const act = api()

  useEffect(() => {
    void api()
      .getSnapshot()
      .then((snapshot) => setSpaces(snapshot.state.spaces.map((s) => ({ id: s.id, name: s.name, emoji: s.emoji, color: s.theme.baseColors[0] ?? '#6666ff' }))))
      .catch((error: unknown) => console.error('[little] cannot list the spaces:', error))
  }, [])

  const shown = filterSpaces(spaces, query)
  const chosen = shown[Math.min(highlight, shown.length - 1)]
  const close = () => act.littleAction(id, 'picker-close')
  const choose = (spaceId: string) => act.littleAction(id, openInCommand(spaceId))
  useEffect(() => list.current?.children[highlight]?.scrollIntoView({ block: 'nearest' }), [highlight])

  return (
    <div className="lp-layer" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="lp"
        role="dialog"
        aria-label={t('littlearc.autres-espaces')}
        style={{ width: LITTLE_PICKER.width, height: LITTLE_PICKER.height, top: LITTLE_PICKER.top, right: LITTLE_PICKER.right }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
          else if (e.key === 'Enter' && chosen) choose(chosen.id)
          else if (e.key === 'ArrowDown') setHighlight((h) => moveHighlight(h, 1, shown.length))
          else if (e.key === 'ArrowUp') setHighlight((h) => moveHighlight(h, -1, shown.length))
          else return
          e.preventDefault()
        }}
      >
        <div className="lp-search" style={{ height: LITTLE_PICKER.searchHeight }}>
          <svg className="lp-lens" viewBox="0 0 16 16" width="14" height="14" {...GLYPH}>
            <circle cx="7" cy="7" r="5" />
            <path d="m11 11 3.500 3.500" />
          </svg>
          <input
            className="lp-input"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="lp-spaces"
            aria-activedescendant={shown[highlight] ? `lp-space-${shown[highlight].id}` : undefined}
            autoFocus
            value={query}
            placeholder={t('littlearc.rechercher-des-espaces')}
            aria-label={t('littlearc.rechercher-des-espaces-2')}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlight(0)
            }}
          />
          <button className="lp-fold" title={t('littlearc.replier-echap')} aria-label={t('littlearc.replier-la-liste-des-espaces')} onClick={close}>
            <svg viewBox="0 0 16 16" width="14" height="14" {...GLYPH} strokeWidth={1.8}>
              <path d="m4 10 4-4 4 4" />
            </svg>
          </button>
        </div>
        <ul ref={list} id="lp-spaces" className="lp-list" role="listbox" aria-label={t('menu.espaces')}>
          {shown.map((space, i) => (
            <li key={space.id} id={`lp-space-${space.id}`} role="option" aria-selected={i === highlight} className={i === highlight ? 'on' : ''} style={{ height: LITTLE_PICKER.rowHeight }} onMouseMove={() => setHighlight(i)} onClick={() => choose(space.id)}>
              <span className="lp-icon" style={{ background: space.color }} aria-hidden="true">
                {space.emoji}
              </span>
              <span className="lp-name">{space.name}</span>
            </li>
          ))}
          {shown.length === 0 && spaces.length > 0 && <li className="lp-empty">{t('littlearc.aucun-espace-ne-correspond')}</li>}
        </ul>
      </div>
    </div>
  )
}

// ---------- Downloads tray ----------

const TRAY_GLYPH = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const

/**
 * The files the page of this window downloaded, in a card at the bottom of the window (a view of its own, over the page). Reveal and
 * open work on the file; the cross cancels a running download, or takes a finished one out of the tray.
 */
function DownloadsTray() {
  const id = new URLSearchParams(location.search).get('id') ?? ''
  const [state, setState] = useState<LittleState | null>(null)
  const act = api()
  useEffect(() => {
    const off = api().onLittleState(setState)
    // Listening now: the window sends its state again (what it sent as the page loaded may have come too early).
    act.littleAction(id, 'ready')
    return off
  }, [act, id])
  const rows = trayRows(state?.downloads ?? [])
  // The action bubble (Settings › Navigation › Plus de réglages) for the file that just finished: the pointer on it keeps it up, main takes it down after a few seconds.
  const bubble = bubbleDownload(state?.downloads ?? [], state?.bubble)
  const afterBubble = (command: 'open' | 'reveal') => {
    if (!bubble) return
    act.downloadAction(bubble.id, command)
    act.littleAction(id, 'bubble-close')
  }
  return (
    <div className="lt" role="region" aria-label={t('sidebar.telechargements')}>
      {bubble && (
        <div className="lt-bubble" role="status" onPointerEnter={() => act.littleAction(id, 'bubble-hold')} onPointerLeave={() => act.littleAction(id, 'bubble-release')}>
          <span className="lt-bubble-done" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="12" height="12" {...TRAY_GLYPH} strokeWidth={2}>
              <path d="m3.500 8.500 3 3L12.500 5" />
            </svg>
          </span>
          <span className="lt-bubble-text">{t('littlearc.telecharge')}</span>
          <button className="lt-bubble-btn primary" onClick={() => afterBubble('open')}>
            {t('download-ui.ouvrir')}
          </button>
          <button className="lt-bubble-btn" onClick={() => afterBubble('reveal')}>
            {t('littlearc.dans-le-finder')}
          </button>
          <button className="lt-btn" title={t('translate.close')} aria-label={t('littlearc.fermer-la-bulle')} onClick={() => act.littleAction(id, 'bubble-close')}>
            <svg viewBox="0 0 20 20" width="16" height="16" {...TRAY_GLYPH}>
              <path d="m6 6 8 8M14 6l-8 8" />
            </svg>
          </button>
        </div>
      )}
      {rows.map((d) => {
        const progress = downloadProgress(d)
        const running = d.state === 'progressing'
        return (
          <div key={d.id} className={`lt-row ${d.state}`}>
            <span className="lt-icon" aria-hidden="true">
              <svg viewBox="0 0 28 34" width="24" height="30" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                <path d="M5 1.750h12.500L26 10.250V30.500a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3.750a2 2 0 0 1 2-2Z" />
                <path d="M17.500 1.750v6.500a2 2 0 0 0 2 2H26" />
              </svg>
              {fileExtension(d.filename) && <span className="lt-ext">{fileExtension(d.filename)}</span>}
            </span>
            <span className="lt-main">
              <span className="lt-name" title={d.filename}>
                {d.filename}
              </span>
              <span className="lt-status">{downloadStatus(d)}</span>
              {running && <progress value={progress ?? undefined} max={1} aria-label={t('littlearc.progression-de-filename', { filename: d.filename })} />}
            </span>
            {d.state === 'completed' && (
              <>
                <button className="lt-btn" title={t('panels.afficher-dans-le-finder')} aria-label={t('panels.afficher-dans-le-finder')} onClick={() => act.downloadAction(d.id, 'reveal')}>
                  <svg viewBox="0 0 20 20" width="16" height="16" {...TRAY_GLYPH}>
                    <circle cx="9" cy="9" r="5" />
                    <path d="m13 13 4 4" />
                  </svg>
                </button>
                <button className="lt-btn" title={t('panels.ouvrir')} aria-label={t('panels.ouvrir')} onClick={() => act.downloadAction(d.id, 'open')}>
                  <svg viewBox="0 0 20 20" width="16" height="16" {...TRAY_GLYPH}>
                    <path d="M7 13 13 7M8 6h5v5" />
                  </svg>
                </button>
              </>
            )}
            <button
              className="lt-btn"
              title={running ? t('ctx.annuler-le-telechargement') : t('littlearc.retirer-du-plateau')}
              aria-label={running ? t('ctx.annuler-le-telechargement') : t('littlearc.retirer-du-plateau')}
              onClick={() => (running ? act.downloadAction(d.id, 'cancel') : act.littleAction(id, `dismiss-download:${d.id}`))}
            >
              <svg viewBox="0 0 20 20" width="16" height="16" {...TRAY_GLYPH}>
                <path d="m6 6 8 8M14 6l-8 8" />
              </svg>
            </button>
          </div>
        )
      })}
    </div>
  )
}

// A picker is a view of its own over the window: it must not paint the window's background.
const isPicker = new URLSearchParams(location.search).has('picker')
const isTray = new URLSearchParams(location.search).has('tray')
const barFromQuery = new URLSearchParams(location.search).has('bar')
const isApp = new URLSearchParams(location.search).has('app')
if (isPicker) document.body.className = 'little-picker'
else if (isTray) document.body.className = 'little-tray'

// The picker, the tray and the header of a web application are pages apart that draw no snapshot: each one learns the language of the interface before its texts are read.
const apart = isPicker ? <SpacePicker /> : isTray ? <DownloadsTray /> : isApp ? <WebAppHeader /> : null
mountRoot(apart ? <InLanguage>{apart}</InLanguage> : <LittleArc />)
