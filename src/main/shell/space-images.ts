// The pictures of spaces in the data folder (`space-images/`): importing a file the user chose, reading a stored picture back, deleting the ones
// no space refers to any more. No Electron here: the decoding is an `ImageCodec` handed in (see space-images-electron.ts), so that every rule can
// be tested with a plain folder. The chosen file is the user's own and is never kept, moved or written to: only its shrunk copy is stored, under
// a name made here, and the state holds that name alone.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { writeDurableFile } from '../durable-write'
import { join } from 'node:path'
import type { Space, TabItem } from '@shared/model'
import type { Action } from '@shared/sidebar'
import {
  SPACE_IMAGE_FILE_MAX,
  SPACE_IMAGE_SIZE,
  SPACE_IMAGE_STORED_MAX,
  spaceImageUnreadable,
  imageHeader,
  imageRefusal,
  isSpaceImageName,
  orphanImages,
  type SpaceImageReply,
  type SpaceImageRequest
} from '@shared/space-image'
import { spaceLookRefusal } from '@shared/lock'
import { t } from '@shared/i18n'

/** Decodes a picture in any of the three formats, crops its middle to a square and shrinks it to `size` pixels: PNG bytes. Rejects when it cannot. */
export interface ImageCodec {
  shrink(bytes: Buffer, size: number): Promise<Buffer>
}

/** A refusal the user is told in these words. */
export class SpaceImageError extends Error {}

/** A leftover of an import that did not finish: removed with the pictures nothing refers to. */
const TEMPORARY = /^[0-9a-f]{24}\.png\.tmp$/

export type StoredImage = { kind: 'ok'; dataUrl: string } | { kind: 'missing' } | { kind: 'damaged' }

export class SpaceImageStore {
  constructor(
    private readonly dir: string,
    private readonly codec: ImageCodec
  ) {}

  /**
   * Makes the stored picture of a file on the disk and answers its name. Nothing is decoded before the file's size and its header have
   * been checked, and nothing is stored that the codec's answer does not pass for a 128 px PNG. Throws a `SpaceImageError` whose message
   * is the sentence for the user; whatever was written on the way is removed.
   */
  async importFile(path: string): Promise<string> {
    let size: number
    try {
      const info = statSync(path)
      if (!info.isFile()) throw new SpaceImageError(t('space-images.ce-n-est-pas-un-fichier'))
      size = info.size
    } catch (error) {
      if (error instanceof SpaceImageError) throw error
      console.warn('[space image] cannot look at the chosen file:', (error as NodeJS.ErrnoException).code ?? String(error))
      throw new SpaceImageError(t('space-images.ce-fichier-n-a-pas-pu-etre-ouvert'))
    }
    // The weight is checked before a byte is read; the header before a byte is decoded.
    if (size > SPACE_IMAGE_FILE_MAX) throw new SpaceImageError(imageRefusal(size, new Uint8Array(0))!)
    let bytes: Buffer
    try {
      bytes = readFileSync(path)
    } catch (error) {
      console.warn('[space image] cannot read the chosen file:', (error as NodeJS.ErrnoException).code ?? String(error))
      throw new SpaceImageError(t('space-images.ce-fichier-n-a-pas-pu-etre-lu'))
    }
    const refusal = imageRefusal(bytes.length, bytes)
    if (refusal) throw new SpaceImageError(refusal)
    let png: Buffer
    try {
      png = await this.codec.shrink(bytes, SPACE_IMAGE_SIZE)
    } catch (error) {
      console.warn('[space image] the picture could not be decoded:', error instanceof Error ? error.message : String(error))
      throw new SpaceImageError(spaceImageUnreadable())
    }
    // What the decoder hands back is checked like anything else: a PNG, no bigger than asked, small.
    const header = imageHeader(png)
    if (!header || header.format !== 'png' || header.width < 1 || header.width > SPACE_IMAGE_SIZE || header.height < 1 || header.height > SPACE_IMAGE_SIZE || png.length > SPACE_IMAGE_STORED_MAX) {
      console.warn('[space image] the decoder returned something that is not a small PNG')
      throw new SpaceImageError(spaceImageUnreadable())
    }
    const name = `${randomBytes(12).toString('hex')}.png`
    const temporary = join(this.dir, `${name}.tmp`)
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      // On the disk before the rename: a power cut must not leave an empty picture under a name the state already holds.
      writeDurableFile(temporary, png)
      renameSync(temporary, join(this.dir, name))
    } catch (error) {
      console.error('[space image] cannot store the picture in', this.dir, error)
      this.discard(temporary)
      throw new SpaceImageError(t('space-images.l-image-n-a-pas-pu-etre-enregistree-dans-le'))
    }
    return name
  }

  /** The stored picture of this name, as a `data:` URL. A file that is gone or that is not one of our small PNGs is reported, not returned. */
  read(name: string): StoredImage {
    if (!isSpaceImageName(name)) return { kind: 'missing' }
    const path = join(this.dir, name)
    try {
      const info = statSync(path)
      if (!info.isFile()) return { kind: 'damaged' }
      if (info.size > SPACE_IMAGE_STORED_MAX) return { kind: 'damaged' }
      const bytes = readFileSync(path)
      const header = imageHeader(bytes)
      if (!header || header.format !== 'png' || header.width > SPACE_IMAGE_SIZE || header.height > SPACE_IMAGE_SIZE) return { kind: 'damaged' }
      return { kind: 'ok', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
      console.error('[space image] cannot read', name, error)
      return { kind: 'damaged' }
    }
  }

  /** Deletes one stored picture. True when it is gone (it may never have been there); false, with a log, when the system refused. */
  remove(name: string): boolean {
    if (!isSpaceImageName(name)) return false
    return this.discard(join(this.dir, name))
  }

  /**
   * Deletes every stored picture the state no longer refers to, and the leftovers of an import that did not finish. Answers how many files went.
   * `alsoKept` names what else must stay (the pictures the copies of the session name, see space-image-sweep.ts); it is asked only when a picture
   * would go, and when it cannot tell (null) no picture is deleted.
   */
  sweep(referenced: ReadonlySet<string>, alsoKept?: () => ReadonlySet<string> | null): number {
    let files: string[]
    try {
      files = readdirSync(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[space image] cannot list', this.dir, error)
      return 0
    }
    let orphans = orphanImages(files, referenced)
    if (orphans.length > 0 && alsoKept) {
      const more = alsoKept()
      if (more === null) console.warn(`[space image] ${orphans.length} picture(s) nothing in the state names are kept: a copy that may name them cannot be read`)
      orphans = more === null ? [] : orphans.filter((name) => !more.has(name))
    }
    const doomed = [...orphans, ...files.filter((f) => TEMPORARY.test(f))]
    let removed = 0
    for (const file of doomed) if (this.discard(join(this.dir, file))) removed++
    return removed
  }

  private discard(path: string): boolean {
    try {
      unlinkSync(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      console.error('[space image] cannot delete', path, error)
      return false
    }
  }
}

/** What a request needs of the window it comes from. */
export interface SpaceImageHost {
  spaces(): readonly Space[]
  /** The tabs, for the picture of a tab. */
  tabs(): readonly TabItem[]
  dispatch(action: Action): void
  /** The file the user picks in the dialog (its title says whether it is for a space or a tab); null when they close it. */
  chooseFile(target: 'space' | 'tab'): Promise<string | null>
  /** Deletes the pictures nothing refers to (the state has changed). */
  sweep(): void
  /** A private window keeps nothing on disk. */
  isPrivate(): boolean
  /** The spaces locked at this moment: their picture does not change. Without it none is. */
  lockedSpaces?(): readonly string[]
}

/**
 * Answers a request of the interface. The interface says which space and which stored name, never a path: the file is the one the user picks
 * in a dialog of the main process.
 */
export async function runSpaceImageRequest(store: SpaceImageStore, host: SpaceImageHost, request: SpaceImageRequest): Promise<SpaceImageReply> {
  // A private window writes nothing to the disk. (The picture of a space is no longer a function to switch on: the picker offers it.)
  if (host.isPrivate()) return { ok: false, message: t('space-images.les-images-d-espace-ne-sont-pas-disponibles') }

  if (request.op === 'read') {
    const stored = store.read(request.name)
    if (stored.kind === 'ok') return { ok: true, dataUrl: stored.dataUrl }
    // A picture that is gone or damaged is let go of: the spaces that named it show their emoji again, the tabs their site's icon, and the file does not stay behind.
    // A locked space is not changed, even to let go of a picture: it keeps the name, and the file, until it is unlocked and asks for it again.
    const locked = host.lockedSpaces?.() ?? []
    const named = host.spaces().filter((space) => space.image === request.name)
    for (const space of named) if (!locked.includes(space.id)) host.dispatch({ type: 'space/image', id: space.id, image: null })
    for (const tab of host.tabs()) if (tab.image === request.name) host.dispatch({ type: 'tab/image', id: tab.id, image: null })
    if (!named.some((space) => locked.includes(space.id))) store.remove(request.name)
    return { ok: false, message: spaceImageUnreadable() }
  }

  if (request.op === 'pick-tab') {
    const tab = host.tabs().find((entry) => entry.id === request.tabId)
    if (!tab) return { ok: false, message: t('space-images.cet-onglet-n-existe-plus') }
    // A private tab is written nowhere: no copy of a picture is made for it.
    if (tab.private) return { ok: false, message: t('space-images.un-onglet-prive-ne-garde-pas-d-image') }
    return importPicture(store, host, 'tab', (name) => {
      host.dispatch({ type: 'tab/image', id: tab.id, image: name })
      // The tab may have gone while the picture was being made: then nothing keeps it.
      return host.tabs().find((entry) => entry.id === tab.id)?.image === name
    }, t('space-images.l-image-n-a-pas-pu-etre-appliquee-a-cet-onglet'))
  }

  const space = host.spaces().find((s) => s.id === request.spaceId)
  if (!space) return { ok: false, message: t('space-images.cet-espace-n-existe-plus') }
  // Asked before the file dialog: a refusal copies no picture.
  const refusal = spaceLookRefusal(space.id, host.lockedSpaces?.() ?? [])
  if (refusal !== null) return { ok: false, message: refusal }

  if (request.op === 'clear') {
    host.dispatch({ type: 'space/image', id: space.id, image: null })
    host.sweep()
    return { ok: true }
  }

  return importPicture(store, host, 'space', (name) => {
    host.dispatch({ type: 'space/image', id: space.id, image: name })
    // The space may have gone while the picture was being made: then nothing keeps it.
    return host.spaces().find((s) => s.id === space.id)?.image === name
  }, t('space-images.l-image-n-a-pas-pu-etre-appliquee-a-cet-espace'))
}

/**
 * The file the user picks becomes a stored picture, given to its space or tab by `give` (true when it holds it afterwards). Whatever nothing holds is
 * swept; a copy made but not given is not left behind.
 */
async function importPicture(store: SpaceImageStore, host: SpaceImageHost, target: 'space' | 'tab', give: (name: string) => boolean, notKept: string): Promise<SpaceImageReply> {
  const path = await host.chooseFile(target)
  if (path === null) return { ok: false, message: '' }
  let made: string | null = null
  try {
    const name = await store.importFile(path)
    made = name
    const kept = give(name)
    host.sweep()
    return kept ? { ok: true } : { ok: false, message: notKept }
  } catch (error) {
    if (error instanceof SpaceImageError) return { ok: false, message: error.message }
    // The copy was made but could not be given to its space or tab: it is not left behind.
    if (made) store.remove(made)
    console.error('[space image] unexpected failure while importing a picture:', error)
    return { ok: false, message: t('space-image-picker.l-image-n-a-pas-pu-etre-importee') }
  }
}
