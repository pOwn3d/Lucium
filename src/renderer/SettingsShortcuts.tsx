// The Shortcuts pane (Settings): the "start with the basics" banner, the searchable list of commands and the aside about custom shortcuts.

import { useEffect, useRef, useState } from 'react'
import type { Settings } from '@shared/model'
import {
  COMMANDS,
  FIXED_SHORTCUTS,
  effectiveAccelerator,
  canonicalAccelerator,
  extensionMenuCommands,
  findConflicts,
  formatAccelerator,
  keyLayoutOf,
  type CommandDef,
  type ExtensionShortcuts,
  type KeyLayout
} from '@shared/keybindings'
import type { PlatformId } from '@shared/platform'
import { readKeyboardCharacters } from './keyboard-layout'
import {
  SEARCH_EXAMPLES,
  assignShortcut,
  conflictNote,
  recordingStep,
  restoreRemoved,
  settleConflicts,
  shortcutSections,
  takenNote,
  otherUseNotes,
  type RemovedShortcut
} from '@shared/shortcut-view'
import { COMMAND, DOTS, Group, MoreText, Row, SEARCH } from './settings-parts'
import { getLanguage, t } from '@shared/i18n'
import { actionName } from './action-name'
import { focusFirstEntry, moveInMenu } from './menu-keys'
import { isUndoKey } from '@shared/panel-keys'
import { settingsPath } from '@shared/settings-path'
import { useActionNotice, type NoticeHoldProps } from './notice-hold'

interface Props {
  bindings: Record<string, string>
  /** The system the shortcuts are drawn, read and recorded for. */
  platform: PlatformId
  /** The extensions that are on: the shortcuts the Extensions menu gives their commands are not free. */
  extensions?: readonly ExtensionShortcuts[]
  /** « Raccourci de la mini-fenêtre dans toutes les apps » is on. */
  littleEverywhere?: boolean
  /** The keyboard layout, when the caller knows it already (the pane reads it otherwise). */
  keyboard?: Readonly<Record<string, string>>
  update: (patch: Partial<Settings>) => void
  /** In the results of a search the editor below is hidden (it is a tool, not a row); this opens the subpage that holds it. */
  open?: () => void
}

const SMILE = (
  <svg viewBox="0 0 30 30" fill="none" stroke="currentColor" strokeWidth="2.600" strokeLinecap="round" aria-hidden="true">
    <path d="M10.500 6.500v3.200M19.500 6.500v3.200M5.500 17c2.200 5 6 7.200 9.500 7.200S22.300 22 24.500 17" />
  </svg>
)
const BIG_COMMAND = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.100" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 6V4.200A1.700 1.700 0 1 0 4.300 5.900H6zm0 0h4m-4 0v4m4-4V4.200a1.700 1.700 0 1 1 1.700 1.700H10zm0 0v4M6 10H4.300A1.700 1.700 0 1 0 6 11.800zm0 0h4m0 0v1.800a1.700 1.700 0 1 0 1.700-1.800z" />
  </svg>
)

/**
 * What the pane tells under the text of the aside: two commands now share a shortcut (with the way out), the clashes were removed (with the way back),
 * every shortcut the user had chosen was reset (with the way back: they are kept nowhere else), the shortcut of one command was reset (with the way
 * back for a few seconds, as a deletion in a list), or the shortcut just typed was refused because an entry that cannot let go of it has it (nothing
 * was saved, so there is nothing to undo).
 */
export type ShortcutNoticeContent =
  | { kind: 'clash'; text: string }
  | { kind: 'removed'; text: string; removed: RemovedShortcut[] }
  | { kind: 'reset'; text: string; bindings: Record<string, string> }
  | { kind: 'reset-one'; text: string; id: string; accelerator: string }
  | { kind: 'refused'; text: string }

/** The notices ⌘Z takes back, as their button does. */
const UNDOABLE: ReadonlySet<ShortcutNoticeContent['kind']> = new Set(['removed', 'reset', 'reset-one'])

/** A field where ⌘Z undoes the typing, not a change of the pane. */
const isField = (target: EventTarget | null): boolean => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)

/**
 * The status line of the pane. The region is always there, empty when there is nothing to say: a screen reader announces a change inside a live region,
 * not one that arrives with its text.
 */
export function ShortcutNotice({ notice, onRemove, onUndo, hold }: { notice: ShortcutNoticeContent | null; onRemove: () => void; onUndo: () => void; hold?: NoticeHoldProps }) {
  return (
    <div className="shortcuts-notice" role="status" aria-live="polite" aria-atomic="true" {...hold}>
      {notice && (
        <>
          <div className="shortcuts-notice-text">{notice.text}</div>
          {notice.kind === 'clash' && (
            <button className="link-button" onClick={onRemove}>
              {t('settings-shortcuts.retirer-les-raccourcis-en-conflit')}
            </button>
          )}
          {notice.kind === 'removed' && (
            <button className="link-button" onClick={onUndo}>
              {t('settings-shortcuts.annuler-le-retrait')}
            </button>
          )}
          {(notice.kind === 'reset' || notice.kind === 'reset-one') && (
            <button className="link-button" onClick={onUndo}>
              {t('settings-shortcuts.annuler-la-reinitialisation')}
            </button>
          )}
        </>
      )}
    </div>
  )
}

export function ShortcutsPane({ bindings, platform, extensions = [], littleEverywhere = false, keyboard, update, open }: Props) {
  const [filter, setFilter] = useState('')
  const [basicsOnly, setBasicsOnly] = useState(false)
  // The same command can show twice (customised, then in the list): only the row that was clicked listens for the new keys.
  const [recording, setRecording] = useState<string | null>(null)
  // The keyboard layout, read again each time a recording starts (it can change while the pane is open): it names the letter of a key
  // when Option hides it, and says which shortcuts ask for a key this keyboard does not give alone.
  const [characters, setCharacters] = useState(keyboard)
  const layout = useRef<KeyLayout | undefined>(keyboard ? keyLayoutOf(keyboard) : undefined)
  useEffect(() => {
    let current = true
    void readKeyboardCharacters().then((read) => {
      if (!current || !read) return
      layout.current = keyLayoutOf(read)
      setCharacters(read)
    })
    return () => {
      current = false
    }
  }, [recording])
  const [menu, setMenu] = useState(false)
  const menuBox = useRef<HTMLDivElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const menuCard = useRef<HTMLDivElement>(null)
  const [notice, setNotice] = useState<ShortcutNoticeContent | null>(null)
  // The commands the user gave a shortcut to in this pane, oldest first: when two commands share one, the one typed last keeps it.
  const assigned = useRef<string[]>([])
  const conflicts = findConflicts(bindings)
  // The shortcuts that are not the Settings' to give: the fixed entries of the menus, and the commands of the extensions.
  const taken = [...FIXED_SHORTCUTS, ...extensions.flatMap(extensionMenuCommands)]
  const accelerators = Object.fromEntries(COMMANDS.map((c) => [c.id, effectiveAccelerator(c.id, bindings, platform)]))
  const customized = Object.keys(bindings).length

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => !menuBox.current?.contains(e.target as Node) && setMenu(false)
    window.addEventListener('mousedown', close)
    // A menu that opens takes the focus on its first entry: the arrows then go through it.
    if (menuCard.current) focusFirstEntry(menuCard.current)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])
  /** Closes the menu and gives the focus back to the button that opened it (the entry that had it is gone). */
  const closeMenu = () => {
    setMenu(false)
    menuButton.current?.focus()
  }

  /** Saves the bindings and forgets what the notice said (the commands it spoke of may have changed). */
  const save = (next: Record<string, string>) => {
    update({ keyBindings: next })
    setNotice(null)
  }
  /**
   * Gives `id` the shortcut just typed, unless a fixed entry of the menus or an extension has it: the status line then says whose it is, and
   * nothing changes. If another command has it, both are named in the status line, with the way to remove the clash.
   */
  const record = (id: string, accelerator: string) => {
    const assignment = assignShortcut(id, accelerator, bindings, taken, platform)
    if (assignment.kind === 'refused') return setNotice({ kind: 'refused', text: assignment.text })
    update({ keyBindings: assignment.bindings })
    // Appended each time: the rule reads the list from its end, and ignores a command that has no saved shortcut any more.
    assigned.current.push(id)
    setNotice(assignment.clash ? { kind: 'clash', text: assignment.clash } : null)
  }
  /** The command typed last keeps its shortcut, the others lose theirs; the status line says which, and can give them back. */
  const removeConflicts = () => {
    const settled = settleConflicts(bindings, platform, assigned.current)
    if (settled) update({ keyBindings: settled.bindings })
    setNotice(settled ? { kind: 'removed', text: settled.text, removed: settled.removed } : null)
  }
  /** Every shortcut goes back to its default. The ones the user had chosen are kept in the notice, which can give them back. */
  const resetAll = () => {
    if (customized === 0) return
    update({ keyBindings: {} })
    setNotice({ kind: 'reset', text: t('settings-shortcuts.raccourcis-reinitialises'), bindings: { ...bindings } })
  }
  /**
   * « Réinitialiser » on one row: the command takes its default shortcut back at once, and the notice gives the one the user had chosen back
   * (its button, or ⌘Z) for ACTION_NOTICE_MS, as « Rétablir » of the Settings offers its « Annuler » (and waits while the pointer or the focus is on it).
   */
  const resetOne = (c: CommandDef) => {
    const { [c.id]: chosen, ...rest } = bindings
    if (chosen === undefined) return
    update({ keyBindings: rest })
    setNotice({ kind: 'reset-one', text: t('settings-shortcuts.command-retrouve-son-raccourci-par-defaut', { command: c.label }), id: c.id, accelerator: chosen })
  }
  const undoNotice = () => {
    // The shortcut of one row comes back through the rule of a typed one: a fixed entry of the menus or an extension that took it since keeps it,
    // and the status line says so.
    if (notice?.kind === 'reset-one') return record(notice.id, notice.accelerator)
    if (notice?.kind === 'removed') update({ keyBindings: restoreRemoved(bindings, notice.removed) })
    else if (notice?.kind === 'reset') update({ keyBindings: notice.bindings })
    else return
    setNotice(null)
  }
  // The way back from the reset of one row lasts a few seconds, then the notice goes.
  const resetNotice = useActionNotice(notice?.kind === 'reset-one' ? notice : null, () => setNotice((now) => (now === notice ? null : now)))
  // ⌘Z takes back what the notice offers to take back, outside a field (where it undoes the typing) and outside the key being recorded (which keeps it).
  useEffect(() => {
    if (!notice || !UNDOABLE.has(notice.kind)) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isUndoKey(e, isField(e.target))) return
      e.preventDefault()
      undoNotice()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const { basics, all } = shortcutSections(filter, accelerators)
  const changed = all.filter((c) => bindings[c.id] !== undefined)
  const rest = all.filter((c) => bindings[c.id] === undefined)

  const row = (c: CommandDef, section: string) => {
    const key = `${section}:${c.id}`
    const accelerator = effectiveAccelerator(c.id, bindings, platform)
    const clash = accelerator ? conflicts[canonicalAccelerator(accelerator)] : undefined
    const isChanged = bindings[c.id] !== undefined
    // The conflict is written out (a colour alone says nothing to a screen reader, or to someone who does not see it): with which command, under the name.
    const note = clash ? conflictNote(c.id, bindings) : undefined
    const noteId = `shortcut-clash-${key.replace(':', '-')}`
    // The same for a shortcut something else than a command holds (saved before it was refused, or an extension came since).
    const held = takenNote(c.id, bindings, taken)
    const heldId = `shortcut-held-${key.replace(':', '-')}`
    // What sites, macOS or the keyboard in use do with the same press: said, without the colour of a clash (nothing is broken).
    const uses = otherUseNotes(c.id, bindings, platform, { characters, littleEverywhere })
    const usesId = `shortcut-use-${key.replace(':', '-')}`
    const described = [note ? noteId : '', held ? heldId : '', uses.length > 0 ? usesId : ''].filter(Boolean).join(' ')
    // The key is named by its command, then by what it shows (the shortcut, « --- » or « Appuyez… »): alone, « ⌘T » says nothing of what it does.
    const nameId = `shortcut-name-${key.replace(':', '-')}`
    const keyId = `shortcut-key-${key.replace(':', '-')}`
    return (
      <div key={key} className={['shortcut-row', note || held ? 'has-clash' : '', uses.length > 0 ? 'has-note' : ''].filter(Boolean).join(' ')}>
        <span className="shortcut-label" title={c.group}>
          <span id={nameId}>{c.label}</span>
          {note && (
            <span className="shortcut-clash-note" id={noteId}>
              {note}
            </span>
          )}
          {held && (
            <span className="shortcut-clash-note" id={heldId}>
              {held}
            </span>
          )}
        </span>
        {isChanged && (
          <button
            className="link-button shortcut-reset"
            aria-label={actionName(t('settings-shortcuts.reinitialiser'), c.label)}
            onClick={() => resetOne(c)}
          >
            {t('settings-shortcuts.reinitialiser')}
          </button>
        )}
        <button
          className={`shortcut-key ${recording === key ? 'recording' : ''} ${clash || held ? 'clash' : ''} ${accelerator ? '' : 'off'}`}
          title={recording === key ? t('settings-shortcuts.appuyez-sur-la-nouvelle-combinaison-echap') : clash ? t('panels.ce-raccourci-est-deja-utilise-par-une-autre') : t('panels.modifier-le-raccourci')}
          id={keyId}
          aria-labelledby={`${nameId} ${keyId}`}
          aria-describedby={described || undefined}
          onClick={() => setRecording(key)}
          onBlur={() => setRecording((r) => (r === key ? null : r))}
          onKeyDown={(e) => {
            if (recording !== key) return
            e.preventDefault()
            e.stopPropagation()
            const step = recordingStep(e.nativeEvent, platform, layout.current)
            if (step.kind === 'wait') return
            if (step.kind === 'clear') save({ ...bindings, [c.id]: '' })
            if (step.kind === 'record') record(c.id, step.accelerator)
            setRecording(null)
          }}
        >
          {recording === key ? t('settings-shortcuts.appuyez') : accelerator ? formatAccelerator(accelerator, platform) : '---'}
        </button>
        {/* On a line of its own under the row, outside the name of the command: the name stays the whole text of its label. */}
        {uses.length > 0 && (
          <span className="shortcut-use-note" id={usesId}>
            {uses.join(' ')}
          </span>
        )}
      </div>
    )
  }

  const empty = all.length === 0
  return (
    <>
      {/* Shown by a search only (settings.css), and never where a result lands (settings-anchor.ts): the editor is the place. */}
      <div className="shortcuts-jump" data-search-only="">
        <Group>
          {/* The row of the shortcuts in a search: it carries their setting, so that « raccourci » (shared/settings-synonyms.ts) names it. */}
          <Row settingKey="keyBindings" label={t('cmd.modifier-les-raccourcis-clavier')}>
            <button className="button" onClick={open}>
              {t('settings.changer')}
            </button>
          </Row>
        </Group>
      </div>
      <div className="shortcuts-callout">
        <span>{t('settings-shortcuts.commencez-par-les-bases')}</span>
        <button className="button" aria-pressed={basicsOnly} onClick={() => setBasicsOnly(!basicsOnly)}>
          {COMMAND}
          {basicsOnly ? t('settings-shortcuts.voir-tous-les-raccourcis') : t('settings-shortcuts.decouvrir-les-raccourcis-essentiels')}
        </button>
      </div>
      <div className="shortcuts-layout" data-setting="keyBindings">
        <div className="shortcuts-box">
          <div className="shortcuts-search">
            {SEARCH}
            <input type="search" placeholder={t('settings-shortcuts.saisissez-une-commande-ou-un-raccourci-comme', { example: SEARCH_EXAMPLES[getLanguage()] })} aria-label={t('settings-shortcuts.rechercher-un-raccourci')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="shortcuts-list">
            {basicsOnly && filter.trim() === '' ? (
              <section className="shortcut-basics" aria-label={t('settings-shortcuts.raccourcis-essentiels')}>
                <h4 className="shortcuts-head">{t('settings-shortcuts.raccourcis-essentiels')}</h4>
                {basics.map((c) => row(c, 'basics'))}
              </section>
            ) : empty ? (
              <p className="muted shortcut-empty">{t('settings-shortcuts.aucun-raccourci')}</p>
            ) : (
              <>
                {changed.length > 0 && (
                  <section aria-label={t('settings-shortcuts.raccourcis-personnalises')}>
                    <h4 className="shortcuts-head">{t('settings-shortcuts.raccourcis-personnalises')}</h4>
                    {changed.map((c) => row(c, 'custom'))}
                  </section>
                )}
                {rest.length > 0 && (
                  <section aria-label={t('panels.tous-les-raccourcis')}>
                    <h4 className="shortcuts-head">{t('settings-shortcuts.raccourcis-par-defaut')}</h4>
                    {rest.map((c) => row(c, 'all'))}
                  </section>
                )}
              </>
            )}
          </div>
        </div>
        <div className="shortcuts-aside">
          <div className="keycaps" aria-hidden="true">
            <span className="keycap">{BIG_COMMAND}</span>
            <span className="keycap">{SMILE}</span>
          </div>
          <h2>{t('settings-shortcuts.raccourcis-personnalises')}</h2>
          <p>{t('settings-shortcuts.modifiez-les-raccourcis')}</p>
          <ShortcutNotice notice={notice} onRemove={removeConflicts} onUndo={undoNotice} hold={resetNotice.props} />
          <div className="shortcuts-aside-foot" ref={menuBox}>
            <button className="button" disabled={customized === 0} onClick={resetAll}>
              {t('settings-shortcuts.tout-reinitialiser')}
            </button>
            <button ref={menuButton} className="round-button" aria-label={t('settings-shortcuts.plus-d-actions')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              {DOTS}
            </button>
            {menu && (
              <div
                ref={menuCard}
                className="menu-pop"
                role="menu"
                aria-label={t('settings-shortcuts.plus-d-actions')}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    // The menu's own Escape: the window of the Settings must not also hear it.
                    e.preventDefault()
                    e.stopPropagation()
                    closeMenu()
                  } else if (moveInMenu(e.currentTarget, document.activeElement, e.key)) e.preventDefault()
                }}
              >
                <button
                  role="menuitem"
                  disabled={customized === 0}
                  onClick={() => {
                    resetAll()
                    closeMenu()
                  }}
                >
                  {t('settings-shortcuts.reinitialiser-tous-les-raccourcis')}
                </button>
                <button
                  role="menuitem"
                  disabled={Object.keys(conflicts).length === 0}
                  onClick={() => {
                    removeConflicts()
                    closeMenu()
                  }}
                >
                  {t('settings-shortcuts.retirer-les-raccourcis-en-conflit')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {/* The default shortcuts that take a key macOS gives to another command, said where the shortcuts are (and under ⌃Tab, on the page). It says nothing elsewhere: the keys of that sentence are the ones of macOS. */}
      {platform === 'darwin' && (
        <>
          <p className="pref-note">{t('settings-shortcuts.quelques-raccourcis-prennent-une-touche-que')}</p>
          <div className="pref-note pref-note-more">
            <MoreText more={t('settings-shortcuts.raccourcis-du-systeme-repris', { settingsPath: settingsPath('shortcuts') })} />
          </div>
        </>
      )}
    </>
  )
}
