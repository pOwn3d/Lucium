// The field of a note: a visual editor that shows the result (titles, bold, italic, struck, lists, boxes, quotes, code, links) and not the marks, the
// note staying Markdown underneath (shared/note-doc.ts says how a place on screen is a place in the Markdown, and how an edit on screen is written).
// The field is a `contenteditable` in "plaintext-only" whose elements are drawn from the note after each change (note-editor-dom.ts): the browser never
// writes an element of its own in it. What is typed, deleted, cut, pasted and every key with a meaning (Return, ⌘B, ⌘I, ⌘K, ⇧⌘U, ⌘Z, ⇧⌘Z) is done here
// on the Markdown; only an input method (accents, other alphabets) writes in the elements itself, read back when it is done. A toolbar above makes
// the same marks and blocks; « M↓ » shows the raw Markdown in a plain field, where the same keys and buttons write the marks themselves.
// A paste keeps what a note knows of formatted text (note-paste.ts) and drops the rest; nothing is dropped into the field; nothing is ever read as
// HTML into the page: the clipboard's HTML is parsed into a document of its own, which is only read.

import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import {
  blockIndexAt,
  blocksIn,
  deleteBackward,
  deleteForward,
  deleteVisible,
  enter,
  insertText,
  isBlockOf,
  linkAddress,
  noteHtml,
  pasteMarkdown,
  readDoc,
  selectionMarkdown,
  selectionStyle,
  setBlocks,
  setLink,
  sourceAt,
  toggleCodeBlock,
  toggleInline,
  typingStyle,
  visibleAt,
  wordAt,
  type BlockChoice,
  type DeleteUnit,
  type CharStyle,
  type InlineMark,
  type NoteDoc
} from '@shared/note-doc'
import { enterEdit, linkEdit, NoteHistory, pastedText, safeNoteHref, toggleMarks, toggleTaskLine, toggleTasksEdit, withinLimit, type NoteEdit } from '@shared/note-markdown'
import { htmlToNoteMarkdown, type PasteNode } from '@shared/note-paste'
import { t } from '@shared/i18n'
import { blockIndexOfNode, drawDoc, openLinkTitle, pointOfSource, readShown, sourceOfPoint, visibleOfPoint, type EditorLabels } from './note-editor-dom'

export interface NoteTextEditorProps {
  /** The text of the note (Markdown). */
  value: string
  onChange: (text: string) => void
  /** The most characters it takes: typing or pasting more is refused, as a field's `maxLength` does. */
  max: number
  /** The ids of the visible name of the field and of its hint. */
  labelledBy: string
  describedBy: string
  /** A link opened with ⌘-click: an address safeNoteHref accepted. */
  onOpenLink: (url: string) => void
  /** The caret is put at the end of the text when the field appears. */
  autoFocus?: boolean
  /** The raw Markdown is shown in a plain field (« M↓ »). */
  raw: boolean
  onRaw: (raw: boolean) => void
}

/** The keys that move the caret: the field keeps them (the panel around would take them to go from row to row). */
const CARET_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

/** What the toolbar shows pressed. */
export interface ToolbarLook {
  strong: boolean
  em: boolean
  strike: boolean
  code: boolean
  link: string | null
  h1: boolean
  h2: boolean
  bullet: boolean
  ordered: boolean
  task: boolean
  quote: boolean
}

/** The look of the selection (or of what a caret will type, with the look a button asked for): what the toolbar shows pressed. */
export function toolbarLook(doc: NoteDoc, start: number, end: number, pending: CharStyle | null = null): ToolbarLook {
  const style = start === end && pending !== null ? { ...pending, href: selectionStyle(doc, start, end).href } : selectionStyle(doc, start, end)
  const blocks = blocksIn(doc, start, end).map((index) => doc.blocks[index]!)
  const all = (test: (block: (typeof blocks)[number]) => boolean): boolean => blocks.length > 0 && blocks.every(test)
  return {
    strong: style.strong === true,
    em: style.em === true,
    strike: style.strike === true,
    code: style.code === true || all((block) => block.kind === 'code'),
    link: style.href ?? null,
    h1: all((block) => isBlockOf(block, { kind: 'heading', level: 1 })),
    h2: all((block) => isBlockOf(block, { kind: 'heading', level: 2 })),
    bullet: all((block) => block.kind === 'bullet'),
    ordered: all((block) => block.kind === 'ordered'),
    task: all((block) => block.kind === 'task'),
    quote: all((block) => block.kind === 'quote')
  }
}

export type ToolbarAction = InlineMark | 'h1' | 'h2' | 'bullet' | 'ordered' | 'task' | 'quote' | 'link' | 'raw'

interface ToolbarButton {
  action: ToolbarAction
  glyph: ReactNode
  label: string
  pressed: (look: ToolbarLook, raw: boolean) => boolean
  /** A thin line before it: the groups of the toolbar. */
  group?: true
}

/** The buttons of the toolbar, in their order and groups: B I S | H1 H2 | • 1. ☑ | ❝ </> link | M↓. */
export function toolbarButtons(): ToolbarButton[] {
  return [
    { action: 'strong', glyph: <b>B</b>, label: t('notes.gras'), pressed: (look) => look.strong },
    { action: 'em', glyph: <i>I</i>, label: t('notes.italique'), pressed: (look) => look.em },
    { action: 'strike', glyph: <s>S</s>, label: t('notes.barre'), pressed: (look) => look.strike },
    { action: 'h1', glyph: 'H1', label: t('notes.titre-1'), pressed: (look) => look.h1, group: true },
    { action: 'h2', glyph: 'H2', label: t('notes.titre-2'), pressed: (look) => look.h2 },
    { action: 'bullet', glyph: '•', label: t('notes.liste-a-puces'), pressed: (look) => look.bullet, group: true },
    { action: 'ordered', glyph: '1.', label: t('notes.liste-numerotee'), pressed: (look) => look.ordered },
    { action: 'task', glyph: '☑', label: t('notes.liste-de-taches'), pressed: (look) => look.task },
    { action: 'quote', glyph: '❝', label: t('notes.citation'), pressed: (look) => look.quote, group: true },
    { action: 'code', glyph: '</>', label: t('notes.code'), pressed: (look) => look.code },
    { action: 'link', glyph: <LinkGlyph />, label: t('notes.lien'), pressed: (look) => look.link !== null },
    { action: 'raw', glyph: 'M↓', label: t('notes.voir-le-markdown'), pressed: (_look, raw) => raw, group: true }
  ]
}

/** A link: two rings of a chain (the family of the templates: 1.5 px on a 16 grid). Decorative. */
const LinkGlyph = (): ReactNode => (
  <svg viewBox="0 0 16 16" width={16} height={16} aria-hidden="true" focusable="false">
    <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-1 1M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l1-1" />
  </svg>
)

/**
 * The toolbar above the field: named buttons, the ones that toggle saying whether they are on (aria-pressed); one stop of Tab, the arrows going from
 * one button to the next. A press keeps the selection of the field.
 */
export function NoteToolbar({ look, raw, controls, onAction }: { look: ToolbarLook; raw: boolean; controls: string; onAction: (action: ToolbarAction) => void }) {
  const buttons = toolbarButtons()
  const [current, setCurrent] = useState(0)
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const move = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const last = buttons.length - 1
    const next = event.key === 'ArrowRight' ? (current >= last ? 0 : current + 1) : event.key === 'ArrowLeft' ? (current <= 0 ? last : current - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : null
    if (next === null) return
    event.preventDefault()
    // The arrows are the toolbar's: the panel around does not go from row to row with them.
    event.stopPropagation()
    setCurrent(next)
    refs.current[next]?.focus()
  }
  return (
    <div className="nm-toolbar" role="toolbar" aria-label={t('notes.mise-en-forme')} aria-controls={controls} onKeyDown={move}>
      {buttons.map((button, index) => {
        const toggles = button.action !== 'link'
        return (
          <span key={button.action} className="nm-tool-slot">
            {button.group && <span className="nm-tool-sep" aria-hidden="true" />}
            <button
              ref={(element) => {
                refs.current[index] = element
              }}
              type="button"
              className="nm-tool"
              tabIndex={index === current ? 0 : -1}
              aria-label={button.label}
              title={button.label}
              aria-pressed={toggles ? button.pressed(look, raw) : undefined}
              data-on={button.pressed(look, raw) || undefined}
              data-action={button.action}
              // The field keeps its selection: the button acts on it.
              onMouseDown={(event) => event.preventDefault()}
              onFocus={() => setCurrent(index)}
              onClick={() => onAction(button.action)}
            >
              <span aria-hidden="true">{button.glyph}</span>
            </button>
          </span>
        )
      })}
    </div>
  )
}

/** The address typed in the link field, as a link of a note writes it: a bare domain is a web page, a bare mail address a mail link. */
export function typedLinkAddress(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return null
  if (/^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/.test(text)) return linkAddress(`mailto:${text}`)
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) return linkAddress(`https://${text}`)
  return linkAddress(text)
}

/** The field below the toolbar where the address of a link is typed: Return applies it, Escape gives it up, both back to the text. */
function LinkField({ initial, linked, onApply, onRemove, onClose }: { initial: string; linked: boolean; onApply: (href: string) => void; onRemove: () => void; onClose: () => void }) {
  const [value, setValue] = useState(initial)
  const [wrong, setWrong] = useState(false)
  const id = useId()
  const apply = (): void => {
    const href = typedLinkAddress(value)
    if (href === null) return setWrong(true)
    onApply(href)
  }
  return (
    <div className="nm-link-field" role="group" aria-label={t('notes.lien')}>
      <label htmlFor={id}>{t('notes.adresse-du-lien')}</label>
      <input
        id={id}
        className="tk-field"
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        value={value}
        aria-invalid={wrong || undefined}
        aria-describedby={wrong ? `${id}-wrong` : undefined}
        onChange={(event) => {
          setValue(event.target.value)
          setWrong(false)
        }}
        onKeyDown={(event) => {
          // Return applies the link and Escape gives it up: neither saves nor gives up the note (the form around).
          if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
            event.preventDefault()
            event.stopPropagation()
            apply()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          } else if (CARET_KEYS.has(event.key)) event.stopPropagation()
        }}
      />
      <button type="button" className="tk-btn small" onClick={apply}>
        {t('notes.appliquer')}
      </button>
      {linked && (
        <button type="button" className="tk-btn small quiet" onClick={onRemove}>
          {t('notes.retirer-le-lien')}
        </button>
      )}
      <button type="button" className="tk-btn small quiet" onClick={onClose}>
        {t('notes.annuler')}
      </button>
      {wrong && (
        <p id={`${id}-wrong`} className="nm-link-wrong" role="alert">
          {t('notes.adresse-invalide')}
        </p>
      )}
    </div>
  )
}

/** The clipboard's HTML read into a document of its own (inert: no script runs, nothing is fetched), as the Markdown a note knows. */
function pastedMarkdown(html: string): string {
  if (html.trim() === '' || typeof DOMParser === 'undefined') return ''
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return htmlToNoteMarkdown(parsed.body as unknown as PasteNode)
}

export function NoteTextEditor({ value, onChange, max, labelledBy, describedBy, onOpenLink, autoFocus = false, raw, onRaw }: NoteTextEditorProps) {
  const fieldId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const rawRef = useRef<HTMLTextAreaElement>(null)
  // The Markdown and its selection now (places in the Markdown); its blocks; the history; an input method composing (with what was shown when it
  // started); the look a button asked for with no selection; the selection last put in the elements (one the browser reports back as it is).
  const live = useRef<NoteEdit>({ text: value, start: value.length, end: value.length })
  const doc = useRef<NoteDoc>(readDoc(value))
  const history = useRef<NoteHistory>(new NoteHistory(live.current))
  const composing = useRef<{ edit: NoteEdit; shown: string } | null>(null)
  const pending = useRef<CharStyle | null>(null)
  const placed = useRef<{ anchor: Node; anchorOffset: number; focus: Node; focusOffset: number } | null>(null)
  const rawSelection = useRef<{ start: number; end: number } | null>(null)
  const changed = useRef(onChange)
  changed.current = onChange
  const [look, setLook] = useState<ToolbarLook>(() => toolbarLook(doc.current, live.current.start, live.current.end))
  const [link, setLink_] = useState<{ start: number; end: number; href: string } | null>(null)
  const labels: EditorLabels = { box: t('notes.tache-faite'), openLink: openLinkTitle }

  const root = (): HTMLDivElement | null => ref.current
  const focused = (): boolean => root() !== null && document.activeElement === root()

  const refreshLook = (): void => {
    const next = toolbarLook(doc.current, live.current.start, live.current.end, pending.current)
    setLook((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next))
  }

  /** The selection of the elements, as places in the Markdown (the one kept when the browser reports back the one put there); null outside the field. */
  const domSelection = (): { start: number; end: number } | null => {
    const field = root()
    const chosen = window.getSelection()
    if (!field || !chosen || chosen.anchorNode === null || chosen.focusNode === null || !field.contains(chosen.anchorNode)) return null
    const was = placed.current
    if (was && was.anchor === chosen.anchorNode && was.anchorOffset === chosen.anchorOffset && was.focus === chosen.focusNode && was.focusOffset === chosen.focusOffset) return null
    const anchor = sourceOfPoint(field, doc.current, { node: chosen.anchorNode, offset: chosen.anchorOffset })
    const focus = sourceOfPoint(field, doc.current, { node: chosen.focusNode, offset: chosen.focusOffset })
    if (anchor === null || focus === null) return null
    return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) }
  }

  const remember = (): void => {
    const chosen = window.getSelection()
    placed.current = chosen && chosen.anchorNode && chosen.focusNode ? { anchor: chosen.anchorNode, anchorOffset: chosen.anchorOffset, focus: chosen.focusNode, focusOffset: chosen.focusOffset } : null
  }

  /** The selection of the field moved by the user: kept as places in the Markdown; one at the same places of the text keeps its side of the marks. */
  const takeSelection = (): void => {
    if (composing.current) return
    const next = domSelection()
    if (next === null) return
    const was = live.current
    const same = visibleAt(doc.current, next.start) === visibleAt(doc.current, was.start) && visibleAt(doc.current, next.end) === visibleAt(doc.current, was.end)
    if (!same) {
      live.current = { ...was, ...next }
      pending.current = null
    }
    remember()
    refreshLook()
  }

  /** The text now, with the selection as it is on screen. */
  const now = (): NoteEdit => {
    takeSelection()
    return live.current
  }

  /** The note drawn, and its selection put back when the field has the focus. */
  const draw = (edit: NoteEdit): void => {
    const field = root()
    if (!field) return
    if (doc.current.source !== edit.text) doc.current = readDoc(edit.text)
    drawDoc(field, doc.current, labels)
    field.classList.toggle('nm-empty', edit.text === '')
    if (!focused()) return
    const start = pointOfSource(field, doc.current, edit.start)
    const end = pointOfSource(field, doc.current, edit.end)
    window.getSelection()?.setBaseAndExtent(start.node, start.offset, end.node, end.offset)
    remember()
  }

  /** A new state of the text: kept in the history, drawn, and told. More than `max` characters is refused (the text drawn before stays). */
  const commit = (next: NoteEdit | null, typing: boolean, keepPending = false): void => {
    const before = live.current
    if (next === null || !withinLimit(before.text, next.text, max)) {
      if (!raw) draw(before)
      return
    }
    live.current = next
    doc.current = readDoc(next.text)
    history.current.record(next, typing, Date.now())
    if (!keepPending) pending.current = null
    if (raw) rawSelection.current = { start: next.start, end: next.end }
    else draw(next)
    if (next.text !== before.text) changed.current(next.text)
    refreshLook()
  }

  /** A state of the history, back on screen. */
  const restore = (state: NoteEdit | null): void => {
    if (state === null) return
    const before = live.current.text
    live.current = state
    doc.current = readDoc(state.text)
    pending.current = null
    if (raw) rawSelection.current = { start: state.start, end: state.end }
    else draw(state)
    if (state.text !== before) changed.current(state.text)
    refreshLook()
  }

  /** The field takes the focus back, its selection with it (after a button pressed from the keyboard). */
  const focusField = (): void => {
    if (raw) {
      rawRef.current?.focus()
      return
    }
    const field = root()
    if (!field) return
    field.focus({ preventScroll: true })
    draw(live.current)
  }

  /** What an input method wrote in the elements, read back: the text shown before and after it, the difference put into the Markdown. */
  const readBack = (started: { edit: NoteEdit; shown: string }): void => {
    const field = root()
    if (!field) return
    const shown = readShown(field)
    const before = started.shown
    let head = 0
    while (head < before.length && head < shown.length && before[head] === shown[head]) head++
    let tail = 0
    while (tail < before.length - head && tail < shown.length - head && before[before.length - 1 - tail] === shown[shown.length - 1 - tail]) tail++
    const removedTo = before.length - tail
    const inserted = shown.slice(head, shown.length - tail)
    const base = started.edit
    const was = readDoc(base.text)
    let next: NoteEdit | null
    if (head < removedTo) next = inserted === '' ? deleteVisible(base.text, head, removedTo) : insertText(base.text, sourceAt(was, head, 'right'), sourceAt(was, removedTo, 'left'), inserted)
    else if (inserted === '') next = base
    else {
      // The caret the input method started at keeps its side of the marks.
      const at = visibleAt(was, base.start) === head ? base.start : sourceAt(was, head, 'left')
      next = insertText(base.text, at, at, inserted, pending.current)
    }
    // Whatever the input method left in the elements is drawn again from the note (drawDoc redraws a block whose elements changed).
    commit(next ?? base, true)
  }

  useLayoutEffect(() => {
    if (raw) return
    const field = root()
    if (!field) return
    if (autoFocus || document.activeElement === document.body) field.focus({ preventScroll: true })
    draw(live.current)
    refreshLook()
    // Drawn when the field appears (and again when it comes back from the raw Markdown); afterwards every change goes through commit.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- drawn when the field appears and when it comes back from the raw Markdown, not at each draw of the component
  }, [raw])

  // A text given from outside (not one the field told): drawn as it is, with a history of its own.
  useLayoutEffect(() => {
    if (value === live.current.text) return
    live.current = { text: value, start: value.length, end: value.length }
    doc.current = readDoc(value)
    history.current = new NoteHistory(live.current)
    if (!raw) draw(live.current)
    refreshLook()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs for a text given from outside only; `raw` and `draw` are read as they are then
  }, [value])

  // The selection of the raw field, put back after a change made by a key or a button.
  useLayoutEffect(() => {
    const field = rawRef.current
    const wanted = rawSelection.current
    if (!raw || !field || wanted === null) return
    rawSelection.current = null
    field.setSelectionRange(wanted.start, wanted.end)
  })

  useEffect(() => {
    if (raw) return
    const field = root()
    if (!field) return
    // `beforeinput` is the browser's intention, before it changes anything: every one is done here on the Markdown and refused to the browser, but
    // for an input method's (React has no such event).
    const beforeInput = (event: InputEvent): void => {
      const type = event.inputType
      if (type === 'insertCompositionText') return
      event.preventDefault()
      if (composing.current) return
      const edit = now()
      const target = event.getTargetRanges?.()[0]
      const range = (() => {
        if (!target) return undefined
        const from = visibleOfPoint(field, doc.current, { node: target.startContainer, offset: target.startOffset })
        const to = visibleOfPoint(field, doc.current, { node: target.endContainer, offset: target.endOffset })
        return from === null || to === null ? undefined : ([Math.min(from, to), Math.max(from, to)] as [number, number])
      })()
      switch (type) {
        case 'insertText': {
          const data = event.data ?? ''
          if (data !== '') commit(insertText(edit.text, edit.start, edit.end, data, pending.current), true)
          return
        }
        case 'insertReplacementText': {
          // A correction of the spelling, an accent chosen from a held key: the text it names (or the selection, or the word at the caret), replaced.
          const data = event.dataTransfer?.getData('text/plain') ?? event.data ?? ''
          const span = range ?? (edit.start !== edit.end ? ([visibleAt(doc.current, edit.start), visibleAt(doc.current, edit.end)] as [number, number]) : wordSpan(edit.start))
          if (span) commit(insertText(edit.text, sourceAt(doc.current, span[0], 'right'), sourceAt(doc.current, span[1], 'left'), data), false)
          return
        }
        case 'insertParagraph':
        case 'insertLineBreak':
          return commit(enter(edit.text, edit.start, edit.end), false)
        case 'deleteContentBackward':
        case 'deleteWordBackward':
        case 'deleteSoftLineBackward':
        case 'deleteHardLineBackward':
          return commit(deleteBackward(edit.text, edit.start, edit.end, unitOf(type)), type === 'deleteContentBackward')
        case 'deleteContentForward':
        case 'deleteWordForward':
        case 'deleteSoftLineForward':
        case 'deleteHardLineForward':
          return commit(deleteForward(edit.text, edit.start, edit.end, unitOf(type)), type === 'deleteContentForward')
        case 'historyUndo':
          return restore(history.current.undo())
        case 'historyRedo':
          return restore(history.current.redo())
        default:
          // A drop, a paste (the paste handler's), a format of the browser, a transposition: refused.
          return
      }
    }
    // The browser names no range in a field of plain text: a word (⌥⌫) and a line (⌘⌫) are found here.
    const unitOf = (type: string): DeleteUnit => (/Word/.test(type) ? 'word' : /Line/.test(type) ? 'line' : 'char')
    const wordSpan = (at: number): [number, number] | null => {
      const visible = visibleAt(doc.current, at)
      const block = doc.current.blocks[blockIndexAt(doc.current, visible)]!
      const word = wordAt(block.text, visible - block.start)
      return word ? [block.start + word[0], block.start + word[1]] : null
    }
    const selectionChange = (): void => takeSelection()
    const compositionStart = (): void => {
      composing.current = { edit: now(), shown: doc.current.text }
    }
    const compositionEnd = (): void => {
      const started = composing.current
      composing.current = null
      if (started) readBack(started)
    }
    // Anything the browser wrote that no handler above took (it never should): read back as an input method's.
    const input = (): void => {
      if (composing.current) return
      const field = root()
      if (field && readShown(field) !== doc.current.text) readBack({ edit: live.current, shown: doc.current.text })
    }
    field.addEventListener('beforeinput', beforeInput)
    field.addEventListener('compositionstart', compositionStart)
    field.addEventListener('compositionend', compositionEnd)
    field.addEventListener('input', input)
    document.addEventListener('selectionchange', selectionChange)
    return () => {
      field.removeEventListener('beforeinput', beforeInput)
      field.removeEventListener('compositionstart', compositionStart)
      field.removeEventListener('compositionend', compositionEnd)
      field.removeEventListener('input', input)
      document.removeEventListener('selectionchange', selectionChange)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the listeners are put once per field; they read the latest functions through the refs
  }, [raw])

  /** ⌘B, ⌘I, the struck and the code: on the selection, or the look of what is typed next at a caret. */
  const mark = (which: InlineMark): void => {
    const edit = now()
    if (raw) return commit(toggleMarks(edit, which === 'strong' ? '**' : which === 'em' ? '*' : which === 'strike' ? '~~' : '`'), false)
    if (edit.start === edit.end) {
      const base = pending.current ?? typingStyle(doc.current, edit.start)
      const next: CharStyle = { ...base }
      if (next[which]) delete next[which]
      else next[which] = true
      pending.current = next
      refreshLook()
      return
    }
    commit(toggleInline(edit.text, edit.start, edit.end, which), false)
  }

  /** The link button and ⌘K: the address field (in the raw Markdown, the marks of a link with its address chosen). */
  const openLink = (): void => {
    const edit = now()
    if (raw) return commit(linkEdit(edit), false)
    setLink_({ start: edit.start, end: edit.end, href: selectionStyle(doc.current, edit.start, edit.end).href ?? '' })
  }

  const act = (action: ToolbarAction): void => {
    const edit = now()
    const blocks = (choice: BlockChoice): void => commit(setBlocks(edit.text, edit.start, edit.end, choice), false)
    switch (action) {
      case 'strong':
      case 'em':
      case 'strike':
        mark(action)
        break
      case 'code': {
        // Inside a line: code in the text; with a caret alone or over several lines: a block of code.
        const one = blocksIn(doc.current, edit.start, edit.end)
        const inLine = edit.start !== edit.end && one.length === 1 && doc.current.blocks[one[0]!]!.kind !== 'code'
        if (inLine) mark('code')
        else commit(toggleCodeBlock(edit.text, edit.start, edit.end), false)
        break
      }
      case 'h1':
        blocks({ kind: 'heading', level: 1 })
        break
      case 'h2':
        blocks({ kind: 'heading', level: 2 })
        break
      case 'bullet':
      case 'ordered':
      case 'task':
      case 'quote':
        blocks({ kind: action })
        break
      case 'link':
        return openLink()
      case 'raw':
        onRaw(!raw)
        return
    }
    focusField()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    // An input method owns Return and Escape while it composes: neither saves nor gives up the note.
    if ((composing.current || event.nativeEvent.isComposing) && (event.key === 'Enter' || event.key === 'Escape')) return event.stopPropagation()
    if (CARET_KEYS.has(event.key)) return event.stopPropagation()
    if (raw && event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      return commit(enterEdit(now()), false)
    }
    const command = event.metaKey || event.ctrlKey
    if (!command || event.altKey) return
    const key = event.key.toLowerCase()
    const run = (action: () => void): void => {
      event.preventDefault()
      action()
    }
    if (key === 'b' && !event.shiftKey) return run(() => mark('strong'))
    if (key === 'i' && !event.shiftKey) return run(() => mark('em'))
    if (key === 'k' && !event.shiftKey) return run(openLink)
    if (key === 'u' && event.shiftKey) return run(() => commit(toggleTasksEdit(now()), false))
    // ⌘U would underline, which Markdown has not.
    if (key === 'u') return event.preventDefault()
    if (key === 'z') {
      // Always taken: ⌘Z in the field never reaches the panel, where it would bring a deleted note back.
      event.preventDefault()
      return restore(event.shiftKey ? history.current.redo() : history.current.undo())
    }
  }

  const onPaste = (event: ReactClipboardEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const edit = now()
    const plain = pastedText(event.clipboardData.getData('text/plain'))
    const inCode = blocksIn(doc.current, edit.start, edit.end).some((index) => doc.current.blocks[index]!.kind === 'code')
    // Formatted text keeps what a note knows of it; in a block of code, only its text.
    const markdown = inCode ? '' : pastedMarkdown(event.clipboardData.getData('text/html'))
    commit(pasteMarkdown(edit.text, edit.start, edit.end, markdown !== '' ? markdown : plain, max), false)
  }

  // The clipboard gets the Markdown of the selection (its runs closed on its edges) and its HTML, for an application that takes formatted text.
  const onCopy = (event: ReactClipboardEvent<HTMLDivElement>, cut: boolean): void => {
    const edit = now()
    if (edit.start === edit.end) return
    event.preventDefault()
    const markdown = selectionMarkdown(edit.text, edit.start, edit.end)
    event.clipboardData.setData('text/plain', markdown)
    event.clipboardData.setData('text/html', noteHtml(markdown))
    if (cut) commit(deleteVisible(edit.text, visibleAt(doc.current, edit.start), visibleAt(doc.current, edit.end)), false)
  }

  const boxOf = (target: EventTarget): Element | null => (target instanceof Element ? target.closest('.nm-box') : null)

  const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    // A press on a box leaves the caret where it is: the click checks it.
    if (boxOf(event.target)) event.preventDefault()
  }

  const onClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const field = root()
    if (!field) return
    const box = boxOf(event.target)
    if (box) {
      event.preventDefault()
      const index = blockIndexOfNode(field, box)
      const block = doc.current.blocks[index]
      const edit = now()
      if (block) commit({ ...edit, text: toggleTaskLine(edit.text, edit.text.slice(0, block.from).split('\n').length - 1) }, false)
      return
    }
    const target = event.target instanceof Element ? event.target.closest('[data-href]') : null
    const href = target ? safeNoteHref(target.getAttribute('data-href') ?? '') : null
    if (href !== null && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      onOpenLink(href)
    }
  }

  const applyLink = (href: string | null): void => {
    const target = link
    setLink_(null)
    if (target === null) return
    const text = live.current.text
    live.current = { ...live.current, start: target.start, end: target.end }
    commit(setLink(text, target.start, target.end, href), false)
    focusField()
  }

  return (
    <div className="nm-wrap">
      <NoteToolbar look={look} raw={raw} controls={fieldId} onAction={act} />
      {link && (
        <LinkField
          initial={link.href}
          linked={link.href !== ''}
          onApply={(href) => applyLink(href)}
          onRemove={() => applyLink(null)}
          onClose={() => {
            setLink_(null)
            focusField()
          }}
        />
      )}
      {raw ? (
        <textarea
          ref={rawRef}
          id={fieldId}
          className="tk-field notes-text nm-raw"
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          placeholder={t('notes.ecrire-une-note')}
          spellCheck
          autoFocus
          value={value}
          onKeyDown={onKeyDown}
          onSelect={(event) => {
            const field = event.currentTarget
            live.current = { ...live.current, start: field.selectionStart, end: field.selectionEnd }
            refreshLook()
          }}
          onChange={(event) => {
            const field = event.currentTarget
            commit({ text: field.value, start: field.selectionStart, end: field.selectionEnd }, true)
          }}
        />
      ) : (
        <div
          ref={ref}
          id={fieldId}
          className="tk-field notes-text nm-editor"
          role="textbox"
          aria-multiline="true"
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-placeholder={t('notes.ecrire-une-note')}
          data-placeholder={t('notes.ecrire-une-note')}
          contentEditable="plaintext-only"
          spellCheck
          suppressContentEditableWarning
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCopy={(event) => onCopy(event, false)}
          onCut={(event) => onCopy(event, true)}
          onDragStart={(event) => event.preventDefault()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => event.preventDefault()}
          onMouseDown={onMouseDown}
          onClick={onClick}
          onFocus={() => takeSelection()}
        />
      )}
    </div>
  )
}
