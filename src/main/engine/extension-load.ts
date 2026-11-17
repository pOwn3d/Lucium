// The one check every load of an extension folder goes through before the engine is handed the folder. Without Electron, so that it is tested.

import { manifestListsTooLong } from '@shared/chrome-compat'
import { ManifestRefusal, manifestTooLongMessage } from '@shared/extension-page'

export interface CheckedLoad<T> {
  /** The manifest of the folder, parsed; null when it cannot be read (the engine then says why itself). */
  readManifest(folder: string): unknown
  load(folder: string): Promise<T>
}

/**
 * Loads a folder unless its manifest lists more than every reader of a manifest agrees to read. The rules that grant stop at that bound, but the
 * engine applies the whole manifest (its content scripts, its sites): past the bound, an extension would act where nothing showed it could.
 * A package of the Web Store is refused for the same reason before it is installed; a folder chosen by hand, or listed in the settings, is refused here.
 */
export async function loadChecked<T>(folder: string, how: CheckedLoad<T>): Promise<T> {
  if (manifestListsTooLong(how.readManifest(folder))) throw new ManifestRefusal(manifestTooLongMessage())
  return how.load(folder)
}
