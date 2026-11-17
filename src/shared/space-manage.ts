// "Gérer les espaces": the rows, the counts in the subtitle, the moves by drag and by key, and what archiving and deleting mean.
//
// "Archiver" is the space put aside (Espaces › Mettre l'espace de côté…): the space leaves the sidebar with its tabs, its theme and its settings, kept as a
// session, and "Restaurer" is `space/reopen`, which gives it back at its place. So the "Archivés" section is the sessions that hold a space. Deleting closes
// the tabs for good; the panel makes it wait a few seconds (the undo queue) so that it can be taken back.

import type { AsideSpace, SidebarState, Space } from './model'
import { profileLabel } from './profiles'
import { asideRefusal } from './sessions'
import { spaceGlyph } from './space-icon'
import { ACTION_NOTICE_MS } from './toast'

/** How long "Annuler" stays after an archive or a deletion: the time of every notice with an action. */
export const SPACE_UNDO_MS = ACTION_NOTICE_MS

export interface ManagedSpace {
  id: string
  name: string
  /** The icon in plain text (the emoji, or the letters); the row draws the real icon from `space`. */
  glyph: string
  space: Space
  profile: string
  tabs: number
  current: boolean
}

export interface ArchivedSpace {
  /** The session that holds it: "Restaurer" and the permanent deletion go by this. */
  sessionId: string
  name: string
  glyph: string
  space: Space
  profile: string
  tabs: number
}

/**
 * The tabs a space holds in every window, as the snapshot gives them with windows of their own (`UiSnapshot.spaceTabs`); absent, the window lists
 * every tab and counts them itself.
 */
export type TabsOfEverySpace = Readonly<Record<string, number>> | undefined

const tabsOf = (state: SidebarState, everyWindow: TabsOfEverySpace, spaceId: string): number => everyWindow?.[spaceId] ?? state.tabs.filter((tab) => tab.spaceId === spaceId).length

/** The rows, each with the tabs of the space in every window: deleting it or putting it aside closes them all. */
export function managedSpaces(state: SidebarState, everyWindow?: TabsOfEverySpace): ManagedSpace[] {
  return state.spaces.map((space) => ({
    id: space.id,
    name: space.name,
    glyph: spaceGlyph(space),
    space,
    profile: profileLabel(state.settings, space.profileId),
    tabs: tabsOf(state, everyWindow, space.id),
    current: space.id === state.activeSpaceId
  }))
}

export function archivedSpaces(state: SidebarState): ArchivedSpace[] {
  const out: ArchivedSpace[] = []
  for (const session of state.sessions) {
    const aside: AsideSpace | undefined = session.space
    if (!aside) continue
    out.push({ sessionId: session.id, name: aside.space.name, glyph: spaceGlyph(aside.space), space: aside.space, profile: profileLabel(state.settings, aside.space.profileId), tabs: aside.tabs.length })
  }
  return out
}

/** The session `space/aside` has just made for a space (it goes first): what "Annuler" reopens. Null when the space was not put aside. */
export const asideSessionOf = (state: SidebarState, spaceId: string): string | null => state.sessions.find((session) => session.space?.space.id === spaceId)?.id ?? null

export interface ManageCounts {
  spaces: number
  tabs: number
  archived: number
}

/** The numbers of the subtitle: spaces and their tabs (those waiting to be deleted do not count), and the archived ones. */
export function manageCounts(state: SidebarState, hidden: ReadonlySet<string> = new Set(), everyWindow?: TabsOfEverySpace): ManageCounts {
  const shown = state.spaces.filter((space) => !hidden.has(space.id))
  return { spaces: shown.length, tabs: shown.reduce((sum, space) => sum + tabsOf(state, everyWindow, space.id), 0), archived: archivedSpaces(state).length }
}

/**
 * The `toIndex` of `space/move` for a drop of a row on another: the dragged space takes the place of the one it is dropped on. Null when nothing moves
 * (the same row, or one that is not there).
 */
export function dropIndex(spaces: readonly Pick<Space, 'id'>[], draggedId: string, overId: string): number | null {
  const from = spaces.findIndex((space) => space.id === draggedId)
  const to = spaces.findIndex((space) => space.id === overId)
  return from < 0 || to < 0 || from === to ? null : to
}

/** The `toIndex` of `space/move` for ⌥↑ (-1) and ⌥↓ (+1). Null at either end, where there is nowhere to go. */
export function stepIndex(spaces: readonly Pick<Space, 'id'>[], id: string, step: -1 | 1): number | null {
  const from = spaces.findIndex((space) => space.id === id)
  const to = from + step
  return from < 0 || to < 0 || to >= spaces.length ? null : to
}

/** The spaces that are left once the ones waiting to be deleted are gone: the last one cannot be deleted, archived or put aside. */
export const spacesLeft = (state: SidebarState, hidden: ReadonlySet<string>): number => state.spaces.filter((space) => !hidden.has(space.id)).length

/** Whether a space can be deleted now: not the last one that is left (the reducer refuses too, but a row that waits for its deletion no longer counts). */
export const canDeleteSpace = (state: SidebarState, hidden: ReadonlySet<string>, id: string): boolean => state.spaces.some((space) => space.id === id) && spacesLeft(state, hidden) > 1

/**
 * Why a space cannot be archived now, as a sentence for the button, or null when it can. The reasons of putting a space aside apply (a limit of sessions,
 * of tabs), and so does the last space that is left once the deletions that wait are made: archiving it would leave nothing to show.
 */
export function archiveRefusal(state: SidebarState, hidden: ReadonlySet<string>, id: string): string | null {
  const refusal = asideRefusal(state, id)
  if (refusal !== null) return refusal
  return spacesLeft(state, hidden) > 1 ? null : asideRefusal({ ...state, spaces: state.spaces.filter((space) => space.id === id) }, id)
}
