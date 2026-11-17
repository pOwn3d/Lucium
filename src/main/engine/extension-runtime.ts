// The preload scripts that make extensions work are put in a session when an extension is first about to be loaded into it, not when the
// session is made: every script a session carries runs in the main frame of each of its pages, and most sessions never load an extension.
// There are three sets, registered in this order (the last one relies on running after the library's own, see the shims):
//   1. ours, the first pass of the shims (`before`),
//   2. the library's (electron-chrome-extensions registers two when it is set up on a session; they are taken out right after, and put back here),
//   3. ours again, the second pass (`after`).

import { existsSync } from 'node:fs'
import { sep } from 'node:path'
import type { PreloadScriptRegistration, PreloadTarget } from './switched-preload'

/** The part of Electron's `Session` this needs. */
export interface ScriptedSession extends PreloadTarget {
  getPreloadScripts(): Array<{ id: string; type: PreloadScriptRegistration['type']; filePath: string }>
}

/** The ids electron-chrome-extensions gives its two preload scripts (see `prependPreload` in its sources). */
export const LIBRARY_PRELOAD_IDS = ['crx-mv2-preload', 'crx-mv3-preload'] as const

/**
 * The documents the library's script of frames runs in: it gives the `chrome` APIs to the pages of extensions only (it checks
 * `location.href.startsWith('chrome-extension://')` first), so running it in every page of the session was 23 KB read for nothing.
 */
export const LIBRARY_FRAME_MATCHES: Readonly<Record<string, readonly string[]>> = { 'crx-mv2-preload': ['chrome-extension://*/*'] }

/**
 * The documents our own scripts of frames (the two passes of the shims) run in: the pages of extensions, the only ones where they do anything
 * (they return at once anywhere else). Registered for every document, the script was read and compiled twice in each web page of a session
 * that has an extension, before the first script of the page.
 */
export const EXTENSION_FRAME_MATCHES: readonly string[] = ['chrome-extension://*/*']

/**
 * Registers a script limited to some documents (`matches`). A build of Electron that refuses the limit gets the script for every document, as
 * it always had it, and `refused` is told why. A script without a limit, or one that cannot be registered at all, throws as Electron does.
 */
export function registerLimitedPreload(session: PreloadTarget, script: PreloadScriptRegistration, refused: (error: unknown) => void): void {
  try {
    session.registerPreloadScript(script)
  } catch (error) {
    if (!script.matches) throw error
    const { matches: _limited, ...everywhere } = script
    session.registerPreloadScript(everywhere)
    refused(error)
  }
}

/**
 * Where Chromium can read a preload of the packaged application: it reads the preloads of service workers (and of frames) from disk and
 * cannot see into app.asar, so a script the build unpacked (electron-builder.yml, `asarUnpack`) is registered from app.asar.unpacked.
 * The library resolves its own script inside app.asar. A script that was not unpacked keeps the path it had: registering a file that does
 * not exist would take the extension APIs away from the frames as well.
 */
export function readablePreloadPath(filePath: string, exists: (path: string) => boolean = existsSync): string {
  const inside = `${sep}app.asar${sep}`
  if (!filePath.includes(inside)) return filePath
  const unpacked = filePath.replace(inside, `${sep}app.asar.unpacked${sep}`)
  return exists(unpacked) ? unpacked : filePath
}

export class ExtensionPreloads {
  private held: PreloadScriptRegistration[] = []
  private started = false

  constructor(
    private readonly session: ScriptedSession,
    private readonly steps: { before: () => void; after: () => void },
    private readonly label: string,
    private readonly report: (message: string, error: unknown) => void = (message, error) => console.error(message, error)
  ) {}

  /** Whether the scripts are in the session (an extension is being or has been loaded there). */
  get active(): boolean {
    return this.started
  }

  /**
   * Called right after the library was set up on the session: takes its scripts out of it and keeps them for `activate`.
   * Returns the ids it did not find (a library that no longer registers them under those names): those it never held stay registered.
   */
  holdLibrary(ids: readonly string[] = LIBRARY_PRELOAD_IDS): string[] {
    const present = this.session.getPreloadScripts()
    const missing: string[] = []
    for (const id of ids) {
      const script = present.find((s) => s.id === id)
      if (!script) {
        missing.push(id)
        continue
      }
      try {
        this.session.unregisterPreloadScript(id)
      } catch (error) {
        // It stays registered, as it always was: the session loads it for every page, which is the cost this avoids, not a failure.
        this.report(`[extensions] the library script ${id} could not be taken out of ${this.label}; it stays there:`, error)
        missing.push(id)
        continue
      }
      const matches = script.type === 'frame' ? LIBRARY_FRAME_MATCHES[id] : undefined
      this.held.push({ id: script.id, type: script.type, filePath: readablePreloadPath(script.filePath), ...(matches ? { matches: [...matches] } : {}) })
    }
    return missing
  }

  /**
   * An extension is about to be loaded in the session: its scripts go in, once. A script that cannot be registered is reported and the
   * others still go in (an extension that half works is better told than one that does not load at all).
   */
  activate(): void {
    if (this.started) return
    this.started = true
    const attempt = (what: string, run: () => void): void => {
      try {
        run()
      } catch (error) {
        this.report(`[extensions] ${what} could not be put in ${this.label}; extensions may not work there:`, error)
      }
    }
    attempt('the first pass of the shims', this.steps.before)
    for (const script of this.held.splice(0)) attempt(`the library script ${script.id}`, () => this.register(script))
    attempt('the second pass of the shims', this.steps.after)
  }

  /** A build of Electron that refuses the documents a script is limited to gets the script for every document, as it always had it. */
  private register(script: PreloadScriptRegistration): void {
    // When it cannot be registered at all, the caller says so once, with the error of the second try.
    registerLimitedPreload(this.session, script, (error) =>
      this.report(`[extensions] the library script ${script.id} could not be limited to the pages of extensions in ${this.label}; it runs in every page, as before:`, error)
    )
  }
}
