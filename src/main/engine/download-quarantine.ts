// The "downloaded from the Internet" mark of macOS (the `com.apple.quarantine` attribute). A browser on the Mac puts it on every file it downloads; Electron's
// downloads come out without it (measured on Electron 45: a downloaded file carries only `com.apple.provenance`), so Gatekeeper never checks an application,
// an installer or a script that was downloaded, and the system never says "downloaded from the Internet" when it is first opened. The mark is put on here,
// in the format of the attribute (`flags;time in hexadecimal;application;identifier`), with the system's own `xattr` (there is no call for it in Node or Electron).

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/** What the mark says it comes from: the name the system shows beside it. */
export const QUARANTINE_AGENT = 'Lucium'
/** The flags of a web download, not yet approved by the user. */
export const QUARANTINE_FLAGS = '0083'
const XATTR = '/usr/bin/xattr'
const XATTR_TIMEOUT_MS = 5000

/** The value of the attribute for a download that ended at `now`. */
export const quarantineValue = (now: number, id: string): string => `${QUARANTINE_FLAGS};${Math.floor(now / 1000).toString(16)};${QUARANTINE_AGENT};${id}`

/** Runs a program with arguments (no shell) and rejects when it fails: a seam for the tests. */
export type RunProgram = (program: string, args: readonly string[]) => Promise<void>

const runProgram: RunProgram = (program, args) =>
  new Promise((resolve, reject) => {
    execFile(program, [...args], { timeout: XATTR_TIMEOUT_MS }, (error, _stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve()))
  })

export interface QuarantinePorts {
  platform?: NodeJS.Platform
  now?: () => number
  uuid?: () => string
  run?: RunProgram
}

export type QuarantineOutcome = { ok: true } | { ok: false; reason: string }

/**
 * Marks the file as downloaded from the Internet. Only on macOS (nothing is run elsewhere); never throws: a file that could not be marked is the outcome, and the
 * caller says so to the user. The path is passed as an argument, never to a shell, and must be absolute (it is the engine's own, but a file name starting with a
 * dash must not be taken for an option).
 */
export async function quarantineDownload(path: string, ports: QuarantinePorts = {}): Promise<QuarantineOutcome> {
  if ((ports.platform ?? process.platform) !== 'darwin') return { ok: true }
  if (!path.startsWith('/')) return { ok: false, reason: 'the path of the file is not absolute' }
  try {
    await (ports.run ?? runProgram)(XATTR, ['-w', 'com.apple.quarantine', quarantineValue((ports.now ?? Date.now)(), (ports.uuid ?? randomUUID)().toUpperCase()), path])
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** How many times the mark is tried while a download runs: the file may not exist yet at the first sign of progress. */
export const EARLY_MARK_TRIES = 3

/**
 * The mark of a download that is still running. The file is written under its final name, so a file whose server announced more bytes than it
 * sends (and then keeps the connection open) is whole on disk, named as the finished one, for as long as the download "runs": opened from the
 * Finder, it must already carry the mark. `progress` is called with each sign of progress; the mark is put once, as soon as something was
 * written, and tried again a few times when it fails (the file not there yet). The mark put when the download ends stays the one that counts:
 * a failure here is only logged.
 */
export function earlyQuarantine(path: () => string, mark: (path: string) => Promise<QuarantineOutcome> = quarantineDownload, log: (message: string) => void = (message) => console.debug(message)): (receivedBytes: number) => void {
  let tries = 0
  let busy = false
  let done = false
  return (receivedBytes) => {
    if (done || busy || receivedBytes <= 0 || tries >= EARLY_MARK_TRIES) return
    tries++
    busy = true
    const target = path()
    void mark(target).then((outcome) => {
      busy = false
      if (outcome.ok) done = true
      else log(`[downloads] cannot mark a running download as downloaded from the Internet yet (try ${tries} of ${EARLY_MARK_TRIES}): ${outcome.reason}`)
    })
  }
}
