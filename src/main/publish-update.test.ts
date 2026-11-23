import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { getLanguage, setLanguage } from '@shared/i18n'
import { settingsPath } from '@shared/settings-path'
import {
  CONFIG_SHAPE,
  DEFAULT_ENGINE_RUN,
  DEFAULT_MIN_TEST_HOURS,
  FUSE_SENTINEL,
  MIN_REASON,
  PUBLIC_CHANNELS,
  archiveNameProblem,
  attestationNameOf,
  buildLogProblem,
  buildRecordNameOf,
  channelProblems,
  commandLine,
  configPathOf,
  describeFailure,
  readWithdrawn,
  feedWithWithdrawn,
  dmgNameOf,
  imageRecordNameOf,
  imageRecordProblem,
  feedProblems,
  findFuseWire,
  fuseFileOf,
  fuseWireLines,
  fuseWireProblems,
  makeFeedCommand,
  minTestHoursOf,
  parsePublishArgs,
  parseSha256Line,
  publish,
  readChannelFile,
  readFuseWire,
  realDeps,
  remotePlan,
  replacementProblem,
  resolveChannel,
  resolveInput,
  shellWord,
  sumFileProblem,
  sumNameOf,
  makeStagingCommand,
  stagingFolderOf,
  STAGING_TEMPLATE,
  type Channel,
  type ChannelFile,
  type Command,
  type CommandResult,
  type ExpectedRelease,
  type FuseWire,
  type OutputHash,
  type PublishDeps,
  type PublishInput
} from './publish-update'
import { dmgNameOf as makerDmgNameOf, imageRecordNameOf as makerImageRecordNameOf, imageRecordOf, sumNameOf as makerSumNameOf } from './make-dmg'
import * as gate from './release-gate'
import { TEST_FEED_KEYS, signedFeed, writtenFeed } from './update-feed-keys.test-support'
import { posix } from './windows.test-support'

// The publication of an update in one command (scripts/publish-update.mjs). Nothing here touches a network or a server: the commands are planned
// and checked as text, and the order of the steps is run against fake effects that record what would have been run.
const VERSION = '1.0.2'

// The code under test spells its paths with `join` and `resolve`: `\` on Windows, and `resolve` gives the current drive to a path that has none. The
// expectations below are written with `/` and go through the same two functions, so that they hold on every system.
/** A path as `join` writes it. */
const asJoined = (path: string): string => join(path)
/** A path as `resolve` writes it (an absolute one, on the current drive). */
const asResolved = (path: string): string => resolve(path)

/** The way to the icon in Settings, as the English interface writes it: what a message for the maintainer, written in English, must say. */
function iconPathInEnglish(): string {
  const before = getLanguage()
  setLanguage('en')
  try {
    return settingsPath('appIcon')
  } finally {
    setLanguage(before)
  }
}
// Made-up servers: the real ones are in a file outside the repository, which no test reads (the scripts below are always given another one).
const SERVERS: ChannelFile = {
  path: '/cfg/publish-channels.json',
  state: 'read',
  config: { test: { host: 'deploy@updates.example', folder: '/srv/updates/test' }, stable: { host: 'deploy@updates.example', folder: '/srv/updates/stable' } }
}
const channelOf = (name: string): Channel => {
  const choice = resolveChannel(name, SERVERS)
  if (!choice.ok) throw new Error(choice.message)
  return choice.channel
}
const CHANNEL = channelOf('test')
const STABLE = channelOf('stable')
const ZIP = `Lucium-${VERSION}-arm64.zip`
const INPUT: PublishInput = {
  version: VERSION,
  root: '/repo',
  archive: `/repo/dist-drm/${ZIP}`,
  app: '/repo/dist-drm/mac-arm64/Lucium.app',
  installedApp: '/Applications/Lucium.app',
  buildLog: null,
  channelName: 'test',
  channel: CHANNEL,
  sshKey: '/home/me/.ssh/id_ed25519',
  dmg: true,
  dryRun: false,
  journal: '/outside/publish-journal.jsonl',
  buildRecord: `/repo/dist-drm/Lucium-${VERSION}-arm64.build.json`,
  engineRun: '/repo/out-engine/release-run.json',
  noEngineRun: null,
  attestation: `/repo/dist-drm/Lucium-${VERSION}-arm64.attestation.json`,
  minTestHours: 24,
  securityFix: null
}
const FEED_FILE = '/repo/dist-drm/feed.json'
// The private folder `mktemp -d` makes on the server at the start of the sending, as it prints it.
const STAGING = '/tmp/lucium-publish.Ab3dE5gH7j'
const HASH = 'a'.repeat(64)
const OTHER_HASH = 'b'.repeat(64)
const SIZE = 128_172_732
const ARCHIVE_URL = `https://test.lucium.app/updates/darwin-arm64/${ZIP}`
const STABLE_ARCHIVE_URL = `https://lucium.app/updates/darwin-arm64/${ZIP}`
const WANT: ExpectedRelease = { version: VERSION, url: ARCHIVE_URL, sha256: HASH, size: SIZE }
// The disk image scripts/make-dmg.mjs leaves beside the archive, with its sum.
const DMG = `Lucium-${VERSION}-arm64.dmg`
const DMG_FILE = `/repo/dist-drm/${DMG}`
const SUM_FILE = `${DMG_FILE}.sha256`
const DMG_HASH = 'c'.repeat(64)
const DMG_SIZE = 141_000_017
const SUM_TEXT = `${DMG_HASH}  ${DMG}\n`
// The record the maker of the image writes with it: the image, and the executable of the app it holds.
const IMAGE_RECORD_FILE = `${DMG_FILE}.json`
// What `publish` plans to send, with the paths as `join` writes them (the keys of the fake files in `world` keep the `/`).
const PLANNED_FEED = asJoined(FEED_FILE)
const PLANNED_DISK = { dmg: asJoined(DMG_FILE), sum: asJoined(SUM_FILE) }
const DMG_URL = `https://test.lucium.app/updates/darwin-arm64/${DMG}`
const SUM_URL = `${DMG_URL}.sha256`
const feedText = (change: Record<string, unknown> = {}, top: Record<string, unknown> = {}): string =>
  writtenFeed({
    currentRelease: VERSION,
    page: 'https://test.lucium.app/telecharger/',
    releases: [{ version: VERSION, updateTo: { version: VERSION, name: `Lucium ${VERSION}`, notes: 'Notes.', pub_date: '2026-11-07T09:00:00Z', url: ARCHIVE_URL, sha256: HASH, size: SIZE, ...change } }],
    ...top
  })
// The conditions of a publication, as a release leaves them when everything was done: the record of the build, the record of the engine run on
// the same commit, the changelogs with the date, and, for the stable channel, a line of the journal two days old and the attestation.
const COMMIT = '1234567890abcdef1234567890abcdef12345678'
const OTHER_COMMIT = 'fedcba0987654321fedcba0987654321fedcba09'
const NOW = new Date('2026-11-12T12:00:00Z')
const EXE = { sha256: 'e'.repeat(64), size: 91_024 }
const EXE_FILE = `${INPUT.app}/Contents/MacOS/Lucium`
const IMAGE_RECORD = JSON.stringify(imageRecordOf({ version: VERSION, image: { sha256: DMG_HASH, size: DMG_SIZE }, executable: EXE }))
const BUILD_RECORD: gate.BuildRecord = { version: VERSION, commit: COMMIT, clean: true, builtAt: '2026-11-10T08:00:00.000Z', archive: { name: ZIP, sha256: HASH, size: SIZE } }
const ENGINE_RUN: gate.EngineRunRecord = {
  commit: COMMIT,
  clean: true,
  startedAt: '2026-11-10T06:00:00.000Z',
  endedAt: '2026-11-10T07:10:00.000Z',
  steps: { engine: 1, compare: 0, webstore: 0, extwindows: 0 },
  reportSha256: 'd'.repeat(64)
}
const CHANGELOG = `# Changelog\n\n## [${VERSION}] - 2026-11-10\n\n### Fixed\n\n- **A thing**: fixed.\n\n## [1.0.1] - 2026-11-07\n`
const TEST_ENTRY: gate.JournalEntry = {
  at: '2026-11-10T10:00:00.000Z',
  version: VERSION,
  channel: 'test',
  outcome: 'published',
  holds: 'everything',
  commit: COMMIT,
  archive: { name: ZIP, sha256: HASH, size: SIZE },
  dmg: null,
  tag: null,
  engineRun: { endedAt: ENGINE_RUN.endedAt, reportSha256: ENGINE_RUN.reportSha256 }
}
const JOURNAL = gate.journalLine(TEST_ENTRY)
const ATTESTATION = {
  version: VERSION,
  archiveSha256: HASH,
  attestedBy: 'The maintainer',
  attestedAt: '2026-11-11T18:30:00Z',
  checks: { netflixPlays: true, touchIdUnlocksTheVault: true, updateFromPreviousVersion: true },
  updatedFrom: '1.0.1'
}
// castLabs' set: RunAsNode, the two Node switches off, the cookie encryption and the two ASAR fuses on, then the defaults (nine positions).
const WIRE: FuseWire = { version: 1, bytes: [0x30, 0x31, 0x30, 0x30, 0x31, 0x31, 0x30, 0x31, 0x31] }

describe('the channels', () => {
  it('keeps in the repository the name and the https folder of each channel, and nothing of the servers', () => {
    expect(PUBLIC_CHANNELS).toEqual({ test: { baseUrl: 'https://test.lucium.app/updates/darwin-arm64/' }, stable: { baseUrl: 'https://lucium.app/updates/darwin-arm64/' } })
  })

  it('gets the server and the folder from the file and the address from the repository, for test and for stable', () => {
    expect(resolveChannel('test', SERVERS)).toEqual({ ok: true, channel: { host: 'deploy@updates.example', folder: '/srv/updates/test', baseUrl: 'https://test.lucium.app/updates/darwin-arm64/' } })
    expect(resolveChannel('stable', SERVERS)).toEqual({ ok: true, channel: { host: 'deploy@updates.example', folder: '/srv/updates/stable', baseUrl: 'https://lucium.app/updates/darwin-arm64/' } })
    expect(channelProblems(CHANNEL)).toEqual([])
    expect(channelProblems(STABLE)).toEqual([])
  })

  it('looks only at the channel it publishes to: the other one may be wrong or missing', () => {
    const odd: ChannelFile = { path: '/cfg/p.json', state: 'read', config: { test: { host: 'deploy@updates.example', folder: '/srv/updates/test' }, stable: 'later' } }
    expect(resolveChannel('test', odd)).toMatchObject({ ok: true })
    expect(resolveChannel('stable', odd).ok).toBe(false)
  })

  it('refuses a channel that does not exist, whatever the name looks like, even before it looks at the file', () => {
    for (const name of ['prod', '', 'Test', '__proto__', 'constructor', 'toString']) {
      for (const file of [SERVERS, { path: '/cfg/p.json', state: 'missing' } as ChannelFile]) {
        const choice = resolveChannel(name, file)
        expect(choice.ok, name).toBe(false)
        expect(choice.ok ? '' : choice.message, name).toMatch(/Unknown channel/)
      }
    }
  })

  const refusal = (name: string, file: ChannelFile): string => {
    const choice = resolveChannel(name, file)
    expect(choice.ok, `${name}: ${JSON.stringify(file)}`).toBe(false)
    return choice.ok ? '' : choice.message
  }
  const readWith = (config: unknown): ChannelFile => ({ path: '/cfg/p.json', state: 'read', config })

  it('refuses a file that does not exist, and names it, the shape it must have and the ways to give another', () => {
    const message = refusal('stable', { path: '/cfg/p.json', state: 'missing' })
    expect(message).toMatch(/The file of the servers does not exist: \/cfg\/p\.json/)
    expect(message).toContain(CONFIG_SHAPE)
    expect(message).toMatch(/--config <path>, or LUCIUM_PUBLISH_CONFIG/)
  })

  it('refuses a file that cannot be used, and a file that is not one object', () => {
    const message = refusal('test', { path: '/cfg/p.json', state: 'unusable', reason: 'it is not JSON' })
    expect(message).toMatch(/cannot be used: \/cfg\/p\.json, it is not JSON/)
    expect(message).toContain(CONFIG_SHAPE)
    for (const config of [null, [], 'test', 3, [{ test: {} }]]) expect(refusal('test', readWith(config)), JSON.stringify(config)).toMatch(/\/cfg\/p\.json must hold one JSON object/)
  })

  it('refuses a channel that is not in the file, and does not guess its values', () => {
    const message = refusal('stable', readWith({ test: { host: 'deploy@updates.example', folder: '/srv/updates/test' } }))
    expect(message).toMatch(/The channel "stable" is not in \/cfg\/p\.json: its server and folder are not guessed/)
    expect(message).toContain(CONFIG_SHAPE)
    expect(refusal('test', readWith({}))).toMatch(/The channel "test" is not in/)
    // A channel the object only inherits (a prototype key) is not in the file.
    expect(refusal('test', readWith(Object.create({ test: { host: 'deploy@updates.example', folder: '/srv/updates/test' } })))).toMatch(/is not in/)
  })

  it('refuses a channel that is not an object', () => {
    for (const entry of [null, 'deploy@updates.example', [], 3]) expect(refusal('test', readWith({ test: entry })), JSON.stringify(entry)).toMatch(/The channel "test" in \/cfg\/p\.json must be an object with "host" and "folder"/)
  })

  it('refuses values that are missing, are not strings, or could change the command they end up in', () => {
    expect(refusal('test', readWith({ test: { host: 'deploy@updates.example' } }))).toMatch(/misconfigured:\n  "folder" must be a string/)
    expect(refusal('test', readWith({ test: {} }))).toMatch(/"host" must be a string\n  "folder" must be a string/)
    // An array of one string would become that string once written in a template: it must be refused before.
    expect(refusal('test', readWith({ test: { host: 'deploy@updates.example', folder: ['/srv/updates/test'] } }))).toMatch(/"folder" must be a string/)
    expect(refusal('test', readWith({ test: { host: 7, folder: '/srv/updates/test' } }))).toMatch(/"host" must be a string/)
    const bad = refusal('test', readWith({ test: { host: 'deploy@updates.example; rm -rf /', folder: '/srv/x y' } }))
    expect(bad).toMatch(/the host must be user@host/)
    expect(bad).toMatch(/the folder must be an absolute path of plain characters/)
    expect(bad).toContain(CONFIG_SHAPE)
    for (const folder of ['/srv/../etc', '/srv/$(id)', 'srv/updates', '/']) expect(refusal('test', readWith({ test: { host: 'deploy@updates.example', folder } })), folder).toMatch(/the folder must be an absolute path/)
    for (const host of ['updates.example', 'a b@updates.example', '@updates.example', 'deploy@']) expect(refusal('test', readWith({ test: { host, folder: '/srv/updates/test' } })), host).toMatch(/the host must be user@host/)
  })

  it('refuses a key that is not host or folder: the address is the repository’s, a baseUrl in the file would only look as if it were used', () => {
    const message = refusal('test', readWith({ test: { host: 'deploy@updates.example', folder: '/srv/updates/test', baseUrl: 'https://elsewhere.example/' } }))
    expect(message).toMatch(/"baseUrl" is not a key of a channel/)
  })

  it('still validates the address of a channel it is given (a plain https folder that ends with "/")', () => {
    const bad: Channel = { host: 'deploy@host; rm -rf /', folder: '/data/x y', baseUrl: 'http://test.lucium.app/updates' }
    expect(channelProblems(bad)).toHaveLength(3)
    expect(channelProblems({ ...CHANNEL, baseUrl: 'https://test.lucium.app/updates/darwin-arm64' })).toHaveLength(1)
    const choice = resolveChannel('odd', readWith({ odd: { host: 'deploy@updates.example', folder: '/srv/updates/odd' } }), { odd: { baseUrl: 'http://odd.example/updates' } })
    expect(choice.ok ? '' : choice.message).toMatch(/misconfigured:\n  the address must be https and end with "\/"/)
  })
})

describe('the file of the servers', () => {
  it('is, by default, in lucium-secrets under the home folder; --config comes first, then the environment variable', () => {
    const env = { cwd: '/work', home: '/home/me', fromEnv: undefined as string | undefined }
    expect(configPathOf({ config: null }, env)).toBe(asJoined('/home/me/Library/Application Support/lucium-secrets/publish-channels.json'))
    expect(configPathOf({ config: null }, { ...env, fromEnv: '/etc/channels.json' })).toBe(asResolved('/etc/channels.json'))
    expect(configPathOf({ config: '/cli.json' }, { ...env, fromEnv: '/etc/channels.json' })).toBe(asResolved('/cli.json'))
    // Relative paths are those of the folder the command is run from; an empty variable is no variable.
    expect(configPathOf({ config: 'cfg/c.json' }, env)).toBe(asResolved('/work/cfg/c.json'))
    expect(configPathOf({ config: null }, { ...env, fromEnv: 'c.json' })).toBe(asResolved('/work/c.json'))
    expect(configPathOf({ config: null }, { ...env, fromEnv: '' })).toBe(asJoined('/home/me/Library/Application Support/lucium-secrets/publish-channels.json'))
  })

  it('is read through the reader it is given, from that path only', () => {
    const asked: string[] = []
    const file = readChannelFile('/cfg/p.json', (path) => {
      asked.push(path)
      return '{"test":{"host":"deploy@updates.example","folder":"/srv/updates/test"}}'
    })
    expect(file).toEqual({ path: '/cfg/p.json', state: 'read', config: { test: { host: 'deploy@updates.example', folder: '/srv/updates/test' } } })
    expect(asked).toEqual(['/cfg/p.json'])
  })

  it('is missing when the reader says ENOENT, and unusable when it cannot be read or is not JSON', () => {
    const failing = (code: string) => () => {
      throw Object.assign(new Error(`${code}: nope`), { code })
    }
    expect(readChannelFile('/cfg/p.json', failing('ENOENT'))).toEqual({ path: '/cfg/p.json', state: 'missing' })
    expect(readChannelFile('/cfg/p.json', failing('EACCES'))).toEqual({ path: '/cfg/p.json', state: 'unusable', reason: 'it cannot be read (EACCES: nope)' })
    expect(readChannelFile('/cfg/p.json', () => '{ "test": ')).toEqual({ path: '/cfg/p.json', state: 'unusable', reason: 'it is not JSON' })
    expect(readChannelFile('/cfg/p.json', () => '')).toEqual({ path: '/cfg/p.json', state: 'unusable', reason: 'it is not JSON' })
  })
})

describe('the arguments', () => {
  it('default to the test channel, a real run and nothing else', () => {
    expect(parsePublishArgs([])).toEqual({ ok: true, options: { archive: null, channel: 'test', dryRun: false, help: false, app: null, installedApp: null, sshKey: null, buildLog: null, config: null, noDmg: false, journal: null, buildRecord: null, engineRun: null, noEngineRun: null, attestation: null, minTestHours: null, securityFix: null, withdraw: null, to: null } })
  })

  it('read the archive, the flag and the options with a value (separate or after "=")', () => {
    const parsed = parsePublishArgs(['dist-drm/a.zip', '--dry-run', '--channel', 'stable', '--ssh-key=/k', '--app', '/a.app', '--installed-app', '/i.app', '--build-log', '/log', '--config', '/c.json'])
    expect(parsed).toEqual({ ok: true, options: { archive: 'dist-drm/a.zip', channel: 'stable', dryRun: true, help: false, app: '/a.app', installedApp: '/i.app', sshKey: '/k', buildLog: '/log', config: '/c.json', noDmg: false, journal: null, buildRecord: null, engineRun: null, noEngineRun: null, attestation: null, minTestHours: null, securityFix: null, withdraw: null, to: null } })
    expect(parsePublishArgs(['--config=/d.json'])).toMatchObject({ ok: true, options: { config: '/d.json' } })
    expect(parsePublishArgs(['--help'])).toMatchObject({ ok: true, options: { help: true } })
  })

  it('read --no-dmg as a flag, that takes no value and does not swallow the next word', () => {
    expect(parsePublishArgs(['--no-dmg', 'dist-drm/a.zip'])).toMatchObject({ ok: true, options: { noDmg: true, archive: 'dist-drm/a.zip' } })
    expect(parsePublishArgs(['--no-dmg=1'])).toEqual({ ok: false, message: 'Unknown option: --no-dmg=1' })
  })

  it('refuse an unknown option, a missing value (also when the next word is an option) and two archives', () => {
    expect(parsePublishArgs(['--stable'])).toEqual({ ok: false, message: 'Unknown option: --stable' })
    expect(parsePublishArgs(['--channel'])).toEqual({ ok: false, message: '--channel needs a value' })
    expect(parsePublishArgs(['--ssh-key', '--dry-run'])).toEqual({ ok: false, message: '--ssh-key needs a value' })
    expect(parsePublishArgs(['--ssh-key='])).toEqual({ ok: false, message: '--ssh-key needs a value' })
    expect(parsePublishArgs(['--config'])).toEqual({ ok: false, message: '--config needs a value' })
    expect(parsePublishArgs(['--config', '--dry-run'])).toEqual({ ok: false, message: '--config needs a value' })
    const two = parsePublishArgs(['a.zip', 'b.zip'])
    expect(two.ok).toBe(false)
    expect(two.ok ? '' : two.message).toMatch(/Only one archive/)
  })

  it('resolve the defaults: the archive of package.json in dist-drm, the app beside it, the key in the home folder', () => {
    const parsed = parsePublishArgs([])
    if (!parsed.ok) throw new Error('unreachable')
    // The archive and the files beside it are joined to the root, the key and the journal are resolved from the folder of the command.
    expect(resolveInput(parsed.options, { cwd: '/work', root: '/repo', home: '/home/me', version: VERSION, servers: SERVERS })).toEqual({
      ok: true,
      input: {
        ...INPUT,
        archive: asJoined(INPUT.archive),
        app: asJoined(INPUT.app),
        buildRecord: asJoined(INPUT.buildRecord),
        engineRun: asJoined(INPUT.engineRun),
        attestation: asJoined(INPUT.attestation),
        sshKey: asResolved('/home/me/.ssh/id_ed25519'),
        journal: asResolved('/home/me/Library/Application Support/lucium-secrets/publish-journal.jsonl')
      }
    })
  })

  it('publish the disk image unless --no-dmg says not to', () => {
    const env = { cwd: '/work', root: '/repo', home: '/home/me', version: VERSION, servers: SERVERS }
    const options = (args: string[]) => {
      const parsed = parsePublishArgs(args)
      if (!parsed.ok) throw new Error('unreachable')
      return parsed.options
    }
    expect(resolveInput(options([]), env)).toMatchObject({ ok: true, input: { dmg: true } })
    expect(resolveInput(options(['--no-dmg']), env)).toMatchObject({ ok: true, input: { dmg: false } })
  })

  it('take the key of --ssh-key, else of LUCIUM_PUBLISH_SSH_KEY, else the name ssh-keygen gives: never a name of one machine', () => {
    const env = { cwd: '/work', root: '/repo', home: '/home/me', version: VERSION, servers: SERVERS }
    const keyOf = (args: string[], sshKeyFromEnv?: string) => {
      const parsed = parsePublishArgs(args)
      if (!parsed.ok) throw new Error('unreachable')
      const resolved = resolveInput(parsed.options, { ...env, sshKeyFromEnv })
      return resolved.ok ? resolved.input.sshKey : null
    }
    expect(keyOf([])).toBe(asResolved('/home/me/.ssh/id_ed25519'))
    expect(keyOf([], '/keys/site')).toBe(asResolved('/keys/site'))
    expect(keyOf([], ' keys/site\n')).toBe(asResolved('/work/keys/site'))
    expect(keyOf([], '  ')).toBe(asResolved('/home/me/.ssh/id_ed25519'))
    expect(keyOf(['--ssh-key', '/cli/key'], '/keys/site')).toBe(asResolved('/cli/key'))
  })

  it('resolve relative paths against the folder the command is run from, and the channel from the file of the servers', () => {
    const parsed = parsePublishArgs([`out/${ZIP}`, '--ssh-key', 'k/key', '--dry-run'])
    if (!parsed.ok) throw new Error('unreachable')
    const env = { cwd: '/work', root: '/repo', home: '/home/me', version: VERSION, servers: SERVERS }
    const resolved = resolveInput(parsed.options, env)
    expect(resolved.ok && resolved.input).toMatchObject({ archive: asResolved(`/work/out/${ZIP}`), app: asResolved('/work/out/mac-arm64/Lucium.app'), sshKey: asResolved('/work/k/key'), dryRun: true, channelName: 'test', channel: CHANNEL })
    const stable = resolveInput({ ...parsed.options, channel: 'stable' }, env)
    expect(stable.ok && stable.input).toMatchObject({ channelName: 'stable', channel: STABLE })
  })

  it('refuse a channel whose server is not in the file, and say so without reading any other place', () => {
    const parsed = parsePublishArgs([])
    if (!parsed.ok) throw new Error('unreachable')
    const env = { cwd: '/work', root: '/repo', home: '/home/me', version: VERSION }
    const missing = resolveInput(parsed.options, { ...env, servers: { path: '/cfg/p.json', state: 'missing' } })
    expect(missing.ok ? '' : missing.message).toMatch(/does not exist: \/cfg\/p\.json/)
    const noStable = resolveInput({ ...parsed.options, channel: 'stable' }, { ...env, servers: { path: '/cfg/p.json', state: 'read', config: { test: { host: 'deploy@updates.example', folder: '/srv/updates/test' } } } })
    expect(noStable.ok ? '' : noStable.message).toMatch(/The channel "stable" is not in \/cfg\/p\.json/)
  })
})

describe('the commands of the manual publication', () => {
  const plan = remotePlan({ archive: INPUT.archive, feed: FEED_FILE, channel: CHANNEL, sshKey: INPUT.sshKey, staging: STAGING })
  const D = 'D=/srv/updates/test'
  const scriptOf = (command: Command): string => command.args[command.args.length - 1] as string

  it('sends both files to the private folder of the server with scp, the key given by its path', () => {
    expect(plan.upload.program).toBe('scp')
    expect(plan.upload.args).toEqual(['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-i', INPUT.sshKey, INPUT.archive, FEED_FILE, `deploy@updates.example:${STAGING}/`])
  })

  it('checks the copy with sha256sum over ssh', () => {
    expect(plan.remoteHash.program).toBe('ssh')
    expect(plan.remoteHash.args.slice(0, 6)).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-i', INPUT.sshKey])
    expect(plan.remoteHash.args[6]).toBe('deploy@updates.example')
    expect(scriptOf(plan.remoteHash)).toBe(`sha256sum ${STAGING}/${ZIP}`)
  })

  it('makes the folder of the channel first (idempotent), then writes the archive and the feed under a temporary name, renames them, root:root 0644, and removes a half-written one', () => {
    expect(scriptOf(plan.installArchive)).toBe(`${D}; sudo -n install -d -o root -g root -m 755 $D && sudo -n install -o root -g root -m 644 ${STAGING}/${ZIP} $D/.${ZIP}.part && sudo -n mv $D/.${ZIP}.part $D/${ZIP} || { sudo -n rm -f $D/.${ZIP}.part; exit 1; }`)
    expect(scriptOf(plan.installFeed)).toBe(`${D}; sudo -n install -o root -g root -m 644 ${STAGING}/feed.json $D/.feed.json.part && sudo -n mv $D/.feed.json.part $D/feed.json || { sudo -n rm -f $D/.feed.json.part; exit 1; }`)
    expect(scriptOf(plan.cleanup)).toBe(`rm -rf -- ${STAGING}`)
  })

  it('does the same for stable, in its own folder, so that a folder that does not exist yet is made before the archive is written', () => {
    const stable = remotePlan({ archive: INPUT.archive, feed: FEED_FILE, channel: STABLE, sshKey: INPUT.sshKey, staging: STAGING })
    expect(scriptOf(stable.installArchive)).toBe(`D=/srv/updates/stable; sudo -n install -d -o root -g root -m 755 $D && sudo -n install -o root -g root -m 644 ${STAGING}/${ZIP} $D/.${ZIP}.part && sudo -n mv $D/.${ZIP}.part $D/${ZIP} || { sudo -n rm -f $D/.${ZIP}.part; exit 1; }`)
    // The feed comes after the archive, into a folder that exists then: it only writes.
    expect(scriptOf(stable.installFeed)).not.toContain('install -d')
    expect(stable.upload.args.at(-1)).toBe(`deploy@updates.example:${STAGING}/`)
    expect(stable.archiveUrl).toBe(STABLE_ARCHIVE_URL)
    expect(stable.feedUrl).toBe('https://lucium.app/updates/darwin-arm64/feed.json')
    expect(stable.downloadArchive.args).toEqual(['-sS', '--fail', STABLE_ARCHIVE_URL])
  })

  it('reads the archive and the feed back from the addresses the app uses', () => {
    expect(plan.archiveUrl).toBe(ARCHIVE_URL)
    expect(plan.feedUrl).toBe('https://test.lucium.app/updates/darwin-arm64/feed.json')
    expect(plan.downloadArchive.args).toEqual(['-sS', '--fail', ARCHIVE_URL])
    expect(plan.fetchFeed.args).toEqual(['-sS', '--fail', plan.feedUrl])
  })

  it('never puts the key in a script of the server, only its path in -i', () => {
    for (const command of [plan.remoteHash, plan.installArchive, plan.installFeed, plan.cleanup]) expect(scriptOf(command)).not.toContain('id_ed25519')
  })

  it('writes the feed with the script that exists, on the https folder of the channel', () => {
    expect(makeFeedCommand('/repo', INPUT.archive, CHANNEL.baseUrl)).toEqual({ program: 'node', args: [asJoined('/repo/scripts/make-update-feed.mjs'), INPUT.archive, 'https://test.lucium.app/updates/darwin-arm64/'], timeoutMs: 120_000 })
    expect(makeFeedCommand('/repo', INPUT.archive, STABLE.baseUrl).args[2]).toBe('https://lucium.app/updates/darwin-arm64/')
  })

  it('prints a command that can be pasted', () => {
    expect(shellWord('plain-1.2/x')).toBe('plain-1.2/x')
    expect(shellWord('has space')).toBe("'has space'")
    expect(shellWord("it's")).toBe("'it'\\''s'")
    expect(shellWord('')).toBe("''")
    expect(commandLine(plan.remoteHash)).toBe(`ssh -o BatchMode=yes -o ConnectTimeout=20 -i ${INPUT.sshKey} deploy@updates.example 'sha256sum ${STAGING}/${ZIP}'`)
  })
})

describe('the private folder of the server', () => {
  const scriptOf = (command: Command): string => command.args[command.args.length - 1] as string
  const disk = { dmg: DMG_FILE, sum: SUM_FILE }
  const everyCommand = (plan: ReturnType<typeof remotePlan>): Command[] => [
    plan.upload,
    plan.remoteHash,
    plan.installArchive,
    plan.installFeed,
    plan.cleanup,
    ...(plan.disk ? [plan.disk.remoteHash, plan.disk.installDmg, plan.disk.installSum] : [])
  ]

  it('is made by mktemp -d on the server, set to 0700, and its path printed', () => {
    const make = makeStagingCommand(CHANNEL, INPUT.sshKey)
    expect(make.program).toBe('ssh')
    expect(make.args.slice(0, 7)).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-i', INPUT.sshKey, 'deploy@updates.example'])
    expect(scriptOf(make)).toBe('T=$(mktemp -d /tmp/lucium-publish.XXXXXXXXXX) || exit 1; chmod 700 "$T" || { rmdir "$T"; exit 1; }; echo "$T"')
    expect(STAGING_TEMPLATE).toBe('/tmp/lucium-publish.XXXXXXXXXX')
  })

  it('is read back only when it is a folder mktemp makes from the template: /tmp/, the prefix, ten letters or digits', () => {
    expect(stagingFolderOf(`${STAGING}\n`)).toBe(STAGING)
    expect(stagingFolderOf('/tmp/lucium-publish.0123456789')).toBe('/tmp/lucium-publish.0123456789')
    for (const printed of [
      '',
      '\n',
      // The template itself: mktemp replaced nothing.
      STAGING_TEMPLATE,
      // Another folder, or /tmp itself.
      '/tmp/',
      '/tmp',
      '/var/tmp/lucium-publish.Ab3dE5gH7j',
      '/tmp/other.Ab3dE5gH7j',
      'tmp/lucium-publish.Ab3dE5gH7j',
      // Characters a shell reads, a way out of the folder, a second line.
      '/tmp/lucium-publish.Ab3dE5gH7j; rm -rf /',
      '/tmp/lucium-publish.Ab3dE5gH7j/../..',
      '/tmp/lucium-publish.Ab3dE$(id)7j',
      '/tmp/lucium-publish.Ab3 dE5gH7',
      '/tmp/lucium-publish.Ab3dE5gH7j/',
      'Welcome to the server\n/tmp/lucium-publish.Ab3dE5gH7j',
      `${STAGING}\n${STAGING}`,
      // Not ten characters.
      '/tmp/lucium-publish.Ab3dE5gH7',
      '/tmp/lucium-publish.Ab3dE5gH7jk'
    ]) {
      expect(stagingFolderOf(printed), JSON.stringify(printed)).toBeNull()
    }
  })

  it('never goes into a command when it is not such a folder', () => {
    for (const staging of ['/tmp', '/tmp/', '/', '/tmp/lucium-publish.Ab3dE5gH7j; rm -rf /', '/tmp/lucium-publish.Ab3dE5gH7j/..', '/srv/updates/test']) {
      expect(() => remotePlan({ archive: INPUT.archive, feed: FEED_FILE, channel: CHANNEL, sshKey: INPUT.sshKey, disk, staging }), staging).toThrow(/not a private folder of the publication/)
    }
  })

  it('holds every copy: no command reads or writes a file of /tmp itself, the image and its sum included', () => {
    for (const plan of [remotePlan({ archive: INPUT.archive, feed: FEED_FILE, channel: CHANNEL, sshKey: INPUT.sshKey, staging: STAGING }), remotePlan({ archive: INPUT.archive, feed: FEED_FILE, channel: STABLE, sshKey: INPUT.sshKey, disk, staging: STAGING })]) {
      for (const command of everyCommand(plan)) {
        const text = command.args.join(' ')
        // Every /tmp/ of the plan is the private folder, and something is in it or it is removed.
        expect(text.match(/\/tmp\/[^ ;]*/g) ?? [], text).not.toEqual([])
        for (const path of text.match(/\/tmp\/[^ ;]*/g) ?? []) expect(path.startsWith(`${STAGING}`), `${path} in ${text}`).toBe(true)
        expect(text).not.toMatch(/\/tmp\/(Lucium-|feed\.json)/)
      }
    }
  })

  it('is removed whole, by its path alone', () => {
    const plan = remotePlan({ archive: INPUT.archive, feed: FEED_FILE, channel: CHANNEL, sshKey: INPUT.sshKey, disk, staging: STAGING })
    expect(plan.cleanup.program).toBe('ssh')
    expect(scriptOf(plan.cleanup)).toBe(`rm -rf -- ${STAGING}`)
  })
})

describe('the commands of the disk image', () => {
  const disk = { dmg: DMG_FILE, sum: SUM_FILE }
  const plan = remotePlan({ archive: INPUT.archive, feed: FEED_FILE, channel: CHANNEL, sshKey: INPUT.sshKey, disk, staging: STAGING })
  const bare = remotePlan({ archive: INPUT.archive, feed: FEED_FILE, channel: CHANNEL, sshKey: INPUT.sshKey, staging: STAGING })
  const scriptOf = (command: Command): string => command.args[command.args.length - 1] as string
  const D = 'D=/srv/updates/test'

  it('names the image and its sum as the maker of the image does', () => {
    expect(dmgNameOf(VERSION)).toBe(DMG)
    expect(sumNameOf(VERSION)).toBe(`${DMG}.sha256`)
    expect(makerDmgNameOf(VERSION)).toBe(dmgNameOf(VERSION))
    expect(makerSumNameOf(VERSION)).toBe(sumNameOf(VERSION))
  })

  it('has no command for the image when there is none: the plan is the one of the archive and the feed', () => {
    expect(bare.disk).toBeNull()
    expect(bare.upload.args.slice(-3)).toEqual([INPUT.archive, FEED_FILE, `deploy@updates.example:${STAGING}/`])
    expect(scriptOf(bare.cleanup)).toBe(`rm -rf -- ${STAGING}`)
  })

  it('sends the image and its sum with the archive and the feed, in the same scp', () => {
    expect(plan.upload.args).toEqual(['-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-i', INPUT.sshKey, INPUT.archive, FEED_FILE, DMG_FILE, SUM_FILE, `deploy@updates.example:${STAGING}/`])
  })

  it('checks the copy of the image with sha256sum over ssh, apart from the archive’s', () => {
    expect(scriptOf(plan.disk!.remoteHash)).toBe(`sha256sum ${STAGING}/${DMG}`)
    expect(plan.disk!.remoteHash.program).toBe('ssh')
    expect(scriptOf(plan.remoteHash)).toBe(`sha256sum ${STAGING}/${ZIP}`)
  })

  it('writes the image and its sum in the folder of the archive under a temporary name, renames them, root:root 0644, and does not make the folder (the archive made it)', () => {
    expect(scriptOf(plan.disk!.installDmg)).toBe(`${D}; sudo -n install -o root -g root -m 644 ${STAGING}/${DMG} $D/.${DMG}.part && sudo -n mv $D/.${DMG}.part $D/${DMG} || { sudo -n rm -f $D/.${DMG}.part; exit 1; }`)
    expect(scriptOf(plan.disk!.installSum)).toBe(`${D}; sudo -n install -o root -g root -m 644 ${STAGING}/${DMG}.sha256 $D/.${DMG}.sha256.part && sudo -n mv $D/.${DMG}.sha256.part $D/${DMG}.sha256 || { sudo -n rm -f $D/.${DMG}.sha256.part; exit 1; }`)
    for (const command of [plan.disk!.installDmg, plan.disk!.installSum]) expect(scriptOf(command)).not.toContain('install -d')
  })

  it('reads them back from the folder of the channel, and removes their copies with the others (the whole private folder)', () => {
    expect(plan.disk!.dmgUrl).toBe(DMG_URL)
    expect(plan.disk!.sumUrl).toBe(SUM_URL)
    expect(plan.disk!.downloadDmg.args).toEqual(['-sS', '--fail', DMG_URL])
    expect(plan.disk!.fetchSum.args).toEqual(['-sS', '--fail', SUM_URL])
    expect(scriptOf(plan.cleanup)).toBe(`rm -rf -- ${STAGING}`)
    const stable = remotePlan({ archive: INPUT.archive, feed: FEED_FILE, channel: STABLE, sshKey: INPUT.sshKey, disk, staging: STAGING })
    expect(stable.disk!.dmgUrl).toBe(`https://lucium.app/updates/darwin-arm64/${DMG}`)
    expect(scriptOf(stable.disk!.installDmg)).toMatch(/^D=\/srv\/updates\/stable; /)
  })

  it('never puts the key in a script of the server', () => {
    for (const command of [plan.disk!.remoteHash, plan.disk!.installDmg, plan.disk!.installSum]) expect(scriptOf(command)).not.toContain('id_ed25519')
  })
})

describe('the checks', () => {
  it('want the archive the build writes, of the version being published', () => {
    expect(archiveNameProblem(ZIP, VERSION)).toBeNull()
    expect(archiveNameProblem('Lucium-1.0.1-arm64.zip', VERSION)).toMatch(/for 1\.0\.1 and package\.json says 1\.0\.2/)
    for (const name of ['Lucium.zip', 'Lucium-1.0.2-x64.zip', 'Lucium-1.0.2-arm64.zip.sha256', 'Lucium 1.0.2-arm64.zip', 'x; rm -rf ~', 'Lucium-1.0.2-arm64.zip\n']) {
      expect(archiveNameProblem(name, VERSION), name).toMatch(/is not named Lucium-<version>-arm64\.zip/)
    }
  })

  it('read the hash from the line sha256sum prints, and nothing else', () => {
    expect(parseSha256Line(`${HASH}  /tmp/${ZIP}\n`)).toBe(HASH)
    expect(parseSha256Line(HASH)).toBe(HASH)
    for (const text of ['', 'sha256sum: /tmp/x: No such file or directory', `${HASH.slice(1)}  x`, `${'A'.repeat(64)}  x`, `${HASH}x  y`]) expect(parseSha256Line(text), text).toBeNull()
  })

  it('want "Notarized, stapled" in the build log', () => {
    expect(buildLogProblem('…\n✅ Notarized, stapled and checked: dist-drm/x.zip is the file to hand out\n')).toBeNull()
    expect(buildLogProblem('📮 Step 2b: Notarizing …\n❌ rejected')).toMatch(/does not say "Notarized, stapled"/)
  })

  it('accept a feed that names the archive with its hash and size', () => {
    expect(feedProblems(feedText(), WANT)).toEqual([])
  })

  it('name every field of the feed that is not the archive’s', () => {
    expect(feedProblems(feedText({}, { currentRelease: '1.0.1' }), WANT)).toEqual(['currentRelease is "1.0.1", expected "1.0.2"', 'no entry of releases carries currentRelease'])
    expect(feedProblems(feedText({ version: '1.0.1' }), WANT)).toEqual([expect.stringContaining('the release says "1.0.1"')])
    expect(feedProblems(feedText({ url: 'https://test.lucium.app/updates/darwin-arm64/Lucium-1.0.1-arm64.zip' }), WANT)).toEqual([expect.stringContaining('the archive address is')])
    expect(feedProblems(feedText({ sha256: OTHER_HASH }), WANT)).toEqual([expect.stringContaining(`the SHA-256 is "${OTHER_HASH}"`)])
    expect(feedProblems(feedText({ size: SIZE + 1 }), WANT)).toEqual([expect.stringContaining(`the size is ${SIZE + 1}`)])
    expect(feedProblems(feedText({ sha256: OTHER_HASH, size: 1 }), WANT)).toHaveLength(2)
  })

  it('refuse what is not a feed', () => {
    expect(feedProblems('<html>404</html>', WANT)).toEqual(['the feed is not JSON'])
    expect(feedProblems('[]', WANT)).toEqual(['the feed is not an object'])
    expect(feedProblems('{}', WANT)).toEqual(['currentRelease is undefined, expected "1.0.2"', 'no entry of releases carries currentRelease'])
    expect(feedProblems(JSON.stringify({ currentRelease: VERSION, releases: [{ version: VERSION }] }), WANT)).toEqual(['no entry of releases carries currentRelease'])
  })

  it('accept the sum that shasum -a 256 prints for the image (two spaces, or a star for the binary mode), with or without the last newline', () => {
    expect(sumFileProblem(SUM_TEXT, DMG, DMG_HASH)).toBeNull()
    expect(sumFileProblem(SUM_TEXT.trim(), DMG, DMG_HASH)).toBeNull()
    expect(sumFileProblem(`${DMG_HASH} *${DMG}\n`, DMG, DMG_HASH)).toBeNull()
  })

  it('name what is wrong with a sum: not the one line shasum prints, another image, another hash', () => {
    expect(sumFileProblem(DMG_HASH, DMG, DMG_HASH)).toMatch(/not one line/)
    expect(sumFileProblem('', DMG, DMG_HASH)).toMatch(/not one line/)
    expect(sumFileProblem(`${DMG_HASH.slice(1)}  ${DMG}`, DMG, DMG_HASH)).toMatch(/not one line/)
    expect(sumFileProblem(`${'C'.repeat(64)}  ${DMG}`, DMG, DMG_HASH)).toMatch(/not one line/)
    expect(sumFileProblem(SUM_TEXT + SUM_TEXT, DMG, DMG_HASH)).toMatch(/not one line/)
    expect(sumFileProblem(`${DMG_HASH}  Lucium-1.0.1-arm64.dmg`, DMG, DMG_HASH)).toMatch(/names "Lucium-1\.0\.1-arm64\.dmg", the image is Lucium-1\.0\.2-arm64\.dmg/)
    expect(sumFileProblem(`${OTHER_HASH}  ${DMG}`, DMG, DMG_HASH)).toMatch(/says b{64}, the image has SHA-256 c{64}/)
  })
})

describe('the Electron fuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-update-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const withWire = (bytes: number[], before = 100, after = 60, version = 1): Buffer => Buffer.concat([Buffer.alloc(before, 7), Buffer.from(FUSE_SENTINEL), Buffer.from([version, bytes.length, ...bytes]), Buffer.alloc(after, 9)])

  it('are read after the sentinel: the version byte, the length byte, one byte per fuse', () => {
    expect(FUSE_SENTINEL).toBe('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')
    expect(findFuseWire(withWire(WIRE.bytes))).toEqual(WIRE)
    expect(findFuseWire(Buffer.alloc(300, 1))).toBeNull()
    // The wire runs past the end of the buffer.
    expect(findFuseWire(withWire(WIRE.bytes, 10, 0).subarray(0, 32 + 10 + 2 + 3))).toBeNull()
  })

  it('are read from a file by pieces, also when the sentinel or the wire is cut between two pieces', async () => {
    const file = join(dir, 'framework')
    writeFileSync(file, withWire(WIRE.bytes))
    for (const chunk of [1, 2, 31, 32, 33, 40, 99, 100, 101, 120, 131, 132, 133, 140, 141, 142, 143, 1000, 8 * 1024 * 1024]) {
      expect(await readFuseWire(file, chunk), `pieces of ${chunk}`).toEqual(WIRE)
    }
  })

  it('are not found in a file without a sentinel, an empty file, or a wire cut by the end of the file', async () => {
    const plain = join(dir, 'plain')
    writeFileSync(plain, Buffer.alloc(1000, 5))
    const empty = join(dir, 'empty')
    writeFileSync(empty, '')
    const cut = join(dir, 'cut')
    writeFileSync(cut, withWire(WIRE.bytes, 100, 0).subarray(0, 100 + 32 + 2 + 4))
    for (const file of [plain, empty, cut]) expect(await readFuseWire(file, 64), file).toBeNull()
  })

  it('are looked for in the framework of the app', () => {
    expect(posix(fuseFileOf('/Applications/Lucium.app'))).toBe('/Applications/Lucium.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework')
  })

  it('prints a wire one fuse a line, by name, the position without a name and a state it does not know included', () => {
    expect(fuseWireLines({ version: 1, bytes: [0x30, 0x31, 0x30, 0x30, 0x31, 0x31, 0x30, 0x31, 0x72, 0x41] })).toEqual([
      'Fuse version: v1',
      '  RunAsNode is Disabled',
      '  EnableCookieEncryption is Enabled',
      '  EnableNodeOptionsEnvironmentVariable is Disabled',
      '  EnableNodeCliInspectArguments is Disabled',
      '  EnableEmbeddedAsarIntegrityValidation is Enabled',
      '  OnlyLoadAppFromAsar is Enabled',
      '  LoadBrowserProcessSpecificV8Snapshot is Disabled',
      '  GrantFileProtocolExtraPrivileges is Enabled',
      '  fuse 8 is Removed',
      '  fuse 9 is unknown (0x41)'
    ])
  })

  it('are equal, or the difference is named (the cookie encryption above all)', () => {
    expect(fuseWireProblems(WIRE, { ...WIRE, bytes: [...WIRE.bytes] })).toEqual([])
    const flipped = { ...WIRE, bytes: WIRE.bytes.map((byte, at) => (at === 1 ? 0x30 : byte)) }
    expect(fuseWireProblems(flipped, WIRE)).toEqual(['EnableCookieEncryption is off in the new build and on in the installed app'])
    expect(fuseWireProblems({ ...WIRE, version: 2 }, WIRE)).toEqual(["the fuse wire is version 2, the installed app's is 1"])
    expect(fuseWireProblems({ ...WIRE, bytes: WIRE.bytes.slice(0, 7) }, WIRE)).toEqual([
      "the fuse wire has 7 fuses, the installed app's has 9",
      'GrantFileProtocolExtraPrivileges is missing in the new build and on in the installed app',
      'fuse 8 is missing in the new build and on in the installed app'
    ])
    expect(fuseWireProblems({ ...WIRE, bytes: [...WIRE.bytes.slice(0, 8), 0x72] }, WIRE)).toEqual(['fuse 8 is removed in the new build and on in the installed app'])
  })
})

type Kind =
  | 'plutil'
  | 'stapler'
  | 'unzip-exe'
  | 'zipinfo'
  | 'git-tag'
  | 'git-tag-verify'
  | 'stapler-dmg'
  | 'make-feed'
  | 'make-staging'
  | 'scp'
  | 'remote-hash'
  | 'remote-hash-dmg'
  | 'install-archive'
  | 'download-archive'
  | 'install-dmg'
  | 'install-sum'
  | 'download-dmg'
  | 'fetch-sum'
  | 'read-feed'
  | 'keep-feed'
  | 'install-feed'
  | 'fetch-feed'
  | 'cleanup'

function kindOf(command: Command): Kind {
  const script = command.args[command.args.length - 1] ?? ''
  if (command.program === '/usr/bin/plutil') return 'plutil'
  if (command.program === '/usr/bin/unzip') return 'unzip-exe'
  if (command.program === '/usr/bin/zipinfo') return 'zipinfo'
  if (command.program === 'git') return command.args.includes('rev-parse') ? 'git-tag' : 'git-tag-verify'
  if (command.program === 'xcrun') return script.endsWith('.dmg') ? 'stapler-dmg' : 'stapler'
  if (command.program === 'node') return 'make-feed'
  if (command.program === 'scp') return 'scp'
  if (script.includes('mktemp -d')) return 'make-staging'
  if (command.program === 'curl') return script.endsWith('.zip') ? 'download-archive' : script.endsWith('.dmg') ? 'download-dmg' : script.endsWith('.sha256') ? 'fetch-sum' : 'fetch-feed'
  if (script.startsWith('sha256sum')) return script.endsWith('.dmg') ? 'remote-hash-dmg' : 'remote-hash'
  if (script.startsWith('rm -rf -- ')) return 'cleanup'
  if (script.includes('then sudo -n cat $D/feed.json')) return 'read-feed'
  if (script.includes('cp -p $D/feed.json')) return 'keep-feed'
  if (script.includes('feed.json')) return 'install-feed'
  // The sum's script also holds the image's name, so it comes first.
  if (script.includes('.dmg.sha256')) return 'install-sum'
  return script.includes('.dmg') ? 'install-dmg' : 'install-archive'
}

const NETWORK = new Set(['ssh', 'scp', 'curl'])
const done = (stdout = '', status: number | null = 0, stderr = ''): CommandResult => ({ status, stdout, stderr })

/** A world where everything goes well, and what each test changes. Records every command that was run, in order, and every file touched. */
interface World {
  results?: Partial<Record<Kind, CommandResult>>
  download?: Partial<OutputHash>
  missing?: string[]
  wires?: Record<string, FuseWire | null>
  log?: string
  weight?: { sha256: string; size: number }
  unreadable?: boolean
  /** The disk image and its sum are beside the archive (by default they are not). */
  dmg?: boolean
  dmgWeight?: { sha256: string; size: number }
  dmgDownload?: Partial<OutputHash>
  sum?: string
  /** The record of the image, as text; null for none beside the image. By default the one of this image, made of the built app. */
  imageRecord?: string | null
  /** What each reading of the feed in place answers, in order (the last one is repeated): before anything is sent, then before the feed is replaced. */
  feedReads?: CommandResult[]
  unreadableDmg?: boolean
  unreadableSum?: boolean
  /** The files of the conditions, as text; null for a file that is not there. By default they are those of a release where everything was done. */
  buildRecord?: string | null
  engineRun?: string | null
  changelog?: string
  changelogFr?: string
  journal?: string | null
  attestation?: string | null
  /** The executable inside the archive, when it is not the built one. */
  zipped?: Partial<OutputHash>
  /** The journal cannot be written. */
  journalFails?: boolean
  /** The keys of the feed, when they are not the pair of the tests. */
  feedKeys?: PublishDeps['feedKeys']
  now?: Date
}

function world(change: World = {}) {
  const ran: Command[] = []
  const said: string[] = []
  const written: Record<string, string> = {}
  const read: string[] = []
  const asked: string[] = []
  const appended: Array<{ path: string; text: string }> = []
  const conditions: Record<string, string | null> = {
    [INPUT.buildRecord]: change.buildRecord === undefined ? JSON.stringify(BUILD_RECORD) : change.buildRecord,
    [INPUT.engineRun]: change.engineRun === undefined ? JSON.stringify(ENGINE_RUN) : change.engineRun,
    '/repo/CHANGELOG.md': change.changelog ?? CHANGELOG,
    '/repo/CHANGELOG.fr.md': change.changelogFr ?? CHANGELOG,
    [INPUT.journal]: change.journal === undefined ? JOURNAL : change.journal,
    [INPUT.attestation]: change.attestation === undefined ? JSON.stringify(ATTESTATION) : change.attestation,
    [IMAGE_RECORD_FILE]: change.imageRecord === undefined ? IMAGE_RECORD : change.imageRecord
  }
  let feedRead = 0
  const missing = new Set([...(change.dmg ? [] : [DMG_FILE, SUM_FILE, IMAGE_RECORD_FILE]), ...(change.missing ?? []), ...Object.keys(conditions).filter((path) => conditions[path] === null)])
  const defaults: Record<Kind, CommandResult> = {
    plutil: done(`${VERSION}\n`),
    stapler: done('The validate action worked!'),
    'stapler-dmg': done('The validate action worked!'),
    'unzip-exe': done(),
    // The names in the archive, as ditto writes them: the bundle and its contents, nothing at its root but Contents.
    zipinfo: done('Lucium.app/\nLucium.app/Contents/\nLucium.app/Contents/Info.plist\nLucium.app/Contents/MacOS/Lucium\n'),
    // No tag of the version, as for every version that came before the public repository.
    'git-tag': done('', 1),
    'git-tag-verify': done('', 1, 'error: no signature found'),
    'make-feed': done(feedText()),
    'make-staging': done(`${STAGING}\n`),
    scp: done(),
    'remote-hash': done(`${HASH}  ${STAGING}/${ZIP}\n`),
    'remote-hash-dmg': done(`${DMG_HASH}  ${STAGING}/${DMG}\n`),
    'install-archive': done(),
    'download-archive': done(),
    'install-dmg': done(),
    'install-sum': done(),
    'download-dmg': done(),
    'fetch-sum': done(SUM_TEXT),
    // A channel that was never published to: no feed in place, nothing to keep.
    'read-feed': done(''),
    'keep-feed': done(),
    'install-feed': done(),
    // What the web answers once the feed is published: the feed that was written, with its signature.
    'fetch-feed': done(signedFeed(feedText())),
    cleanup: done()
  }
  const deps: PublishDeps = {
    say: (line) => said.push(line),
    // The files are named with `/` in this test; the code names them with `join`, which writes `\` on Windows. Every path is brought back to `/` here.
    exists: (file) => {
      const path = posix(file)
      asked.push(path)
      return !missing.has(path)
    },
    readText: (file) => {
      const path = posix(file)
      read.push(path)
      if (path === SUM_FILE) {
        if (change.unreadableSum) throw new Error('EACCES: permission denied')
        return change.sum ?? SUM_TEXT
      }
      const condition = conditions[path]
      if (typeof condition === 'string') return condition
      if (condition === null) throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' })
      return change.log ?? '✅ Notarized, stapled and checked: x.zip is the file to hand out'
    },
    appendText: (path, text) => {
      if (change.journalFails) throw new Error('EACCES: permission denied')
      appended.push({ path: posix(path), text })
    },
    now: () => change.now ?? NOW,
    gate,
    feedKeys: change.feedKeys ?? TEST_FEED_KEYS,
    writeText: (path, text) => {
      written[posix(path)] = text
    },
    run: (command) => {
      ran.push(command)
      // The folder of a channel (`D=…`) is readable by root only: a read of it that nothing elevates would read nothing on the real server.
      const script = command.args.at(-1) ?? ''
      if (command.program === 'ssh' && script.startsWith('D=') && /(?<!sudo -n )(?:\btest -[a-z]\b|\b(?:ls|cat|sha256sum|stat)\b)|\[ -[a-z] /.test(script)) {
        throw new Error(`a read of the folder of the channel that does not go through sudo -n: ${commandLine(command)}`)
      }
      if (kindOf(command) === 'read-feed' && change.feedReads) return change.feedReads[Math.min(feedRead++, change.feedReads.length - 1)] ?? done('')
      return { ...defaults[kindOf(command)], ...change.results?.[kindOf(command)] }
    },
    hashOutput: async (command) => {
      ran.push(command)
      if (kindOf(command) === 'download-dmg') return { status: 0, sha256: DMG_HASH, size: DMG_SIZE, stderr: '', ...change.dmgDownload }
      if (kindOf(command) === 'unzip-exe') return { status: 0, ...EXE, stderr: '', ...change.zipped }
      return { status: 0, sha256: HASH, size: SIZE, stderr: '', ...change.download }
    },
    sha256File: async (file) => {
      const path = posix(file)
      if (path === EXE_FILE) return EXE
      if (path === DMG_FILE) {
        if (change.unreadableDmg) throw new Error('EACCES: permission denied')
        return change.dmgWeight ?? { sha256: DMG_HASH, size: DMG_SIZE }
      }
      if (change.unreadable) throw new Error('EACCES: permission denied')
      return change.weight ?? { sha256: HASH, size: SIZE }
    },
    readFuseWire: async (app) => (change.wires && app in change.wires ? (change.wires[app] ?? null) : WIRE)
  }
  return { deps, ran, said, written, read, asked, appended, journal: () => appended.map((line) => JSON.parse(line.text) as gate.JournalEntry), kinds: () => ran.map(kindOf) }
}

const LOCAL: Kind[] = ['plutil', 'stapler', 'unzip-exe', 'zipinfo', 'git-tag', 'make-feed']
// The feed in place is read twice: before anything is sent (what the channel offers decides whether this archive may go), then before it is replaced.
const FULL_RUN: Kind[] = [...LOCAL, 'read-feed', 'make-staging', 'scp', 'remote-hash', 'install-archive', 'download-archive', 'read-feed', 'install-feed', 'fetch-feed', 'cleanup']
// With the disk image: its ticket is checked with the build, and it goes after the archive (checked online) and before the feed.
const LOCAL_DMG: Kind[] = ['plutil', 'stapler', 'unzip-exe', 'zipinfo', 'git-tag', 'stapler-dmg', 'make-feed']
const FULL_RUN_DMG: Kind[] = [...LOCAL_DMG, 'read-feed', 'make-staging', 'scp', 'remote-hash', 'remote-hash-dmg', 'install-archive', 'download-archive', 'install-dmg', 'install-sum', 'download-dmg', 'fetch-sum', 'read-feed', 'install-feed', 'fetch-feed', 'cleanup']

describe('the publication', () => {
  it('runs the steps of the manual publication in their order: archive first, checked online, then the feed, checked online', async () => {
    const w = world()
    expect(await publish(INPUT, w.deps)).toEqual({ ok: true, dryRun: false })
    expect(w.kinds()).toEqual(FULL_RUN)
    expect(w.written).toEqual({ [FEED_FILE]: signedFeed(feedText()) })
    expect(w.said.at(-1)).toMatch(/Lucium 1\.0\.2 is published on the channel "test"/)
  })

  it('runs nothing that touches the network or the server in a dry run, writes nothing, and prints the commands', async () => {
    const w = world()
    expect(await publish({ ...INPUT, dryRun: true }, w.deps)).toEqual({ ok: true, dryRun: true })
    expect(w.kinds()).toEqual(LOCAL)
    expect(w.ran.filter((command) => NETWORK.has(command.program))).toEqual([])
    expect(w.written).toEqual({})
    const printed = w.said.join('\n')
    for (const command of [remotePlan({ archive: INPUT.archive, feed: PLANNED_FEED, channel: CHANNEL, sshKey: INPUT.sshKey })].flatMap((plan) => [plan.upload, plan.remoteHash, plan.installArchive, plan.downloadArchive, plan.installFeed, plan.fetchFeed, plan.cleanup])) {
      expect(printed).toContain(`$ ${commandLine(command)}   (dry run: not run)`)
    }
    expect(printed).toMatch(/Dry run done: nothing was sent to the server and nothing was written/)
  })

  it('still makes the local checks in a dry run, and fails on them', async () => {
    const w = world({ results: { plutil: done('1.0.1\n') } })
    const result = await publish({ ...INPUT, dryRun: true }, w.deps)
    expect(result).toMatchObject({ ok: false, step: 'Check the build', published: 'nothing' })
    expect(w.ran.filter((command) => NETWORK.has(command.program))).toEqual([])
  })

  it('never opens the ssh key: it is only looked for', async () => {
    const w = world({ log: 'Notarized, stapled' })
    await publish({ ...INPUT, buildLog: '/repo/build.log' }, w.deps)
    // The journal is the last file read: the versions withdrawn from the channel, which the feed lists.
    expect(w.read).toEqual(['/repo/build.log', INPUT.buildRecord, '/repo/CHANGELOG.md', '/repo/CHANGELOG.fr.md', INPUT.engineRun, INPUT.journal])
  })

  describe('stops before anything is sent when the build is not the one to publish', () => {
    const cases: Array<[string, Parameters<typeof world>[0], Partial<PublishInput>, RegExp]> = [
      ['the archive is missing', { missing: [INPUT.archive] }, {}, /does not exist: build the release first/],
      ['the archive is of another version', {}, { archive: '/repo/dist-drm/Lucium-1.0.1-arm64.zip' }, /for 1\.0\.1 and package\.json says 1\.0\.2/],
      ['the archive has another kind of name', {}, { archive: '/repo/dist-drm/archive.zip' }, /is not named Lucium-<version>-arm64\.zip/],
      ['the built app is missing', { missing: [INPUT.app] }, {}, /Lucium\.app does not exist/],
      ['the built app is of another version', { results: { plutil: done('1.0.1\n') } }, {}, /the built app is 1\.0\.1, package\.json says 1\.0\.2/],
      ['the version of the built app cannot be read', { results: { plutil: done('', 1, 'no such key') } }, {}, /cannot read the version of .*no such key/],
      ['the app has no stapled ticket', { results: { stapler: done('', 65, 'does not have a ticket stapled to it') } }, {}, /no valid notarization ticket.*does not have a ticket stapled/],
      ['the build log does not say the app was notarized', { log: 'Step 2b failed' }, { buildLog: '/repo/build.log' }, /does not say "Notarized, stapled"/],
      ['the build log is missing', { missing: ['/repo/build.log'] }, { buildLog: '/repo/build.log' }, /build\.log does not exist/],
      ['the new app has no fuse wire', { wires: { [INPUT.app]: null } }, {}, /no Electron fuse wire in .*Lucium\.app/],
      ['the installed app is missing', { missing: [INPUT.installedApp] }, {}, /\/Applications\/Lucium\.app does not exist/],
      ['the installed app has no fuse wire', { wires: { [INPUT.installedApp]: null } }, {}, /no Electron fuse wire in [\\/]Applications/],
      ['a fuse differs from the installed app’s', { wires: { [INPUT.app]: { ...WIRE, bytes: WIRE.bytes.map((byte, at) => (at === 1 ? 0x30 : byte)) } } }, {}, /EnableCookieEncryption is off in the new build and on in the installed app/],
      ['the ssh key is missing', { missing: [INPUT.sshKey] }, {}, /ssh key .* does not exist/],
      ['scripts/make-update-feed.mjs refuses', { results: { 'make-feed': done('', 1, '❌ the app in the archive is 1.0.1') } }, {}, /make-update-feed\.mjs refused:\s+❌ the app in the archive is 1\.0\.1/],
      ['the feed written has another hash than the archive', { results: { 'make-feed': done(feedText({ sha256: OTHER_HASH })) } }, {}, /does not describe the archive[\s\S]*the SHA-256 is/],
      ['the feed written is dated after the clock of this machine', { results: { 'make-feed': done(feedText({ pub_date: '2026-11-12T12:05:00Z' })) } }, {}, /the feed to write is dated 2026-11-12T12:05:00Z, after the clock of this machine \(2026-11-12T12:00:00Z\)/],
      ['the archive cannot be read to be weighed', { unreadable: true }, {}, /cannot read .*Lucium-1\.0\.2-arm64\.zip: EACCES: permission denied/],
      // The record of the build is the one of the archive that is weighed: only the feed is wrong.
      ['the feed written has another size than the archive', { weight: { sha256: HASH, size: SIZE + 1 }, buildRecord: JSON.stringify({ ...BUILD_RECORD, archive: { ...BUILD_RECORD.archive, size: SIZE + 1 } }) }, {}, /does not describe the archive[\s\S]*the size is/]
    ]
    it.each(cases)('%s', async (_name, change, input, message) => {
      const w = world(change)
      const result = await publish({ ...INPUT, ...input }, w.deps)
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.problem).toMatch(message)
      expect(result.ok ? '' : result.published).toBe('nothing')
      expect(w.ran.filter((command) => NETWORK.has(command.program)), 'a command of the network was run').toEqual([])
      expect(w.written, 'the feed was written').toEqual({})
    })

    it('the ssh key is not needed to see what a dry run would do', async () => {
      const w = world({ missing: [INPUT.sshKey] })
      expect(await publish({ ...INPUT, dryRun: true }, w.deps)).toEqual({ ok: true, dryRun: true })
    })
  })

  describe('stops at the first failure of the server or the network, and says what the server holds', () => {
    const cases: Array<[string, Parameters<typeof world>[0], Kind[], string, RegExp]> = [
      ['scp fails', { results: { scp: done('', 1, 'Permission denied (publickey).') } }, [...LOCAL, 'read-feed', 'make-staging', 'scp'], 'nothing', /scp failed: Permission denied/],
      ['the server cannot hash the copy', { results: { 'remote-hash': done('', 1, 'No such file') } }, [...LOCAL, 'read-feed', 'make-staging', 'scp', 'remote-hash'], 'nothing', /sha256sum failed on the server/],
      ['the copy on the server is not the archive', { results: { 'remote-hash': done(`${OTHER_HASH}  ${STAGING}/${ZIP}\n`) } }, [...LOCAL, 'read-feed', 'make-staging', 'scp', 'remote-hash'], 'nothing', /the copy on the server has SHA-256 b{64}/],
      ['the server answers something that is not a hash', { results: { 'remote-hash': done('sudo: a password is required\n') } }, [...LOCAL, 'read-feed', 'make-staging', 'scp', 'remote-hash'], 'nothing', /unreadable: sudo: a password is required/],
      ['the archive is not installed', { results: { 'install-archive': done('', 1, 'sudo: a password is required') } }, [...LOCAL, 'read-feed', 'make-staging', 'scp', 'remote-hash', 'install-archive'], 'nothing', /the archive was not installed: sudo: a password is required/],
      ['the archive cannot be downloaded back', { download: { status: 22, sha256: '', size: 0, stderr: 'curl: (22) The requested URL returned error: 404' } }, [...LOCAL, 'read-feed', 'make-staging', 'scp', 'remote-hash', 'install-archive', 'download-archive'], 'archive', /cannot download .*404/],
      ['the archive online has another hash', { download: { sha256: OTHER_HASH } }, [...LOCAL, 'read-feed', 'make-staging', 'scp', 'remote-hash', 'install-archive', 'download-archive'], 'archive', /the archive online is \d+ bytes with SHA-256 b{64}/],
      ['the archive online has another size', { download: { size: SIZE - 1 } }, [...LOCAL, 'read-feed', 'make-staging', 'scp', 'remote-hash', 'install-archive', 'download-archive'], 'archive', /the archive online is 128172731 bytes/],
      ['the feed is not installed', { results: { 'install-feed': done('', 1, 'mv: cannot move') } }, [...LOCAL, 'read-feed', 'make-staging', 'scp', 'remote-hash', 'install-archive', 'download-archive', 'read-feed', 'install-feed'], 'archive', /the feed was not installed: mv: cannot move/],
      ['the feed cannot be read back', { results: { 'fetch-feed': done('', 22, 'curl: (22) 404') } }, [...LOCAL, 'read-feed', 'make-staging', 'scp', 'remote-hash', 'install-archive', 'download-archive', 'read-feed', 'install-feed', 'fetch-feed'], 'archive and feed', /cannot read https:\/\/test\.lucium\.app\/updates\/darwin-arm64\/feed\.json/],
      ['the feed online is the old one', { results: { 'fetch-feed': done(feedText({ version: '1.0.1', sha256: OTHER_HASH }, { currentRelease: '1.0.1' })) } }, FULL_RUN.slice(0, -1), 'archive and feed', /the feed online is not the one that was published[\s\S]*currentRelease is "1\.0\.1"/]
    ]
    it.each(cases)('%s', async (_name, change, ranKinds, published, message) => {
      const w = world(change)
      const result = await publish(INPUT, w.deps)
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.problem).toMatch(message)
      expect(result.ok ? '' : result.published).toBe(published)
      // Every failure here comes after the private folder was made: it is removed all the same, last.
      expect(w.kinds(), 'what was run, up to the failure, then the removal of the private folder').toEqual([...ranKinds, 'cleanup'])
    })

    it('never installs the feed when the archive was not installed or does not answer right', async () => {
      for (const change of [{ results: { 'install-archive': done('', 1, 'x') } }, { download: { sha256: OTHER_HASH } }, { download: { status: 7 } }, { results: { 'remote-hash': done(`${OTHER_HASH}  x`) } }] as Array<Parameters<typeof world>[0]>) {
        const w = world(change)
        await publish(INPUT, w.deps)
        expect(w.kinds()).not.toContain('install-feed')
        expect(w.kinds()).not.toContain('fetch-feed')
      }
    })
  })

  describe('on the stable channel, which is a configured channel like test', () => {
    const stableInput: PublishInput = { ...INPUT, channelName: 'stable', channel: STABLE }
    const stableFeed = feedText({ url: STABLE_ARCHIVE_URL }, { page: 'https://lucium.app/telecharger/' })
    const stableWorld = () => world({ results: { 'make-feed': done(stableFeed), 'fetch-feed': done(signedFeed(stableFeed)) } })

    it('writes the feed for the https folder of stable, and publishes in the same order as for test', async () => {
      const w = stableWorld()
      expect(await publish(stableInput, w.deps)).toEqual({ ok: true, dryRun: false })
      expect(w.kinds()).toEqual(FULL_RUN)
      expect(w.ran.find((command) => command.program === 'node')?.args).toEqual([asJoined('/repo/scripts/make-update-feed.mjs'), INPUT.archive, 'https://lucium.app/updates/darwin-arm64/'])
      expect(w.ran.find((command) => command.program === 'curl' && command.args.at(-1)?.endsWith('.zip'))?.args.at(-1)).toBe(STABLE_ARCHIVE_URL)
      expect(w.written).toEqual({ [FEED_FILE]: signedFeed(stableFeed) })
      expect(w.said.at(-1)).toMatch(/Lucium 1\.0\.2 is published on the channel "stable"/)
    })

    it('makes the folder of stable before it writes the archive there, with the command of the plan', async () => {
      const w = stableWorld()
      await publish(stableInput, w.deps)
      const archive = w.ran.filter((command) => kindOf(command) === 'install-archive')
      expect(archive.map(commandLine)).toEqual([commandLine(remotePlan({ archive: INPUT.archive, feed: PLANNED_FEED, channel: STABLE, sshKey: INPUT.sshKey, staging: STAGING }).installArchive)])
      expect(archive[0]?.args.at(-1)).toMatch(/^D=\/srv\/updates\/stable; sudo -n install -d -o root -g root -m 755 \$D && sudo -n install -o root -g root -m 644 /)
      expect(w.ran.filter((command) => kindOf(command) === 'install-feed').map((command) => command.args.at(-1))).toEqual([expect.not.stringContaining('install -d')])
    })

    it('refuses a feed that was written for the https folder of test, before anything is sent', async () => {
      const w = world()
      const result = await publish(stableInput, w.deps)
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.problem).toMatch(/does not describe the archive[\s\S]*the archive address is .*test\.lucium\.app/)
      expect(result.ok ? '' : result.published).toBe('nothing')
      expect(w.ran.filter((command) => NETWORK.has(command.program))).toEqual([])
      expect(w.written).toEqual({})
    })

    it('prints the commands of stable in a dry run, the making of the folder included, and runs none of the server', async () => {
      const w = stableWorld()
      expect(await publish({ ...stableInput, dryRun: true }, w.deps)).toEqual({ ok: true, dryRun: true })
      expect(w.ran.filter((command) => NETWORK.has(command.program))).toEqual([])
      const plan = remotePlan({ archive: INPUT.archive, feed: PLANNED_FEED, channel: STABLE, sshKey: INPUT.sshKey })
      expect(w.said.join('\n')).toContain(`$ ${commandLine(plan.installArchive)}   (dry run: not run)`)
      expect(w.said.join('\n')).toContain('D=/srv/updates/stable; sudo -n install -d -o root -g root -m 755 $D && ')
    })
  })

  describe('with the disk image that scripts/make-dmg.mjs left beside the archive', () => {
    const diskPlan = remotePlan({ archive: INPUT.archive, feed: PLANNED_FEED, channel: CHANNEL, sshKey: INPUT.sshKey, disk: PLANNED_DISK, staging: STAGING })
    // What a dry run prints: the folder mktemp would make is not known, the template stands for it.
    const diskDryPlan = remotePlan({ archive: INPUT.archive, feed: PLANNED_FEED, channel: CHANNEL, sshKey: INPUT.sshKey, disk: PLANNED_DISK })
    const NOT_SENT = 'nothing'

    it('publishes the image and its sum after the archive has been checked online, and before the feed', async () => {
      const w = world({ dmg: true })
      expect(await publish(INPUT, w.deps)).toEqual({ ok: true, dryRun: false })
      expect(w.kinds()).toEqual(FULL_RUN_DMG)
      const at = (kind: Kind): number => w.kinds().indexOf(kind)
      expect(at('install-archive')).toBeLessThan(at('download-archive'))
      expect(at('download-archive')).toBeLessThan(at('install-dmg'))
      expect(at('install-dmg')).toBeLessThan(at('install-sum'))
      expect(at('install-sum')).toBeLessThan(at('download-dmg'))
      expect(at('download-dmg')).toBeLessThan(at('install-feed'))
      expect(at('fetch-sum')).toBeLessThan(at('install-feed'))
      expect(w.written).toEqual({ [FEED_FILE]: signedFeed(feedText()) })
      expect(w.said.join('\n')).toContain(`The disk image: ${DMG_URL}`)
    })

    it('runs the commands of the plan: the same folder and the same install as the archive, one scp for everything', async () => {
      const w = world({ dmg: true })
      await publish(INPUT, w.deps)
      const lines = w.ran.map(commandLine)
      for (const command of [diskPlan.upload, diskPlan.disk!.remoteHash, diskPlan.disk!.installDmg, diskPlan.disk!.installSum, diskPlan.disk!.downloadDmg, diskPlan.disk!.fetchSum, diskPlan.cleanup]) expect(lines).toContain(commandLine(command))
      expect(w.ran.filter((command) => command.program === 'scp')).toHaveLength(1)
    })

    it('looks at the ticket of the image and weighs it before anything is written or sent, in a dry run too, and sends nothing in a dry run', async () => {
      const w = world({ dmg: true })
      expect(await publish({ ...INPUT, dryRun: true }, w.deps)).toEqual({ ok: true, dryRun: true })
      expect(w.kinds()).toEqual(LOCAL_DMG)
      expect(w.ran.filter((command) => NETWORK.has(command.program))).toEqual([])
      expect(w.written).toEqual({})
      const printed = w.said.join('\n')
      for (const command of [diskDryPlan.upload, diskDryPlan.disk!.remoteHash, diskDryPlan.disk!.installDmg, diskDryPlan.disk!.installSum, diskDryPlan.disk!.downloadDmg, diskDryPlan.disk!.fetchSum, diskDryPlan.cleanup]) {
        expect(printed).toContain(`$ ${commandLine(command)}   (dry run: not run)`)
      }
      // The order of the plan is the order of the steps printed.
      const titles = ['Check the disk image', 'Send the archive, the disk image and the feed', 'Publish the archive', 'Check the archive online', 'Publish the disk image and its sum', 'Check the disk image online', 'Publish the feed']
      const positions = titles.map((title) => printed.indexOf(`\n${title}`))
      expect(positions.every((position) => position >= 0), titles.join(' | ')).toBe(true)
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
    })

    it('does not publish it with --no-dmg, and does not even look for it', async () => {
      const w = world({ dmg: true })
      expect(await publish({ ...INPUT, dmg: false }, w.deps)).toEqual({ ok: true, dryRun: false })
      expect(w.kinds()).toEqual(FULL_RUN)
      expect(w.asked).not.toContain(DMG_FILE)
      expect(w.asked).not.toContain(SUM_FILE)
      expect(w.ran.some((command) => command.args.some((arg) => arg.includes('.dmg')))).toBe(false)
      expect(w.said.join('\n')).toMatch(/--no-dmg: the disk image, if there is one, is not published/)
    })

    it('says it when there is no image beside the archive, and publishes the archive and the feed as before', async () => {
      const w = world()
      expect(await publish(INPUT, w.deps)).toEqual({ ok: true, dryRun: false })
      expect(w.kinds()).toEqual(FULL_RUN)
      expect(w.said.join('\n')).toContain(`no ${DMG} beside the archive: only the archive and the feed are published`)
    })

    describe('stops before anything is sent when the image is not the one to publish', () => {
      const cases: Array<[string, World, RegExp]> = [
        ['the image is there and its sum is not', { dmg: true, missing: [SUM_FILE] }, /Lucium-1\.0\.2-arm64\.dmg\.sha256 is missing: the disk image and its sum go together/],
        ['the sum is there and the image is not', { dmg: true, missing: [DMG_FILE] }, /Lucium-1\.0\.2-arm64\.dmg is missing: the disk image and its sum go together/],
        ['the image has no stapled ticket', { dmg: true, results: { 'stapler-dmg': done('', 65, 'does not have a ticket stapled to it') } }, /the disk image has no valid notarization ticket.*does not have a ticket stapled/],
        ['the sum is the hash of another image', { dmg: true, sum: `${OTHER_HASH}  ${DMG}\n` }, /dmg\.sha256: the sum says b{64}, the image has SHA-256 c{64}/],
        ['the sum names another file', { dmg: true, sum: `${DMG_HASH}  Lucium-1.0.1-arm64.dmg\n` }, /the sum names "Lucium-1\.0\.1-arm64\.dmg"/],
        ['the sum is not a sum', { dmg: true, sum: 'done\n' }, /the sum is not one line/],
        ['the sum cannot be read', { dmg: true, unreadableSum: true }, /cannot read .*dmg\.sha256: EACCES: permission denied/],
        ['the image cannot be read to be weighed', { dmg: true, unreadableDmg: true }, /cannot read .*Lucium-1\.0\.2-arm64\.dmg: EACCES: permission denied/]
      ]
      it.each(cases)('%s', async (_name, change, message) => {
        const w = world(change)
        const result = await publish(INPUT, w.deps)
        expect(result.ok).toBe(false)
        expect(result.ok ? '' : result.step).toBe('Check the disk image')
        expect(result.ok ? '' : result.problem).toMatch(message)
        expect(result.ok ? '' : result.published).toBe(NOT_SENT)
        expect(w.ran.filter((command) => NETWORK.has(command.program)), 'a command of the network was run').toEqual([])
        expect(w.written, 'the feed was written').toEqual({})
      })

      it('also in a dry run', async () => {
        const w = world({ dmg: true, sum: `${OTHER_HASH}  ${DMG}\n` })
        expect(await publish({ ...INPUT, dryRun: true }, w.deps)).toMatchObject({ ok: false, step: 'Check the disk image', published: NOT_SENT })
      })

      it('and not with --no-dmg: an image that is not published is not checked', async () => {
        const w = world({ dmg: true, sum: 'done\n' })
        expect(await publish({ ...INPUT, dmg: false }, w.deps)).toEqual({ ok: true, dryRun: false })
      })
    })

    describe('stops at the first failure of the server or the network, and says what the server holds', () => {
      const BEFORE_ARCHIVE: Kind[] = [...LOCAL_DMG, 'read-feed', 'make-staging', 'scp', 'remote-hash', 'remote-hash-dmg']
      const AFTER_ARCHIVE: Kind[] = [...BEFORE_ARCHIVE, 'install-archive', 'download-archive']
      const cases: Array<[string, World, Kind[], string, RegExp]> = [
        ['the server cannot hash the copy of the image', { dmg: true, results: { 'remote-hash-dmg': done('', 1, 'No such file') } }, BEFORE_ARCHIVE, 'nothing', /sha256sum of the disk image failed on the server/],
        ['the copy of the image on the server is not the image', { dmg: true, results: { 'remote-hash-dmg': done(`${OTHER_HASH}  ${STAGING}/${DMG}\n`) } }, BEFORE_ARCHIVE, 'nothing', /the copy of the disk image on the server has SHA-256 b{64}, the local image c{64}/],
        ['the image is not installed', { dmg: true, results: { 'install-dmg': done('', 1, 'sudo: a password is required') } }, [...AFTER_ARCHIVE, 'install-dmg'], 'archive', /the disk image was not installed: sudo: a password is required/],
        ['the sum is not installed', { dmg: true, results: { 'install-sum': done('', 1, 'mv: cannot move') } }, [...AFTER_ARCHIVE, 'install-dmg', 'install-sum'], 'archive and disk image', /the sum of the disk image was not installed: mv: cannot move/],
        ['the image cannot be downloaded back', { dmg: true, dmgDownload: { status: 22, sha256: '', size: 0, stderr: 'curl: (22) The requested URL returned error: 404' } }, [...AFTER_ARCHIVE, 'install-dmg', 'install-sum', 'download-dmg'], 'archive and disk image', /cannot download .*dmg: curl: \(22\)/],
        ['the image online has another hash', { dmg: true, dmgDownload: { sha256: OTHER_HASH } }, [...AFTER_ARCHIVE, 'install-dmg', 'install-sum', 'download-dmg'], 'archive and disk image', /the disk image online is \d+ bytes with SHA-256 b{64}, the local one 141000017 bytes with c{64}/],
        ['the image online has another size', { dmg: true, dmgDownload: { size: DMG_SIZE - 1 } }, [...AFTER_ARCHIVE, 'install-dmg', 'install-sum', 'download-dmg'], 'archive and disk image', /the disk image online is 141000016 bytes/],
        ['the sum cannot be read back', { dmg: true, results: { 'fetch-sum': done('', 22, 'curl: (22) 404') } }, [...AFTER_ARCHIVE, 'install-dmg', 'install-sum', 'download-dmg', 'fetch-sum'], 'archive and disk image', /cannot read .*dmg\.sha256/],
        ['the sum online is not the local one', { dmg: true, results: { 'fetch-sum': done(`${OTHER_HASH}  ${DMG}\n`) } }, [...AFTER_ARCHIVE, 'install-dmg', 'install-sum', 'download-dmg', 'fetch-sum'], 'archive and disk image', /the sum online is not the local one: b{64}/],
        ['the feed is not installed', { dmg: true, results: { 'install-feed': done('', 1, 'mv: cannot move') } }, [...FULL_RUN_DMG.slice(0, FULL_RUN_DMG.indexOf('install-feed') + 1)], 'archive and disk image', /the feed was not installed/],
        ['the feed online is the old one', { dmg: true, results: { 'fetch-feed': done(feedText({ version: '1.0.1', sha256: OTHER_HASH }, { currentRelease: '1.0.1' })) } }, FULL_RUN_DMG.slice(0, -1), 'archive, disk image and feed', /the feed online is not the one that was published/]
      ]
      it.each(cases)('%s', async (_name, change, ranKinds, published, message) => {
        const w = world(change)
        const result = await publish(INPUT, w.deps)
        expect(result.ok).toBe(false)
        expect(result.ok ? '' : result.problem).toMatch(message)
        expect(result.ok ? '' : result.published).toBe(published)
        expect(w.kinds(), 'what was run, up to the failure, then the removal of the private folder').toEqual([...ranKinds, 'cleanup'])
      })

      it('never installs the image before the archive was installed and answers right', async () => {
        for (const change of [{ results: { 'install-archive': done('', 1, 'x') } }, { download: { sha256: OTHER_HASH } }, { download: { status: 7 } }, { results: { 'remote-hash': done(`${OTHER_HASH}  x`) } }] as World[]) {
          const w = world({ dmg: true, ...change })
          await publish(INPUT, w.deps)
          expect(w.kinds()).not.toContain('install-dmg')
          expect(w.kinds()).not.toContain('install-sum')
        }
      })

      it('never installs the feed when the image or its sum does not answer right', async () => {
        for (const change of [{ results: { 'install-dmg': done('', 1, 'x') } }, { results: { 'install-sum': done('', 1, 'x') } }, { dmgDownload: { sha256: OTHER_HASH } }, { dmgDownload: { status: 7 } }, { results: { 'fetch-sum': done('', 22, 'x') } }, { sum: SUM_TEXT, results: { 'fetch-sum': done('other\n') } }] as World[]) {
          const w = world({ dmg: true, ...change })
          await publish(INPUT, w.deps)
          expect(w.kinds()).not.toContain('install-feed')
          expect(w.kinds()).not.toContain('fetch-feed')
        }
      })
    })

    it('publishes it to the folder of the stable channel with the address of that channel', async () => {
      const stableFeed = feedText({ url: STABLE_ARCHIVE_URL }, { page: 'https://lucium.app/telecharger/' })
      const w = world({ dmg: true, results: { 'make-feed': done(stableFeed), 'fetch-feed': done(signedFeed(stableFeed)) } })
      expect(await publish({ ...INPUT, channelName: 'stable', channel: STABLE }, w.deps)).toEqual({ ok: true, dryRun: false })
      expect(w.ran.find((command) => kindOf(command) === 'download-dmg')?.args.at(-1)).toBe(`https://lucium.app/updates/darwin-arm64/${DMG}`)
      expect(w.ran.find((command) => kindOf(command) === 'install-dmg')?.args.at(-1)).toMatch(/^D=\/srv\/updates\/stable; /)
      expect(w.said.join('\n')).toContain(`The disk image: https://lucium.app/updates/darwin-arm64/${DMG}`)
    })

    it('goes on when the private folder cannot be removed, the image’s copy included', async () => {
      const w = world({ dmg: true, results: { cleanup: done('', 1, 'rm: permission denied') } })
      expect(await publish(INPUT, w.deps)).toEqual({ ok: true, dryRun: false })
      expect(w.ran.filter((command) => kindOf(command) === 'cleanup').map((command) => command.args.at(-1))).toEqual([`rm -rf -- ${STAGING}`])
    })
  })

  it('goes on when the private folder cannot be removed: everything is published and checked, it only says so, with the command to remove it', async () => {
    const w = world({ results: { cleanup: done('', 1, 'rm: permission denied') } })
    expect(await publish(INPUT, w.deps)).toEqual({ ok: true, dryRun: false })
    const said = w.said.join('\n')
    expect(said).toContain(`warning: the private folder ${STAGING} of the server was not removed: rm: permission denied`)
    expect(said).toContain(`Remove it by hand: ssh -o BatchMode=yes -o ConnectTimeout=20 -i ${INPUT.sshKey} deploy@updates.example 'rm -rf -- ${STAGING}'`)
    // Removed once, at its step: the journal comes after it, as before.
    expect(w.kinds().filter((kind) => kind === 'cleanup')).toHaveLength(1)
    expect(said.indexOf('Remove the private folder on the server')).toBeLessThan(said.indexOf('Write the journal'))
  })

  describe('sends everything to a private folder of the server, and removes it whatever happens', () => {
    const PAST_STAGING: Kind[] = [...LOCAL, 'read-feed', 'make-staging']
    const ranAfter = (w: ReturnType<typeof world>, kind: Kind): Command[] => w.ran.slice(w.kinds().indexOf(kind) + 1)

    it('makes the folder before anything is sent, sends it all there, installs from there, then removes it', async () => {
      const w = world({ dmg: true })
      expect(await publish(INPUT, w.deps)).toEqual({ ok: true, dryRun: false })
      expect(w.kinds().indexOf('make-staging')).toBe(w.kinds().indexOf('scp') - 1)
      expect(w.ran.find((command) => command.program === 'scp')?.args.at(-1)).toBe(`deploy@updates.example:${STAGING}/`)
      for (const kind of ['remote-hash', 'remote-hash-dmg', 'install-archive', 'install-dmg', 'install-sum', 'install-feed'] as Kind[]) {
        expect(w.ran.find((command) => kindOf(command) === kind)?.args.at(-1), kind).toContain(`${STAGING}/`)
      }
      // Nothing is read from or written to /tmp itself: every /tmp/ of every command is the folder mktemp made.
      for (const command of ranAfter(w, 'make-staging')) {
        for (const path of command.args.join(' ').match(/\/tmp\/[^ ;]*/g) ?? []) expect(path.startsWith(STAGING), commandLine(command)).toBe(true)
      }
      expect(w.ran.at(-1)?.args.at(-1)).toBe(`rm -rf -- ${STAGING}`)
      expect(w.said.join('\n')).toContain(`ok  ${STAGING}, mode 0700: it is removed at the end, whatever happens`)
      expect(w.said.join('\n')).toContain(`ok  ${STAGING} removed`)
    })

    it('stops before anything is sent when mktemp fails, and has nothing to remove', async () => {
      const w = world({ results: { 'make-staging': done('', 1, 'mktemp: failed to create directory via template') } })
      const result = await publish(INPUT, w.deps)
      expect(result).toMatchObject({ ok: false, step: 'Make a private folder on the server', published: 'nothing' })
      expect(result.ok ? '' : result.problem).toMatch(/mktemp failed on the server, so nothing is sent: mktemp: failed to create directory/)
      expect(w.kinds()).toEqual(PAST_STAGING)
    })

    it('uses no folder that is not one mktemp makes: it sends nothing, removes nothing, and names what the server printed', async () => {
      for (const printed of ['/tmp/\n', '/tmp/lucium-publish.Ab3dE5gH7j; rm -rf ~\n', 'Last login: today\n/tmp/lucium-publish.Ab3dE5gH7j\n', '/var/tmp/lucium-publish.Ab3dE5gH7j\n', '']) {
        const w = world({ results: { 'make-staging': done(printed) } })
        const result = await publish(INPUT, w.deps)
        expect(result, printed).toMatchObject({ ok: false, step: 'Make a private folder on the server', published: 'nothing' })
        expect(result.ok ? '' : result.problem).toMatch(/instead of a folder \/tmp\/lucium-publish\.XXXXXXXXXX: nothing is sent/)
        expect(w.kinds(), printed).toEqual(PAST_STAGING)
      }
    })

    it.each<[string, World, Kind]>([
      ['scp fails', { results: { scp: done('', 1, 'Connection reset') } }, 'scp'],
      ['the copy on the server is not the archive', { results: { 'remote-hash': done(`${OTHER_HASH}  ${STAGING}/${ZIP}\n`) } }, 'remote-hash'],
      ['the archive is not installed', { results: { 'install-archive': done('', 1, 'sudo: a password is required') } }, 'install-archive'],
      ['the feed is not installed', { results: { 'install-feed': done('', 1, 'mv: cannot move') } }, 'install-feed'],
      ['the feed online is the old one', { results: { 'fetch-feed': done('{}') } }, 'fetch-feed']
    ])('removes the folder when the publication stops: %s', async (_name, change, failedAt) => {
      const w = world(change)
      const result = await publish(INPUT, w.deps)
      expect(result.ok).toBe(false)
      // Right after the step that failed, and nothing else.
      expect(ranAfter(w, failedAt).map((command) => command.args.at(-1))).toEqual([`rm -rf -- ${STAGING}`])
      const said = w.said.join('\n')
      expect(said).toContain(`\nRemove the private folder on the server\n  $ ssh -o BatchMode=yes -o ConnectTimeout=20 -i ${INPUT.sshKey} deploy@updates.example 'rm -rf -- ${STAGING}'\n  ok  ${STAGING} removed`)
    })

    it('says so when the folder cannot be removed after a failure, and the failure stays the one that stopped it', async () => {
      const w = world({ results: { 'install-archive': done('', 1, 'sudo: a password is required'), cleanup: done('', 1, 'rm: cannot remove: Permission denied') } })
      const result = await publish(INPUT, w.deps)
      expect(result).toMatchObject({ ok: false, step: 'Publish the archive', published: 'nothing' })
      expect(result.ok ? '' : result.problem).toMatch(/the archive was not installed: sudo: a password is required/)
      expect(w.said.join('\n')).toContain(`warning: the private folder ${STAGING} of the server was not removed: rm: cannot remove: Permission denied`)
    })

    it('removes it too when an error nobody expected stops the publication, and lets the error through', async () => {
      const w = world()
      const run = w.deps.run
      w.deps.run = (command) => {
        if (kindOf(command) === 'install-archive') throw new Error('spawn ssh ENOMEM')
        return run(command)
      }
      await expect(publish(INPUT, w.deps)).rejects.toThrow('spawn ssh ENOMEM')
      expect(w.ran.at(-1)?.args.at(-1)).toBe(`rm -rf -- ${STAGING}`)
    })

    it('says so when the removal itself throws, instead of hiding the result', async () => {
      const w = world({ results: { 'install-feed': done('', 1, 'mv: cannot move') } })
      const run = w.deps.run
      w.deps.run = (command) => {
        if (kindOf(command) === 'cleanup') throw new Error('spawn ssh EAGAIN')
        return run(command)
      }
      expect(await publish(INPUT, w.deps)).toMatchObject({ ok: false, step: 'Publish the feed', published: 'archive' })
      expect(w.said.join('\n')).toContain(`warning: the private folder ${STAGING} of the server was not removed: spawn ssh EAGAIN`)
    })

    it('prints the commands in a dry run, the template standing for the folder, and runs none of them', async () => {
      const w = world()
      expect(await publish({ ...INPUT, dryRun: true }, w.deps)).toEqual({ ok: true, dryRun: true })
      const printed = w.said.join('\n')
      expect(printed).toContain(`\nMake a private folder on the server\n  $ ${commandLine(makeStagingCommand(CHANNEL, INPUT.sshKey))}   (dry run: not run)`)
      expect(printed).toContain(`deploy@updates.example:${STAGING_TEMPLATE}/   (dry run: not run)`)
      expect(printed).toContain(`'rm -rf -- ${STAGING_TEMPLATE}'   (dry run: not run)`)
      expect(printed).not.toContain('Remove it by hand')
    })
  })

  describe('keeps the feed it replaces, under the name of its version: what a withdrawal goes back to', () => {
    const feedOf = (version: string): string =>
      JSON.stringify({ currentRelease: version, releases: [{ version, updateTo: { version, url: ARCHIVE_URL.replace(VERSION, version), sha256: OTHER_HASH, size: 7 } }] })
    const keepOf = (w: ReturnType<typeof world>): string[] => w.ran.filter((command) => kindOf(command) === 'keep-feed').map((command) => command.args.at(-1) ?? '')

    it('copies the feed in place to feed-<its version>.json before it installs the new one', async () => {
      const w = world({ results: { 'read-feed': done(feedOf('1.0.1')) } })
      expect(await publish(INPUT, w.deps)).toEqual({ ok: true, dryRun: false })
      expect(keepOf(w)).toEqual(['D=/srv/updates/test; sudo -n cp -p $D/feed.json $D/feed-1.0.1.json'])
      const kinds = w.kinds()
      expect(kinds.indexOf('read-feed')).toBeLessThan(kinds.indexOf('keep-feed'))
      expect(kinds.indexOf('keep-feed')).toBeLessThan(kinds.indexOf('install-feed'))
      expect(w.said.join('\n')).toMatch(/the feed of 1\.0\.1 is kept as feed-1\.0\.1\.json/)
    })

    it('keeps nothing on a new channel, and nothing when the command is run again for the same version (the feed kept before stays)', async () => {
      const fresh = world()
      await publish(INPUT, fresh.deps)
      expect(keepOf(fresh)).toEqual([])
      expect(fresh.said.join('\n')).toMatch(/the channel has no feed yet/)
      const again = world({ results: { 'read-feed': done(feedText()) } })
      expect(await publish(INPUT, again.deps)).toEqual({ ok: true, dryRun: false })
      expect(keepOf(again)).toEqual([])
      expect(again.kinds()).toContain('install-feed')
    })

    it('keeps a feed that is not a release file under a name of its own, and says so', async () => {
      const w = world({ results: { 'read-feed': done('<html>502</html>') } })
      expect(await publish(INPUT, w.deps)).toEqual({ ok: true, dryRun: false })
      expect(keepOf(w)).toEqual(['D=/srv/updates/test; sudo -n cp -p $D/feed.json $D/feed.json.replaced'])
      expect(w.said.join('\n')).toMatch(/warning: the feed in place is not a release file; it is kept as feed\.json\.replaced/)
    })

    it('never puts in the command a version that is not digits and dots: such a feed is not a release file', async () => {
      const w = world({ results: { 'read-feed': done(feedOf('1.0.0; rm -rf /')) } })
      await publish(INPUT, w.deps)
      expect(keepOf(w)).toEqual(['D=/srv/updates/test; sudo -n cp -p $D/feed.json $D/feed.json.replaced'])
    })

    it('stops before it sends anything when the feed in place cannot be read because sudo is refused: that is not a channel without a feed', async () => {
      const refused = 'sudo: a password is required\ncannot read the folder of the channel: sudo -n is refused on the server (the folder of a channel is readable by root only)'
      const w = world({ results: { 'read-feed': done('', 2, refused) } })
      const result = await publish(INPUT, w.deps)
      expect(result).toMatchObject({ ok: false, step: 'Read what the channel offers now', published: 'nothing' })
      expect(result.ok ? '' : result.problem).toMatch(/cannot read the feed in place on the server, so nothing is sent: sudo: a password is required\ncannot read the folder of the channel/)
      expect(w.kinds()).toEqual([...LOCAL, 'read-feed'])
      expect(w.said.join('\n')).not.toMatch(/the channel has no feed yet/)
    })

    it('does not replace the feed when the one in place cannot be read or cannot be kept', async () => {
      for (const [change, message] of [
        [{ feedReads: [done(''), done('', 255, 'ssh: connection refused')] }, /cannot read the feed in place on the server, so it is not replaced: ssh: connection refused/],
        [{ results: { 'read-feed': done(feedOf('1.0.1')), 'keep-feed': done('', 1, 'cp: No space left on device') } }, /the feed in place was not kept as feed-1\.0\.1\.json, so it is not replaced: cp: No space left/]
      ] as Array<[Parameters<typeof world>[0], RegExp]>) {
        const w = world(change)
        const result = await publish(INPUT, w.deps)
        expect(result).toMatchObject({ ok: false, step: 'Keep the feed that is published now', published: 'archive' })
        expect(result.ok ? '' : result.problem).toMatch(message)
        expect(w.kinds()).not.toContain('install-feed')
      }
    })

    it('reads nothing of the server in a dry run, and says what would be kept', async () => {
      const w = world({ results: { 'read-feed': done(feedOf('1.0.1')) } })
      await publish({ ...INPUT, dryRun: true }, w.deps)
      expect(w.kinds()).toEqual(LOCAL)
      expect(w.said.join('\n')).toMatch(/then the feed it prints is copied to feed-<its version>\.json in the same folder/)
    })
  })

  describe('carries the versions withdrawn from the channel in the feed, for the copies that still run one', () => {
    const inPlace = (version: string, top: Record<string, unknown> = {}): string =>
      signedFeed(unsignedInPlace(version, top))
    /** A feed in place that nobody signed here: one of before the signature, or one that was changed on the server. */
    const unsignedInPlace = (version: string, top: Record<string, unknown> = {}): string =>
      writtenFeed({ currentRelease: version, releases: [{ version, updateTo: { version, url: ARCHIVE_URL.replace(VERSION, version), sha256: OTHER_HASH, size: 7 } }], ...top })
    const withdrawal = (version: string, channel = 'test', at = '2026-11-11T08:00:00.000Z'): string =>
      gate.withdrawalLine({ at, type: 'withdrawal', version, channel, outcome: 'withdrawn', offers: 'nothing', to: null })
    const online = (list: string[]): CommandResult => done(signedFeed(feedWithWithdrawn(feedText(), list)))

    it('keeps the list of the feed in place: the feed that is sent is the one that was written, with that list and nothing else changed', async () => {
      const w = world({ results: { 'read-feed': done(inPlace('1.0.0', { withdrawn: ['1.0.1'] })), 'fetch-feed': online(['1.0.1']) }, journal: null })
      expect(await publish(INPUT, w.deps)).toEqual({ ok: true, dryRun: false })
      expect(w.written[FEED_FILE]).toBe(signedFeed(feedWithWithdrawn(feedText(), ['1.0.1'])))
      expect(feedProblems(w.written[FEED_FILE] as string, WANT)).toEqual([])
      // Written again before anything is sent.
      expect(w.kinds().indexOf('read-feed')).toBeLessThan(w.kinds().indexOf('scp'))
      expect(w.said.join('\n')).toMatch(/written again with the versions withdrawn from this channel \(1\.0\.1\)/)
    })

    it('adds those the journal shows as withdrawn from this channel and not published there again: a channel left without a feed carried no list', async () => {
      const journal = [withdrawal('1.0.1'), withdrawal('1.0.0', 'stable'), withdrawal('0.2.9'), gate.journalLine({ ...TEST_ENTRY, version: '0.2.9', at: '2026-11-11T09:00:00.000Z' })].join('')
      const w = world({ journal, results: { 'fetch-feed': online(['1.0.1']) } })
      expect(await publish(INPUT, w.deps)).toEqual({ ok: true, dryRun: false })
      expect(readWithdrawn(w.written[FEED_FILE] as string)).toEqual({ versions: ['1.0.1'], problem: null })
    })

    it('never lists the version it publishes, and leaves the feed as scripts/make-update-feed.mjs wrote it when nothing is withdrawn', async () => {
      // 1.0.2 was withdrawn (the feed in place and the journal say so), and is published again here.
      const again = world({ journal: withdrawal(VERSION), results: { 'read-feed': done(inPlace('1.0.0', { withdrawn: [VERSION] })) } })
      expect(await publish(INPUT, again.deps)).toEqual({ ok: true, dryRun: false })
      expect(again.written[FEED_FILE]).toBe(signedFeed(feedText()))
      const fresh = world()
      await publish(INPUT, fresh.deps)
      expect(fresh.written[FEED_FILE]).toBe(signedFeed(feedText()))
    })

    it('says so when the list of the feed in place holds something else than versions, and carries the versions', async () => {
      const w = world({ results: { 'read-feed': done(inPlace('1.0.0', { withdrawn: ['1.0.1', 'latest'] })), 'fetch-feed': online(['1.0.1']) } })
      expect(await publish(INPUT, w.deps)).toEqual({ ok: true, dryRun: false })
      expect(readWithdrawn(w.written[FEED_FILE] as string).versions).toEqual(['1.0.1'])
      expect(w.said.join('\n')).toMatch(/warning: in the feed in place, "withdrawn" holds something that is not a version of three numbers \(\["latest"\]\)/)
    })

    it('stops when the feed online does not list them: the copies on a withdrawn version would be told nothing', async () => {
      // The site answers the feed without its list (the default answer of this world).
      const w = world({ results: { 'read-feed': done(inPlace('1.0.0', { withdrawn: ['1.0.1'] })) } })
      const result = await publish(INPUT, w.deps)
      expect(result).toMatchObject({ ok: false, step: 'Check the feed online' })
      expect(result.ok ? '' : result.problem).toMatch(/the feed online is not the one that was published:\s+the withdrawn versions are \[\], expected \["1\.0\.1"\]/)
    })

    it('carries nothing of the list of a feed in place that was not signed here: only the journal is believed then', async () => {
      const journal = withdrawal('1.0.0')
      const w = world({ journal, results: { 'read-feed': done(unsignedInPlace('1.0.1', { withdrawn: ['0.2.9', '1.0.0'] })), 'fetch-feed': online(['1.0.0']) } })
      expect(await publish(INPUT, w.deps)).toEqual({ ok: true, dryRun: false })
      expect(readWithdrawn(w.written[FEED_FILE] as string).versions).toEqual(['1.0.0'])
      expect(w.said.join('\n')).toMatch(/warning: the feed in place carries no signature by a key of the feed .*its list of withdrawn versions is not carried/)
    })

    it('stops before anything is sent when the journal is there and cannot be read', async () => {
      const w = world()
      const readText = w.deps.readText
      w.deps.readText = (path) => {
        if (path === INPUT.journal) throw new Error('EACCES: permission denied')
        return readText(path)
      }
      const result = await publish(INPUT, w.deps)
      expect(result).toMatchObject({ ok: false, step: 'Read what the channel offers now', published: 'nothing' })
      expect(result.ok ? '' : result.problem).toMatch(/cannot read the journal .*EACCES/)
      expect(w.kinds()).not.toContain('scp')
    })
  })

  describe('what the channel offers now, read before anything is sent', () => {
    const offering = (version: string, change: { sha256?: string; size?: number; pub_date?: string } = {}): string =>
      JSON.stringify({ currentRelease: version, releases: [{ version, updateTo: { version, url: ARCHIVE_URL.replace(VERSION, version), sha256: HASH, size: SIZE, ...change } }] })
    const nothingSent = (w: ReturnType<typeof world>): void => {
      expect(w.kinds()).toEqual([...LOCAL, 'read-feed'])
      expect(w.kinds()).not.toContain('install-archive')
    }

    it('refuses the same version with another archive: the file under the feed in place is never replaced', async () => {
      for (const change of [{ sha256: OTHER_HASH }, { size: SIZE + 1 }]) {
        const w = world({ results: { 'read-feed': done(offering(VERSION, change)) } })
        const result = await publish(INPUT, w.deps)
        expect(result).toMatchObject({ ok: false, step: 'Read what the channel offers now', published: 'nothing' })
        expect(result.ok ? '' : result.problem).toMatch(/the channel already offers 1\.0\.2, with another archive .*publishing this one would replace the file under the feed in place.*--withdraw 1\.0\.2/)
        nothingSent(w)
        expect(w.appended).toEqual([])
      }
    })

    it('refuses a version below the one the channel offers: a publication never goes back', async () => {
      const w = world({ results: { 'read-feed': done(offering('1.0.10')) } })
      const result = await publish(INPUT, w.deps)
      expect(result).toMatchObject({ ok: false, step: 'Read what the channel offers now', published: 'nothing' })
      expect(result.ok ? '' : result.problem).toMatch(/the channel offers 1\.0\.10, and 1\.0\.2 is below it: a publication never goes back .*--withdraw 1\.0\.10/)
      nothingSent(w)
    })

    it('sends nothing when the feed in place cannot be read', async () => {
      const w = world({ results: { 'read-feed': done('', 255, 'ssh: connection refused') } })
      const result = await publish(INPUT, w.deps)
      expect(result).toMatchObject({ ok: false, step: 'Read what the channel offers now', published: 'nothing' })
      expect(result.ok ? '' : result.problem).toMatch(/cannot read the feed in place on the server, so nothing is sent: ssh: connection refused/)
      nothingSent(w)
    })

    it('sends nothing when the feed in place is dated after the feed written: no copy that read it would take this one (shared/update-feed-date.ts)', async () => {
      const w = world({ results: { 'read-feed': done(offering('1.0.1', { pub_date: '2026-12-01T00:00:00Z' })) } })
      const result = await publish(INPUT, w.deps)
      expect(result).toMatchObject({ ok: false, step: 'Read what the channel offers now', published: 'nothing' })
      expect(result.ok ? '' : result.problem).toMatch(/the feed to write is dated 2026-11-07T09:00:00Z, before the feed in place \(2026-12-01T00:00:00Z\)/)
      nothingSent(w)
    })

    it('lets through a feed in place dated the same day as the feed written, or earlier', async () => {
      for (const date of ['2026-11-07T09:00:00Z', '2026-11-06T09:00:00Z']) {
        expect(await publish(INPUT, world({ results: { 'read-feed': done(offering('1.0.1', { pub_date: date, sha256: OTHER_HASH })) } }).deps), date).toEqual({ ok: true, dryRun: false })
      }
    })

    it('lets through a lower version in place, the same archive published again, a channel without a feed, and a feed nobody can read', async () => {
      for (const [inPlace, said] of [
        [offering('1.0.1', { sha256: OTHER_HASH }), /the channel offers 1\.0\.1, below 1\.0\.2/],
        [offering(VERSION), /the channel already offers 1\.0\.2, with this same archive/],
        ['', /the channel has no feed yet/],
        ['<html>502</html>', /warning: the feed in place is not a release file: it cannot be compared with this version/]
      ] as Array<[string, RegExp]>) {
        const w = world({ results: { 'read-feed': done(inPlace) } })
        expect(await publish(INPUT, w.deps), inPlace).toEqual({ ok: true, dryRun: false })
        expect(w.said.join('\n')).toMatch(said)
      }
    })

    it('reads nothing of the server in a dry run, and says what will be compared', async () => {
      const w = world({ results: { 'read-feed': done(offering(VERSION, { sha256: OTHER_HASH })) } })
      expect(await publish({ ...INPUT, dryRun: true }, w.deps)).toEqual({ ok: true, dryRun: true })
      expect(w.kinds()).toEqual(LOCAL)
      expect(w.said.join('\n')).toMatch(/the same version with another archive, or a higher version, stops everything here/)
    })

    it('says that the copies are still offered the update when a second run of the same publication stops after the archive', async () => {
      const w = world({ results: { 'read-feed': done(offering(VERSION)) }, download: { status: 22, sha256: '', size: 0, stderr: 'curl: (22) 503' } })
      const result = await publish(INPUT, w.deps)
      expect(result).toMatchObject({ ok: false, published: 'archive', alreadyOffered: true })
      if (!result.ok) {
        expect(describeFailure(result, CHANNEL)).toMatch(/The feed in place already offered this version with this same archive, and was not replaced: the installed copies are still offered the update/)
        expect(describeFailure(result, CHANNEL)).not.toMatch(/no installed copy is offered the update/)
      }
      // A first publication that stops there says what it said: nobody is offered anything.
      const first = await publish(INPUT, world({ download: { status: 22, sha256: '', size: 0, stderr: 'curl: (22) 503' } }).deps)
      expect(first).not.toHaveProperty('alreadyOffered')
      if (!first.ok) expect(describeFailure(first, CHANNEL)).toMatch(/The archive is published and the feed is not: no installed copy is offered the update/)
    })

    it('compares versions number by number, and the archive by its sum and its size', () => {
      const archive = { version: '1.0.2', sha256: HASH, size: SIZE }
      const offered = (version: string, sha256 = HASH, size = SIZE): ExpectedRelease => ({ version, url: ARCHIVE_URL, sha256, size })
      expect(replacementProblem(null, archive)).toBeNull()
      expect(replacementProblem(offered('1.0.2'), archive)).toBeNull()
      expect(replacementProblem(offered('1.0.1', OTHER_HASH), archive)).toBeNull()
      expect(replacementProblem(offered('1.0.2', OTHER_HASH), archive)).toMatch(/already offers 1\.0\.2, with another archive/)
      expect(replacementProblem(offered('1.0.2', HASH, SIZE - 1), archive)).toMatch(/already offers 1\.0\.2, with another archive/)
      // 1.0.10 is above 1.0.2: numbers, not text.
      expect(replacementProblem(offered('1.0.10'), archive)).toMatch(/is below it/)
      expect(replacementProblem(offered('1.1.0'), archive)).toMatch(/is below it/)
    })
  })

  it('refuses a version before the first one the channels serve, before anything is read or sent', async () => {
    const old = '0.2.15'
    const w = world({ results: { plutil: done(`${old}\n`) } })
    const result = await publish({ ...INPUT, version: old, archive: `/repo/dist-drm/Lucium-${old}-arm64.zip` }, w.deps)
    expect(result).toMatchObject({ ok: false, step: 'Check the build', published: 'nothing' })
    expect(result.ok ? '' : result.problem).toMatch(/0\.2\.15 is before 1\.0\.0, the first version these channels serve/)
    expect(w.ran.filter((command) => NETWORK.has(command.program))).toEqual([])
  })

  describe('the disk image must hold the app of the archive', () => {
    const refusedImage = async (imageRecord: string | null) => {
      const w = world({ dmg: true, imageRecord })
      const result = await publish(INPUT, w.deps)
      expect(result).toMatchObject({ ok: false, step: 'Check the disk image', published: 'nothing' })
      expect(w.ran.filter((command) => NETWORK.has(command.program)), 'a command of the network was run').toEqual([])
      return result.ok ? '' : result.problem
    }

    it('refuses an image left from an earlier build of the same version: its record names another executable', async () => {
      const earlier = JSON.stringify(imageRecordOf({ version: VERSION, image: { sha256: DMG_HASH, size: DMG_SIZE }, executable: { sha256: 'f'.repeat(64), size: EXE.size } }))
      expect(await refusedImage(earlier)).toMatch(/the image holds another build of the app than the archive \(its executable has SHA-256 "f{64}", the one of the archive e{64}\): it was left from an earlier build/)
    })

    it('refuses an image without its record, the record of another image, and a record nobody can read', async () => {
      expect(await refusedImage(null)).toMatch(/Lucium-1\.0\.2-arm64\.dmg\.json is missing: scripts\/make-dmg\.mjs writes it with the image.*--no-dmg/)
      const other = JSON.stringify(imageRecordOf({ version: VERSION, image: { sha256: OTHER_HASH, size: DMG_SIZE }, executable: EXE }))
      expect(await refusedImage(other)).toMatch(/it is the record of another image .*the image was made again without its record/)
      expect(await refusedImage('not json')).toMatch(/Lucium-1\.0\.2-arm64\.dmg\.json: it is not JSON/)
      expect(await refusedImage('{"image":{}}')).toMatch(/it names no image or no executable/)
    })

    it('reads the record the maker of the image writes, under the name it writes it', () => {
      expect(imageRecordNameOf(VERSION)).toBe(makerImageRecordNameOf(VERSION))
      expect(imageRecordProblem(IMAGE_RECORD, { name: DMG, sha256: DMG_HASH, size: DMG_SIZE }, EXE)).toBeNull()
      expect(imageRecordProblem(IMAGE_RECORD, { name: DMG, sha256: DMG_HASH, size: DMG_SIZE }, { ...EXE, size: EXE.size + 1 })).toMatch(/another build of the app/)
    })

    it('does not ask for a record when no image is published', async () => {
      expect(await publish({ ...INPUT, dmg: false }, world({ dmg: true, imageRecord: null }).deps)).toEqual({ ok: true, dryRun: false })
      expect(await publish(INPUT, world({ imageRecord: null }).deps)).toEqual({ ok: true, dryRun: false })
    })
  })

  it('says what the server holds when it stops', () => {
    const base = { step: 'Check the archive online', problem: 'the archive online is 1 bytes' }
    expect(describeFailure({ ...base, published: 'nothing' }, CHANNEL)).toMatch(/^FAILED at "Check the archive online": the archive online is 1 bytes\nNothing is published/)
    expect(describeFailure({ ...base, published: 'archive' }, CHANNEL)).toMatch(/The archive is published and the feed is not: no installed copy is offered the update/)
    expect(describeFailure({ ...base, published: 'archive and feed' }, CHANNEL)).toMatch(/The feed is already published, and it does not check out: look at https:\/\/test\.lucium\.app\/updates\/darwin-arm64\/feed\.json/)
    expect(describeFailure({ ...base, published: 'archive and disk image' }, CHANNEL)).toMatch(/The archive and the disk image .* are published and the feed is not: no installed copy is offered the update/)
    expect(describeFailure({ ...base, published: 'archive, disk image and feed' }, CHANNEL)).toMatch(/The feed is already published, and it does not check out: look at https:\/\/test\.lucium\.app\/updates\/darwin-arm64\/feed\.json .*the archive and the disk image are published/)
  })
})

describe('the conditions of a publication', () => {
  const refused = async (change: Parameters<typeof world>[0], input: Partial<PublishInput> = {}) => {
    const w = world(change)
    const result = await publish({ ...INPUT, ...input }, w.deps)
    expect(result.ok, 'the publication went on').toBe(false)
    expect(w.ran.filter((command) => NETWORK.has(command.program)), 'a command of the network was run').toEqual([])
    expect(w.written, 'the feed was written').toEqual({})
    expect(w.appended, 'a line was added to the journal').toEqual([])
    return result.ok ? { step: '', problem: '', published: '' } : result
  }

  describe('stop the publication before anything is sent, on either channel', () => {
    const cases: Array<[string, Parameters<typeof world>[0], string, RegExp]> = [
      ['the app in the archive is not the built one', { zipped: { sha256: OTHER_HASH } }, 'Check that the archive holds the built app', /the app in the archive is not .*Lucium\.app .*the app was built again after the archive was made/],
      ['the app in the archive has another size', { zipped: { size: EXE.size + 1 } }, 'Check that the archive holds the built app', /the app was built again after the archive was made/],
      ['the archive holds no app', { zipped: { status: 11, stderr: 'caution: filename not matched' } }, 'Check that the archive holds the built app', /cannot read Lucium\.app\/Contents\/MacOS\/Lucium in .*filename not matched/],
      // A copy the icon of Settings was put on, archived by hand: ditto keeps its `Icon\r` (measured on a copy of 1.0.0, 12 November 2026).
      ['the archive carries a custom icon', { results: { zipinfo: done('Lucium.app/\nLucium.app/Icon\r\nLucium.app/Contents/\n__MACOSX/Lucium.app/._Icon\r\n') } }, 'Check that the archive carries no custom icon', new RegExp(String.raw`the archive carries a custom icon \(Lucium\.app/Icon\\r\): it was made from a copy that the icon of ${iconPathInEnglish()} was put on`)],
      ['the files of the archive cannot be listed', { results: { zipinfo: done('', 9, 'zipinfo: cannot find or open x.zip') } }, 'Check that the archive carries no custom icon', /cannot list the files of .*\.zip: zipinfo: cannot find or open/],
      ['the build left no record', { buildRecord: null }, 'Check where the build comes from', /build\.json does not exist: scripts\/build-drm-release\.sh --notarize writes it/],
      ['the record is not one', { buildRecord: 'commit 1234' }, 'Check where the build comes from', /is not a build record: it is not a JSON object/],
      ['the record is of another archive', { buildRecord: JSON.stringify({ ...BUILD_RECORD, archive: { ...BUILD_RECORD.archive, sha256: OTHER_HASH } }) }, 'Check where the build comes from', /the archive was made again without its record/],
      ['the record is of another version', { buildRecord: JSON.stringify({ ...BUILD_RECORD, version: '1.0.1' }) }, 'Check where the build comes from', /it is the record of 1\.0\.1, not of 1\.0\.2/],
      ['the working tree was modified when it was built', { buildRecord: JSON.stringify({ ...BUILD_RECORD, clean: false }) }, 'Check where the build comes from', /the archive is the build of no commit/],
      ['the tag of the version names another commit', { results: { 'git-tag': done(`${OTHER_COMMIT}\n`) } }, 'Check where the build comes from', /the tag v1\.0\.2 names the commit fedcba0987654321fedcba0987654321fedcba09, the archive was built from 1234567890abcdef/],
      ['Git cannot say whether the tag exists', { results: { 'git-tag': done('', 128, 'fatal: not a git repository') } }, 'Check where the build comes from', /cannot ask Git for the tag v1\.0\.2: fatal: not a git repository/],
      ['CHANGELOG.md still says Unreleased', { changelog: CHANGELOG.replace('2026-11-10', 'Unreleased') }, 'Check the changelogs', /CHANGELOG\.md: the heading of 1\.0\.2 is "## \[1\.0\.2\] - Unreleased"/],
      ['CHANGELOG.fr.md still says Unreleased', { changelogFr: CHANGELOG.replace('2026-11-10', 'Unreleased') }, 'Check the changelogs', /CHANGELOG\.fr\.md: the heading of 1\.0\.2 is/],
      ['a changelog has no section for the version', { changelogFr: '# Journal\n' }, 'Check the changelogs', /CHANGELOG\.fr\.md has no section "## \[1\.0\.2\]"/],
      ['the engine suites left no record', { engineRun: null }, 'Check the engine suites', /release-run\.json does not exist: pnpm test:engine:release .*--no-engine-run "<reason>"/],
      ['the record of the suites is not one', { engineRun: '[]' }, 'Check the engine suites', /is not the record of an engine run: it is not a JSON object/],
      ['the suites ran on another commit', { engineRun: JSON.stringify({ ...ENGINE_RUN, commit: OTHER_COMMIT }) }, 'Check the engine suites', /the suites ran on fedcba098765, the archive was built from 1234567890ab/],
      ['a suite failed', { engineRun: JSON.stringify({ ...ENGINE_RUN, steps: { ...ENGINE_RUN.steps, webstore: 1 } }) }, 'Check the engine suites', /pnpm test:engine:webstore ended with code 1/],
      ['the run lost a check against the reference', { engineRun: JSON.stringify({ ...ENGINE_RUN, steps: { ...ENGINE_RUN.steps, compare: 1 } }) }, 'Check the engine suites', /pnpm compat:compare ended with code 1/]
    ]
    it.each(cases)('%s', async (_name, change, step, message) => {
      for (const input of [{}, { channelName: 'stable', channel: STABLE }]) {
        const result = await refused(change, input)
        expect(result.step).toBe(step)
        expect(result.problem).toMatch(message)
        expect(result.published).toBe('nothing')
      }
    })

    it('in a dry run too: a dry run that passes is a real run that would pass them', async () => {
      const result = await refused({ buildRecord: null }, { dryRun: true })
      expect(result.step).toBe('Check where the build comes from')
    })

    it('a condition that cannot be read is said with its file and the reason', async () => {
      const w = world()
      const unreadable = { ...w.deps, readText: (path: string) => (path === INPUT.buildRecord ? (() => { throw new Error('EACCES: permission denied') })() : w.deps.readText(path)) }
      const result = await publish(INPUT, unreadable)
      expect(result).toMatchObject({ ok: false, step: 'Check where the build comes from', published: 'nothing' })
      expect(result.ok ? '' : result.problem).toBe(`cannot read the build record ${INPUT.buildRecord}: EACCES: permission denied`)
    })
  })

  it('accept a tag of the version that names the commit of the build, and say whether Git verified its signature', async () => {
    const signed = world({ results: { 'git-tag': done(`${COMMIT}\n`), 'git-tag-verify': done() } })
    expect(await publish(INPUT, signed.deps)).toEqual({ ok: true, dryRun: false })
    expect(signed.journal()[0]?.tag).toEqual({ name: 'v1.0.2', signatureVerified: true })
    expect(signed.ran.filter((command) => command.program === 'git').map((command) => command.args)).toEqual([
      ['-C', '/repo', 'rev-parse', '-q', '--verify', 'refs/tags/v1.0.2^{commit}'],
      ['-C', '/repo', 'tag', '-v', 'v1.0.2']
    ])
    const unsigned = world({ results: { 'git-tag': done(`${COMMIT}\n`) } })
    expect(await publish(INPUT, unsigned.deps)).toEqual({ ok: true, dryRun: false })
    expect(unsigned.journal()[0]?.tag).toEqual({ name: 'v1.0.2', signatureVerified: false })
    expect(unsigned.said.join('\n')).toMatch(/Git could not verify the signature of v1\.0\.2/)
  })

  it('go without the record of the engine suites only with --no-engine-run, whose reason is said and kept in the journal', async () => {
    const reason = 'The chain ran on the runner of the tag: run 4521 of Smoke (macOS)'
    const w = world({ engineRun: null })
    expect(await publish({ ...INPUT, noEngineRun: reason }, w.deps)).toEqual({ ok: true, dryRun: false })
    expect(w.said.join('\n')).toContain(`!!  --no-engine-run: published without the record of the engine suites. Reason, kept in the journal: ${reason}`)
    expect(w.journal()[0]?.engineRun).toEqual({ waived: reason })
    expect(w.read).not.toContain(INPUT.engineRun)
  })
})

describe('the journal of the publications', () => {
  it('gets one line when everything is published: the date, the version, the channel, the commit, the sums, the tag and the engine run', async () => {
    const w = world()
    expect(await publish(INPUT, w.deps)).toEqual({ ok: true, dryRun: false })
    expect(w.appended.map((line) => line.path)).toEqual([INPUT.journal])
    expect(w.appended[0]?.text.endsWith('}\n')).toBe(true)
    expect(w.journal()).toEqual([
      {
        at: '2026-11-12T12:00:00.000Z',
        version: VERSION,
        channel: 'test',
        outcome: 'published',
        holds: 'everything',
        commit: COMMIT,
        archive: { name: ZIP, sha256: HASH, size: SIZE },
        dmg: null,
        tag: null,
        engineRun: { endedAt: ENGINE_RUN.endedAt, reportSha256: ENGINE_RUN.reportSha256 }
      }
    ])
    expect(w.said.join('\n')).toContain(`ok  ${INPUT.journal}: one line added`)
  })

  it('is written after the feed was checked online, never before', async () => {
    const order: string[] = []
    const w = world()
    const deps: PublishDeps = { ...w.deps, run: (command) => (order.push(kindOf(command)), w.deps.run(command)), appendText: (path, text) => (order.push('journal'), w.deps.appendText(path, text)) }
    await publish(INPUT, deps)
    expect(order.indexOf('journal')).toBeGreaterThan(order.indexOf('fetch-feed'))
    expect(order.filter((entry) => entry === 'journal')).toHaveLength(1)
  })

  it('keeps the sum and the size of the disk image when one was published', async () => {
    const w = world({ dmg: true })
    await publish(INPUT, w.deps)
    expect(w.journal()[0]?.dmg).toEqual({ name: DMG, sha256: DMG_HASH, size: DMG_SIZE })
  })

  it('is not written in a dry run, which shows the line it would get', async () => {
    const w = world()
    expect(await publish({ ...INPUT, dryRun: true }, w.deps)).toEqual({ ok: true, dryRun: true })
    expect(w.appended).toEqual([])
    expect(w.said.join('\n')).toMatch(/publish-journal\.jsonl is not written in a dry run\. Its line would be:\n +\{"at":"2026-11-12T12:00:00\.000Z","version":"1\.0\.2","channel":"test"/)
  })

  it('gets a line that says what the server holds when the publication stopped half way, and none when nothing was published', async () => {
    const half = world({ download: { sha256: OTHER_HASH } })
    expect(await publish(INPUT, half.deps)).toMatchObject({ ok: false, published: 'archive' })
    expect(half.journal()).toMatchObject([{ version: VERSION, channel: 'test', outcome: 'partial', holds: 'archive', commit: COMMIT }])
    const nothing = world({ results: { scp: done('', 1, 'Permission denied (publickey).') } })
    expect(await publish(INPUT, nothing.deps)).toMatchObject({ ok: false, published: 'nothing' })
    expect(nothing.appended).toEqual([])
  })

  it('fails the run when its line cannot be written after everything was published, and gives the line to add by hand', async () => {
    const w = world({ journalFails: true })
    const result = await publish(INPUT, w.deps)
    expect(result).toMatchObject({ ok: false, step: 'Write the journal', published: 'everything' })
    const problem = result.ok ? '' : result.problem
    expect(problem).toMatch(/publish-journal\.jsonl could not be written \(EACCES: permission denied\)\. Add this line to it by hand/)
    expect(JSON.parse(problem.split('\n').find((line) => line.startsWith('{')) ?? '')).toMatchObject({ version: VERSION, channel: 'test', outcome: 'published', commit: COMMIT })
    expect(describeFailure({ step: 'Write the journal', problem: 'x', published: 'everything' }, CHANNEL)).toMatch(/Everything is published and checked online.*Only the journal lacks its line/)
  })

  it('says so when the line of a publication that stopped half way cannot be written either', async () => {
    const w = world({ journalFails: true, download: { sha256: OTHER_HASH } })
    const result = await publish(INPUT, w.deps)
    expect(result).toMatchObject({ ok: false, step: 'Check the archive online', published: 'archive' })
    expect(result.ok ? '' : result.problem).toMatch(/the archive online is[\s\S]*And the journal .*publish-journal\.jsonl could not be written \(EACCES: permission denied\); its line:\n\{.*"outcome":"partial"/)
  })

  it('is appended to by the real effects, which make its folder first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'publish-journal-'))
    try {
      const file = join(dir, 'not', 'made', 'yet', 'journal.jsonl')
      const deps = realDeps(() => {}, { exists: () => true, readText: () => '', writeText: () => {} }, gate, TEST_FEED_KEYS)
      deps.appendText(file, 'one\n')
      deps.appendText(file, 'two\n')
      expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n')
      expect(Math.abs(deps.now().getTime() - Date.now())).toBeLessThan(5_000)
      expect(deps.gate).toBe(gate)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// A copy believes a feed only when a key it carries signed it: the publication signs what it writes, and checks that the web answers those bytes.
describe('the signature of the feed that is published', () => {
  const refusing = (problem: string): PublishDeps['feedKeys'] => ({ sign: () => ({ ok: false, problem }), signedPart: () => null })

  it('signs the feed after everything it says is written, and sends that file', async () => {
    const w = world()
    expect(await publish(INPUT, w.deps)).toEqual({ ok: true, dryRun: false })
    const sent = w.written[FEED_FILE] as string
    expect(TEST_FEED_KEYS.signedPart(sent)).toBe(feedText())
    expect(w.said.join('\n')).toMatch(/Sign the feed\n {2}ok {2}signed with 1 key\(s\)/)
  })

  it('stops before anything is sent when the feed cannot be signed, and says why', async () => {
    const w = world({ feedKeys: refusing('/secrets/feed-key.pem does not exist: it is the private key the feed is signed with') })
    const result = await publish(INPUT, w.deps)
    expect(result).toEqual({ ok: false, step: 'Sign the feed', published: 'nothing', problem: expect.stringMatching(/the feed is not signed, so nothing is sent:\s+\/secrets\/feed-key\.pem does not exist/) })
    expect(w.kinds().filter((kind) => ['scp', 'install-archive', 'install-feed'].includes(kind))).toEqual([])
    // The file beside the archive is never left as a signed one that was not.
    expect(TEST_FEED_KEYS.signedPart(w.written[FEED_FILE] ?? '')).toBeNull()
  })

  it('checks the keys in a dry run too, which writes nothing', async () => {
    const refusal = await publish({ ...INPUT, dryRun: true }, world({ feedKeys: refusing('the public key is not in src/main/update-feed-keys.ts') }).deps)
    expect(refusal).toMatchObject({ ok: false, step: 'Sign the feed' })
    const w = world()
    expect(await publish({ ...INPUT, dryRun: true }, w.deps)).toEqual({ ok: true, dryRun: true })
    expect(w.written).toEqual({})
  })

  it.each([
    ['without its signature', feedText()],
    ['with a byte more', `${signedFeed(feedText())}\n`],
    ['signed, of another content', signedFeed(feedText({ notes: 'Other notes.' }))]
  ])('stops when the web answers the feed %s: the installed copies would refuse it, or read something else', async (_name, online) => {
    const w = world({ results: { 'fetch-feed': done(online) } })
    const result = await publish(INPUT, w.deps)
    expect(result).toMatchObject({ ok: false, step: 'Check the feed online' })
    expect(result.ok ? '' : result.problem).toMatch(/it is not, byte for byte, the feed that was signed/)
  })
})

describe('the lock between the test channel and the stable channel', () => {
  const stableInput: PublishInput = { ...INPUT, channelName: 'stable', channel: STABLE }
  const stableFeed = feedText({ url: STABLE_ARCHIVE_URL }, { page: 'https://lucium.app/telecharger/' })
  const stableWorld = (change: Parameters<typeof world>[0] = {}) => world({ results: { 'make-feed': done(stableFeed), 'fetch-feed': done(signedFeed(stableFeed)) }, ...change })
  const refused = async (change: Parameters<typeof world>[0], input: Partial<PublishInput> = {}) => {
    const w = stableWorld(change)
    const result = await publish({ ...stableInput, ...input }, w.deps)
    expect(result).toMatchObject({ ok: false, step: 'Check the passage through the channel "test"', published: 'nothing' })
    expect(w.ran.filter((command) => NETWORK.has(command.program)), 'a command of the network was run').toEqual([])
    expect(w.appended, 'a line was added to the journal').toEqual([])
    return result.ok ? '' : result.problem
  }
  // Three hours and twelve minutes after the version reached the test channel.
  const TOO_SOON = new Date('2026-11-10T13:12:00Z')
  const attestedAt = (at: string): string => JSON.stringify({ ...ATTESTATION, attestedAt: at })
  const REASON = 'A page can read the files of the profile: fixed in this version'

  it('lets in a version that was published on the test channel a day ago or more and that the maintainer attested, and keeps both in the journal', async () => {
    const w = stableWorld()
    expect(await publish(stableInput, w.deps)).toEqual({ ok: true, dryRun: false })
    expect(w.said.join('\n')).toContain('ok  this archive has been on the channel "test" since 2026-11-10T10:00:00.000Z, 24 h or more')
    expect(w.said.join('\n')).toContain('ok  attested by The maintainer on 2026-11-11T18:30:00.000Z: netflixPlays, touchIdUnlocksTheVault, updateFromPreviousVersion')
    expect(w.journal()).toMatchObject([{ channel: 'stable', outcome: 'published', commit: COMMIT }])
    expect(w.journal()[0]?.stable).toEqual({ testPublishedAt: '2026-11-10T10:00:00.000Z', minTestHours: 24, attestedBy: 'The maintainer', attestedAt: '2026-11-11T18:30:00.000Z', securityFix: null })
  })

  it('reads neither the journal nor the attestation for the test channel: a version enters there first', async () => {
    const w = world({ journal: null, attestation: null })
    expect(await publish(INPUT, w.deps)).toEqual({ ok: true, dryRun: false })
    expect(w.read).not.toContain(INPUT.journal)
    expect(w.read).not.toContain(INPUT.attestation)
    expect(w.journal()[0]).not.toHaveProperty('stable')
  })

  it('refuses a version that was never published on the test channel', async () => {
    expect(await refused({ journal: null })).toMatch(/the journal has no publication of 1\.0\.2 on the test channel: a version goes to the test channel first[\s\S]*\(journal: \/outside\/publish-journal\.jsonl\)/)
    expect(await refused({ journal: gate.journalLine({ ...TEST_ENTRY, version: '1.0.1' }) })).toMatch(/the journal has no publication of 1\.0\.2 on the test channel/)
    expect(await refused({ journal: gate.journalLine({ ...TEST_ENTRY, channel: 'stable' }) })).toMatch(/the journal has no publication of 1\.0\.2 on the test channel/)
  })

  it('does not count a publication on the test channel that stopped half way', async () => {
    expect(await refused({ journal: gate.journalLine({ ...TEST_ENTRY, outcome: 'partial', holds: 'archive' }) })).toMatch(/the journal has no publication of 1\.0\.2 on the test channel/)
  })

  it('refuses a version that was withdrawn from the test channel, until this archive is published there again', async () => {
    const withdrawn = gate.withdrawalLine({ at: '2026-11-10T11:00:00.000Z', type: gate.WITHDRAWAL, version: TEST_ENTRY.version, channel: 'test', outcome: 'withdrawn', offers: 'earlier version', to: '1.0.1' })
    expect(await refused({ journal: JOURNAL + withdrawn })).toMatch(/1\.0\.2 was withdrawn from the test channel on 2026-11-10T11:00:00\.000Z[\s\S]*a withdrawn version does not go to stable[\s\S]*\(journal: \/outside\/publish-journal\.jsonl\)/)
    const w = stableWorld({ journal: JOURNAL + withdrawn + gate.journalLine({ ...TEST_ENTRY, at: '2026-11-10T12:00:00.000Z' }) })
    expect(await publish(stableInput, w.deps)).toEqual({ ok: true, dryRun: false })
    expect(w.journal().at(-1)?.stable).toMatchObject({ testPublishedAt: '2026-11-10T12:00:00.000Z' })
  })

  it('refuses an archive that is not the one the test channel got', async () => {
    expect(await refused({ journal: gate.journalLine({ ...TEST_ENTRY, archive: { ...TEST_ENTRY.archive, sha256: OTHER_HASH } }) })).toMatch(/the test channel got another archive of 1\.0\.2 \(SHA-256 b{64}\), not this one \(a{64}\)/)
  })

  it('refuses a version that has not waited a day on the test channel, and says from when it may go', async () => {
    const problem = await refused({ now: TOO_SOON, attestation: attestedAt('2026-11-10T13:00:00Z') })
    expect(problem).toMatch(/1\.0\.2 has been on the test channel for 3 h 12 \(since 2026-11-10T10:00:00\.000Z\), less than the 24 h it must stay there: it may go to stable from 2026-11-11T10:00:00\.000Z/)
    expect(problem).toMatch(/--security-fix "<reason>"/)
    // One minute before the day is over, and at the day.
    expect(await refused({ now: new Date('2026-11-11T09:59:00Z'), attestation: attestedAt('2026-11-10T13:00:00Z') })).toMatch(/for 23 h 59/)
    expect(await publish(stableInput, stableWorld({ now: new Date('2026-11-11T10:00:00Z'), attestation: attestedAt('2026-11-10T13:00:00Z') }).deps)).toEqual({ ok: true, dryRun: false })
  })

  it('counts from the first publication of the archive on the test channel, when it was published there twice', async () => {
    const again = gate.journalLine(TEST_ENTRY) + gate.journalLine({ ...TEST_ENTRY, at: '2026-11-12T11:00:00.000Z' })
    const w = stableWorld({ journal: again })
    expect(await publish(stableInput, w.deps)).toEqual({ ok: true, dryRun: false })
    expect(w.journal()[0]?.stable?.testPublishedAt).toBe('2026-11-10T10:00:00.000Z')
  })

  it('waits as long as --min-test-hours says', async () => {
    // NOW is fifty hours after the version reached the test channel.
    expect(await publish({ ...stableInput, minTestHours: 48 }, stableWorld().deps)).toEqual({ ok: true, dryRun: false })
    expect(await refused({}, { minTestHours: 72 })).toMatch(/for 50 h 00 .*less than the 72 h it must stay there: it may go to stable from 2026-11-13T10:00:00\.000Z/)
  })

  it('goes without the wait with --security-fix, says it loudly and keeps the reason in the journal', async () => {
    const w = stableWorld({ now: TOO_SOON, attestation: attestedAt('2026-11-10T13:00:00Z') })
    expect(await publish({ ...stableInput, securityFix: REASON }, w.deps)).toEqual({ ok: true, dryRun: false })
    expect(w.said.join('\n')).toContain(`!!  --security-fix: 1.0.2 has been on the test channel for 3 h 12 (since 2026-11-10T10:00:00.000Z), less than the 24 h it must stay there. Published all the same. Reason, kept in the journal: ${REASON}`)
    expect(w.journal()[0]?.stable).toEqual({ testPublishedAt: '2026-11-10T10:00:00.000Z', minTestHours: 24, attestedBy: 'The maintainer', attestedAt: '2026-11-10T13:00:00.000Z', securityFix: REASON })
  })

  it('keeps no reason of --security-fix in the journal when the version had waited anyway', async () => {
    const w = stableWorld()
    expect(await publish({ ...stableInput, securityFix: REASON }, w.deps)).toEqual({ ok: true, dryRun: false })
    expect(w.journal()[0]?.stable?.securityFix).toBeNull()
    expect(w.said.join('\n')).not.toContain('--security-fix')
  })

  it('still wants the passage through the test channel and the attestation with --security-fix: it waives the wait and nothing else', async () => {
    expect(await refused({ journal: null }, { securityFix: REASON })).toMatch(/the journal has no publication of 1\.0\.2 on the test channel/)
    expect(await refused({ now: TOO_SOON, attestation: null }, { securityFix: REASON })).toMatch(/attestation\.json does not exist/)
    expect(await refused({ now: TOO_SOON, attestation: JSON.stringify({ ...ATTESTATION, attestedAt: '2026-11-10T13:00:00Z', checks: { ...ATTESTATION.checks, netflixPlays: false } }) }, { securityFix: REASON })).toMatch(/checks\.netflixPlays is not true/)
  })

  it('refuses without the attestation, and shows the file to fill in, with the version and the sum of the archive', async () => {
    const problem = await refused({ attestation: null })
    expect(problem).toMatch(/Lucium-1\.0\.2-arm64\.attestation\.json does not exist: it is the maintainer's attestation/)
    const template = JSON.parse(problem.slice(problem.indexOf('{'))) as Record<string, unknown>
    expect(template).toMatchObject({ version: VERSION, archiveSha256: HASH, checks: { netflixPlays: false, touchIdUnlocksTheVault: false, updateFromPreviousVersion: false } })
  })

  it('refuses an attestation that is not complete, or not of this archive, and names each thing', async () => {
    const withChecks = (checks: Record<string, unknown>) => JSON.stringify({ ...ATTESTATION, checks: { ...ATTESTATION.checks, ...checks } })
    expect(await refused({ attestation: withChecks({ netflixPlays: false }) })).toMatch(/does not let 1\.0\.2 into "stable":\n +checks\.netflixPlays is not true/)
    expect(await refused({ attestation: withChecks({ touchIdUnlocksTheVault: 'yes' }) })).toMatch(/checks\.touchIdUnlocksTheVault is not true/)
    expect(await refused({ attestation: withChecks({ updateFromPreviousVersion: false }) })).toMatch(/checks\.updateFromPreviousVersion is not true/)
    expect(await refused({ attestation: JSON.stringify({ ...ATTESTATION, archiveSha256: OTHER_HASH }) })).toMatch(/what was tried is not what goes to stable/)
    expect(await refused({ attestation: 'Netflix: ok' })).toMatch(/it is not a JSON object/)
  })

  it('refuses a journal with a line it cannot read: the lock rests on it', async () => {
    expect(await refused({ journal: `${JOURNAL}{"at": "yesterday"}\n` })).toMatch(/the journal \/outside\/publish-journal\.jsonl cannot be trusted \(line 2 is not an entry\): repair it before anything goes to "stable"/)
  })
})

describe('the options of the conditions', () => {
  const env = { cwd: '/work', root: '/repo', home: '/home/me', version: VERSION, servers: SERVERS }
  const resolved = (args: string[], more: { journalFromEnv?: string } = {}) => {
    const parsed = parsePublishArgs(args)
    if (!parsed.ok) throw new Error(parsed.message)
    return resolveInput(parsed.options, { ...env, ...more })
  }
  const inputOf = (args: string[], more: { journalFromEnv?: string } = {}): PublishInput => {
    const result = resolved(args, more)
    if (!result.ok) throw new Error(result.message)
    return result.input
  }
  const messageOf = (args: string[]): string => {
    const result = resolved(args)
    expect(result.ok, args.join(' ')).toBe(false)
    return result.ok ? '' : result.message
  }
  const REASON = 'The chain ran on the runner of the tag'

  it('default to the files a release leaves: the two records and the attestation by their names, the journal outside the repository, a day of wait', () => {
    expect(inputOf([])).toMatchObject({
      buildRecord: asJoined(`/repo/dist-drm/Lucium-${VERSION}-arm64.build.json`),
      attestation: asJoined(`/repo/dist-drm/Lucium-${VERSION}-arm64.attestation.json`),
      engineRun: asJoined('/repo/out-engine/release-run.json'),
      journal: asResolved('/home/me/Library/Application Support/lucium-secrets/publish-journal.jsonl'),
      noEngineRun: null,
      securityFix: null,
      minTestHours: 24
    })
    expect(DEFAULT_MIN_TEST_HOURS).toBe(24)
    // The record and the attestation follow the archive, wherever it is.
    expect(inputOf([`out/${ZIP}`])).toMatchObject({ buildRecord: asResolved(`/work/out/Lucium-${VERSION}-arm64.build.json`), attestation: asResolved(`/work/out/Lucium-${VERSION}-arm64.attestation.json`) })
  })

  it('name the files as the conditions and the scripts that write them do', () => {
    expect(buildRecordNameOf(VERSION)).toBe(gate.buildRecordNameOf(VERSION))
    expect(attestationNameOf(VERSION)).toBe(gate.attestationNameOf(VERSION))
    expect(DEFAULT_ENGINE_RUN.join('/')).toBe(gate.ENGINE_RUN_FILE)
    expect(MIN_REASON).toBe(gate.MIN_REASON)
  })

  it('take the journal of --journal, else of LUCIUM_PUBLISH_JOURNAL, else the default one', () => {
    expect(inputOf([], { journalFromEnv: ' /var/j.jsonl\n' }).journal).toBe(asResolved('/var/j.jsonl'))
    expect(inputOf(['--journal', 'j.jsonl'], { journalFromEnv: '/var/j.jsonl' }).journal).toBe(asResolved('/work/j.jsonl'))
    expect(inputOf([], { journalFromEnv: '  ' }).journal).toBe(asResolved('/home/me/Library/Application Support/lucium-secrets/publish-journal.jsonl'))
  })

  it('read the other files and the wait from their options', () => {
    expect(inputOf(['--channel', 'stable', '--build-record', 'b.json', '--engine-run', '/e.json', '--attestation=a.json', '--min-test-hours', '48'])).toMatchObject({
      buildRecord: asResolved('/work/b.json'),
      engineRun: asResolved('/e.json'),
      attestation: asResolved('/work/a.json'),
      minTestHours: 48
    })
    expect(inputOf(['--no-engine-run', `  ${REASON}  `]).noEngineRun).toBe(REASON)
    expect(inputOf(['--channel', 'stable', '--security-fix', `${REASON}\n`]).securityFix).toBe(REASON)
  })

  it('refuse a wait that is none: less than an hour, or not a number', () => {
    for (const value of ['0', '0.5', '-3', 'a day', 'NaN', 'Infinity']) expect(messageOf(['--channel', 'stable', '--min-test-hours', value]), value).toMatch(/--min-test-hours takes a number of hours, 1 or more/)
    expect(minTestHoursOf('1')).toEqual({ hours: 1 })
    expect(minTestHoursOf(' ')).toHaveProperty('problem')
  })

  it('refuse a way out without a reason that says something', () => {
    expect(messageOf(['--no-engine-run', 'later'])).toMatch(/--no-engine-run takes the reason, in at least 20 characters: it is written in the journal/)
    expect(messageOf(['--channel', 'stable', '--security-fix', 'urgent'])).toMatch(/--security-fix takes the reason, in at least 20 characters/)
    expect(messageOf(['--channel', 'stable', '--security-fix', `${' '.repeat(30)}x`])).toMatch(/--security-fix takes the reason/)
    expect(parsePublishArgs(['--security-fix'])).toEqual({ ok: false, message: '--security-fix needs a value' })
    expect(parsePublishArgs(['--no-engine-run', '--dry-run'])).toEqual({ ok: false, message: '--no-engine-run needs a value' })
  })

  it('refuse --security-fix and --min-test-hours on the test channel, where there is no wait, and --engine-run with --no-engine-run', () => {
    expect(messageOf(['--security-fix', REASON])).toMatch(/they mean nothing on the channel "test"/)
    expect(messageOf(['--min-test-hours', '48'])).toMatch(/they mean nothing on the channel "test"/)
    expect(messageOf(['--engine-run', 'e.json', '--no-engine-run', REASON])).toMatch(/not both/)
  })

  it('are handed to the publication by the script, with the conditions themselves', () => {
    const script = readFileSync(fileURLToPath(new URL('../../scripts/publish-update.mjs', import.meta.url)), 'utf8')
    expect(script).toContain("const gate = await import('../src/main/release-gate.ts')")
    expect(script).toMatch(/realDeps\(\(line\) => console\.log\(line\), \{[^}]+\}, gate, feedKeys\)/)
    // The keys of the feed are those of the repository (public) and of the folder outside it (private), never given on the command line.
    expect(script).toMatch(/const feedKeys = feedKeysIn\(process\.env\.LUCIUM_FEED_KEY_DIR\?\.trim\(\) \|\| join\(homedir\(\), \.\.\.FEED_KEY_FOLDER\), UPDATE_FEED_PUBLIC_KEYS\)/)
    expect(script).toContain('journalFromEnv: process.env.LUCIUM_PUBLISH_JOURNAL')
  })
})

describe('the real effects', () => {
  const deps = realDeps(() => {}, { exists: () => true, readText: () => '', writeText: () => {} }, gate, TEST_FEED_KEYS)
  const node = (script: string, timeoutMs = 20_000): Command => ({ program: process.execPath, args: ['-e', script], timeoutMs })

  it('run a command without a shell and give its output, its error and its code', () => {
    expect(deps.run(node("process.stdout.write('out $HOME;'); process.stderr.write('err'); process.exit(3)"))).toEqual({ status: 3, stdout: 'out $HOME;', stderr: 'err' })
  })

  it('say that a command could not be started, with a status that is not 0', () => {
    const result = deps.run({ program: '/nonexistent/program', args: [], timeoutMs: 1000 })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/ENOENT/)
  })

  it('hash the output of a command as it comes, and its size', async () => {
    const result = await deps.hashOutput(node("process.stdout.write(Buffer.alloc(3 * 1024 * 1024, 'ab')); process.stdout.write('end')"))
    const expected = createHash('sha256').update(Buffer.concat([Buffer.alloc(3 * 1024 * 1024, 'ab'), Buffer.from('end')])).digest('hex')
    expect(result).toEqual({ status: 0, sha256: expected, size: 3 * 1024 * 1024 + 3, stderr: '' })
  })

  it('report the failure of the command that is hashed', async () => {
    expect(await deps.hashOutput(node("process.stderr.write('curl: (22) 404'); process.exit(22)"))).toMatchObject({ status: 22, stderr: 'curl: (22) 404' })
    expect(await deps.hashOutput({ program: '/nonexistent/program', args: [], timeoutMs: 1000 })).toMatchObject({ status: null, size: 0 })
  })

  it('hash a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'publish-update-'))
    try {
      writeFileSync(join(dir, 'a'), 'abc')
      expect(await deps.sha256File(join(dir, 'a'))).toEqual({ sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', size: 3 })
      await expect(deps.sha256File(join(dir, 'missing'))).rejects.toThrow(/ENOENT/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('scripts/publish-update.mjs', () => {
  const script = fileURLToPath(new URL('../../scripts/publish-update.mjs', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'publish-update-script-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const good = join(dir, 'good.json')
  const onlyTest = join(dir, 'only-test.json')
  const absent = join(dir, 'absent.json')
  writeFileSync(good, JSON.stringify((SERVERS as { config: unknown }).config))
  writeFileSync(onlyTest, JSON.stringify({ test: { host: 'deploy@updates.example', folder: '/srv/updates/test' } }))
  // The file of the maintainer's own folder is never read here: the variable always names a file of the test, and `--config` goes before it.
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, LUCIUM_PUBLISH_CONFIG: absent, LUCIUM_PUBLISH_JOURNAL: join(dir, 'journal.jsonl') } })
  const version = (JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string }).version
  const nowhere = join(tmpdir(), 'nowhere', `Lucium-${version}-arm64.zip`)

  it('refuses a channel that is not in the file, naming the file and its shape, before it looks at anything', () => {
    const result = run('--channel', 'stable', '--dry-run', '--config', onlyTest)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(`The channel "stable" is not in ${onlyTest}`)
    expect(result.stderr).toContain(CONFIG_SHAPE)
    expect(result.stdout).toBe('')
  })

  it('refuses a file that does not exist, the one the variable names when there is no --config', () => {
    const result = run('--dry-run')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(`The file of the servers does not exist: ${absent}`)
    expect(result.stdout).toBe('')
  })

  it('refuses a file that is not JSON', () => {
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ "test": ')
    const result = run('--dry-run', '--config', broken)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(`cannot be used: ${broken}, it is not JSON`)
  })

  it('refuses an unknown option, and shows its usage with --help, without looking for the file', () => {
    expect(run('--publish-now').status).toBe(2)
    const help = run('--help')
    expect(help.status).toBe(0)
    expect(help.stderr).toMatch(/--dry-run +prints every command and runs none that touches the network/)
    expect(help.stderr).toMatch(/--config <path> +the JSON file that holds the server and the folder of each channel/)
    expect(help.stderr).toMatch(/--no-dmg +does not publish the disk image/)
    expect(help.stderr).toMatch(/--security-fix "<reason>" +for a security fix that cannot wait: the channel "stable" without the wait/)
    expect(help.stderr).toMatch(/--no-engine-run "<reason>" +publishes without the record of the engine run/)
    expect(help.stderr).toMatch(/--journal <path> +the journal of the publications/)
  })

  it('stops in a dry run on an archive that does not exist, without printing a command of the network', () => {
    const result = run('--dry-run', '--config', good, nowhere)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/FAILED at "Check the build": .* does not exist/)
    expect(result.stdout).toContain('on the channel "test" (https://test.lucium.app/updates/darwin-arm64/)')
    expect(result.stdout).not.toMatch(/\$ (ssh|scp|curl) /)
  })

  it('takes --no-dmg as an option of its own: it stops on the missing archive (1), not on the arguments (2)', () => {
    const result = run('--dry-run', '--no-dmg', '--config', good, nowhere)
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/FAILED at "Check the build": .* does not exist/)
    expect(result.stdout).not.toMatch(/Check the disk image/)
  })

  it('takes the file from LUCIUM_PUBLISH_CONFIG, and the channel stable from it', () => {
    const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, '--dry-run', '--channel', 'stable', nowhere], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, LUCIUM_PUBLISH_CONFIG: good, LUCIUM_PUBLISH_JOURNAL: join(dir, 'journal.jsonl') }
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('on the channel "stable" (https://lucium.app/updates/darwin-arm64/)')
  })

  it('lets --config win over the variable', () => {
    const result = run('--dry-run', '--config', onlyTest, '--channel', 'stable', nowhere)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(`is not in ${onlyTest}`)
  })
})

// The repository becomes public: what the servers are stays in the file outside of it. These are the files that talk about the publication (this one
// is left out: it holds the patterns). The brackets keep the name of the volume out of this very file.
describe('the files about the publication', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
  const files = ['./publish-update.ts', '../../scripts/publish-update.mjs', '../../docs/community/release-process.md', '../../docs/drm.md']

  it('hold no address of a server, no folder of a server volume and no user of a server', () => {
    for (const path of files) {
      const text = read(path)
      expect(text, path).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
      expect(text, path).not.toMatch(/docker\/volumes|_data\/|lucium[-]updates/)
      expect(text, path).not.toMatch(/\bubunt[u]@/)
    }
  })
})
