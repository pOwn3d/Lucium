// The id of a tab container. It names a storage partition on disk, so it is a plain slug and nothing else: this file is a leaf (no imports)
// so that the cleaners of state-clean.ts and the engine can both use it without a cycle.

/** Lower case letters, digits and dashes, starting with a letter or digit: short enough for a folder name, never a path. */
const CONTAINER_ID = /^[a-z0-9][a-z0-9-]{0,23}$/

export const isContainerId = (value: unknown): value is string => typeof value === 'string' && CONTAINER_ID.test(value)

/** The name of the folder under `Partitions/` that holds a container's data (Chromium names it after the partition). */
export const CONTAINER_DIR_PREFIX = 'container-'

/** The Electron partition of a container: persistent, and apart from every profile's (`persist:profile-<id>`). */
export const containerPartition = (id: string): string => `persist:${CONTAINER_DIR_PREFIX}${id}`

/** The key the engine gives the browsing context of a container (never a valid profile id: it holds a colon). */
export const containerScopeKey = (id: string): string => `container:${id}`

/** The container id a `Partitions/` folder name stands for, or null when the folder is not a container's. */
export function containerIdOfDir(dirName: string): string | null {
  if (!dirName.startsWith(CONTAINER_DIR_PREFIX)) return null
  const id = dirName.slice(CONTAINER_DIR_PREFIX.length)
  return isContainerId(id) ? id : null
}
