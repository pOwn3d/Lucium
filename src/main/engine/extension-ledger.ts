import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { replaceFileDurably } from '../durable-write'
import { readTextBounded, SMALL_FILE_MAX_BYTES } from '../persist'

/**
 * The version each extension had the last time it was loaded in each profile, kept on disk. It is what tells a first load (the
 * extension is installed) from a later one (the browser started) and from a new version (it was updated): see `lifecycleEvents`.
 */
export class ExtensionLedger {
  private versions: Record<string, string> | null = null

  constructor(private readonly path: string) {}

  versionOf(profileId: string, extensionId: string): string | undefined {
    return this.load()[`${profileId}:${extensionId}`]
  }

  record(profileId: string, extensionId: string, version: string): void {
    this.set(`${profileId}:${extensionId}`, version)
  }

  /** An extension that was removed: if it comes back it is installed afresh (its worker is told so), not updated. */
  forget(profileId: string, extensionId: string): void {
    this.set(`${profileId}:${extensionId}`, undefined)
  }

  /** The id an unpacked extension had the last time its folder was loaded: what lets a profile skip it without loading it when it is switched off there. */
  idOfPath(path: string): string | undefined {
    return this.load()[`path:${path}`]
  }

  rememberPath(path: string, extensionId: string): void {
    this.set(`path:${path}`, extensionId)
  }

  /** What an extension chose of its static rulesets in a profile (which are enabled, which rules are switched off), as extension-net.ts wrote it. */
  netChoices(profileId: string, extensionId: string): string | undefined {
    return this.load()[`net:${profileId}:${extensionId}`]
  }

  keepNetChoices(profileId: string, extensionId: string, value: string | undefined): void {
    this.set(`net:${profileId}:${extensionId}`, value)
  }

  /** What the person granted an extension in a profile of the permissions its manifest lists as facultative, as optional-grants.ts wrote it. */
  optionalGrant(profileId: string, extensionId: string): string | undefined {
    return this.load()[`optional:${profileId}:${extensionId}`]
  }

  keepOptionalGrant(profileId: string, extensionId: string, value: string | undefined): void {
    this.set(`optional:${profileId}:${extensionId}`, value)
  }

  /** When the store extensions last looked for updates (ms since the epoch), if they ever did. */
  lastUpdateCheck(): number | undefined {
    const at = Number(this.load()['#update-check'])
    return Number.isFinite(at) && at > 0 ? at : undefined
  }

  recordUpdateCheck(at: number): void {
    this.set('#update-check', String(Math.round(at)))
  }

  private set(key: string, value: string | undefined): void {
    const versions = this.load()
    if (versions[key] === value) return
    if (value === undefined) delete versions[key]
    else versions[key] = value
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      // Written aside and moved in place, so that a crash cannot leave half a file that would read as "never loaded".
      replaceFileDurably(this.path, JSON.stringify(versions))
    } catch (error) {
      console.warn(`[engine] cannot save ${this.path}:`, (error as Error).message)
    }
  }

  private load(): Record<string, string> {
    if (this.versions) return this.versions
    try {
      const parsed: unknown = JSON.parse(readTextBounded(this.path, SMALL_FILE_MAX_BYTES))
      this.versions = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
    } catch (error) {
      // No file yet is the first launch; a file that cannot be read is worth a word, and starts the ledger afresh.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[engine] cannot read ${this.path}:`, (error as Error).message)
      this.versions = {}
    }
    return this.versions
  }
}
