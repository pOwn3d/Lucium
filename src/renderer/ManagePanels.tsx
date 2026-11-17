import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { historyOwnerLine } from '@shared/history-scope'
import { ALL_DAYS, DAY_UNDO, dayBounds, historyColumns, visitTime, type HistoryColumns } from '@shared/history-days'
import type { HistoryEntry } from '@shared/model'
import { activeProfileId } from '@shared/profiles'
import type { PlusAnchor } from '@shared/plus-menu'
import { SPACE_UNDO_MS, archiveRefusal, archivedSpaces, asideSessionOf, canDeleteSpace, dropIndex, manageCounts, managedSpaces, stepIndex } from '@shared/space-manage'
import { hostOf } from '@shared/url'
import { api, useSnapshot } from './api'
import { radioGroupKeys } from './radio-keys'
import { SpaceMark } from './SpaceMark'
import { TabMark } from './TabPicture'
import { pictureNote } from '@shared/space-customize'
import { useActionNotice } from './notice-hold'
import { ArchiveGlyph, ClockGlyph, ListEmpty, ListGroup, ListPanel, ListRow, Sheet, SheetField, TabGlyph, TrashGlyph, activeSpaceHue, useSpaceHue, useUndoQueue } from './templates'
import './manage-panels.css'
import './space-manage.css'
import { actionName } from './action-name'

// ---------- History (Archive › Afficher l'historique) ----------
// A list panel in two columns: the days on the left, the pages of the chosen day on the right. ↑↓ go through the days or the pages,
// ↩ opens the page (in a new tab, and the panel closes), ⌘↩ opens it in a new tab behind and keeps the panel, ⌫ forgets it with eight seconds to take it back.

const HISTORY_ROWS = 500
const SEARCH_DELAY_MS = 120

/**
 * The history search of the panel: only the answer to the last request reaches the panel, so a slow answer to an older query does not
 * overwrite the one for the query on screen. A failed request gives no answer (`undefined`).
 */
export function latestHistorySearch(search: (query: string) => Promise<HistoryEntry[]>): (query: string) => Promise<HistoryEntry[] | undefined> {
  let last = 0
  return async (query) => {
    const ticket = ++last
    try {
      const entries = await search(query)
      return ticket === last ? entries : undefined
    } catch (error) {
      // The list on screen stays as it is; the cause goes to the console.
      console.warn('[history] the search failed:', error)
      return undefined
    }
  }
}

interface HistoryViewProps {
  columns: HistoryColumns
  query: string
  onPick: (day: string) => void
  onOpen: (entry: HistoryEntry) => void
  onForget: (entry: HistoryEntry, index: number) => void
}

/** The days column and the pages column, as the panel draws them from what the search found. */
export function HistoryView({ columns, query, onPick, onOpen, onForget }: HistoryViewProps) {
  const { alive, days, day, rows } = columns
  if (alive.length === 0) {
    return <ListEmpty icon={<ClockGlyph />} title={query ? t('manage-panels.aucun-resultat') : t('manage-panels.aucune-page-visitee')} />
  }
  return (
    <div className="hist-cols">
      <nav className="hist-days" aria-label={t('history-days.jour')}>
        {days.map((entry) => (
          <button key={entry.key} type="button" aria-current={entry.key === day} onClick={() => onPick(entry.key)}>
            {entry.label} <span>{entry.count}</span>
          </button>
        ))}
        <button type="button" aria-current={day === ALL_DAYS} onClick={() => onPick(ALL_DAYS)}>
          {t('history-days.tout')} <span>{alive.length}</span>
        </button>
      </nav>
      <div className="hist-pages">
        <ListGroup>
          {rows.map((entry, index) => (
            <ListRow
              key={entry.url}
              icon={(hostOf(entry.url)[0] ?? '·').toUpperCase()}
              title={entry.title || entry.url}
              subtitle={hostOf(entry.url)}
              hint={entry.url}
              meta={visitTime(entry.lastVisitAt, day === ALL_DAYS)}
              onOpen={() => onOpen(entry)}
              actions={
                <button type="button" className="tk-btn quiet small" aria-label={actionName(t('manage-panels.oublier'), entry.title || entry.url)} onClick={() => onForget(entry, index)}>
                  {t('manage-panels.oublier')}
                </button>
              }
            />
          ))}
        </ListGroup>
      </div>
    </div>
  )
}

/**
 * The history panel lists one profile: the one of the space on screen when it opens. When the space changes to one of another profile under the
 * open panel, the list is made again for that profile (the key), and what the old list still had to send (a page forgotten within its six
 * seconds) names the profile it was listed from: it never lands on the history of the new one.
 */
export function HistoryPanel() {
  const snapshot = useSnapshot()
  const profileId = snapshot ? activeProfileId(snapshot.state) : null
  return profileId === null ? null : <HistoryList key={profileId} profileId={profileId} />
}

function HistoryList({ profileId }: { profileId: string }) {
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const refocus = useRef<number | null>(null)
  const act = api()
  const [latest] = useState(() => latestHistorySearch((text) => api().searchHistory(text, HISTORY_ROWS, profileId)))
  const snapshot = useSnapshot()
  const undo = useUndoQueue()
  // The panel lists the history of the profile of the space shown; with several profiles it says whose.
  const owner = snapshot ? historyOwnerLine(snapshot.state, profileId) : null

  useEffect(() => {
    // An answer that is no longer the last one, or a failed search, leaves the list as it is.
    const timer = setTimeout(() => void latest(query).then((found) => { if (found) setEntries(found) }), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [query, latest])

  // A page that was forgotten gives the focus to the one that took its place.
  useEffect(() => {
    if (refocus.current === null) return
    const buttons = document.querySelectorAll<HTMLElement>('.hist-pages .lp-main')
    buttons[Math.min(refocus.current, buttons.length - 1)]?.focus()
    refocus.current = null
  })

  const columns = historyColumns(entries ?? [], undo.hidden, chosen, query !== '', Date.now())
  const { alive, days, day, rows } = columns

  const open = (url: string, behind = false) => {
    void act.dispatch({ type: 'tab/open', url, ...(behind ? { background: true } : {}) })
    if (!behind) act.closeOverlay()
  }
  // What the main process still holds, asked again after a deletion that failed or went further than the rows on screen: the list never shows a
  // page that is gone, nor hides one that stayed.
  const reload = () => void latest(query).then((found) => { if (found) setEntries(found) })
  const forgetPage = (entry: HistoryEntry, index: number) => {
    refocus.current = index
    undo.remove(entry.url, t('history-days.page-oubliee', { name: entry.title || hostOf(entry.url) }), () =>
      void act.forgetHistory(entry.url, profileId).then(() => setEntries((current) => current && current.filter((other) => other.url !== entry.url)), (error: unknown) => console.warn('[history] the page could not be forgotten:', error))
    )
  }
  // Every page of the day goes at once, and comes back together within the six seconds. The panel loads the newest pages only (`HISTORY_ROWS`),
  // so the day is forgotten by the main process, over the whole history of the profile: the rows on screen may be a part of it. During a
  // search the day shows the pages found, and only those go.
  const forgetDay = () => {
    const urls = new Set(rows.map((entry) => entry.url))
    const bounds = query === '' ? dayBounds(day) : null
    undo.remove(DAY_UNDO + day, t('history-days.jour-oublie', { day: days.find((candidate) => candidate.key === day)?.label ?? '' }), () => {
      const forgotten = bounds ? act.forgetHistoryDay(bounds.from, bounds.to, profileId) : Promise.all([...urls].map((url) => act.forgetHistory(url, profileId)))
      void forgotten.then(
        () => (bounds ? reload() : setEntries((current) => current && current.filter((other) => !urls.has(other.url)))),
        (error: unknown) => {
          console.warn('[history] the day could not be forgotten:', error)
          // Some of its pages may be gone, the others not: the list is read again.
          reload()
        }
      )
    })
  }

  // The keys of a page: ⌘↩ opens it behind, ⌫ forgets it. The days column goes through the days with ↑↓ (the panel's own arrows would leave it for the pages).
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    const nav = target.closest('.hist-days')
    if (nav && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      event.stopPropagation()
      const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>('button'))
      const next = buttons[(buttons.indexOf(target as HTMLButtonElement) + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]
      next?.focus()
      next?.click()
      return
    }
    const item = target.closest('li.lp-row')
    if (!item || !target.classList.contains('lp-main')) return
    const index = Array.from(item.parentElement?.children ?? []).indexOf(item)
    const entry = rows[index]
    if (!entry) return
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      open(entry.url, true)
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      forgetPage(entry, index)
    }
  }

  return (
    <ListPanel
      className="hist-panel"
      icon={<ClockGlyph />}
      title={t('manage-panels.historique')}
      count={entries === null ? undefined : alive.length}
      hue={snapshot ? activeSpaceHue(snapshot.state.spaces, snapshot.state.activeSpaceId) : undefined}
      search={{
        value: query,
        onChange: (text) => {
          setQuery(text)
          setChosen(null)
        },
        label: t('manage-panels.rechercher-dans-l-historique'),
        placeholder: t('manage-panels.rechercher-dans-l-historique'),
        onSubmit: (behind) => rows[0] && open(rows[0].url, behind)
      }}
      state={entries === null ? 'loading' : 'ready'}
      footStart={
        <button type="button" className="tk-btn quiet danger" disabled={day === ALL_DAYS || rows.length === 0} onClick={forgetDay}>
          {t('history-days.oublier-ce-jour')}
        </button>
      }
      onDone={() => act.closeOverlay()}
      undo={undo.panel}
    >
      <div onKeyDown={onKeyDown}>
        {owner && <p className="tk-status">{owner}</p>}
        {/* The list is cut at its limit (always far more than one page): said, so that an old day does not pass for complete. */}
        {query === '' && entries !== null && entries.length >= HISTORY_ROWS && <p className="tk-status">{t('history-days.liste-coupee', { count: HISTORY_ROWS })}</p>}
        <HistoryView columns={columns} query={query} onPick={setChosen} onOpen={(entry) => open(entry.url)} onForget={forgetPage} />
      </div>
    </ListPanel>
  )
}

// ---------- Manage Spaces (Espaces › Gérer les espaces…) ----------
// A list panel (templates): one row per space with its icon, profile and tabs; drag a row (or ⌥↑↓) to change the order of the sidebar; ↩ personalizes, ⌫ deletes.
// Deleting waits eight seconds with an "Annuler" (and ⌘Z), archiving is the space put aside and "Restaurer" gives it back at its place: nothing is lost by a click.

export function SpacesPanel() {
  const snapshot = useSnapshot()
  const undo = useUndoQueue(SPACE_UNDO_MS)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [reopen, setReopen] = useState<{ message: string; sessionId: string } | null>(null)
  // An archive the main process could not make, in words (until the next action of the panel).
  const [failure, setFailure] = useState('')
  const refocus = useRef<string | null>(null)
  const act = api()

  // A row that moved keeps the focus (React moves the node, the browser drops its focus).
  useEffect(() => {
    if (refocus.current === null) return
    document.querySelector<HTMLElement>(`.sm-row[data-id="${CSS.escape(refocus.current)}"] .lp-main`)?.focus()
    refocus.current = null
  })

  // The notice of an archive ends after the same eight seconds as the deletion's, and waits as it does while the pointer or the focus is on it.
  const reopening = useActionNotice(reopen, () => setReopen(null))

  if (!snapshot) return null
  const state = snapshot.state
  const hidden = undo.hidden
  // With windows of their own, the tabs of the other windows count too: deleting a space or putting it aside takes them all.
  const spaces = managedSpaces(state, snapshot.spaceTabs).filter((space) => !hidden.has(space.id))
  const archived = archivedSpaces(state).filter((space) => !hidden.has(`session:${space.sessionId}`))
  const counts = manageCounts(state, hidden, snapshot.spaceTabs)

  const personalize = (id: string) => act.openOverlay({ panel: 'space', spaceId: id })
  const move = (id: string, toIndex: number | null, keepFocus = true) => {
    if (toIndex === null) return
    if (keepFocus) refocus.current = id
    void act.dispatch({ type: 'space/move', id, toIndex })
  }
  const remove = (id: string, name: string, tabs: number) => {
    if (!canDeleteSpace(state, hidden, id)) return
    setReopen(null)
    undo.remove(id, tp('space-manage.espace-supprime', tabs, { name }), () => void act.dispatch({ type: 'space/delete', id }))
  }
  const archive = (id: string, name: string) => {
    if (archiveRefusal(state, hidden, id) !== null) return
    // The window of an earlier deletion closes: the notice below is for this action alone.
    undo.flush()
    setFailure('')
    act
      .dispatch({ type: 'space/aside', id })
      .then(async () => {
        const sessionId = asideSessionOf((await act.getSnapshot()).state, id)
        if (sessionId) setReopen({ message: t('space-manage.espace-mis-de-cote', { name }), sessionId })
      })
      .catch((error: unknown) => {
        console.warn('[spaces] the space could not be archived:', error)
        setFailure(t('space-manage.l-espace-n-a-pas-pu-etre-mis-de-cote', { name }))
      })
  }
  const restore = (sessionId: string) => {
    setReopen(null)
    void act.dispatch({ type: 'space/reopen', id: sessionId })
  }
  const forget = (sessionId: string, name: string) => {
    setReopen(null)
    undo.remove(`session:${sessionId}`, t('space-manage.espace-mis-de-cote-supprime', { name }), () => void act.dispatch({ type: 'session/delete', id: sessionId }))
  }

  const onRowKey = (event: ReactKeyboardEvent<HTMLLIElement>, id: string, name: string, tabs: number) => {
    if (event.target !== event.currentTarget.querySelector('.lp-main')) return
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      // The panel's own arrows (row to row) must not also run.
      event.stopPropagation()
      move(id, stepIndex(state.spaces, id, event.key === 'ArrowUp' ? -1 : 1))
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      remove(id, name, tabs)
    }
  }

  const summary = [tp('space-manage.espaces', counts.spaces), tp('space-manage.onglets', counts.tabs), ...(counts.archived > 0 ? [tp('space-manage.mis-de-cote', counts.archived)] : [])].join(' · ')
  const notice = reopen ? { message: reopen.message, onUndo: () => restore(reopen.sessionId), onHold: reopening.hold } : undo.panel

  return (
    <ListPanel
      className="sm-panel"
      icon={<SpacesGlyph />}
      title={t('manage-panels.gerer-les-espaces')}
      count={summary}
      hue={activeSpaceHue(state.spaces, state.activeSpaceId)}
      action={
        <button type="button" className="tk-btn" onClick={() => act.openOverlay({ panel: 'spacecreate' })}>
          {t('space-manage.nouvel-espace')}
        </button>
      }
      onDone={() => act.closeOverlay()}
      undo={notice}
    >
      <p className="tk-status">{t('space-manage.glissez-une-ligne')}</p>
      {failure && (
        <p className="tk-status error" role="alert">
          {failure}
        </p>
      )}
      <ListGroup>
        {spaces.map((space, index) => (
          <li
            key={space.id}
            className={`lp-row sm-row${dragging === space.id ? ' dragging' : ''}${over === space.id && dragging !== space.id ? ' over' : ''}`}
            data-id={space.id}
            draggable
            onDragStart={(event) => {
              setDragging(space.id)
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', space.id)
            }}
            onDragOver={(event) => {
              if (dragging === null) return
              event.preventDefault()
              setOver(space.id)
            }}
            onDrop={(event) => {
              event.preventDefault()
              if (dragging !== null) move(dragging, dropIndex(state.spaces, dragging, space.id), false)
              setDragging(null)
              setOver(null)
            }}
            onDragEnd={() => {
              setDragging(null)
              setOver(null)
            }}
            onKeyDown={(event) => onRowKey(event, space.id, space.name, space.tabs)}
          >
            <span className="sm-grip" aria-hidden="true">
              <GripGlyph />
            </span>
            <button type="button" className="lp-main" aria-label={t('space-manage.personnaliser-name', { name: space.name })} title={t('space-manage.personnaliser-aide')} onClick={() => personalize(space.id)}>
              <span className="lp-ico sm-ico" aria-hidden="true">
                <SpaceMark space={space.space} className="manage" />
              </span>
              <span className="lp-text">
                <span className="lp-title">{space.name}</span>
                <span className="lp-sub sm-sub">
                  {space.current && <span className="sm-chip current">{t('space-manage.actuel')}</span>}
                  <span className="sm-chip">{space.profile}</span>
                  {tp('space-manage.onglets', space.tabs)}
                </span>
              </span>
            </button>
            <span className="lp-actions">
              <button type="button" className="tk-btn quiet icon" disabled={index === 0} aria-label={t('space-manage.monter-name', { name: space.name })} title={t('space-manage.monter-aide')} onClick={() => move(space.id, stepIndex(state.spaces, space.id, -1), false)}>
                <ArrowGlyph up />
              </button>
              <button type="button" className="tk-btn quiet icon" disabled={index === spaces.length - 1} aria-label={t('space-manage.descendre-name', { name: space.name })} title={t('space-manage.descendre-aide')} onClick={() => move(space.id, stepIndex(state.spaces, space.id, 1), false)}>
                <ArrowGlyph />
              </button>
              <button type="button" className="tk-btn quiet icon" aria-label={t('space-manage.personnaliser-name', { name: space.name })} title={t('space-manage.personnaliser-aide')} onClick={() => personalize(space.id)}>
                <EditGlyph />
              </button>
              <button
                type="button"
                className="tk-btn quiet icon"
                disabled={archiveRefusal(state, hidden, space.id) !== null}
                aria-label={t('space-manage.mettre-name-de-cote', { name: space.name })}
                title={archiveRefusal(state, hidden, space.id) ?? t('space-manage.mettre-de-cote-aide')}
                onClick={() => archive(space.id, space.name)}
              >
                <ArchiveGlyph />
              </button>
              <button type="button" className="tk-btn quiet icon danger" disabled={!canDeleteSpace(state, hidden, space.id)} aria-label={t('space-manage.supprimer-name', { name: space.name })} title={!canDeleteSpace(state, hidden, space.id) ? t('space-customize.le-dernier-espace-ne-peut-pas-etre-supprime') : t('space-manage.supprimer-aide')} onClick={() => remove(space.id, space.name, space.tabs)}>
                <TrashGlyph />
              </button>
            </span>
          </li>
        ))}
      </ListGroup>
      {archived.length > 0 && (
        <ListGroup title={t('space-manage.mis-de-cote-titre')}>
          {archived.map((space) => (
            <li key={space.sessionId} className="lp-row sm-row archived" data-id={space.sessionId}>
              <span className="sm-grip" aria-hidden="true" />
              <button type="button" className="lp-main" aria-label={t('space-manage.rouvrir-name', { name: space.name })} title={t('space-manage.rouvrir-aide')} onClick={() => restore(space.sessionId)}>
                <span className="lp-ico sm-ico" aria-hidden="true">
                  <SpaceMark space={space.space} className="manage" />
                </span>
                <span className="lp-text">
                  <span className="lp-title">{space.name}</span>
                  <span className="lp-sub sm-sub">
                    <span className="sm-chip">{space.profile}</span>
                    {tp('space-manage.onglets', space.tabs)}
                  </span>
                </span>
              </button>
              <span className="sm-restore">
                <button type="button" className="tk-btn" onClick={() => restore(space.sessionId)}>
                  <RestoreGlyph />
                  {t('space-manage.rouvrir')}
                </button>
                <button type="button" className="tk-btn quiet icon danger" aria-label={t('space-manage.supprimer-name', { name: space.name })} title={t('space-manage.supprimer-mis-de-cote-aide')} onClick={() => forget(space.sessionId, space.name)}>
                  <TrashGlyph />
                </button>
              </span>
            </li>
          ))}
        </ListGroup>
      )}
    </ListPanel>
  )
}

function SpacesGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <rect x="2" y="2.500" width="12" height="11" rx="2.500" />
      <path d="M6 2.500v11M3.500 6h1M3.500 8h1" />
    </svg>
  )
}
function GripGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <g fill="currentColor" stroke="none">
        <circle cx="6" cy="4" r="1" />
        <circle cx="10" cy="4" r="1" />
        <circle cx="6" cy="8" r="1" />
        <circle cx="10" cy="8" r="1" />
        <circle cx="6" cy="12" r="1" />
        <circle cx="10" cy="12" r="1" />
      </g>
    </svg>
  )
}
function ArrowGlyph({ up }: { up?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={up ? 'M8 13V3.500M4 7l4-4 4 4' : 'M8 3v9.500M4 9l4 4 4-4'} />
    </svg>
  )
}
function EditGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M10.500 2.500a1.400 1.400 0 0 1 2 2L5 12l-2.500.500L3 10z" />
    </svg>
  )
}
function RestoreGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M2.500 8a5.500 5.500 0 1 0 1.800-4.100L2.500 5.500" />
      <path d="M2.500 2.500v3h3" />
    </svg>
  )
}

// ---------- Tab name and icon (tab menu › Renommer… / Changer l'icône…) ----------

const TAB_EMOJIS = ['🏠', '💼', '📚', '🛠️', '🎧', '💬', '📧', '📅', '📝', '💡', '🎨', '🎬', '🎮', '🛒', '💰', '✈️', '🍳', '🏋️', '🧪', '🚀', '⭐', '🔥', '❤️', '🔒', '🌍', '🧠', '📷', '🔗', '⚡', '✅', '📌', '🐞']

/**
 * The name and the icon of a tab: the sheet of the small editors, hung from the row that was right-clicked when it knows it (`anchor`).
 * Nothing is kept before "Enregistrer": Escape, "Annuler" and a click outside leave the tab as it was. One of the four bubbles that takes the
 * place of the editor keeps the name and the icon chosen so far, never the address: that would send the tab to another page on a click
 * that asked for something else.
 */
export function TabEditor({ tabId, focus = 'name', anchor }: { tabId: string; focus?: 'name' | 'icon'; anchor?: PlusAnchor }) {
  const snapshot = useSnapshot()
  const tab = snapshot?.state.tabs.find((t) => t.id === tabId)
  const [name, setName] = useState<string | null>(null)
  // '' is "the icon of the site"; null is "not touched".
  const [icon, setIcon] = useState<string | null>(null)
  // The address as typed, null while it is untouched: saved only when it differs from the page's.
  const [address, setAddress] = useState<string | null>(null)
  // « Choisir une image… »: the dialog of the main process is open; what went wrong, in words.
  const [picking, setPicking] = useState(false)
  const [pictureMessage, setPictureMessage] = useState('')
  const hue = useSpaceHue()
  const act = api()
  if (!snapshot || !tab) return null

  // A bubble replaces this editor: the name and the icon it holds are saved first, so that they are not lost. The address is not: the tab stays
  // on its page (the QR code shown is the one of that page).
  const anchorOf = (el: HTMLElement) => {
    const box = el.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  }
  const openBubble = (request: OverlayRequest) => {
    keep()
    act.openOverlay(request)
  }

  // The tab's picture stands for it while no emoji and not the site's icon has been chosen here; an emoji under it is not the one shown.
  const pictured = icon === null && tab.image !== undefined
  const shownIcon = icon ?? (pictured ? '' : (tab.icon ?? ''))
  // Opened on the icon (the menu's "Changer l’icône…"), the focus starts on the icon in use, or the first one.
  const iconFocus = focus === 'icon' ? (TAB_EMOJIS.includes(shownIcon) ? shownIcon : TAB_EMOJIS[0]) : null
  // The picture is taken at once, as a space's is: the dialog belongs to the main process, which gives the tab the stored copy (`tab/image`).
  const pickPicture = () => {
    setPicking(true)
    setPictureMessage('')
    void pictureNote(act.spaceImage({ op: 'pick-tab', tabId: tab.id }), t('space-image-picker.l-image-n-a-pas-pu-etre-importee'))
      .then((message) => {
        setPictureMessage(message)
        // The picture now stands for the tab: an emoji clicked before it is not saved over it.
        if (!message) setIcon(null)
      })
      .finally(() => setPicking(false))
  }
  /** The name and the icon, as chosen here. */
  const keep = () => {
    if (name !== null) void act.dispatch({ type: 'tab/rename', id: tab.id, title: name })
    // An emoji, or the site's icon taken back, also takes the picture away (`tab/icon`).
    if (icon !== null && (icon !== (tab.icon ?? '') || tab.image !== undefined)) void act.dispatch({ type: 'tab/icon', id: tab.id, icon })
  }
  const save = () => {
    keep()
    if (address !== null && address.trim() !== '' && address.trim() !== tab.url) act.setTabAddress(tab.id, address.trim())
    act.closeOverlay()
  }

  return (
    <Sheet
      className="tab-editor"
      title={t('manage-panels.modifier-l-onglet')}
      context={tab.title}
      glyph={<TabGlyph />}
      hue={hue}
      anchor={anchor}
      side="right"
      onCancel={() => act.closeOverlay()}
      primary={{ label: t('templates.enregistrer') }}
      onSubmit={save}
      footStart={
        <button type="button" className="tk-btn quiet" disabled={!shownIcon && !pictured} onClick={() => setIcon('')}>
          {t('manage-panels.reprendre-l-icone-du-site')}
        </button>
      }
    >
      <SheetField label={t('templates.nom')} help={t('manage-panels.laissez-vide-pour-reprendre-le-titre-de-la-page')}>
        {(field) => <input className="tk-field" {...field} value={name ?? tab.customTitle ?? ''} placeholder={tab.title} data-autofocus={focus === 'name' ? '' : undefined} onChange={(e) => setName(e.target.value)} />}
      </SheetField>
      <SheetField label={t('manage-panels.adresse')}>
        {(field) => <input className="tk-field" {...field} type="text" spellCheck={false} value={address ?? tab.url} onChange={(e) => setAddress(e.target.value)} />}
      </SheetField>
      {/* Four bubbles anchored on their buttons: the tab's name, its QR code, its translation, its live folder. The editor saves what it holds first. */}
      <div className="tab-editor-bubbles" role="group" aria-label={t('manage-panels.actions-de-l-onglet')}>
        <button type="button" className="tk-btn quiet" onClick={(e) => openBubble({ panel: 'windowname', anchor: anchorOf(e.currentTarget) })}>{t('window-name.nommer-la-fenetre')}</button>
        <button type="button" className="tk-btn quiet" onClick={() => openBubble({ panel: 'qr', text: tab.url })}>{t('qr-panel.code-qr')}</button>
        <button type="button" className="tk-btn quiet" onClick={() => openBubble({ panel: 'translate' })}>{t('translate.translate')}</button>
        <button type="button" className="tk-btn quiet" onClick={() => openBubble({ panel: 'livefolder' })}>{t('ctx.bloc-dossier-en-direct')}</button>
      </div>
      <div className="sh-field" role="radiogroup" onKeyDown={radioGroupKeys} aria-label={t('manage-panels.icone-de-l-onglet')}>
        <span>{t('settings.pane-icon')}</span>
        <div className="emoji-grid">
          {TAB_EMOJIS.map((emoji) => (
            <button key={emoji} type="button" role="radio" aria-checked={emoji === shownIcon} data-autofocus={emoji === iconFocus ? '' : undefined} className={`emoji ${emoji === shownIcon ? 'current' : ''}`} onClick={() => setIcon(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
        {/* A picture of the user's own, in place of an emoji: shown here while it stands for the tab. A private tab is written nowhere, so it keeps none. */}
        <div className="tab-editor-picture">
          {pictured && (
            <span className="tab-editor-picture-shown" role="img" aria-label={t('manage-panels.image-choisie')}>
              <TabMark tab={tab} />
            </span>
          )}
          <button type="button" className="tk-btn quiet" disabled={picking || tab.private === true} onClick={pickPicture}>
            {t('manage-panels.choisir-une-image')}
          </button>
        </div>
        {pictureMessage && (
          <p className="sh-error" role="alert">
            {pictureMessage}
          </p>
        )}
      </div>
    </Sheet>
  )
}

import { t, tp } from '@shared/i18n'
import type { OverlayRequest } from '@shared/ipc'
