// The files of an AppImage update, on the disk (shared/linux-install.ts names them). The update of an AppImage is a file that replaces a file, so it is written
// BESIDE the one that runs (same folder, so the same file system: the last step is one `rename`, which is atomic and works on a file that is running), checked, and
// swapped in only after the second click:
//
//   Lucium.AppImage             the copy that runs
//   Lucium.AppImage.update.part the download as it arrives (created new; never reused)
//   Lucium.AppImage.update      the download once its size and SHA-256 are the signed ones, made executable: it waits for « Installer et relancer »
//   Lucium.AppImage.previous    the copy that was running, kept from the swap until the new one has started (a rollback if the swap cannot be finished)
//
// Nothing here chooses what to download: the claim comes from the signed feed (update-installer-file.ts checks it), the path from the system (`APPIMAGE`, which
// shared/linux-install.ts only believes when it is a plain absolute path).

import { accessSync, constants, lstatSync, rmSync } from 'node:fs'
import { chmod, lstat, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { appImageFiles } from '@shared/linux-install'
import type { UpdateOffer } from '@shared/update-check'
import { fetchVerifiedFile, installerClaim, refused, verifyFileAgainst, words, type DownloadDeps, type InstallerDownload } from './update-installer-file'

/**
 * Whether the running AppImage can be replaced by this user: the file is a regular file (not a link: a link to a file elsewhere is not the person's to swap), and
 * the folder that holds it can be written and entered (a rename needs the folder, not the file). Asked just before the update is offered, so that a copy that cannot be
 * replaced is told the download page instead of downloading a file it could not put in place.
 */
export function canReplaceAppImage(file: string): boolean {
  try {
    const info = lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink()) return false
    accessSync(dirname(file), constants.W_OK | constants.X_OK)
    return true
  } catch (error) {
    // No such file, no right on the folder: the answer is « no », which sends the person to the download page instead of an update that could not be put in place.
    console.warn(`[update] the AppImage cannot be replaced by an update (${file}): ${words(error)}`)
    return false
  }
}

/**
 * Downloads the AppImage `offer` names next to the one that runs (`file`) and returns it once its size and SHA-256 are the signed ones, made executable. Anything that
 * an earlier download left (`.update`, `.update.part`) is taken away first; any other end removes what this one made, so that no file with the name of a checked
 * download is one that was not.
 */
export async function downloadAppImage(deps: DownloadDeps, offer: UpdateOffer, file: string): Promise<InstallerDownload> {
  const claim = installerClaim(offer, 'appimage')
  if (!claim) return refused('offer', 'the offer does not name an AppImage with an https address, a SHA-256 and a size')
  const { part, staged } = appImageFiles(file)
  const clear = async (): Promise<void> => {
    await rm(part, { force: true })
    await rm(staged, { force: true })
  }
  try {
    // `rm` takes away a link itself, never what it points to.
    await clear()
  } catch (error) {
    return refused('disk', `the files of an earlier download could not be removed: ${words(error)}`)
  }
  const done = await fetchVerifiedFile(deps, claim, part, staged, clear)
  if (!done.ok) return done
  try {
    // The mode is the person's to expect of an AppImage: readable and runnable by them, writable by them alone.
    await chmod(staged, 0o755)
  } catch (error) {
    await clear().catch((cleanError: unknown) => console.warn(`[update] the download that could not be made executable could not be removed: ${words(cleanError)}`))
    return refused('disk', `the download could not be made executable: ${words(error)}`)
  }
  return done
}

/** The last check of the download that waits, as it is on the disk: the file the system names `.update` beside `file`, a regular file of the signed size and sum. */
export async function verifyStagedAppImage(file: string, staged: string, offer: UpdateOffer): Promise<boolean> {
  return staged === appImageFiles(file).staged && (await verifyFileAgainst(staged, offer, 'appimage'))
}

/**
 * Puts the download in the place of the running AppImage: the running file is renamed to `.previous` (the copy that runs keeps working: its file is open), then the
 * download is renamed to the running file's name. If the second step fails the first is undone, so that the person is left with the AppImage they had, and the error is
 * thrown. A `.previous` left by an earlier swap is replaced.
 */
export async function swapAppImage(file: string): Promise<void> {
  const { staged, previous } = appImageFiles(file)
  await rename(file, previous)
  try {
    await rename(staged, file)
  } catch (error) {
    try {
      await rename(previous, file)
    } catch (undoError) {
      // Both failed: the running copy is at `.previous`, and the person is told where it is (the report of the caller carries this message).
      throw new Error(`${words(error)}; and the copy that ran could not be put back from ${previous}: ${words(undoError)}`, { cause: error })
    }
    throw error
  }
}

/** Undoes a swap: the copy kept as `.previous` is put back in the place of the one that replaced it (which is then gone: it was never started). */
export async function undoSwapAppImage(file: string): Promise<void> {
  await rename(appImageFiles(file).previous, file)
}

/** Takes away the download that waits (and its unfinished form), at once: for the quit, which does not wait for what is asked after it. */
export function discardAppImageUpdateNow(file: string): void {
  const { part, staged } = appImageFiles(file)
  rmSync(part, { force: true })
  rmSync(staged, { force: true })
}

export async function discardAppImageUpdate(file: string): Promise<void> {
  const { part, staged } = appImageFiles(file)
  await rm(part, { force: true })
  await rm(staged, { force: true })
}

/**
 * The copy a swap kept (`.previous`), taken away once the new one has started: asked by the new copy itself, from the path it was started from. Only a regular file is
 * removed: a folder, or a link, that someone put there is not Lucium's to delete. A failure is told to `log` (the file stays; the next start tries again).
 */
export async function removePreviousAppImage(file: string, log: (line: string) => void): Promise<void> {
  const { previous } = appImageFiles(file)
  try {
    const info = await lstat(previous)
    if (!info.isFile() || info.isSymbolicLink()) {
      log(`[update] ${previous} is not a file Lucium made: it is left as it is`)
      return
    }
    await rm(previous)
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return
    log(`[update] the copy kept before the update could not be removed (${previous}): ${words(error)}`)
  }
}
