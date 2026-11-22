import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { gotoTabCommand } from '@shared/little-picker'
import { actionToDispatch, bookmarkCandidates, BAR_WIDTH, barBox, barLayout, candidateDispatches, candidateHint, candidatePreview, cardSurface, completedRow, groupCandidates, groupStarts, groupTitle, inScope, littleCandidates, littleGroupStarts, newTabOf, pageColorBehind, typedStaysPrivate, inlineCompletion, rankCandidates, resultAtEdge, scopeSiteFor, SCOPE_PREFIX, splitScope, suggestionQuery, usageKey, windowSidebarChangeOf, type BarScope, type Candidate, type CommandAction } from '@shared/command-bar'
import type { CommandBarMode } from '@shared/ipc'
import { commandHeld, effectiveAccelerator, formatAccelerator } from '@shared/keybindings'
import { ariaKeyShortcut, commandPress, platformOf } from '@shared/platform'
import type { HistoryEntry, SiteSearch } from '@shared/model'
import { copyableUrl } from '@shared/copy-url'
import { activeTab } from '@shared/sidebar'
import { activeProfileId } from '@shared/profiles'
import { hostOf } from '@shared/url'
import { api, useSnapshot } from './api'
import { BarClipboardButtons, barNoticeText } from './BarClipboard'
import { applyPaste, copyFromBar, noticeClock, pasteToBar, type BarClipNotice } from './bar-clipboard'
import { ICONS, glyph } from './command-icons'
import { CommandPreview } from './CommandPreview'
import { t, tp } from '@shared/i18n'
import './command-bar.css'
import { iconSource } from '@shared/site-icon'
import { ACTION_NOTICE_MS } from '@shared/toast'
import { useActionNotice } from './notice-hold'

const HISTORY_DEBOUNCE_MS = 60
const SUGGEST_DEBOUNCE_MS = 140
/** The recent pages listed in "Historique" while nothing is typed. */
const HISTORY_RECENT = 8
const BOOKMARKS_SHOWN = 12

/** Commands that have a picture of their own rather than the bolt. */
const ACTION_ICONS: Partial<Record<CommandAction, ReactNode>> = {
  // A folder.
  'new-folder': glyph('M2.500 5.500a1 1 0 0 1 1-1h4l1.700 2h7.300a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V5.500Z'),
  // A keyboard.
  'edit-shortcuts': glyph('M3.500 5.500h13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM5.500 8.500h.01M8.500 8.500h.01M11.500 8.500h.01M14.500 8.500h.01M6.500 11.500h7')
}

/**
 * The favicon of a line. A site whose icon cannot be loaded (a local address that does not answer, a damaged file) is not drawn as a broken image, in the
 * line and in the preview that reuses it: the line icon of its kind stands in. The failure is of that address, so another line is not affected.
 */
export function ResultFavicon({ src, fallback }: { src: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null)
  // The picture is the copy the main process keeps of the icon, never the site's address (shared/site-icon.ts).
  const source = iconSource(src)
  if (failed === src || !source) return <>{fallback}</>
  return <img className="result-favicon" src={source} alt="" draggable={false} onError={() => setFailed(src)} />
}

/** Puts the focus in the field and, when the bar opens on some text (an address), selects it whole; an empty field is only focused. */
export function focusBarField(field: Pick<HTMLInputElement, 'focus' | 'select'> | null, initial: string): void {
  if (!field) return
  field.focus()
  if (initial !== '') field.select()
}

/** What leads a result line: a favicon, the emoji of a space in a rounded tile, or a line icon of its kind. */
function lead(c: Candidate): ReactNode {
  if ((c.kind === 'tab' || c.kind === 'readlater' || c.kind === 'bookmark') && c.faviconUrl) return <ResultFavicon src={c.faviconUrl} fallback={ICONS[c.kind]} />
  if (c.kind === 'space' || c.kind === 'move' || c.kind === 'workview') return <span className="space-tile" aria-hidden="true">{c.emoji}</span>
  if (c.kind === 'open' && c.search) return ICONS.suggestion
  if (c.kind === 'action') return ACTION_ICONS[c.action] ?? ICONS.action
  return ICONS[c.kind]
}

/** The bar asks the same thing whatever it is for (a search or an address). */
const placeholder = (): string => t('cmd.rechercher-ou-saisir-une-adresse')

/** The key drawn in the white square of the highlighted row: an arrow to go somewhere, the return key to run. */
const KEY_ARROW = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8h10M9 4l4 4-4 4" />
  </svg>
)
const KEY_RETURN = (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13 3v5a2 2 0 0 1-2 2H3M6 7l-3 3 3 3" />
  </svg>
)
const goesSomewhere = (c: Candidate) => c.kind === 'tab' || c.kind === 'space' || c.kind === 'archived' || c.kind === 'workview'

/**
 * The command bar. In a mini window (`little`: that window's id) it is the whole window, in its first state: results are
 * pages and searches only, a choice is sent to the window (which grows to hold the page) and Escape closes the window.
 */
export function CommandBar({ mode, initial, little }: { mode: CommandBarMode; initial: string; little?: { id: string } }) {
  const snapshot = useSnapshot()
  const [query, setQuery] = useState(initial)
  const [selected, setSelected] = useState(0)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  // After a deletion the bar stops completing, as a browser's address field does, until the next letter typed.
  const [typing, setTyping] = useState(true)
  // A site search the text is scoped to ("yt" + space or Tab makes a pill); Backspace on an empty field removes it.
  const [scope, setScope] = useState<SiteSearch | null>(null)
  const [help, setHelp] = useState(false)
  // The bar narrowed to one genre by a chip (the letters `>`, `@`, `*`, `^` typed first do the same, see `splitScope`).
  const [chipScope, setChipScope] = useState<BarScope | null>(null)
  // Whether the highlighted line was chosen with the arrows (or Home and End), not left there by what is typed. ⇧⌫ forgets a page of the history only
  // then: with Shift still held while a fault is corrected, the key is the field's and takes a letter away, whatever the first line is.
  const [picked, setPicked] = useState(false)
  const list = useRef<HTMLUListElement>(null)
  // What "Copier" and "Coller" last did, for a moment (bar-clipboard.ts); the clock that takes it away stops with the bar.
  const [clip, setClip] = useState<BarClipNotice | null>(null)
  const clock = useRef<ReturnType<typeof noticeClock> | null>(null)
  clock.current ??= noticeClock(setClip)
  useEffect(() => () => clock.current?.stop(), [])
  // The page ⇧⌫ just forgot, and the profile whose history it was in, while « Annuler » is offered (a row of the bar, and ⌘Z).
  const [forgotten, setForgotten] = useState<{ url: string; profileId: string } | null>(null)
  const undoNotice = useActionNotice(forgotten, () => setForgotten(null))
  // With the history switched off (Settings › Profils › Réglages de la recherche) the bar never asks for it.
  const wantHistory = snapshot ? snapshot.state.settings.suggestHistory : true
  // The genre the bar is narrowed to, and the text that is looked for: without the `>` or `@` that named the genre. The Mini-fenêtre has no genres.
  const typed = little ? { scope: null, text: query } : splitScope(query, snapshot ? snapshot.state.settings.siteSearches.map((site) => site.keyword) : [])
  const barScope: BarScope | null = typed.scope ?? chipScope
  const lookFor = typed.scope ? typed.text : query

  useEffect(() => {
    setQuery(initial)
    setSelected(0)
    setPicked(false)
  }, [initial, mode])
  // The field is drawn once the state has come (below, `if (!snapshot) return null`): the focus and the selection wait for it, so an address
  // the bar opens on (the page on screen) is selected whole, ready for ⌘C or to be replaced by ⌘V.
  const drawn = snapshot !== null
  useEffect(() => {
    if (!drawn) return
    const frame = requestAnimationFrame(() => focusBarField(input.current, initial))
    return () => cancelAnimationFrame(frame)
  }, [initial, mode, drawn])

  /**
   * Asks the main process for the pages of the history that match `text`, and keeps them while `wanted` still holds. A request that fails is said
   * in the bar and written to the console (the name of the error only: its message may carry what was typed); the list is emptied, never left
   * with the lines of another text.
   */
  const readHistory = useCallback(
    (text: string, wanted: () => boolean = () => true): Promise<void> =>
      api()
        .searchHistory(text)
        .then(
          (entries) => {
            if (wanted()) setHistory(entries)
          },
          (error: unknown) => {
            console.warn('[command bar] the history could not be read:', error instanceof Error ? error.name : typeof error)
            if (!wanted()) return
            setHistory([])
            clock.current?.say({ kind: 'problem', message: t('cmd.historique-illisible') })
          }
        ),
    []
  )
  /**
   * ⇧⌫ on a page of the history chosen with the arrows: it is forgotten, the bar says so and offers « Annuler » for a few seconds, and the list is read
   * again without it. The profile is named: the page leaves, and comes back to, the history it was listed from, whatever space is on screen by then.
   */
  const forgetPage = (url: string): void => {
    if (!snapshot) return
    const text = lookFor
    const profileId = activeProfileId(snapshot.state)
    void api()
      .forgetHistory(url, profileId, true)
      .then(
        () => {
          setForgotten({ url, profileId })
          return readHistory(text)
        },
        (error: unknown) => {
          console.warn('[command bar] the page could not be forgotten:', error instanceof Error ? error.name : typeof error)
          clock.current?.say({ kind: 'problem', message: t('cmd.oubli-impossible') })
        }
      )
  }

  /** « Annuler » (the button of the row, or ⌘Z): the page goes back in the history as it was, and the list is read again with it. */
  const undoForget = (): void => {
    const page = forgotten
    if (!page) return
    const text = lookFor
    setForgotten(null)
    const failed = (reason: string): void => {
      console.warn('[command bar] the page could not be put back in the history:', reason)
      clock.current?.say({ kind: 'problem', message: t('cmd.remise-impossible') })
    }
    void api()
      .putBackHistory(page.url, page.profileId)
      .then(
        (back) => {
          // The main process no longer has the page (the time was up, or the history was erased meanwhile): said, never left as if it had worked.
          if (back !== true) return failed('refused')
          clock.current?.say({ kind: 'told', message: t('cmd.page-remise-dans-l-historique') })
          return readHistory(text)
        },
        (error: unknown) => failed(error instanceof Error ? error.name : typeof error)
      )
  }

  // History lives in the main process: ask for matches, ignoring answers to outdated queries.
  useEffect(() => {
    if (!wantHistory) {
      setHistory([])
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      void readHistory(lookFor, () => !stale)
    }, HISTORY_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [lookFor, wantHistory, readHistory])

  // In a private window and over a private tab, what is typed is not sent to the search engine (the main process refuses it as well).
  const staysPrivate = snapshot ? typedStaysPrivate(snapshot.state, snapshot.private === true) : true
  // The system the keys of the bar are drawn for, and the one whose main modifier (Command or Ctrl) the keys of the bar read.
  const platform = platformOf(snapshot?.platform)
  // Web suggestions come from the search engine: ask only for text that is not a URL, and drop outdated answers.
  useEffect(() => {
    let stale = false
    // Nothing goes to the search engine inside a genre, nor while the text is for the search of a site (`suggestionQuery`).
    const text = suggestionQuery(query, { staysPrivate, genre: barScope, siteSearch: scope !== null })
    if (text === null) {
      setSuggestions([])
      return
    }
    const timer = setTimeout(() => {
      void api()
        .suggest(text)
        .then(
          (list) => {
            if (!stale) setSuggestions(list)
          },
          (error: unknown) => {
            // Suggestions are a convenience: without them the bar keeps its other lines. The name of the error only: its message may carry what was typed.
            console.warn('[command bar] the suggestions could not be asked for:', error instanceof Error ? error.name : typeof error)
            if (!stale) setSuggestions([])
          }
        )
    }, SUGGEST_DEBOUNCE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query, barScope, staysPrivate, scope])


  const ranked = useMemo(() => {
    if (!snapshot) return []
    if (little && !scope) return littleCandidates(query, snapshot.state, history, suggestions)
    if (scope) {
      const text = query.trim()
      return text ? [{ kind: 'open', id: 'scope', label: text, detail: scope.name, url: scope.url.replace('%s', encodeURIComponent(text)), search: true } satisfies Candidate] : []
    }
    // A bar opened for a new tab (⌘T, new window, split view) opens a new tab with what is typed; the open tabs follow in the list (setting `goToOpenTab` brings back the switch to an open tab).
    const found = rankCandidates(lookFor, snapshot.state, history, suggestions, snapshot.extensions, { private: snapshot.private === true, windows: snapshot.windows, platform, newTab: mode === 'new' || mode === 'split', ...(snapshot.windowSidebar ? { windowSidebar: snapshot.windowSidebar } : {}) })
    if (barScope === null) return found
    // Narrowed to a genre: its lines only. The history has no line of its own while nothing is typed (the ranking lists it only for a text), so the recent pages are the list.
    if (barScope === 'history' && lookFor.trim() === '') return history.slice(0, HISTORY_RECENT).map((h): Candidate => ({ kind: 'history', id: `history:${h.url}`, label: h.title || h.url, detail: t('cmd.history-host', { host: hostOf(h.url) }), url: h.url }))
    // The bookmarks have the room of a list of their own, not the four lines they get among the other genres.
    if (barScope === 'bookmarks') return bookmarkCandidates(lookFor, snapshot.state, snapshot.private === true, BOOKMARKS_SHOWN)
    return inScope(found, barScope)
  }, [snapshot, query, lookFor, barScope, history, suggestions, scope, little, mode, platform])
  // Narrowed to a genre, no letters are completed: the field holds a prefix and a search, not an address.
  const completion = typing && barScope === null ? inlineCompletion(query, ranked) : null
  // The address on screen is what Enter opens: when the field shows a completed address and the first row would search for the letters typed, a row for the address leads.
  const completed = useMemo(() => completedRow(ranked, completion), [ranked, completion])
  // The lines of one genre together, under its title, the genre of the best line first (so the line Enter opens is still the first). The mini window groups in its own way.
  const candidates = useMemo(() => {
    const all = completed ? [completed, ...ranked] : ranked
    return little ? all : groupCandidates(all)
  }, [completed, ranked, little])
  // The titles of the groups: those of the mini window's bar (open tabs, suggestions), or the genres of the bar of the main window.
  const groups = useMemo(() => (little ? (scope ? candidates.map(() => null) : littleGroupStarts(candidates)) : groupStarts(candidates)), [little, scope, candidates])
  // Where the page the mini window opens will go: the space the main window is on (the one ⌘O opens it in).
  const targetSpace = snapshot?.state.spaces.find((s) => s.id === snapshot.state.activeSpaceId) ?? snapshot?.state.spaces[0]
  // The list shows five rows: the arrows must bring the highlighted one into view.
  useEffect(() => {
    list.current?.querySelector(`#cb-option-${selected}`)?.scrollIntoView({ block: 'nearest' })
  }, [selected, candidates])
  const tail = completion ? completion.slice(query.length) : ''
  // The completed part of the address stays selected, so the next letter replaces it.
  useLayoutEffect(() => {
    const field = input.current
    if (tail && field && document.activeElement === field) field.setSelectionRange(query.length, query.length + tail.length)
  }, [query, tail])
  if (!snapshot) return null
  const enterScope = (keyword: string): boolean => {
    const site = scopeSiteFor(keyword, snapshot.state)
    if (!site) return false
    setScope(site)
    setQuery('')
    setSelected(0)
    return true
  }

  const acceptSiteSearch = (c: Candidate | undefined): boolean => {
    if (c?.kind !== 'site-search') return false
    return enterScope(c.keyword)
  }

  // "Copier": what the field shows (a completed address too: it is what Enter opens), else the address of the tab on screen as "Copier l'URL" gives it.
  const copyField = () => {
    const tab = activeTab(snapshot.state)
    void copyFromBar(api(), query + tail, tab ? copyableUrl(tab.url, snapshot.state.settings.stripCopiedLinks) : null).then((notice) => clock.current?.say(notice))
  }

  // "Coller": the clipboard replaces the whole field, on one line, and the propositions follow as if it had been typed. When there is nothing to put the
  // field stays as it is and the sentence says why. The pasted text is not completed (a browser's field does not complete a paste): it is what is opened.
  const pasteField = () => {
    void pasteToBar(api()).then((pasted) =>
      applyPaste(pasted, {
        say: (notice) => clock.current?.say(notice),
        setTyping,
        setQuery,
        setSelected,
        caretToEnd: () =>
          requestAnimationFrame(() => {
            const field = input.current
            if (!field) return
            field.focus()
            field.setSelectionRange(field.value.length, field.value.length)
          })
      })
    )
  }

  // The bar of a mini window sends what was chosen to that window; everywhere else it goes to the browser.
  const go = (input: string) => (little ? api().littleAction(little.id, `go:${input}`) : api().submitUrl(input, mode))
  const dismiss = () => (little ? api().littleAction(little.id, 'close') : api().closeOverlay())

  const run = (c: Candidate | undefined) => {
    if (!c) return
    const act = api()
    switch (c.kind) {
      case 'open':
      case 'history':
        // Remember the pick: pages chosen often rank higher next time.
        if (!little) void act.dispatch({ type: 'commandbar/used', key: usageKey(c.url) })
        return go(c.url)
      case 'suggestion':
        return go(c.query)
      case 'site-search':
        acceptSiteSearch(c)
        return
      case 'calc':
        // The answer goes to the clipboard (the main process checks that it is a number) and the bar closes.
        act.copyCalcResult(c.copy)
        break
      case 'extension':
        // Main closes the bar first, then clicks the icon so the popup opens over the page.
        return act.activateExtension(c.extensionId)
      case 'window':
        // Main closes the bar, then brings the window to the front.
        return act.goToWindow(c.windowId)
      case 'omnibox':
        // Main closes the bar, then tells the extension: where the page opens depends on what the bar was opened for.
        return act.omniboxEnter({ extensionId: c.extensionId, text: c.text, disposition: mode === 'current' ? 'currentTab' : 'newForegroundTab' })
      case 'extpage':
        // As for a pane of Settings: the bar goes first, or closing the window would hand the focus back to the page.
        act.closeOverlay()
        return act.openOverlay({ panel: 'extensions', target: c.target })
      case 'pane':
        // The bar goes before the Settings window opens, or closing it would hand the focus back to the page.
        act.closeOverlay()
        return act.openOverlay({ panel: 'settings', pane: c.pane, ...(c.anchor ? { anchor: c.anchor } : {}) })
      case 'internal':
        // A row that says there is no such page has nothing to open: the bar stays, with the sentence on screen.
        if (!c.request) return
        // As for a pane: the Settings window opens after the bar has gone. A panel takes the place of the bar.
        if (c.request.panel === 'settings') act.closeOverlay()
        return act.openOverlay(c.request)
      case 'tab':
        // The mini window has no tabs of its own: the main window goes to the tab, and this window (which has no page yet) goes away.
        if (little) return act.littleAction(little.id, gotoTabCommand(c.tabId))
        void act.dispatch({ type: 'commandbar/used', key: usageKey(c.url) })
        void act.dispatch({ type: 'tab/select', id: c.tabId })
        break
      case 'archived':
        void act.dispatch({ type: 'archive/restore', id: c.archivedId })
        break
      case 'readlater':
        void act.dispatch({ type: 'readlater/open', id: c.readLaterId })
        break
      case 'bookmark':
        void act.dispatch({ type: 'bookmark/open', id: c.bookmarkId })
        break
      case 'webpanel':
        // The main process closes the bar, then docks the site beside the page.
        return act.webPanel({ op: 'open', panelId: c.panelId })
      case 'session':
        // The reducer opens the pages; the main process says how many came back.
        for (const action of candidateDispatches(c)) void act.dispatch(action)
        break
      case 'container': {
        const actions = candidateDispatches(c)
        if (c.mode === 'new') {
          // The blank tab in the container is made first; then the bar is put over it again to type where it goes (as for a private tab).
          void Promise.all(actions.map((action) => act.dispatch(action))).then(() => act.openOverlay({ panel: 'commandbar', mode: 'current', initial: '' }))
          return
        }
        for (const action of actions) void act.dispatch(action)
        break
      }
      case 'workview':
        // The reducer opens the view, or shows it again; the main process opens a window first for a view that opens in one.
        for (const action of candidateDispatches(c)) void act.dispatch(action)
        break
      case 'space':
      case 'move':
        // Sent in order: a tab is moved to the space before it is pinned there.
        for (const action of candidateDispatches(c)) void act.dispatch(action)
        break
      case 'action': {
        // The same bar, in "Onglets" mode: the new request takes the place of this one (no closeOverlay: it would close the one that replaces it).
        if (c.action === 'search-tabs') return act.openOverlay({ panel: 'commandbar', mode: 'tabs', initial: '' })
        if (c.action === 'archive') return act.openOverlay({ panel: 'archive' })
        if (c.action === 'capture-region') return act.openOverlay({ panel: 'capture' })
        // As the File menu does: the main process closes the bar first, so that the page is what is captured, not the bar over it.
        if (c.action === 'capture-full') return act.captureFullPage()
        if (c.action === 'capture') return act.captureVisible()
        if (c.action === 'site-info') return act.openOverlay({ panel: 'site' })
        if (c.action === 'create-shortcut' && c.url) return act.openOverlay({ panel: 'shortcut', url: c.url, title: hostOf(c.url) })
        if (c.action === 'clear-site-data') return act.openOverlay({ panel: 'sitedata' })
        if (c.action === 'export-markdown') {
          // The main process closes the bar and gives the page the keyboard before its picker opens.
          act.markdownExport()
          break
        }
        if (c.action === 'sessions') return act.openOverlay({ panel: 'sessions' })
        if (c.action === 'save-session') return act.openOverlay({ panel: 'sessions', focus: 'save' })
        if (c.action === 'clear-site-now') {
          act.clearSiteNow()
          break
        }
        if (c.action === 'reload-all') {
          act.reloadAllTabs()
          break
        }
        if (c.action === 'recent-notices') return act.openOverlay({ panel: 'notices' })
        if (c.action === 'web-panel-add') {
          act.webPanel({ op: 'add' })
          break
        }
        if (c.action === 'web-panel-close') {
          act.webPanel({ op: 'close' })
          break
        }
        if (c.action === 'name-window') return act.openOverlay({ panel: 'windowname' })
        // The sidebar of this window (window-sidebar.ts): the main process keeps it; the bar only closes.
        const sidebarChange = windowSidebarChangeOf(c.action)
        if (sidebarChange) {
          act.windowSidebar(sidebarChange)
          break
        }
        if (c.action === 'aside-space') {
          // The main process closes the bar and asks before it closes the pages of the space.
          act.asideSpace()
          break
        }
        // The shell shows the file dialog or the sheet, and says how it went in a toast: the bar only closes.
        if (c.action === 'import-boost' || c.action === 'paste-boost') {
          void act.boostShare({ kind: c.action === 'import-boost' ? 'import-file' : 'import-link' }).catch((error: unknown) => console.error('[boost] sharing failed:', error))
          break
        }
        if (c.action === 'import-theme' || c.action === 'export-theme') {
          void act.themeCode({ kind: c.action === 'import-theme' ? 'import-file' : 'export-file', spaceId: snapshot.state.activeSpaceId }).catch((error: unknown) => console.error('[theme] sharing failed:', error))
          break
        }
        if (c.action === 'web-store') {
          act.openWebStore()
          break
        }
        if (c.action === 'lock-now') {
          // The lock screen replaces the window: the bar goes first.
          act.closeOverlay()
          void act.lockConfigure({ op: 'lock-now' })
          break
        }
        if (c.action === 'auto-reload') {
          const tab = activeTab(snapshot.state)
          if (tab) return act.openOverlay({ panel: 'autoreload', tabId: tab.id })
        }
        if (c.action === 'find') return act.openOverlay({ panel: 'find' })
        if (c.action === 'downloads') return act.openOverlay({ panel: 'downloads' })
        if (c.action === 'read-later-list') return act.openOverlay({ panel: 'readlater' })
        if (c.action === 'bookmarks-list') return act.openOverlay({ panel: 'bookmarks' })
        if (c.action === 'live-folder-new') return act.openOverlay({ panel: 'livefolder' })
        // The main process opens the panel in place of the bar (no closeOverlay: it would close the panel that replaces it).
        if (c.action === 'notes' || c.action === 'new-note') {
          void act.notes(c.action === 'new-note' ? { kind: 'open', compose: true } : { kind: 'open' }).catch((error: unknown) => console.error('[notes] the panel could not be asked for:', error instanceof Error ? error.message : typeof error))
          return
        }
        // "note <text>": the main process makes the note, tied to the page on screen, and says so in a notice; the bar only closes.
        if (c.action === 'jot-note' && c.text !== undefined) {
          void act.notes({ kind: 'jot', text: c.text }).catch((error: unknown) => console.error('[notes] the note could not be asked for:', error instanceof Error ? error.message : typeof error))
          break
        }
        if (c.action === 'open-as-app') {
          // The main process opens the window of the site; the bar only closes.
          act.openAsApp()
          break
        }
        if (c.action === 'cookie-manager') return act.openOverlay({ panel: 'cookies' })
        if (c.action === 'passwords') return act.openOverlay({ panel: 'passwords' })
        if (c.action === 'fill-password') {
          // The bar goes first, so that the page has the focus when it is filled; the main process says by a notice when it cannot.
          act.closeOverlay()
          void act.passwords({ kind: 'fill-active' }).catch((error: unknown) => console.error('[passwords] the fill could not be asked for:', error instanceof Error ? error.name : typeof error))
          return
        }
        if (c.action === 'new-private-tab') {
          // The main process opens the tab and puts the bar over it again, to type where it goes.
          act.newPrivateTab()
          break
        }
        if (c.action === 'settings' || c.action === 'edit-shortcuts') {
          act.closeOverlay()
          return act.openOverlay(c.action === 'settings' ? { panel: 'settings' } : { panel: 'settings', pane: 'keyboard', anchor: 'shortcuts' })
        }
        if (c.action === 'edit-theme') return act.openOverlay({ panel: 'theme', spaceId: snapshot.state.activeSpaceId })
        if (c.action === 'edit-space') return act.openOverlay({ panel: 'space', spaceId: snapshot.state.activeSpaceId })
        if (c.action === 'new-space') return act.openOverlay({ panel: 'spacecreate' })
        const action = actionToDispatch(c.action, snapshot.state)
        if (action) void act.dispatch(action)
        break
      }
    }
    act.closeOverlay()
  }

  /** ⌘↩: the page of a line (a tab, a page of the history, an address or a search) in a new tab. A line with no page does what ↩ does. */
  const openInNewTab = (c: Candidate) => {
    const target = snapshot ? newTabOf(c, snapshot.state) : { how: 'run' as const }
    if (target.how === 'run') return run(c)
    if (c.kind === 'open' || c.kind === 'history') void api().dispatch({ type: 'commandbar/used', key: usageKey(c.url) })
    if (target.how === 'submit') return api().submitUrl(target.url, 'new')
    // The line of a private tab: its page opens in another private tab, never in an ordinary one.
    void api().dispatch({ type: 'tab/open', url: target.url, private: true })
    api().closeOverlay()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') dismiss()
    // ⌘Z while « Annuler » is offered takes the forgetting back; at any other time the key is the field's (it undoes what was typed).
    else if (forgotten && e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) undoForget()
    else if ((e.key === 'Backspace' || e.key === 'Delete') && e.shiftKey) {
      // ⇧⌫ forgets the highlighted page of the history, once that line was chosen with the arrows; else the key is the field's.
      const c = candidates[selected]
      if (!picked || c?.kind !== 'history') return
      forgetPage(c.url)
    } else if (e.key === 'Backspace' && scope && query === '') setScope(null)
    // A genre chosen by its chip is let go of with Backspace on the empty field, as the pill of a site search is.
    else if (e.key === 'Backspace' && chipScope && query === '') setChipScope(null)
    else if (e.key === 'ArrowDown') {
      setSelected((s) => Math.min(s + 1, candidates.length - 1))
      setPicked(true)
    } else if (e.key === 'ArrowUp') {
      setSelected((s) => Math.max(s - 1, 0))
      setPicked(true)
    } else if (e.key === 'Tab') {
      // Tab completes a site search keyword: prefer the highlighted one, else the first on offer. With none to complete the key keeps its own job, the focus
      // goes on (to the genres, then to "Copier" and "Coller"); it used to end here and shut the keyboard out of them. Shift+Tab always goes back:
      // it completed a keyword too, so the focus could not leave the field backwards while a site search was on offer.
      if (e.shiftKey || (!acceptSiteSearch(candidates[selected]) && !acceptSiteSearch(candidates.find((c) => c.kind === 'site-search')))) return
    } else if (e.key === 'Enter' && e.shiftKey && query.trim() && !scope && !little && barScope === null) {
      // ⇧↩: the first result of the search, not the results page; commas open several.
      api().submitUrl(query, mode, true)
    } else if (e.key === 'Enter' && commandHeld(e, platform) && !little && candidates[selected]) {
      // ⌘↩ (Ctrl+Enter away from macOS): the page of the line in a new tab, whatever Enter does on it.
      openInNewTab(candidates[selected]!)
    } else if (e.key === 'Enter') {
      // Enter on raw text must always navigate, even before the candidate list has caught up. Inside `>` or `@` there is no raw text to send (`@abc` is not an address); a genre of bookmarks or history that finds nothing searches as typed.
      if (candidates[selected]) run(candidates[selected])
      else if (query.trim() && (barScope === null || ((barScope === 'bookmarks' || barScope === 'history') && lookFor.trim()))) go(query)
    } else if (e.key === 'Home' || e.key === 'End') {
      // The first or the last result, once the caret is at that end of the text; before that the key moves the caret, as in any field.
      const to = resultAtEdge(e.key, e, e.currentTarget as HTMLInputElement, candidates.length)
      if (to === null) return
      setSelected(to)
      setPicked(true)
    } else return
    e.preventDefault()
  }

  // The card is a dark tint over whatever the page behind it is: the colour the tab reports stands for that page.
  const shown = activeTab(snapshot.state)
  const surface = cardSurface(pageColorBehind(shown ? (snapshot.runtime.tabs[shown.id]?.color ?? null) : undefined))
  // 640 px for the field alone, 720 px with lines to choose from and the preview of the highlighted one on the right; the mini window fills its own.
  const layout = barLayout(candidates.length, !!little)
  // The size and the shape the user chose (Settings › Recherche): the width, the height of the list and the preview column, which the style sheet reads.
  const box = barBox(snapshot.state.settings.commandBarSize, snapshot.state.settings.commandBarShape, layout.preview)
  const current = candidates[selected]
  const preview = !little && layout.preview && current ? candidatePreview(current, { state: snapshot.state, runtime: snapshot.runtime, history, now: Date.now(), mode, picked, platform }) : null
  const helpKey = effectiveAccelerator('shortcutHelp', snapshot.state.settings.keyBindings, platform)
  // The function `shortcutHelp` gives the button its sheet; off, the button keeps the older reminder of the keys of the bar.
  const openHelp = () => {
    if (snapshot.state.settings.shortcutHelp) return api().openOverlay({ panel: 'shortcuts' })
    setHelp(!help)
  }
  const scopes: Array<{ id: BarScope; label: string }> = [
    { id: 'commands', label: t('cmd.filtre-commandes') },
    { id: 'tabs', label: t('cmd.filtre-onglets') },
    { id: 'bookmarks', label: t('cmd.filtre-signets') },
    { id: 'history', label: t('cmd.filtre-historique') }
  ]
  // An address typed in full opens a new tab with Enter; the tab already on it is the next line.
  const addressWithTab = candidates[0]?.kind === 'open' && candidates[0].search !== true && candidates.some((c) => c.kind === 'tab')
  /** The space a tab lives in, found by its id: two spaces may wear the same emoji, and the name of the first one was then said for both. */
  const whereOf = (c: Candidate): { emoji: string; name: string } | null => {
    // The mini window names the space once, in its title; its rows keep the look they had.
    if (little || c.kind !== 'tab' || snapshot.state.spaces.length < 2) return null
    return snapshot.state.spaces.find((sp) => sp.id === snapshot.state.tabs.find((x) => x.id === c.tabId)?.spaceId) ?? null
  }

  return (
    <div
      className={`palette ${layout.width === BAR_WIDTH.field ? 'cb-field' : ''} ${layout.preview ? 'cb-wide' : ''} ${mode === 'split' ? 'cb-split' : ''} ${little ? 'cb-little' : ''}`}
      role="dialog"
      aria-label={t('cmd.barre-de-commandes')}
      // The card is a dark tint over the page behind it (cardSurface), read with the dark values of the tokens (command-bar.css). A mini window has the colours of its own window.
      style={little ? undefined : ({ '--cb-fill': surface.fill, '--cb-edge': surface.edge, '--cb-ring': surface.ring, '--cb-width': `${box.width}px`, '--cb-list': `${box.list}px`, '--cb-preview': `${box.previewWidth}px` } as React.CSSProperties)}
    >
      {/* The mini window says where the page it opens will go: "Mini-fenêtre · 💼 Travail" (the space the main window is on, which ⌘O opens it in). */}
      {little && targetSpace && (
        <div className="palette-title" aria-hidden="true">
          {t('littlearc.titre-avec-espace', { space: `${targetSpace.emoji} ${targetSpace.name}`.trim() })}
        </div>
      )}
      {/* A bar opened for a split view says where the page will open, as the mini window's title does. */}
      {mode === 'split' && !little && (
        <div className="cb-strip">
          <span>{t('cmd.vue-scindee-volet-de-droite')}</span>
          <button type="button" className="cb-strip-close" aria-label={t('cmd.annuler-echap')} title={t('cmd.annuler-echap')} onMouseDown={(e) => e.preventDefault()} onClick={dismiss}>
            <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.600" strokeLinecap="round" aria-hidden="true">
              <path d="m2 2 8 8m0-8-8 8" />
            </svg>
          </button>
        </div>
      )}
      <div className="palette-head">
        <span className="palette-search">{completion ? ICONS.open : ICONS.suggestion}</span>
        {scope && (
          <span className="scope-pill" title={t('cmd.retour-arriere-pour-retirer-la-recherche')}>
            {scope.name}
            <button aria-label={t('cmd.retirer-la-recherche-dans-ce-site')} onClick={() => setScope(null)}>
              ✕
            </button>
          </span>
        )}
        <input
          ref={input}
          className="palette-input"
          value={query + tail}
          placeholder={scope ? t('cmd.search-on', { name: scope.name }) : mode === 'split' && !little ? t('cmd.quelle-page-a-droite') : placeholder()}
          // A combobox: the arrows move through the results, and the one chosen is what a screen reader reads (the focus stays in the field).
          role="combobox"
          aria-label={scope ? t('cmd.search-on', { name: scope.name }) : t('cmd.adresse-ou-recherche')}
          aria-autocomplete="list"
          aria-expanded={candidates.length > 0}
          aria-controls="cb-results"
          aria-activedescendant={candidates[selected] ? `cb-option-${selected}` : undefined}
          spellCheck={false}
          autoFocus
          onChange={(e) => {
            setTyping(!(e.nativeEvent as InputEvent).inputType?.startsWith('delete'))
            const keyword = !scope && /^\S+ $/.test(e.target.value) ? e.target.value.trim() : null
            setPicked(false)
            if (keyword && enterScope(keyword)) return
            setQuery(e.target.value)
            setSelected(0)
          }}
          onKeyDown={onKeyDown}
        />
        {little ? (
          <button className="palette-close" title={t('cmd.fermer-echap')} aria-label={t('cmd.fermer-la-fenetre')} onClick={dismiss}>
            <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.600" strokeLinecap="round" aria-hidden="true">
              <path d="m2 2 8 8m0-8-8 8" />
            </svg>
          </button>
        ) : (
          // The round "i" had no word and led nowhere: a word, and the key of the sheet of the shortcuts when there is one.
          <button className={`palette-info ${help ? 'on' : ''}`} title={t('cmd.aide-de-la-barre-de-commandes')} aria-label={t('cmd.aide-de-la-barre-de-commandes')} aria-expanded={snapshot.state.settings.shortcutHelp ? undefined : help} onMouseDown={(e) => e.preventDefault()} onClick={openHelp}>
            {t('cmd.raccourcis')}
            {snapshot.state.settings.shortcutHelp && helpKey && <kbd aria-hidden="true">{formatAccelerator(helpKey, platform)}</kbd>}
          </button>
        )}
      </div>
      {!little && (
        <div className="cb-chips">
          {/* The genres, as buttons: `>`, `@`, `*` and `^` (or the words `@bookmarks`, `@history`) may also be typed first; `#` is the tag of a bookmark. */}
          <div className="cb-genres" role="group" aria-label={t('cmd.filtrer-par-type')}>
            {scopes.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={barScope === id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setChipScope(barScope === id ? null : id)
                  setQuery(lookFor)
                  setSelected(0)
                  setPicked(false)
                  input.current?.focus()
                }}
              >
                <kbd aria-hidden="true">{SCOPE_PREFIX[id]}</kbd>
                {label}
              </button>
            ))}
          </div>
          {/* A quick action at the right of the genres: the recent notifications (the command of that name), one click away. */}
          <button type="button" className="cb-quick" aria-label={t('cmd.notifications-recentes')} onMouseDown={(e) => e.preventDefault()} onClick={() => api().openOverlay({ panel: 'notices' })}>
            {t('cmd.notifications')}
          </button>
          {/* "Copier" and "Coller", at the right of the genres (not in the Mini-fenêtre, whose bar has its own layout). */}
          <BarClipboardButtons notice={clip} onCopy={copyField} onPaste={pasteField} />
        </div>
      )}
      {help && !little && !snapshot.state.settings.shortcutHelp && (
        <div className="palette-help">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t('cmd.choisir')}</span>
          <span><kbd>↩</kbd> {t('cmd.ouvrir')}</span>
          <span><kbd>⇥</kbd> {t('cmd.recherche-dans-un-site')}</span>
          <span><kbd>⇧</kbd><kbd>↩</kbd> {t('cmd.premier-resultat-plusieurs-separes-par-des')}</span>
          <span><kbd>⇧</kbd><kbd>⌫</kbd> {t('cmd.oublier-une-page-de-l-historique')}</span>
        </div>
      )}
      <div className="cb-body">
        {/* The mini window has no « Copier » nor « Coller », whose live region says the notices of the bar: it says them here. Not on screen. */}
        {little && (
          <span className="cb-count" role="status">
            {barNoticeText(clip)}
          </span>
        )}
        {/* How many lines the list has, said when it changes: the list is drawn without a word to a screen reader, whose focus stays in the field. Not on screen. */}
        <span className="cb-count" role="status">
          {tp('cmd.count-resultats', candidates.length)}
        </span>
        {candidates.length > 0 && (
          <ul className="results" ref={list} id="cb-results" role="listbox" aria-label={t('cmd.resultats')}>
            {/* No hover effect: the highlight follows the arrows and the click, never the pointer. */}
            {candidates.map((c, i) => {
              const group = groups[i]
              const where = whereOf(c)
              return (
                <Fragment key={c.id}>
                  {/* "Onglets ouverts" / "Suggestions" in the mini window's bar, the genres ("Onglets ouverts", "Signets", "Historique"…) in the main one: the title before the first row of each. */}
                  {group && (
                    <li className="group-title" role="presentation" aria-hidden="true">
                      {little ? (group === 'tabs' ? t('littlearc.onglets-ouverts') : t('littlearc.suggestions')) : groupTitle(group as Parameters<typeof groupTitle>[0], lookFor)}
                    </li>
                  )}
                  <li
                    id={`cb-option-${i}`}
                    role="option"
                    aria-selected={i === selected}
                    className={i === selected ? 'selected' : ''}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      run(c)
                    }}
                  >
                    <span className="kind">{lead(c)}</span>
                    <span className="label">{c.label}</span>
                    {c.detail && <span className="detail">— {c.detail}</span>}
                    {/* A tab says where Enter takes you on its row, not only on the highlighted one (mini window and main bar alike), and the space it lives in. */}
                    {where && (
                      <span className="where" title={where.name}>
                        <span aria-hidden="true">{where.emoji}</span>
                        {/* The name of the space, for a screen reader: the emoji alone was read, and a tooltip is not. */}
                        <span className="cb-count">{where.name}</span>
                      </span>
                    )}
                    {c.kind === 'tab' && (little || i !== selected) && <span className="chip">{candidateHint(c)}</span>}
                    {i === selected && !(little && c.kind === 'tab') && candidateHint(c) && <span className="hint">{candidateHint(c)}</span>}
                    {i === selected && (
                      <span className="keycap" aria-hidden="true">
                        {goesSomewhere(c) ? KEY_ARROW : KEY_RETURN}
                      </span>
                    )}
                  </li>
                </Fragment>
              )
            })}
          </ul>
        )}
        {preview && current && (
          <aside className="cb-preview" aria-label={t('cmd.apercu-de-la-ligne-selectionnee')}>
            <CommandPreview key={current.id} preview={preview} lead={preview.faviconUrl ? <ResultFavicon src={preview.faviconUrl} fallback={lead(current)} /> : lead(current)} />
          </aside>
        )}
      </div>
      {/* A page was just forgotten with ⇧⌫: said (to a screen reader too), with the way back for ACTION_NOTICE_MS (held while the pointer is on it). The button takes no focus from the field. */}
      {forgotten && (
        <div className="ts-undo cb-undo" role="status" aria-live="polite" key={forgotten.url} style={{ '--notice-ms': `${ACTION_NOTICE_MS}ms` } as CSSProperties} {...undoNotice.props}>
          <b>{t('cmd.page-oubliee')}</b>
          <span className="ts-undo-spacer" />
          <kbd aria-hidden="true">{commandPress('Z', platform)}</kbd>
          <button type="button" aria-keyshortcuts={ariaKeyShortcut('Z', platform)} onMouseDown={(e) => e.preventDefault()} onClick={undoForget}>
            {t('cmd.annuler')}
          </button>
        </div>
      )}
      {/* The bar of a mini window asks the search engine for suggestions too (above), so it says so as well, once. Not where nothing is asked. */}
      {query.trim() && !scope && !staysPrivate && snapshot.state.settings.searchSuggestions && !snapshot.state.settings.suggestionsNoticeSeen && (
        <div className="palette-note">
          <span>{t('cmd.nous-interrogeons-votre-moteur-de-recherche')}</span>
          <button className="link-button" onClick={() => api().openOverlay({ panel: 'settings', pane: 'profiles' })}>
            {t('cmd.reglages')}
          </button>
          <button className="toast-action" onClick={() => void api().dispatch({ type: 'settings/update', patch: { suggestionsNoticeSeen: true } })}>
            {t('cmd.compris')}
          </button>
        </div>
      )}
      {!little && (
        <div className="cb-foot">
          {mode === 'split' ? (
            <>
              <span><kbd>↵</kbd> {t('cmd.pied-ouvrir-a-droite')}</span>
              <span><kbd>{t('cmd.echap')}</kbd> {t('cmd.pied-annuler')}</span>
            </>
          ) : addressWithTab ? (
            <>
              <span><kbd>↵</kbd> {t('cmd.pied-nouvel-onglet')}</span>
              <span><kbd>↓</kbd> <kbd>↵</kbd> {t('cmd.pied-rejoindre-l-onglet-deja-ouvert')}</span>
              <span><kbd>{t('cmd.echap')}</kbd> {t('cmd.pied-fermer')}</span>
            </>
          ) : (
            <>
              <span><kbd>↑↓</kbd> {t('cmd.pied-parcourir')}</span>
              <span><kbd>↵</kbd> {t('cmd.pied-ouvrir')}</span>
              <span><kbd>{commandPress('↵', platform)}</kbd> {t('cmd.pied-nouvel-onglet')}</span>
              <span><kbd>{t('cmd.echap')}</kbd> {t('cmd.pied-fermer')}</span>
            </>
          )}
          <span className="cb-foot-spacer" />
          <button type="button" className="cb-foot-link" onMouseDown={(e) => e.preventDefault()} onClick={() => { api().closeOverlay(); api().openOverlay({ panel: 'settings', pane: 'keyboard', anchor: 'shortcuts' }) }}>
            {t('cmd.tous-les-raccourcis')}
          </button>
        </div>
      )}
    </div>
  )
}
