// Deletes the background media nothing refers to any more: a replaced background, a deleted space, a cancelled change.
// The files that the automatic copies still refer to are kept, so that restoring a copy brings its background back, and so are those named by the
// copy of the state made before Help › Restore Data (`state.json.avant-restauration-*`): the dialog invites the user to put it back.

import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { referencedBackgroundFiles } from '@shared/background-media-refs'
import { containersNamedByCopies } from '@shared/containers'
import type { SessionCopyData } from '@shared/session-backups'
import { BackupFiles } from '../backup-store'
import { DATA_FILE_MAX_BYTES, copiesFromNewerVersion, hasSetAsideFiles, readTextBounded, sideFiles } from '../persist'

/**
 * Whether the media nothing refers to may be deleted at this launch. Only a state that was read, and that is the one the user had, names every
 * background; a state that was set aside, held, or absent does not. Nor does a set-aside file beside it, which may still refer to
 * backgrounds the current state dropped: deleting then would leave that file restorable only in name. The same holds for the copy of a state a later
 * version than `runningVersion` wrote (persist.ts, `copyOnVersionChange`): this version may have dropped what it did not know in it.
 */
export function mayDeleteBackgroundMedia(statePath: string, stateReadable: boolean, runningVersion?: string): boolean {
  return stateReadable && !hasSetAsideFiles(statePath) && !(runningVersion !== undefined && copiesFromNewerVersion(statePath, runningVersion).length > 0)
}

/** The media names referred to by the current spaces and by every readable automatic copy. */
export function referencedByStateAndCopies(spaces: readonly { background?: { type: string; value: string } | undefined }[], copies: readonly SessionCopyData[]): Set<string> {
  const names = referencedBackgroundFiles(spaces)
  for (const copy of copies) for (const name of referencedBackgroundFiles(copy.spaces)) names.add(name)
  return names
}

/** The automatic copies of the session that can be read; an unreadable copy is skipped, not an error. `log`: who asks and for what, for the warning. */
export function readSessionCopies(userDataPath: string, log: { tag: string; what: string } = { tag: '[media]', what: 'backgrounds' }): SessionCopyData[] {
  const files = new BackupFiles(join(userDataPath, 'session-backups'))
  const data: SessionCopyData[] = []
  for (const id of files.ids()) {
    try {
      data.push(files.read(id).data)
    } catch (error) {
      // A copy that cannot be read refers to nothing this sweep can check: its backgrounds may be deleted, which is logged here.
      console.warn(`${log.tag} the automatic copy ${id} could not be read; its ${log.what} are not kept for it:`, error)
    }
  }
  return data
}

/**
 * The texts of the copies of the state kept before a restoration (`state.json.avant-restauration-*`), each read whole when it is no larger than a
 * state file may be. A copy that cannot be read is answered as null: the sweep then deletes nothing (it cannot tell what that copy names).
 * `log`: who asks, for the warning (the sweep of the backgrounds by default).
 */
export function copiesBeforeRestore(userDataPath: string, log: { tag: string; kept: string } = { tag: '[media]', kept: 'no background is deleted' }): Array<string | null> {
  let paths: string[]
  try {
    paths = sideFiles(join(userDataPath, 'state.json'), 'avant-restauration')
  } catch (error) {
    console.warn(`${log.tag} the copies of the state made before a restoration cannot be listed; ${log.kept} at this launch:`, error)
    return [null]
  }
  return paths.map((path) => {
    try {
      return readTextBounded(path, DATA_FILE_MAX_BYTES)
    } catch (error) {
      console.warn(`${log.tag} the copy ${path} cannot be read; ${log.kept} at this launch:`, error)
      return null
    }
  })
}

/**
 * The containers the copies of the state made before a restoration name: the launch sweep leaves their folders (cookies, storage) alone, as it
 * leaves the backgrounds those copies name. Null when a copy cannot be read or is not a state: no folder of a container is removed then.
 */
export function containersNamedBeforeRestore(userDataPath: string): Set<string> | null {
  const named = containersNamedByCopies(copiesBeforeRestore(userDataPath, { tag: '[containers]', kept: 'no folder of a container is removed' }))
  if (named === null) console.warn('[containers] a copy of the state made before a restoration cannot be read as a state; no folder of a container is removed at this launch')
  return named
}

/** Deletes the files of the media folder that no space, no automatic copy and no copy made before a restoration refers to. Returns how many were deleted. */
export function sweepBackgroundMedia(userDataPath: string, spaces: readonly { background?: { type: string; value: string } | undefined }[], copies: readonly SessionCopyData[]): number {
  const mediaDir = join(userDataPath, 'media')
  if (!existsSync(mediaDir)) return 0
  const kept = referencedByStateAndCopies(spaces, copies)
  let names: string[]
  try {
    names = readdirSync(mediaDir)
  } catch (error) {
    // `media` is a file, or cannot be read (ENOTDIR, EACCES): the launch goes on, and nothing is deleted (this runs before any window, outside any try).
    console.warn('[media] the folder of the backgrounds cannot be listed; no background is deleted at this launch:', error)
    return 0
  }
  const unused = names.filter((name) => !kept.has(name))
  if (unused.length === 0) return 0
  // The copies before a restoration are whole state files (megabytes): they are searched for the names, not parsed. A name found anywhere in one keeps its file.
  const beforeRestore = copiesBeforeRestore(userDataPath)
  if (beforeRestore.includes(null)) return 0
  let deleted = 0
  for (const name of unused) {
    if (beforeRestore.some((text) => text!.includes(name))) continue
    try {
      unlinkSync(join(mediaDir, name))
      deleted++
    } catch (error) {
      console.warn(`[media] the unused background ${name} could not be deleted:`, error)
    }
  }
  return deleted
}
