// How the Shortcuts pane lays the commands out ("Start with the basics", then the whole list).

import {
  COMMANDS,
  acceleratorFromKeyEvent,
  canonicalAccelerator,
  effectiveAccelerator,
  findConflicts,
  formatAccelerator,
  keyOffLayout,
  secondAccelerator,
  otherUseOf,
  takenBy,
  type CommandDef,
  type KeyBindings,
  type KeyEventLike,
  type KeyLayout,
  type TakenShortcut
} from './keybindings'
import { getLanguage, quoted, t, type Language } from './i18n'
import { foldMarks } from './fold'

/** The shortcuts worth knowing first, in the order they are shown. */
export const BASIC_SHORTCUTS: readonly string[] = ['newTab', 'openLocation', 'closeTab', 'pin', 'toggleSidebar', 'find', 'reload']

/**
 * The query the search box offers as its example, in each language. It names a shortcut that exists (⌘T is "Nouvel onglet"): an example that finds nothing
 * ("Commande E" did, no command has ⌘E) makes the person think the search is broken.
 */
export const SEARCH_EXAMPLES: Readonly<Record<Language, string>> = { fr: 'Commande T', en: 'Command T' }

/** Lower case without accents, so "epingler" finds "Épingler". */
const fold = foldMarks

export interface ShortcutSections {
  /** The essentials, shown above the list; empty while the user is searching. */
  basics: CommandDef[]
  /** Every command that matches, alphabetically. */
  all: CommandDef[]
}

const MODIFIER_ALIASES: Record<string, string> = {
  '⌘': 'cmd', cmd: 'cmd', command: 'cmd', commande: 'cmd', cmdorctrl: 'cmd',
  '⇧': 'shift', shift: 'shift', maj: 'shift', majuscule: 'shift',
  '⌥': 'alt', alt: 'alt', option: 'alt', opt: 'alt',
  '⌃': 'ctrl', ctrl: 'ctrl', control: 'ctrl', controle: 'ctrl'
}
// The keys as the list draws them (↑ ⇥ ↩…, see formatAcceleratorFor) and as a French keyboard names them, for the names accelerators carry (Up, Tab, Return…).
const KEY_ALIASES: Record<string, string> = {
  espace: 'space', entree: 'return', retour: 'return', haut: 'up', bas: 'down', gauche: 'left', droite: 'right', plus: 'plus', moins: '-',
  tabulation: 'tab', supprimer: 'delete', suppr: 'delete',
  '↑': 'up', '↓': 'down', '←': 'left', '→': 'right', '↩': 'return', '⌫': 'backspace', '⌦': 'delete', '␣': 'space', '⇥': 'tab'
}
/** Words that only say "key": "Flèche gauche" is the key "left". */
const FILLER_WORDS: ReadonlySet<string> = new Set(['fleche', 'fleches'])

/**
 * The query an end user types in the search box, in the words the accelerators carry: "Commande E", "⌘E" and "cmd+e" all give the same two. The
 * symbols of the modifiers (⌘ ⇧ ⌥ ⌃) need no gap, their French and English names work with or without accents, and a "+" that ends the query is the Plus key
 * ("⌘+" is Zoom avant) while one between two words only joins them.
 */
export function queryWords(query: string): string[] {
  const spaced = fold(query)
    .replace(/[⌘⇧⌥⌃]/g, (symbol) => ` ${symbol} `)
    .replace(/retour arriere/g, 'backspace')
    // A "+" that follows a gap or another "+" and ends the query names the key; any other one separates words ("cmd+shift+j", and "cmd+" half typed).
    .replace(/(^|[\s+])\+(?=\s*$)/, '$1plus')
  return spaced
    .split(/[\s+]+/)
    .filter((word) => word !== '' && !FILLER_WORDS.has(word))
    .map((word) => MODIFIER_ALIASES[word] ?? KEY_ALIASES[word] ?? word)
}

/** The words of an accelerator: "CmdOrCtrl+Shift+J" → cmd, shift, j. */
export function acceleratorWords(accelerator: string): string[] {
  return accelerator.split('+').map((part) => (MODIFIER_ALIASES[part.toLowerCase()] ?? part).toLowerCase())
}

/** A query names a shortcut (rather than a feature) when it carries a modifier: "Commande E" finds ⌘E. */
export function matchesShortcut(query: string, accelerator: string | undefined): boolean {
  if (!accelerator) return false
  const words = queryWords(query)
  if (!words.some((w) => ['cmd', 'shift', 'alt', 'ctrl'].includes(w))) return false
  const have = acceleratorWords(accelerator)
  return words.every((w) => have.includes(w))
}

/** `accelerators` (command id → its accelerator in force) lets a search find a command by its shortcut as well as by its name. */
export function shortcutSections(filter: string, accelerators?: Readonly<Record<string, string | undefined>>): ShortcutSections {
  const wanted = fold(filter.trim())
  const alphabetical = [...COMMANDS].sort((a, b) => a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' }))
  if (wanted) {
    return { basics: [], all: alphabetical.filter((c) => fold(c.label).includes(wanted) || fold(c.group).includes(wanted) || matchesShortcut(filter, accelerators?.[c.id])) }
  }
  return { basics: BASIC_SHORTCUTS.flatMap((id) => COMMANDS.filter((c) => c.id === id)), all: alphabetical }
}

/** The other commands that have the accelerator `id` has in force (after the overrides): the ones it clashes with. Empty when it has none or no clash. */
export function conflictPartners(id: string, bindings: KeyBindings | undefined): string[] {
  const accelerator = effectiveAccelerator(id, bindings)
  if (!accelerator) return []
  return (findConflicts(bindings)[canonicalAccelerator(accelerator)] ?? []).filter((other) => other !== id)
}

/** What "Retirer les raccourcis en conflit" took from a command, so that it can be given back. */
export interface RemovedShortcut {
  id: string
  /** The accelerator it had (and lost). */
  accelerator: string
  /** What the user had saved for it: an accelerator, or undefined when it ran on its default. */
  was: string | undefined
}

export interface SettledConflict {
  /** The accelerator in dispute, as the winner has it. */
  accelerator: string
  /** The command that keeps it. */
  kept: string
  /** The commands switched off. */
  removed: string[]
}

export interface ConflictResolution {
  bindings: KeyBindings
  settled: SettledConflict[]
  removed: RemovedShortcut[]
}

/**
 * Who keeps a shortcut that several commands have: what the user has just assigned (`recent`, oldest first, only the commands that still have a saved
 * binding), else the command with a saved binding that was saved last (the keys of the bindings keep the order they were first saved in), else, when
 * every one of them runs on its default, the first of the list. A shortcut the user chose never loses to a default.
 */
function keeperOf(ids: readonly string[], bindings: KeyBindings, recent: readonly string[]): string {
  for (let i = recent.length - 1; i >= 0; i--) {
    const id = recent[i]!
    if (ids.includes(id) && bindings[id] !== undefined) return id
  }
  const chosen = Object.keys(bindings).filter((id) => ids.includes(id))
  return chosen.at(-1) ?? ids[0]!
}

/**
 * Settles every clash: in each group of commands that share an accelerator one keeps it (see `keeperOf`: the one the user has just assigned) and the others
 * are switched off (saved as ''). Says what was kept and removed, and `restoreRemoved` undoes it.
 */
export function resolveConflicts(bindings: KeyBindings, recent: readonly string[] = []): ConflictResolution {
  const next = { ...bindings }
  const settled: SettledConflict[] = []
  const removed: RemovedShortcut[] = []
  for (const [canonical, ids] of Object.entries(findConflicts(bindings))) {
    const kept = keeperOf(ids, bindings, recent)
    const losers = ids.filter((id) => id !== kept)
    for (const id of losers) {
      next[id] = ''
      removed.push({ id, accelerator: effectiveAccelerator(id, bindings) ?? canonical, was: bindings[id] })
    }
    settled.push({ accelerator: effectiveAccelerator(kept, bindings) ?? canonical, kept, removed: losers })
  }
  return { bindings: next, settled, removed }
}

/** The bindings with every clash settled (see `resolveConflicts`). */
export function withoutConflicts(bindings: KeyBindings, recent: readonly string[] = []): KeyBindings {
  return resolveConflicts(bindings, recent).bindings
}

/**
 * Gives back what `resolveConflicts` took, to the commands it took it from and only if they are still switched off: what the user changed since is kept.
 * A command that ran on its default goes back to it (its saved binding is dropped).
 */
export function restoreRemoved(bindings: KeyBindings, removed: readonly RemovedShortcut[]): KeyBindings {
  const next = { ...bindings }
  for (const { id, was } of removed) {
    if (next[id] !== '') continue
    if (was === undefined) delete next[id]
    else next[id] = was
  }
  return next
}

/** « A », « B » in French, “A”, “B” in English: names of commands in a sentence. */
export function quotedNames(names: readonly string[], language: Language): string {
  return names.map((name) => quoted(name, language)).join(', ')
}

/** What the list calls a command (its id for one that does not exist any more). */
export function commandLabel(id: string): string {
  return COMMANDS.find((c) => c.id === id)?.label ?? id
}

/** Under a row whose shortcut clashes: "En conflit avec « Nouvel onglet »". Undefined when the command has no clash. */
export function conflictNote(id: string, bindings: KeyBindings | undefined): string | undefined {
  const partners = conflictPartners(id, bindings)
  return partners.length > 0 ? t('settings-shortcuts.en-conflit-avec', { commands: quotedNames(partners.map(commandLabel), getLanguage()) }) : undefined
}

/** Said when a shortcut has just been assigned to a command that already had it elsewhere: both commands are named. Undefined when it clashes with nothing. */
export function conflictAnnouncement(id: string, bindings: KeyBindings | undefined): string | undefined {
  const partners = conflictPartners(id, bindings)
  if (partners.length === 0) return undefined
  // A command that clashes has the accelerator it clashes on.
  const accelerator = effectiveAccelerator(id, bindings)!
  return t('settings-shortcuts.conflit-signale', { shortcut: formatAccelerator(accelerator), commands: quotedNames([id, ...partners].map(commandLabel), getLanguage()) })
}

/** Said when the conflicts have been removed: for each shortcut, the command that keeps it and the ones it was taken from. */
export function resolutionAnnouncement(resolution: ConflictResolution): string {
  const language = getLanguage()
  return resolution.settled
    .map((s) => t('settings-shortcuts.conflit-resolu', { shortcut: formatAccelerator(s.accelerator), kept: quotedNames([commandLabel(s.kept)], language), removed: quotedNames(s.removed.map(commandLabel), language) }))
    .join(' ')
}

/**
 * What "Retirer les raccourcis en conflit" does: the bindings with the clashes settled (see `resolveConflicts`), the sentence that says what was kept and
 * removed, and what to give back to undo it. Undefined when nothing clashes (nothing to remove, nothing to say).
 */
export function settleConflicts(bindings: KeyBindings, recent: readonly string[] = []): { bindings: KeyBindings; text: string; removed: RemovedShortcut[] } | undefined {
  const resolution = resolveConflicts(bindings, recent)
  if (resolution.removed.length === 0) return undefined
  return { bindings: resolution.bindings, text: resolutionAnnouncement(resolution), removed: resolution.removed }
}

/** What a key press does to a row that is recording its shortcut. */
export type RecordingStep =
  /** Escape: the row keeps the shortcut it had. */
  | { kind: 'cancel' }
  /** Backspace or Delete alone: the command has no shortcut any more. */
  | { kind: 'clear' }
  /** A lone modifier, or a key no shortcut can name: the row keeps listening. */
  | { kind: 'wait' }
  | { kind: 'record'; accelerator: string }

/**
 * Reads a press for the row that records. Backspace and Delete turn the shortcut off only when pressed alone (Shift apart): with ⌘, ⌃ or ⌥
 * they are a shortcut like another (⌘⌫), which could not be given otherwise.
 */
export function recordingStep(e: KeyEventLike & { key: string }, layout?: KeyLayout): RecordingStep {
  if (e.key === 'Escape') return { kind: 'cancel' }
  if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey) return { kind: 'clear' }
  const accelerator = acceleratorFromKeyEvent(e, undefined, layout)
  return accelerator ? { kind: 'record', accelerator } : { kind: 'wait' }
}

/** Said when a shortcut is refused because an entry that cannot let go of it has it (a fixed entry of the menus, a shortcut of an extension). */
export function refusalAnnouncement(id: string, accelerator: string, owner: TakenShortcut): string {
  const language = getLanguage()
  return t('settings-shortcuts.raccourci-reserve', { shortcut: formatAccelerator(accelerator), owner: quoted(owner.label, language), command: quoted(commandLabel(id), language) })
}

/**
 * Under a row whose shortcut something else than a command holds too (a binding saved before the Settings refused it, or an extension added
 * since): who, and what it means. Undefined when the shortcut of the command is its own.
 */
export function takenNote(id: string, bindings: KeyBindings | undefined, taken: readonly TakenShortcut[]): string | undefined {
  const owner = takenBy(effectiveAccelerator(id, bindings), taken)
  if (!owner) return undefined
  // A command of an extension never wins over a command of Lucium: the menu gives it no key (see `takenExtensionShortcuts`), so the note
  // says which of the two is silent. A fixed entry of the menus keeps its key, and which of the two answers is not settled.
  const key = 'extensionId' in owner ? 'settings-shortcuts.aussi-propose-par-une-extension' : 'settings-shortcuts.aussi-pris-par'
  return t(key, { owner: quoted(owner.label, getLanguage()) })
}

/** What giving a shortcut to a command comes to. */
export type Assignment =
  /** An entry that cannot let go of the shortcut has it: nothing is saved, `text` says whose it is. */
  | { kind: 'refused'; text: string }
  /** The bindings to save; `clash` names the commands that now share the shortcut, when another one has it. */
  | { kind: 'saved'; bindings: KeyBindings; clash: string | undefined }

/**
 * Gives `id` the shortcut just typed, unless something that is not a command holds it (`taken`). The command goes last in the saved
 * bindings even when it had a saved shortcut already: of two commands on one shortcut, the one saved last keeps it (see `keeperOf`).
 */
export function assignShortcut(id: string, accelerator: string, bindings: KeyBindings, taken: readonly TakenShortcut[]): Assignment {
  const owner = takenBy(accelerator, taken)
  if (owner) return { kind: 'refused', text: refusalAnnouncement(id, accelerator, owner) }
  const others = Object.fromEntries(Object.entries(bindings).filter(([other]) => other !== id))
  const next = { ...others, [id]: accelerator }
  return { kind: 'saved', bindings: next, clash: conflictAnnouncement(id, next) }
}

/** What the Settings know besides the bindings, to say what a shortcut runs into. */
export interface ShortcutSurroundings {
  /** The keyboard layout in use (the character of each key), when it could be read. */
  characters?: Readonly<Record<string, string>> | undefined
  /** « Raccourci de la mini-fenêtre dans toutes les apps » is on: the shortcut of the mini window is held for the whole system. */
  littleEverywhere?: boolean
}

const USE_NOTE = {
  page: 'settings-shortcuts.note-pages',
  macos: 'settings-shortcuts.note-macos',
  'mission-control': 'settings-shortcuts.note-mission-control'
} as const

/**
 * What is worth knowing about the shortcut a command has in force, under its row: sites or macOS use the same press, the shortcut is held in
 * every application, or the keyboard in use does not give its key alone. Nothing for a command without a shortcut. These are not clashes
 * (nothing is broken in the application): they say why a press may do something else than expected, or nothing.
 */
export function otherUseNotes(id: string, bindings: KeyBindings | undefined, surroundings: ShortcutSurroundings = {}): string[] {
  const accelerator = effectiveAccelerator(id, bindings)
  if (!accelerator) return []
  const notes: string[] = []
  const use = otherUseOf(accelerator)
  if (use) notes.push(t(USE_NOTE[use]))
  if (id === 'newLittleArc' && surroundings.littleEverywhere) notes.push(t('settings-shortcuts.note-toutes-les-apps', { setting: quoted(t('settings.raccourci-de-la-mini-fenetre-dans-toutes-les-applications'), getLanguage()) }))
  const key = keyOffLayout(accelerator, surroundings.characters)
  if (key) notes.push(t('settings-shortcuts.note-disposition', { key: quoted(key, getLanguage()) }))
  // The second press of the command, which this row does not move: said here, where the first may be the one that cannot be typed.
  const second = secondAccelerator(id, bindings)
  if (second) notes.push(t('settings-shortcuts.note-second-raccourci', { keys: formatAccelerator(second) }))
  return notes
}
