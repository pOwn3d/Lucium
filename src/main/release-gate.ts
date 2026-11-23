// What a version must show before scripts/publish-update.mjs sends anything (docs/community/release-process.md, « The conditions of a publication »).
// Not part of the application (nothing in it imports this file); the scripts read it with Node's own TypeScript, so it imports nothing.
//
// A publication used to rest on the maintainer remembering each step: 0.2.15 reached the test channel and the stable channel 19 seconds apart, on an
// engine nobody had meant to ship, and nothing kept a trace of what was sent. Each condition below is a file that a step of the release leaves,
// read here and refused with the way to make it:
//   - the build record, written by scripts/build-drm-release.sh beside the archive: the commit the archive was built from, and its SHA-256;
//   - the record of the engine run (`pnpm test:engine:release`): the suites passed, on that very commit;
//   - the changelogs: the section of the version carries its date;
//   - for the stable channel, the journal (the version was published on the test channel, this very archive, long enough ago) and the attestation,
//     a file the maintainer fills in: Netflix plays, Touch ID unlocks the vault, the update from the previous version installs.
// The journal is the trace: one line per publication, in a file outside the repository. A withdrawal adds a line of its own type; the lock of
// the stable channel reads those of the test channel, and a publication reads those of its own channel to list the withdrawn versions in the feed.
//
// A condition is never lifted by an option that can be passed by habit: the two ways out (`--no-engine-run`, `--security-fix`, read by
// publish-update.ts) take a reason, and the reason is written in the journal with the publication.

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Small readers

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const VERSION = /^\d+\.\d+\.\d+$/

/** The date a text names, when it is a full ISO date with its time and zone (what `Date.prototype.toISOString` writes); null for anything else. */
function isoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

/** Whether `a` is a lower version than `b` ("0.2.15" before "0.3.0"); both are three numbers. */
function isLowerVersion(a: string, b: string): boolean {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let at = 0; at < 3; at++) if (left[at] !== right[at]) return (left[at] ?? 0) < (right[at] ?? 0)
  return false
}

/** A reason shorter than this says nothing ("n/a", "ok"). */
export const MIN_REASON = 20

const hours = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000)
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The build record: which commit an archive was built from

export interface WeighedFile {
  name: string
  sha256: string
  size: number
}

export interface BuildRecord {
  version: string
  /** The commit of the working tree when the build started. */
  commit: string
  /**
   * False when a tracked file was modified during the build, when a file Git does not track lay in a folder the build reads (release-records.ts
   * `BUILT_FOLDERS`), or when the commit moved under it: the archive is then the build of no commit.
   */
  clean: boolean
  builtAt: string
  archive: WeighedFile
}

/** The record scripts/build-drm-release.sh --notarize writes beside the archive. */
export const buildRecordNameOf = (version: string): string => `Lucium-${version}-arm64.build.json`

/** The record of a build: `start` is what Git said before the build, `end` after the archive was written. */
export function buildRecordOf(input: { version: string; archive: WeighedFile; start: { commit: string; modified: boolean }; end: { commit: string; modified: boolean }; now: Date }): BuildRecord {
  return {
    version: input.version,
    commit: input.start.commit,
    clean: !input.start.modified && !input.end.modified && input.start.commit === input.end.commit,
    builtAt: input.now.toISOString(),
    archive: input.archive
  }
}

function weighedFileOf(value: unknown): WeighedFile | null {
  if (!isRecord(value)) return null
  const { name, sha256, size } = value
  return typeof name === 'string' && typeof sha256 === 'string' && SHA256.test(sha256) && typeof size === 'number' && Number.isInteger(size) && size > 0 ? { name, sha256, size } : null
}

/** The record a file holds, or why it is not one. */
export function readBuildRecord(text: string): { record: BuildRecord } | { problem: string } {
  const data = parseObject(text)
  if (!data) return { problem: 'it is not a JSON object' }
  const archive = weighedFileOf(data['archive'])
  if (typeof data['version'] !== 'string' || !VERSION.test(data['version'])) return { problem: 'it has no version' }
  if (typeof data['commit'] !== 'string' || !COMMIT.test(data['commit'])) return { problem: 'it has no commit (40 hexadecimal digits)' }
  if (typeof data['clean'] !== 'boolean') return { problem: 'it does not say whether the working tree was clean' }
  if (!isoDate(data['builtAt'])) return { problem: 'it has no date' }
  if (!archive) return { problem: 'it does not name the archive with its SHA-256 and size' }
  return { record: { version: data['version'], commit: data['commit'], clean: data['clean'], builtAt: String(data['builtAt']), archive } }
}

/** Why the archive at hand is not the build this record describes, or was built from no commit. Empty when it is. */
export function buildRecordProblems(record: BuildRecord, want: { version: string; archive: WeighedFile }): string[] {
  const problems: string[] = []
  if (record.version !== want.version) problems.push(`it is the record of ${record.version}, not of ${want.version}`)
  if (record.archive.name !== want.archive.name) problems.push(`it names ${record.archive.name}, the archive is ${want.archive.name}`)
  if (record.archive.sha256 !== want.archive.sha256 || record.archive.size !== want.archive.size) {
    problems.push(`it describes an archive of ${record.archive.size} bytes with SHA-256 ${record.archive.sha256}, the one at hand has ${want.archive.size} bytes and ${want.archive.sha256}: the archive was made again without its record`)
  }
  if (!record.clean) problems.push(`the working tree was modified when ${record.commit.slice(0, 12)} was built (a tracked file changed, an untracked file lay in a folder the build reads, or the commit moved): the archive is the build of no commit. Commit, then build again`)
  return problems
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The engine run: the suites passed on the commit that was built

/**
 * The steps of `pnpm test:engine:release`, in order. The chain itself (`test:engine`) is recorded and not judged by its exit code: the reference of
 * the engine (compat/baseline-electron-<version>.json) holds the checks that are known to fail, and `compat:compare` is what says whether this run
 * lost anything against it. The three others must end with 0.
 */
export const ENGINE_RUN_STEPS: readonly { name: string; script: string; decides: boolean }[] = [
  { name: 'engine', script: 'test:engine', decides: false },
  { name: 'compare', script: 'compat:compare', decides: true },
  { name: 'webstore', script: 'test:engine:webstore', decides: true },
  { name: 'extwindows', script: 'test:engine:extwindows', decides: true }
]

export interface EngineRunRecord {
  commit: string
  /** False when a tracked file was modified during the run, or the commit moved under it. */
  clean: boolean
  startedAt: string
  endedAt: string
  /** The exit code of each step of ENGINE_RUN_STEPS, by name; null when it did not end (killed, not started). */
  steps: Record<string, number | null>
  /** The SHA-256 of the report the chain wrote (out-engine/report.json), null when it wrote none. */
  reportSha256: string | null
}

/** Where `pnpm test:engine:release` writes its record, relative to the root of the repository (out-engine/ is not in Git). */
export const ENGINE_RUN_FILE = 'out-engine/release-run.json'

export function readEngineRun(text: string): { record: EngineRunRecord } | { problem: string } {
  const data = parseObject(text)
  if (!data) return { problem: 'it is not a JSON object' }
  if (typeof data['commit'] !== 'string' || !COMMIT.test(data['commit'])) return { problem: 'it has no commit (40 hexadecimal digits)' }
  if (typeof data['clean'] !== 'boolean') return { problem: 'it does not say whether the working tree was clean' }
  if (!isoDate(data['startedAt']) || !isoDate(data['endedAt'])) return { problem: 'it has no dates' }
  if (!isRecord(data['steps'])) return { problem: 'it has no steps' }
  const steps: Record<string, number | null> = {}
  for (const [name, code] of Object.entries(data['steps'])) {
    if (code !== null && (typeof code !== 'number' || !Number.isInteger(code))) return { problem: `the step "${name}" has no exit code` }
    steps[name] = code
  }
  const report = data['reportSha256']
  if (report !== null && (typeof report !== 'string' || !SHA256.test(report))) return { problem: 'the SHA-256 of the report is not one' }
  return { record: { commit: data['commit'], clean: data['clean'], startedAt: String(data['startedAt']), endedAt: String(data['endedAt']), steps, reportSha256: report } }
}

/** Why this run does not show that the suites passed on `commit`. Empty when it does. */
export function engineRunProblems(record: EngineRunRecord, commit: string): string[] {
  const problems: string[] = []
  if (record.commit !== commit) problems.push(`the suites ran on ${record.commit.slice(0, 12)}, the archive was built from ${commit.slice(0, 12)}`)
  if (!record.clean) problems.push('the working tree was modified while the suites ran (a tracked file changed, or the commit moved): they ran on no commit')
  if (record.reportSha256 === null) problems.push('the chain wrote no report (out-engine/report.json): it did not reach its end')
  for (const step of ENGINE_RUN_STEPS) {
    // A step the record does not have did not run: never read as passed.
    const code = Object.prototype.hasOwnProperty.call(record.steps, step.name) ? record.steps[step.name] : undefined
    if (code === undefined) problems.push(`the step "${step.name}" (pnpm ${step.script}) is not in the record`)
    else if (step.decides && code !== 0) problems.push(`pnpm ${step.script} ended with ${code === null ? 'no exit code' : `code ${code}`}`)
  }
  return problems
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The changelogs: the section of the version carries its date

/**
 * Why the heading of `version` in a changelog is not the heading of a published version, or null. The rule of the file: at release time
 * « Unreleased » becomes the date. A version that is published while its heading still says « Unreleased » stays so for good.
 */
export function changelogHeadingProblem(text: string, version: string, file: string): string | null {
  const heading = text.split('\n').find((line) => line.startsWith(`## [${version}]`))
  if (heading === undefined) return `${file} has no section "## [${version}]"`
  const date = /^## \[\d+\.\d+\.\d+\] - (\d{4})-(\d{2})-(\d{2})$/.exec(heading.trimEnd())
  if (!date) return `${file}: the heading of ${version} is "${heading.trim()}", not "## [${version}] - YYYY-MM-DD": write the date of the release in it (step 3 of the release)`
  const [, year, month, day] = date
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) return `${file}: "${heading.trim()}" does not carry a date that exists`
  return null
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The journal: one line per publication

/**
 * The system a line of the journal is about when it names none: the Mac, which the journal knew alone before the other systems were published. The lock of the
 * stable channel and the list of withdrawn versions are read by system: what was published or withdrawn for one says nothing of another.
 */
export const MAC_TARGET = 'darwin-arm64'

/** What the server holds when a publication ends: everything it was meant to (`published`), or less (`partial`, with what in `holds`). */
export interface JournalEntry {
  at: string
  version: string
  channel: string
  outcome: 'published' | 'partial'
  /** What the server holds, in the words of the publication ("archive, disk image and feed"). */
  holds: string
  /** The commit of the build record. */
  commit: string
  archive: WeighedFile
  /** The disk image, null when none was published. */
  dmg: WeighedFile | null
  /** The tag of the version when it exists, and whether Git could verify its signature. */
  tag: { name: string; signatureVerified: boolean } | null
  /** The engine run the publication rests on, or the reason it went without one. */
  engineRun: { endedAt: string; reportSha256: string | null } | { waived: string }
  /** The system an installer is for (`win32-x64`, `linux-x64`, `linux-arm64`) and its kind; absent for the Mac, whose lines are as they always were. */
  platform?: string
  kind?: string
  /** For the stable channel: what let the version in. */
  stable?: {
    testPublishedAt: string
    minTestHours: number
    attestedBy: string
    attestedAt: string
    /** The reason given to `--security-fix`, when the delay was not waited for. */
    securityFix: string | null
  }
}

/** The line of an entry, as the journal keeps it: one JSON object, then a newline. */
export const journalLine = (entry: JournalEntry): string => `${JSON.stringify(entry)}\n`

/** The `type` of the line a withdrawal adds. A line of a publication has no `type`. */
export const WITHDRAWAL = 'withdrawal'

/**
 * What the journal keeps of a withdrawal (`--withdraw`). It is not a publication: it names no archive and no commit, and it never counts as a
 * passage through a channel. It is kept so that the journal says why a version it shows as published is no longer offered, and so that a
 * version taken out of the test channel does not go to stable (`stableGate`).
 */
export interface WithdrawalEntry {
  at: string
  type: typeof WITHDRAWAL
  version: string
  channel: string
  /** `withdrawn` when the files of the version answer 404 and the feed was checked; `partial` when the withdrawal stopped after it changed the server. */
  outcome: 'withdrawn' | 'partial'
  /** What the channel offers afterwards, in the words of the withdrawal. */
  offers: 'unchanged' | 'earlier version' | 'nothing'
  /** The version the feed went back to; null when the feed was left as it was, or taken away. */
  to: string | null
  /** The system whose channel it was withdrawn from; absent for the Mac. */
  platform?: string
}

export const withdrawalLine = (entry: WithdrawalEntry): string => `${JSON.stringify(entry)}\n`

const isWithdrawal = (data: Record<string, unknown>): boolean =>
  isoDate(data['at']) !== null && typeof data['version'] === 'string' && typeof data['channel'] === 'string' && (data['outcome'] === 'withdrawn' || data['outcome'] === 'partial')

/** The withdrawals a journal holds, in the order they were written. Lines that are not withdrawals are left to `readJournal`. */
export function readWithdrawals(text: string): WithdrawalEntry[] {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? null : parseObject(line)))
    .filter((data): data is Record<string, unknown> => data !== null && data['type'] === WITHDRAWAL && isWithdrawal(data))
    .map((data) => data as unknown as WithdrawalEntry)
}

/**
 * The versions the journal shows as withdrawn from a channel and not published there again since. A withdrawal that stopped half way counts (the
 * maintainer meant the version to go); a publication that stopped half way puts nothing back. It is what a publication writes in the feed for the
 * copies that still run one of them, with what the feed in place already lists: a channel left without a feed has no feed to carry the list.
 */
export function withdrawnOn(input: { entries: readonly JournalEntry[]; withdrawals: readonly WithdrawalEntry[]; channel: string; platform?: string }): string[] {
  const time = (iso: string): number => new Date(iso).getTime()
  const platform = input.platform ?? MAC_TARGET
  const last = new Map<string, number>()
  for (const entry of input.withdrawals) {
    if (entry.channel !== input.channel || (entry.platform ?? MAC_TARGET) !== platform || !VERSION.test(entry.version)) continue
    last.set(entry.version, Math.max(last.get(entry.version) ?? 0, time(entry.at)))
  }
  return [...last]
    .filter(([version, at]) => !input.entries.some((entry) => entry.channel === input.channel && (entry.platform ?? MAC_TARGET) === platform && entry.version === version && entry.outcome === 'published' && time(entry.at) > at))
    .map(([version]) => version)
}

/**
 * The entries of a journal, and the lines that are not entries. Only what the conditions read is checked (the date, the version, the channel, the
 * outcome, the archive); an entry keeps everything else it was written with. The line of a withdrawal is neither: it is not a publication, so it
 * is not an entry, and it belongs to the journal, so it is not a problem (`readWithdrawals` reads those).
 */
export function readJournal(text: string): { entries: JournalEntry[]; problems: string[] } {
  const entries: JournalEntry[] = []
  const problems: string[] = []
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return
    const data = parseObject(line)
    if (data && data['type'] === WITHDRAWAL) {
      if (!isWithdrawal(data)) problems.push(`line ${index + 1} is not an entry`)
      return
    }
    const archive = data ? weighedFileOf(data['archive']) : null
    if (!data || !archive || !isoDate(data['at']) || typeof data['version'] !== 'string' || typeof data['channel'] !== 'string' || (data['outcome'] !== 'published' && data['outcome'] !== 'partial')) {
      problems.push(`line ${index + 1} is not an entry`)
      return
    }
    entries.push({ ...(data as unknown as JournalEntry), archive })
  })
  return { entries, problems }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The attestation: what the maintainer tried by hand on the version of the test channel

/** The three things a version must have shown on the test channel before it goes to stable. */
export const ATTESTED_CHECKS = ['netflixPlays', 'touchIdUnlocksTheVault', 'updateFromPreviousVersion'] as const

/**
 * What an installer of Windows or Linux must have shown on the test channel: it installs on a real machine of its system (not a runner or a virtual machine
 * of another architecture), and the update from the previous version installs. Netflix and Touch ID are the Mac's.
 */
export const INSTALLER_ATTESTED_CHECKS = ['installsOnARealMachine', 'updateFromPreviousVersion'] as const

/** The attestation beside the archive, unless `--attestation` names another file. */
export const attestationNameOf = (version: string): string => `Lucium-${version}-arm64.attestation.json`

/** The file to fill in, shown when it is missing: every check is false until the maintainer has made it. */
export function attestationTemplate(version: string, sha256: string, platform?: string): string {
  return `${JSON.stringify(
    {
      version,
      ...(platform ? { platform } : {}),
      archiveSha256: sha256,
      attestedBy: '',
      attestedAt: 'YYYY-MM-DDTHH:MM:SSZ',
      checks: Object.fromEntries((platform ? INSTALLER_ATTESTED_CHECKS : ATTESTED_CHECKS).map((name) => [name, false])),
      updatedFrom: 'X.Y.Z'
    },
    null,
    2
  )}\n`
}

export interface Attestation {
  attestedBy: string
  attestedAt: string
}

/**
 * Why an attestation does not let `version` into the stable channel. Empty when it does (`attestation` is then what the journal keeps of it).
 * - it is the attestation of this version and of this very archive (its SHA-256): one written for another build says nothing of this one;
 * - each check is `true`. `updateFromPreviousVersion` may instead be `{ "notApplicable": "<reason>" }`, for a version no earlier one can update
 *   to (a new identifier): the reason is the maintainer's written choice;
 * - `updatedFrom` names the earlier version the update was installed from;
 * - it is signed with a name and dated after the version reached the test channel (what was tried is what the channel serves), not in the future.
 */
export function attestationProblems(text: string, want: { version: string; sha256: string; testPublishedAt: Date | null; now: Date; platform?: string }): { problems: string[]; attestation: Attestation | null } {
  const data = parseObject(text)
  if (!data) return { problems: ['it is not a JSON object'], attestation: null }
  const problems: string[] = []
  if (data['version'] !== want.version) problems.push(`it is the attestation of ${JSON.stringify(data['version'])}, not of ${want.version}`)
  // What was tried on one system says nothing of another: the attestation of an installer names its system.
  if (want.platform !== undefined && data['platform'] !== want.platform) problems.push(`it is the attestation of ${JSON.stringify(data['platform'])}, not of ${want.platform}: what was tried on one system says nothing of another`)
  if (data['archiveSha256'] !== want.sha256) problems.push(`it attests the archive ${JSON.stringify(data['archiveSha256'])}, the one being published has SHA-256 ${want.sha256}: what was tried is not what goes to stable`)
  const checks = isRecord(data['checks']) ? data['checks'] : {}
  for (const name of want.platform === undefined ? ATTESTED_CHECKS : INSTALLER_ATTESTED_CHECKS) {
    const value = Object.prototype.hasOwnProperty.call(checks, name) ? checks[name] : undefined
    if (value === true) continue
    if (name === 'updateFromPreviousVersion' && isRecord(value) && typeof value['notApplicable'] === 'string') {
      if (value['notApplicable'].trim().length < MIN_REASON) problems.push(`checks.${name}.notApplicable must say why, in at least ${MIN_REASON} characters`)
      continue
    }
    problems.push(`checks.${name} is not true`)
  }
  if (checks['updateFromPreviousVersion'] === true) {
    const from = data['updatedFrom']
    if (typeof from !== 'string' || !VERSION.test(from)) problems.push('updatedFrom must name the version the update was installed from ("X.Y.Z")')
    else if (!isLowerVersion(from, want.version)) problems.push(`updatedFrom is ${from}, which is not an earlier version than ${want.version}`)
  }
  const by = typeof data['attestedBy'] === 'string' ? data['attestedBy'].trim() : ''
  if (by === '') problems.push('attestedBy must name who made the checks')
  const at = isoDate(data['attestedAt'])
  if (!at) problems.push('attestedAt must be the date of the checks, with its time ("2026-11-12T09:30:00Z")')
  else {
    if (at.getTime() > want.now.getTime() + 5 * 60_000) problems.push(`attestedAt (${at.toISOString()}) is in the future`)
    if (want.testPublishedAt && at.getTime() < want.testPublishedAt.getTime()) {
      problems.push(`attestedAt (${at.toISOString()}) is before the version reached the test channel (${want.testPublishedAt.toISOString()}): the checks are made on what the channel serves`)
    }
  }
  return { problems, attestation: problems.length === 0 && at ? { attestedBy: by, attestedAt: at.toISOString() } : null }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The lock between the channels

export interface StableGate {
  problems: string[]
  /** When this very archive was first published on the test channel, when the journal has it. */
  testPublishedAt: string | null
  /** What was waived by `--security-fix`, said to the maintainer and kept in the journal. */
  waived: string[]
}

/**
 * Whether `version` may enter the stable channel: the journal must hold a complete publication of this very archive on the test channel, at least
 * `minTestHours` old. `securityFix` (the reason of `--security-fix`) waives the wait and nothing else: the version still went through the test
 * channel, and the attestation is still read.
 *
 * A version withdrawn from the test channel lost its passage: what was taken out because it was bad must not reach stable on the wait it had
 * already counted. Only the publications of this archive made after the last withdrawal count, and the wait starts again at the first of them.
 * A withdrawal that stopped half way (`partial`) counts too: the maintainer meant the version to go. A withdrawal from another channel says
 * nothing of the test channel.
 */
export function stableGate(input: {
  entries: readonly JournalEntry[]
  withdrawals: readonly WithdrawalEntry[]
  version: string
  sha256: string
  now: Date
  minTestHours: number
  securityFix: string | null
  /** The system the archive or installer is for; the Mac when absent. The test channel of another system is another channel. */
  platform?: string
}): StableGate {
  const time = (iso: string): number => new Date(iso).getTime()
  const platform = input.platform ?? MAC_TARGET
  const onTest = input.entries.filter((entry) => entry.channel === 'test' && (entry.platform ?? MAC_TARGET) === platform && entry.version === input.version && entry.outcome === 'published')
  const published = onTest.filter((entry) => entry.archive.sha256 === input.sha256).sort((a, b) => time(a.at) - time(b.at))
  const withdrawnAt = input.withdrawals
    .filter((entry) => entry.channel === 'test' && (entry.platform ?? MAC_TARGET) === platform && entry.version === input.version)
    .map((entry) => entry.at)
    .sort((a, b) => time(b) - time(a))[0]
  // A publication at the very instant of the withdrawal does not come after it.
  const same = withdrawnAt === undefined ? published : published.filter((entry) => time(entry.at) > time(withdrawnAt))
  const first = same[0]
  if (!first) {
    if (withdrawnAt !== undefined && published.length > 0) {
      return {
        problems: [
          `${input.version} was withdrawn from the test channel on ${withdrawnAt}, and the journal has no publication of this archive there since: a withdrawn version does not go to stable. If it was withdrawn by mistake, publish this archive on the test channel again (node scripts/publish-update.mjs); the wait starts again from there`
        ],
        testPublishedAt: null,
        waived: []
      }
    }
    const other = onTest[0]
    return {
      problems: [
        other
          ? `the test channel got another archive of ${input.version} (SHA-256 ${other.archive.sha256}), not this one (${input.sha256}): what goes to stable is the archive that was tried. Publish this one on the test channel first`
          : `the journal has no publication of ${input.version} on the test channel: a version goes to the test channel first (node scripts/publish-update.mjs), then to stable`
      ],
      testPublishedAt: null,
      waived: []
    }
  }
  const since = input.now.getTime() - new Date(first.at).getTime()
  const wanted = input.minTestHours * 3_600_000
  if (since >= wanted) return { problems: [], testPublishedAt: first.at, waived: [] }
  const short = `${input.version} has been on the test channel for ${hours(Math.max(0, since))} (since ${first.at}), less than the ${input.minTestHours} h it must stay there`
  if (input.securityFix !== null) return { problems: [], testPublishedAt: first.at, waived: [short] }
  return {
    problems: [`${short}: it may go to stable from ${new Date(new Date(first.at).getTime() + wanted).toISOString()}. A security fix that cannot wait: --security-fix "<reason>" (written in the journal)`],
    testPublishedAt: first.at,
    waived: []
  }
}
