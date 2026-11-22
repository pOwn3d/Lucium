import type { BlockedExtension } from './extension-blocklist'

/**
 * The extensions Lucium refuses, by identifier. The list travels with the application and changes only with its versions: nothing is fetched, nothing is sent
 * (see `blockedExtension`). An entry is added with a release, from a source that can be named in the changelog, and with the reason that fits.
 * It is empty until a first entry has such a source: an identifier written from memory would refuse an honest extension.
 */
export const BLOCKED_EXTENSIONS: readonly BlockedExtension[] = []
