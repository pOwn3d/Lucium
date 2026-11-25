// The installer of a Windows update that was run is still in the temporary folder when Lucium quits for it (the installer needs the file, and the system
// refuses to remove a program that runs), and the new Lucium starts after it is done. The new one therefore sweeps the folder at launch.
// The rule is here, with no Electron and no file system of its own, so that a test runs the same on every system: the folder is removed only when it is the
// one this application makes in the temporary folder (never a path taken from outside, never the temporary folder itself).

/** The name of the folder of a download in the temporary folder (update-installer-file.ts). */
export const INSTALLER_LEFTOVER_FOLDER = 'lucium-update'

export type LeftoverOutcome = 'removed' | 'refused' | 'failed'

export interface LeftoverSweep {
  /** The temporary folder of the application. */
  temp: string
  /** The folder to remove. */
  folder: string
  /** The `join` of the path module of the running system. */
  join: (...parts: string[]) => string
  /** Takes a folder away, whatever it holds; a folder that is not there is not a failure. */
  remove: (folder: string) => Promise<void>
  log?: (line: string) => void
}

/** Removes `folder` only when it is exactly the download folder of Lucium inside `temp`; the reason of a refusal or of a failure goes to the log. */
export async function sweepInstallerLeftover({ temp, folder, join, remove, log }: LeftoverSweep): Promise<LeftoverOutcome> {
  if (!temp || !folder || folder === temp || folder !== join(temp, INSTALLER_LEFTOVER_FOLDER)) {
    log?.('[update] the folder of an installer left behind was not removed: it is not the download folder of Lucium')
    return 'refused'
  }
  try {
    await remove(folder)
    return 'removed'
  } catch (error) {
    log?.(`[update] the installer left in the temporary folder could not be removed: ${error instanceof Error ? error.message : String(error)}`)
    return 'failed'
  }
}
