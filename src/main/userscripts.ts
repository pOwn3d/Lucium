// The user scripts the user imported: one file in the data folder, read the first time something asks for it (never at startup, never
// while the manager is switched off). The text of a script is the only thing kept about it: its name, patterns and timing are read from it
// again every time, so that what the user read, what is saved and what runs cannot differ. The scripts belong to the person, not to a
// profile: they are not in the profile data that is erased, nor in the exported state.

import { closeSync, copyFileSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { basename } from 'node:path'
import {
  USER_SCRIPTS_MAX,
  USER_SCRIPT_MAX_BYTES,
  cleanUserScripts,
  newUserScriptId,
  parseUserScript,
  sameScript,
  storedForm,
  userScriptMatches,
  type UserScript,
  type UserScriptView
} from '@shared/userscript'
import { pruneSideFiles, readTextBounded, setAsideOrHold, sideFiles, writeFileAtomic } from './persist'
import { t } from '@shared/i18n'

/** The file is bounded: a hundred scripts of the largest size, and some room for the structure. */
export const USER_SCRIPTS_FILE_MAX_BYTES = USER_SCRIPTS_MAX * (USER_SCRIPT_MAX_BYTES + 400) + 10_000

export type AddOutcome = { ok: true; id: string; replaced: boolean; warnings: string[] } | { ok: false; error: string }

/** Whether two files hold the same bytes; false when either cannot be read. */
function sameContent(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

export class UserScripts {
  private scripts: UserScript[] = []
  private loaded = false
  /** The last failure of each script in a page, kept in memory: the list shows it, and it goes with the application. */
  private readonly failures = new Map<string, { message: string; at: number }>()

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now
  ) {}

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.path)) return
    try {
      // A regular file of a believable size, looked at before it is opened: a pipe or a device under that name would hold the application for ever.
      const { scripts, dropped } = cleanUserScripts(JSON.parse(readTextBounded(this.path, USER_SCRIPTS_FILE_MAX_BYTES)))
      this.scripts = scripts
      if (dropped > 0) this.keepDropped(dropped)
    } catch (error) {
      setAsideOrHold(this.path, error, 'userscripts')
      this.scripts = []
    }
  }

  /**
   * Scripts the file held that Lucium no longer accepts would vanish with the next write: a copy of the file is kept first. The same file read
   * again at the next launch (nothing was saved in between) is not copied again, and only the three most recent copies are kept.
   */
  private keepDropped(dropped: number): void {
    const copy = `${this.path}.dropped-${this.now()}`
    try {
      const newest = sideFiles(this.path, 'dropped')[0]
      if (newest !== undefined && sameContent(newest, this.path)) return
      copyFileSync(this.path, copy)
      pruneSideFiles(this.path, 'dropped')
      console.error(`[userscripts] ${dropped} script(s) of ${basename(this.path)} are not valid scripts any more and were left out; the file as it was is kept in ${basename(copy)}`)
    } catch (error) {
      console.error(`[userscripts] ${dropped} script(s) of ${basename(this.path)} were left out and the file could not be copied first (${String(error)}); they are lost at the next save`)
    }
  }

  /** Writes the scripts; throws with a sentence when the disk refuses, and the caller keeps what it had. */
  private save(next: UserScript[]): void {
    try {
      writeFileAtomic(this.path, JSON.stringify({ version: 1, scripts: next.map(storedForm) }))
    } catch (error) {
      console.error(`[userscripts] cannot write ${this.path}:`, error)
      throw new Error(t('userscripts.les-scripts-n-ont-pas-pu-etre-enregistres-reason', { reason: (error as Error).message ?? String(error) }))
    }
    this.scripts = next
  }

  /** The scripts without their code, for the list in Settings. */
  list(): UserScriptView[] {
    this.load()
    return this.scripts.map((script) => {
      const parsed = parseUserScript(script.source)
      const failure = this.failures.get(script.id)
      return {
        id: script.id,
        name: script.name,
        ...(script.namespace ? { namespace: script.namespace } : {}),
        ...(script.version ? { version: script.version } : {}),
        ...(script.description ? { description: script.description } : {}),
        matches: script.matches,
        excludes: script.excludes,
        runAt: script.runAt,
        enabled: script.enabled,
        allowPrivate: script.allowPrivate,
        importedAt: script.importedAt,
        bytes: new TextEncoder().encode(script.source).length,
        warnings: parsed.ok ? parsed.warnings : [],
        ...(failure ? { lastError: failure } : {})
      }
    })
  }

  sourceOf(id: string): string | undefined {
    this.load()
    return this.scripts.find((script) => script.id === id)?.source
  }

  /**
   * Adds a script, switched off. The same script (namespace and name) imported again replaces the earlier one, keeps its place and its
   * id, and is switched off again: the code is another code, to be read again before it runs.
   */
  add(text: unknown): AddOutcome {
    this.load()
    const parsed = parseUserScript(text)
    if (!parsed.ok) return parsed
    const same = this.scripts.find((script) => sameScript(script, parsed.meta))
    if (!same && this.scripts.length >= USER_SCRIPTS_MAX) return { ok: false, error: t('userscripts.deja-user-scripts-max-scripts-retirez-en-un', { USER_SCRIPTS_MAX }) }
    const taken = new Set(this.scripts.map((script) => script.id))
    let id = same?.id ?? newUserScriptId()
    while (!same && taken.has(id)) id = newUserScriptId()
    const added: UserScript = { ...parsed.meta, id, source: text as string, enabled: false, allowPrivate: false, importedAt: this.now() }
    try {
      this.save(same ? this.scripts.map((script) => (script.id === same.id ? added : script)) : [...this.scripts, added])
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
    this.failures.delete(id)
    return { ok: true, id, replaced: same !== undefined, warnings: parsed.warnings }
  }

  /** Turns a script on or off. Answers the reason it could not, or null. */
  setEnabled(id: string, enabled: boolean): string | null {
    return this.change(id, (script) => ({ ...script, enabled }))
  }

  setAllowPrivate(id: string, allowPrivate: boolean): string | null {
    return this.change(id, (script) => ({ ...script, allowPrivate }))
  }

  remove(id: string): string | null {
    this.load()
    if (!this.scripts.some((script) => script.id === id)) return t('userscripts.ce-script-n-existe-plus')
    try {
      this.save(this.scripts.filter((script) => script.id !== id))
    } catch (error) {
      return (error as Error).message
    }
    this.failures.delete(id)
    return null
  }

  private change(id: string, edit: (script: UserScript) => UserScript): string | null {
    this.load()
    if (!this.scripts.some((script) => script.id === id)) return t('userscripts.ce-script-n-existe-plus')
    try {
      this.save(this.scripts.map((script) => (script.id === id ? edit(script) : script)))
    } catch (error) {
      return (error as Error).message
    }
    return null
  }

  /** The scripts to run in a page, in the order they were added. */
  matching(url: string, inPrivateWindow: boolean): UserScript[] {
    this.load()
    return this.scripts.filter((script) => userScriptMatches(script, url, inPrivateWindow))
  }

  /** A script failed in a page: the list shows it, the log keeps it. */
  recordFailure(id: string, message: string): void {
    this.failures.set(id, { message: message.slice(0, 300), at: this.now() })
  }
}

/** The text of a file the user picked, read without ever holding more than a script can be; null when it is bigger. */
export function readScriptFile(path: string): string | null {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(USER_SCRIPT_MAX_BYTES + 1)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return read > USER_SCRIPT_MAX_BYTES ? null : buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

let current: UserScripts | null = null
let configuredPath: string | null = null

/** Where the file is. Only a path is kept: nothing is read, and no object is made, until a script is asked for. */
export function configureUserScripts(path: string): void {
  configuredPath = path
  current = null
}

/** The scripts of the running application (made when first asked for). */
export function userScripts(): UserScripts {
  if (current) return current
  if (configuredPath === null) throw new Error('The user scripts have no file: configureUserScripts was not called')
  current = new UserScripts(configuredPath)
  return current
}
