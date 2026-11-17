// The favourites of the sidebar belong to a profile: the spaces of one profile list the same favourites, the spaces of another profile list
// its own. Changing one (adding, renaming, replacing its page, moving, removing) never shows in a window on a space of another profile. Pure rules,
// shared by the reducer (sidebar.ts), the drag and drop (dnd.ts), the sidebar and the menus.
//
// The page a favourite opens stays a tab of one space (`TabItem.favoriteId`): a space is of one profile, so a page never uses the cookies of
// another profile's favourite (`pruneFavoriteTabs` cuts the link when the two disagree).

import type { Favorite, SidebarState, Space, TabItem } from './model'
import { isProfileId, knownProfiles, profileOfSpace } from './profiles'

/** The profile of a space that names none, and of a favourite that has not been through `normalize` yet. */
export const DEFAULT_PROFILE = 'default'

/** The profile a favourite is listed in. */
export const favoriteProfile = (favorite: Pick<Favorite, 'profileId'>): string => favorite.profileId ?? DEFAULT_PROFILE

/** The favourites of one profile, in the order the sidebar shows them. */
export const favoritesOf = (state: Pick<SidebarState, 'favorites'>, profileId: string): Favorite[] => state.favorites.filter((f) => favoriteProfile(f) === profileId)

/** The favourites a space shows: those of its profile. */
export const favoritesOfSpace = (state: Pick<SidebarState, 'favorites' | 'spaces'>, spaceId: string): Favorite[] =>
  favoritesOf(state, state.spaces.find((s) => s.id === spaceId)?.profileId ?? DEFAULT_PROFILE)

/**
 * The list with `favorite` put at `index` of its profile's favourites (counted without it; clamped), whether it was in the list or is new. The other
 * profiles' favourites keep their places: the list is one array, but each profile reads its own slice of it.
 */
export function withFavoriteAt(all: readonly Favorite[], favorite: Favorite, index: number): Favorite[] {
  const profile = favoriteProfile(favorite)
  const rest = all.filter((f) => f.id !== favorite.id)
  const mine = rest.filter((f) => favoriteProfile(f) === profile)
  const at = Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : mine.length, mine.length))
  const pivot = mine[at]
  const last = mine[mine.length - 1]
  const slot = pivot ? rest.indexOf(pivot) : last ? rest.indexOf(last) + 1 : rest.length
  return [...rest.slice(0, slot), favorite, ...rest.slice(slot)]
}

/** The list with the favourites of `profileId` in the order `order` gives, each in the slot of the one it replaces; the other profiles' are untouched. */
export function withProfileOrder(all: readonly Favorite[], profileId: string, order: readonly Favorite[]): Favorite[] {
  const queue = [...order]
  return all.map((f) => (favoriteProfile(f) === profileId ? (queue.shift() ?? f) : f))
}

/**
 * What an import brings of the favourites, ready to be merged: each one has a profile (its own when it names one, else the one of the first space the
 * import adds, else the one the user is in) and is kept once per address in that profile, whether the state or an earlier incoming one has it.
 * The reducer (`import/merge`) and the importers' accounting of what to take back both read it, so that they never disagree.
 */
export function importedFavorites(state: SidebarState, incoming: readonly Favorite[], newSpaces: readonly Pick<Space, 'profileId'>[]): Favorite[] {
  const fallback = newSpaces.find((s) => isProfileId(s.profileId))?.profileId ?? profileOfSpace(state, state.activeSpaceId)
  const taken = new Set(state.favorites.map((f) => `${favoriteProfile(f)} ${f.url}`))
  const ids = new Set(state.favorites.map((f) => f.id))
  const out: Favorite[] = []
  for (const f of incoming) {
    const profileId = isProfileId(f.profileId) ? f.profileId : fallback
    const key = `${profileId} ${f.url}`
    if (taken.has(key) || ids.has(f.id)) continue
    taken.add(key)
    ids.add(f.id)
    out.push({ ...f, profileId })
  }
  return out
}

/**
 * Gives every favourite a profile. A file from before the favourites were kept per profile has them all in one list, shown by every space: so as not to
 * lose or hide any, each profile the spaces use gets its own copy (the first keeps the id, the others a derived one, and the page a favourite has in a
 * space of another profile follows to that profile's copy). With one profile in use nothing is copied, the favourites are only marked as its own.
 * Afterwards they are independent: the copies are ordinary favourites. Given its own output it hands back the same lists.
 */
export function scopeFavorites(favorites: Favorite[], tabs: TabItem[], spaces: readonly Pick<Space, 'id' | 'profileId'>[]): { favorites: Favorite[]; tabs: TabItem[] } {
  if (favorites.every((f) => f.profileId !== undefined)) return { favorites, tabs }
  const profiles = [...new Set(spaces.map((s) => s.profileId))]
  if (profiles.length === 0) profiles.push(DEFAULT_PROFILE)
  const home = profiles[0]!
  const taken = new Set(favorites.map((f) => f.id))
  const copyId = (id: string, profileId: string): string => {
    let candidate = `${id}.${profileId}`
    while (taken.has(candidate)) candidate += '_'
    taken.add(candidate)
    return candidate
  }
  /** The copy of a legacy favourite made for each other profile, by the legacy id. */
  const copies = new Map<string, Map<string, string>>()
  const out: Favorite[] = []
  for (const f of favorites) {
    if (f.profileId !== undefined) {
      out.push(f)
      continue
    }
    out.push({ ...f, profileId: home })
    const made = new Map<string, string>()
    for (const profileId of profiles.slice(1)) {
      const id = copyId(f.id, profileId)
      made.set(profileId, id)
      out.push({ ...f, id, profileId })
    }
    copies.set(f.id, made)
  }
  const profileOf = new Map(spaces.map((s) => [s.id, s.profileId]))
  let moved = false
  const followed = tabs.map((tab) => {
    const made = tab.favoriteId === undefined ? undefined : copies.get(tab.favoriteId)
    const id = made?.get(profileOf.get(tab.spaceId) ?? home)
    if (id === undefined) return tab
    moved = true
    return { ...tab, favoriteId: id }
  })
  return { favorites: out, tabs: moved ? followed : tabs }
}

/**
 * The favourites of a profile that no longer exists are gone with it: removing a profile (Réglages › Profils) erases its data and its name, and a list
 * of favourites that nothing can show, rename or remove would stay in the file for ever, and come back under a new profile that takes the same id.
 * A profile exists while a space (even one put aside) uses it, it has a name or settings of its own, or it is the default one. Same object when
 * nothing goes; the quick test (the profiles of the spaces) answers for every state that has no such favourite, before the rest is built.
 */
export function pruneFavoriteProfiles(state: SidebarState): SidebarState {
  if (state.favorites.length === 0) return state
  const quick = new Set([DEFAULT_PROFILE, ...state.spaces.map((s) => s.profileId), ...Object.keys(state.settings.profileNames), ...Object.keys(state.settings.profiles)])
  if (state.favorites.every((f) => quick.has(favoriteProfile(f)))) return state
  const known = new Set(knownProfiles(state))
  const favorites = state.favorites.filter((f) => known.has(favoriteProfile(f)))
  return favorites.length === state.favorites.length ? state : { ...state, favorites }
}
