// What the Extensions page can ask for, and how each request is answered. The request has been parsed (shared/extension-page.ts) and the sender
// trusted (extensions-ipc.ts) before it gets here; this decides, with what the application already checks for extensions (the profile and the
// extension must exist, a private window has none, a Web Store extension is uninstalled after a question and a folder is only forgotten), and every
// answer is a sentence for the person: nothing ends in a log line alone. The system's boxes and the engine come in through `env`, so that it is tested without Electron.

import { basename } from 'node:path'
import type { ExtensionInfo } from '@shared/ipc'
import { profileLabel } from '@shared/profiles'
import type { SidebarState } from '@shared/model'
import type { Action } from '@shared/sidebar'
import { checkManifestText, describeLoadError, doneMessages, filesNamedBy, isLegacyManifest, type ExtensionsReply, type ExtensionsRequest } from '@shared/extension-page'
import { cleanText, resolveMessage } from '@shared/extension-review'
import { t } from '@shared/i18n'
import type { Engine } from '../engine/types'
import { ExtensionDevError } from '../engine/extension-dev'

export interface ExtensionsServiceEnv {
  engine: Pick<Engine, 'listAllExtensions' | 'uninstallExtension' | 'extensionTools'>
  state(): SidebarState
  dispatch(action: Action): void
  /** True in a private window: it has no extensions. */
  isPrivate(): boolean
  /** A box with two buttons over the window of the page; resolves true for the first. */
  confirm(options: { message: string; detail: string; ok: string }): Promise<boolean>
  /** The system's box to choose a folder; null when the person gave up. */
  chooseFolder(): Promise<string | null>
  /** The text of `manifest.json` in a folder (bounded), or null when there is none. */
  readManifest(folder: string): Promise<string | null>
  /** Whether a file named by the manifest exists in the folder. */
  fileExists(folder: string, relative: string): Promise<boolean>
  /** Loads the folder in every profile; the message of the first failure, or null when it loaded. */
  loadFolder(folder: string): Promise<string | null>
  /** Puts a text on the clipboard of the system. */
  copyText(text: string): void
  /** Opens a page of the extension in a tab of the profile (rejects with the reason). */
  openExtensionTab(profileId: string, url: string): Promise<void>
  /** Packs the folder (see `pack`); only given where it is wired. */
  pack?(folder: string, name: string): Promise<{ crx: string; key: string; newKey: boolean } | null>
}

const known = (env: ExtensionsServiceEnv, profileId: string, extensionId: string): ExtensionInfo | undefined => env.engine.listAllExtensions().find((e) => e.profileId === profileId && e.id === extensionId)

/** The name a manifest gives (`__MSG_name__` is a key of a language file this does not read: the folder's name stands in). */
const nameOf = (manifest: Record<string, unknown>, folder: string): string => cleanText(resolveMessage(manifest['name'], undefined), 80) || basename(folder)

export class ExtensionsService {
  /** The folder `remove-folder` took out last, for "Annuler". */
  private removed: { path: string; name: string; inSettings: boolean } | null = null

  constructor(private readonly env: ExtensionsServiceEnv) {}

  async handle(request: ExtensionsRequest): Promise<ExtensionsReply> {
    // A private window has no extensions: nothing it could name would exist.
    if (this.env.isPrivate()) return { ok: false, message: t('browser.les-extensions-ne-fonctionnent-pas-dans-une') }
    switch (request.op) {
      case 'details':
        return { ok: true, details: await this.env.engine.extensionTools.details() }
      case 'journal':
        return { ok: true, journal: this.env.engine.extensionTools.readJournal({ since: request.since }), lastId: this.env.engine.extensionTools.lastJournalId() }
      case 'clear-journal': {
        const { op: _op, ids, ...filter } = request
        if (ids !== undefined) this.env.engine.extensionTools.removeJournalEntries(ids)
        else this.env.engine.extensionTools.clearJournal(filter)
        return { ok: true, lastId: this.env.engine.extensionTools.lastJournalId() }
      }
      case 'set-enabled': {
        const info = known(this.env, request.profileId, request.extensionId)
        if (!info) return { ok: false, message: t('extension-actions.cette-extension-n-est-pas-installee-dans-ce') }
        // The same action as Settings: the state decides, the engine follows it (and a switch already in that position changes nothing).
        this.env.dispatch({ type: 'extension/set-enabled', profileId: request.profileId, extensionId: request.extensionId, enabled: request.enabled })
        return { ok: true }
      }
      case 'set-tab-capture': {
        const info = known(this.env, request.profileId, request.extensionId)
        if (!info) return { ok: false, message: t('extension-actions.cette-extension-n-est-pas-installee-dans-ce') }
        // The state holds the choice and the engine follows it; the interface changes it by this request only (the page is a tab with eight calls of its own).
        this.env.dispatch({ type: 'extension/set-tab-capture', profileId: request.profileId, extensionId: request.extensionId, allowed: request.allowed })
        return { ok: true }
      }
      case 'reload':
        return this.reload(request.profileId, request.extensionId)
      case 'uninstall':
        return this.uninstall(request.profileId, request.extensionId, request.asked === true)
      case 'remove-folder':
        return this.removeFolder(request.extensionId)
      case 'undo-remove':
        return this.undoRemove()
      case 'load-unpacked':
        return this.loadUnpacked()
      case 'pack':
        return this.pack(request.extensionId)
      case 'open-options':
        return this.openOptions(request.profileId, request.extensionId)
      case 'revoke-granted': {
        const info = known(this.env, request.profileId, request.extensionId)
        if (!info) return { ok: false, message: t('extension-actions.cette-extension-n-est-pas-installee-dans-ce') }
        // The page may be late: what it names was already taken back, by it or by the extension itself.
        if (!this.env.engine.extensionTools.revokeGranted(request.profileId, request.extensionId, request.name)) return { ok: false, message: t('extpage.cette-autorisation-n-est-plus-accordee') }
        return { ok: true, message: doneMessages.revoked(info.name, cleanText(request.name, 120)) }
      }
      case 'copy-id':
        this.env.copyText(request.extensionId)
        return { ok: true, message: t('extpage.copie') }
    }
  }

  /** The first problem a folder has, as a sentence, or the manifest when it has none (in Manifest V3 or V2): read before anything is unloaded or loaded. */
  private async inspect(folder: string): Promise<{ ok: true; manifest: Record<string, unknown> } | { ok: false; message: string }> {
    let text: string | null
    try {
      text = await this.env.readManifest(folder)
    } catch (error) {
      console.error(`[extensions] cannot read the manifest of ${folder}:`, error)
      return { ok: false, message: t('extpage.manifest-json-ne-peut-pas-etre-lu-message', { message: cleanText((error as Error).message, 160) }) }
    }
    if (text === null) return { ok: false, message: t('extpage.le-dossier-ne-contient-pas-de-manifest-json-lisible') }
    const checked = checkManifestText(text)
    if (!checked.ok) return checked
    for (const file of filesNamedBy(checked.manifest)) {
      if (!(await this.env.fileExists(folder, file))) return { ok: false, message: t('extpage.le-fichier-file-est-cite-par-le-manifeste-mais-absent', { file }) }
    }
    return { ok: true, manifest: checked.manifest }
  }

  private async reload(profileId: string, extensionId: string): Promise<ExtensionsReply> {
    const tools = this.env.engine.extensionTools
    const info = known(this.env, profileId, extensionId)
    const folder = tools.folderOf(profileId, extensionId)
    if (!info || !folder) return { ok: false, message: t('extpage.cette-extension-n-est-pas-chargee-dans-ce-profil') }
    // Switched off by the user: nothing to reload. Not loaded because its last load failed: this is the try again.
    if (!info.enabled && tools.failureOf(profileId, extensionId) === undefined) return { ok: false, message: t('extpage.activez-l-extension-avant-de-la-recharger') }
    // The folder is read first: an edit that broke the manifest leaves the extension running as it was, and says what is wrong.
    const inspected = await this.inspect(folder.path)
    if (!inspected.ok) {
      tools.failed(profileId, folder.path, extensionId, inspected.message)
      return { ok: false, message: inspected.message }
    }
    try {
      await tools.reload(profileId, extensionId)
      return { ok: true, message: doneMessages.reloaded(info.name) }
    } catch (error) {
      // The engine has written the failure in the journal; the sentence is the same here.
      return { ok: false, message: error instanceof ExtensionDevError ? error.message : describeLoadError(error, folder.path) }
    }
  }

  /** `asked`: the panel of the site asked « Retirer ? » in place and the person said yes; the box would ask the same thing again. */
  private async uninstall(profileId: string, extensionId: string, asked: boolean): Promise<ExtensionsReply> {
    const info = known(this.env, profileId, extensionId)
    if (!info) return { ok: false, message: t('extension-actions.cette-extension-n-est-pas-installee-dans-ce') }
    if (info.source !== 'store') return { ok: false, message: t('extpage.name-ne-vient-pas-du-chrome-web-store-utilisez-supprimer', { name: info.name }) }
    const confirmed = asked || await this.env.confirm({
      message: t('extension-actions.desinstaller-name', { name: info.name }),
      detail: t('extpage.l-extension-et-ses-donnees-seront-supprimees-du-profil', { profile: profileLabel(this.env.state().settings, profileId) }),
      ok: t('extension-actions.desinstaller')
    })
    // Giving up is an answer, not a failure: nothing to say.
    if (!confirmed) return { ok: true }
    try {
      await this.env.engine.uninstallExtension(profileId, extensionId)
      return { ok: true, message: doneMessages.uninstalled(info.name) }
    } catch (error) {
      console.error(`[extensions] cannot uninstall ${extensionId} from profile ${profileId}:`, error)
      return { ok: false, message: t('extpage.la-desinstallation-de-name-a-echoue-message', { name: info.name, message: cleanText((error as Error).message, 200) }) }
    }
  }

  private removeFolder(extensionId: string): ExtensionsReply {
    const copy = this.env.engine.listAllExtensions().find((e) => e.id === extensionId)
    if (!copy) return { ok: false, message: t('extension-actions.cette-extension-n-est-pas-installee-dans-ce') }
    if (copy.source !== 'unpacked') return { ok: false, message: t('extpage.name-vient-du-chrome-web-store-desinstallez-la', { name: copy.name }) }
    const gone = this.env.engine.extensionTools.removeFolder(extensionId)
    if (!gone) return { ok: false, message: t('extension-actions.cette-extension-n-est-pas-installee-dans-ce') }
    const paths = this.env.state().settings.extensionPaths
    const inSettings = paths.includes(gone.path)
    if (inSettings) this.env.dispatch({ type: 'settings/update', patch: { extensionPaths: paths.filter((p) => p !== gone.path) } })
    this.removed = { ...gone, inSettings }
    return { ok: true, message: doneMessages.removedFolder(gone.name), undo: true }
  }

  private async undoRemove(): Promise<ExtensionsReply> {
    const back = this.removed
    if (!back) return { ok: false, message: t('extpage.il-n-y-a-rien-a-remettre') }
    this.removed = null
    const failure = await this.env.loadFolder(back.path)
    if (failure !== null) return { ok: false, message: failure }
    const paths = this.env.state().settings.extensionPaths
    if (back.inSettings && !paths.includes(back.path)) this.env.dispatch({ type: 'settings/update', patch: { extensionPaths: [...paths, back.path] } })
    return { ok: true, message: doneMessages.restoredFolder(back.name) }
  }

  private async loadUnpacked(): Promise<ExtensionsReply> {
    const folder = await this.env.chooseFolder()
    if (folder === null) return { ok: true }
    const inspected = await this.inspect(folder)
    if (!inspected.ok) {
      // Said in the journal too, with the folder: the list has nothing to show it on.
      this.env.engine.extensionTools.failed('default', folder, undefined, inspected.message)
      return { ok: false, message: t('extpage.folder-n-a-pas-ete-chargee-message', { folder: basename(folder), message: inspected.message }) }
    }
    const failure = await this.env.loadFolder(folder)
    if (failure !== null) return { ok: false, message: t('extpage.folder-n-a-pas-ete-chargee-message', { folder: basename(folder), message: failure }) }
    const paths = this.env.state().settings.extensionPaths
    if (!paths.includes(folder)) this.env.dispatch({ type: 'settings/update', patch: { extensionPaths: [...paths, folder] } })
    // A Manifest V2 folder is loaded like Settings loads it; the person is told, in the notice and on the row, that the old format may lack features.
    return { ok: true, message: doneMessages.loaded(nameOf(inspected.manifest, folder), isLegacyManifest(inspected.manifest)) }
  }

  private async pack(extensionId: string): Promise<ExtensionsReply> {
    const copy = this.env.engine.listAllExtensions().find((e) => e.id === extensionId && e.source === 'unpacked')
    if (!copy) return { ok: false, message: t('extpage.seule-une-extension-chargee-depuis-un-dossier-peut-etre-empaquetee') }
    const folder = this.env.engine.extensionTools.folderOf(copy.profileId, extensionId)
    if (!folder || !this.env.pack) return { ok: false, message: t('extpage.l-empaquetage-n-est-pas-disponible') }
    const inspected = await this.inspect(folder.path)
    if (!inspected.ok) return { ok: false, message: inspected.message }
    try {
      const packed = await this.env.pack(folder.path, folder.name)
      if (packed === null) return { ok: true }
      return { ok: true, message: packed.newKey ? t('extpage.name-est-empaquetee-crx-cle-privee-creee', { name: folder.name, crx: basename(packed.crx), key: basename(packed.key) }) : t('extpage.name-est-empaquetee-crx-avec-la-cle-de-key', { name: folder.name, crx: basename(packed.crx), key: basename(packed.key) }) }
    } catch (error) {
      console.error(`[extensions] cannot pack ${folder.path}:`, error)
      return { ok: false, message: t('extpage.l-empaquetage-de-name-a-echoue-message', { name: folder.name, message: cleanText((error as Error).message, 200) }) }
    }
  }

  private async openOptions(profileId: string, extensionId: string): Promise<ExtensionsReply> {
    const info = known(this.env, profileId, extensionId)
    if (!info?.enabled) return { ok: false, message: t('extpage.activez-l-extension-avant-d-ouvrir-ses-options') }
    const detail = (await this.env.engine.extensionTools.details()).find((d) => d.profileId === profileId && d.id === extensionId)
    const page = detail?.facts?.optionsPage
    if (page === undefined) return { ok: false, message: t('extpage.name-n-a-pas-de-page-d-options', { name: info.name }) }
    try {
      await this.env.openExtensionTab(profileId, `chrome-extension://${extensionId}/${page}`)
      return { ok: true }
    } catch (error) {
      console.error(`[extensions] cannot open the options of ${extensionId}:`, error)
      return { ok: false, message: t('extpage.la-page-d-options-de-name-ne-s-est-pas-ouverte-message', { name: info.name, message: cleanText((error as Error).message, 200) }) }
    }
  }
}
