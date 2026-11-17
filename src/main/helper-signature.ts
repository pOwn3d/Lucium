// The signature of a helper of Contents/Helpers/ is checked before the helper is started.
//
// The fuses protect app.asar, not Contents/Helpers/: a helper replaced on the disk would read the texts of the pages sent to the system's translation,
// and answer what it likes. So before a helper runs, /usr/bin/codesign checks it against a requirement made here:
//  - the application signed with a Developer ID (its team read by codesign on this very process, as the system checked it at launch): the helper must
//    be signed by the same team, under its own identifier (`identifier "…" and anchor apple generic and certificate leaf[subject.OU] = "<team>"`);
//  - an application without a team (signed ad hoc, or run from the sources) has nothing to compare: a helper of `adHoc: 'refuse'` is then not started
//    at all, the translation helper (`adHoc: 'identifier'`) only when its signature is intact and names its identifier (a check of integrity, not of
//    authenticity).
// The verdict is kept for as long as the helper's files are the same (device, inode, size, times of its program and of its seal): a file replaced
// or rewritten is checked again. The helper itself checks the process that starts it (native/shared/caller.swift).
// The keychain helper of the password vault is not one of these: it is an XPC service, and the system checks its signature on every answer it
// sends (vault-keychain.ts, native/vault-xpc/).
//
// codesign runs with an empty environment, by its absolute path, never through a shell, and only when a helper is about to be started.

import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** codesign of the system: never one found on a PATH. */
export const CODESIGN = '/usr/bin/codesign'
const CODESIGN_TIMEOUT_MS = 10_000
/** A team identifier as Apple gives them. */
const TEAM = /^[A-Z0-9]{10}$/
/** A bundle identifier as the helpers have them (Info.plist of native/…): what may be written in a requirement. */
const IDENTIFIER = /^[A-Za-z0-9.-]{1,128}$/

/** What codesign answered: its exit status and its error output (where it writes what it displays). */
export type RunCodesign = (args: readonly string[]) => { status: number | null; stderr: string }

const runCodesign: RunCodesign = (args) => {
  const result = spawnSync(CODESIGN, [...args], { encoding: 'utf8', env: {}, timeout: CODESIGN_TIMEOUT_MS, stdio: ['ignore', 'ignore', 'pipe'] })
  return { status: result.status, stderr: typeof result.stderr === 'string' ? result.stderr : '' }
}

/** The team that signed the process `pid`, as the system knows it (codesign reads the running code); null without one (ad hoc, unsigned, unreadable). */
export function teamOfProcess(pid: number, run: RunCodesign = runCodesign): string | null {
  const { status, stderr } = run(['-d', '--verbose=2', String(pid)])
  if (status !== 0) return null
  const team = /^TeamIdentifier=(.*)$/m.exec(stderr)?.[1]?.trim() ?? ''
  return TEAM.test(team) ? team : null
}

/** The requirement a helper of `team` meets: its own identifier, a certificate of Apple's chain, the application's team. */
export function helperRequirement(identifier: string, team: string): string {
  if (!IDENTIFIER.test(identifier) || !TEAM.test(team)) throw new Error('not an identifier and a team of a helper')
  return `identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${team}"`
}

/** A helper as the application carries it. */
export interface HelperIdentity {
  /** Its program: <Helper>.app/Contents/MacOS/<name>. */
  executable: string
  /** The identifier its bundle is signed under (its Info.plist in native/…). */
  identifier: string
  /** What an application without a team does with it: never start it, or start it when its signature is intact under its identifier. */
  adHoc: 'refuse' | 'identifier'
}

export interface HelperTrustDeps {
  run?: RunCodesign
  /** The team of this application (default: read once on this process). */
  team?: () => string | null
  /** What identifies the helper's files on the disk now; null when they are not there. */
  fingerprint?: (executable: string) => string | null
}

/** The bundle of a helper's program (…/X.app/Contents/MacOS/x → …/X.app). */
export const bundleOf = (executable: string): string => dirname(dirname(dirname(executable)))

/**
 * The device, inode, size and times of the program, of the seal of the bundle and of its Info.plist: what a replacement or a rewrite of any
 * of them changes. Info.plist is read before each start (the protocol the helper speaks, translate/system.ts) on the word of the signature:
 * a change to it must ask codesign again, like a change to the program.
 */
export function helperFilesFingerprint(executable: string): string | null {
  try {
    const contents = join(bundleOf(executable), 'Contents')
    return [executable, join(contents, '_CodeSignature', 'CodeResources'), join(contents, 'Info.plist')]
      .map((path) => {
        const info = statSync(path)
        return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
      })
      .join('|')
  } catch {
    return null
  }
}

let ownTeam: string | null | undefined
/** The team of this application, read at the first need and kept: the signature of a running program does not change. */
const applicationTeam = (): string | null => (ownTeam === undefined ? (ownTeam = teamOfProcess(process.pid)) : ownTeam)

const verdicts = new Map<string, { fingerprint: string; trusted: boolean }>()

/**
 * THE GUARD: whether `helper` may be started now. Its signature is checked by codesign against the requirement above when it was never
 * checked or its files changed since; a helper that is missing or does not meet it is not started (logged once, by name).
 */
export function isTrustedHelper(helper: HelperIdentity, deps: HelperTrustDeps = {}): boolean {
  const fingerprint = (deps.fingerprint ?? helperFilesFingerprint)(helper.executable)
  if (fingerprint === null) return false
  const known = verdicts.get(helper.executable)
  if (known?.fingerprint === fingerprint) return known.trusted
  const team = (deps.team ?? applicationTeam)()
  const run = deps.run ?? runCodesign
  let trusted: boolean
  if (team !== null) trusted = run(['--verify', '--strict', `-R=${helperRequirement(helper.identifier, team)}`, bundleOf(helper.executable)]).status === 0
  else if (helper.adHoc === 'identifier' && IDENTIFIER.test(helper.identifier)) trusted = run(['--verify', '--strict', `-R=identifier "${helper.identifier}"`, bundleOf(helper.executable)]).status === 0
  else trusted = false
  verdicts.set(helper.executable, { fingerprint, trusted })
  if (!trusted) console.warn(`[helpers] ${basename(bundleOf(helper.executable))} is not signed as a helper of this application${team === null ? ' (the application has no team to compare)' : ''}: it is not started`)
  return trusted
}

/** Forgets the verdicts and the team (tests). */
export function forgetHelperVerdicts(): void {
  verdicts.clear()
  ownTeam = undefined
}
