// What the sweep of the pictures of spaces and tabs keeps beyond what the state names: the pictures the automatic copies of the session name, and
// those named by the copies of the state made before Help › Restore Data (`state.json.avant-restauration-*`). Putting one of those back must bring
// its pictures back with it. No Electron here: the data folder is handed in, so that the rules can be tested against real files.

import type { SidebarState } from '@shared/model'
import { isSpaceImageName, referencedImages } from '@shared/space-image'
import { copiesBeforeRestore, readSessionCopies } from './background-media-sweep'
import type { SpaceImageStore } from './space-images'

/** A name of our own form anywhere in a text: the copies made before a restoration are whole state files, searched and not parsed. */
const IMAGE_NAMES = /[0-9a-f]{24}\.png/g

/**
 * The pictures the copies name. Null when a copy of the state made before a restoration cannot be read: what it names is unknown, so nothing may be
 * deleted. An automatic copy that cannot be read is skipped with a line in the journal: it cannot be restored either.
 */
export function imagesNamedByCopies(userDataPath: string): Set<string> | null {
  const names = new Set<string>()
  for (const copy of readSessionCopies(userDataPath, { tag: '[space image]', what: 'pictures' })) {
    for (const space of copy.spaces) if (isSpaceImageName(space.image)) names.add(space.image)
    for (const tab of copy.tabs) if (isSpaceImageName(tab.image)) names.add(tab.image)
  }
  for (const text of copiesBeforeRestore(userDataPath, { tag: '[space image]', kept: 'no picture is deleted' })) {
    if (text === null) return null
    for (const name of text.match(IMAGE_NAMES) ?? []) names.add(name)
  }
  return names
}

/**
 * Deletes the stored pictures that neither the state nor a copy names. The copies are read only when a picture would go: most sweeps find
 * nothing to delete and never open them. Answers how many files went.
 */
export function sweepStoredImages(store: Pick<SpaceImageStore, 'sweep'>, state: Pick<SidebarState, 'spaces' | 'sessions' | 'tabs'>, userDataPath: string): number {
  return store.sweep(referencedImages(state), () => imagesNamedByCopies(userDataPath))
}
