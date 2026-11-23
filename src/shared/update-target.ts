// Which system a release file is for. The file is read by every system the application runs on, and its signature (main/update-feed-signature.ts) is the
// same for all of them: one key signs the feed of macOS, of Windows and of Linux. A signed file of one system served at the address of another is
// therefore a valid file, and a copy that took it would download an installer made for a different system. What stops that is written in the file itself,
// in the bytes the key signs: `platform` and `arch` (the system it is for), and `kind` (the sort of installer it names). A copy reads them against what
// it runs on, and refuses a file that is for another system whatever its signature says.
//
//   { "currentRelease": "1.2.0", "platform": "win32", "arch": "x64", "kind": "nsis", "releases": [ … ], "signatures": […] }
//
// The release files written before these keys existed are the ones of macOS (Squirrel.Mac): a file with none of the three is read as such, by a Mac only
// and as it always was. No Windows or Linux copy believes a file that does not say it is for it.

import { platformOf, type PlatformId } from './platform'

/** The sort of file a feed names: the archive Squirrel.Mac installs, the NSIS installer of Windows, an AppImage, a .deb (Linux: told to the person, never installed silently). */
export type InstallerKind = 'zip' | 'nsis' | 'appimage' | 'deb'

/** The system a copy runs on, or a file is for. `arch` is `process.arch`'s word (`arm64`, `x64`). */
export interface FeedTarget {
  platform: PlatformId
  arch: string
}

/** The systems a release file may be for (`<platform>-<arch>`, also the folder of the server: `updates/<id>/`), and the installers each may name. */
export const INSTALLER_KINDS: Readonly<Record<string, readonly InstallerKind[]>> = {
  'darwin-arm64': ['zip'],
  'win32-x64': ['nsis'],
  'linux-x64': ['appimage', 'deb'],
  'linux-arm64': ['appimage', 'deb']
}

/** The system this copy runs on (`process.platform` and `process.arch`): any Unix other than macOS counts as Linux, as everywhere else (`platformOf`). */
export const runningTarget = (platform: unknown, arch: unknown): FeedTarget => ({ platform: platformOf(platform), arch: typeof arch === 'string' ? arch : '' })

/** What a file says of itself: the sort of installer it names, and whether it is one of the files written before the keys existed (macOS only). */
export type FeedIdentity = { ok: true; kind: InstallerKind; legacy: boolean } | { ok: false }

/** The SHA-256 of a file as the release file writes it (update-feed-file.ts): 64 lowercase hexadecimal digits. */
export const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * Whether `feed` (the release file, as parsed) is for `running`, and what it names. Refused when:
 * - it says it is for a system other than the running one (`platform` or `arch` differ), or for one no build exists for;
 * - it gives only part of its identity (a `platform` without an `arch`, a `kind` alone), or a `kind` the system does not take;
 * - it gives none of the three and the running system is not macOS: only the files written for macOS before the keys existed may omit them.
 * A file that names `platform` and `arch` but no `kind` is read as a `zip` on macOS, and refused anywhere else (an installer must be named, not guessed).
 */
export function readFeedIdentity(feed: Record<string, unknown>, running: FeedTarget): FeedIdentity {
  const { platform, arch, kind } = feed
  if (platform === undefined && arch === undefined && kind === undefined) return running.platform === 'darwin' ? { ok: true, kind: 'zip', legacy: true } : { ok: false }
  if (typeof platform !== 'string' || typeof arch !== 'string') return { ok: false }
  // The id always holds a hyphen, which no property of Object.prototype does: a word like `constructor` finds nothing.
  const taken = INSTALLER_KINDS[`${platform}-${arch}`]
  if (!taken || platform !== running.platform || arch !== running.arch) return { ok: false }
  const named = kind === undefined && platform === 'darwin' ? 'zip' : kind
  const installer = taken.find((candidate) => candidate === named)
  return installer ? { ok: true, kind: installer, legacy: false } : { ok: false }
}
