import { createPrivateKey } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { commandLine, publish, resolveChannel, withdraw, type Channel, type ChannelFile, type Command, type CommandResult, type PublishDeps, type PublishInput, type WithdrawInput } from './publish-update'
import * as gate from './release-gate'
import { releaseFile } from './update-feed-file'
import { FEED_KEY_FILE, feedKeysIn, publicKeyOfPrivate, signFeedText } from './update-feed-signature'
import { writtenFeed } from './update-feed-keys.test-support'
import { posix } from './windows.test-support'

// The publication of the Mac runs on the maintainer's Mac and its reference is recorded there, with POSIX paths ("/repo/dist-drm/…"). The paths of this test are
// written that way, so the code is given the path functions of a Mac on every system: on Windows `join` would turn them into "\\repo\\dist-drm\\…" (and the shell
// quoting of a command line would then quote them), and the transcript would differ from the reference for a reason that is not the publication's.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>()
  return { ...actual.posix, default: actual.posix, posix: actual.posix, win32: actual.win32 }
})

// The publication of the Mac must stay what it was, to the byte, when the publication of the other systems was added to the same code (the study of card 819,
// lot 1). The reference is the whole of what a publication of the Mac says, runs, writes and journals, recorded from the code as it was before that lot
// (publish-update-mac-reference.golden.json), for a publication on each channel, a dry run, and a withdrawal. Nothing here reaches a network: the effects are fakes.
// To record it again, on purpose, after a change of the Mac's publication that was wanted: RECORD_MAC_REFERENCE=1 pnpm vitest run src/main/publish-update-mac-reference.test.ts.
// A fixed key (Ed25519 signs the same bytes the same way): the recorded feeds hold their signatures, and they must not change from one run to the next.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const PRIVATE_PEM = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.alloc(32, 7)]), format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }).toString()
const keyFolder = mkdtempSync(`${tmpdir()}/lucium-mac-reference-key-`)
writeFileSync(`${keyFolder}/${FEED_KEY_FILE}`, PRIVATE_PEM, { mode: 0o600 })
process.on('exit', () => rmSync(keyFolder, { recursive: true, force: true }))
const FEED_KEYS = feedKeysIn(keyFolder, [publicKeyOfPrivate(PRIVATE_PEM)])
const signedFeed = (unsigned: string): string => signFeedText(unsigned, [PRIVATE_PEM])
const GOLDEN = fileURLToPath(new URL('./publish-update-mac-reference.golden.json', import.meta.url))

const VERSION = '1.0.2'
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
const ZIP = `Lucium-${VERSION}-arm64.zip`
const DMG = `Lucium-${VERSION}-arm64.dmg`
const STAGING = '/tmp/lucium-publish.Ab3dE5gH7j'
const HASH = 'a'.repeat(64)
const SIZE = 128_172_732
const DMG_HASH = 'c'.repeat(64)
const DMG_SIZE = 141_000_017
const EXE = { sha256: 'e'.repeat(64), size: 91_024 }
const COMMIT = '1234567890abcdef1234567890abcdef12345678'
const NOW = new Date('2026-11-12T12:00:00Z')
const INPUT: PublishInput = {
  version: VERSION,
  root: '/repo',
  archive: `/repo/dist-drm/${ZIP}`,
  app: '/repo/dist-drm/mac-arm64/Lucium.app',
  installedApp: '/Applications/Lucium.app',
  buildLog: null,
  channelName: 'test',
  channel: channelOf('test'),
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
const feedFor = (version: string, base: string, sha256 = HASH): string =>
  writtenFeed(
    releaseFile({ version, base, fileName: `Lucium-${version}-arm64.zip`, sha256, size: SIZE, date: new Date('2026-11-10T09:00:00Z'), notes: 'Notes.', notesEn: 'Notes.' })
  )
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
  engineRun: { endedAt: '2026-11-10T07:10:00.000Z', reportSha256: 'd'.repeat(64) }
}
const FILES: Record<string, string> = {
  [INPUT.buildRecord]: JSON.stringify({ version: VERSION, commit: COMMIT, clean: true, builtAt: '2026-11-10T08:00:00.000Z', archive: { name: ZIP, sha256: HASH, size: SIZE } }),
  [INPUT.engineRun]: JSON.stringify({
    commit: COMMIT,
    clean: true,
    startedAt: '2026-11-10T06:00:00.000Z',
    endedAt: '2026-11-10T07:10:00.000Z',
    steps: { engine: 1, compare: 0, webstore: 0, extwindows: 0 },
    reportSha256: 'd'.repeat(64)
  }),
  '/repo/CHANGELOG.md': CHANGELOG,
  '/repo/CHANGELOG.fr.md': CHANGELOG,
  [INPUT.journal]: gate.journalLine(TEST_ENTRY),
  [INPUT.attestation]: JSON.stringify({
    version: VERSION,
    archiveSha256: HASH,
    attestedBy: 'The maintainer',
    attestedAt: '2026-11-11T18:30:00Z',
    checks: { netflixPlays: true, touchIdUnlocksTheVault: true, updateFromPreviousVersion: true },
    updatedFrom: '1.0.1'
  })
}

/** What a withdrawal reads on the server: the feed offering 1.0.2, the kept feed of 1.0.1, the folder's names. */
const DONE = (stdout = '', status: number | null = 0): CommandResult => ({ status, stdout, stderr: '' })

function fakeDeps(options: { withdrawing?: boolean }) {
  const transcript: string[] = []
  const written: Record<string, string> = {}
  const appended: string[] = []
  const base = 'https://test.lucium.app/updates/darwin-arm64/'
  const inPlace = signedFeed(feedFor('1.0.2', base))
  const kept = signedFeed(feedFor('1.0.1', base, 'f'.repeat(64)))
  let feedAfter = ''
  const respond = (command: Command): CommandResult => {
    const script = command.args.at(-1) ?? ''
    if (command.program === '/usr/bin/plutil') return DONE(`${VERSION}\n`)
    if (command.program === 'xcrun') return DONE('The validate action worked!')
    if (command.program === '/usr/bin/zipinfo') return DONE('Lucium.app/\nLucium.app/Contents/\nLucium.app/Contents/Info.plist\nLucium.app/Contents/MacOS/Lucium\n')
    if (command.program === 'git') return command.args.includes('rev-parse') ? DONE('', 1) : DONE('', 1)
    if (command.program === 'node') return DONE(feedFor(VERSION, command.args[2] ?? base))
    if (command.program === 'scp') return DONE()
    if (script.includes('mktemp -d')) return DONE(`${STAGING}\n`)
    if (command.program === 'curl') {
      if (command.args.includes('-I')) return DONE(command.args.at(-1)?.includes('1.0.1') ? '200' : '404')
      if (script.endsWith('.dmg.sha256')) return DONE(`${DMG_HASH}  ${DMG}\n`)
      return DONE(options.withdrawing ? feedAfter : signedFeed(feedFor(VERSION, command.args.at(-1)?.replace('feed.json', '') ?? base)))
    }
    if (script.startsWith('sha256sum')) return DONE(`${script.endsWith('.dmg') ? DMG_HASH : HASH}  x\n`)
    if (script.startsWith('rm -rf -- ')) return DONE()
    if (script.startsWith('D=') && script.includes('ls -1') ) return DONE('feed-1.0.1.json\nfeed.json\n')
    if (script.includes('then sudo -n cat $D/feed.json') || script.includes('sudo -n cat /srv/updates')) return DONE(options.withdrawing ? (script.includes('feed-1.0.1') ? kept : inPlace) : '')
    if (script.startsWith('sudo -n ls')) return DONE('feed-1.0.1.json\nfeed.json\n')
    if (script.includes('sudo -n cat /srv/updates') || script.includes('feed-1.0.1.json') && script.startsWith('sudo -n cat')) return DONE(kept)
    if (script.includes('sha256sum $D/') && script.includes('| wc -c')) return DONE(`${'f'.repeat(64)}  x\n${SIZE}\n`)
    const writing = /printf %s (\S+) \| base64 -d/.exec(script)
    if (writing) {
      feedAfter = Buffer.from(writing[1] as string, 'base64').toString('utf8')
      return DONE()
    }
    return DONE()
  }
  const deps: PublishDeps = {
    say: (line) => transcript.push(line),
    // Everything a publication looks for is there: the archive, the app, the image and its record, the key, the journal.
    exists: () => true,
    readText: (file) => {
      const path = posix(file)
      const text = FILES[path]
      if (text !== undefined) return text
      if (path.endsWith('.dmg.sha256')) return `${DMG_HASH}  ${DMG}\n`
      if (path.endsWith('.dmg.json')) return JSON.stringify({ image: { name: DMG, sha256: DMG_HASH, size: DMG_SIZE }, executable: EXE })
      throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
    },
    writeText: (path, text) => {
      written[posix(path)] = text
    },
    run: (command) => {
      transcript.push(`RUN ${commandLine(command)}`)
      return respond(command)
    },
    hashOutput: async (command) => {
      transcript.push(`HASH ${commandLine(command)}`)
      return command.program === '/usr/bin/unzip' ? { status: 0, ...EXE, stderr: '' } : command.args.at(-1)?.endsWith('.dmg') ? { status: 0, sha256: DMG_HASH, size: DMG_SIZE, stderr: '' } : { status: 0, sha256: HASH, size: SIZE, stderr: '' }
    },
    sha256File: async (file) => {
      const path = posix(file)
      return path.endsWith('/Contents/MacOS/Lucium') ? EXE : path.endsWith('.dmg') ? { sha256: DMG_HASH, size: DMG_SIZE } : { sha256: HASH, size: SIZE }
    },
    readFuseWire: async () => ({ version: 1, bytes: [0x30, 0x31, 0x30, 0x30, 0x31, 0x31, 0x30, 0x31, 0x31] }),
    appendText: (path, text) => {
      appended.push(`${posix(path)} ${text}`)
    },
    now: () => NOW,
    gate,
    feedKeys: FEED_KEYS
  }
  return { deps, transcript, written, appended }
}

async function record(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [name, input] of [
    ['publish on test', INPUT],
    ['publish on stable', { ...INPUT, channelName: 'stable', channel: channelOf('stable') }],
    ['dry run on test', { ...INPUT, dryRun: true }]
  ] as const) {
    const w = fakeDeps({})
    const result = await publish(input, w.deps)
    out[name] = { result, transcript: w.transcript, written: w.written, appended: w.appended }
  }
  for (const [name, dryRun] of [['withdrawal on test', false], ['dry run of a withdrawal', true]] as const) {
    const w = fakeDeps({ withdrawing: true })
    const input: WithdrawInput = { version: VERSION, to: null, channelName: 'test', channel: channelOf('test'), sshKey: INPUT.sshKey, dryRun, journal: INPUT.journal }
    const result = await withdraw(input, w.deps)
    out[name] = { result, transcript: w.transcript, written: w.written, appended: w.appended }
  }
  // The feed file of the Mac, as scripts/make-update-feed.mjs writes it, signed as the publication signs it.
  out['feed of the Mac'] = signedFeed(feedFor(VERSION, 'https://test.lucium.app/updates/darwin-arm64/'))
  return out
}

describe('the publication of the Mac, as it was before the other systems', () => {
  it('says, runs, writes and journals exactly what it did: a publication on each channel, a dry run, a withdrawal', async () => {
    const now = JSON.parse(JSON.stringify(await record()))
    if (process.env['RECORD_MAC_REFERENCE'] === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`)
      return
    }
    const reference = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>
    // The scenarios are compared one by one so that a difference names the publication it is in.
    expect(Object.keys(now)).toEqual(Object.keys(reference))
    for (const name of Object.keys(reference)) expect(now[name], name).toEqual(reference[name])
    // The recorded publications really went through: a reference of a publication that stopped at its first step would prove nothing.
    for (const name of ['publish on test', 'publish on stable']) expect((reference[name] as { result: unknown }).result, name).toEqual({ ok: true, dryRun: false })
    expect((reference['withdrawal on test'] as { result: unknown }).result).toMatchObject({ ok: true, offered: 'earlier version' })
  })
})
