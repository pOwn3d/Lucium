// The .deb a person is told about (shared/linux-install.ts): Lucium may download it, after a click, into the person's Downloads folder, and never installs it. The
// download goes through the same checks as every installer (update-installer-file.ts: size and SHA-256 of the signed feed, a private folder of its own), and only a file
// that passed them is copied to Downloads, under a name made from the signed version and the architecture of this copy, never from the address. An existing file of that
// name is not overwritten: it is kept when it is the same file, and otherwise the download says so and stops.

import { constants } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { debFileName } from '@shared/linux-install'
import type { UpdateOffer } from '@shared/update-check'
import { discardInstallerFolder, downloadVerifiedInstaller, refused, verifyFileAgainst, words, type DownloadDeps, type InstallerDownload } from './update-installer-file'

/**
 * Downloads the .deb `offer` names, checks it in `workFolder` (a new private folder, emptied afterwards), and puts it in `downloads`. Resolves with the file in Downloads,
 * or the reason: the offer is not a .deb that can be checked (`offer`), the network or the bytes (`network`, `mismatch`), the disk (`disk`: including a different file of
 * the same name already in Downloads).
 */
export async function downloadDeb(deps: DownloadDeps & { workFolder: string; downloads: string; arch: string }, offer: UpdateOffer): Promise<InstallerDownload> {
  const fileName = debFileName(offer.version, deps.arch)
  if (!fileName) return refused('offer', `a .deb cannot be named for version ${JSON.stringify(offer.version)} and architecture ${JSON.stringify(deps.arch)}`)
  const checked = await downloadVerifiedInstaller({ ...deps, folder: deps.workFolder }, offer, { kind: 'deb', fileName })
  if (!checked.ok) return checked
  const target = join(deps.downloads, fileName)
  try {
    try {
      // Created new: a file that is already there is never overwritten.
      await copyFile(checked.file, target, constants.COPYFILE_EXCL)
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EEXIST') throw error
      // The same file downloaded before is as good as a new one; any other file of that name is the person's.
      if (!(await verifyFileAgainst(target, offer, 'deb'))) return refused('disk', `${target} already exists and is not the .deb the feed signs: move it away, then try again`)
    }
  } catch (error) {
    return refused('disk', `the .deb could not be saved to ${deps.downloads}: ${words(error)}`)
  } finally {
    await discardInstallerFolder(deps.workFolder).catch((error: unknown) => console.warn(`[update] the folder of the .deb download could not be removed: ${words(error)}`))
  }
  return { ok: true, file: target, sha256: checked.sha256 }
}
