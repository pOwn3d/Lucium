// Extensions written for Chromium-based browsers expect two things of their content scripts that this runtime does not give them:
//  1. `chrome.storage.sync`. That area is not there for a content script ("sync" is not available in this instance of Chrome), although the worker of the same
//     extension has a `chrome.storage.sync` that is the same store as `chrome.storage.local`. A content script that reads its settings from it gets nothing, and
//     stops (Merci: "Cannot read properties of undefined").
//  3. `document.execCommand('paste')`. An extension that holds "clipboardRead" expects its content scripts to paste into the page; Electron answers false and does nothing
//     (`queryCommandEnabled('paste')` is false, the permission `clipboard-read` is denied). MerciApp's "Remplacer" copies the new text to the clipboard and pastes it into
//     the message being written: nothing happened. The content script now asks, over a port the worker of the extension listens to (src/preload/extension-shims.ts), for
//     the main process to paste into the tab, which is what the extension expects.
//  2. `chrome.extension.inIncognitoContext`. Extensions expect every content script to have a `chrome.extension` with it; here `chrome.extension` is not there at all, and a script
//     that reads the flag stops before it has done anything (Vimium: "Cannot read properties of undefined (reading 'inIncognitoContext')", on every page).
// The fix is the one the worker already has: a few lines run first in the isolated world of the content scripts make `chrome.storage.sync` the local area and give
// `chrome.extension` its flag. They are put in the folder of an extension of the Web Store (never of a folder the user loaded by hand) as a file of ours, listed
// first in each content script entry of its manifest; the manifest as it was is kept next to it, and is what the manifest is made again from when it cannot be
// read any more. Only node:fs here, so that every rule can be tested against real files.

import { constants } from 'node:fs'
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeDurableFileAsync } from '../durable-write'

/** The file of ours, put in the extension's folder. */
export const PRELUDE_FILE = 'lucium-content-prelude.js'
/** The manifest as the store delivered it, kept once. */
export const MANIFEST_BACKUP = 'manifest.json.lucium-original'

/**
 * What runs first in the isolated world of an extension's content scripts. `chrome.extension` gets the flag extensions expect (no private windows here, so false).
 * `chrome.storage.sync` becomes the local area with the limits of the sync one (a script that reads `QUOTA_BYTES_PER_ITEM` finds it), calls bound to the local area
 * so that both the promise and the callback forms work. The two are independent: a failure of one leaves the other done.
 */
export const PRELUDE_SOURCE = `// Added by Lucium. See src/main/engine/content-prelude.ts.
(() => {
  try {
    if (!chrome.extension) Object.defineProperty(chrome, 'extension', { value: { inIncognitoContext: false }, configurable: true, enumerable: true, writable: true })
  } catch (error) {
    console.warn('[lucium] chrome.extension could not be set up for this content script:', error)
  }
  try {
    const granted = (chrome.runtime.getManifest().permissions || []).includes('clipboardRead')
    if (granted) {
      const nativeExecCommand = Document.prototype.execCommand
      const nativeEnabled = Document.prototype.queryCommandEnabled
      const nativeSupported = Document.prototype.queryCommandSupported
      const isPaste = (command) => String(command).toLowerCase() === 'paste'
      let port = null
      const askToPaste = () => {
        try {
          if (!port) {
            port = chrome.runtime.connect({ name: '__lucium-paste' })
            port.onDisconnect.addListener(() => { port = null })
          }
          port.postMessage({ type: 'paste' })
          return true
        } catch (error) {
          port = null
          console.warn('[lucium] a paste could not be asked for:', error)
          return false
        }
      }
      const define = (name, value) => Object.defineProperty(Document.prototype, name, { value, writable: true, configurable: true, enumerable: true })
      define('execCommand', function execCommand(command) {
        const done = nativeExecCommand.apply(this, arguments)
        // The browser's own command first: where it is allowed it is the one that runs, and nothing is pasted twice.
        if (done || !isPaste(command)) return done
        return askToPaste()
      })
      define('queryCommandEnabled', function queryCommandEnabled(command) { return isPaste(command) ? true : nativeEnabled.apply(this, arguments) })
      define('queryCommandSupported', function queryCommandSupported(command) { return isPaste(command) ? true : nativeSupported.apply(this, arguments) })
    }
  } catch (error) {
    console.warn('[lucium] the paste command could not be set up for this content script:', error)
  }
  try {
    const storage = chrome.storage
    const local = storage && storage.local
    if (!local) return
    const limits = { QUOTA_BYTES: 102400, QUOTA_BYTES_PER_ITEM: 8192, MAX_ITEMS: 512, MAX_WRITE_OPERATIONS_PER_HOUR: 1800, MAX_WRITE_OPERATIONS_PER_MINUTE: 120 }
    const sync = new Proxy(local, {
      get(target, key) {
        if (typeof key === 'string' && Object.hasOwn(limits, key)) return limits[key]
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    Object.defineProperty(storage, 'sync', { value: sync, configurable: true, enumerable: true, writable: true })
  } catch (error) {
    console.warn('[lucium] chrome.storage.sync could not be set up for this content script:', error)
  }
})()
`

/**
 * The manifest with the prelude first in the content scripts of the isolated world, or null when there is nothing to change: the extension has no such content
 * script, or its content scripts already start with it. A script of the page's own world (`"world": "MAIN"`) has no `chrome` at all; an entry without a list
 * of files (a CSS one) has nothing to run.
 */
export function withContentPrelude(manifest: unknown): Record<string, unknown> | null {
  if (typeof manifest !== 'object' || manifest === null) return null
  const record = manifest as Record<string, unknown>
  const scripts = record['content_scripts']
  if (!Array.isArray(scripts)) return null
  let changed = false
  const next = scripts.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return entry
    const script = entry as Record<string, unknown>
    const files = script['js']
    if (!Array.isArray(files) || files.length === 0 || script['world'] === 'MAIN' || files[0] === PRELUDE_FILE) return entry
    changed = true
    return { ...script, js: [PRELUDE_FILE, ...files] }
  })
  return changed ? { ...record, content_scripts: next } : null
}

/** Whether the manifest already lists the prelude: the folder was prepared, perhaps by an older version of the prelude. */
function listsPrelude(manifest: unknown): boolean {
  const scripts = typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>)['content_scripts'] : undefined
  return Array.isArray(scripts) && scripts.some((entry) => typeof entry === 'object' && entry !== null && Array.isArray((entry as Record<string, unknown>)['js']) && ((entry as Record<string, unknown>)['js'] as unknown[]).includes(PRELUDE_FILE))
}

/** A byte order mark is skipped by its code point, written out so that no editor can drop it. */
const parseManifest = (text: string): unknown => JSON.parse(text.replace(/^\uFEFF/, ''))

/**
 * Puts `text` in place of the manifest: written whole beside it, on the disk, then moved over it. A crash or a full disk in the middle leaves
 * the manifest as it was; written in place, it would leave half a manifest, and an extension that loads no more until it is installed again.
 */
async function replaceManifest(path: string, text: string): Promise<void> {
  const temporary = `${path}.lucium-tmp`
  try {
    await writeDurableFileAsync(temporary, text)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch((cleanup: unknown) => console.error(`[prelude] cannot remove ${temporary} after a failed write:`, cleanup))
    throw error
  }
}

/**
 * The manifest of the folder. One that is there and is not JSON (cut short by a crash of an older version, which wrote it in place) is made
 * again from the copy kept beside it, when there is one that can be read; the folder is named in the log. Otherwise the error goes up.
 */
async function readManifest(folder: string, manifestPath: string): Promise<unknown> {
  const text = await readFile(manifestPath, 'utf8')
  try {
    return parseManifest(text)
  } catch (error) {
    let kept: string
    let manifest: unknown
    try {
      kept = await readFile(join(folder, MANIFEST_BACKUP), 'utf8')
      manifest = parseManifest(kept)
    } catch {
      // No copy to go back to, or one that is no better: the failure to report is the manifest's own.
      throw error
    }
    if (typeof manifest !== 'object' || manifest === null) throw error
    console.warn(`[prelude] the manifest of ${folder} cannot be read (${error instanceof Error ? error.message : String(error)}); it is made again from ${MANIFEST_BACKUP}`)
    await replaceManifest(manifestPath, kept)
    return manifest
  }
}

/**
 * Puts the prelude in the folder of an extension and lists it in its manifest. The file goes first: a manifest never names a file that is not there. The
 * manifest as it was is copied before it is changed. A folder prepared by an older version of the prelude gets the file of today. Answers whether the folder
 * was changed; throws when it cannot be (the caller carries on without the prelude).
 */
export async function prepareContentPrelude(folder: string): Promise<boolean> {
  const manifestPath = join(folder, 'manifest.json')
  const manifest = await readManifest(folder, manifestPath)
  const patched = withContentPrelude(manifest)
  if (patched === null) {
    if (!listsPrelude(manifest)) return false
    const current = await readFile(join(folder, PRELUDE_FILE), 'utf8').catch(() => null)
    if (current === PRELUDE_SOURCE) return false
    await writeFile(join(folder, PRELUDE_FILE), PRELUDE_SOURCE, 'utf8')
    return true
  }
  await writeFile(join(folder, PRELUDE_FILE), PRELUDE_SOURCE, 'utf8')
  // A manifest that lists no prelude is the one the store delivered: it is the copy to keep, whatever file already has that name (one the
  // package brought with it would otherwise be what the manifest is made again from). Once the prelude is listed somewhere, the copy that
  // exists is the manifest of the store, and stays (the copy refuses to replace it; that refusal is the expected answer).
  await copyFile(manifestPath, join(folder, MANIFEST_BACKUP), listsPrelude(manifest) ? constants.COPYFILE_EXCL : 0).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  await replaceManifest(manifestPath, `${JSON.stringify(patched, null, 2)}\n`)
  return true
}

/** `prepareContentPrelude` for a load that must go on whatever happens: a failure is logged with the folder, and the extension loads as the store delivered it. */
export async function prepareContentPreludeSafely(folder: string): Promise<boolean> {
  try {
    return await prepareContentPrelude(folder)
  } catch (error) {
    console.error(`[prelude] cannot prepare the content scripts of ${folder}; it loads without:`, error)
    return false
  }
}
