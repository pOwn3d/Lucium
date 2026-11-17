import { useId, useMemo, useRef, useState } from 'react'
import { BOOKMARK_NOTE_MAX, BOOKMARK_TAG_MAX, BOOKMARK_TITLE_MAX, type Bookmark } from '@shared/model'
import { bookmarkAddressProblem, cleanTag, filterBookmarks, foldText, parseTagInput, tagCounts } from '@shared/bookmarks'
import { activeTab } from '@shared/sidebar'
import { hostOf } from '@shared/url'
import { readLaterAge } from '@shared/read-later'
import { api, useSnapshot } from './api'
import { BookmarkGlyph, ListGroup, ListPanel, activeSpaceHue, useUndoQueue } from './templates'
import './bookmarks.css'
import { t } from '@shared/i18n'
import { iconSource } from '@shared/site-icon'

/** The icon of a bookmark: its favicon, or the initial of its site when it has none (or the image cannot be shown). */
function BookmarkIcon({ bookmark }: { bookmark: Bookmark }) {
  const [failed, setFailed] = useState(false)
  const source = iconSource(bookmark.faviconUrl)
  if (source && !failed) return <img className="favicon bookmark-icon" src={source} alt="" draggable={false} onError={() => setFailed(true)} />
  return <span className="favicon bookmark-icon fallback">{(hostOf(bookmark.url) || bookmark.title || '?').charAt(0).toUpperCase()}</span>
}

interface Draft {
  id: string
  title: string
  url: string
  tags: string
  note: string
  /** Why the address was refused at the last "Enregistrer": shown under its field until the address is typed again. */
  problem?: string
}

/**
 * How many bookmarks the list draws at first, and how many more each « Afficher les suivants » adds. The library holds up to 5 000 of them, each
 * row with its picture, its buttons and its tags: drawn whole, the panel took long to open after a large import and the search stuttered.
 */
export const BOOKMARKS_SHOWN_STEP = 200

const NO_BOOKMARKS: Bookmark[] = []

/**
 * "Signets…" (setting `bookmarkManager`): the library of pages kept for good. A search over titles, addresses, notes and tags (a word that starts
 * with "#" is a tag), the tags in use as chips to narrow the list (all the chosen ones must be on a bookmark), editing in place, deleting, and
 * the file of bookmarks (import, export) whose dialogs belong to the main process. The favourites and pinned tabs of the sidebar are not here.
 * The frame is the template of the panels of a list (templates/ListPanel.tsx): a bookmark deleted leaves the list at once and can be taken back
 * ("Annuler", ⌘Z), and the arrows go from one bookmark to the next.
 */
export function Bookmarks() {
  const snapshot = useSnapshot()
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmTagDelete, setConfirmTagDelete] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  // How many rows are drawn, for one search and one choice of tags: another search starts again from the first rows.
  const [drawn, setDrawn] = useState({ filter: '', count: BOOKMARKS_SHOWN_STEP })
  const problemId = useId()
  // Return and the loss of focus both end a name being typed: whichever comes first counts, once.
  const renameEnded = useRef(false)
  // The ages are computed once per opening of the panel: they do not need to tick while it is on screen.
  const [now] = useState(() => Date.now())
  const undo = useUndoQueue()
  const library = snapshot?.state.bookmarks
  // A bookmark whose deletion can still be taken back is out of the list, of its count and of the tags.
  const list = useMemo(() => (library ?? NO_BOOKMARKS).filter((bookmark) => !undo.hidden.has(bookmark.id)), [library, undo.hidden])
  const tags = useMemo(() => tagCounts(list), [list])
  // A tag that is chosen but no longer exists (renamed, deleted, its last bookmark removed) is dropped from the choice.
  const effective = useMemo(() => {
    const known = new Set(tags.map((t) => foldText(t.tag)))
    return chosen.filter((t) => known.has(foldText(t)))
  }, [tags, chosen])
  const shown = useMemo(() => filterBookmarks(list, query, effective), [list, query, effective])
  const act = api()
  const filterKey = JSON.stringify([query, effective])
  const visible = useMemo(() => shown.slice(0, drawn.filter === filterKey ? drawn.count : BOOKMARKS_SHOWN_STEP), [shown, drawn, filterKey])
  if (!snapshot || !library) return null

  const current = activeTab(snapshot.state)
  const canAddCurrent = current !== undefined && current.private !== true && /^https?:\/\//i.test(current.url) && !list.some((b) => b.url === current.url)
  const filtering = query.trim() !== '' || effective.length > 0
  const toggleTag = (tag: string) => {
    setConfirmTagDelete(false)
    setRenaming(null)
    setChosen(effective.some((t) => foldText(t) === foldText(tag)) ? effective.filter((t) => foldText(t) !== foldText(tag)) : [...effective, tag])
  }

  const open = (id: string) => {
    void act.dispatch({ type: 'bookmark/open', id })
    act.closeOverlay()
  }
  // The bookmark leaves the list at once; it is deleted when the time to take it back has passed, or when the panel is left.
  const remove = (b: Bookmark) => undo.remove(b.id, t('bookmarks.signet-supprime', { name: b.title }), () => void act.dispatch({ type: 'bookmark/remove', id: b.id }))
  // What follows reads or fills the library as the list shows it: a deletion still waiting is made first (its address is free again, the file
  // written does not hold it).
  const addCurrent = () => {
    if (!current) return
    undo.flush()
    void act.dispatch({ type: 'bookmark/add', tabId: current.id })
  }
  const beginEdit = (b: Bookmark) => setDraft({ id: b.id, title: b.title, url: b.url, tags: b.tags.join(', '), note: b.note ?? '' })
  const saveDraft = () => {
    if (!draft) return
    // An address the library refuses would have the whole change dropped: the form stays open and says why, under the field it is about.
    const problem = bookmarkAddressProblem(list, draft.id, draft.url.trim())
    if (problem !== null) return setDraft({ ...draft, problem })
    undo.flush()
    void act.dispatch({ type: 'bookmark/edit', id: draft.id, patch: { title: draft.title, url: draft.url.trim(), tags: parseTagInput(draft.tags), note: draft.note } })
    setDraft(null)
  }
  const transfer = (op: 'import' | 'export') => {
    undo.flush()
    setBusy(true)
    setMessage('')
    void act
      .bookmarksTransfer({ op })
      .then((reply) => setMessage(reply.message))
      .catch((error: unknown) => {
        console.error('[bookmarks] the transfer failed:', error)
        setMessage(t('pwd.l-operation-a-echoue'))
      })
      .finally(() => setBusy(false))
  }
  const commitRename = () => {
    if (renameEnded.current) return
    renameEnded.current = true
    const from = effective[0]
    if (renaming !== null && from !== undefined && cleanTag(renaming) !== null) {
      void act.dispatch({ type: 'bookmark/tag-rename', from, to: renaming })
      setChosen([renaming])
    }
    setRenaming(null)
  }
  // The panel sends ↓ from a field down to the rows. In a form of the list the key belongs to the field: the lines of a note, the tags proposed.
  const keepArrowInField = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') event.stopPropagation()
  }

  const row = (b: Bookmark) => {
    if (draft?.id === b.id) {
      return (
        <li key={b.id} className="bookmark-row editing" data-id={b.id}>
          <div className="bookmark-form" onKeyDown={keepArrowInField}>
            <label>
              {t('bookmarks.nom')}
              <input className="tk-field" data-field="title" autoFocus maxLength={BOOKMARK_TITLE_MAX} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </label>
            <label>
              {t('bookmarks.adresse')}
              <input
                className="tk-field"
                data-field="url"
                spellCheck={false}
                aria-invalid={draft.problem ? true : undefined}
                aria-describedby={draft.problem ? problemId : undefined}
                value={draft.url}
                onChange={(e) => setDraft({ ...draft, url: e.target.value, problem: undefined })}
              />
            </label>
            {draft.problem && (
              <p id={problemId} className="bookmark-problem" role="alert">
                {draft.problem}
              </p>
            )}
            <label>
              {t('bookmarks.etiquettes-separees-par-des-virgules')}
              <input className="tk-field" data-field="tags" list="bookmark-tags" spellCheck={false} placeholder={t('bookmarks.lecture-outils')} value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
            </label>
            <label>
              {t('bookmarks.note')}
              <textarea className="tk-field" data-field="note" rows={2} maxLength={BOOKMARK_NOTE_MAX} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
            </label>
            <div className="bookmark-form-actions">
              <button type="button" className="tk-btn" data-action="save" onClick={saveDraft}>
                {t('bookmarks.enregistrer')}
              </button>
              <button type="button" className="tk-btn quiet" data-action="cancel" onClick={() => setDraft(null)}>
                {t('bookmarks.annuler')}
              </button>
            </div>
          </div>
        </li>
      )
    }
    return (
      <li key={b.id} className="lp-row bookmark-row" data-id={b.id}>
        <button type="button" className="lp-main" data-action="open" aria-label={t('bookmarks.ouvrir-name', { name: b.title })} title={b.url} onClick={() => open(b.id)}>
          <BookmarkIcon bookmark={b} />
          <span className="lp-text">
            <span className="lp-title bookmark-title">{b.title}</span>
            <span className="lp-sub bookmark-meta">
              {hostOf(b.url)} · {readLaterAge(b.addedAt, now)}
            </span>
            {b.note && <span className="lp-sub bookmark-note">{b.note}</span>}
          </span>
        </button>
        <span className="lp-actions">
          <button type="button" className="tk-btn quiet" data-action="edit" aria-label={t('bookmarks.modifier-name', { name: b.title })} onClick={() => beginEdit(b)}>
            {t('bookmarks.modifier')}
          </button>
          <button type="button" className="tk-btn quiet danger" data-action="remove" aria-label={t('bookmarks.supprimer-name', { name: b.title })} onClick={() => remove(b)}>
            {t('bookmarks.supprimer')}
          </button>
        </span>
        {/* Under the row, not in its main button: each tag is a button of its own. */}
        {b.tags.length > 0 && (
          <span className="bookmark-tags">
            {b.tags.map((tag) => (
              <button type="button" key={tag} className="tk-chip bookmark-tag" data-action="tag" aria-label={t('bookmarks.filtrer-sur-l-etiquette-t', { t: tag })} onClick={() => toggleTag(tag)}>
                #{tag}
              </button>
            ))}
          </span>
        )}
      </li>
    )
  }

  return (
    <ListPanel
      className="bookmarks"
      icon={<BookmarkGlyph />}
      title={t('settings.signets')}
      count={filtering ? `${shown.length} / ${list.length}` : list.length}
      hue={activeSpaceHue(snapshot.state.spaces, snapshot.state.activeSpaceId)}
      search={{
        value: query,
        onChange: setQuery,
        label: t('bookmarks.rechercher-dans-les-signets'),
        placeholder: t('bookmarks.rechercher-titre-adresse-note-etiquette'),
        onSubmit: () => shown[0] && open(shown[0].id)
      }}
      action={
        <button type="button" className="tk-btn" data-action="add-current" disabled={!canAddCurrent} title={t('bookmarks.garde-la-page-de-l-onglet-actif')} onClick={addCurrent}>
          {t('bookmarks.ajouter-la-page-en-cours')}
        </button>
      }
      filters={
        tags.length > 0
          ? tags.map((t) => {
              const on = effective.some((c) => foldText(c) === foldText(t.tag))
              return (
                <button type="button" key={t.tag} className="tk-chip bookmark-chip" data-action="chip" aria-pressed={on} onClick={() => toggleTag(t.tag)}>
                  #{t.tag} <span className="bookmark-chip-count">{t.count}</span>
                </button>
              )
            })
          : undefined
      }
      filtersLabel={t('bookmarks.etiquettes')}
      footStart={
        <>
          <button type="button" className="tk-btn quiet" data-action="import" disabled={busy} onClick={() => transfer('import')}>
            {t('bookmarks.importer')}
          </button>
          <button type="button" className="tk-btn quiet" data-action="export" disabled={busy || list.length === 0} onClick={() => transfer('export')}>
            {t('bookmarks.exporter')}
          </button>
        </>
      }
      onDone={() => act.closeOverlay()}
      undo={undo.panel}
    >
      <datalist id="bookmark-tags">
        {tags.map((t) => (
          <option key={t.tag} value={t.tag} />
        ))}
      </datalist>
      {effective.length === 1 && (
        <div className="bookmark-tagtools">
          {renaming === null ? (
            <>
              <button
                type="button"
                className="tk-btn quiet"
                data-action="tag-rename"
                onClick={() => {
                  renameEnded.current = false
                  setConfirmTagDelete(false)
                  setRenaming(effective[0]!)
                }}
              >
                {t('bookmarks.renommer-l-etiquette')}
              </button>
              {confirmTagDelete ? (
                <>
                  <button
                    type="button"
                    className="tk-btn primary danger"
                    data-action="tag-delete-confirm"
                    onClick={() => {
                      void act.dispatch({ type: 'bookmark/tag-delete', tag: effective[0]! })
                      setConfirmTagDelete(false)
                      setChosen([])
                    }}
                  >
                    {t('bookmarks.retirer-tag-de-tous-les-signets', { tag: effective[0]! })}
                  </button>
                  <button type="button" className="tk-btn quiet" onClick={() => setConfirmTagDelete(false)}>
                    {t('bookmarks.annuler')}
                  </button>
                </>
              ) : (
                <button type="button" className="tk-btn quiet" data-action="tag-delete" onClick={() => setConfirmTagDelete(true)}>
                  {t('bookmarks.supprimer-l-etiquette')}
                </button>
              )}
            </>
          ) : (
            <input
              className="tk-field bookmark-rename"
              data-field="tag-rename"
              autoFocus
              aria-label={t('bookmarks.nouveau-nom-de-l-etiquette')}
              maxLength={BOOKMARK_TAG_MAX}
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                else if (e.key === 'Escape') {
                  e.stopPropagation()
                  renameEnded.current = true
                  setRenaming(null)
                } else keepArrowInField(e)
              }}
            />
          )}
        </div>
      )}
      {list.length === 0 && <p className="tk-status bookmarks-empty">{t('bookmarks.aucun-signet')}</p>}
      {list.length > 0 && shown.length === 0 && <p className="tk-status bookmarks-empty">{t('manage-panels.aucun-resultat')}</p>}
      <ListGroup>{visible.map(row)}</ListGroup>
      {visible.length < shown.length && (
        <p className="tk-status bookmarks-more">
          <span role="status" data-role="shown-count">
            {t('bookmarks.premiers-affiches', { shown: visible.length, total: shown.length })}
          </span>{' '}
          <button type="button" className="tk-btn quiet" data-action="show-more" onClick={() => setDrawn({ filter: filterKey, count: visible.length + BOOKMARKS_SHOWN_STEP })}>
            {t('bookmarks.afficher-les-suivants')}
          </button>
        </p>
      )}
      {message && (
        <p className="tk-status bookmarks-message" role="status">
          {message}
        </p>
      )}
    </ListPanel>
  )
}
