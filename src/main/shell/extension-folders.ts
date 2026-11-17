// The folders of Settings › Extensions (`extensionPaths`) and the extensions that run: the list says which folders are loaded, and the engine follows
// it whatever changed it (the « Retirer » of Settings, the Extensions page, a folder chosen in the dialog). A folder that leaves the list is taken
// out of every profile the way the Extensions page's « Retirer » does it (the engine's `removeFolderAt`: the files and the extension's data stay);
// a folder that comes back is loaded when no profile knows it yet. The engine and the boxes come in through `env`, so that it is tested without Electron.

import { basename } from 'node:path'
import { describeLoadError } from '@shared/extension-page'
import { cleanText } from '@shared/extension-review'
import { t } from '@shared/i18n'
import type { Engine } from '../engine/types'

export interface ExtensionFoldersEnv {
  engine: Pick<Engine, 'listAllExtensions' | 'extensionTools'>
  /** Loads the folder in every profile; the sentence of the first failure, or null when it loaded. */
  loadFolder(folder: string): Promise<string | null>
  /** A sentence for the person, in the window they are working in. */
  notice(message: string): void
}

/** The folders a new list drops and the ones it brings, each once. */
export function folderChanges(before: readonly string[], after: readonly string[]): { removed: string[]; added: string[] } {
  const was = new Set(before)
  const is = new Set(after)
  return { removed: [...was].filter((path) => !is.has(path)), added: [...is].filter((path) => !was.has(path)) }
}

export class ExtensionFolderSync {
  /** The list as it was last seen; null before the first look (the launch loads the folders of the list itself). */
  private seen: readonly string[] | null = null
  /** The folders this is loading now: a list that names one again meanwhile does not load it twice. */
  private readonly loading = new Set<string>()

  constructor(private readonly env: ExtensionFoldersEnv) {}

  /** Called with the list of the settings every time the state changes; the first call only takes note of it. */
  follow(paths: readonly string[]): void {
    const before = this.seen
    this.seen = paths
    if (before === null || before === paths) return
    const { removed, added } = folderChanges(before, paths)
    for (const path of removed) this.unload(path)
    for (const path of added) void this.load(path)
  }

  /** Whether an extension of some profile, loaded or switched off there, comes from the folder. */
  private known(path: string): boolean {
    const { engine } = this.env
    return engine.listAllExtensions().some((e) => e.source === 'unpacked' && engine.extensionTools.folderOf(e.profileId, e.id)?.path === path)
  }

  private unload(path: string): void {
    try {
      // Nothing comes from it any more when the Extensions page has removed it first, or when it never loaded (its folder was gone at launch): nothing to do.
      this.env.engine.extensionTools.removeFolderAt(path)
    } catch (error) {
      console.error(`[extensions] the folder ${path} left Settings but its extension could not be unloaded:`, error)
      this.env.notice(t('extpage.folder-n-a-pas-pu-etre-dechargee-message', { folder: basename(path), message: cleanText(error instanceof Error ? error.message : String(error), 200) }))
    }
  }

  private async load(path: string): Promise<void> {
    if (this.loading.has(path) || this.known(path)) return
    this.loading.add(path)
    let failure: string | null
    try {
      failure = await this.env.loadFolder(path)
    } catch (error) {
      failure = describeLoadError(error, path)
    } finally {
      this.loading.delete(path)
    }
    if (failure !== null) {
      console.error(`[extensions] the folder ${path} came back in Settings but did not load: ${failure}`)
      this.env.notice(t('extpage.folder-n-a-pas-ete-chargee-message', { folder: basename(path), message: failure }))
      return
    }
    // Taken out of the list again while it was loading: what the list says now wins.
    if (this.seen !== null && !this.seen.includes(path)) this.unload(path)
  }
}
