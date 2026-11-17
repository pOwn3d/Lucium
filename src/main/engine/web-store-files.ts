// Where the extensions installed from the Chrome Web Store live on disk, and how they are told apart: one folder per profile, one per
// extension, one per version (`<root>/<profile>/<extension id>/<version>_0`, the layout the install library writes). An extension
// installed in a profile is a folder of that profile only, which is what keeps it from running in the others.
// No Electron here: tested on a temporary folder.

import { chmod, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isExtensionId } from '@shared/extension-review'
import { isProfileId } from '@shared/profiles'
import { compareVersions } from '@shared/versions'

export const STORE_DIR = 'WebStoreExtensions'
export const STAGING_DIR = 'WebStoreStaging'

/**
 * Makes `path` a folder only its owner can enter (0700), whatever the umask, and closes it when it was already there with wider rights (an install
 * of an earlier version made it readable by every account of the Mac). What is under it keeps the rights the install library gave it: a closed
 * door in front is what keeps the other accounts out, as for the rest of the data folder.
 */
export async function ownerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

/** Closes the folder of the installed extensions when there is one, and only then: a profile that never installed anything gets no folder. */
export async function closeStoreDirectory(root: string): Promise<void> {
  try {
    await chmod(root, 0o700)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** `<root>/<profile>`: throws for a profile id that is not a plain storage key (it names a folder). */
export function profileDirectory(root: string, profileId: string): string {
  if (!isProfileId(profileId)) throw new Error(`"${profileId}" is not a profile id`)
  return join(root, profileId)
}

export function extensionDirectory(root: string, profileId: string, extensionId: string): string {
  if (!isExtensionId(extensionId)) throw new Error(`"${extensionId}" is not an extension id`)
  return join(profileDirectory(root, profileId), extensionId)
}

/** Compares two version folders ("1.2.10_0" is later than "1.2.9_0"): the numbers in the order of shared/versions.ts, then the suffix after "_", which counts
 *  last. Only well-formed folder names are ordered (`storedExtensions` keeps those of VERSION_FOLDER): a name whose numbers are not a version ranks as equal
 *  on them. */
export function compareVersionFolders(a: string, b: string): number {
  const [numbersA = '', suffixA = '0'] = a.split('_')
  const [numbersB = '', suffixB = '0'] = b.split('_')
  return compareVersions(numbersA, numbersB) || (Number.parseInt(suffixA, 10) || 0) - (Number.parseInt(suffixB, 10) || 0)
}

const VERSION_FOLDER = /^\d+(\.\d+){0,3}(_\d+)?$/

export interface StoredExtension {
  id: string
  /** The version folder's name without its suffix ("1.2.3"). */
  version: string
  /** The folder to load. */
  path: string
}

async function listNames(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    // A profile that never installed anything has no folder: that is not a failure.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** The newest version folder of every extension installed in a profile. A folder that is not an extension id or holds no manifest is left alone. */
export async function storedExtensions(root: string, profileId: string): Promise<StoredExtension[]> {
  const profileDir = profileDirectory(root, profileId)
  const found: StoredExtension[] = []
  for (const id of await listNames(profileDir)) {
    if (!isExtensionId(id)) continue
    const versions = (await listNames(join(profileDir, id))).filter((name) => VERSION_FOLDER.test(name)).sort(compareVersionFolders)
    for (const folder of versions.reverse()) {
      const path = join(profileDir, id, folder)
      try {
        await readFile(join(path, 'manifest.json'))
      } catch (error) {
        // An interrupted install leaves a folder without a manifest: the previous version, if any, is the one to load.
        console.warn(`[webstore] ${path} has no readable manifest, skipped:`, (error as Error).message)
        continue
      }
      found.push({ id, version: folder.split('_')[0]!, path })
      break
    }
  }
  return found
}
