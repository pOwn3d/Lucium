// Aide des raccourcis (⌘/): the sheet that lists the shortcuts worth knowing, by context, with a search and the ones the user changed marked.
// The source is the list of commands of keybindings.ts and the bindings in force (the defaults, or what Réglages › Raccourcis changed): the sheet keeps no
// list of keys of its own, so it cannot say a key that is no longer the one. What it adds is the choice (about thirty rows) and the contexts.

import { COMMANDS, canonicalAccelerator, effectiveAccelerator, formatAccelerator, secondAccelerator, type KeyBindings } from './keybindings'
import { matchesShortcut } from './shortcut-view'
import { commandPress, defaultAcceleratorFor, type PlatformId } from './platform'
import type { Settings } from './model'
import { t } from './i18n'
import { foldMarks } from './fold'

export type HelpContext = 'tabs' | 'spaces' | 'page' | 'window' | 'bar'

/** The contexts in the order the sheet draws them. */
export const HELP_CONTEXTS: readonly HelpContext[] = ['tabs', 'spaces', 'page', 'window', 'bar']

export function contextTitle(context: HelpContext): string {
  switch (context) {
    case 'tabs':
      return t('shortcut-help.onglets')
    case 'spaces':
      return t('shortcut-help.espaces')
    case 'page':
      return t('shortcut-help.page')
    case 'window':
      return t('shortcut-help.fenetre')
    case 'bar':
      return t('shortcut-help.barre-de-commande')
  }
}

/**
 * One row of the sheet. `command` is a command of keybindings.ts; a `range` is a family of nine commands shown as one row (⌘1 … ⌘9); a `pair` is two
 * commands that go together (zoom in, zoom out); a `typed` row is a key typed in the field of the bar, which is no command and cannot be changed.
 */
type Spec =
  | { kind: 'command'; id: string }
  | { kind: 'range'; first: string; last: string; label: () => string }
  | { kind: 'pair'; ids: readonly [string, string]; label: () => string }
  | { kind: 'typed'; keys: string | ((platform: PlatformId) => string); label: () => string; hint: () => string }

const command = (id: string): Spec => ({ kind: 'command', id })

/** The thirty or so shortcuts of the sheet. A command with no shortcut in force (none by default, or the user switched it off) is not listed: the sheet is a reminder of keys. */
const SHEET: Readonly<Record<HelpContext, readonly Spec[]>> = {
  tabs: [
    command('newTab'),
    command('closeTab'),
    command('restoreClosed'),
    command('pin'),
    command('recentTab'),
    command('recentTabBack'),
    command('nextTab'),
    command('previousTab'),
    command('tabSearch'),
    { kind: 'range', first: 'item1', last: 'item9', label: () => t('shortcut-help.aller-a-l-element-1-a-9') }
  ],
  spaces: [
    command('nextSpace'),
    command('previousSpace'),
    { kind: 'range', first: 'space1', last: 'space9', label: () => t('shortcut-help.aller-a-l-espace-1-a-9') },
    command('clearToday'),
    command('archive')
  ],
  page: [
    command('reload'),
    command('hardReload'),
    command('find'),
    command('back'),
    command('forward'),
    { kind: 'pair', ids: ['zoomIn', 'zoomOut'], label: () => t('shortcut-help.zoom-avant-arriere') },
    command('captureRegion'),
    command('copyUrl'),
    command('clearSiteData'),
    command('viewSource'),
    command('print'),
    // A note tied to the page on screen (⌥⌘E): the panel opens on it, the cursor in it.
    command('newNote')
  ],
  window: [command('toggleSidebar'), command('toggleToolbar'), command('newWindow'), command('privateWindow'), command('newLittleArc'), command('fullscreen')],
  bar: [
    command('openLocation'),
    { kind: 'typed', keys: '>', label: () => t('shortcut-help.commandes-seulement'), hint: () => t('shortcut-help.prefixe-tape-dans-le-champ') },
    { kind: 'typed', keys: '@', label: () => t('shortcut-help.onglets-seulement'), hint: () => t('shortcut-help.prefixe-tape-dans-le-champ') },
    { kind: 'typed', keys: (platform) => commandPress('↵', platform), label: () => t('shortcut-help.ouvrir-dans-un-nouvel-onglet'), hint: () => t('shortcut-help.sur-la-ligne-choisie') },
    command('history'),
    command('downloads'),
    command('settings'),
    command('shortcutHelp')
  ]
}

/** The setting behind a command that is a function of its own: with the setting off, the key does nothing, and the row says so. */
const DEPENDS_ON: Readonly<Record<string, keyof Settings>> = {
  tabSearch: 'tabSearch',
  shortcutHelp: 'shortcutHelp',
  recentTab: 'tabCycleRecent',
  recentTabBack: 'tabCycleRecent',
  newNote: 'notes'
}

export interface HelpRow {
  /** The command (or the first of a family, or the typed key). */
  id: string
  label: string
  /** The key caps, as drawn: `['⇧⌘T']`, `['⌘1', '…', '⌘9']`. */
  keys: string[]
  /** The key caps of the second press that runs the same command, drawn the same way; empty when it has none in force. */
  also: string[]
  /** The user gave it another key than the default. */
  custom: boolean
  /** The default key of a custom one, drawn, to be shown crossed out. */
  was: string | null
  /** A sentence under the label: what the key does when it depends on a setting that is off, or where a typed key is typed. */
  note: string | null
}

export interface HelpGroup {
  context: HelpContext
  title: string
  rows: HelpRow[]
}

export interface ShortcutHelp {
  groups: HelpGroup[]
  /** How many rows answer the search. */
  shown: number
  /** How many commands Réglages › Raccourcis lists: the sheet says where the others are. */
  total: number
}

const fold = foldMarks

/** The settings the sheet reads: the functions behind some of its keys. */
export type HelpSettings = Pick<Settings, 'tabSearch' | 'shortcutHelp' | 'tabCycleRecent' | 'notes'>

function rowOf(spec: Spec, bindings: KeyBindings | undefined, settings: HelpSettings, platform: PlatformId): { row: HelpRow; accelerators: string[] } | null {
  const drawn = (id: string): string | null => {
    const accelerator = effectiveAccelerator(id, bindings, platform)
    return accelerator ? formatAccelerator(accelerator, platform) : null
  }
  const customOf = (id: string): { custom: boolean; was: string | null } => {
    const own = bindings?.[id]
    const standard = defaultAcceleratorFor(platform, id, COMMANDS.find((c) => c.id === id)?.accelerator ?? '')
    // A binding equal to the default (spelled in another order of modifiers) is no change.
    const custom = own !== undefined && own !== '' && canonicalAccelerator(own) !== canonicalAccelerator(standard)
    return { custom, was: custom && standard ? formatAccelerator(standard, platform) : null }
  }
  const labelOf = (id: string): string => COMMANDS.find((c) => c.id === id)?.label ?? id
  /** The second presses of the commands of a row, drawn, when every one of them has one in force (a family shows both of its ends or none). */
  const alsoOf = (...ids: string[]): { also: string[]; seconds: string[] } => {
    const seconds = ids.flatMap((id) => secondAccelerator(id, bindings, platform) ?? [])
    return seconds.length === ids.length ? { also: seconds.map((second) => formatAccelerator(second, platform)), seconds } : { also: [], seconds: [] }
  }
  switch (spec.kind) {
    case 'command': {
      const keys = drawn(spec.id)
      if (!keys) return null
      const gate = DEPENDS_ON[spec.id]
      const off = gate !== undefined && settings[gate as keyof typeof settings] === false
      const accelerator = effectiveAccelerator(spec.id, bindings, platform)!
      const { also, seconds } = alsoOf(spec.id)
      return { row: { id: spec.id, label: labelOf(spec.id), keys: [keys], also, ...customOf(spec.id), note: off ? t('shortcut-help.fonction-coupee') : null }, accelerators: [accelerator, ...seconds] }
    }
    case 'range': {
      const first = drawn(spec.first)
      const last = drawn(spec.last)
      if (!first || !last) return null
      const { also, seconds } = alsoOf(spec.first, spec.last)
      return { row: { id: spec.first, label: spec.label(), keys: [first, '…', last], also: also.length > 0 ? [also[0]!, '…', also[1]!] : [], ...customOf(spec.first), note: null }, accelerators: [effectiveAccelerator(spec.first, bindings, platform)!, effectiveAccelerator(spec.last, bindings, platform)!, ...seconds] }
    }
    case 'pair': {
      const [a, b] = spec.ids
      const keys = [drawn(a), drawn(b)]
      if (keys.some((k) => !k)) return null
      const { also, seconds } = alsoOf(a, b)
      return { row: { id: a, label: spec.label(), keys: keys as string[], also, ...customOf(a), note: null }, accelerators: [effectiveAccelerator(a, bindings, platform)!, effectiveAccelerator(b, bindings, platform)!, ...seconds] }
    }
    case 'typed': {
      const keys = typeof spec.keys === 'function' ? spec.keys(platform) : spec.keys
      return { row: { id: `typed:${keys}`, label: spec.label(), keys: [keys], also: [], custom: false, was: null, note: spec.hint() }, accelerators: [] }
    }
  }
}

/** Whether a row answers the search: its label, its context, or its key (typed as "⌘T", "cmd t" or "commande t"). Nothing typed: every row. */
function answers(row: HelpRow, accelerators: readonly string[], context: HelpContext, query: string): boolean {
  const needle = fold(query.trim())
  if (!needle) return true
  return fold(row.label).includes(needle) || fold(contextTitle(context)).includes(needle) || [...row.keys, ...row.also].some((k) => fold(k).includes(needle)) || accelerators.some((a) => matchesShortcut(query, a))
}

/**
 * The sheet for the bindings in force. `bindings` are the user's changes (`settings.keyBindings`); `settings` tells which functions behind a key are
 * off. A context with no row left by the search is not returned.
 */
export function shortcutSheet(bindings: KeyBindings | undefined, settings: HelpSettings, platform: PlatformId, query = ''): ShortcutHelp {
  const groups: HelpGroup[] = []
  let shown = 0
  for (const context of HELP_CONTEXTS) {
    const rows = SHEET[context].flatMap((spec) => {
      const made = rowOf(spec, bindings, settings, platform)
      return made && answers(made.row, made.accelerators, context, query) ? [made.row] : []
    })
    if (rows.length === 0) continue
    shown += rows.length
    groups.push({ context, title: contextTitle(context), rows })
  }
  return { groups, shown, total: COMMANDS.length }
}
