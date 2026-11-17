// Names given to windows (Fenêtre › Nommer la fenêtre…). Pure rules: what a name may be, the entries the Window menu lists, and
// the windows the command bar offers to go to. The window manager keeps the names (shell/windows.ts) and windows.json remembers them.

import { t } from './i18n'

export const WINDOW_NAME_MAX = 60

/**
 * A name as the interface shows it: control and format characters (a stray newline, a zero-width or bidirectional mark that would
 * make a name read other than it is) become nothing or a space, runs of spaces become one, and it stops at `WINDOW_NAME_MAX`.
 * Undefined for anything that is not text, or that is empty once cleaned: such a window has no name.
 */
export function cleanWindowName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value
    .replace(/\p{Cf}/gu, '')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
  const cut = [...text].slice(0, WINDOW_NAME_MAX).join('').trim()
  return cut === '' ? undefined : cut
}

/**
 * The title of a window that carries no name: the title of the page it shows, cleaned the way a name is (so a page cannot dress its title with control
 * or direction marks, nor make it long), or `fallback` when the page has none. The system lists the windows of an application by this title.
 */
export function pageWindowTitle(pageTitle: string | undefined, fallback: string): string {
  return cleanWindowName(pageTitle) ?? fallback
}

/**
 * The title of a window that carries no name, from the tab it shows. The system hands this title to Mission Control, to the menu of the Dock and to
 * every application that lists the windows: a private tab gives it nothing, the window then carries `fallback`.
 */
export function tabWindowTitle(tab: { title: string; private?: boolean } | undefined, fallback: string): string {
  return tab === undefined || tab.private === true ? fallback : pageWindowTitle(tab.title, fallback)
}

/** A window another one can go to, as the snapshot tells the command bar: only named windows are offered. */
export interface NamedWindow {
  id: string
  name: string
}

/** A browser window as the Window menu lists it. */
export interface WindowEntry {
  id: string
  kind: 'main' | 'window' | 'private'
  /** A guest window (profil invité): private underneath, but not called that. */
  guest?: true
  /** Its name, when it has one. */
  name?: string
  /** Its place among the browser windows, from 1 (the order they were opened in). */
  position: number
  focused: boolean
}

/** What the menu writes for a window: its name, else a plain word that does not change while the pages inside it do. */
export function windowEntryLabel(entry: Pick<WindowEntry, 'name' | 'kind' | 'position' | 'guest'>): string {
  if (entry.name !== undefined) return entry.name
  if (entry.guest === true) return t('window-names.fenetre-invite')
  return entry.kind === 'private' ? t('menu.private-window-name') : t('menu.window-n', { position: entry.position })
}

/** The named windows the command bar of window `selfId` may go to: those with a name, never the window the bar is in. */
export function namedWindows(entries: readonly WindowEntry[], selfId: string): NamedWindow[] {
  return entries.flatMap((entry) => (entry.name !== undefined && entry.id !== selfId ? [{ id: entry.id, name: entry.name }] : []))
}

/** Everything about the windows' names the application menu draws: it is rebuilt only when this changes. */
export function windowNamesKey(entries: readonly WindowEntry[]): string {
  return JSON.stringify(entries.map((entry) => [entry.id, entry.name ?? null, entry.position, entry.focused]))
}
