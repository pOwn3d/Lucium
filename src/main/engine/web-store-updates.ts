// The updates that electron-chrome-web-store finds on a check (the schedule, or "Rechercher des mises à jour") are applied by the library
// itself: for each one it downloads the new version next to the installed one, then calls `removeExtension` and `loadExtension` on the
// session it was given, and removes the old folder once the load returned. Left to that, an update loads without the content prelude
// (content-prelude.ts: `chrome.storage.sync` and the rest are gone for its content scripts until the next launch), and a new version that
// does not load leaves the profile with no version at all. The library is therefore handed this instead of the session's extensions: the
// installed version stays loaded until the new one is ready, the prelude is written into the new folder first, and a version that does not
// load gives its place back to the installed one, as the user's own update does (web-store.ts, `reviewUpdate`). The failure goes back to
// the library, which then keeps the installed folder.

import { rm } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'

/** What the updater reads of a loaded extension (Electron's `Extension` has more; no Electron here, see engine-port.test.ts). */
export interface LoadedExtension {
  id: string
  path: string
}

/** The part of `session.extensions` the library's updater calls (see `updateExtension` in its sources). */
export interface UpdaterExtensions {
  getAllExtensions(): LoadedExtension[]
  getExtension(extensionId: string): LoadedExtension | null
  removeExtension(extensionId: string): void
  loadExtension(path: string): Promise<LoadedExtension>
}

export interface UpdateSteps {
  /** Before the new version loads: its content prelude goes into its folder, and the scripts extensions need into the session. */
  prepare(path: string): Promise<void>
  /** The installed version leaves the session (the engine's own unload). */
  unload(extensionId: string): void
  /** The new version did not load; `restored` says whether the installed one is back. */
  failed(extensionId: string, error: unknown, restored: boolean): void
}

/**
 * What the library is given as the session of a check. `root` is the profile's folder of the store: the folder of a version that did not
 * load is removed only from there.
 */
export function updaterSession(extensions: UpdaterExtensions, steps: UpdateSteps, root: string): { extensions: UpdaterExtensions } {
  // The installed version of each extension the library is about to replace, by id: it is taken out only when the new one is ready.
  const leaving = new Map<string, string>()
  const inside = `${resolve(root)}${sep}`
  return {
    extensions: {
      getAllExtensions: () => extensions.getAllExtensions(),
      getExtension: (extensionId) => extensions.getExtension(extensionId),
      removeExtension: (extensionId) => {
        const installed = extensions.getExtension(extensionId)
        if (installed) leaving.set(extensionId, installed.path)
      },
      loadExtension: async (path) => {
        // The library downloads into `<profile folder>/<id>/<version>_0`.
        const extensionId = basename(dirname(path))
        const previous = leaving.get(extensionId)
        leaving.delete(extensionId)
        // A version that is not used does not stay on disk next to the installed one.
        const discard = async (): Promise<void> => {
          if (!resolve(path).startsWith(inside)) return
          await rm(path, { recursive: true, force: true }).catch((cleanup: unknown) => console.warn(`[webstore] cannot remove the update of ${extensionId} that did not load (${path}):`, cleanup))
        }
        try {
          await steps.prepare(path)
        } catch (error) {
          // Nothing was taken out yet: the installed version goes on running.
          await discard()
          steps.failed(extensionId, error, true)
          throw error
        }
        steps.unload(extensionId)
        try {
          return await extensions.loadExtension(path)
        } catch (error) {
          let restored = false
          if (previous !== undefined) {
            try {
              await extensions.loadExtension(previous)
              restored = true
            } catch (again) {
              console.error(`[webstore] the installed version of ${extensionId} could not be loaded again either:`, again)
            }
          }
          await discard()
          steps.failed(extensionId, error, restored)
          throw error
        }
      }
    }
  }
}
