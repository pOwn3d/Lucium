// How the new AppImage is started once the old one has been replaced (Linux). Pure, and free of Node: the environment, the paths and the pid are given.
//
// Why not `app.relaunch()`: Electron starts the new file from a « relauncher » process that is a child of the OLD AppImage, so it lives inside the old runtime's
// FUSE mount and cgroup. The static AppImage runtime is its own FUSE server and ends with its child (lazy unmount, `fusermount3 -u -z`); the new AppImage, started a
// few milliseconds before that, was seen to die at that very moment, before it had even mounted its own file system (VM trial of 24 November 2026: it works with
// `APPIMAGE_EXTRACT_AND_RUN=1`, which uses no FUSE, and it works when started by hand).
//
// So the new copy is started by a helper that belongs to nobody: a detached shell (its own session, started BEFORE the quit, so a failure to start is still told to the
// person) which waits for the old process to be gone, then a short grace for the old runtime to unmount, and only then `exec`s the new file with an environment cleaned of
// what the old AppImage set. The wait is also what the single-instance lock needs: a second instance started while the first lives finds it and gives up.

/** The variables the AppImage runtime and its AppRun set for the copy that runs; the next copy must set its own. */
const APPIMAGE_VARIABLES: readonly string[] = ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']

/** Lists of paths an AppRun prepends its own mount to; only the entries under the old mount are taken out, the person's own entries stay. */
const PATH_LISTS: readonly string[] = ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'PATH', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'GSETTINGS_SCHEMA_DIR', 'GIO_EXTRA_MODULES', 'PYTHONPATH', 'PERLLIB', 'QT_PLUGIN_PATH', 'GST_PLUGIN_SYSTEM_PATH']

/** A mount of an AppImage runtime: `/tmp/.mount_<name><random>`, or an extracted copy (`/tmp/appimage_extracted_<id>`). */
const MOUNT_PATTERN = /^\/(?:[^/]+\/)*(?:\.mount_[^/]+|appimage_extracted_[^/]+)(?:\/|$)/

/** The longest the helper waits for the old process to end, in seconds: after that it starts the new copy anyway (which then finds the first one, if it still lives). */
export const RELAUNCH_WAIT_SECONDS = 30

/** The grace, in seconds, after the old process is gone: the old runtime unmounts its file system just after its child ends. */
export const RELAUNCH_GRACE_SECONDS = 1

/**
 * The script of the helper (`/bin/sh -c`): `$1` is the pid to wait for, `$2` the file to start, `$3` the seconds to wait at most, `$4` the grace. `exec` so that the new
 * AppImage is the process the helper became, with nothing of ours left around it. The file is always a quoted argument, never a part of the script.
 */
export const RELAUNCH_SCRIPT = 'i=0; while kill -0 "$1" 2>/dev/null && [ "$i" -lt "$(( $3 * 10 ))" ]; do sleep 0.1; i=$(( i + 1 )); done; sleep "$4"; exec "$2"'

/** The command that starts the new AppImage, as `child_process.spawn` takes it. */
export interface AppImageRelaunch {
  command: string
  args: string[]
  env: Record<string, string>
  /** A folder that survives the old mount (the one of the file), never the working folder of the old copy. */
  cwd: string
}

/** The environment of the new copy: the one of the old, without the variables of the old AppImage and without the entries of its mount in the path lists. */
export function cleanedEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const appDir = env.APPDIR
  const ofOldMount = (entry: string): boolean => (appDir !== undefined && appDir !== '' && (entry === appDir || entry.startsWith(`${appDir}/`))) || MOUNT_PATTERN.test(entry)
  const cleaned: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || APPIMAGE_VARIABLES.includes(name)) continue
    if (PATH_LISTS.includes(name)) {
      const kept = value.split(':').filter((entry) => entry !== '' && !ofOldMount(entry))
      if (kept.length > 0) cleaned[name] = kept.join(':')
      continue
    }
    cleaned[name] = value
  }
  return cleaned
}

/** The folder of a POSIX file path (`/` for a file at the root). */
const folderOf = (file: string): string => file.slice(0, Math.max(file.lastIndexOf('/'), 1))

/** What to run to start `file` once the process `pid` has ended. */
export function appImageRelaunch(file: string, pid: number, env: Readonly<Record<string, string | undefined>>): AppImageRelaunch {
  return {
    command: '/bin/sh',
    args: ['-c', RELAUNCH_SCRIPT, 'lucium-relaunch', String(pid), file, String(RELAUNCH_WAIT_SECONDS), String(RELAUNCH_GRACE_SECONDS)],
    env: cleanedEnvironment(env),
    cwd: folderOf(file)
  }
}
