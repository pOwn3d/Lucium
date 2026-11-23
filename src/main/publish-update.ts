// The publication of an update in one command: `node scripts/publish-update.mjs` (docs/community/release-process.md). Not part of the application
// (nothing in it imports this file); the script reads it with Node's own TypeScript, like update-feed-file.ts, so it imports nothing but Node's
// modules and uses nothing that type stripping cannot erase (no enum, no parameter property).
//
// What it does is what the maintainer did by hand, in the same order: check the build, write the release file (scripts/make-update-feed.mjs),
// send both files to the server, check the copy there, publish the ARCHIVE, check it online, publish the FEED, check it online. It stops at the
// first thing that is wrong, and the feed is never published unless the archive was published and answers with its hash: a feed that names
// a missing or wrong archive makes every installation fail (docs/drm.md, section 12).
//
// The disk image that scripts/make-dmg.mjs makes beside the archive (the public download: the same app, in a signed and notarized image) goes
// too, with its sum, in the same folder: after the archive and before the feed, installed the same way (a temporary name, then renamed) and
// checked online by its hash. It is optional (no image beside the archive, or `--no-dmg`: nothing of it), but an image without its sum, or a sum
// that is not the image's, stops everything before anything is sent. The feed does not name the image: it is never what an installed copy installs.
// The image must hold the app of the archive: the record scripts/make-dmg.mjs writes with it says which executable it holds, and an image left
// from an earlier build of the same version is refused.
//
// The archive of a version has one name, so writing it replaces the file of that name. Before anything is sent, the feed in place is read: a
// version the channel already offers with another archive is refused (the feed in place would name a file that no longer has its hash, and every
// installation would fail until the new feed is there), and so is a version below the one the channel offers (a publication never goes back).
//
// The repository holds the name and the https folder of each channel (they are public: every installed copy reads them). The server and the folder
// of each channel are in a JSON file outside the repository (`--config`, LUCIUM_PUBLISH_CONFIG, else ~/Library/Application Support/lucium-secrets/
// publish-channels.json); this code only reads that one file, through the reader it is given, and never writes it.
//
// Before anything is sent, the conditions of a publication are read (release-gate.ts has them, with their reasons): the archive holds the app that
// was checked, a build record names the commit it was built from, the changelogs carry the date of the version, the engine suites passed on that
// commit, and, for the stable channel, the version waited on the test channel and the maintainer's attestation is complete. Then one line of the
// journal, a file outside the repository, keeps what was published. A withdrawal (`--withdraw`) is not a publication: it reads none of these
// conditions, and adds a line of its own type to the same journal. The lock of the stable channel reads that line: a version taken out of the
// test channel does not go to stable until its archive is published there again.
//
// The feed also lists the versions withdrawn from its channel (`withdrawn`, Lucium's own key): a copy that runs one of them reads it in the file it
// reads anyway and says so (shared/update-check.ts). A withdrawal writes the list, and every later publication carries it.
//
// The code is either pure (the channels, the arguments, the commands, the checks) or takes its effects as `PublishDeps`: the script gives the real
// ones (`realDeps`), the tests a fake one. So the order of the steps, and what stops them, is tested without a network or a server.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, mkdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
// Types only: Node erases this line when it reads the file for the script, which hands the functions over in `PublishDeps.gate`.
import type * as ReleaseGate from './release-gate'
import type { FeedKeys } from './update-feed-signature'

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The channels

export interface Channel {
  /** `user@host` of the server, for ssh and scp. */
  host: string
  /** The folder of the server that the web server publishes (the archive and feed.json are written there). */
  folder: string
  /** The https folder these files answer at, ending with "/": the second argument of scripts/make-update-feed.mjs. */
  baseUrl: string
}

/**
 * What the repository says about the channels, and all it says: a name and the https folder the files answer at (the address every installed copy
 * reads anyway). The server and its folder are not here: they come from the maintainer's own file (below), which stays outside the repository.
 */
export const PUBLIC_CHANNELS: Record<string, { baseUrl: string }> = {
  test: { baseUrl: 'https://test.lucium.app/updates/darwin-arm64/' },
  stable: { baseUrl: 'https://lucium.app/updates/darwin-arm64/' }
}

export const DEFAULT_CHANNEL = 'test'

/** The channel a version waits on before any other: the lock between the channels applies to every channel but this one. */
export const TEST_CHANNEL = 'test'

/** The name of the release file, on the server and in the https folder. */
export const FEED_NAME = 'feed.json'

/** The name of the archive the build writes, `Lucium-<version>-arm64.zip`. */
const ARCHIVE_NAME = /^Lucium-(\d+\.\d+\.\d+)-arm64\.zip$/

/** The disk image scripts/make-dmg.mjs writes beside the archive, and its sum (src/main/make-dmg.ts has the same two names, and a test keeps them equal). */
export const dmgNameOf = (version: string): string => `Lucium-${version}-arm64.dmg`
export const sumNameOf = (version: string): string => `${dmgNameOf(version)}.sha256`
/** The record scripts/make-dmg.mjs writes with the image: which image it is, and the executable of the app it holds (the same name in src/main/make-dmg.ts). It stays on the Mac. */
export const imageRecordNameOf = (version: string): string => `${dmgNameOf(version)}.json`

/** What a channel may hold: its values end up in a command line of the server, so only plain characters are allowed. */
export function channelProblems(channel: Channel): string[] {
  const problems: string[] = []
  if (!/^[A-Za-z_][A-Za-z0-9_-]*@[A-Za-z0-9.-]+$/.test(channel.host)) problems.push(`the host must be user@host: ${channel.host}`)
  if (!/^\/[A-Za-z0-9._/-]+$/.test(channel.folder) || channel.folder.includes('..')) problems.push(`the folder must be an absolute path of plain characters: ${channel.folder}`)
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._/-]*$/.test(channel.baseUrl) || !channel.baseUrl.endsWith('/')) problems.push(`the address must be https and end with "/": ${channel.baseUrl}`)
  return problems
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The file of the servers

/** Where the servers and folders are, unless `--config` or LUCIUM_PUBLISH_CONFIG says otherwise: under the home folder, outside the repository. */
export const DEFAULT_CONFIG_PATH = ['Library', 'Application Support', 'lucium-secrets', 'publish-channels.json']

/** The shape of the file, shown whenever it is missing or wrong. */
export const CONFIG_SHAPE = '{ "test": { "host": "user@host", "folder": "/absolute/folder" }, "stable": { "host": "user@host", "folder": "/absolute/folder" } }'

/** The file, as it was read: missing, unusable (not readable, not JSON), or its parsed content. */
export type ChannelFile = { path: string; state: 'missing' } | { path: string; state: 'unusable'; reason: string } | { path: string; state: 'read'; config: unknown }

/** The path of the file: `--config`, else the environment variable, else the default one under the home folder. Only this file is ever read. */
export function configPathOf(options: { config: string | null }, env: { cwd: string; home: string; fromEnv: string | undefined }): string {
  const given = options.config || env.fromEnv
  return given ? resolve(env.cwd, given) : join(env.home, ...DEFAULT_CONFIG_PATH)
}

/** Reads the file of the servers with the reader it is given (the script's is `readFileSync`). It writes nothing. */
export function readChannelFile(path: string, readText: (path: string) => string): ChannelFile {
  let text: string
  try {
    text = readText(path)
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') return { path, state: 'missing' }
    return { path, state: 'unusable', reason: `it cannot be read (${error instanceof Error ? error.message : String(error)})` }
  }
  try {
    return { path, state: 'read', config: JSON.parse(text) as unknown }
  } catch {
    return { path, state: 'unusable', reason: 'it is not JSON' }
  }
}

export type ChannelChoice = { ok: true; channel: Channel } | { ok: false; message: string }

const asRecord = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

/**
 * The channel `name`: its https folder from the repository, its server and folder from the file. Nothing is guessed: a missing file, a missing
 * channel or a wrong value is refused with a message that names the file and the shape it must have.
 */
export function resolveChannel(name: string, file: ChannelFile, publicChannels: Record<string, { baseUrl: string }> = PUBLIC_CHANNELS): ChannelChoice {
  if (!Object.prototype.hasOwnProperty.call(publicChannels, name)) return { ok: false, message: `Unknown channel "${name}" (known: ${Object.keys(publicChannels).join(', ')})` }
  const shape = `Expected shape of ${file.path}:\n  ${CONFIG_SHAPE}`
  if (file.state === 'missing') {
    return { ok: false, message: `The file of the servers does not exist: ${file.path}\nIt holds the server and the folder of each channel, and stays outside the repository. Another place: --config <path>, or LUCIUM_PUBLISH_CONFIG.\n${shape}` }
  }
  if (file.state === 'unusable') return { ok: false, message: `The file of the servers cannot be used: ${file.path}, ${file.reason}.\n${shape}` }
  const config = asRecord(file.config)
  if (!config) return { ok: false, message: `${file.path} must hold one JSON object, with one entry per channel.\n${shape}` }
  if (!Object.prototype.hasOwnProperty.call(config, name)) return { ok: false, message: `The channel "${name}" is not in ${file.path}: its server and folder are not guessed.\n${shape}` }
  const entry = asRecord(config[name])
  if (!entry) return { ok: false, message: `The channel "${name}" in ${file.path} must be an object with "host" and "folder".\n${shape}` }
  const problems: string[] = []
  for (const key of ['host', 'folder']) if (typeof entry[key] !== 'string') problems.push(`"${key}" must be a string`)
  // The address is the repository's: a "baseUrl" in the file would look as if it were used and would not be.
  for (const key of Object.keys(entry)) if (key !== 'host' && key !== 'folder') problems.push(`"${key}" is not a key of a channel (only "host" and "folder": the address is the repository's)`)
  const channel: Channel = { host: String(entry['host']), folder: String(entry['folder']), baseUrl: (publicChannels[name] as { baseUrl: string }).baseUrl }
  if (problems.length === 0) problems.push(...channelProblems(channel))
  if (problems.length > 0) return { ok: false, message: `The channel "${name}" in ${file.path} is misconfigured:\n  ${problems.join('\n  ')}\n${shape}` }
  return { ok: true, channel }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The arguments

export interface PublishOptions {
  archive: string | null
  channel: string
  dryRun: boolean
  help: boolean
  /** The built app the archive was made from (default: mac-arm64/Lucium.app beside the archive). */
  app: string | null
  /** The installed app whose fuses the new build must equal (default: /Applications/Lucium.app). */
  installedApp: string | null
  /** The key passed to ssh and scp, by path (default: LUCIUM_PUBLISH_SSH_KEY, else ~/.ssh/id_ed25519). It is never opened here. */
  sshKey: string | null
  /** A saved output of the build, which must say that the app was notarized and stapled. */
  buildLog: string | null
  /** The file that holds the server and the folder of each channel (default: LUCIUM_PUBLISH_CONFIG, else under the home folder). */
  config: string | null
  /** `--no-dmg`: the disk image beside the archive, if there is one, is not published. */
  noDmg: boolean
  /** `--withdraw <version>`: nothing is published; this version is taken out of the channel (see `withdraw`). */
  withdraw: string | null
  /** `--to <version>|none`, with `--withdraw`: the version the feed goes back to (default: the highest kept feed below the withdrawn one), or no feed at all. */
  to: string | null
  /** The journal of the publications (default: LUCIUM_PUBLISH_JOURNAL, else beside the file of the servers). */
  journal: string | null
  /** The record of the build (default: beside the archive). */
  buildRecord: string | null
  /** The record of the engine run (default: out-engine/release-run.json of the repository). */
  engineRun: string | null
  /** `--no-engine-run "<reason>"`: publish without the record of the engine run; the reason goes to the journal. */
  noEngineRun: string | null
  /** The maintainer's attestation, read for the stable channel (default: beside the archive). */
  attestation: string | null
  /** `--min-test-hours <n>`: how long a version stays on the test channel before stable. */
  minTestHours: string | null
  /** `--security-fix "<reason>"`: the stable channel without the wait; the reason goes to the journal. */
  securityFix: string | null
}

const VALUE_OPTIONS = {
  '--channel': 'channel',
  '--app': 'app',
  '--installed-app': 'installedApp',
  '--ssh-key': 'sshKey',
  '--build-log': 'buildLog',
  '--config': 'config',
  '--journal': 'journal',
  '--build-record': 'buildRecord',
  '--engine-run': 'engineRun',
  '--no-engine-run': 'noEngineRun',
  '--attestation': 'attestation',
  '--min-test-hours': 'minTestHours',
  '--security-fix': 'securityFix',
  '--withdraw': 'withdraw',
  '--to': 'to'
} as const

/** A reason shorter than this says nothing ("urgent", "ok"). */
export const MIN_REASON = 20

/** Why the reason given to a way out (`--no-engine-run`, `--security-fix`) cannot be used, or null. */
export function reasonProblem(option: string, reason: string): string | null {
  return reason.trim().length < MIN_REASON ? `${option} takes the reason, in at least ${MIN_REASON} characters: it is written in the journal with the publication` : null
}

/** How long a version stays on the test channel before it may go to stable, unless `--min-test-hours` says otherwise: one day. */
export const DEFAULT_MIN_TEST_HOURS = 24

/** `--min-test-hours` as a number, or why it is not one. An hour at least: less is not a wait, and the way around the wait is `--security-fix`. */
export function minTestHoursOf(value: string): { hours: number } | { problem: string } {
  const parsed = Number(value)
  if (value.trim() === '' || !Number.isFinite(parsed) || parsed < 1) return { problem: `--min-test-hours takes a number of hours, 1 or more (got "${value}"): a fix that cannot wait goes with --security-fix "<reason>"` }
  return { hours: parsed }
}

/** A version as the build names its files: three numbers. */
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/
/** `--to none`: the feed is taken away and nothing is offered, when there is no earlier version to go back to. */
export const NO_FEED = 'none'

export type ParsedArgs = { ok: true; options: PublishOptions } | { ok: false; message: string }

export function parsePublishArgs(args: string[]): ParsedArgs {
  const options: PublishOptions = {
    archive: null,
    channel: DEFAULT_CHANNEL,
    dryRun: false,
    help: false,
    app: null,
    installedApp: null,
    sshKey: null,
    buildLog: null,
    config: null,
    noDmg: false,
    journal: null,
    buildRecord: null,
    engineRun: null,
    noEngineRun: null,
    attestation: null,
    minTestHours: null,
    securityFix: null,
    withdraw: null,
    to: null
  }
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] as string
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--no-dmg') options.noDmg = true
    else if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      const flag = equals === -1 ? arg : arg.slice(0, equals)
      const inline = equals === -1 ? undefined : arg.slice(equals + 1)
      const key = VALUE_OPTIONS[flag as keyof typeof VALUE_OPTIONS] ?? null
      if (!key) return { ok: false, message: `Unknown option: ${arg}` }
      // The next word is the value, unless it is another option: `--ssh-key --dry-run` must not take the flag for a path.
      const value = inline ?? (args[at + 1] !== undefined && !(args[at + 1] as string).startsWith('--') ? args[++at] : undefined)
      if (value === undefined || value === '') return { ok: false, message: `${flag} needs a value` }
      options[key] = value
    } else if (options.archive === null) options.archive = arg
    else return { ok: false, message: `Only one archive can be published at a time (got ${options.archive} and ${arg})` }
  }
  // A withdrawal publishes nothing: an archive or an option of the build beside it would be a publication the maintainer did not mean.
  if (options.withdraw !== null) {
    if (!PLAIN_VERSION.test(options.withdraw)) return { ok: false, message: `--withdraw needs a version such as 1.0.1 (got ${options.withdraw})` }
    if (options.archive !== null) return { ok: false, message: `--withdraw publishes nothing: no archive goes with it (got ${options.archive})` }
    // The conditions of a publication are not read by a withdrawal: an option that names one would look as if it were.
    const ofThePublication = [
      ['--app', 'app'],
      ['--installed-app', 'installedApp'],
      ['--build-log', 'buildLog'],
      ['--build-record', 'buildRecord'],
      ['--engine-run', 'engineRun'],
      ['--no-engine-run', 'noEngineRun'],
      ['--attestation', 'attestation'],
      ['--min-test-hours', 'minTestHours'],
      ['--security-fix', 'securityFix']
    ] as const
    for (const [flag, key] of ofThePublication) {
      if (options[key] !== null) return { ok: false, message: `${flag} is an option of the publication: it does not go with --withdraw` }
    }
    if (options.noDmg) return { ok: false, message: '--no-dmg is an option of the publication: it does not go with --withdraw' }
    if (options.to !== null && options.to !== NO_FEED && !PLAIN_VERSION.test(options.to)) return { ok: false, message: `--to needs a version such as 1.0.0, or "${NO_FEED}" (got ${options.to})` }
  } else if (options.to !== null) return { ok: false, message: '--to only goes with --withdraw' }
  return { ok: true, options }
}

export interface PublishInput {
  /** The version of package.json: the one the archive and the app must carry. */
  version: string
  /** The repository (scripts/make-update-feed.mjs is run from it). */
  root: string
  archive: string
  app: string
  installedApp: string
  buildLog: string | null
  channelName: string
  channel: Channel
  sshKey: string
  /** Publish the disk image beside the archive when there is one (false with `--no-dmg`). */
  dmg: boolean
  dryRun: boolean
  /** The journal of the publications: read for the stable channel, and one line is added to it by every publication. */
  journal: string
  /** The record scripts/build-drm-release.sh writes beside the archive. */
  buildRecord: string
  /** The record `pnpm test:engine:release` writes. */
  engineRun: string
  /** The reason the publication goes without the record of the engine run, or null when it reads it. */
  noEngineRun: string | null
  /** The maintainer's attestation (read for the stable channel only). */
  attestation: string
  minTestHours: number
  /** The reason the stable channel is reached without the wait, or null. */
  securityFix: string | null
}

/** The journal, unless `--journal` or LUCIUM_PUBLISH_JOURNAL says otherwise: beside the file of the servers, outside the repository. */
export const DEFAULT_JOURNAL_PATH = ['Library', 'Application Support', 'lucium-secrets', 'publish-journal.jsonl']

/** The record of the engine run, relative to the root of the repository (release-gate.ts has the same path, and a test keeps them equal). */
export const DEFAULT_ENGINE_RUN = ['out-engine', 'release-run.json']

/** The two files of a version that sit beside its archive (release-gate.ts has the same names, and a test keeps them equal). */
export const buildRecordNameOf = (version: string): string => `Lucium-${version}-arm64.build.json`
export const attestationNameOf = (version: string): string => `Lucium-${version}-arm64.attestation.json`

/** The key of the default: the name ssh-keygen gives a new key. Another one is named by `--ssh-key` or LUCIUM_PUBLISH_SSH_KEY. */
export const DEFAULT_SSH_KEY = 'id_ed25519'

export type ResolvedInput = { ok: true; input: PublishInput } | { ok: false; message: string }

/** The options with their defaults and absolute paths. `home` only locates the default key; nothing is read from it. `sshKeyFromEnv` is LUCIUM_PUBLISH_SSH_KEY, as it was found. `servers` is the file of the servers, already read. */
export function resolveInput(
  options: PublishOptions,
  env: { cwd: string; root: string; home: string; version: string; servers: ChannelFile; sshKeyFromEnv?: string | undefined; journalFromEnv?: string | undefined }
): ResolvedInput {
  const choice = resolveChannel(options.channel, env.servers)
  if (!choice.ok) return choice
  // The ways out are checked before anything is read: a reason that says nothing, or a wait that is none, is an argument that is wrong.
  const waited = options.minTestHours === null ? { hours: DEFAULT_MIN_TEST_HOURS } : minTestHoursOf(options.minTestHours)
  if ('problem' in waited) return { ok: false, message: waited.problem }
  for (const [flag, reason] of [['--no-engine-run', options.noEngineRun], ['--security-fix', options.securityFix]] as const) {
    const problem = reason === null ? null : reasonProblem(flag, reason)
    if (problem) return { ok: false, message: problem }
  }
  if (options.noEngineRun !== null && options.engineRun !== null) return { ok: false, message: '--engine-run names the record to read and --no-engine-run publishes without one: not both' }
  if (options.channel === TEST_CHANNEL && (options.securityFix !== null || options.minTestHours !== null)) {
    return { ok: false, message: `--security-fix and --min-test-hours are about the wait before the stable channel: they mean nothing on the channel "${TEST_CHANNEL}"` }
  }
  const archive = options.archive ? resolve(env.cwd, options.archive) : join(env.root, 'dist-drm', `Lucium-${env.version}-arm64.zip`)
  const beside = (name: string): string => join(dirname(archive), name)
  return {
    ok: true,
    input: {
      version: env.version,
      root: env.root,
      archive,
      app: options.app ? resolve(env.cwd, options.app) : join(dirname(archive), 'mac-arm64', 'Lucium.app'),
      installedApp: options.installedApp ? resolve(env.cwd, options.installedApp) : '/Applications/Lucium.app',
      buildLog: options.buildLog ? resolve(env.cwd, options.buildLog) : null,
      channelName: options.channel,
      channel: choice.channel,
      sshKey: resolve(env.cwd, options.sshKey || env.sshKeyFromEnv?.trim() || join(env.home, '.ssh', DEFAULT_SSH_KEY)),
      dmg: !options.noDmg,
      dryRun: options.dryRun,
      journal: resolve(env.cwd, options.journal || env.journalFromEnv?.trim() || join(env.home, ...DEFAULT_JOURNAL_PATH)),
      buildRecord: options.buildRecord ? resolve(env.cwd, options.buildRecord) : beside(buildRecordNameOf(env.version)),
      engineRun: options.engineRun ? resolve(env.cwd, options.engineRun) : join(env.root, ...DEFAULT_ENGINE_RUN),
      noEngineRun: options.noEngineRun?.trim() ?? null,
      attestation: options.attestation ? resolve(env.cwd, options.attestation) : beside(attestationNameOf(env.version)),
      minTestHours: waited.hours,
      securityFix: options.securityFix?.trim() ?? null
    }
  }
}

export interface WithdrawInput {
  /** The version taken out of the channel. */
  version: string
  /** The version the feed goes back to; `NO_FEED` for no feed at all; null to take the highest kept feed below `version`. */
  to: string | null
  channelName: string
  channel: Channel
  sshKey: string
  dryRun: boolean
  /** The journal of the publications: a withdrawal adds one line to it, of its own type, and reads nothing from it. */
  journal: string
}

export type ResolvedWithdrawal = { ok: true; input: WithdrawInput } | { ok: false; message: string }

/** The options of `--withdraw` with their defaults: the same file of the servers, the same key and the same journal as the publication. */
export function resolveWithdrawal(
  options: PublishOptions,
  env: { cwd: string; home: string; servers: ChannelFile; sshKeyFromEnv?: string | undefined; journalFromEnv?: string | undefined }
): ResolvedWithdrawal {
  if (options.withdraw === null) return { ok: false, message: 'No version to withdraw (--withdraw <version>)' }
  const choice = resolveChannel(options.channel, env.servers)
  if (!choice.ok) return choice
  return {
    ok: true,
    input: {
      version: options.withdraw,
      to: options.to,
      channelName: options.channel,
      channel: choice.channel,
      sshKey: resolve(env.cwd, options.sshKey || env.sshKeyFromEnv?.trim() || join(env.home, '.ssh', DEFAULT_SSH_KEY)),
      dryRun: options.dryRun,
      journal: resolve(env.cwd, options.journal || env.journalFromEnv?.trim() || join(env.home, ...DEFAULT_JOURNAL_PATH))
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The commands

export interface Command {
  program: string
  args: string[]
  timeoutMs: number
}

const plainWord = /^[A-Za-z0-9_@%+=:,./~-]+$/
/** A word as a shell would need it, so that a printed command can be pasted. */
export const shellWord = (word: string): string => (plainWord.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`)
export const commandLine = (command: Command): string => [command.program, ...command.args].map(shellWord).join(' ')

const MINUTE = 60_000
/** The custom icon of a folder (src/main/shell/bundle-icon.ts) at the root of the bundle, as `zipinfo -1` names it in the archive. */
const ARCHIVED_CUSTOM_ICON = 'Lucium.app/Icon\r'
/** Never ask for a password or a host key: a prompt would hang the publication, a refusal says why. */
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20']

/** The commands that publish the disk image and its sum, and read them back. */
export interface DiskPlan {
  dmgUrl: string
  sumUrl: string
  remoteHash: Command
  installDmg: Command
  installSum: Command
  downloadDmg: Command
  fetchSum: Command
}

export interface RemotePlan {
  archiveUrl: string
  feedUrl: string
  upload: Command
  remoteHash: Command
  installArchive: Command
  downloadArchive: Command
  installFeed: Command
  fetchFeed: Command
  /** Removes the private folder of the server, and every copy in it. */
  cleanup: Command
  /** Null when there is no disk image to publish. */
  disk: DiskPlan | null
}

/**
 * The files are sent to a folder of their own on the server, never to /tmp itself: `mktemp -d` makes it at the start of the sending, mode 0700, so no
 * other account of the server can read a copy, or put its own file under the name the install step reads, between the check of its SHA-256 and its
 * installation. The publication removes it at the end, whatever happened. This is the template given to `mktemp`, and what a dry run prints.
 */
export const STAGING_TEMPLATE = '/tmp/lucium-publish.XXXXXXXXXX'
/** What `mktemp -d` makes of the template: the same /tmp/ folder and prefix, then ten letters or digits. Nothing a shell would read otherwise. */
const STAGING_FOLDER = /^\/tmp\/lucium-publish\.[A-Za-z0-9]{10}$/

/**
 * The commands of steps 2 to 4 of the manual publication. The names are checked by the caller (an archive name of the build, `feed.json`, the disk image
 * and its sum: their names come from the version). `disk` is the image and its sum beside the archive, or null.
 */
export function remotePlan(plan: { archive: string; feed: string; channel: Channel; sshKey: string; disk?: { dmg: string; sum: string } | null; staging?: string }): RemotePlan {
  const { channel } = plan
  // The folder `mktemp` printed, once read back by `stagingFolderOf`; the template until then (a dry run, or the addresses alone).
  const staging = plan.staging ?? STAGING_TEMPLATE
  // It goes into shell scripts of the server and into `rm -rf`: anything but a folder `mktemp` can make is a mistake of the caller, never run.
  if (!STAGING_FOLDER.test(staging)) throw new Error(`not a private folder of the publication on the server: ${JSON.stringify(staging)}`)
  const zip = basename(plan.archive)
  const ssh = (script: string, timeoutMs = 3 * MINUTE): Command => ({ program: 'ssh', args: [...SSH_OPTIONS, '-i', plan.sshKey, channel.host, script], timeoutMs })
  // Written under a temporary name, then renamed: a reader never sees half a file. root:root 0644. The archive goes first, so it is the step that
  // makes the folder (a channel may be new). `install -d` is idempotent: on a folder that exists it only sets root:root 0755 again.
  const install = (name: string, makeFolder = false): string =>
    `D=${shellWord(channel.folder)}; ${makeFolder ? 'sudo -n install -d -o root -g root -m 755 $D && ' : ''}sudo -n install -o root -g root -m 644 ${staging}/${name} $D/.${name}.part && sudo -n mv $D/.${name}.part $D/${name} || { sudo -n rm -f $D/.${name}.part; exit 1; }`
  const archiveUrl = new URL(zip, channel.baseUrl).href
  const feedUrl = new URL(FEED_NAME, channel.baseUrl).href
  const disk = plan.disk ?? null
  const dmgName = disk ? basename(disk.dmg) : ''
  const sumName = disk ? basename(disk.sum) : ''
  const dmgUrl = disk ? new URL(dmgName, channel.baseUrl).href : ''
  const sumUrl = disk ? new URL(sumName, channel.baseUrl).href : ''
  return {
    archiveUrl,
    feedUrl,
    upload: { program: 'scp', args: ['-q', ...SSH_OPTIONS, '-i', plan.sshKey, plan.archive, plan.feed, ...(disk ? [disk.dmg, disk.sum] : []), `${channel.host}:${staging}/`], timeoutMs: 20 * MINUTE },
    remoteHash: ssh(`sha256sum ${staging}/${zip}`),
    installArchive: ssh(install(zip, true)),
    downloadArchive: { program: 'curl', args: ['-sS', '--fail', archiveUrl], timeoutMs: 20 * MINUTE },
    installFeed: ssh(install(FEED_NAME)),
    fetchFeed: { program: 'curl', args: ['-sS', '--fail', feedUrl], timeoutMs: 2 * MINUTE },
    cleanup: ssh(`rm -rf -- ${staging}`),
    // The folder exists once the archive is installed (it makes it): the image and its sum only write, like the feed.
    disk: disk
      ? {
          dmgUrl,
          sumUrl,
          remoteHash: ssh(`sha256sum ${staging}/${dmgName}`),
          installDmg: ssh(install(dmgName)),
          installSum: ssh(install(sumName)),
          downloadDmg: { program: 'curl', args: ['-sS', '--fail', dmgUrl], timeoutMs: 20 * MINUTE },
          fetchSum: { program: 'curl', args: ['-sS', '--fail', sumUrl], timeoutMs: 2 * MINUTE }
        }
      : null
  }
}

const sshCommand = (channel: Channel, sshKey: string, script: string, timeoutMs = 3 * MINUTE): Command => ({ program: 'ssh', args: [...SSH_OPTIONS, '-i', sshKey, channel.host, script], timeoutMs })

/**
 * Makes the private folder of the publication on the server and prints its path. `mktemp -d` already makes it 0700; `chmod` says so whatever the
 * umask, and a folder it cannot set is removed rather than used.
 */
export const makeStagingCommand = (channel: Channel, sshKey: string): Command =>
  sshCommand(channel, sshKey, `T=$(mktemp -d ${STAGING_TEMPLATE}) || exit 1; chmod 700 "$T" || { rmdir "$T"; exit 1; }; echo "$T"`)

/** The folder `makeStagingCommand` printed, or null when it printed anything else (another folder, a second line, a character a shell reads). */
export function stagingFolderOf(printed: string): string | null {
  const folder = printed.trim()
  return STAGING_FOLDER.test(folder) && folder !== STAGING_TEMPLATE ? folder : null
}

/** The archive of a version, as the build names it. */
export const archiveNameOf = (version: string): string => `Lucium-${version}-arm64.zip`
/** The feed of a version, kept in the folder of the channel when a later publication replaces it: what `--withdraw` goes back to. */
export const keptFeedNameOf = (version: string): string => `feed-${version}.json`
/**
 * What a withdrawn file is renamed to. The site serves from this folder only the names that end with .zip, .dmg, .sha256 or .json: a name that ends
 * with this answers 404, and the file stays on the server for the maintainer to look at.
 */
export const WITHDRAWN_SUFFIX = '.withdrawn'
/** The feed in place that is not a release file, kept under this name before a publication replaces it. */
export const REPLACED_FEED_NAME = `${FEED_NAME}.replaced`

/**
 * The folder of a channel is readable by root only, so every read of it goes through `sudo -n`, as every write does. A read the account makes itself
 * is not an error, it is worse: `[ -f $D/feed.json ]` is false in a folder the account cannot enter, nothing is printed and the status is 0, so a
 * channel that offers a version reads as "no feed yet", and a publication replaces that feed without keeping it.
 *
 * A `test` that sudo refuses is false like one that answers no. A script that tests for a file therefore asks sudo for something that is always true
 * first (`test -d /`): a refusal stops the script, with a status and a message, instead of reading as "the file is not there".
 */
const sudoWorks = (what: string): string => `sudo -n test -d / || { echo "cannot ${what}: sudo -n is refused on the server (the folder of a channel is readable by root only)" >&2; exit 2; }`

/**
 * Prints the feed the folder of the channel holds, or nothing when there is none yet (a new channel: no folder, or a folder without it). It changes
 * nothing. A status that is not 0 means the folder could not be read, never that there is no feed.
 */
export const readFeedCommand = (channel: Channel, sshKey: string): Command =>
  sshCommand(channel, sshKey, `D=${shellWord(channel.folder)}; ${sudoWorks('read the folder of the channel')}; if sudo -n test -f $D/${FEED_NAME}; then sudo -n cat $D/${FEED_NAME}; fi`)

/** Copies the feed in place to `name` (the feed of its version, or `REPLACED_FEED_NAME`), before another one takes its place. */
export const keepFeedCommand = (channel: Channel, sshKey: string, name: string): Command => sshCommand(channel, sshKey, `D=${shellWord(channel.folder)}; sudo -n cp -p $D/${FEED_NAME} $D/${name}`)

/** The commands of a withdrawal. Every version in them was checked to be digits and dots (`PLAIN_VERSION`, `readRelease`). */
export interface WithdrawPlan {
  feedUrl: string
  /** The names of the folder of the channel, one a line. */
  list: Command
  readFeed: Command
  fetchFeed: Command
  /** The feed in place is copied aside under the name of the withdrawn version (never a name `--withdraw` goes back to). */
  keepWithdrawnFeed: Command
  /** `--to none`: the feed goes aside and nothing takes its place. */
  dropFeed: Command
  /** The archive, the disk image, its sum and the kept feed of the withdrawn version are renamed so that they answer 404. */
  setAsideFiles: Command
  /** The addresses that must answer 404 afterwards. */
  withdrawnUrls: string[]
  /** What an address answers, as an HTTP status. */
  statusOf: (url: string) => Command
  /** Writes `text` as the feed of the channel: the feed a withdrawal goes back to, or the one in place, with the list of the withdrawn versions. */
  writeFeed: (text: string) => Command
  /** For the version the feed goes back to. */
  target: (version: string) => { archiveUrl: string; readKept: Command; weighArchive: Command }
}

export function withdrawPlan(plan: { version: string; channel: Channel; sshKey: string }): WithdrawPlan {
  const { channel, version } = plan
  const ssh = (script: string): Command => sshCommand(channel, plan.sshKey, script)
  const D = `D=${shellWord(channel.folder)}`
  const feedUrl = new URL(FEED_NAME, channel.baseUrl).href
  // No --fail: the status is the answer (a withdrawn file must say 404). A HEAD, so that a check is not counted as a download.
  const statusOf = (url: string): Command => ({ program: 'curl', args: ['-sS', '-I', '-o', '/dev/null', '-w', '%{http_code}', url], timeoutMs: 2 * MINUTE })
  const aside = [archiveNameOf(version), dmgNameOf(version), sumNameOf(version), keptFeedNameOf(version)]
  return {
    feedUrl,
    list: ssh(`sudo -n ls -1 ${shellWord(channel.folder)}`),
    readFeed: readFeedCommand(channel, plan.sshKey),
    fetchFeed: { program: 'curl', args: ['-sS', '--fail', feedUrl], timeoutMs: 2 * MINUTE },
    keepWithdrawnFeed: ssh(`${D}; sudo -n cp -p $D/${FEED_NAME} $D/${keptFeedNameOf(version)}${WITHDRAWN_SUFFIX}`),
    dropFeed: ssh(`${D}; sudo -n mv -f $D/${FEED_NAME} $D/${keptFeedNameOf(version)}${WITHDRAWN_SUFFIX}`),
    setAsideFiles: ssh(`${D}; ${sudoWorks('set the files aside')}; for F in ${aside.join(' ')}; do if sudo -n test -e $D/$F; then sudo -n mv -f $D/$F $D/$F${WITHDRAWN_SUFFIX} || exit 1; fi; done`),
    withdrawnUrls: [archiveNameOf(version), dmgNameOf(version), sumNameOf(version)].map((name) => new URL(name, channel.baseUrl).href),
    statusOf,
    // The text goes in the command itself, in base64 (letters, digits, "+", "/" and "=": nothing a shell reads), to a temporary file of the
    // server. Then the same way as a publication writes the feed: a temporary name in the folder, then renamed, root:root 0644.
    writeFeed: (text) =>
      ssh(
        `${D}; T=$(mktemp) && printf %s ${Buffer.from(text, 'utf8').toString('base64')} | base64 -d > $T && sudo -n install -o root -g root -m 644 $T $D/.${FEED_NAME}.part && sudo -n mv $D/.${FEED_NAME}.part $D/${FEED_NAME}; S=$?; rm -f $T; if [ $S != 0 ]; then sudo -n rm -f $D/.${FEED_NAME}.part; exit 1; fi`
      ),
    target: (to) => ({
      archiveUrl: new URL(archiveNameOf(to), channel.baseUrl).href,
      readKept: ssh(`sudo -n cat ${shellWord(`${channel.folder}/${keptFeedNameOf(to)}`)}`),
      // The sum, then the size alone on the next line. The size is counted on what root reads: a `wc -c < file` would open the file as the account.
      weighArchive: ssh(`${D}; sudo -n sha256sum $D/${archiveNameOf(to)} && sudo -n cat $D/${archiveNameOf(to)} | wc -c`)
    })
  }
}

export const makeFeedCommand = (root: string, archive: string, baseUrl: string): Command => ({
  program: 'node',
  args: [join(root, 'scripts', 'make-update-feed.mjs'), archive, baseUrl],
  timeoutMs: 2 * MINUTE
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The checks

/** The name the build gives the archive, and that of the version being published. Null when it is right. */
export function archiveNameProblem(name: string, version: string): string | null {
  const found = ARCHIVE_NAME.exec(name)
  if (!found) return `"${name}" is not named Lucium-<version>-arm64.zip, as scripts/build-drm-release.sh --notarize names it`
  if (found[1] !== version) return `the archive is for ${found[1]} and package.json says ${version}: build it again, or check out the right version`
  return null
}

/** The line `shasum -a 256` and `sha256sum` print: 64 hexadecimal digits, then the name. */
export function parseSha256Line(text: string): string | null {
  return /^([0-9a-f]{64})\s/.exec(text.trim() + ' ')?.[1] ?? null
}

/**
 * What is wrong with the sum file beside the disk image, or null: it must be the one line `shasum -a 256` prints (the hash, then the name), name this
 * image, and carry the hash of the file that is there. A sum of another build would make the people who check their download believe it is damaged.
 */
export function sumFileProblem(text: string, imageName: string, sha256: string): string | null {
  const found = /^([0-9a-f]{64}) [ *](.+)$/.exec(text.trim())
  if (!found) return `the sum is not one line "<sha256>  <name>", as shasum -a 256 prints it`
  if (found[2] !== imageName) return `the sum names ${JSON.stringify(found[2])}, the image is ${imageName}`
  if (found[1] !== sha256) return `the sum says ${found[1]}, the image has SHA-256 ${sha256}: make the image again (scripts/make-dmg.mjs)`
  return null
}

/** The build log of scripts/build-drm-release.sh --notarize ends with this line when Apple accepted the app and the ticket is stapled. */
export function buildLogProblem(text: string): string | null {
  return text.includes('Notarized, stapled') ? null : 'the build log does not say "Notarized, stapled": the build did not finish with --notarize'
}

export interface ExpectedRelease {
  version: string
  /** The address of the archive: the https folder and its name. */
  url: string
  sha256: string
  size: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * What is wrong with a release file, for the one that was just written and for the one read back from the server. Squirrel takes the entry
 * whose version is `currentRelease`, then downloads its `url` and discards a file whose `size` or `sha256` differ (update-feed-file.ts).
 */
export function feedProblems(text: string, want: ExpectedRelease): string[] {
  let feed: unknown
  try {
    feed = JSON.parse(text)
  } catch {
    return ['the feed is not JSON']
  }
  if (!isRecord(feed)) return ['the feed is not an object']
  const problems: string[] = []
  if (feed['currentRelease'] !== want.version) problems.push(`currentRelease is ${JSON.stringify(feed['currentRelease'])}, expected "${want.version}"`)
  const releases = Array.isArray(feed['releases']) ? feed['releases'] : []
  const entry = releases.find((release) => isRecord(release) && release['version'] === feed['currentRelease'])
  if (!isRecord(entry) || !isRecord(entry['updateTo'])) return [...problems, 'no entry of releases carries currentRelease']
  const update = entry['updateTo']
  if (update['version'] !== want.version) problems.push(`the release says ${JSON.stringify(update['version'])}, expected "${want.version}"`)
  if (update['url'] !== want.url) problems.push(`the archive address is ${JSON.stringify(update['url'])}, expected ${want.url}`)
  if (update['sha256'] !== want.sha256) problems.push(`the SHA-256 is ${JSON.stringify(update['sha256'])}, expected ${want.sha256}`)
  if (update['size'] !== want.size) problems.push(`the size is ${JSON.stringify(update['size'])}, expected ${want.size}`)
  return problems
}

/** The release a feed offers (the entry of `currentRelease`), or null when the text is not a release file both readers would take. */
export function readRelease(text: string): ExpectedRelease | null {
  let feed: unknown
  try {
    feed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(feed)) return null
  const version = feed['currentRelease']
  if (typeof version !== 'string' || !PLAIN_VERSION.test(version)) return null
  const entry = (Array.isArray(feed['releases']) ? feed['releases'] : []).find((release) => isRecord(release) && release['version'] === version)
  const update = isRecord(entry) ? entry['updateTo'] : null
  if (!isRecord(update) || update['version'] !== version) return null
  const { url, sha256, size } = update
  if (typeof url !== 'string' || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null
  return { version, url, sha256, size }
}

/** The key of the feed that lists the versions withdrawn from the channel. Lucium reads it (shared/update-check.ts, `withdrawnVersions`); Squirrel ignores it. */
export const WITHDRAWN_KEY = 'withdrawn'

/**
 * The withdrawn versions a feed lists. `problem` says what cannot be read, or what in the list is not a version of three numbers, or null: those entries are left out,
 * and the caller says so, because a copy believes nothing of a list that holds anything else than versions.
 */
export function readWithdrawn(text: string): { versions: string[]; problem: string | null } {
  // No feed at all lists nothing, and that is not a problem.
  if (text.trim() === '') return { versions: [], problem: null }
  let feed: unknown
  try {
    feed = JSON.parse(text)
  } catch {
    return { versions: [], problem: 'the feed is not JSON' }
  }
  if (!isRecord(feed) || !(WITHDRAWN_KEY in feed)) return { versions: [], problem: null }
  const list = feed[WITHDRAWN_KEY]
  if (!Array.isArray(list)) return { versions: [], problem: `"${WITHDRAWN_KEY}" is not a list (${JSON.stringify(list)})` }
  const versions = list.filter((version): version is string => typeof version === 'string' && PLAIN_VERSION.test(version))
  return { versions, problem: versions.length === list.length ? null : `"${WITHDRAWN_KEY}" holds something that is not a version of three numbers (${JSON.stringify(list.filter((version) => !versions.includes(version as string)))})` }
}

/** The list a feed that offers `offered` carries: each version once, the highest first, and never the version the feed offers. */
export function withdrawnList(versions: readonly string[], offered: string): string[] {
  return [...new Set(versions)].filter((version) => PLAIN_VERSION.test(version) && compareDotted(version, offered) !== 0).sort((a, b) => compareDotted(b, a))
}

/**
 * The feed `text` with `versions` as its list of withdrawn versions (no key at all for an empty list), written as scripts/make-update-feed.mjs
 * writes a feed. Everything else of the feed is kept as it is. `text` is a feed that was read as a release file already.
 *
 * `redated`, for a withdrawal: the date the feed is written, which becomes the `pub_date` of the release it names. A copy keeps the latest `pub_date` it
 * accepted and refuses an older feed (shared/update-feed-date.ts): the feed that goes back to an earlier version, or that only gains a withdrawn version,
 * would otherwise carry the date of its own publication, before the feed the copies read last, and every one of them would refuse it, the list included.
 */
export function feedWithWithdrawn(text: string, versions: readonly string[], redated?: Date): string {
  const feed: unknown = JSON.parse(text)
  if (!isRecord(feed)) throw new Error('the feed is not an object')
  const rest = Object.fromEntries(Object.entries(feed).filter(([key]) => key !== WITHDRAWN_KEY))
  const dated = redated === undefined ? rest : { ...rest, releases: redatedReleases(rest['releases'], rest['currentRelease'], redated) }
  return `${JSON.stringify(versions.length > 0 ? { ...dated, [WITHDRAWN_KEY]: versions } : dated, null, 2)}\n`
}

/** The date as Squirrel parses it and as update-feed-file.ts writes it: "2026-11-06T09:00:00Z", with no fraction of a second. */
const feedDate = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z')

/** `releases` with the `pub_date` of the entry whose version is `current` set to `date`; anything else is returned as it is. */
function redatedReleases(releases: unknown, current: unknown, date: Date): unknown {
  if (!Array.isArray(releases)) return releases
  return releases.map((release: unknown) => {
    if (!isRecord(release) || release['version'] !== current || !isRecord(release['updateTo'])) return release
    return { ...release, updateTo: { ...release['updateTo'], pub_date: feedDate(date) } }
  })
}

const FEED_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/

/** The `pub_date` of the release a feed names, in milliseconds, or null when the text is not a feed with one (it is no constraint then: `dateProblem` says nothing of it). */
export function feedDateOf(text: string): number | null {
  let feed: unknown
  try {
    feed = JSON.parse(text)
  } catch {
    // A feed in place that is not JSON is said by the step that reads it ("not a release file"); here it simply gives no date.
    return null
  }
  if (!isRecord(feed) || !Array.isArray(feed['releases'])) return null
  const entry = feed['releases'].find((release: unknown) => isRecord(release) && release['version'] === feed['currentRelease'])
  const written = isRecord(entry) && isRecord(entry['updateTo']) ? entry['updateTo']['pub_date'] : undefined
  const at = typeof written === 'string' && FEED_DATE_FORMAT.test(written) ? Date.parse(written) : Number.NaN
  return Number.isFinite(at) ? at : null
}

/**
 * Why the feed about to be written would be refused by every copy that read the one in place, or null. A copy keeps the latest `pub_date` it accepted and
 * refuses a feed dated before it (shared/update-feed-date.ts): a feed written with an earlier date than the one in place (the clock of this machine is behind,
 * a `--date` that is old) reaches nobody, and nobody would be told why. The same date is fine.
 */
export function dateProblem(inPlace: string, written: string): string | null {
  return datesProblem(feedDateOf(inPlace), feedDateOf(written))
}

/** How far ahead of the clock of this machine a feed may be dated: the time between writing the date and reading the clock, not a margin to publish ahead. */
export const FEED_DATE_SLACK_MS = 60_000

/**
 * Why the feed about to be written must not go out, or null: it is dated after the clock of this machine (a wrong `--date`, a clock that is ahead). A copy keeps the
 * latest date it accepted and never reads its own clock, so a date in the future would make it refuse every honest feed published until that date.
 */
export function futureProblem(written: string, now: Date): string | null {
  const at = feedDateOf(written)
  if (at === null || at <= now.getTime() + FEED_DATE_SLACK_MS) return null
  return `the feed to write is dated ${feedDate(new Date(at))}, after the clock of this machine (${feedDate(now)}): a copy that accepted it would refuse every feed published before that date. Check the clock of this machine, or the --date of the feed`
}

/** `dateProblem` on two instants (milliseconds), either of which may be unknown: a feed with no date is no constraint, and none is made up. */
export function datesProblem(before: number | null, now: number | null): string | null {
  if (before === null || now === null || now >= before) return null
  return `the feed to write is dated ${feedDate(new Date(now))}, before the feed in place (${feedDate(new Date(before))}): every copy that read the feed in place would refuse it as older. Check the clock of this machine, or the --date of the feed, then run it again`
}

/** What is wrong with the list of withdrawn versions of a feed read back from the server, or null: it must be exactly `want`. */
export function withdrawnProblem(text: string, want: readonly string[]): string | null {
  const read = readWithdrawn(text)
  if (read.problem) return read.problem
  return JSON.stringify(read.versions) === JSON.stringify(want) ? null : `the withdrawn versions are ${JSON.stringify(read.versions)}, expected ${JSON.stringify(want)}`
}

/** Compares two versions of digits and dots, number by number: negative when `a` is the older. */
export function compareDotted(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let at = 0; at < Math.max(left.length, right.length); at++) {
    const difference = (left[at] ?? 0) - (right[at] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * The first version the channels serve. The versions before it are another application (another identifier, another data folder): no feed of these
 * channels may ever name one. Every version from this one on refuses a feed that names an older version than itself, twice: the check calls it
 * "up to date" (shared/update-check.ts, `updateOutcome`), and Squirrel refuses the bundle (`ElectronSquirrelPreventDowngrades`, electron-builder.yml).
 * A withdrawal relies on both: going back to an earlier feed offers that version to the copies below it and nothing to the others.
 */
export const FIRST_FEED_VERSION = '1.0.0'

/**
 * Why the archive at hand must not be published over what the channel offers now (`offered`, null when it offers nothing a reader would take), or
 * null. Two refusals:
 *  - the channel already offers this version with another archive. The archive of a version has one name: installing this one replaces the file
 *    the feed in place names, with its old hash, minutes before the new feed arrives, or for good if a later step fails. Every copy that installs
 *    the update meanwhile refuses the file;
 *  - the channel offers a higher version. The copies on it would be told they are up to date and receive nothing more, and a new installation
 *    would get the older version. Going back is what `--withdraw` does, with its own checks.
 */
export function replacementProblem(offered: ExpectedRelease | null, archive: { version: string; sha256: string; size: number }): string | null {
  if (!offered) return null
  const order = compareDotted(archive.version, offered.version)
  if (order < 0) {
    return `the channel offers ${offered.version}, and ${archive.version} is below it: a publication never goes back (the copies on ${offered.version} would be told they are up to date and receive nothing more, and a new installation would get ${archive.version}). To take ${offered.version} out of the channel: --withdraw ${offered.version}`
  }
  if (order === 0 && (offered.sha256 !== archive.sha256 || offered.size !== archive.size)) {
    return `the channel already offers ${archive.version}, with another archive (${offered.size} bytes, SHA-256 ${offered.sha256}; the one at hand has ${archive.size} bytes and ${archive.sha256}). The archive of a version has one name: publishing this one would replace the file under the feed in place, and every copy that installs the update would refuse it until the new feed is there. Build it under a new version number, or take ${archive.version} out first (--withdraw ${archive.version}) and publish again`
  }
  return null
}

/**
 * Why the disk image at hand is not the image of the app in the archive, from the record scripts/make-dmg.mjs wrote with it; or null. `image` is
 * the image as it was just weighed, `executable` the executable of the built app (the one the archive was checked to hold). An image left from an
 * earlier build of the same version is notarized and has its sum, but holds another app than the commit the journal will name.
 */
export function imageRecordProblem(text: string, image: { name: string; sha256: string; size: number }, executable: { sha256: string; size: number }): string | null {
  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    return 'it is not JSON'
  }
  const of = isRecord(record) && isRecord(record['image']) ? record['image'] : null
  const holds = isRecord(record) && isRecord(record['executable']) ? record['executable'] : null
  if (!of || !holds) return 'it names no image or no executable'
  if (of['name'] !== image.name || of['sha256'] !== image.sha256 || of['size'] !== image.size) {
    return `it is the record of another image (${JSON.stringify(of['name'])}, SHA-256 ${JSON.stringify(of['sha256'])}), not of the one at hand (${image.sha256}): the image was made again without its record`
  }
  if (holds['sha256'] !== executable.sha256 || holds['size'] !== executable.size) {
    return `the image holds another build of the app than the archive (its executable has SHA-256 ${JSON.stringify(holds['sha256'])}, the one of the archive ${executable.sha256}): it was left from an earlier build. Make the image again (scripts/make-dmg.mjs), archive and disk image from the same app`
  }
  return null
}

/** The versions whose feed the folder keeps (`feed-<version>.json`), the highest first, from the names `ls -1` printed. */
export function keptFeedVersions(listing: string): string[] {
  return listing
    .split('\n')
    .map((name) => /^feed-(\d+\.\d+\.\d+)\.json$/.exec(name.trim())?.[1])
    .filter((version): version is string => version !== undefined)
    .sort((a, b) => compareDotted(b, a))
}

/**
 * What is wrong with the feed a withdrawal would go back to, or nothing. `kept` is the kept feed of `to`, as read; `withdrawn` is the version taken
 * out. It must be the feed of `to`, a version below the withdrawn one and not before the first one of the channels, and name the archive of `to`
 * in the folder of this channel.
 */
export function returnProblems(kept: ExpectedRelease | null, to: string, withdrawn: string, channel: Channel): string[] {
  const problems: string[] = []
  if (compareDotted(to, withdrawn) >= 0) problems.push(`${to} is not below ${withdrawn}: a withdrawal only goes back; a higher version is published, not returned to`)
  if (compareDotted(to, FIRST_FEED_VERSION) < 0) problems.push(`${to} is before ${FIRST_FEED_VERSION}, the first version these channels serve: no feed may name it`)
  if (!kept) return [...problems, `${keptFeedNameOf(to)} is not a release file`]
  if (kept.version !== to) problems.push(`${keptFeedNameOf(to)} offers ${kept.version}, not ${to}`)
  const url = new URL(archiveNameOf(to), channel.baseUrl).href
  if (kept.url !== url) problems.push(`${keptFeedNameOf(to)} names ${kept.url}, expected ${url}`)
  return problems
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The Electron fuses of an app: the sentinel of Electron's fuse wire in "Electron Framework", then the version byte, the length byte, and one byte
// per fuse ('0' off, '1' on, 'r' removed). The same reading as @electron/fuses' getCurrentFuseWire, without the dependency.

export const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'

export interface FuseWire {
  version: number
  bytes: number[]
}

/** The names of the positions of the wire (FuseV1Options of @electron/fuses 1.8.0). castLabs' build has one more position, without a name. */
export const FUSE_NAMES: readonly string[] = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges'
]

export const fuseFileOf = (app: string): string => join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework')

/** The wire whose sentinel starts at `at`, or null when the buffer ends before the wire does. */
function wireAt(buffer: Buffer, at: number): FuseWire | null {
  const start = at + FUSE_SENTINEL.length
  const version = buffer[start]
  const length = buffer[start + 1]
  if (version === undefined || length === undefined || start + 2 + length > buffer.length) return null
  return { version, bytes: [...buffer.subarray(start + 2, start + 2 + length)] }
}

/** The first fuse wire of a buffer (a whole binary), or null. */
export function findFuseWire(buffer: Buffer): FuseWire | null {
  const at = buffer.indexOf(FUSE_SENTINEL)
  return at === -1 ? null : wireAt(buffer, at)
}

/** The first fuse wire of a file, read by pieces: the framework is a few hundred megabytes. A sentinel cut by the end of a piece is found in the next. */
export async function readFuseWire(file: string, chunk = 8 * 1024 * 1024): Promise<FuseWire | null> {
  const handle = await open(file, 'r')
  try {
    const piece = Buffer.alloc(chunk)
    let carry = Buffer.alloc(0)
    for (let position = 0; ; ) {
      const { bytesRead } = await handle.read(piece, 0, chunk, position)
      const window = Buffer.concat([carry, piece.subarray(0, bytesRead)])
      const at = window.indexOf(FUSE_SENTINEL)
      if (at !== -1) {
        const wire = wireAt(window, at)
        if (wire) return wire
        // A wire cut by the end of the piece is read again with the next one (cut by the end of the file, it is not a wire: null below).
        carry = window.subarray(at)
      } else carry = window.subarray(Math.max(0, window.length - (FUSE_SENTINEL.length - 1)))
      if (bytesRead === 0) return null
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
}

const fuseState = (byte: number | undefined): string => (byte === 0x30 ? 'off' : byte === 0x31 ? 'on' : byte === 0x72 ? 'removed' : byte === undefined ? 'missing' : `0x${byte.toString(16)}`)
const fuseName = (position: number): string => FUSE_NAMES[position] ?? `fuse ${position}`

/** The fuses of a wire, one line each, in the words of the fuse reader of Electron (`RunAsNode is Disabled`): what `pnpm fuses:read` prints. */
export function fuseWireLines(wire: FuseWire): string[] {
  const words: Record<string, string> = { on: 'Enabled', off: 'Disabled', removed: 'Removed' }
  return [`Fuse version: v${wire.version}`, ...wire.bytes.map((byte, position) => `  ${fuseName(position)} is ${words[fuseState(byte)] ?? `unknown (${fuseState(byte)})`}`)]
}

/** What differs between the fuses of the new build and the installed app: a build that changes a fuse (the cookie encryption above all) is not an update. */
export function fuseWireProblems(built: FuseWire, installed: FuseWire): string[] {
  const problems: string[] = []
  if (built.version !== installed.version) problems.push(`the fuse wire is version ${built.version}, the installed app's is ${installed.version}`)
  if (built.bytes.length !== installed.bytes.length) problems.push(`the fuse wire has ${built.bytes.length} fuses, the installed app's has ${installed.bytes.length}`)
  for (let position = 0; position < Math.max(built.bytes.length, installed.bytes.length); position++) {
    if (built.bytes[position] !== installed.bytes[position]) problems.push(`${fuseName(position)} is ${fuseState(built.bytes[position])} in the new build and ${fuseState(installed.bytes[position])} in the installed app`)
  }
  return problems
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The publication

export interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface OutputHash {
  status: number | null
  sha256: string
  size: number
  stderr: string
}

/** Everything the publication does to the outside; `realDeps` is the real one. */
export interface PublishDeps {
  say: (line: string) => void
  exists: (path: string) => boolean
  readText: (path: string) => string
  writeText: (path: string, text: string) => void
  /** Runs a command to its end, without a shell. */
  run: (command: Command) => CommandResult
  /** Runs a command and hashes what it prints as it comes (the archive, downloaded back from the server). */
  hashOutput: (command: Command) => Promise<OutputHash>
  sha256File: (path: string) => Promise<{ sha256: string; size: number }>
  /** The fuse wire of the app at this path. */
  readFuseWire: (app: string) => Promise<FuseWire | null>
  /** Adds text at the end of a file, and makes its folder when it does not exist (the journal). */
  appendText: (path: string, text: string) => void
  now: () => Date
  /** The conditions of a publication (release-gate.ts): the script hands the module over, since Node resolves no import between two TypeScript files. */
  gate: typeof ReleaseGate
  /**
   * The keys of the feed (update-feed-signature.ts, `feedKeysIn`): the script hands them over like `gate`. They sign the feed that is written, with
   * the private key kept outside the repository, and say whether a feed read from the server is one that was signed here.
   */
  feedKeys: FeedKeys
}

/** What the server holds when the publication stops. */
export type Published = 'nothing' | 'archive' | 'archive and disk image' | 'archive and feed' | 'archive, disk image and feed' | 'everything'

/** `alreadyOffered`: the feed in place offered this version, with this same archive, before the publication started (a second run of the same publication). */
export type PublishResult = { ok: true; dryRun: boolean } | { ok: false; step: string; problem: string; published: Published; alreadyOffered?: true }

class PublishFailure extends Error {
  step: string
  constructor(step: string, problem: string) {
    super(problem)
    this.step = step
  }
}

/** The message the script prints when the publication failed: what went wrong, and what the server holds. */
export function describeFailure(result: { step: string; problem: string; published: Published; alreadyOffered?: true }, channel: Channel): string {
  const state: Record<Published, string> = {
    nothing: 'Nothing is published. The copies sent to the server, if any, were in a private folder that is removed when the publication stops (the lines above say so, or say it was not and how to remove it).',
    archive: 'The archive is published and the feed is not: no installed copy is offered the update. Run the command again once the cause is fixed.',
    'archive and disk image': 'The archive and the disk image (or the image without its sum) are published and the feed is not: no installed copy is offered the update. Run the command again once the cause is fixed.',
    'archive and feed': `The feed is already published, and it does not check out: look at ${new URL(FEED_NAME, channel.baseUrl).href} before any copy checks for updates.`,
    'archive, disk image and feed': `The feed is already published, and it does not check out: look at ${new URL(FEED_NAME, channel.baseUrl).href} before any copy checks for updates (the archive and the disk image are published).`,
    everything: 'Everything is published and checked online: the installed copies are offered the update. Only the journal lacks its line.'
  }
  // The feed in place already offered this very archive: saying that no copy is offered the update would be false.
  const again = 'The feed in place already offered this version with this same archive, and was not replaced: the installed copies are still offered the update. Run the command again once the cause is fixed.'
  const said = result.alreadyOffered && (result.published === 'archive' || result.published === 'archive and disk image') ? again : state[result.published]
  return `FAILED at "${result.step}": ${result.problem}\n${said}`
}

const firstLines = (text: string, count = 6): string => text.trim().split('\n').slice(0, count).join('\n')
const failureOf = (result: CommandResult | OutputHash): string => firstLines(result.stderr) || `exit code ${result.status === null ? 'none (timeout or not started)' : result.status}`

/**
 * Publishes the archive of `input`, then its feed. In a dry run the local checks are made (they read files and run no network command) and every
 * command that touches the network or the server is printed and not run. Never throws for a failed step: the result says which and why.
 */
export async function publish(input: PublishInput, deps: PublishDeps): Promise<PublishResult> {
  const { say } = deps
  const { dryRun } = input
  const feedFile = join(dirname(input.archive), FEED_NAME)
  const dmgFile = join(dirname(input.archive), dmgNameOf(input.version))
  const sumFile = join(dirname(input.archive), sumNameOf(input.version))
  let published: Published = 'nothing'
  let alreadyOffered = false
  let step = ''
  // What the journal keeps of this publication, gathered as the conditions are read: null until the build record names the commit.
  let trace: Omit<ReleaseGate.JournalEntry, 'at' | 'version' | 'channel' | 'outcome' | 'holds' | 'dmg'> | null = null
  let imageOfTrace: ReleaseGate.WeighedFile | null = null
  // The private folder of the server, from the moment `mktemp` made it until it is removed: whoever holds it removes it (step 10, or `finally`).
  let staging: string | null = null
  const { gate } = deps
  const readOrFail = (path: string, what: string): string => {
    try {
      return deps.readText(path)
    } catch (error) {
      throw new PublishFailure(step, `cannot read ${what} ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  /** The line of the journal for what the server holds now, or null when nothing names the build yet. */
  const lineOf = (outcome: 'published' | 'partial'): string | null =>
    trace ? gate.journalLine({ at: deps.now().toISOString(), version: input.version, channel: input.channelName, outcome, holds: published, ...trace, dmg: imageOfTrace }) : null

  const begin = (title: string, commands: Command[], touchesServer: boolean): boolean => {
    step = title
    say(`\n${title}`)
    for (const command of commands) say(`  $ ${commandLine(command)}${touchesServer && dryRun ? '   (dry run: not run)' : ''}`)
    return !(touchesServer && dryRun)
  }
  const ok = (line: string): void => say(`  ok  ${line}`)
  // A declaration, not a constant: TypeScript only narrows after a call to a function that is declared to return `never`.
  function fail(problem: string): never {
    throw new PublishFailure(step, problem)
  }
  /**
   * Removes the private folder of the server, once. What it held is either published (copied out by `install`) or not to be published, so a
   * failure here changes nothing for the users: it is said, with the command that removes it by hand, and the publication goes on or stops as it was.
   */
  const removeStaging = (cleanup: Command): void => {
    const folder = staging
    if (folder === null) return
    staging = null
    let removed: CommandResult
    try {
      removed = deps.run(cleanup)
    } catch (error) {
      removed = { status: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
    }
    if (removed.status !== 0) say(`  warning: the private folder ${folder} of the server was not removed: ${failureOf(removed)}\n  Remove it by hand: ${commandLine(cleanup)}`)
    else ok(`${folder} removed`)
  }

  try {
    say(`${dryRun ? 'Dry run of the publication' : 'Publication'} of Lucium ${input.version} on the channel "${input.channelName}" (${input.channel.baseUrl})`)

    // 1. The build.
    const stapler: Command = { program: 'xcrun', args: ['stapler', 'validate', input.app], timeoutMs: 2 * MINUTE }
    const plist: Command = { program: '/usr/bin/plutil', args: ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(input.app, 'Contents', 'Info.plist')], timeoutMs: MINUTE }
    begin('Check the build', [plist, stapler], false)
    if (!deps.exists(input.archive)) fail(`${input.archive} does not exist: build the release first (scripts/build-drm-release.sh --notarize --no-install …)`)
    const nameProblem = archiveNameProblem(basename(input.archive), input.version)
    if (nameProblem) fail(nameProblem)
    ok(`${basename(input.archive)} is the archive of ${input.version}`)
    if (!deps.exists(input.app)) fail(`${input.app} does not exist: it is the app the archive was made from (--app)`)
    const builtVersion = deps.run(plist)
    if (builtVersion.status !== 0) fail(`cannot read the version of ${input.app}: ${failureOf(builtVersion)}`)
    if (builtVersion.stdout.trim() !== input.version) fail(`the built app is ${builtVersion.stdout.trim()}, package.json says ${input.version}: the build is not of this version`)
    ok(`the built app is ${input.version}, as package.json`)
    if (compareDotted(input.version, FIRST_FEED_VERSION) < 0) fail(`${input.version} is before ${FIRST_FEED_VERSION}, the first version these channels serve: it is another application, and no feed of these channels may name it`)
    const staple = deps.run(stapler)
    if (staple.status !== 0) fail(`the app has no valid notarization ticket stapled to it (xcrun stapler validate): ${failureOf(staple)}`)
    ok('the notarization ticket is stapled')
    if (input.buildLog) {
      if (!deps.exists(input.buildLog)) fail(`${input.buildLog} does not exist (--build-log)`)
      const logProblem = buildLogProblem(deps.readText(input.buildLog))
      if (logProblem) fail(logProblem)
      ok('the build log says "Notarized, stapled"')
    }
    const builtWire = await deps.readFuseWire(input.app)
    if (!builtWire) fail(`no Electron fuse wire in ${fuseFileOf(input.app)}`)
    if (!deps.exists(input.installedApp)) fail(`${input.installedApp} does not exist: the fuses of the new build are compared with the installed app's (--installed-app)`)
    const installedWire = await deps.readFuseWire(input.installedApp)
    if (!installedWire) fail(`no Electron fuse wire in ${fuseFileOf(input.installedApp)}`)
    const fuseProblems = fuseWireProblems(builtWire, installedWire)
    if (fuseProblems.length > 0) fail(`the Electron fuses of the new build are not the installed app's:\n    ${fuseProblems.join('\n    ')}`)
    ok(`the ${builtWire.bytes.length} Electron fuses equal those of ${input.installedApp}`)
    if (dryRun) say(`  --  the key ${input.sshKey} is passed to ssh by its path, never opened (not looked for in a dry run)`)
    else if (!deps.exists(input.sshKey)) fail(`the ssh key ${input.sshKey} does not exist (--ssh-key, or LUCIUM_PUBLISH_SSH_KEY)`)

    // 2. The archive's hash and size.
    begin('Weigh the archive', [], false)
    const weight = await deps.sha256File(input.archive).catch((error: unknown) => fail(`cannot read ${input.archive}: ${error instanceof Error ? error.message : String(error)}`))
    ok(`SHA-256 ${weight.sha256}, ${weight.size} bytes`)
    const archiveFile: ReleaseGate.WeighedFile = { name: basename(input.archive), sha256: weight.sha256, size: weight.size }

    // 2a. The archive holds the app that was checked above. The signature of a bundle is in its executable (the code directory, which seals
    // Info.plist and the resources): the same executable is the same signed app. An app built again after the archive was made differs here.
    const executable = join(input.app, 'Contents', 'MacOS', 'Lucium')
    const zipped: Command = { program: '/usr/bin/unzip', args: ['-p', input.archive, 'Lucium.app/Contents/MacOS/Lucium'], timeoutMs: 5 * MINUTE }
    begin('Check that the archive holds the built app', [zipped], false)
    const inArchive = await deps.hashOutput(zipped)
    if (inArchive.status !== 0) fail(`cannot read Lucium.app/Contents/MacOS/Lucium in ${input.archive}: ${failureOf(inArchive)}`)
    const onDisk = await deps.sha256File(executable).catch((error: unknown) => fail(`cannot read ${executable}: ${error instanceof Error ? error.message : String(error)}`))
    if (inArchive.sha256 !== onDisk.sha256 || inArchive.size !== onDisk.size) {
      fail(`the app in the archive is not ${input.app} (its executable has SHA-256 ${inArchive.sha256}, the built one ${onDisk.sha256}): the app was built again after the archive was made. Build the release again, archive and disk image together`)
    }
    ok('the executable in the archive is the built one, with its signature')

    // 2a'. The archive carries no custom icon. Settings › About and updates › App icon puts the chosen icon on a running copy (an `Icon\r` at the root of its
    // bundle, src/main/shell/bundle-icon.ts): an archive made from such a copy would hand that file to every copy it updates. The build makes the
    // archive from the app it has just checked, before anything runs it; this is read in the archive itself.
    const listing: Command = { program: '/usr/bin/zipinfo', args: ['-1', input.archive], timeoutMs: MINUTE }
    begin('Check that the archive carries no custom icon', [listing], false)
    const listed = deps.run(listing)
    if (listed.status !== 0) fail(`cannot list the files of ${input.archive}: ${failureOf(listed)}`)
    if (listed.stdout.split('\n').includes(ARCHIVED_CUSTOM_ICON)) {
      fail(`the archive carries a custom icon (Lucium.app/Icon\\r): it was made from a copy that the icon of Settings › About and updates › App icon was put on, not from the build as it was checked. Build the release again, archive and disk image together`)
    }
    ok('the archive carries no custom icon')

    // 2b. Which commit the archive was built from: the record the build wrote beside it. Without it, nothing ties what is published to the sources.
    const tagName = `v${input.version}`
    const tagCommit: Command = { program: 'git', args: ['-C', input.root, 'rev-parse', '-q', '--verify', `refs/tags/${tagName}^{commit}`], timeoutMs: MINUTE }
    const tagSignature: Command = { program: 'git', args: ['-C', input.root, 'tag', '-v', tagName], timeoutMs: MINUTE }
    begin('Check where the build comes from', [tagCommit], false)
    if (!deps.exists(input.buildRecord)) {
      fail(`${input.buildRecord} does not exist: scripts/build-drm-release.sh --notarize writes it beside the archive, with the commit the archive was built from. An archive without its record is not published (--build-record names another file)`)
    }
    const built = gate.readBuildRecord(readOrFail(input.buildRecord, 'the build record'))
    if ('problem' in built) fail(`${input.buildRecord} is not a build record: ${built.problem}`)
    const recordProblems = gate.buildRecordProblems(built.record, { version: input.version, archive: archiveFile })
    if (recordProblems.length > 0) fail(`${input.buildRecord} is not the record of this archive:\n    ${recordProblems.join('\n    ')}`)
    const { commit } = built.record
    ok(`built from the commit ${commit}, the working tree clean`)
    // The tag of the version, when it exists, must name that commit. Its absence is said and kept in the journal, not refused: the versions that
    // came before the public repository have no tag.
    const tagged = deps.run(tagCommit)
    let tag: { name: string; signatureVerified: boolean } | null = null
    if (tagged.status === 0) {
      if (tagged.stdout.trim() !== commit) fail(`the tag ${tagName} names the commit ${tagged.stdout.trim()}, the archive was built from ${commit}: the tag and the build are not of the same sources`)
      tag = { name: tagName, signatureVerified: deps.run(tagSignature).status === 0 }
      ok(`the tag ${tagName} names that commit${tag.signatureVerified ? ', and Git verified its signature' : ''}`)
      if (!tag.signatureVerified) say(`  --  Git could not verify the signature of ${tagName} (git tag -v): unsigned, or no key to check it with on this Mac. Kept in the journal`)
    } else if (tagged.status === 1) say(`  --  no tag ${tagName} in ${input.root}: kept in the journal`)
    else fail(`cannot ask Git for the tag ${tagName}: ${failureOf(tagged)}`)

    // 2c. The changelogs say when: a version published under « Unreleased » keeps that heading for good.
    begin('Check the changelogs', [], false)
    for (const name of ['CHANGELOG.md', 'CHANGELOG.fr.md']) {
      const headingProblem = gate.changelogHeadingProblem(readOrFail(join(input.root, name), 'the changelog'), input.version, name)
      if (headingProblem) fail(headingProblem)
    }
    ok(`CHANGELOG.md and CHANGELOG.fr.md carry the date of ${input.version}`)

    // 2d. The engine suites passed on that commit, or the maintainer wrote why the publication goes without them.
    begin('Check the engine suites', [], false)
    let engineRun: ReleaseGate.JournalEntry['engineRun']
    if (input.noEngineRun !== null) {
      engineRun = { waived: input.noEngineRun }
      say(`  !!  --no-engine-run: published without the record of the engine suites. Reason, kept in the journal: ${input.noEngineRun}`)
    } else {
      if (!deps.exists(input.engineRun)) {
        fail(`${input.engineRun} does not exist: pnpm test:engine:release runs the engine suites on a Mac that is not in use and writes it. Without it: --no-engine-run "<reason>" (written in the journal)`)
      }
      const ran = gate.readEngineRun(readOrFail(input.engineRun, 'the record of the engine run'))
      if ('problem' in ran) fail(`${input.engineRun} is not the record of an engine run: ${ran.problem}`)
      const runProblems = gate.engineRunProblems(ran.record, commit)
      if (runProblems.length > 0) fail(`${input.engineRun} does not show that the engine suites passed on this commit:\n    ${runProblems.join('\n    ')}\n    Run pnpm test:engine:release on ${commit.slice(0, 12)}, or --no-engine-run "<reason>" (written in the journal)`)
      engineRun = { endedAt: ran.record.endedAt, reportSha256: ran.record.reportSha256 }
      ok(`the engine suites passed on that commit (${ran.record.endedAt})`)
    }
    trace = { commit, archive: archiveFile, tag, engineRun }

    // 2e. The lock between the channels: every channel but the test one takes a version that waited there, and that the maintainer tried.
    if (input.channelName !== TEST_CHANNEL) {
      begin(`Check the passage through the channel "${TEST_CHANNEL}"`, [], false)
      const journalText = deps.exists(input.journal) ? readOrFail(input.journal, 'the journal') : ''
      const journal = gate.readJournal(journalText)
      if (journal.problems.length > 0) fail(`the journal ${input.journal} cannot be trusted (${journal.problems.join('; ')}): repair it before anything goes to "${input.channelName}"`)
      const lock = gate.stableGate({ entries: journal.entries, withdrawals: gate.readWithdrawals(journalText), version: input.version, sha256: weight.sha256, now: deps.now(), minTestHours: input.minTestHours, securityFix: input.securityFix })
      if (lock.problems.length > 0) fail(`${lock.problems.join('\n    ')}\n    (journal: ${input.journal})`)
      if (lock.waived.length > 0) say(`  !!  --security-fix: ${lock.waived.join('; ')}. Published all the same. Reason, kept in the journal: ${input.securityFix}`)
      else ok(`this archive has been on the channel "${TEST_CHANNEL}" since ${lock.testPublishedAt}, ${input.minTestHours} h or more`)
      const testPublishedAt = lock.testPublishedAt as string
      if (!deps.exists(input.attestation)) {
        fail(`${input.attestation} does not exist: it is the maintainer's attestation of what was tried on the version of the test channel. Fill in and save:\n${gate.attestationTemplate(input.version, weight.sha256)}`)
      }
      const attested = gate.attestationProblems(readOrFail(input.attestation, 'the attestation'), { version: input.version, sha256: weight.sha256, testPublishedAt: new Date(testPublishedAt), now: deps.now() })
      if (attested.problems.length > 0 || !attested.attestation) fail(`${input.attestation} does not let ${input.version} into "${input.channelName}":\n    ${attested.problems.join('\n    ')}`)
      ok(`attested by ${attested.attestation.attestedBy} on ${attested.attestation.attestedAt}: ${gate.ATTESTED_CHECKS.join(', ')}`)
      // The reason of --security-fix is kept only when it waived something: a wait that was long enough needed none.
      trace = { ...trace, stable: { testPublishedAt, minTestHours: input.minTestHours, ...attested.attestation, securityFix: lock.waived.length > 0 ? input.securityFix : null } }
    }

    // 2b. The disk image beside the archive, if there is one: the public download. Its sum is the maintainer's word for it, so it is read here, not trusted.
    const stapleDmg: Command = { program: 'xcrun', args: ['stapler', 'validate', dmgFile], timeoutMs: 2 * MINUTE }
    const hasDmg = input.dmg && deps.exists(dmgFile)
    const hasSum = input.dmg && deps.exists(sumFile)
    begin('Check the disk image', hasDmg && hasSum ? [stapleDmg] : [], false)
    let image: { sha256: string; size: number; sumText: string } | null = null
    if (!input.dmg) say('  --  --no-dmg: the disk image, if there is one, is not published')
    else if (!hasDmg && !hasSum) say(`  --  no ${basename(dmgFile)} beside the archive: only the archive and the feed are published (scripts/make-dmg.mjs makes the image)`)
    else if (hasDmg !== hasSum) fail(`${hasDmg ? `${basename(sumFile)} is missing` : `${basename(dmgFile)} is missing`}: the disk image and its sum go together (scripts/make-dmg.mjs writes both), or neither (--no-dmg)`)
    else {
      const stapledDmg = deps.run(stapleDmg)
      if (stapledDmg.status !== 0) fail(`the disk image has no valid notarization ticket stapled to it (xcrun stapler validate): ${failureOf(stapledDmg)}`)
      ok('the disk image has its notarization ticket stapled')
      const weighed = await deps.sha256File(dmgFile).catch((error: unknown) => fail(`cannot read ${dmgFile}: ${error instanceof Error ? error.message : String(error)}`))
      let sumText = ''
      try {
        sumText = deps.readText(sumFile)
      } catch (error) {
        fail(`cannot read ${sumFile}: ${error instanceof Error ? error.message : String(error)}`)
      }
      const sumProblem = sumFileProblem(sumText, basename(dmgFile), weighed.sha256)
      if (sumProblem) fail(`${sumFile}: ${sumProblem}`)
      // The image is notarized and has its sum, and nothing so far says it holds the app of the archive: its record does.
      const recordFile = join(dirname(input.archive), imageRecordNameOf(input.version))
      if (!deps.exists(recordFile)) {
        fail(`${basename(recordFile)} is missing: scripts/make-dmg.mjs writes it with the image, and it says which app the image holds. Without it nothing ties the image to the archive: make the image again from ${input.app}, or publish without it (--no-dmg)`)
      }
      const recordProblem = imageRecordProblem(readOrFail(recordFile, 'the record of the disk image'), { name: basename(dmgFile), sha256: weighed.sha256, size: weighed.size }, onDisk)
      if (recordProblem) fail(`${recordFile}: ${recordProblem}`)
      ok('the disk image holds the app of the archive (the executable its record names)')
      image = { sha256: weighed.sha256, size: weighed.size, sumText }
      imageOfTrace = { name: basename(dmgFile), sha256: weighed.sha256, size: weighed.size }
      ok(`${basename(dmgFile)}: SHA-256 ${weighed.sha256}, ${weighed.size} bytes, as its sum says`)
    }
    // Planned first in the folder of the template (the addresses do not depend on it, and a dry run prints it), then again in the folder `mktemp` made.
    const planIn = (folder: string): RemotePlan => remotePlan({ archive: input.archive, feed: feedFile, channel: input.channel, sshKey: input.sshKey, disk: image ? { dmg: dmgFile, sum: sumFile } : null, staging: folder })
    const diskOf = (plan: RemotePlan) => (image && plan.disk ? { ...image, plan: plan.disk } : null)
    let remote = planIn(STAGING_TEMPLATE)
    let disk = diskOf(remote)

    // 3. The release file, written by scripts/make-update-feed.mjs and checked against the archive before it goes anywhere.
    const makeFeed = makeFeedCommand(input.root, input.archive, input.channel.baseUrl)
    begin('Write the feed', [makeFeed], false)
    const made = deps.run(makeFeed)
    if (made.status !== 0) fail(`scripts/make-update-feed.mjs refused:\n    ${firstLines(made.stderr, 10).replace(/\n/g, '\n    ')}`)
    const expected: ExpectedRelease = { version: input.version, url: remote.archiveUrl, sha256: weight.sha256, size: weight.size }
    const written = feedProblems(made.stdout, expected)
    if (written.length > 0) fail(`the feed that was written does not describe the archive:\n    ${written.join('\n    ')}`)
    ok(`the feed names ${remote.archiveUrl} with its SHA-256 and size`)
    const ahead = futureProblem(made.stdout, deps.now())
    if (ahead) fail(ahead)
    if (dryRun) say(`  --  ${feedFile} is not written in a dry run`)
    else {
      deps.writeText(feedFile, made.stdout)
      ok(`${feedFile} written`)
    }
    // The versions withdrawn from this channel, which the feed lists for the copies that still run one (step 3b fills it).
    let carried: string[] = []

    // 3b. What the channel offers now, read before anything is sent or replaced: see `replacementProblem`.
    const readInPlace = readFeedCommand(input.channel, input.sshKey)
    if (begin('Read what the channel offers now', [readInPlace], true)) {
      const inPlace = deps.run(readInPlace)
      if (inPlace.status !== 0) fail(`cannot read the feed in place on the server, so nothing is sent: ${failureOf(inPlace)}`)
      const offeredNow = inPlace.stdout.trim() === '' ? null : readRelease(inPlace.stdout)
      const refusal = replacementProblem(offeredNow, { version: input.version, sha256: weight.sha256, size: weight.size })
      if (refusal) fail(refusal)
      alreadyOffered = offeredNow?.version === input.version
      // A copy refuses a feed dated before the one it read last: this one must not be (a clock that is behind, an old --date).
      const stale = dateProblem(inPlace.stdout, made.stdout)
      if (stale) fail(stale)
      if (inPlace.stdout.trim() === '') ok('the channel has no feed yet')
      else if (!offeredNow) say('  warning: the feed in place is not a release file: it cannot be compared with this version, and will be kept aside before it is replaced')
      else if (alreadyOffered) ok(`the channel already offers ${input.version}, with this same archive: nothing a copy installs changes`)
      else ok(`the channel offers ${offeredNow.version}, below ${input.version}`)
      // The withdrawn versions: those the feed in place lists, and those the journal shows as withdrawn from this channel and not published
      // again (a channel left without a feed carried no list). Never the version being published: publishing it is what puts it back.
      // The list is carried into a feed that is signed here: it is taken only from a feed that was signed here, never from whatever the server holds.
      const inPlaceSigned = inPlace.stdout.trim() === '' ? '' : deps.feedKeys.signedPart(inPlace.stdout)
      if (inPlaceSigned === null) say('  warning: the feed in place carries no signature by a key of the feed (it was published before the feeds were signed, or it was changed on the server): its list of withdrawn versions is not carried, only the one of the journal is')
      const listed = readWithdrawn(inPlaceSigned ?? '')
      if (listed.problem) say(`  warning: in the feed in place, ${listed.problem}: only the versions of that list are carried`)
      const journalText = deps.exists(input.journal) ? readOrFail(input.journal, 'the journal') : ''
      const inJournal = gate.withdrawnOn({ entries: gate.readJournal(journalText).entries, withdrawals: gate.readWithdrawals(journalText), channel: input.channelName })
      carried = withdrawnList([...listed.versions, ...inJournal], input.version)
      if (carried.length > 0) {
        deps.writeText(feedFile, feedWithWithdrawn(made.stdout, carried))
        ok(`${feedFile} written again with the versions withdrawn from this channel (${carried.join(', ')}): a copy that runs one of them is told so`)
      }
    } else say('  --  then the version and the SHA-256 that feed names are compared with this archive: the same version with another archive, or a higher version, stops everything here; and the versions withdrawn from the channel (the feed in place, the journal) are written in the feed')

    // 3c. The signature, once the feed says all it will say: a copy believes a feed only when a key it carries signed it. The private key is read
    // here and nowhere else; a key that is missing, or that the builds do not carry the public half of, stops everything before anything is sent.
    begin('Sign the feed', [], false)
    const signedFeed = deps.feedKeys.sign(carried.length > 0 ? feedWithWithdrawn(made.stdout, carried) : made.stdout)
    if (!signedFeed.ok) fail(`the feed is not signed, so nothing is sent:\n    ${signedFeed.problem}`)
    ok(`signed with ${signedFeed.keys} key(s): the installed copies read only what was signed`)
    if (dryRun) say(`  --  ${feedFile} is not written in a dry run`)
    else {
      deps.writeText(feedFile, signedFeed.text)
      ok(`${feedFile} written with its signature`)
    }

    // 4. To a private folder of the server: nothing is public yet, and no other account there can read or replace what is sent.
    const makeStaging = makeStagingCommand(input.channel, input.sshKey)
    if (begin('Make a private folder on the server', [makeStaging], true)) {
      const made = deps.run(makeStaging)
      if (made.status !== 0) fail(`mktemp failed on the server, so nothing is sent: ${failureOf(made)}`)
      const folder = stagingFolderOf(made.stdout)
      // Never used, never removed: a path that is not one mktemp makes goes into no command. A folder it may have made stays, and is named here.
      if (folder === null) fail(`the server printed ${JSON.stringify(firstLines(made.stdout, 3))} instead of a folder ${STAGING_TEMPLATE}: nothing is sent. If a folder ${STAGING_TEMPLATE.replace(/X+$/, '*')} was made, it is empty: remove it by hand`)
      staging = folder
      remote = planIn(folder)
      disk = diskOf(remote)
      ok(`${folder}, mode 0700: it is removed at the end, whatever happens`)
    } else say(`  --  the files go into the folder it prints (${STAGING_TEMPLATE} below), mode 0700, removed at the end whatever happens`)
    if (begin(`Send the archive${disk ? ', the disk image' : ''} and the feed to the private folder of the server`, [remote.upload], true)) {
      const sent = deps.run(remote.upload)
      if (sent.status !== 0) fail(`scp failed: ${failureOf(sent)}`)
      ok('sent')
    }

    // 5. The copy there must be the file here.
    if (begin('Check the copy on the server', disk ? [remote.remoteHash, disk.plan.remoteHash] : [remote.remoteHash], true)) {
      const hashed = deps.run(remote.remoteHash)
      if (hashed.status !== 0) fail(`sha256sum failed on the server: ${failureOf(hashed)}`)
      const there = parseSha256Line(hashed.stdout)
      if (there !== weight.sha256) fail(`the copy on the server has SHA-256 ${there ?? `(unreadable: ${firstLines(hashed.stdout, 2)})`}, the local archive ${weight.sha256}: the transfer is wrong`)
      ok('the copy has the same SHA-256')
      if (disk) {
        const hashedImage = deps.run(disk.plan.remoteHash)
        if (hashedImage.status !== 0) fail(`sha256sum of the disk image failed on the server: ${failureOf(hashedImage)}`)
        const thereImage = parseSha256Line(hashedImage.stdout)
        if (thereImage !== disk.sha256) fail(`the copy of the disk image on the server has SHA-256 ${thereImage ?? `(unreadable: ${firstLines(hashedImage.stdout, 2)})`}, the local image ${disk.sha256}: the transfer is wrong`)
        ok('the copy of the disk image has the same SHA-256')
      }
    }

    // 6. The archive FIRST.
    if (begin('Publish the archive', [remote.installArchive], true)) {
      const installed = deps.run(remote.installArchive)
      if (installed.status !== 0) fail(`the archive was not installed: ${failureOf(installed)}`)
      published = 'archive'
      ok(`${remote.archiveUrl} written, root:root 0644`)
    }

    // 7. It must answer, with the bytes that were sent, before anything names it.
    if (begin('Check the archive online', [remote.downloadArchive], true)) {
      const downloaded = await deps.hashOutput(remote.downloadArchive)
      if (downloaded.status !== 0) fail(`cannot download ${remote.archiveUrl}: ${failureOf(downloaded)}`)
      if (downloaded.sha256 !== weight.sha256 || downloaded.size !== weight.size) {
        fail(`the archive online is ${downloaded.size} bytes with SHA-256 ${downloaded.sha256}, the local one ${weight.size} bytes with ${weight.sha256}`)
      }
      ok(`the archive online has the SHA-256 and the size of the local one`)
    }

    // 7b. The disk image and its sum: after the archive, which made the folder, and before the feed. Nothing names them, so they can wait for the check.
    if (disk) {
      if (begin('Publish the disk image and its sum', [disk.plan.installDmg, disk.plan.installSum], true)) {
        const installedImage = deps.run(disk.plan.installDmg)
        if (installedImage.status !== 0) fail(`the disk image was not installed: ${failureOf(installedImage)}`)
        published = 'archive and disk image'
        ok(`${disk.plan.dmgUrl} written, root:root 0644`)
        const installedSum = deps.run(disk.plan.installSum)
        if (installedSum.status !== 0) fail(`the sum of the disk image was not installed: ${failureOf(installedSum)}`)
        ok(`${disk.plan.sumUrl} written, root:root 0644`)
      }
      if (begin('Check the disk image online', [disk.plan.downloadDmg, disk.plan.fetchSum], true)) {
        const downloadedImage = await deps.hashOutput(disk.plan.downloadDmg)
        if (downloadedImage.status !== 0) fail(`cannot download ${disk.plan.dmgUrl}: ${failureOf(downloadedImage)}`)
        if (downloadedImage.sha256 !== disk.sha256 || downloadedImage.size !== disk.size) {
          fail(`the disk image online is ${downloadedImage.size} bytes with SHA-256 ${downloadedImage.sha256}, the local one ${disk.size} bytes with ${disk.sha256}`)
        }
        ok('the disk image online has the SHA-256 and the size of the local one')
        const fetchedSum = deps.run(disk.plan.fetchSum)
        if (fetchedSum.status !== 0) fail(`cannot read ${disk.plan.sumUrl}: ${failureOf(fetchedSum)}`)
        if (fetchedSum.stdout.trim() !== disk.sumText.trim()) fail(`the sum online is not the local one: ${firstLines(fetchedSum.stdout, 2)}`)
        ok('the sum online is the local one')
      }
    }

    // 7c. The feed in place is kept under the name of its version before the new one replaces it: it is what `--withdraw` goes back to.
    const readCurrent = readFeedCommand(input.channel, input.sshKey)
    if (begin('Keep the feed that is published now', [readCurrent], true)) {
      const current = deps.run(readCurrent)
      if (current.status !== 0) fail(`cannot read the feed in place on the server, so it is not replaced: ${failureOf(current)}`)
      const offered = current.stdout.trim() === '' ? null : readRelease(current.stdout)
      if (current.stdout.trim() === '') say('  --  the channel has no feed yet: nothing to keep')
      else if (offered?.version === input.version) say(`  --  the feed in place is already the one of ${input.version}: the feed kept before it stays as it is`)
      else {
        // A feed nobody can read is kept all the same, under a name of its own: it is about to be replaced, and it may be the only trace of what went wrong.
        const name = offered ? keptFeedNameOf(offered.version) : REPLACED_FEED_NAME
        const keep = keepFeedCommand(input.channel, input.sshKey, name)
        say(`  $ ${commandLine(keep)}`)
        const kept = deps.run(keep)
        if (kept.status !== 0) fail(`the feed in place was not kept as ${name}, so it is not replaced: ${failureOf(kept)}`)
        if (offered) ok(`the feed of ${offered.version} is kept as ${name}`)
        else say(`  warning: the feed in place is not a release file; it is kept as ${name}`)
      }
    } else say(`  --  then the feed it prints is copied to ${keptFeedNameOf('<its version>')} in the same folder`)

    // 8. The feed, once the archive answers.
    if (begin('Publish the feed', [remote.installFeed], true)) {
      const installed = deps.run(remote.installFeed)
      if (installed.status !== 0) fail(`the feed was not installed: ${failureOf(installed)}`)
      published = disk ? 'archive, disk image and feed' : 'archive and feed'
      ok(`${remote.feedUrl} written, root:root 0644`)
    }

    // 9. What the installed copies will read.
    if (begin('Check the feed online', [remote.fetchFeed], true)) {
      const fetched = deps.run(remote.fetchFeed)
      if (fetched.status !== 0) fail(`cannot read ${remote.feedUrl}: ${failureOf(fetched)}`)
      const online = feedProblems(fetched.stdout, expected)
      const list = withdrawnProblem(fetched.stdout, carried)
      if (list) online.push(list)
      // A copy checks the signature on the bytes it receives: one byte changed between here and there, and it refuses the feed.
      if (fetched.stdout !== signedFeed.text) online.push('it is not, byte for byte, the feed that was signed: the installed copies would refuse it')
      if (online.length > 0) fail(`the feed online is not the one that was published:\n    ${online.join('\n    ')}`)
      ok(`currentRelease is ${input.version}, with the SHA-256 and the size of the archive`)
    }

    // 10. Housekeeping, after the check: everything is published, a failure here changes nothing for the users. A publication that stops before
    // removes the folder in `finally`.
    if (begin('Remove the private folder on the server', [remote.cleanup], true)) removeStaging(remote.cleanup)

    // 11. The journal: what was published, where, from which commit. After everything, so that its line says what the server really holds.
    begin('Write the journal', [], false)
    const line = lineOf('published')
    if (dryRun) say(`  --  ${input.journal} is not written in a dry run. Its line would be:\n      ${line?.trim()}`)
    else {
      published = 'everything'
      try {
        deps.appendText(input.journal, lineOf('published') as string)
      } catch (error) {
        fail(`${input.journal} could not be written (${error instanceof Error ? error.message : String(error)}). Add this line to it by hand, the lock of the stable channel reads it:\n${lineOf('published')}`)
      }
      ok(`${input.journal}: one line added`)
    }

    say(dryRun ? '\nDry run done: nothing was sent to the server and nothing was written.' : `\nLucium ${input.version} is published on the channel "${input.channelName}".`)
    if (disk && !dryRun) say(`The disk image: ${disk.plan.dmgUrl}`)
    return { ok: true, dryRun }
  } catch (error) {
    if (!(error instanceof PublishFailure)) throw error
    // A publication that stopped half way left files on the server: the journal says so too. It is never counted as a passage through a channel.
    let problem = error.message
    const partial = published !== 'nothing' && published !== 'everything' ? lineOf('partial') : null
    if (partial) {
      try {
        deps.appendText(input.journal, partial)
      } catch (journalError) {
        problem += `\nAnd the journal ${input.journal} could not be written (${journalError instanceof Error ? journalError.message : String(journalError)}); its line:\n${partial}`
      }
    }
    return { ok: false, step: error.step, problem, published, ...(alreadyOffered ? { alreadyOffered: true as const } : {}) }
  } finally {
    // A publication that stopped (a failed step, or an error nobody expected) after `mktemp` made the folder: it goes now, before the failure is told.
    if (staging !== null) {
      say('\nRemove the private folder on the server')
      const cleanup = remotePlan({ archive: input.archive, feed: feedFile, channel: input.channel, sshKey: input.sshKey, staging }).cleanup
      say(`  $ ${commandLine(cleanup)}`)
      removeStaging(cleanup)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The withdrawal

/** What the channel offers when a withdrawal stops. */
export type Offered = 'unchanged' | 'earlier version' | 'nothing'

/** `journalOnly`: the withdrawal itself is done and checked, and only its line of the journal could not be written. */
export type WithdrawResult = { ok: true; dryRun: boolean; offered: Offered } | { ok: false; step: string; problem: string; offered: Offered; journalOnly?: true }

/** The message the script prints when a withdrawal failed: what went wrong, and what the channel offers. */
export function describeWithdrawFailure(result: { step: string; problem: string; offered: Offered; journalOnly?: true }, input: WithdrawInput): string {
  if (result.journalOnly) return `FAILED at "${result.step}": ${result.problem}\nLucium ${input.version} is withdrawn from the channel "${input.channelName}" and checked online. Only the journal lacks its line.`
  const state: Record<Offered, string> = {
    unchanged: `The feed was not changed: the channel offers what it offered before. Nothing of ${input.version} was renamed.`,
    'earlier version': `The feed no longer offers ${input.version}: it went back to an earlier version. The files of ${input.version} may still answer: run the command again once the cause is fixed.`,
    nothing: `The feed was taken away: the channel offers nothing, and a check for updates fails until a version is published. The files of ${input.version} may still answer: run the command again once the cause is fixed.`
  }
  return `FAILED at "${result.step}": ${result.problem}\n${state[result.offered]}`
}

/**
 * Takes `input.version` out of a channel, without publishing anything:
 *   1. reads the folder of the channel and its feed (also in a dry run: these commands change nothing);
 *   2. when the feed offers that version, puts back the kept feed of an earlier one (`--to`, else the highest kept below it), after checking that
 *      feed and the archive it names; with `--to none`, takes the feed away. A feed that offers another version is left as it is;
 *      In both cases the feed that stays lists the version as withdrawn (`WITHDRAWN_KEY`), with those it listed before: the copies that run it
 *      read that in the feed and say so. A channel left without a feed lists nothing; the next publication takes the list from the journal;
 *   3. renames the archive, the disk image, its sum and the kept feed of the version so that they answer 404, and checks that they do.
 *   4. adds one line to the journal of the publications, of the type `withdrawal`.
 * The feed is dealt with first: nothing may name a file that is gone. Running it again after a failure, or for a version the feed no longer
 * offers, is safe. It never offers a version to a copy that runs a later one: see `FIRST_FEED_VERSION`.
 * It is not a publication: none of the conditions of one is read (no build record, no engine run, no wait, no attestation), on any channel.
 */
export async function withdraw(input: WithdrawInput, deps: Pick<PublishDeps, 'say' | 'run' | 'exists' | 'appendText' | 'now' | 'gate' | 'feedKeys'>): Promise<WithdrawResult> {
  const { say } = deps
  const { dryRun, version } = input
  const plan = withdrawPlan({ version, channel: input.channel, sshKey: input.sshKey })
  let offered: Offered = 'unchanged'
  let step = ''
  // What the journal keeps: the version the feed went back to, and whether a command that changes the server was run at all.
  let wentBackTo: string | null = null
  let changed = false
  let journalOnly = false
  const lineOf = (outcome: 'withdrawn' | 'partial'): string =>
    deps.gate.withdrawalLine({ at: deps.now().toISOString(), type: deps.gate.WITHDRAWAL, version, channel: input.channelName, outcome, offers: offered, to: wentBackTo })
  const begin = (title: string): void => {
    step = title
    say(`\n${title}`)
  }
  const ok = (line: string): void => say(`  ok  ${line}`)
  function fail(problem: string): never {
    throw new PublishFailure(step, problem)
  }
  /** Runs a command that only reads (also in a dry run). */
  const read = (command: Command): CommandResult => {
    say(`  $ ${commandLine(command)}`)
    return deps.run(command)
  }
  /** Runs a command that changes the server, or prints it in a dry run; null when it was not run. */
  const change = (command: Command): CommandResult | null => {
    say(`  $ ${commandLine(command)}${dryRun ? '   (dry run: not run)' : ''}`)
    if (dryRun) return null
    changed = true
    return deps.run(command)
  }
  const statusOf = (url: string): string => {
    const answer = read(plan.statusOf(url))
    if (answer.status !== 0) fail(`cannot ask ${url}: ${failureOf(answer)}`)
    return answer.stdout.trim()
  }

  try {
    say(`${dryRun ? 'Dry run of the withdrawal' : 'Withdrawal'} of Lucium ${version} from the channel "${input.channelName}" (${input.channel.baseUrl})`)
    if (dryRun) say('A dry run reads the server (the folder, the feeds, the sums) and changes nothing there.')
    begin('Check the key')
    if (!deps.exists(input.sshKey)) fail(`the ssh key ${input.sshKey} does not exist (--ssh-key, or LUCIUM_PUBLISH_SSH_KEY)`)
    ok(`${input.sshKey} is passed to ssh by its path, never opened`)

    // 1. What the channel holds and offers.
    begin('Read the channel')
    const listed = read(plan.list)
    if (listed.status !== 0) fail(`cannot list the folder of the channel: ${failureOf(listed)}`)
    const current = read(plan.readFeed)
    if (current.status !== 0) fail(`cannot read the feed in place: ${failureOf(current)}`)
    const hasFeed = current.stdout.trim() !== ''
    const inPlace = hasFeed ? readRelease(current.stdout) : null
    if (hasFeed && !inPlace) fail(`the feed in place is not a release file: look at ${plan.feedUrl} and publish a version; a withdrawal cannot tell what it offers`)
    ok(inPlace ? `the feed offers ${inPlace.version}` : 'the channel has no feed: it offers nothing')
    const listedInPlace = readWithdrawn(current.stdout)
    if (listedInPlace.problem) say(`  warning: in the feed in place, ${listedInPlace.problem}: only the versions of that list are kept`)
    /**
     * Writes `text` as the feed and reads it back: it must offer `release` and list `list`. False in a dry run (nothing was written). `onWritten`
     * runs as soon as the server holds the new feed, before it is read back: what the channel offers has changed from there on.
     */
    const writeFeed = (text: string, release: ExpectedRelease, list: readonly string[], notWritten: string, what: string, onWritten?: () => void): boolean => {
      // Signed again: the list changed the bytes, and a copy believes no feed without a signature that holds on them. Also in a dry run, which
      // then shows that the key is there and is one the builds carry.
      const signed = deps.feedKeys.sign(text)
      if (!signed.ok) fail(`the feed is not signed, so the one in place is not replaced:\n    ${signed.problem}`)
      ok(`the feed to write is signed with ${signed.keys} key(s)`)
      const written = change(plan.writeFeed(signed.text))
      if (!written) return false
      if (written.status !== 0) fail(`${notWritten}: ${failureOf(written)}`)
      onWritten?.()
      const fetched = read(plan.fetchFeed)
      if (fetched.status !== 0) fail(`cannot read ${plan.feedUrl}: ${failureOf(fetched)}`)
      const online = feedProblems(fetched.stdout, release)
      const listProblem = withdrawnProblem(fetched.stdout, list)
      if (listProblem) online.push(listProblem)
      if (fetched.stdout !== signed.text) online.push('it is not, byte for byte, the feed that was signed: the installed copies would refuse it')
      if (online.length > 0) fail(`the feed online is not ${what}:\n    ${online.join('\n    ')}`)
      return true
    }

    // The feed a withdrawal writes is dated now (see `feedWithWithdrawn`): it must not be before the feed in place, or no copy would take it. Said before anything is changed.
    const clockProblem = (): void => {
      const stale = datesProblem(feedDateOf(current.stdout), deps.now().getTime())
      if (stale) fail(stale)
    }

    // 2. The feed first: nothing may name a file that is about to go.
    if (inPlace?.version !== version) {
      const list = inPlace ? withdrawnList([...listedInPlace.versions, version], inPlace.version) : []
      if (!inPlace || JSON.stringify(list) === JSON.stringify(listedInPlace.versions)) {
        begin('Leave the feed as it is')
        say(`  --  the feed does not offer ${version}${inPlace ? ` (it offers ${inPlace.version}, and already lists ${version} as withdrawn)` : ''}: it is not changed`)
      } else {
        // What the channel offers does not change; the copies that still run the version are told it was withdrawn.
        begin(`List ${version} as withdrawn in the feed`)
        clockProblem()
        say(`  --  the feed does not offer ${version} (it offers ${inPlace.version}): what it offers is not changed`)
        // What is signed here is the feed of the server with one list changed: it must be a feed that was signed here, not whatever the server holds.
        const source = deps.feedKeys.signedPart(current.stdout)
        if (source === null) {
          fail(`the feed in place carries no signature by a key of the feed, so it is not signed again as it is: it was published before the feeds were signed, or it was changed on the server. Look at ${plan.feedUrl}, then publish a version (its feed is written and signed here)`)
        }
        if (writeFeed(feedWithWithdrawn(source, list, deps.now()), inPlace, list, `${version} was not listed as withdrawn in the feed, which is as it was`, `the one of ${inPlace.version} with ${version} listed as withdrawn`)) ok(`the feed online still offers ${inPlace.version}, and lists as withdrawn: ${list.join(', ')}`)
      }
    } else if (input.to === NO_FEED) {
      begin('Take the feed away')
      const dropped = change(plan.dropFeed)
      if (dropped) {
        if (dropped.status !== 0) fail(`the feed was not taken away: ${failureOf(dropped)}`)
        offered = 'nothing'
        const answer = statusOf(plan.feedUrl)
        if (answer !== '404') fail(`${plan.feedUrl} answers ${answer} and not 404: the feed is still served`)
        ok(`${plan.feedUrl} answers 404: nothing is offered, and a check for updates fails until a version is published`)
      }
    } else {
      begin('Choose the version the feed goes back to')
      const to = input.to ?? keptFeedVersions(listed.stdout).find((kept) => compareDotted(kept, version) < 0) ?? null
      if (to === null) {
        fail(
          `the folder keeps no feed of a version below ${version} (${keptFeedNameOf('<version>')}): there is nothing to go back to.\n` +
            `    Publish a higher version (the fix, or the code of the previous version under a new number), or take the feed away with --to ${NO_FEED}.`
        )
      }
      const target = plan.target(to)
      const kept = read(target.readKept)
      if (kept.status !== 0) fail(`cannot read ${keptFeedNameOf(to)} in the folder of the channel: ${failureOf(kept)}`)
      const release = readRelease(kept.stdout)
      const problems = returnProblems(release, to, version, input.channel)
      if (problems.length > 0 || !release) fail(`the feed cannot go back to ${to}:\n    ${problems.join('\n    ')}`)
      ok(`${keptFeedNameOf(to)} is the feed of ${to}, below ${version}`)
      // The feed that goes back is signed again here: only one that was signed here before is taken, never whatever the server holds under that name.
      const keptSource = deps.feedKeys.signedPart(kept.stdout)
      if (keptSource === null) {
        fail(
          `${keptFeedNameOf(to)} carries no signature by a key of the feed: it was kept before the feeds were signed, or it was changed on the server. The feed cannot go back to it.\n` +
            `    Name another version with --to, publish a higher version, or take the feed away with --to ${NO_FEED}.`
        )
      }
      ok(`${keptFeedNameOf(to)} was signed by a key of the feed`)
      // The archive it names must still be there, with its bytes: a feed that names a missing or changed archive fails every installation.
      const weighed = read(target.weighArchive)
      if (weighed.status !== 0) fail(`the archive of ${to} cannot be weighed in the folder of the channel: ${failureOf(weighed)}`)
      const [hashLine = '', sizeLine = ''] = weighed.stdout.trim().split('\n')
      const there = parseSha256Line(hashLine)
      if (there !== release.sha256 || Number(sizeLine.trim()) !== release.size) {
        fail(`the archive of ${to} on the server is ${sizeLine.trim() || '?'} bytes with SHA-256 ${there ?? '(unreadable)'}, its feed says ${release.size} bytes with ${release.sha256}`)
      }
      ok(`the archive of ${to} is on the server with the SHA-256 and the size its feed says`)

      begin(`Put the feed of ${to} back`)
      clockProblem()
      const aside = change(plan.keepWithdrawnFeed)
      if (aside && aside.status !== 0) fail(`the feed of ${version} was not kept aside, so it is not replaced: ${failureOf(aside)}`)
      // The kept feed, with the withdrawn version in its list: the one thing that tells a copy on that version why nothing higher is offered.
      const listedKept = readWithdrawn(kept.stdout)
      if (listedKept.problem) say(`  warning: in ${keptFeedNameOf(to)}, ${listedKept.problem}: only the versions of that list are kept`)
      const list = withdrawnList([...listedInPlace.versions, ...listedKept.versions, version], to)
      const wentBack = (): void => {
        offered = 'earlier version'
        wentBackTo = to
      }
      if (writeFeed(feedWithWithdrawn(keptSource, list, deps.now()), release, list, `the feed of ${to} was not put back`, `the one of ${to}`, wentBack)) {
        const answer = statusOf(target.archiveUrl)
        if (answer !== '200') fail(`${target.archiveUrl} answers ${answer} and not 200: the feed names an archive that does not answer`)
        ok(`the feed online offers ${to}, lists as withdrawn: ${list.join(', ')}, and its archive answers`)
      }
    }

    // 3. The files of the version, so that nobody downloads it any more. Never while the feed still names them.
    begin(`Set the files of ${version} aside`)
    const renamed = change(plan.setAsideFiles)
    if (renamed) {
      if (renamed.status !== 0) fail(`the files of ${version} were not all renamed: ${failureOf(renamed)}`)
      for (const url of plan.withdrawnUrls) {
        const answer = statusOf(url)
        if (answer !== '404') fail(`${url} answers ${answer} and not 404: the file is still served`)
      }
      ok(`the archive, the disk image and its sum answer 404 (the files stay on the server, renamed *${WITHDRAWN_SUFFIX})`)
    }

    // 4. The journal: a line of its own type, after everything, so that it says what the channel really offers. No condition reads it.
    begin('Write the journal')
    if (dryRun) say(`  --  ${input.journal} is not written in a dry run`)
    else {
      const line = lineOf('withdrawn')
      try {
        deps.appendText(input.journal, line)
      } catch (error) {
        journalOnly = true
        fail(`${input.journal} could not be written (${error instanceof Error ? error.message : String(error)}). Add this line to it by hand:\n${line}`)
      }
      ok(`${input.journal}: one line added`)
    }

    say(dryRun ? '\nDry run done: nothing was changed on the server.' : `\nLucium ${version} is withdrawn from the channel "${input.channelName}".`)
    say('Still to do by hand (docs/community/release-process.md, "Withdrawing a version"):')
    say('  - the download pages of the site name the disk image by hand: point them to another version, and deploy;')
    say(`  - the copies that already run ${version} stay on it until a higher version is published: no feed makes a copy go back. From the version that reads the list of the feed on, they say "This version has been withdrawn" and name the version to install.`)
    return { ok: true, dryRun, offered }
  } catch (error) {
    if (!(error instanceof PublishFailure)) throw error
    if (journalOnly) return { ok: false, step: error.step, problem: error.message, offered, journalOnly: true }
    // A withdrawal that stopped after it changed the server says so in the journal too. One that changed nothing leaves no line.
    let problem = error.message
    if (changed) {
      const partial = lineOf('partial')
      try {
        deps.appendText(input.journal, partial)
      } catch (journalError) {
        problem += `\nAnd the journal ${input.journal} could not be written (${journalError instanceof Error ? journalError.message : String(journalError)}); its line:\n${partial}`
      }
    }
    return { ok: false, step: error.step, problem, offered }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The real effects

/** The real effects of `PublishDeps`: files, child processes (no shell), the network through ssh, scp and curl. */
export function realDeps(
  say: (line: string) => void,
  files: { exists: (path: string) => boolean; readText: (path: string) => string; writeText: (path: string, text: string) => void },
  gate: typeof ReleaseGate,
  feedKeys: FeedKeys
): PublishDeps {
  return {
    say,
    ...files,
    gate,
    feedKeys,
    now: () => new Date(),
    appendText: (path, text) => {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, text)
    },
    run: (command) => {
      const done = spawnSync(command.program, command.args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: command.timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
      return { status: done.status, stdout: done.stdout ?? '', stderr: `${done.stderr ?? ''}${done.error ? `\n${done.error.message}` : ''}` }
    },
    hashOutput: (command) =>
      new Promise((done) => {
        const hash = createHash('sha256')
        let size = 0
        let stderr = ''
        const child = spawn(command.program, command.args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: command.timeoutMs })
        child.stdout.on('data', (chunk: Buffer) => {
          hash.update(chunk)
          size += chunk.length
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
        })
        child.on('error', (error) => done({ status: null, sha256: '', size: 0, stderr: error.message }))
        child.on('close', (status) => done({ status, sha256: hash.digest('hex'), size, stderr }))
      }),
    sha256File: (path) =>
      new Promise((done, fail) => {
        const hash = createHash('sha256')
        let size = 0
        createReadStream(path)
          .on('data', (chunk) => {
            hash.update(chunk)
            size += chunk.length
          })
          .on('error', fail)
          .on('end', () => done({ sha256: hash.digest('hex'), size }))
      }),
    readFuseWire: (app) => readFuseWire(fuseFileOf(app))
  }
}
