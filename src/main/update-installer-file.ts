// The installer of an update (the NSIS installer of Windows, the AppImage of Linux, the .deb the person is told to install), from the network to a file that is safe to use. The feed (read and signed by a key of the application: update-check.ts)
// names the installer by its address, its size and its SHA-256; nothing else makes the file the one the maintainer published, so nothing else is believed:
// not the https of the download (a server is the party the signature does not trust), and not a file name (the folder and the name below are Lucium's own,
// never taken from the address).
//
// What a download goes through:
// - a folder of its own in the temporary folder, emptied first and created new (a name another program planted there, a link, is not followed or reused);
// - the bytes are counted and hashed as they arrive, written to a `.part` file created exclusively, and stopped at the first byte beyond the size the feed signs;
// - only when the count and the sum are the feed's is the file given its final name: a file with the final name has been checked, and any other end (a
//   refusal, a failure of the network or of the disk) removes the folder, so that nothing half-written or wrong stays where it could be run;
// - `verifyInstallerFile` checks the same things again on the file as it is on the disk, just before it is run (windows-update.ts).

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { rmSync } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SHA256_HEX, type InstallerKind } from '@shared/update-target'
import type { UpdateOffer } from '@shared/update-check'

/** The name of the folder in the temporary folder. */
export const INSTALLER_FOLDER = 'lucium-update'
/** The name the installer is given; Lucium's own, whatever the address says. */
export const INSTALLER_FILE_NAME = 'Lucium-Setup.exe'
/** The most an installer may weigh (the NSIS installer is 140 MB): a signed size above it is a mistake, and nothing that large is written to the disk. */
export const INSTALLER_MAX_BYTES = 1024 * 1024 * 1024
/** The longest a download may take: a connection that stalls does not hold the update for ever. */
export const INSTALLER_TIMEOUT_MS = 30 * 60 * 1000

/** The sort of installer a download is, and the name Lucium gives its file (its own, whatever the address says). Windows' NSIS installer unless told otherwise. */
export interface InstallerSpec {
  kind: InstallerKind
  fileName: string
}

export const NSIS_SPEC: InstallerSpec = { kind: 'nsis', fileName: INSTALLER_FILE_NAME }

/** What the installer of an offer is, as the signed feed says it; null when the offer is not an installer of the sort asked that can be checked. */
export interface InstallerClaim {
  url: string
  sha256: string
  size: number
}

/**
 * The address, the sum and the size of the installer an offer names, or null: the offer must name an installer of the `kind` asked (NSIS unless told otherwise), at an
 * https address, with a SHA-256 of 64 lowercase hexadecimal digits and a size that is a positive whole number within INSTALLER_MAX_BYTES. A feed written for macOS
 * before these keys existed has no `kind`, so it is never taken for an installer.
 */
export function installerClaim(offer: UpdateOffer, wanted: InstallerKind = 'nsis'): InstallerClaim | null {
  const { archive, sha256, size, kind } = offer
  if (kind !== wanted || typeof archive !== 'string' || !/^https:\/\/\S+$/i.test(archive)) return null
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > INSTALLER_MAX_BYTES) return null
  return { url: archive, sha256, size }
}

/** The folder of a download, inside the temporary folder `temp`. */
export const installerFolder = (temp: string): string => join(temp, INSTALLER_FOLDER)

/** The part of a fetch `Response` the download reads. */
export interface DownloadResponse {
  ok: boolean
  status: number
  /** The address the answer came from, after any redirect. */
  url: string
  headers: { get(name: string): string | null }
  body: ReadableStream<Uint8Array> | null
}

export type InstallerFetch = (url: string, init: { cache: 'no-store'; credentials: 'omit'; headers: Record<string, string>; signal: AbortSignal }) => Promise<DownloadResponse>

export type InstallerFailureKind = 'offer' | 'network' | 'mismatch' | 'disk'

export type InstallerDownload = { ok: true; file: string; sha256: string } | { ok: false; kind: InstallerFailureKind; detail: string }

export const refused = (kind: InstallerFailureKind, detail: string): InstallerDownload => ({ ok: false, kind, detail })

export const words = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Ends the body of a download that is refused; a stream that cannot even be cancelled is only logged, the refusal is the answer. */
const stopReading = (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> =>
  reader.cancel().catch((error: unknown) => console.warn(`[update] the body of a refused download could not be cancelled: ${words(error)}`))

/** Takes the folder away, whatever it holds (a link is removed, never followed). A folder that is not there is not a failure. */
export async function discardInstallerFolder(folder: string): Promise<void> {
  await rm(folder, { recursive: true, force: true })
}

/** The same, at once: for the quit, which does not wait for what is asked after it. */
export function discardInstallerFolderNow(folder: string): void {
  rmSync(folder, { recursive: true, force: true })
}

/** What a download needs of the system, the same whatever the installer is. */
export interface DownloadDeps {
  fetch: InstallerFetch
  headers?: Record<string, string>
  timeoutMs?: number
}

/**
 * The bytes of `claim` into `part` (created new: nothing may be there), counted and hashed as they arrive, and the file given its name `target` only when its size and
 * its SHA-256 are the signed ones. `cleanup` runs on every end but success and takes away whatever the download made, so that nothing half-written or wrong stays where
 * it could be used. The failure says which of the four it is: the network failed or refused (`network`), the bytes are not the announced ones (`mismatch`), the disk
 * failed (`disk`).
 */
export async function fetchVerifiedFile(deps: DownloadDeps, claim: InstallerClaim, part: string, target: string, cleanup: () => Promise<void>): Promise<InstallerDownload> {
  const fail = async (result: InstallerDownload): Promise<InstallerDownload> => {
    await cleanup().catch((error: unknown) => console.warn(`[update] what a refused download made could not be removed: ${words(error)}`))
    return result
  }
  let response: DownloadResponse
  try {
    response = await deps.fetch(claim.url, { cache: 'no-store', credentials: 'omit', headers: deps.headers ?? {}, signal: AbortSignal.timeout(deps.timeoutMs ?? INSTALLER_TIMEOUT_MS) })
  } catch (error) {
    return fail(refused('network', words(error)))
  }
  // The body of an answer that is refused is not read: it is cancelled, so that the connection does not stay open for a file nobody wants.
  const refuseAnswer = async (result: InstallerDownload): Promise<InstallerDownload> => {
    await response.body?.cancel().catch((error: unknown) => console.warn(`[update] the body of a refused answer could not be cancelled: ${words(error)}`))
    return fail(result)
  }
  // A redirect to plain http is a hop that could be swapped on the way; the sum would catch the file, but nothing here asks a server that offers it.
  if (response.url && !/^https:\/\//i.test(response.url)) return refuseAnswer(refused('network', 'the download was redirected to an address that is not https'))
  if (!response.ok) return refuseAnswer(refused('network', `the server answered ${response.status}`))
  if (!response.body) return fail(refused('network', 'the server answered without a body'))
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > claim.size) return refuseAnswer(refused('mismatch', `the server declares ${declared} bytes, the feed signs ${claim.size}`))

  const hash = createHash('sha256')
  let count = 0
  let file: Awaited<ReturnType<typeof open>> | null = null
  const reader = response.body.getReader()
  try {
    // 'wx': created new, failing if anything is already there (the caller made sure nothing is).
    file = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  } catch (error) {
    await stopReading(reader)
    return fail(refused('disk', `the file could not be created: ${words(error)}`))
  }
  try {
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>
      try {
        step = await reader.read()
      } catch (error) {
        return await fail(refused('network', words(error)))
      }
      if (step.done) break
      count += step.value.byteLength
      // The first byte beyond the signed size ends the download: nothing more is read or written.
      if (count > claim.size) {
        await stopReading(reader)
        return await fail(refused('mismatch', `the download is larger than the ${claim.size} bytes the feed signs`))
      }
      hash.update(step.value)
      try {
        await file.write(step.value)
      } catch (error) {
        await stopReading(reader)
        return await fail(refused('disk', `the file could not be written: ${words(error)}`))
      }
    }
  } finally {
    await file.close().catch((error: unknown) => console.warn(`[update] the file of the download could not be closed: ${words(error)}`))
  }
  if (count !== claim.size) return fail(refused('mismatch', `the download is ${count} bytes, the feed signs ${claim.size}`))
  const sum = hash.digest('hex')
  if (sum !== claim.sha256) return fail(refused('mismatch', `the SHA-256 of the download is ${sum}, the feed signs ${claim.sha256}`))
  try {
    await rename(part, target)
  } catch (error) {
    return fail(refused('disk', `the file could not be given its name: ${words(error)}`))
  }
  return { ok: true, file: target, sha256: sum }
}

/**
 * Downloads the installer of `offer` into `folder` (a new folder: the one of the earlier download is taken away first) and returns the file once its size
 * and its SHA-256 are the ones the offer carries. Otherwise the folder is removed and the reason says which of the four it is: the offer is not an installer
 * of the sort asked (`offer`, nothing asked of the network), the network failed or refused (`network`), the bytes are not the announced ones (`mismatch`), or the
 * disk failed (`disk`). The NSIS installer of Windows unless `spec` says otherwise.
 */
export async function downloadVerifiedInstaller(deps: DownloadDeps & { folder: string }, offer: UpdateOffer, spec: InstallerSpec = NSIS_SPEC): Promise<InstallerDownload> {
  const claim = installerClaim(offer, spec.kind)
  if (!claim) return refused('offer', `the offer does not name an installer of the kind ${spec.kind} with an https address, a SHA-256 and a size`)
  const target = join(deps.folder, spec.fileName)
  try {
    await discardInstallerFolder(deps.folder)
    // Not recursive: the folder must not exist (it was just taken away), so a program that made one in between makes this fail instead of being used.
    await mkdir(deps.folder, { mode: 0o700 })
  } catch (error) {
    return refused('disk', `the folder of the download could not be made: ${words(error)}`)
  }
  return fetchVerifiedFile(deps, claim, `${target}.part`, target, () => discardInstallerFolder(deps.folder))
}

/**
 * Whether `file` is, right now on the disk, the installer `offer` names: the file of the download folder under Lucium's own name (not another path, not a
 * link, a regular file), of the signed size and of the signed SHA-256. Asked just before the installer is run, so that a file that changed since the download
 * (or never was the one) is not run.
 */
export async function verifyInstallerFile(folder: string, file: string, offer: UpdateOffer, spec: InstallerSpec = NSIS_SPEC): Promise<boolean> {
  if (resolve(file) !== resolve(join(folder, spec.fileName))) return false
  return verifyFileAgainst(file, offer, spec.kind)
}

/** The same check of a file wherever it is: a regular file (not a link) of the signed size and the signed SHA-256. The caller says whether the place is the right one. */
export async function verifyFileAgainst(file: string, offer: UpdateOffer, kind: InstallerKind): Promise<boolean> {
  const claim = installerClaim(offer, kind)
  if (!claim) return false
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== claim.size) return false
    return createHash('sha256').update(await readFile(file)).digest('hex') === claim.sha256
  } catch (error) {
    console.warn(`[update] the installer could not be read for its last check: ${words(error)}`)
    return false
  }
}
