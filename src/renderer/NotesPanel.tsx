// File › Notes… (setting `notes`; the command bar's "Ouvrir les notes", ⇧⌘E by default): the quick notes, on the template of the panels of a list. Under
// the header, what the list shows: « Cette page », « Cet espace » or « Toutes » (the notes of the page on screen first, then those of the space, then
// all the others); it opens on the page when the page has notes, else on all of them. A search over the text and address of the notes shown; a note is
// written in the editor at the top (⌘↩ saves it, Escape gives it up), opened by its row (the tab stays where it is), and deleted with eight seconds to
// take it back (⌘Z), as in the other lists.
// With no note yet, the focus is on the button that writes one rather than in the search. File › Nouvelle note (⌥⌘E by default, the command bar's
// "Nouvelle note", the toolbar's button) opens the panel on a new note tied to the page on screen, the cursor in it; Escape on it while it is empty
// closes the panel. The note is written in a visual editor with its toolbar (NoteTextEditor.tsx), Markdown underneath, kept as it was written: no text
// of a note is ever read as HTML. « Partager » opens the share sheet of the Mac; « ⋯ » downloads the note as a .md file, copies it (as Markdown or as
// formatted text), imports a .md file as a new note (a .md file dropped on the panel too) and shows the raw Markdown. A row shows the note as plain
// text, without its marks. The file, the dialogs, the clipboard and the share sheet are the main process's.

import { useEffect, useId, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import type { Space } from '@shared/model'
import { isMarkdownName, NOTE_FILE_MAX_BYTES, type NoteFileRequest } from '@shared/note-files'
import { NOTE_TEXT_MAX, defaultNoteLink, defaultNotesScope, givingUpClosesPanel, givingUpLosesText, noteLinkChoices, noteLinkKey, notePreview, notesContext, notesInScope, notesScopes, notesSections, noteTitle, openingNotesScope, usableNotesScope, type Note, type NoteLink, type NotesContext, type NotesReply, type NotesRequest, type NotesScope } from '@shared/notes'
import { relativeAgo } from '@shared/relative-time'
import { activeTab } from '@shared/sidebar'
import { spaceGlyph } from '@shared/space-icon'
import { hostOf } from '@shared/url'
import { getKeyPlatform, t } from '@shared/i18n'
import { api, useSnapshot } from './api'
import { commandPress } from '@shared/platform'
import { NoteTextEditor } from './NoteTextEditor'
import { useActionNotice } from './notice-hold'
import { TAKES_FILES_ATTRIBUTE } from './surface'
import { ListEmpty, ListGroup, ListPanel, ListRow, PlusGlyph, TrashGlyph, activeSpaceHue, useUndoQueue } from './templates'
import './notes.css'

/** The glyph of the panel: a sheet with its lines (the family of the templates: 1.5 px on a 16 grid). Decorative. */
export const NoteGlyph = (): ReactNode => (
  <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" focusable="false">
    <path d="M4 2.5h5.5L12.5 5.5v8a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" />
    <path d="M9.5 2.5v3h3M5.5 8.5h5M5.5 11h3.5" />
  </svg>
)

/** The note being written: a new one (`id` null) or one of the list. */
export interface NoteDraft {
  id: string | null
  text: string
  link: NoteLink | null
}

type SpaceNames = ReadonlyArray<Pick<Space, 'id' | 'name' | 'emoji' | 'iconKind' | 'iconLetter' | 'image'>>

/** What a link is called, in the editor and under the title of a row. */
export function noteLinkLabel(link: NoteLink | null | undefined, spaces: SpaceNames): string {
  if (!link) return t('notes.sans-lien')
  if (link.kind === 'page') return t('notes.page-host', { host: hostOf(link.url) || link.url })
  const space = spaces.find((each) => each.id === link.spaceId)
  return space ? t('notes.espace-name', { name: space.name }) : t('notes.espace-supprime')
}

/** What the panel does with a note beyond keeping it: the share sheet, a .md file, the clipboard, an import. */
export interface NoteFileActions {
  share: (text: string) => void
  download: (text: string) => void
  copy: (text: string, format: 'markdown' | 'rich') => void
  /** The open dialog for a .md file, made a new note. */
  importFile: () => void
  /** A file dropped on the panel. */
  dropFile: (file: File) => void
}

export type NoteMenuId = 'download' | 'copy-markdown' | 'copy-rich' | 'share' | 'import' | 'raw'

export interface NoteMenuItem {
  id: NoteMenuId
  label: string
  /** Nothing to download, copy or share in an empty note. */
  disabled: boolean
  /** « Voir le Markdown »: on while the raw Markdown is shown. */
  checked?: boolean
  /** A line before it: the groups of the menu. */
  group?: true
}

/** The entries of « ⋯ », in their order and groups. */
export function noteMenuItems(text: string, raw: boolean): NoteMenuItem[] {
  const empty = text.trim() === ''
  return [
    { id: 'download', label: t('notes.telecharger-en-md'), disabled: empty },
    { id: 'copy-markdown', label: t('notes.copier-en-markdown'), disabled: empty },
    { id: 'copy-rich', label: t('notes.copier-le-texte-mis-en-forme'), disabled: empty },
    { id: 'share', label: t('notes.partager-menu'), disabled: empty, group: true },
    { id: 'import', label: t('notes.importer-un-fichier-md'), disabled: false, group: true },
    { id: 'raw', label: t('notes.voir-le-markdown'), disabled: false, checked: raw }
  ]
}

/**
 * What a key does in the menu « ⋯ »: the entry it goes to (the arrows go round, Home and End), or the menu closed (Escape, the focus back on its
 * button; Tab, the focus going on). A key the menu takes is its own: the panel and the note around do not get it (Escape would give the note up).
 * Null for any other key.
 */
export function menuKeyAction(key: string, at: number, count: number): { focus: number } | { close: true; refocus: boolean } | null {
  if (count === 0) return key === 'Escape' ? { close: true, refocus: true } : null
  switch (key) {
    case 'ArrowDown':
      return { focus: (at + 1 + count) % count }
    case 'ArrowUp':
      return { focus: (at - 1 + count) % count }
    case 'Home':
      return { focus: 0 }
    case 'End':
      return { focus: count - 1 }
    case 'Escape':
      return { close: true, refocus: true }
    case 'Tab':
      return { close: true, refocus: false }
    default:
      return null
  }
}

/**
 * The menu « ⋯ » of a note: a button that says it opens a menu, the menu's entries reached with the arrows (Home, End), taken with Return or Space;
 * Escape closes it (and only it: the note stays), Tab or a click elsewhere too.
 */
export function NoteMoreMenu({ items, onPick, defaultOpen = false }: { items: readonly NoteMenuItem[]; onPick: (id: NoteMenuId) => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const entries = (): HTMLButtonElement[] => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])
  useEffect(() => {
    if (!open) return
    entries()[0]?.focus()
    const away = (event: MouseEvent): void => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const list = entries()
    const action = menuKeyAction(event.key, list.indexOf(document.activeElement as HTMLButtonElement), list.length)
    if (action === null) return
    event.stopPropagation()
    if ('focus' in action) {
      event.preventDefault()
      list[action.focus]?.focus()
      return
    }
    if (action.refocus) event.preventDefault()
    close(action.refocus)
  }
  return (
    <span className="notes-more">
      <button
        ref={button}
        type="button"
        className="tk-btn quiet icon"
        aria-label={t('notes.plus-d-actions')}
        title={t('notes.plus-d-actions')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            event.stopPropagation()
            setOpen(true)
          }
        }}
      >
        <MoreGlyph />
      </button>
      {open && (
        <div ref={menu} id={menuId} className="notes-menu" role="menu" aria-label={t('notes.plus-d-actions')} onKeyDown={onKeyDown}>
          {items.map((item) => (
            <span key={item.id} className="notes-menu-slot" role="none">
              {item.group && <span className="notes-menu-sep" role="separator" />}
              <button
                type="button"
                className="notes-menu-item"
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.checked === undefined ? undefined : item.checked}
                // Not `disabled`: a disabled entry is still announced in the menu, and the arrows skip it.
                aria-disabled={item.disabled || undefined}
                tabIndex={-1}
                onClick={() => {
                  if (item.disabled) return
                  close(true)
                  onPick(item.id)
                }}
              >
                {item.label}
              </button>
            </span>
          ))}
        </div>
      )}
    </span>
  )
}

/** Three dots: more actions. Decorative. */
const MoreGlyph = (): ReactNode => (
  <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" focusable="false">
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.5} strokeLinecap="round" />
  </svg>
)

/** The share sheet's mark: a box with an arrow going up out of it. Decorative. */
const ShareGlyph = (): ReactNode => (
  <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" focusable="false">
    <path d="M8 1.8v8.4M5.3 4.3 8 1.8l2.7 2.5M5.5 6.5H4a1 1 0 0 0-1 1v5.8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7.5a1 1 0 0 0-1-1h-1.5" />
  </svg>
)

interface EditorProps {
  draft: NoteDraft
  /** The note's own link when it has one: it stays one of the choices. */
  own: NoteLink | undefined
  context: NotesContext
  spaces: SpaceNames
  busy: boolean
  onChange: (draft: NoteDraft) => void
  onCancel: () => void
  onSave: () => void
  /** A link of the note opened with ⌘-click. */
  onOpenLink: (url: string) => void
  files?: NoteFileActions
}

function NoteEditor({ draft, own, context, spaces, busy, onChange, onCancel, onSave, onOpenLink, files }: EditorProps) {
  // The key of « Enregistrer » is drawn for the system the window runs on (told to the texts with the snapshot); not told, no key is drawn.
  const platform = getKeyPlatform()
  // The raw Markdown (« M↓ », « Voir le Markdown »), for this note only.
  const [raw, setRaw] = useState(false)
  const labelId = useId()
  const hintId = useId()
  const countId = useId()
  const radio = useId()
  const choices = noteLinkChoices(own, context)
  const onKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    // Escape anywhere in the editor gives the note up and leaves the panel open: neither the panel nor the layer under it closes.
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      onSave()
    }
  }
  return (
    <form
      className="notes-editor"
      aria-label={draft.id === null ? t('notes.nouvelle-note') : t('notes.modifier-la-note')}
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      <span className="notes-label" id={labelId}>
        {t('notes.texte-de-la-note')}
      </span>
      <NoteTextEditor
        value={draft.text}
        max={NOTE_TEXT_MAX}
        labelledBy={labelId}
        describedBy={`${hintId} ${countId}`}
        autoFocus
        raw={raw}
        onRaw={setRaw}
        onChange={(text) => onChange({ ...draft, text })}
        onOpenLink={onOpenLink}
      />
      <p className="notes-hint">
        <span id={hintId}>{t('notes.le-markdown-se-met-en-forme')}</span> <span id={countId}>{t('notes.length-max-caracteres', { length: draft.text.length, max: NOTE_TEXT_MAX })}</span>
      </p>
      <fieldset className="notes-links">
        <legend>{t('notes.liee-a')}</legend>
        {choices.map((choice) => (
          <label key={noteLinkKey(choice)} className="notes-choice">
            <input type="radio" name={radio} checked={noteLinkKey(choice) === noteLinkKey(draft.link)} onChange={() => onChange({ ...draft, link: choice })} />
            <span>{noteLinkLabel(choice, spaces)}</span>
          </label>
        ))}
      </fieldset>
      <div className="notes-editor-foot">
        {files && (
          <>
            <button type="button" className="tk-btn quiet" title={t('notes.partager-la-note')} disabled={draft.text.trim() === ''} onClick={() => files.share(draft.text)}>
              <ShareGlyph /> {t('notes.partager')}
            </button>
            <NoteMoreMenu
              items={noteMenuItems(draft.text, raw)}
              onPick={(id) => {
                if (id === 'download') files.download(draft.text)
                else if (id === 'copy-markdown') files.copy(draft.text, 'markdown')
                else if (id === 'copy-rich') files.copy(draft.text, 'rich')
                else if (id === 'share') files.share(draft.text)
                else if (id === 'import') files.importFile()
                else setRaw((was) => !was)
              }}
            />
          </>
        )}
        <span className="notes-foot-space" />
        <button type="button" className="tk-btn quiet" onClick={onCancel}>
          {t('notes.annuler')}
        </button>
        <button type="submit" className="tk-btn primary" disabled={busy || draft.text.trim() === ''} aria-busy={busy ? true : undefined}>
          {t('notes.enregistrer')}
          {platform && (
            <>
              {' '}
              <kbd className="tk-kbd">{commandPress('↩', platform)}</kbd>
            </>
          )}
        </button>
      </div>
    </form>
  )
}

/** The name of a choice of what the list shows. */
const scopeLabel = (scope: NotesScope): string => (scope === 'page' ? t('notes.cette-page') : scope === 'space' ? t('notes.cet-espace') : t('notes.toutes'))

export interface NotesViewProps {
  /** null while the list is read. */
  notes: readonly Note[] | null
  context: NotesContext
  /** What the list shows; null or absent: what the panel opens on (the page when it has notes, else all of them). */
  scope?: NotesScope | null
  /** « Cette page », « Cet espace » or « Toutes » chosen under the header. */
  onScope: (scope: NotesScope) => void
  spaces: SpaceNames
  query: string
  onQuery: (query: string) => void
  /** The notes being deleted, hidden for the eight seconds they can be taken back. */
  hidden: ReadonlySet<string>
  draft: NoteDraft | null
  onDraft: (draft: NoteDraft | null) => void
  /** Giving up the note being written (Escape, Annuler): without it, the editor closes and the list stays. */
  onCancel?: () => void
  onSave: () => void
  onRemove: (note: Note) => void
  onOpenPage: (url: string) => void
  /** A link of the note being written, opened with ⌘-click: a tab behind the panel, the note kept. Without it, as `onOpenPage`. */
  onOpenLink?: (url: string) => void
  /** Sharing, downloading, copying and importing notes; without it, the panel offers none of them. */
  files?: NoteFileActions
  message: string
  busy: boolean
  undo: { message: string; onUndo: () => void; onHold?: (held: boolean) => void } | null
  onDone: () => void
  hue?: number
  now: number
}

/** The panel as it is drawn from what it is given: the container below asks the main process, this only shows and calls back. */
export function NotesView(props: NotesViewProps) {
  const { notes, context, spaces, query, hidden, draft, now } = props
  const [dragging, setDragging] = useState(false)
  const scope = usableNotesScope(props.scope ?? defaultNotesScope(notes ?? [], context), context)
  // The note being edited is shown in the editor only, not twice.
  const away = draft?.id ? new Set([...hidden, draft.id]) : hidden
  const sections = notesSections(notes ?? [], context, query, away, scope)
  const left = (notes ?? []).filter((note) => !hidden.has(note.id)).length
  const shownCount = notesInScope(notes ?? [], context, scope, hidden)
  const found = sections.page.length + sections.space.length + sections.others.length
  // A search that finds nothing in the page or the space, but finds notes elsewhere, offers them.
  const foundElsewhere = scope !== 'all' && found === 0 && query.trim() !== '' && Object.values(notesSections(notes ?? [], context, query, away)).some((list) => list.length > 0)
  const seeAll = (
    <button type="button" className="tk-btn small" onClick={() => props.onScope('all')}>
      {t('notes.voir-toutes-les-notes')}
    </button>
  )
  const own = draft?.id ? notes?.find((note) => note.id === draft.id)?.link : undefined
  const startNew = (text = '') => props.onDraft({ id: null, text, link: defaultNoteLink(context) })
  const edit = (note: Note) => props.onDraft({ id: note.id, text: note.text, link: note.link ?? null })

  const row = (note: Note): ReactNode => {
    const title = noteTitle(note.text) || t('notes.note-sans-titre')
    const link = note.link
    const icon = link?.kind === 'page' ? (hostOf(link.url)[0] ?? '·').toUpperCase() : link?.kind === 'space' ? spaceGlyphOf(spaces, link.spaceId) : <NoteGlyph />
    return (
      <ListRow
        key={note.id}
        icon={icon}
        title={title}
        subtitle={`${noteLinkLabel(link, spaces)} · ${relativeAgo(note.updatedAt, now)}`}
        hint={notePreview(note.text)}
        onOpen={() => edit(note)}
        actions={
          <>
            {link?.kind === 'page' && (
              <button type="button" className="tk-btn quiet" aria-label={t('notes.ouvrir-la-page-de-title', { title })} onClick={() => props.onOpenPage(link.url)}>
                {t('notes.ouvrir-la-page')}
              </button>
            )}
            <button type="button" className="tk-btn quiet icon danger" aria-label={t('notes.supprimer-la-note-title', { title })} title={t('notes.supprimer')} onClick={() => props.onRemove(note)}>
              <TrashGlyph />
            </button>
          </>
        }
      />
    )
  }

  // ⌫ on a row deletes its note (with eight seconds to take it back), as in the history; ↩ opens it, the arrows go from row to row (the template).
  const group = (title: string | undefined, list: readonly Note[]): ReactNode =>
    list.length > 0 && (
      <div
        onKeyDown={(event) => {
          const target = event.target as HTMLElement
          if ((event.key !== 'Backspace' && event.key !== 'Delete') || !target.classList.contains('lp-main')) return
          const item = target.closest('li.lp-row')
          const note = list[Array.from(item?.parentElement?.children ?? []).indexOf(item as Element)]
          if (!note) return
          event.preventDefault()
          props.onRemove(note)
        }}
      >
        <ListGroup title={title}>{list.map(row)}</ListGroup>
      </div>
    )

  // A .md file dropped anywhere on the panel becomes a note.
  const dropping = (event: ReactDragEvent<HTMLDivElement>): boolean => props.files !== undefined && Array.from(event.dataTransfer.types).includes('Files')
  return (
    <div
      className={`notes-drop${dragging ? ' dragging' : ''}`}
      {...(props.files !== undefined ? { [TAKES_FILES_ATTRIBUTE]: '' } : {})}
      onDragOver={(event) => {
        if (!dropping(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(event) => {
        if (!dropping(event)) return
        event.preventDefault()
        setDragging(false)
        const file = event.dataTransfer.files[0]
        if (file) props.files?.dropFile(file)
      }}
    >
      <ListPanel
        className="notes-panel"
        icon={<NoteGlyph />}
        title={t('notes.notes')}
        count={notes === null ? undefined : shownCount}
        hue={props.hue}
        search={{
          value: query,
          onChange: props.onQuery,
          label: t('notes.rechercher-dans-les-notes'),
          placeholder: t('notes.rechercher'),
          // Return opens the first note found; with none, it starts a note with what was typed.
          onSubmit: () => {
            const first = sections.page[0] ?? sections.space[0] ?? sections.others[0]
            if (first) edit(first)
            else startNew(query.trim())
          }
        }}
        action={
          <button type="button" className="tk-btn" onClick={() => startNew()} disabled={notes === null}>
            <PlusGlyph /> {t('notes.nouvelle-note')}
          </button>
        }
        // What the list shows, once there are notes to choose among: one choice at a time, the arrows move and choose.
        filters={
          notes !== null && left > 0
            ? notesScopes(context).map((each) => (
                <button key={each} type="button" className="tk-chip" role="radio" aria-checked={each === scope} tabIndex={each === scope ? 0 : -1} data-scope={each} onClick={() => props.onScope(each)}>
                  {scopeLabel(each)}
                </button>
              ))
            : undefined
        }
        filtersLabel={t('notes.notes-affichees')}
        filtersRole="radiogroup"
        state={notes === null ? 'loading' : 'ready'}
        onDone={props.onDone}
        undo={props.undo}
      >
        {props.message && (
          <p className="tk-status notes-message" role="status">
            {props.message}
          </p>
        )}
        {draft && (
          // One editor per note: opening another one starts a field (and a history) of its own.
          <NoteEditor
            key={draft.id ?? 'new'}
            draft={draft}
            own={own}
            context={context}
            spaces={spaces}
            busy={props.busy}
            onChange={props.onDraft}
            onCancel={props.onCancel ?? (() => props.onDraft(null))}
            onSave={props.onSave}
            onOpenLink={props.onOpenLink ?? props.onOpenPage}
            files={props.files}
          />
        )}
        {notes !== null && left === 0 && !draft && (
          <ListEmpty
            icon={<NoteGlyph />}
            title={t('notes.aucune-note')}
            hint={t('notes.une-note-reste-sur-ce-mac')}
            action={
              // Nothing to look for yet: the focus leaves the search for the way to write the first note (Return or Space opens the editor).
              <button type="button" className="tk-btn primary" autoFocus onClick={() => startNew()}>
                {t('notes.nouvelle-note')}
              </button>
            }
          />
        )}
        {notes !== null && left > 0 && scope !== 'all' && shownCount === 0 ? (
          // Nothing on the page or in the space: the panel offers every note rather than an empty list.
          <p className="tk-status">
            {scope === 'page' ? t('notes.aucune-note-sur-cette-page') : t('notes.aucune-note-dans-cet-espace')} {seeAll}
          </p>
        ) : (
          notes !== null &&
          query.trim() !== '' &&
          found === 0 && (
            <p className="tk-status">
              {t('notes.aucune-note-ne-correspond')} {foundElsewhere && seeAll}
            </p>
          )
        )}
        {scope === 'all' ? (
          <>
            {group(t('notes.cette-page'), sections.page)}
            {group(t('notes.cet-espace'), sections.space)}
            {group(sections.page.length > 0 || sections.space.length > 0 ? t('notes.autres-notes') : t('notes.toutes-les-notes'), sections.others)}
          </>
        ) : (
          // The choice above names the list: no title over it.
          group(undefined, scope === 'page' ? sections.page : sections.space)
        )}
        {dragging && (
          <p className="notes-drop-hint" role="status">
            {t('notes.deposer-un-fichier-md')}
          </p>
        )}
      </ListPanel>
    </div>
  )
}

function spaceGlyphOf(spaces: SpaceNames, id: string): string {
  const space = spaces.find((each) => each.id === id)
  return space ? spaceGlyph(space) : '·'
}

/**
 * The panel in the window: asks the main process for the notes, and for every change; what it answers is what is shown. `compose` (File › Nouvelle note):
 * it opens on a new note tied to the page on screen, its field focused. `scope` (the toolbar's « Toutes les notes »): the list opens on « Toutes ».
 */
export function NotesPanel({ compose = false, scope: requestedScope }: { compose?: boolean; scope?: 'all' }) {
  const snapshot = useSnapshot()
  const [notes, setNotes] = useState<Note[] | null>(null)
  // What the list shows: null until the notes first come, then the choice the panel opened on, and the person's.
  const [scope, setScope] = useState<NotesScope | null>(null)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<NoteDraft | null>(null)
  // The new note the panel was opened on, until it is saved, given up or another note is opened: Escape on it while it is empty closes the panel.
  const [quick, setQuick] = useState(compose)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  // The ages are computed once per opening of the panel: they do not need to tick while it is on screen.
  const [now] = useState(() => Date.now())
  const undo = useUndoQueue()
  // The note given up with words in it that were not saved: kept as long as a deleted note is, so that an Escape typed by reflex can be taken back.
  const [givenUp, setGivenUp] = useState<NoteDraft | null>(null)
  const givenUpNotice = useActionNotice(givenUp, () => setGivenUp(null))
  const act = api()
  // The editor that closes and the row that is deleted take the focus with them: it goes back to the search, so that the keys still reach the panel.
  const refocus = useRef(false)
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    if (document.activeElement === null || document.activeElement === document.body) document.querySelector<HTMLInputElement>('.notes-panel .lp-head input[type="search"]')?.focus()
  })
  const changeDraft = (next: NoteDraft | null) => {
    if (next === null) refocus.current = true
    if (next === null || next.id !== null) setQuick(false)
    setDraft(next)
  }

  const ask = (request: NotesRequest): Promise<NotesReply | null> =>
    act.notes(request).then(
      (reply) => {
        setNotes(reply.notes)
        setMessage(reply.ok ? '' : (reply.message ?? ''))
        return reply
      },
      (error: unknown) => {
        console.error('[notes] the request failed:', error instanceof Error ? error.message : typeof error)
        setNotes((current) => current ?? [])
        setMessage(t('notes.la-demande-a-echoue'))
        return null
      }
    )

  useEffect(() => {
    void ask({ kind: 'list' })
    // Asked once, when the panel opens: every later answer carries the list as it is then.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- asked once, when the panel opens
  }, [])

  if (!snapshot) return null
  const { spaces, activeSpaceId } = snapshot.state
  const context = notesContext(activeSpaceId, activeTab(snapshot.state))
  // The choice the panel opens on is taken once, when the notes first come: a note saved or deleted afterwards does not change the list under the
  // pointer (React's way of a state that follows a value: set during the draw).
  if (scope === null && notes !== null) setScope(openingNotesScope(notes, context, requestedScope))
  // Until something is typed, the quick note is the panel's own new note (the same link a click on « Nouvelle note » gives it), made from what is on screen.
  const shown = draft ?? (quick ? { id: null, text: '', link: defaultNoteLink(context) } : null)

  const save = () => {
    if (!shown || busy || shown.text.trim() === '') return
    setBusy(true)
    const request: NotesRequest = shown.id === null ? { kind: 'create', text: shown.text, link: shown.link } : { kind: 'update', id: shown.id, text: shown.text, link: shown.link }
    void ask(request)
      .then((reply) => {
        if (reply?.ok) changeDraft(null)
      })
      .finally(() => setBusy(false))
  }
  // An empty quick note is never sent: giving it up closes the panel, and nothing is kept. Any other note is given up as the panel always did.
  const losesText = givingUpLosesText(shown, shown?.id == null ? undefined : notes?.find((note) => note.id === shown.id)?.text)
  const cancel = () => {
    if (givingUpClosesPanel(shown, quick)) return act.closeOverlay()
    if (losesText) setGivenUp(shown)
    changeDraft(null)
  }
  const takeBack = () => {
    if (givenUp) changeDraft(givenUp)
    setGivenUp(null)
  }
  // Leaving the panel on a note that was not saved gives the note up first, and says so: the panel stays for the time the note can be taken back.
  const done = () => (losesText ? cancel() : act.closeOverlay())
  // Choosing what the list shows is asking to look at the notes: the note in the editor makes way when that loses nothing (« Nouvelle note » still
  // empty, a note opened and left as it was), so that the list is in view; a note with words not saved stays, the list under it.
  const chooseScope = (next: NotesScope) => {
    setScope(next)
    // « Voir toutes les notes » goes with the empty list it was offered in: the focus it leaves goes back to the search, as for a row deleted.
    refocus.current = true
    if (shown !== null && !losesText) changeDraft(null)
  }
  const remove = (note: Note) => {
    refocus.current = true
    if (draft?.id === note.id) setDraft(null)
    undo.remove(note.id, t('notes.note-supprimee-title', { title: noteTitle(note.text) || t('notes.note-sans-titre') }), () => void ask({ kind: 'remove', id: note.id }))
  }
  const openPage = (url: string) => {
    void act.dispatch({ type: 'tab/open', url })
    act.closeOverlay()
  }
  // The panel stays, with the note being written: the page opens in a tab behind it; a mail link, in the mail application.
  const openLink = (url: string) => {
    if (url.startsWith('mailto:')) void fileRequest({ kind: 'mail', url })
    else void act.dispatch({ type: 'tab/open', url, background: true })
  }

  const fileRequest = (request: NoteFileRequest): Promise<void> =>
    act.noteFiles(request).then(
      (reply) => {
        if (reply.notes) setNotes(reply.notes)
        setMessage(reply.message ?? '')
        // An imported note opens in the editor, unless another one is being written.
        if (reply.ok && reply.id && reply.notes && draft === null) {
          const made = reply.notes.find((note) => note.id === reply.id)
          if (made) changeDraft({ id: made.id, text: made.text, link: made.link ?? null })
        }
      },
      (error: unknown) => {
        console.error('[notes] the request of a file failed:', error instanceof Error ? error.message : typeof error)
        setMessage(t('notes.la-demande-a-echoue'))
      }
    )
  const files: NoteFileActions = {
    share: (text) => void fileRequest({ kind: 'share', text }),
    download: (text) => void fileRequest({ kind: 'save', text }),
    copy: (text, format) => void fileRequest({ kind: 'copy', format, text }),
    importFile: () => void fileRequest({ kind: 'import', link: defaultNoteLink(context) }),
    dropFile: (file) => {
      // Checked here before the file is read (the main process checks the name and the text again).
      if (!isMarkdownName(file.name)) return setMessage(t('notes.import-pas-markdown'))
      if (file.size > NOTE_FILE_MAX_BYTES) return setMessage(t('notes.import-trop-gros', { max: NOTE_TEXT_MAX }))
      void file.text().then(
        (text) => fileRequest({ kind: 'import-text', name: file.name, text, link: defaultNoteLink(context) }),
        (error: unknown) => {
          console.error('[notes] cannot read the dropped file:', error instanceof Error ? error.message : typeof error)
          setMessage(t('notes.lecture-impossible', { detail: error instanceof Error ? error.message : String(error) }))
        }
      )
    }
  }

  return (
    <NotesView
      notes={notes}
      context={context}
      scope={scope}
      onScope={chooseScope}
      spaces={spaces}
      query={query}
      onQuery={setQuery}
      hidden={undo.hidden}
      draft={shown}
      onDraft={changeDraft}
      onCancel={cancel}
      onSave={save}
      onRemove={remove}
      onOpenPage={openPage}
      onOpenLink={openLink}
      files={files}
      message={message}
      busy={busy}
      undo={givenUp ? { message: t('notes.note-abandonnee-title', { title: noteTitle(givenUp.text) || t('notes.note-sans-titre') }), onUndo: takeBack, onHold: givenUpNotice.hold } : undo.panel}
      onDone={done}
      hue={activeSpaceHue(spaces, activeSpaceId)}
      now={now}
    />
  )
}
