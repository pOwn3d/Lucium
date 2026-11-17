import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { updateOutcome } from '@shared/update-check'
import {
  FIRST_FEED_VERSION,
  NO_FEED,
  commandLine,
  compareDotted,
  describeWithdrawFailure,
  feedWithWithdrawn,
  keptFeedVersions,
  parsePublishArgs,
  readRelease,
  readWithdrawn,
  resolveChannel,
  resolveWithdrawal,
  returnProblems,
  withdraw,
  withdrawPlan,
  withdrawnList,
  withdrawnProblem,
  type ChannelFile,
  type Command,
  type CommandResult,
  type WithdrawInput
} from './publish-update'
import * as gate from './release-gate'
import { TEST_FEED_KEYS, signedFeed, writtenFeed } from './update-feed-keys.test-support'

// The withdrawal of a published version (scripts/publish-update.mjs --withdraw). Nothing here touches a network or a server: the commands are
// checked as text, and the steps are run against a made-up folder of a channel that records what was run and applies it.
const SERVERS: ChannelFile = { path: '/cfg/publish-channels.json', state: 'read', config: { stable: { host: 'deploy@updates.example', folder: '/srv/updates/stable' } } }
const choice = resolveChannel('stable', SERVERS)
if (!choice.ok) throw new Error(choice.message)
const CHANNEL = choice.channel
const BASE = 'https://lucium.app/updates/darwin-arm64/'
const KEY = '/home/me/.ssh/id_ed25519'
const BAD = '1.0.2'
const JOURNAL = '/home/me/Library/Application Support/lucium-secrets/publish-journal.jsonl'
const NOW = '2026-11-21T08:00:00.000Z'
const INPUT: WithdrawInput = { version: BAD, to: null, channelName: 'stable', channel: CHANNEL, sshKey: KEY, dryRun: false, journal: JOURNAL }
const hashOf = (version: string): string => version.replace(/\D/g, '').padEnd(64, 'a')
const sizeOf = (version: string): number => 100_000_000 + Number(version.replace(/\D/g, ''))
const zip = (version: string): string => `Lucium-${version}-arm64.zip`
const dmg = (version: string): string => `Lucium-${version}-arm64.dmg`
/** The feed of a version before it is signed, as the publication writes it. */
const unsignedFeedOf = (version: string, change: Record<string, unknown> = {}): string =>
  writtenFeed({ currentRelease: version, page: 'https://lucium.app/telecharger/', releases: [{ version, updateTo: { version, name: `Lucium ${version}`, notes: 'Notes.', pub_date: '2026-11-20T09:00:00Z', url: `${BASE}${zip(version)}`, sha256: hashOf(version), size: sizeOf(version), ...change } }] })
/** The feed of a version as a publication leaves it on the server: signed. */
const feedOf = (version: string, change: Record<string, unknown> = {}): string => signedFeed(unsignedFeedOf(version, change))

const done = (stdout = '', status: number | null = 0, stderr = ''): CommandResult => ({ status, stdout, stderr })

/** The files of the three versions a channel holds once 1.0.2 is published: the kept feeds of the two before it, and the feed of 1.0.2 in place. */
const published = (): Record<string, string> => ({
  'feed.json': feedOf(BAD),
  'feed-1.0.0.json': feedOf('1.0.0'),
  'feed-1.0.1.json': feedOf('1.0.1'),
  ...Object.fromEntries(['1.0.0', '1.0.1', BAD].flatMap((version) => [[zip(version), `zip ${version}`], [dmg(version), `dmg ${version}`], [`${dmg(version)}.sha256`, `sum ${version}`]]))
})

/**
 * A folder of a channel, and the site that serves it: it runs the commands of the plan as the server would (the scripts are matched as text), so
 * that a test reads what the folder holds and what the web answers afterwards. `fails` makes the command whose script holds that text fail.
 */
function server(files: Record<string, string> = published(), options: { fails?: string; keyMissing?: boolean; served?: (name: string) => boolean; journalFails?: boolean; feedKeys?: typeof TEST_FEED_KEYS } = {}) {
  const ran: Command[] = []
  // What was added to the journal, and when among the commands: the count of commands run before each line.
  const appended: Array<{ path: string; text: string; after: number }> = []
  const appendText = (path: string, text: string): void => {
    if (options.journalFails) throw new Error('EACCES: permission denied')
    appended.push({ path, text, after: ran.length })
  }
  const said: string[] = []
  // The site serves a name of the folder only when it ends with one of these (the server of the site, `serveUpdate`).
  const served = options.served ?? ((name: string) => name in files && /\.(zip|dmg|sha256|json)$/.test(name))
  const weigh = (name: string): CommandResult => {
    const version = /^Lucium-(.+)-arm64\.zip$/.exec(name)?.[1] ?? ''
    return name in files ? done(`${hashOf(version)}  /srv/updates/stable/${name}\n${sizeOf(version)}\n`) : done('', 1, `sha256sum: ${name}: No such file or directory`)
  }
  const run = (command: Command): CommandResult => {
    ran.push(command)
    const script = command.args.at(-1) ?? ''
    // The folder of a channel is readable by root only: a read that nothing elevates would read nothing on the real server, so it is no read here.
    if (command.program === 'ssh' && readsWithoutSudo(script).length > 0) throw new Error(`a read of the folder that does not go through sudo -n: ${commandLine(command)}`)
    if (options.fails && script.includes(options.fails)) return done('', 1, 'sudo: a password is required')
    if (command.program === 'curl') {
      const name = script.slice(BASE.length)
      if (command.args.includes('-I')) return done(served(name) ? '200' : '404')
      return served(name) ? done(files[name]) : done('', 22, 'curl: (22) The requested URL returned error: 404')
    }
    if (script.startsWith('sudo -n ls -1 ')) return done(Object.keys(files).join('\n'))
    if (script.includes('then sudo -n cat $D/feed.json')) return done(files['feed.json'] ?? '')
    if (script.startsWith('sudo -n cat ')) {
      const name = script.slice(script.lastIndexOf('/') + 1)
      return name in files ? done(files[name]) : done('', 1, `cat: ${name}: No such file or directory`)
    }
    if (script.includes('sha256sum $D/')) return weigh(/sha256sum \$D\/(\S+)/.exec(script)?.[1] ?? '')
    const copied = /sudo -n cp -p \$D\/(\S+) \$D\/(\S+)$/.exec(script)
    if (copied) {
      files[copied[2] as string] = files[copied[1] as string] as string
      return done()
    }
    const written = /printf %s (\S+) \| base64 -d > \$T && sudo -n install -o root -g root -m 644 \$T \$D\/\.feed\.json\.part && sudo -n mv \$D\/\.feed\.json\.part \$D\/feed\.json/.exec(script)
    if (written) {
      files['feed.json'] = Buffer.from(written[1] as string, 'base64').toString('utf8')
      return done()
    }
    const moved = /sudo -n mv -f \$D\/feed\.json \$D\/(\S+)$/.exec(script)
    if (moved) {
      files[moved[1] as string] = files['feed.json'] as string
      delete files['feed.json']
      return done()
    }
    const aside = /for F in ([^;]+); do .* sudo -n mv -f \$D\/\$F \$D\/\$F(\.\w+) /.exec(script)
    if (aside) {
      for (const name of (aside[1] as string).split(' ')) {
        if (!(name in files)) continue
        files[`${name}${aside[2]}`] = files[name] as string
        delete files[name]
      }
      return done()
    }
    throw new Error(`a command the made-up server does not know: ${commandLine(command)}`)
  }
  return {
    files,
    ran,
    said,
    appended,
    lines: () => appended.map((line) => JSON.parse(line.text) as gate.WithdrawalEntry),
    deps: { say: (line: string) => void said.push(line), run, exists: (path: string) => !(options.keyMissing && path === KEY), appendText, now: () => new Date(NOW), gate, feedKeys: options.feedKeys ?? TEST_FEED_KEYS },
    scripts: () => ran.map((command) => command.args.at(-1) ?? '')
  }
}

const offeredBy = (files: Record<string, string>): string | undefined => (files['feed.json'] === undefined ? undefined : readRelease(files['feed.json'])?.version)
/** The commands that change the server: a `sudo -n` that installs, copies, moves or removes (the reads of the folder go through `sudo -n` too). */
const changes = (scripts: string[]): string[] => scripts.filter((script) => /sudo -n (?:install|cp|mv|rm)\b/.test(script))
/** What a script of the server reads without `sudo -n`: a `test`, `[ -f … ]`, `cat`, `ls`, `sha256sum` or `stat` that nothing elevates. */
const readsWithoutSudo = (script: string): string[] => script.match(/(?<!sudo -n )(?:\btest -[a-z]\b|\b(?:ls|cat|sha256sum|stat)\b)|\[ -[a-z] /g) ?? []

describe('the arguments of a withdrawal', () => {
  it('read --withdraw and --to, with the channel, the file of the servers, the key and the dry run', () => {
    expect(parsePublishArgs(['--withdraw', BAD, '--channel', 'stable', '--dry-run'])).toMatchObject({ ok: true, options: { withdraw: BAD, to: null, channel: 'stable', dryRun: true } })
    expect(parsePublishArgs([`--withdraw=${BAD}`, '--to', '1.0.0'])).toMatchObject({ ok: true, options: { withdraw: BAD, to: '1.0.0' } })
    expect(parsePublishArgs(['--withdraw', BAD, '--to', NO_FEED])).toMatchObject({ ok: true, options: { to: 'none' } })
    expect(parsePublishArgs([])).toMatchObject({ ok: true, options: { withdraw: null, to: null } })
  })

  it('refuse a version that is not three numbers: it ends up in a command of the server', () => {
    for (const version of ['v1.0.2', '1.0', '1.0.2-beta', '1.0.2; rm -rf /', '$(id)', '../1.0.2', 'latest']) {
      expect(parsePublishArgs(['--withdraw', version]), version).toEqual({ ok: false, message: `--withdraw needs a version such as 1.0.1 (got ${version})` })
      expect(parsePublishArgs(['--withdraw', BAD, '--to', version]), version).toMatchObject({ ok: false, message: expect.stringMatching(/^--to needs a version such as 1\.0\.0, or "none"/) })
    }
    expect(parsePublishArgs(['--withdraw'])).toEqual({ ok: false, message: '--withdraw needs a value' })
  })

  it('refuse what belongs to a publication: a withdrawal publishes nothing', () => {
    expect(parsePublishArgs(['--withdraw', BAD, 'dist-drm/a.zip'])).toMatchObject({ ok: false, message: expect.stringMatching(/--withdraw publishes nothing/) })
    for (const option of [['--app', '/a.app'], ['--installed-app', '/i.app'], ['--build-log', '/log'], ['--no-dmg']]) {
      expect(parsePublishArgs(['--withdraw', BAD, ...option]), option[0]).toMatchObject({ ok: false, message: expect.stringMatching(/does not go with --withdraw/) })
    }
    expect(parsePublishArgs(['--to', '1.0.0'])).toEqual({ ok: false, message: '--to only goes with --withdraw' })
  })

  it('refuse the conditions of a publication: a withdrawal reads none, and an option that names one would look as if it did', () => {
    const REASON = 'the flaw is being exploited in the wild'
    for (const option of [['--build-record', '/b.json'], ['--engine-run', '/e.json'], ['--no-engine-run', REASON], ['--attestation', '/a.json'], ['--min-test-hours', '2'], ['--security-fix', REASON]]) {
      expect(parsePublishArgs(['--withdraw', BAD, ...option]), option[0]).toEqual({ ok: false, message: `${option[0]} is an option of the publication: it does not go with --withdraw` })
    }
  })

  it('take the journal as the publication does: --journal, else the environment variable, else beside the file of the servers', () => {
    const inputOf = (args: string[], journalFromEnv?: string): WithdrawInput => {
      const parsed = parsePublishArgs(['--withdraw', BAD, '--channel', 'stable', ...args])
      if (!parsed.ok) throw new Error(parsed.message)
      const resolved = resolveWithdrawal(parsed.options, { cwd: '/work', home: '/home/me', servers: SERVERS, journalFromEnv })
      if (!resolved.ok) throw new Error(resolved.message)
      return resolved.input
    }
    expect(inputOf([]).journal).toBe(JOURNAL)
    expect(inputOf([], ' /env/journal.jsonl ').journal).toBe('/env/journal.jsonl')
    expect(inputOf(['--journal', 'j.jsonl'], '/env/journal.jsonl').journal).toBe('/work/j.jsonl')
  })

  it('resolve the channel from the file of the servers and the key as the publication does', () => {
    const parsed = parsePublishArgs(['--withdraw', BAD, '--channel', 'stable'])
    if (!parsed.ok) throw new Error(parsed.message)
    expect(resolveWithdrawal(parsed.options, { cwd: '/work', home: '/home/me', servers: SERVERS })).toEqual({ ok: true, input: INPUT })
    expect(resolveWithdrawal(parsed.options, { cwd: '/work', home: '/home/me', servers: SERVERS, sshKeyFromEnv: '/keys/k' })).toMatchObject({ ok: true, input: { sshKey: '/keys/k' } })
    // The default channel is "test", which this file of the servers does not hold: nothing is guessed.
    const onTest = parsePublishArgs(['--withdraw', BAD])
    if (!onTest.ok) throw new Error(onTest.message)
    expect(resolveWithdrawal(onTest.options, { cwd: '/work', home: '/home/me', servers: SERVERS })).toMatchObject({ ok: false, message: expect.stringMatching(/The channel "test" is not in/) })
  })
})

describe('the checks of a withdrawal', () => {
  it('compare versions number by number', () => {
    expect(compareDotted('1.0.10', '1.0.9')).toBeGreaterThan(0)
    expect(compareDotted('1.0.1', '1.0.2')).toBeLessThan(0)
    expect(compareDotted('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareDotted('1.0.0', '1.0.0')).toBe(0)
    expect(compareDotted('1.0', '1.0.0')).toBe(0)
  })

  it('find the kept feeds in the names of the folder, the highest first, and nothing else', () => {
    const listing = ['feed.json', 'feed-1.0.9.json', 'feed-1.0.10.json', 'feed-1.0.0.json', 'feed-1.0.5.json.withdrawn', 'feed.json.replaced', 'feed-latest.json', 'Lucium-1.0.9-arm64.zip', ' feed-1.1.0.json '].join('\n')
    expect(keptFeedVersions(listing)).toEqual(['1.1.0', '1.0.10', '1.0.9', '1.0.0'])
    expect(keptFeedVersions('')).toEqual([])
  })

  it('read the release a feed offers, and nothing from a file both readers would not take', () => {
    expect(readRelease(feedOf('1.0.1'))).toEqual({ version: '1.0.1', url: `${BASE}${zip('1.0.1')}`, sha256: hashOf('1.0.1'), size: sizeOf('1.0.1') })
    for (const text of ['', 'not json', '[]', '{}', JSON.stringify({ currentRelease: '1.0.1', releases: [] }), feedOf('1.0.1', { version: '1.0.0' }), feedOf('1.0.1', { sha256: 'abc' }), feedOf('1.0.1', { size: 0 }), feedOf('1.0.1', { url: 7 }), feedOf('v1.0.1')]) {
      expect(readRelease(text), text).toBeNull()
    }
  })

  it('accept to go back to the kept feed of a lower version of this channel', () => {
    expect(returnProblems(readRelease(feedOf('1.0.1')), '1.0.1', BAD, CHANNEL)).toEqual([])
  })

  it('refuse to go back to the same version or a higher one', () => {
    expect(returnProblems(readRelease(feedOf(BAD)), BAD, BAD, CHANNEL)).toEqual([`${BAD} is not below ${BAD}: a withdrawal only goes back; a higher version is published, not returned to`])
    expect(returnProblems(readRelease(feedOf('1.0.3')), '1.0.3', BAD, CHANNEL)[0]).toMatch(/1\.0\.3 is not below 1\.0\.2/)
  })

  it('refuse to go back before the first version of the channels: an earlier build is another application', () => {
    expect(FIRST_FEED_VERSION).toBe('1.0.0')
    expect(returnProblems(readRelease(feedOf('0.2.15')), '0.2.15', BAD, CHANNEL)).toEqual(['0.2.15 is before 1.0.0, the first version these channels serve: no feed may name it'])
    expect(returnProblems(readRelease(feedOf('1.0.0')), '1.0.0', BAD, CHANNEL)).toEqual([])
  })

  it('refuse a kept feed that is not the one of the version, or that names an archive of another place', () => {
    expect(returnProblems(null, '1.0.1', BAD, CHANNEL)).toEqual(['feed-1.0.1.json is not a release file'])
    expect(returnProblems(readRelease(feedOf('1.0.0')), '1.0.1', BAD, CHANNEL)).toEqual(['feed-1.0.1.json offers 1.0.0, not 1.0.1', `feed-1.0.1.json names ${BASE}${zip('1.0.0')}, expected ${BASE}${zip('1.0.1')}`])
    const elsewhere = readRelease(feedOf('1.0.1', { url: `https://test.lucium.app/updates/darwin-arm64/${zip('1.0.1')}` }))
    expect(returnProblems(elsewhere, '1.0.1', BAD, CHANNEL)[0]).toMatch(/names https:\/\/test\.lucium\.app\/.*expected https:\/\/lucium\.app\//)
  })
})

describe('the list of the withdrawn versions in a feed', () => {
  it('is read from the feed: versions of three numbers, and what is not one is left out and said', () => {
    expect(readWithdrawn(feedOf('1.0.1'))).toEqual({ versions: [], problem: null })
    expect(readWithdrawn('')).toEqual({ versions: [], problem: null })
    expect(readWithdrawn(feedWithWithdrawn(feedOf('1.0.1'), ['1.0.3', BAD]))).toEqual({ versions: ['1.0.3', BAD], problem: null })
    const feed = JSON.parse(feedOf('1.0.1')) as Record<string, unknown>
    const odd = readWithdrawn(JSON.stringify({ ...feed, withdrawn: [BAD, 'v1.0.3', 7, '1.0'] }))
    expect(odd.versions).toEqual([BAD])
    expect(odd.problem).toMatch(/holds something that is not a version of three numbers \(\["v1\.0\.3",7,"1\.0"\]\)/)
    expect(readWithdrawn(JSON.stringify({ ...feed, withdrawn: BAD }))).toEqual({ versions: [], problem: '"withdrawn" is not a list ("1.0.2")' })
    expect(readWithdrawn('<html>')).toEqual({ versions: [], problem: 'the feed is not JSON' })
  })

  it('holds each version once, the highest first, and never the version the feed offers', () => {
    expect(withdrawnList([BAD, '1.0.10', BAD, '1.0.1', 'x'], '1.0.1')).toEqual(['1.0.10', BAD])
    expect(withdrawnList([], '1.0.1')).toEqual([])
  })

  it('is written in the feed without touching anything else of it, and taken out of it when it is empty', () => {
    const feed = feedOf('1.0.1')
    const listed = feedWithWithdrawn(feed, [BAD])
    expect(JSON.parse(listed)).toEqual({ ...(JSON.parse(feed) as object), withdrawn: [BAD] })
    expect(readRelease(listed)).toEqual(readRelease(feed))
    expect(listed.endsWith('}\n')).toBe(true)
    expect(JSON.parse(feedWithWithdrawn(listed, []))).toEqual(JSON.parse(feed))
  })

  it('must be, online, exactly the one that was written', () => {
    const listed = feedWithWithdrawn(feedOf('1.0.1'), ['1.0.3', BAD])
    expect(withdrawnProblem(listed, ['1.0.3', BAD])).toBeNull()
    expect(withdrawnProblem(listed, [BAD])).toBe('the withdrawn versions are ["1.0.3","1.0.2"], expected ["1.0.2"]')
    expect(withdrawnProblem(feedOf('1.0.1'), [BAD])).toBe('the withdrawn versions are [], expected ["1.0.2"]')
    expect(withdrawnProblem(feedOf('1.0.1'), [])).toBeNull()
    expect(withdrawnProblem('<html>', [])).toBe('the feed is not JSON')
  })
})

describe('what a withdrawal relies on in every installed copy', () => {
  // Going back to an earlier feed is safe only because a copy that runs a later version never takes it. Both guards are in the application
  // from the first version the channels serve; a withdrawal has no way to tell which version a copy runs.
  it('the check calls a feed of an older version "up to date": nothing is offered, nothing is downloaded', () => {
    const answer = { ok: true as const, json: JSON.parse(feedOf('1.0.1')) as unknown }
    expect(updateOutcome(BAD, `${BASE}feed.json`, answer)).toEqual({ kind: 'up-to-date', current: BAD })
    expect(updateOutcome('1.0.1', `${BASE}feed.json`, answer)).toEqual({ kind: 'up-to-date', current: '1.0.1' })
    expect(updateOutcome('1.0.0', `${BASE}feed.json`, answer)).toMatchObject({ kind: 'available', offer: { version: '1.0.1' } })
  })

  it('the installer refuses a bundle older than the running one (electron-builder.yml)', () => {
    const builder = readFileSync(fileURLToPath(new URL('../../electron-builder.yml', import.meta.url)), 'utf8')
    expect(builder).toMatch(/^\s+ElectronSquirrelPreventDowngrades: true$/m)
  })
})

describe('the commands of a withdrawal', () => {
  const plan = withdrawPlan({ version: BAD, channel: CHANNEL, sshKey: KEY })

  it('read the folder and the feed without changing anything, and only through sudo -n: the folder of a channel is readable by root only', () => {
    for (const command of [plan.list, plan.readFeed, plan.target('1.0.1').readKept, plan.target('1.0.1').weighArchive]) {
      const script = command.args.at(-1) ?? ''
      expect(command.program).toBe('ssh')
      // Nothing that writes (the `>&2` of a message is not a redirection to a file), and no read the account would make itself.
      expect(script).not.toMatch(/\b(?:rm|mv|cp|install)\b|>(?!&2)/)
      expect(readsWithoutSudo(script)).toEqual([])
      expect(script).toContain('sudo -n ')
    }
    expect(plan.list.args.at(-1)).toBe('sudo -n ls -1 /srv/updates/stable')
    expect(plan.target('1.0.1').readKept.args.at(-1)).toBe('sudo -n cat /srv/updates/stable/feed-1.0.1.json')
    expect(plan.target('1.0.1').weighArchive.args.at(-1)).toBe('D=/srv/updates/stable; sudo -n sha256sum $D/Lucium-1.0.1-arm64.zip && sudo -n cat $D/Lucium-1.0.1-arm64.zip | wc -c')
  })

  it('read the feed so that a sudo that is refused stops the script, and is never read as "no feed yet"', () => {
    expect(plan.readFeed.args.at(-1)).toBe(
      'D=/srv/updates/stable; sudo -n test -d / || { echo "cannot read the folder of the channel: sudo -n is refused on the server (the folder of a channel is readable by root only)" >&2; exit 2; }; if sudo -n test -f $D/feed.json; then sudo -n cat $D/feed.json; fi'
    )
  })

  it('write the feed as a publication writes one: a temporary name, then renamed, root:root 0644; its text travels in base64, which no shell reads', () => {
    // An apostrophe, a dollar and a backquote in the notes: none of them reaches the shell of the server.
    const text = feedWithWithdrawn(feedOf('1.0.1', { notes: "L'onglet `$HOME` ; \"x\"" }), [BAD])
    const script = plan.writeFeed(text).args.at(-1) ?? ''
    const sent = /^D=\/srv\/updates\/stable; T=\$\(mktemp\) && printf %s ([A-Za-z0-9+/=]+) \| base64 -d > \$T && sudo -n install -o root -g root -m 644 \$T \$D\/\.feed\.json\.part && sudo -n mv \$D\/\.feed\.json\.part \$D\/feed\.json; S=\$\?; rm -f \$T; if \[ \$S != 0 \]; then sudo -n rm -f \$D\/\.feed\.json\.part; exit 1; fi$/.exec(script)
    expect(Buffer.from(sent?.[1] ?? '', 'base64').toString('utf8')).toBe(text)
  })

  it('rename what is withdrawn to names the site does not serve, and delete nothing', () => {
    expect(plan.keepWithdrawnFeed.args.at(-1)).toBe('D=/srv/updates/stable; sudo -n cp -p $D/feed.json $D/feed-1.0.2.json.withdrawn')
    expect(plan.dropFeed.args.at(-1)).toBe('D=/srv/updates/stable; sudo -n mv -f $D/feed.json $D/feed-1.0.2.json.withdrawn')
    expect(plan.setAsideFiles.args.at(-1)).toBe(
      'D=/srv/updates/stable; sudo -n test -d / || { echo "cannot set the files aside: sudo -n is refused on the server (the folder of a channel is readable by root only)" >&2; exit 2; }; for F in Lucium-1.0.2-arm64.zip Lucium-1.0.2-arm64.dmg Lucium-1.0.2-arm64.dmg.sha256 feed-1.0.2.json; do if sudo -n test -e $D/$F; then sudo -n mv -f $D/$F $D/$F.withdrawn || exit 1; fi; done'
    )
    for (const command of [plan.keepWithdrawnFeed, plan.dropFeed, plan.setAsideFiles, plan.writeFeed(feedOf('1.0.1'))]) expect(command.args.at(-1)).not.toMatch(/\brm (?!-f \$(?:D\/\.feed\.json\.part|T;))/)
    for (const command of [plan.keepWithdrawnFeed, plan.dropFeed, plan.setAsideFiles, plan.writeFeed(feedOf('1.0.1'))]) expect(readsWithoutSudo(command.args.at(-1) ?? '')).toEqual([])
  })

  it('ask the web with a HEAD, so that a check is not counted as a download', () => {
    expect(plan.statusOf(`${BASE}${zip(BAD)}`)).toMatchObject({ program: 'curl', args: ['-sS', '-I', '-o', '/dev/null', '-w', '%{http_code}', `${BASE}${zip(BAD)}`] })
    expect(plan.withdrawnUrls).toEqual([`${BASE}${zip(BAD)}`, `${BASE}${dmg(BAD)}`, `${BASE}${dmg(BAD)}.sha256`])
  })

  it('never put the key in a script of the server, only its path in -i', () => {
    for (const command of [plan.list, plan.readFeed, plan.keepWithdrawnFeed, plan.dropFeed, plan.setAsideFiles, plan.writeFeed(feedOf('1.0.1'))]) {
      expect(command.args.at(-1)).not.toContain(KEY)
      expect(command.args).toContain('BatchMode=yes')
      expect(command.args[command.args.indexOf('-i') + 1]).toBe(KEY)
    }
  })
})

describe('the withdrawal', () => {
  it('puts back the feed of the highest kept version below the withdrawn one, then sets the files of the withdrawn version aside', async () => {
    const s = server()
    expect(await withdraw(INPUT, s.deps)).toEqual({ ok: true, dryRun: false, offered: 'earlier version' })
    expect(offeredBy(s.files)).toBe('1.0.1')
    // The feed of 1.0.1 as it was kept, and one thing more: 1.0.2 in its list of withdrawn versions.
    expect(s.files['feed.json']).toBe(signedFeed(feedWithWithdrawn(unsignedFeedOf('1.0.1'), [BAD])))
    expect(JSON.parse(TEST_FEED_KEYS.signedPart(s.files['feed.json'] as string) as string)).toEqual({ ...(JSON.parse(unsignedFeedOf('1.0.1')) as object), withdrawn: [BAD] })
    // Nothing of 1.0.2 answers any more, nothing is deleted, and the two other versions are untouched.
    expect(Object.keys(s.files).sort()).toEqual(
      ['feed.json', 'feed-1.0.0.json', 'feed-1.0.1.json', 'feed-1.0.2.json.withdrawn', zip('1.0.0'), dmg('1.0.0'), `${dmg('1.0.0')}.sha256`, zip('1.0.1'), dmg('1.0.1'), `${dmg('1.0.1')}.sha256`, `${zip(BAD)}.withdrawn`, `${dmg(BAD)}.withdrawn`, `${dmg(BAD)}.sha256.withdrawn`].sort()
    )
    expect(s.files['feed-1.0.2.json.withdrawn']).toBe(feedOf(BAD))
    expect(s.said.at(-4)).toMatch(/Lucium 1\.0\.2 is withdrawn from the channel "stable"/)
    expect(s.said.join('\n')).toMatch(/the copies that already run 1\.0\.2 stay on it until a higher version is published/)
  })

  it('changes the feed before it touches the files, and renames them only once the feed online names another archive that answers', async () => {
    const s = server()
    await withdraw(INPUT, s.deps)
    const scripts = s.scripts()
    const at = (text: string): number => scripts.findIndex((script) => script.includes(text))
    expect(at('ls -1')).toBe(0)
    expect(at('sha256sum $D/Lucium-1.0.1-arm64.zip')).toBeLessThan(at('install -o root'))
    expect(at('cp -p $D/feed.json $D/feed-1.0.2.json.withdrawn')).toBeLessThan(at('install -o root'))
    expect(at('install -o root')).toBeLessThan(at(`${BASE}feed.json`))
    expect(at(`${BASE}feed.json`)).toBeLessThan(at(`${BASE}${zip('1.0.1')}`))
    expect(at(`${BASE}${zip('1.0.1')}`)).toBeLessThan(at('for F in'))
    expect(at('for F in')).toBeLessThan(at(`${BASE}${zip(BAD)}`))
  })

  it('goes back to the version --to names, when its feed is kept', async () => {
    const s = server()
    expect(await withdraw({ ...INPUT, to: '1.0.0' }, s.deps)).toMatchObject({ ok: true, offered: 'earlier version' })
    expect(offeredBy(s.files)).toBe('1.0.0')
  })

  it('skips a kept feed that is not below the withdrawn version, and never goes back to a withdrawn one', async () => {
    // 1.0.3 was published over the bad 1.0.2 (its feed was kept then), and 1.0.3 is withdrawn in turn after 1.0.2 was.
    const files = { ...published(), 'feed.json': feedOf('1.0.3'), 'feed-1.0.2.json': feedOf(BAD), [zip('1.0.3')]: 'zip' }
    const first = server(files)
    expect(await withdraw(INPUT, first.deps)).toEqual({ ok: true, dryRun: false, offered: 'unchanged' })
    expect(offeredBy(first.files)).toBe('1.0.3')
    expect(first.files['feed-1.0.2.json']).toBeUndefined()
    const second = server(first.files)
    expect(await withdraw({ ...INPUT, version: '1.0.3' }, second.deps)).toMatchObject({ ok: true, offered: 'earlier version' })
    expect(offeredBy(second.files)).toBe('1.0.1')
  })

  it('leaves what the feed offers as it is when it offers another version, lists the version as withdrawn in it, and still sets its files aside', async () => {
    const s = server({ ...published(), 'feed.json': feedOf('1.0.1') })
    expect(await withdraw(INPUT, s.deps)).toEqual({ ok: true, dryRun: false, offered: 'unchanged' })
    expect(s.files['feed.json']).toBe(signedFeed(feedWithWithdrawn(unsignedFeedOf('1.0.1'), [BAD])))
    // The feed, then the files: two commands change the server.
    expect(changes(s.scripts())).toHaveLength(2)
    expect(changes(s.scripts())[1]).toContain('for F in')
    expect(s.files[zip(BAD)]).toBeUndefined()
    expect(s.files[`${zip(BAD)}.withdrawn`]).toBe(`zip ${BAD}`)
    expect(s.said.join('\n')).toMatch(/the feed does not offer 1\.0\.2 \(it offers 1\.0\.1\): what it offers is not changed/)
  })

  it('leaves the feed untouched when it already lists the version, and when the channel has no feed', async () => {
    const listed = server({ ...published(), 'feed.json': feedWithWithdrawn(feedOf('1.0.1'), [BAD]) })
    expect(await withdraw(INPUT, listed.deps)).toMatchObject({ ok: true, offered: 'unchanged' })
    expect(listed.files['feed.json']).toBe(feedWithWithdrawn(feedOf('1.0.1'), [BAD]))
    expect(changes(listed.scripts())).toHaveLength(1)
    const { 'feed.json': _feed, ...noFeed } = published()
    const none = server(noFeed)
    expect(await withdraw(INPUT, none.deps)).toMatchObject({ ok: true, offered: 'unchanged' })
    expect(none.files['feed.json']).toBeUndefined()
    expect(changes(none.scripts())).toHaveLength(1)
  })

  it('tells the copies that run the withdrawn version: the feed that stays is read by the application as "this version was withdrawn"', async () => {
    const back = server()
    await withdraw(INPUT, back.deps)
    const answer = (files: Record<string, string>) => ({ ok: true as const, json: JSON.parse(files['feed.json'] as string) as unknown })
    // Back to 1.0.1: the copy on 1.0.2 is told, with the version to install below it; the others read the feed as before.
    expect(updateOutcome(BAD, `${BASE}feed.json`, answer(back.files))).toMatchObject({ kind: 'withdrawn', current: BAD, newer: false, offer: { version: '1.0.1' } })
    expect(updateOutcome('1.0.1', `${BASE}feed.json`, answer(back.files))).toEqual({ kind: 'up-to-date', current: '1.0.1' })
    expect(updateOutcome('1.0.0', `${BASE}feed.json`, answer(back.files))).toMatchObject({ kind: 'available', offer: { version: '1.0.1' } })
    // A fix was published over it already: the copy on 1.0.2 is told, with the version to install above it.
    const fixed = server({ ...published(), 'feed.json': feedOf('1.0.3'), 'feed-1.0.2.json': feedOf(BAD), [zip('1.0.3')]: 'zip' })
    await withdraw(INPUT, fixed.deps)
    expect(updateOutcome(BAD, `${BASE}feed.json`, answer(fixed.files))).toMatchObject({ kind: 'withdrawn', current: BAD, newer: true, offer: { version: '1.0.3' } })
  })

  it('keeps the versions withdrawn before in the list, the highest first, and never lists the version the feed offers', async () => {
    // 1.0.2 was withdrawn while 1.0.3 was offered (the feed lists it), then 1.0.3 is withdrawn in turn: the feed of 1.0.1 lists both.
    const files = { ...published(), 'feed.json': feedOf('1.0.3'), 'feed-1.0.2.json': feedOf(BAD), [zip('1.0.3')]: 'zip' }
    const first = server(files)
    await withdraw(INPUT, first.deps)
    expect(readWithdrawn(first.files['feed.json'] as string)).toEqual({ versions: [BAD], problem: null })
    const second = server(first.files)
    await withdraw({ ...INPUT, version: '1.0.3' }, second.deps)
    expect(readWithdrawn(second.files['feed.json'] as string)).toEqual({ versions: ['1.0.3', BAD], problem: null })
    // A kept feed that listed the version it now goes back to (withdrawn once, published again since) no longer lists it.
    const again = server({ ...published(), 'feed-1.0.1.json': signedFeed(feedWithWithdrawn(unsignedFeedOf('1.0.1'), ['1.0.1', '1.0.0'])) })
    await withdraw(INPUT, again.deps)
    expect(readWithdrawn(again.files['feed.json'] as string).versions).toEqual([BAD, '1.0.0'])
  })

  it('stops when the feed online does not list what was written, before any file is renamed', async () => {
    // A cache in front of the site answers the feed of 1.0.1 as it was kept: the right version, without the list.
    const s = server(published())
    const run = s.deps.run
    s.deps.run = (command) => (command.program === 'curl' && command.args.includes('--fail') ? (s.ran.push(command), done(feedOf('1.0.1'))) : run(command))
    const result = await withdraw(INPUT, s.deps)
    expect(result).toMatchObject({ ok: false, step: 'Put the feed of 1.0.1 back' })
    expect(result.ok ? '' : result.problem).toMatch(/the feed online is not the one of 1\.0\.1[\s\S]*the withdrawn versions are \[\], expected \["1\.0\.2"\]/)
    expect(s.scripts().some((script) => script.includes('for F in'))).toBe(false)
  })

  it('says so when the list cannot be written in a feed that offers another version, and renames nothing', async () => {
    const s = server({ ...published(), 'feed.json': feedOf('1.0.1') }, { fails: 'base64 -d' })
    const result = await withdraw(INPUT, s.deps)
    expect(result).toMatchObject({ ok: false, offered: 'unchanged', step: 'List 1.0.2 as withdrawn in the feed' })
    expect(result.ok ? '' : result.problem).toMatch(/1\.0\.2 was not listed as withdrawn in the feed, which is as it was: sudo: a password is required/)
    expect(s.files['feed.json']).toBe(feedOf('1.0.1'))
    expect(s.files[zip(BAD)]).toBe(`zip ${BAD}`)
  })

  it('can be run again after it succeeded: nothing changes', async () => {
    const s = server()
    await withdraw(INPUT, s.deps)
    const after = { ...s.files }
    const again = server(s.files)
    expect(await withdraw(INPUT, again.deps)).toEqual({ ok: true, dryRun: false, offered: 'unchanged' })
    expect(again.files).toEqual(after)
  })

  it('changes nothing in a dry run, reads the server, and prints the commands it would run', async () => {
    const s = server()
    const before = { ...s.files }
    expect(await withdraw({ ...INPUT, dryRun: true }, s.deps)).toEqual({ ok: true, dryRun: true, offered: 'unchanged' })
    expect(s.files).toEqual(before)
    expect(changes(s.scripts())).toEqual([])
    expect(s.ran.filter((command) => command.program === 'curl')).toEqual([])
    const plan = withdrawPlan({ version: BAD, channel: CHANNEL, sshKey: KEY })
    const printed = s.said.join('\n')
    for (const command of [plan.keepWithdrawnFeed, plan.writeFeed(signedFeed(feedWithWithdrawn(unsignedFeedOf('1.0.1'), [BAD]))), plan.setAsideFiles]) expect(printed).toContain(`$ ${commandLine(command)}   (dry run: not run)`)
    expect(printed).toMatch(/Dry run done: nothing was changed on the server/)
  })

  describe('refuses, and leaves the feed and every file as they were', () => {
    const unchanged = async (files: Record<string, string>, input: WithdrawInput, message: RegExp, options: Parameters<typeof server>[1] = {}): Promise<void> => {
      const s = server(files, options)
      const before = { ...s.files }
      const result = await withdraw(input, s.deps)
      expect(result).toMatchObject({ ok: false, offered: 'unchanged' })
      expect(result.ok ? '' : result.problem).toMatch(message)
      expect(s.files).toEqual(before)
      expect(changes(s.scripts())).toEqual([])
    }
    const without = (...names: string[]): Record<string, string> => Object.fromEntries(Object.entries(published()).filter(([name]) => !names.includes(name)))

    it('when no feed of a lower version is kept: it says to publish a higher version, or --to none', async () => {
      await unchanged(without('feed-1.0.0.json', 'feed-1.0.1.json'), INPUT, /keeps no feed of a version below 1\.0\.2[\s\S]*Publish a higher version[\s\S]*--to none/)
      // A kept feed of a higher version is not something to go back to.
      await unchanged({ ...without('feed-1.0.0.json', 'feed-1.0.1.json'), 'feed-1.0.3.json': feedOf('1.0.3') }, INPUT, /keeps no feed of a version below 1\.0\.2/)
    })

    it('when --to names the withdrawn version, a higher one, or one before the first of the channels', async () => {
      await unchanged({ ...published(), 'feed-1.0.2.json': feedOf(BAD) }, { ...INPUT, to: BAD }, /1\.0\.2 is not below 1\.0\.2/)
      await unchanged({ ...published(), 'feed-1.0.3.json': feedOf('1.0.3') }, { ...INPUT, to: '1.0.3' }, /1\.0\.3 is not below 1\.0\.2/)
      await unchanged({ ...published(), 'feed-0.2.15.json': feedOf('0.2.15'), [zip('0.2.15')]: 'zip' }, { ...INPUT, to: '0.2.15' }, /0\.2\.15 is before 1\.0\.0/)
    })

    it('when the kept feed is missing, is not a release file, or is the feed of another version', async () => {
      await unchanged(without('feed-1.0.1.json'), { ...INPUT, to: '1.0.1' }, /cannot read feed-1\.0\.1\.json in the folder of the channel: cat: feed-1\.0\.1\.json: No such file/)
      await unchanged({ ...published(), 'feed-1.0.1.json': '<html>' }, INPUT, /feed-1\.0\.1\.json is not a release file/)
      await unchanged({ ...published(), 'feed-1.0.1.json': feedOf('1.0.0') }, INPUT, /feed-1\.0\.1\.json offers 1\.0\.0, not 1\.0\.1/)
    })

    it('when the archive the kept feed names is gone, or is not the one the feed describes: that feed would fail every installation', async () => {
      await unchanged(without(zip('1.0.1')), INPUT, /the archive of 1\.0\.1 cannot be weighed in the folder of the channel: sha256sum: .* No such file/)
      await unchanged({ ...published(), 'feed-1.0.1.json': feedOf('1.0.1', { sha256: 'f'.repeat(64) }) }, INPUT, /the archive of 1\.0\.1 on the server is \d+ bytes with SHA-256 101a+, its feed says \d+ bytes with f{64}/)
      await unchanged({ ...published(), 'feed-1.0.1.json': feedOf('1.0.1', { size: 5 }) }, INPUT, /its feed says 5 bytes/)
    })

    it('when the feed in place is not a release file: it cannot tell what the channel offers', async () => {
      await unchanged({ ...published(), 'feed.json': '<html>502</html>' }, INPUT, /the feed in place is not a release file/)
    })

    it('when the folder or the feed cannot be read, or the key does not exist', async () => {
      await unchanged(published(), INPUT, /cannot list the folder of the channel: sudo: a password is required/, { fails: 'ls -1' })
      await unchanged(published(), INPUT, /cannot read the feed in place/, { fails: 'then sudo -n cat $D/feed.json' })
      const s = server(published(), { keyMissing: true })
      expect(await withdraw(INPUT, s.deps)).toMatchObject({ ok: false, step: 'Check the key', offered: 'unchanged' })
      expect(s.ran).toEqual([])
    })

    it('when the feed of the withdrawn version cannot be copied aside: it is not replaced', async () => {
      const s = server(published(), { fails: 'cp -p' })
      const before = { ...s.files }
      const result = await withdraw(INPUT, s.deps)
      expect(result).toMatchObject({ ok: false, offered: 'unchanged' })
      expect(result.ok ? '' : result.problem).toMatch(/the feed of 1\.0\.2 was not kept aside, so it is not replaced: sudo: a password is required/)
      expect(s.files).toEqual(before)
      // The copy was tried, and nothing after it.
      expect(changes(s.scripts())).toEqual(['D=/srv/updates/stable; sudo -n cp -p $D/feed.json $D/feed-1.0.2.json.withdrawn'])
    })
  })

  describe('stops when the web does not answer what it should, and says what the channel offers', () => {
    it('the feed online is not the one that was put back: the files of the withdrawn version are not touched', async () => {
      // A cache in front of the site still answers the old feed.
      const s = server(published())
      const run = s.deps.run
      s.deps.run = (command) => (command.program === 'curl' && command.args.includes('--fail') ? (s.ran.push(command), done(feedOf(BAD))) : run(command))
      const result = await withdraw(INPUT, s.deps)
      expect(result).toMatchObject({ ok: false, offered: 'earlier version', step: 'Put the feed of 1.0.1 back' })
      expect(result.ok ? '' : result.problem).toMatch(/the feed online is not the one of 1\.0\.1[\s\S]*currentRelease is "1\.0\.2"/)
      expect(s.files[zip(BAD)]).toBe(`zip ${BAD}`)
      expect(s.scripts().some((script) => script.includes('for F in'))).toBe(false)
    })

    it('the archive the feed now names does not answer: the files of the withdrawn version are not touched', async () => {
      const s = server(published(), { served: (name) => name !== zip('1.0.1') })
      const result = await withdraw(INPUT, s.deps)
      expect(result).toMatchObject({ ok: false, offered: 'earlier version' })
      expect(result.ok ? '' : result.problem).toMatch(/Lucium-1\.0\.1-arm64\.zip answers 404 and not 200: the feed names an archive that does not answer/)
      expect(s.files[zip(BAD)]).toBe(`zip ${BAD}`)
    })

    it('a file of the withdrawn version still answers after it was renamed', async () => {
      const s = server(published(), { served: (name) => /\.(zip|dmg|sha256|json)$/.test(name) })
      const result = await withdraw(INPUT, s.deps)
      expect(result).toMatchObject({ ok: false, offered: 'earlier version', step: 'Set the files of 1.0.2 aside' })
      expect(result.ok ? '' : result.problem).toMatch(/Lucium-1\.0\.2-arm64\.zip answers 200 and not 404: the file is still served/)
    })

    it('the files cannot be renamed', async () => {
      const s = server(published(), { fails: 'for F in' })
      const result = await withdraw(INPUT, s.deps)
      expect(result).toMatchObject({ ok: false, offered: 'earlier version' })
      expect(result.ok ? '' : result.problem).toMatch(/the files of 1\.0\.2 were not all renamed: sudo: a password is required/)
    })
  })

  describe('with --to none, when there is no earlier version to go back to', () => {
    const first = (): Record<string, string> => ({ 'feed.json': feedOf('1.0.0'), [zip('1.0.0')]: 'zip', [dmg('1.0.0')]: 'dmg', [`${dmg('1.0.0')}.sha256`]: 'sum' })
    const input: WithdrawInput = { ...INPUT, version: '1.0.0', to: NO_FEED }

    it('takes the feed away, checks that it answers 404, then sets the files aside: nothing is deleted', async () => {
      const s = server(first())
      expect(await withdraw(input, s.deps)).toEqual({ ok: true, dryRun: false, offered: 'nothing' })
      expect(Object.keys(s.files).sort()).toEqual(['feed-1.0.0.json.withdrawn', `${zip('1.0.0')}.withdrawn`, `${dmg('1.0.0')}.withdrawn`, `${dmg('1.0.0')}.sha256.withdrawn`].sort())
      expect(s.files['feed-1.0.0.json.withdrawn']).toBe(feedOf('1.0.0'))
      expect(s.said.join('\n')).toMatch(/feed\.json answers 404: nothing is offered, and a check for updates fails until a version is published/)
    })

    it('is never the default: without --to, a first version is not withdrawn by taking the feed away', async () => {
      const s = server(first())
      expect(await withdraw({ ...input, to: null }, s.deps)).toMatchObject({ ok: false, offered: 'unchanged' })
      expect(s.files['feed.json']).toBe(feedOf('1.0.0'))
    })

    it('stops when the feed still answers', async () => {
      const s = server(first(), { served: () => true })
      const result = await withdraw(input, s.deps)
      expect(result).toMatchObject({ ok: false, offered: 'nothing', step: 'Take the feed away' })
      expect(result.ok ? '' : result.problem).toMatch(/feed\.json answers 200 and not 404: the feed is still served/)
      expect(s.files[zip('1.0.0')]).toBe('zip')
    })
  })

  describe('adds one line to the journal of the publications, of a type of its own', () => {
    it('after everything: the date, the version, the channel, what the channel offers and the version the feed went back to', async () => {
      const s = server()
      expect(await withdraw(INPUT, s.deps)).toEqual({ ok: true, dryRun: false, offered: 'earlier version' })
      expect(s.appended.map((line) => line.path)).toEqual([JOURNAL])
      expect(s.appended[0]?.text.endsWith('}\n')).toBe(true)
      expect(s.lines()).toEqual([{ at: NOW, type: 'withdrawal', version: BAD, channel: 'stable', outcome: 'withdrawn', offers: 'earlier version', to: '1.0.1' }])
      // Written last: no command of the server comes after it.
      expect(s.appended[0]?.after).toBe(s.ran.length)
      expect(s.said.join('\n')).toContain(`ok  ${JOURNAL}: one line added`)
    })

    it('says that the feed was left as it was, or taken away: no version to go back to is named then', async () => {
      const left = server({ ...published(), 'feed.json': feedOf('1.0.3'), 'feed-1.0.2.json': feedOf(BAD) })
      await withdraw(INPUT, left.deps)
      expect(left.lines()).toEqual([{ at: NOW, type: 'withdrawal', version: BAD, channel: 'stable', outcome: 'withdrawn', offers: 'unchanged', to: null }])
      const none = server({ 'feed.json': feedOf('1.0.0'), [zip('1.0.0')]: 'zip' })
      await withdraw({ ...INPUT, version: '1.0.0', to: NO_FEED }, none.deps)
      expect(none.lines()).toEqual([{ at: NOW, type: 'withdrawal', version: '1.0.0', channel: 'stable', outcome: 'withdrawn', offers: 'nothing', to: null }])
    })

    it('is not a publication: the stable channel asks it for no attestation and no wait, and it reads no local file but the key of the feed', async () => {
      // The effects it is given can read no file at all (no `readText`): no build record, no engine run, no attestation, no journal is read. The
      // keys of the feed sign what it writes.
      const s = server()
      expect(Object.keys(s.deps).sort()).toEqual(['appendText', 'exists', 'feedKeys', 'gate', 'now', 'run', 'say'])
      expect(await withdraw({ ...INPUT, channelName: 'stable' }, s.deps)).toMatchObject({ ok: true })
      // Its line is no entry of a publication: the lock of the stable channel never counts it, and still reads the journal that holds it.
      expect(gate.readJournal(s.appended[0]?.text ?? '')).toEqual({ entries: [], problems: [] })
      expect(gate.readWithdrawals(s.appended[0]?.text ?? '')).toEqual(s.lines())
    })

    it('writes nothing in a dry run, and nothing when it stopped before it changed the server', async () => {
      const dry = server()
      await withdraw({ ...INPUT, dryRun: true }, dry.deps)
      expect(dry.appended).toEqual([])
      expect(dry.said.join('\n')).toContain(`${JOURNAL} is not written in a dry run`)
      const refused = server(published(), { fails: 'ls -1' })
      expect(await withdraw(INPUT, refused.deps)).toMatchObject({ ok: false, offered: 'unchanged' })
      expect(refused.appended).toEqual([])
      const noKey = server(published(), { keyMissing: true })
      await withdraw(INPUT, noKey.deps)
      expect(noKey.appended).toEqual([])
    })

    it('says so when it stopped after it changed the server: a line "partial", with what the channel offers then', async () => {
      const s = server(published(), { fails: 'for F in' })
      expect(await withdraw(INPUT, s.deps)).toMatchObject({ ok: false, offered: 'earlier version', step: 'Set the files of 1.0.2 aside' })
      expect(s.lines()).toEqual([{ at: NOW, type: 'withdrawal', version: BAD, channel: 'stable', outcome: 'partial', offers: 'earlier version', to: '1.0.1' }])
    })

    it('fails, and prints the line to add by hand, when the journal cannot be written: the withdrawal itself is done', async () => {
      const s = server(published(), { journalFails: true })
      const result = await withdraw(INPUT, s.deps)
      expect(result).toMatchObject({ ok: false, step: 'Write the journal', offered: 'earlier version', journalOnly: true })
      const problem = result.ok ? '' : result.problem
      expect(problem).toContain(`${JOURNAL} could not be written (EACCES: permission denied). Add this line to it by hand:`)
      expect(JSON.parse(problem.slice(problem.indexOf('{')))).toEqual({ at: NOW, type: 'withdrawal', version: BAD, channel: 'stable', outcome: 'withdrawn', offers: 'earlier version', to: '1.0.1' })
      expect(offeredBy(s.files)).toBe('1.0.1')
      expect(s.files[`${zip(BAD)}.withdrawn`]).toBe(`zip ${BAD}`)
      if (result.ok) throw new Error('the withdrawal did not fail')
      expect(describeWithdrawFailure(result, INPUT)).toMatch(/^FAILED at "Write the journal": [\s\S]*\nLucium 1\.0\.2 is withdrawn from the channel "stable" and checked online\. Only the journal lacks its line\.$/)
    })

    it('adds the line to the problem when a withdrawal that stopped half way cannot write it either', async () => {
      const s = server(published(), { fails: 'for F in', journalFails: true })
      const result = await withdraw(INPUT, s.deps)
      expect(result).toMatchObject({ ok: false, step: 'Set the files of 1.0.2 aside', offered: 'earlier version' })
      expect(result.ok ? true : result.journalOnly).toBeUndefined()
      const problem = result.ok ? '' : result.problem
      expect(problem).toMatch(/the files of 1\.0\.2 were not all renamed/)
      expect(problem).toContain(`And the journal ${JOURNAL} could not be written (EACCES: permission denied); its line:`)
      expect(JSON.parse(problem.slice(problem.indexOf('{')))).toMatchObject({ type: 'withdrawal', outcome: 'partial', offers: 'earlier version', to: '1.0.1' })
    })
  })

  it('says what the channel offers when it stops', () => {
    const base = { step: 'Put the feed of 1.0.1 back', problem: 'x' }
    expect(describeWithdrawFailure({ ...base, offered: 'unchanged' }, INPUT)).toMatch(/^FAILED at "Put the feed of 1\.0\.1 back": x\nThe feed was not changed: the channel offers what it offered before\. Nothing of 1\.0\.2 was renamed\./)
    expect(describeWithdrawFailure({ ...base, offered: 'earlier version' }, INPUT)).toMatch(/The feed no longer offers 1\.0\.2: it went back to an earlier version\. The files of 1\.0\.2 may still answer: run the command again/)
    expect(describeWithdrawFailure({ ...base, offered: 'nothing' }, INPUT)).toMatch(/The feed was taken away: the channel offers nothing/)
  })
})

describe('scripts/publish-update.mjs --withdraw', () => {
  const script = fileURLToPath(new URL('../../scripts/publish-update.mjs', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'withdraw-update-script-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const config = join(dir, 'channels.json')
  writeFileSync(config, JSON.stringify((SERVERS as { config: unknown }).config))
  // The file of the maintainer's own folder is never read here, nor a real key: both are always given, and the key is one that does not exist.
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, ...args, '--config', config, '--ssh-key', join(dir, 'no-such-key')], {
      encoding: 'utf8',
      timeout: 30_000,
      // The maintainer's own journal is never written here either: the variable names a file of the temporary folder.
      env: { ...process.env, LUCIUM_PUBLISH_CONFIG: join(dir, 'absent.json'), LUCIUM_PUBLISH_JOURNAL: join(dir, 'journal.jsonl') }
    })

  it('refuses a version that is not three numbers, and an archive beside --withdraw, before it looks at the file of the servers', () => {
    const odd = run('--withdraw', 'latest', '--channel', 'stable')
    expect(odd.status).toBe(2)
    expect(odd.stderr).toContain('--withdraw needs a version such as 1.0.1 (got latest)')
    const both = run('--withdraw', BAD, 'dist-drm/a.zip')
    expect(both.status).toBe(2)
    expect(both.stderr).toContain('--withdraw publishes nothing')
  })

  it('refuses a channel that is not in the file of the servers', () => {
    const result = run('--withdraw', BAD)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(`The channel "test" is not in ${config}`)
  })

  it('withdraws instead of publishing: it stops on the key that does not exist, before any command of the server, and looks for no archive', () => {
    const result = run('--withdraw', BAD, '--channel', 'stable')
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Withdrawal of Lucium 1.0.2 from the channel "stable" (https://lucium.app/updates/darwin-arm64/)')
    expect(result.stderr).toMatch(/FAILED at "Check the key": the ssh key .*no-such-key does not exist/)
    expect(result.stderr).toContain('The feed was not changed')
    expect(result.stdout).not.toMatch(/\$ (ssh|scp|curl) /)
    expect(result.stdout).not.toContain('Check the build')
  })

  it('says how to withdraw in its usage', () => {
    const help = run('--help')
    expect(help.status).toBe(0)
    expect(help.stderr).toMatch(/--withdraw <version>/)
    expect(help.stderr).toMatch(/--to <version>\|none/)
    expect(help.stderr).toMatch(/adds one line to the journal, of the type "withdrawal"/)
  })
})

// The feed a withdrawal writes is the feed of the server with one list changed, signed again: only a feed that was signed here is taken as its source.
describe('the signature of the feed a withdrawal writes', () => {
  const refusing: typeof TEST_FEED_KEYS = { sign: () => ({ ok: false, problem: '/secrets/feed-key.pem does not exist' }), signedPart: (text) => TEST_FEED_KEYS.signedPart(text) }

  it('writes a feed the copies believe, whose signed part is the kept feed with its list', async () => {
    const s = server()
    await withdraw(INPUT, s.deps)
    expect(TEST_FEED_KEYS.signedPart(s.files['feed.json'] as string)).toBe(feedWithWithdrawn(unsignedFeedOf('1.0.1'), [BAD]))
    expect(s.said.join('\n')).toMatch(/feed-1\.0\.1\.json was signed by a key of the feed/)
  })

  it('does not go back to a kept feed that nobody signed here, and leaves the server as it is', async () => {
    const s = server({ ...published(), 'feed-1.0.1.json': unsignedFeedOf('1.0.1') })
    const before = { ...s.files }
    const result = await withdraw(INPUT, s.deps)
    expect(result).toMatchObject({ ok: false, step: 'Choose the version the feed goes back to', offered: 'unchanged' })
    expect(result.ok ? '' : result.problem).toMatch(/feed-1\.0\.1\.json carries no signature by a key of the feed.*\n.*--to none/)
    expect(s.files).toEqual(before)
    expect(changes(s.scripts())).toEqual([])
  })

  it('does not go back to a kept feed changed on the server after it was signed', async () => {
    const s = server({ ...published(), 'feed-1.0.1.json': feedOf('1.0.1').replace('"Notes."', '"Other notes."') })
    expect(await withdraw(INPUT, s.deps)).toMatchObject({ ok: false, step: 'Choose the version the feed goes back to' })
    expect(offeredBy(s.files)).toBe(BAD)
  })

  it('does not sign again a feed in place that nobody signed here, when it only adds the version to its list', async () => {
    const s = server({ ...published(), 'feed.json': unsignedFeedOf('1.0.3'), [zip('1.0.3')]: 'zip' })
    const before = { ...s.files }
    const result = await withdraw(INPUT, s.deps)
    expect(result).toMatchObject({ ok: false, step: `List ${BAD} as withdrawn in the feed`, offered: 'unchanged' })
    expect(result.ok ? '' : result.problem).toMatch(/the feed in place carries no signature by a key of the feed, so it is not signed again as it is/)
    expect(s.files).toEqual(before)
  })

  it('stops before the feed is replaced when the key is missing, in a dry run too', async () => {
    for (const dryRun of [false, true]) {
      const s = server(published(), { feedKeys: refusing })
      const result = await withdraw({ ...INPUT, dryRun }, s.deps)
      expect(result).toMatchObject({ ok: false, step: 'Put the feed of 1.0.1 back', offered: 'unchanged' })
      expect(result.ok ? '' : result.problem).toMatch(/the feed is not signed, so the one in place is not replaced:\s+\/secrets\/feed-key\.pem does not exist/)
      expect(offeredBy(s.files)).toBe(BAD)
      expect(s.scripts().filter((script) => script.includes('base64 -d'))).toEqual([])
    }
  })

  it('takes the feed away without any key: nothing is signed then', async () => {
    const s = server(published(), { feedKeys: { sign: () => ({ ok: false, problem: 'no key' }), signedPart: () => null } })
    expect(await withdraw({ ...INPUT, to: NO_FEED }, s.deps)).toMatchObject({ ok: true, offered: 'nothing' })
  })

  it('stops when the web does not answer, byte for byte, the feed that was signed', async () => {
    const s = server()
    const run = s.deps.run
    // The site answers the feed with one space more at its end: still the same JSON, no longer the signed bytes.
    s.deps.run = (command) => {
      const result = run(command)
      return command.program === 'curl' && !command.args.includes('-I') && result.status === 0 ? { ...result, stdout: `${result.stdout} ` } : result
    }
    const result = await withdraw(INPUT, s.deps)
    expect(result).toMatchObject({ ok: false, step: 'Put the feed of 1.0.1 back' })
    expect(result.ok ? '' : result.problem).toMatch(/it is not, byte for byte, the feed that was signed/)
  })
})
