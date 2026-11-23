import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { parseFeed } from '@shared/update-check'
import { INSTALLER_KINDS as SHARED_KINDS } from '@shared/update-target'
import {
  ARCH_WORDS,
  INSTALLER_KINDS,
  KIND_EXTENSIONS,
  MAC_TARGET,
  PUBLIC_CHANNELS,
  baseUrlOf,
  commandLine,
  feedProblems,
  installerFilesOf,
  installerKindOf,
  installerNameProblem,
  makeFeedCommand,
  parsePublishArgs,
  publish,
  resolveChannel,
  resolveInput,
  resolveWithdrawal,
  returnProblems,
  systemOf,
  withdraw,
  withdrawPlan,
  type Channel,
  type ChannelFile,
  type Command,
  type CommandResult,
  type ExpectedRelease,
  type PublishDeps,
  type PublishInput,
  type PublishOptions,
  type WithdrawInput
} from './publish-update'
import * as gate from './release-gate'
import { ARCH_WORDS as FILE_ARCH_WORDS, KIND_EXTENSIONS as FILE_KIND_EXTENSIONS, TARGET_KINDS, releaseFile, releaseProblems, type ReleaseFacts } from './update-feed-file'
import { TEST_FEED_KEYS, signedFeed } from './update-feed-keys.test-support'
import { posix, posixRooted } from './windows.test-support'

// The publication of the installers of Windows and Linux (the study of card 819, lot 1): the same chain as the Mac's, per system. Nothing here
// reaches a network or a server: the commands are planned as text and the steps are run against fake effects. What the Mac says, runs, writes and journals is
// kept apart, to the byte (publish-update-mac-reference.test.ts).
const VERSION = '1.0.2'
const SERVERS: ChannelFile = {
  path: '/cfg/publish-channels.json',
  state: 'read',
  config: {
    test: { host: 'deploy@updates.example', folder: '/srv/updates/test', folders: { 'win32-x64': '/srv/updates/test-win', 'linux-x64-appimage': '/srv/updates/test-linux/appimage', 'linux-x64-deb': '/srv/updates/test-linux/deb', 'linux-arm64-appimage': '/srv/updates/test-linux-arm/appimage' } },
    stable: { host: 'deploy@updates.example', folder: '/srv/updates/stable', folders: { 'win32-x64': '/srv/updates/stable-win', 'linux-x64-appimage': '/srv/updates/stable-linux/appimage', 'linux-x64-deb': '/srv/updates/stable-linux/deb' } }
  }
}
const channelFor = (name: string, target: string): Channel => {
  const choice = resolveChannel(name, SERVERS, PUBLIC_CHANNELS, target)
  if (!choice.ok) throw new Error(choice.message)
  return choice.channel
}
const WIN = 'win32-x64'
const EXE = `Lucium-Setup-${VERSION}-x64.exe`
const APPIMAGE = `Lucium-${VERSION}-linux-x64.AppImage`
const DEB = `Lucium-${VERSION}-linux-amd64.deb`
const HASH = 'a'.repeat(64)
const SIZE = 138_108_571
const COMMIT = '1234567890abcdef1234567890abcdef12345678'
const NOW = new Date('2026-11-12T12:00:00Z')
const STAGING = '/tmp/lucium-publish.Ab3dE5gH7j'
const SSH_KEY = '/home/me/.ssh/id_ed25519'
const done = (stdout = '', status: number | null = 0, stderr = ''): CommandResult => ({ status, stdout, stderr })

const folders: string[] = []
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

describe('the systems of a publication', () => {
  it('are the ones the copies know, with the installers they take (the tables are one)', () => {
    // A Linux feed names one kind (one folder per kind): the publication ids are the shared system ids with the kind, and together they take what the system takes.
    const bySystem: Record<string, string[]> = {}
    for (const [id, kinds] of Object.entries(INSTALLER_KINDS)) (bySystem[systemOf(id)] ??= []).push(...kinds)
    expect(bySystem).toEqual(SHARED_KINDS)
    expect(Object.entries(INSTALLER_KINDS).filter(([, kinds]) => kinds.length !== 1)).toEqual([])
    expect(bySystem).toEqual({ ...TARGET_KINDS, [MAC_TARGET]: ['zip'] })
    expect({ ...FILE_KIND_EXTENSIONS, zip: '.zip' }).toEqual(KIND_EXTENSIONS)
    expect(FILE_ARCH_WORDS).toEqual(ARCH_WORDS)
  })

  it('tell the kind of an installer by its extension, and refuse an extension the system does not take', () => {
    expect(installerKindOf(EXE, WIN)).toEqual({ kind: 'nsis' })
    expect(installerKindOf(APPIMAGE, 'linux-x64-appimage')).toEqual({ kind: 'appimage' })
    expect(installerKindOf(DEB, 'linux-arm64-deb')).toEqual({ kind: 'deb' })
    // One kind per feed: an AppImage is never published into the feed of the .deb, nor the reverse.
    for (const [file, target] of [[EXE, 'linux-x64-appimage'], [APPIMAGE, 'linux-x64-deb'], [DEB, 'linux-x64-appimage'], [APPIMAGE, WIN], [DEB, WIN], [`Lucium-${VERSION}-arm64.zip`, WIN], [`${EXE}.withdrawn`, WIN], ['Lucium.AppImage.exe', 'linux-x64-appimage']] as const) {
      expect(installerKindOf(file, target), `${file} for ${target}`).toMatchObject({ problem: expect.stringContaining('is not an installer of') })
    }
    expect(installerKindOf(EXE, MAC_TARGET)).toMatchObject({ problem: expect.stringContaining('is not a system whose installer is published here') })
    // The system alone is no feed on Linux: the kind is in the id.
    expect(installerKindOf(APPIMAGE, 'linux-x64')).toMatchObject({ problem: expect.stringContaining('is not a system whose installer is published here') })
    expect(installerKindOf(EXE, 'freebsd-x64')).toMatchObject({ problem: expect.any(String) })
  })

  it('want the name of an installer to be plain and to carry its version and the architecture of its system', () => {
    expect(installerNameProblem(EXE, VERSION, WIN)).toBeNull()
    expect(installerNameProblem(APPIMAGE, VERSION, 'linux-x64-appimage')).toBeNull()
    expect(installerNameProblem(DEB, VERSION, 'linux-x64-deb')).toBeNull()
    expect(installerNameProblem(`Lucium-${VERSION}-linux-arm64.deb`, VERSION, 'linux-arm64-deb')).toBeNull()
    expect(installerNameProblem('Lucium-Setup-1.0.1-x64.exe', VERSION, WIN)).toMatch(/not named for 1\.0\.2/)
    expect(installerNameProblem(`Lucium-Setup-${VERSION}-arm64.exe`, VERSION, WIN)).toMatch(/does not carry the architecture of win32-x64/)
    expect(installerNameProblem(`Lucium-${VERSION}-linux-arm64.AppImage`, VERSION, 'linux-x64-appimage')).toMatch(/does not carry the architecture/)
    expect(installerNameProblem(`Lucium Setup-${VERSION}-x64.exe`, VERSION, WIN)).toMatch(/must be plain/)
    expect(installerNameProblem(`Lucium-Setup-${VERSION}-x64.exe; rm`, VERSION, WIN)).toMatch(/must be plain/)
  })

  it('give the installers their own https folder beside the Mac’s, and leave the Mac’s as it is', () => {
    expect(baseUrlOf('https://test.lucium.app/updates/darwin-arm64/', MAC_TARGET)).toBe('https://test.lucium.app/updates/darwin-arm64/')
    expect(baseUrlOf('https://test.lucium.app/updates/darwin-arm64/', WIN)).toBe('https://test.lucium.app/updates/win32-x64/')
    expect(baseUrlOf('https://lucium.app/updates/darwin-arm64/', 'linux-arm64-appimage')).toBe('https://lucium.app/updates/linux-arm64/appimage/')
    expect(baseUrlOf('https://lucium.app/updates/darwin-arm64/', 'linux-x64-deb')).toBe('https://lucium.app/updates/linux-x64/deb/')
    expect(baseUrlOf('https://elsewhere.example/feed/', WIN)).toBeNull()
  })
})

describe('the channels of the installers', () => {
  it('take the folder of the system from the file of the servers and the address from the repository; the Mac keeps "folder"', () => {
    expect(channelFor('test', WIN)).toEqual({ host: 'deploy@updates.example', folder: '/srv/updates/test-win', baseUrl: 'https://test.lucium.app/updates/win32-x64/' })
    expect(channelFor('stable', WIN)).toEqual({ host: 'deploy@updates.example', folder: '/srv/updates/stable-win', baseUrl: 'https://lucium.app/updates/win32-x64/' })
    expect(channelFor('test', 'linux-arm64-appimage')).toMatchObject({ folder: '/srv/updates/test-linux-arm/appimage', baseUrl: 'https://test.lucium.app/updates/linux-arm64/appimage/' })
    // An AppImage and a .deb of one system do not share a folder: one feed names one kind, so neither replaces the other's.
    expect(channelFor('test', 'linux-x64-appimage').folder).not.toBe(channelFor('test', 'linux-x64-deb').folder)
    expect(channelFor('test', 'linux-x64-appimage').baseUrl).not.toBe(channelFor('test', 'linux-x64-deb').baseUrl)
    expect(channelFor('test', MAC_TARGET)).toEqual({ host: 'deploy@updates.example', folder: '/srv/updates/test', baseUrl: 'https://test.lucium.app/updates/darwin-arm64/' })
  })

  it('never guess the folder of a system from the Mac’s: a system without its entry is refused, and says which', () => {
    expect(resolveChannel('stable', SERVERS, PUBLIC_CHANNELS, 'linux-arm64-appimage')).toMatchObject({ ok: false, message: expect.stringContaining('"folders.linux-arm64-appimage" is missing') })
    const withoutAny = resolveChannel('test', { path: '/c', state: 'read', config: { test: { host: 'deploy@updates.example', folder: '/srv/updates/test' } } }, PUBLIC_CHANNELS, WIN)
    expect(withoutAny).toMatchObject({ ok: false, message: expect.stringContaining('"folders.win32-x64" is missing') })
  })

  it('refuse a "folders" that is not one folder per system, and a folder that could change the command it ends up in', () => {
    const refuse = (folders: unknown, target = WIN): string => {
      const choice = resolveChannel('test', { path: '/c', state: 'read', config: { test: { host: 'deploy@updates.example', folder: '/srv/updates/test', folders } } }, PUBLIC_CHANNELS, target)
      return choice.ok ? 'accepted' : choice.message
    }
    expect(refuse([1])).toMatch(/"folders" must be an object/)
    expect(refuse({ 'win32-x64': 4 })).toMatch(/"folders.win32-x64" must be a string/)
    expect(refuse({ 'freebsd-x64': '/srv/x', 'win32-x64': '/srv/w' })).toMatch(/"folders.freebsd-x64" is not a system/)
    expect(refuse({ 'darwin-arm64': '/srv/x', 'win32-x64': '/srv/w' })).toMatch(/"folders.darwin-arm64" is not a system/)
    expect(refuse({ 'win32-x64': '/srv/a b; rm' })).toMatch(/the folder must be an absolute path of plain characters/)
    expect(refuse({ 'win32-x64': '/srv/../etc' })).toMatch(/plain characters/)
  })

  it('refuse a channel whose address is not the Mac’s folder, since the address of another system is made from it', () => {
    const choice = resolveChannel('test', SERVERS, { test: { baseUrl: 'https://elsewhere.example/feed/' } }, WIN)
    expect(choice).toMatchObject({ ok: false, message: expect.stringContaining('cannot be made from it') })
  })
})

describe('the arguments of an installer', () => {
  const parse = (...args: string[]): PublishOptions => {
    const parsed = parsePublishArgs(args)
    if (!parsed.ok) throw new Error(parsed.message)
    return parsed.options
  }
  const env = { cwd: '/work', root: '/repo', home: '/home/me', version: VERSION, servers: SERVERS }

  it('read --platform and --sha256, and refuse a system that has no installer here (the Mac is published without the option)', () => {
    expect(parse(EXE, '--platform', WIN, '--sha256', HASH)).toMatchObject({ archive: EXE, platform: WIN, sha256: HASH })
    expect(parsePublishArgs(['--platform', MAC_TARGET])).toMatchObject({ ok: false, message: expect.stringContaining('the Mac is published without it') })
    expect(parsePublishArgs(['--platform', 'freebsd-x64'])).toMatchObject({ ok: false, message: expect.stringContaining('--platform is one of') })
    expect(parse().platform).toBeNull()
  })

  it('refuse the options of the Mac’s build with --platform, instead of ignoring them', () => {
    for (const flag of ['--app', '--installed-app', '--build-log', '--build-record']) {
      expect(parsePublishArgs([EXE, '--platform', WIN, flag, '/x']), flag).toMatchObject({ ok: false, message: expect.stringContaining(`${flag} is an option of the Mac's build`) })
    }
    expect(parsePublishArgs([EXE, '--platform', WIN, '--no-dmg'])).toMatchObject({ ok: false, message: expect.stringContaining('--no-dmg is an option of the Mac') })
  })

  it('refuse --sha256 without --platform (the sum of the Mac’s archive is the build record’s) and with --withdraw', () => {
    expect(parsePublishArgs(['--sha256', HASH])).toMatchObject({ ok: false, message: expect.stringContaining('--sha256 only goes with --platform') })
    expect(parsePublishArgs(['--withdraw', '1.0.1', '--platform', WIN, '--sha256', HASH])).toMatchObject({ ok: false, message: expect.stringContaining('--sha256 is an option of the publication') })
    expect(parsePublishArgs(['--withdraw', '1.0.1', '--platform', WIN])).toMatchObject({ ok: true })
  })

  it('refuse an installer without the sum of the CI run, or with a sum that is not 64 lowercase hexadecimal digits', () => {
    expect(resolveInput(parse(EXE, '--platform', WIN), env)).toMatchObject({ ok: false, message: expect.stringContaining('needs --sha256') })
    for (const sum of ['abc', 'A'.repeat(64), `${HASH}0`, 'g'.repeat(64)]) {
      expect(resolveInput(parse(EXE, '--platform', WIN, '--sha256', sum), env), sum).toMatchObject({ ok: false, message: expect.stringContaining('64 lowercase hexadecimal digits') })
    }
  })

  it('refuse an installer that is not named, and one with the extension of another system', () => {
    expect(resolveInput(parse('--platform', WIN, '--sha256', HASH), env)).toMatchObject({ ok: false, message: expect.stringContaining('name its file') })
    expect(resolveInput(parse(APPIMAGE, '--platform', WIN, '--sha256', HASH), env)).toMatchObject({ ok: false, message: expect.stringContaining('is not an installer of win32-x64') })
    expect(resolveInput(parse(EXE, '--platform', 'linux-x64-appimage', '--sha256', HASH), env)).toMatchObject({ ok: false, message: expect.stringContaining('is not an installer of linux-x64-appimage') })
    expect(resolveInput(parse(DEB, '--platform', 'linux-x64-appimage', '--sha256', HASH), env)).toMatchObject({ ok: false, message: expect.stringContaining('is not an installer of linux-x64-appimage') })
    // The system alone no longer names a feed on Linux: the kind is part of it.
    expect(parsePublishArgs([APPIMAGE, '--platform', 'linux-x64', '--sha256', HASH])).toMatchObject({ ok: false })
  })

  it('resolve the input of an installer: its kind from its extension, the channel of its system, an attestation of its own beside it', () => {
    const resolved = resolveInput(parse(`dist/${EXE}`, '--platform', WIN, '--sha256', HASH, '--channel', 'stable'), env)
    expect(resolved).toMatchObject({ ok: true })
    if (!resolved.ok) return
    expect(resolved.input).toMatchObject({
      channelName: 'stable',
      channel: { folder: '/srv/updates/stable-win', baseUrl: 'https://lucium.app/updates/win32-x64/' },
      target: { id: WIN, kind: 'nsis', sha256: HASH },
      dmg: false
    })
    expect(posixRooted(resolved.input.archive)).toBe(`/work/dist/${EXE}`)
    expect(posixRooted(resolved.input.attestation)).toBe(`/work/dist/Lucium-${VERSION}-win32-x64.attestation.json`)
  })

  it('compares a resolved path with the text of the test whatever the drive Windows puts before it', () => {
    expect(posixRooted('D:/work/dist/a.exe')).toBe('/work/dist/a.exe')
    expect(posixRooted('/work/dist/a.exe')).toBe('/work/dist/a.exe')
    expect(posixRooted('/work/D:/a')).toBe('/work/D:/a')
  })
  it('resolve the withdrawal of a system on the channel of that system', () => {
    const resolved = resolveWithdrawal(parse('--withdraw', '1.0.1', '--platform', 'linux-arm64-appimage'), env)
    expect(resolved).toMatchObject({ ok: true, input: { target: 'linux-arm64-appimage', channel: { folder: '/srv/updates/test-linux-arm/appimage', baseUrl: 'https://test.lucium.app/updates/linux-arm64/appimage/' } } })
    const mac = resolveWithdrawal(parse('--withdraw', '1.0.1'), env)
    expect(mac).toMatchObject({ ok: true, input: { channel: { folder: '/srv/updates/test' } } })
    expect(mac.ok && 'target' in mac.input).toBe(false)
  })
})

describe('the feed of an installer', () => {
  const facts = (over: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
    version: VERSION,
    base: 'https://test.lucium.app/updates/win32-x64/',
    fileName: EXE,
    sha256: HASH,
    size: SIZE,
    date: new Date('2026-11-10T09:00:00Z'),
    notes: 'Notes.',
    target: { platform: 'win32', arch: 'x64', kind: 'nsis' },
    ...over
  })

  it('says which system it is for, in its head, and is read by a copy of that system and by no other', () => {
    const file = JSON.parse(JSON.stringify(releaseFile(facts()))) as Record<string, unknown>
    expect(Object.keys(file).slice(0, 4)).toEqual(['currentRelease', 'platform', 'arch', 'kind'])
    expect(file).toMatchObject({ platform: 'win32', arch: 'x64', kind: 'nsis' })
    expect(parseFeed(file, { platform: 'win32', arch: 'x64' })).toMatchObject({ version: VERSION, archive: `https://test.lucium.app/updates/win32-x64/${EXE}`, sha256: HASH, size: SIZE })
    expect(parseFeed(file, { platform: 'darwin', arch: 'arm64' })).toBeNull()
    expect(parseFeed(file, { platform: 'linux', arch: 'x64' })).toBeNull()
  })

  it('names an AppImage or a .deb for Linux, and keeps the Mac’s file without any of the three keys', () => {
    expect(releaseFile(facts({ fileName: APPIMAGE, target: { platform: 'linux', arch: 'x64', kind: 'appimage' } }))).toMatchObject({ platform: 'linux', arch: 'x64', kind: 'appimage' })
    expect(releaseFile(facts({ fileName: DEB, target: { platform: 'linux', arch: 'x64', kind: 'deb' } }))).toMatchObject({ kind: 'deb' })
    const mac = releaseFile({ ...facts({ fileName: `Lucium-${VERSION}-arm64.zip`, base: 'https://test.lucium.app/updates/darwin-arm64/' }), target: undefined })
    expect(Object.keys(mac)).toEqual(['currentRelease', 'page', 'en', 'releases'])
  })

  it('refuses a system with no build, a kind the system does not take, an extension that says otherwise, another version and another architecture', () => {
    const problem = (over: Partial<ReleaseFacts>): string => releaseProblems(facts(over)).join(' | ')
    expect(problem({ target: { platform: 'darwin', arch: 'arm64', kind: 'zip' } })).toMatch(/no installer is published for "darwin-arm64"/)
    expect(problem({ target: { platform: 'win32', arch: 'arm64', kind: 'nsis' } })).toMatch(/no installer is published/)
    expect(problem({ target: { platform: 'win32', arch: 'x64', kind: 'deb' } })).toMatch(/does not take an installer of the kind "deb"/)
    expect(problem({ fileName: APPIMAGE })).toMatch(/must be a \.exe/)
    expect(problem({ fileName: 'Lucium-Setup-1.0.1-x64.exe' })).toMatch(/does not carry its version 1\.0\.2/)
    expect(problem({ fileName: `Lucium-Setup-${VERSION}-arm64.exe` })).toMatch(/does not carry the architecture x64/)
    expect(problem({ fileName: `Lucium Setup-${VERSION}-x64.exe` })).toMatch(/must be a \.exe with a plain name/)
    expect(problem({ sha256: '' })).toMatch(/SHA-256/)
    expect(problem({})).toBe('')
    expect(() => releaseFile(facts({ target: { platform: 'linux', arch: 'x64', kind: 'nsis' } }))).toThrow(/does not take an installer/)
  })

  it('is written by scripts/make-update-feed.mjs from the installer, for the system it is given, and refuses an installer that is not one of that system', () => {
    const folder = mkdtempSync(join(tmpdir(), 'lucium-installer-feed-'))
    folders.push(folder)
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string }
    const file = join(folder, `Lucium-Setup-${pkg.version}-x64.exe`)
    writeFileSync(file, 'an installer')
    const script = fileURLToPath(new URL('../../scripts/make-update-feed.mjs', import.meta.url))
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    const written = run(file, 'https://test.lucium.app/updates/win32-x64/', '--target', WIN, '--kind', 'nsis', '--date', '2026-11-10T09:00:00Z')
    expect(written.status, written.stderr).toBe(0)
    const feed = JSON.parse(written.stdout) as { currentRelease: string; releases: Array<{ updateTo: { url: string; size: number } }> }
    expect(feed).toMatchObject({ currentRelease: pkg.version, platform: 'win32', arch: 'x64', kind: 'nsis' })
    expect(feed.releases[0]?.updateTo).toMatchObject({ url: `https://test.lucium.app/updates/win32-x64/Lucium-Setup-${pkg.version}-x64.exe`, size: 12 })
    // The kind is the extension's unless it is given; the system must take it.
    expect(run(file, 'https://test.lucium.app/updates/win32-x64/', '--target', WIN).status).toBe(0)
    expect(run(file, 'https://test.lucium.app/updates/linux-x64/', '--target', 'linux-x64')).toMatchObject({ status: 1, stderr: expect.stringContaining('does not take an installer') })
    expect(run(file, 'https://test.lucium.app/updates/win32-x64/', '--target', 'darwin-arm64')).toMatchObject({ status: 1, stderr: expect.stringContaining('--target is win32-x64') })
    expect(run(file, 'https://test.lucium.app/updates/win32-x64/', '--kind', 'nsis')).toMatchObject({ status: 2, stderr: expect.stringContaining('--kind only goes with --target') })
  }, 30_000)

  it('is asked of the script with the system and the kind, and only then (the Mac’s command is as it was)', () => {
    expect(makeFeedCommand('/repo', '/x/a', 'https://h/u/').args.slice(1)).toEqual(['/x/a', 'https://h/u/'])
    expect(makeFeedCommand('/repo', '/x/a', 'https://h/u/', { id: WIN, kind: 'nsis' }).args.slice(1)).toEqual(['/x/a', 'https://h/u/', '--target', WIN, '--kind', 'nsis'])
    expect(commandLine(makeFeedCommand('/repo', `/x/${EXE}`, 'https://h/u/', { id: WIN, kind: 'nsis' }))).toContain('--target win32-x64 --kind nsis')
    // A Linux feed id is the system and the kind; the feed it writes says the system (`platform`, `arch`) and the kind apart.
    expect(makeFeedCommand('/repo', `/x/${DEB}`, 'https://h/u/', { id: 'linux-x64-deb', kind: 'deb' }).args.slice(1)).toEqual([`/x/${DEB}`, 'https://h/u/', '--target', 'linux-x64', '--kind', 'deb'])
  })

  it('is checked online for the three words, not only for the installer: a feed that names the right file under the wrong system is not the one that was published', () => {
    const want: ExpectedRelease = { version: VERSION, url: `https://test.lucium.app/updates/win32-x64/${EXE}`, sha256: HASH, size: SIZE, target: { platform: 'win32', arch: 'x64', kind: 'nsis' } }
    const text = (over: Record<string, unknown> = {}): string =>
      JSON.stringify({ currentRelease: VERSION, platform: 'win32', arch: 'x64', kind: 'nsis', releases: [{ version: VERSION, updateTo: { version: VERSION, url: want.url, sha256: HASH, size: SIZE } }], ...over })
    expect(feedProblems(text(), want)).toEqual([])
    expect(feedProblems(text({ platform: 'linux' }), want)).toEqual(['platform is "linux", expected "win32"'])
    expect(feedProblems(text({ arch: 'arm64' }), want)).toEqual(['arch is "arm64", expected "x64"'])
    expect(feedProblems(text({ kind: 'deb' }), want)).toEqual(['kind is "deb", expected "nsis"'])
    expect(feedProblems(text({ platform: undefined }), want)).toEqual(['platform is undefined, expected "win32"'])
    // The Mac's feed is checked as it always was: nothing is said of words it does not carry.
    expect(feedProblems(text({ platform: undefined, arch: undefined, kind: undefined }), { ...want, target: undefined })).toEqual([])
  })
})

describe('the withdrawal of an installer: what the folder holds', () => {
  it('finds the installers of the version and of the system in the listing, and nothing else', () => {
    const listing = [EXE, 'Lucium-Setup-1.0.1-x64.exe', `${EXE}.withdrawn`, `Lucium-${VERSION}-arm64.zip`, 'feed.json', `feed-${VERSION}.json`, APPIMAGE, `Lucium-Setup-${VERSION}-arm64.exe`, '', '.Lucium.part'].join('\n')
    expect(installerFilesOf(listing, VERSION, WIN)).toEqual([EXE])
    expect(installerFilesOf(listing, VERSION, 'linux-x64-appimage')).toEqual([APPIMAGE])
    expect(installerFilesOf(`${listing}\n${DEB}`, VERSION, 'linux-x64-deb')).toEqual([DEB])
    expect(installerFilesOf(listing, '9.9.9', WIN)).toEqual([])
  })

  it('sets aside the installers it was given and the kept feed, and asks the web whether they answer 404; the Mac’s plan is made from the version alone', () => {
    const plan = withdrawPlan({ version: VERSION, channel: channelFor('test', WIN), sshKey: '/k', installers: [EXE] })
    const script = plan.setAsideFiles.args.at(-1) ?? ''
    expect(script).toContain(`for F in ${EXE} feed-${VERSION}.json;`)
    expect(script).not.toContain('.dmg')
    expect(plan.withdrawnUrls).toEqual([`https://test.lucium.app/updates/win32-x64/${EXE}`])
    const mac = withdrawPlan({ version: VERSION, channel: channelFor('test', MAC_TARGET), sshKey: '/k' })
    expect(mac.setAsideFiles.args.at(-1)).toContain(`Lucium-${VERSION}-arm64.zip Lucium-${VERSION}-arm64.dmg Lucium-${VERSION}-arm64.dmg.sha256 feed-${VERSION}.json`)
  })

  it('weighs the file the kept feed names, not one made up from the version', () => {
    const plan = withdrawPlan({ version: '1.0.2', channel: channelFor('test', WIN), sshKey: '/k' })
    const target = plan.target('1.0.1', 'Lucium-Setup-1.0.1-x64.exe')
    expect(target.archiveUrl).toBe('https://test.lucium.app/updates/win32-x64/Lucium-Setup-1.0.1-x64.exe')
    expect(target.weighArchive.args.at(-1)).toContain('sha256sum $D/Lucium-Setup-1.0.1-x64.exe && sudo -n cat $D/Lucium-Setup-1.0.1-x64.exe | wc -c')
  })

  it('goes back only to a kept feed that names the installer of that version and of that system, in the folder of the channel', () => {
    const channel = channelFor('test', WIN)
    const kept = (url: string): ExpectedRelease => ({ version: '1.0.1', url, sha256: HASH, size: SIZE })
    expect(returnProblems(kept('https://test.lucium.app/updates/win32-x64/Lucium-Setup-1.0.1-x64.exe'), '1.0.1', '1.0.2', channel, WIN)).toEqual([])
    expect(returnProblems(kept('https://test.lucium.app/updates/win32-x64/Lucium-Setup-1.0.0-x64.exe'), '1.0.1', '1.0.2', channel, WIN).join('|')).toMatch(/not the one of 1\.0\.1 for win32-x64/)
    expect(returnProblems(kept('https://test.lucium.app/updates/win32-x64/Lucium-1.0.1-linux-x64.AppImage'), '1.0.1', '1.0.2', channel, WIN).join('|')).toMatch(/is not an installer of win32-x64/)
    expect(returnProblems(kept('https://lucium.app/updates/win32-x64/Lucium-Setup-1.0.1-x64.exe'), '1.0.1', '1.0.2', channel, WIN).join('|')).toMatch(/names https:\/\/lucium\.app/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The steps, run against fake effects

interface World {
  results?: Partial<Record<Kind, CommandResult>>
  journal?: string
  attestation?: string | null
  weight?: { sha256: string; size: number }
  missing?: string[]
  changelog?: string
  engineRun?: string
}

type Kind = 'git-tag' | 'git-tag-verify' | 'make-feed' | 'make-staging' | 'scp' | 'remote-hash' | 'install-archive' | 'download-archive' | 'read-feed' | 'keep-feed' | 'install-feed' | 'fetch-feed' | 'cleanup' | 'other'

function kindOf(command: Command): Kind {
  const script = command.args.at(-1) ?? ''
  if (command.program === 'git') return command.args.includes('rev-parse') ? 'git-tag' : 'git-tag-verify'
  if (command.program === 'node') return 'make-feed'
  if (command.program === 'scp') return 'scp'
  if (script.includes('mktemp -d')) return 'make-staging'
  if (command.program === 'curl') return /\.(exe|AppImage|deb)$/.test(script) ? 'download-archive' : 'fetch-feed'
  if (script.startsWith('sha256sum')) return 'remote-hash'
  if (script.startsWith('rm -rf -- ')) return 'cleanup'
  if (script.includes('then sudo -n cat $D/feed.json')) return 'read-feed'
  if (script.includes('cp -p $D/feed.json')) return 'keep-feed'
  if (script.includes('feed.json')) return 'install-feed'
  return /\.(exe|AppImage|deb)/.test(script) ? 'install-archive' : 'other'
}

function installerInput(over: Partial<PublishInput> = {}, target: string = WIN, file: string = EXE, kind: string = 'nsis'): PublishInput {
  return {
    version: VERSION,
    root: '/repo',
    archive: `/installers/${file}`,
    app: '',
    installedApp: '',
    buildLog: null,
    channelName: 'test',
    channel: channelFor('test', target),
    sshKey: SSH_KEY,
    dmg: false,
    dryRun: false,
    journal: '/outside/publish-journal.jsonl',
    buildRecord: '',
    engineRun: '/repo/out-engine/release-run.json',
    noEngineRun: null,
    attestation: `/installers/Lucium-${VERSION}-${target}.attestation.json`,
    minTestHours: 24,
    securityFix: null,
    target: { id: target, kind, sha256: HASH },
    ...over
  }
}

const CHANGELOG = `# Changelog\n\n## [${VERSION}] - 2026-11-10\n\n### Fixed\n\n- **A thing**: fixed.\n\n## [1.0.1] - 2026-11-07\n`
const ENGINE_RUN: gate.EngineRunRecord = { commit: COMMIT, clean: true, startedAt: '2026-11-10T06:00:00.000Z', endedAt: '2026-11-10T07:10:00.000Z', steps: { engine: 1, compare: 0, webstore: 0, extwindows: 0 }, reportSha256: 'd'.repeat(64) }
const entryOn = (target: string | undefined, over: Partial<gate.JournalEntry> = {}): gate.JournalEntry => ({
  at: '2026-11-10T10:00:00.000Z',
  version: VERSION,
  channel: 'test',
  outcome: 'published',
  holds: 'everything',
  commit: COMMIT,
  archive: { name: EXE, sha256: HASH, size: SIZE },
  dmg: null,
  tag: null,
  engineRun: { endedAt: ENGINE_RUN.endedAt, reportSha256: ENGINE_RUN.reportSha256 },
  ...(target ? { platform: target, kind: 'nsis' } : {}),
  ...over
})
const ATTESTATION = { version: VERSION, platform: WIN, archiveSha256: HASH, attestedBy: 'The maintainer', attestedAt: '2026-11-11T18:30:00Z', checks: { installsOnARealMachine: true, updateFromPreviousVersion: true }, updatedFrom: '1.0.1' }

/** The feed the script would print for this installer: the real writer, with the system it was asked for. */
const feedOf = (target: string, file: string, kind: string, base: string, sha = HASH, version = VERSION): string => {
  const [platform = '', arch = ''] = target.split('-')
  return `${JSON.stringify(releaseFile({ version, base, fileName: file, sha256: sha, size: SIZE, date: new Date('2026-11-10T09:00:00Z'), notes: 'Notes.', target: { platform, arch, kind } }), null, 2)}\n`
}

function world(change: World = {}, target: string = WIN, file: string = EXE, kind: string = 'nsis', channelName: string = 'test') {
  const ran: Command[] = []
  const said: string[] = []
  const written: Record<string, string> = {}
  const appended: string[] = []
  const channel = channelFor(channelName, target)
  const feed = feedOf(target, file, kind, channel.baseUrl)
  const archive = `/installers/${file}`
  const conditions: Record<string, string | null> = {
    '/repo/out-engine/release-run.json': change.engineRun ?? JSON.stringify(ENGINE_RUN),
    '/repo/CHANGELOG.md': change.changelog ?? CHANGELOG,
    '/repo/CHANGELOG.fr.md': change.changelog ?? CHANGELOG,
    '/outside/publish-journal.jsonl': change.journal ?? gate.journalLine(entryOn(target, { archive: { name: file, sha256: HASH, size: SIZE } })),
    [`/installers/Lucium-${VERSION}-${target}.attestation.json`]: change.attestation === undefined ? JSON.stringify({ ...ATTESTATION, platform: target }) : change.attestation
  }
  const missing = new Set([...(change.missing ?? []), ...Object.keys(conditions).filter((path) => conditions[path] === null)])
  const defaults: Record<Kind, CommandResult> = {
    'git-tag': done(`${COMMIT}\n`),
    'git-tag-verify': done('', 1, 'error: no signature found'),
    'make-feed': done(feed),
    'make-staging': done(`${STAGING}\n`),
    scp: done(),
    'remote-hash': done(`${HASH}  ${STAGING}/${file}\n`),
    'install-archive': done(),
    'download-archive': done(),
    'read-feed': done(''),
    'keep-feed': done(),
    'install-feed': done(),
    'fetch-feed': done(signedFeed(feed)),
    cleanup: done(),
    other: done()
  }
  const deps: PublishDeps = {
    say: (line) => said.push(line),
    exists: (path) => !missing.has(posix(path)),
    readText: (path) => {
      const text = conditions[posix(path)]
      if (typeof text === 'string') return text
      throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' })
    },
    writeText: (path, text) => {
      written[posix(path)] = text
    },
    appendText: (_path, text) => {
      appended.push(text)
    },
    now: () => NOW,
    gate,
    feedKeys: TEST_FEED_KEYS,
    run: (command) => {
      ran.push(command)
      return { ...defaults[kindOf(command)], ...change.results?.[kindOf(command)] }
    },
    hashOutput: async (command) => {
      ran.push(command)
      return { status: 0, sha256: HASH, size: SIZE, stderr: '' }
    },
    sha256File: async (path) => (posix(path) === archive ? (change.weight ?? { sha256: HASH, size: SIZE }) : Promise.reject(new Error(`the publication of an installer read ${path}`))),
    readFuseWire: async () => {
      throw new Error('the fuses of an installer are not read')
    }
  }
  return { deps, ran, said, written, appended, kinds: () => ran.map(kindOf), journal: () => appended.map((line) => JSON.parse(line) as gate.JournalEntry) }
}

const NETWORK = ['ssh', 'scp', 'curl']
const FULL_RUN: Kind[] = ['git-tag', 'git-tag-verify', 'make-feed', 'read-feed', 'make-staging', 'scp', 'remote-hash', 'install-archive', 'download-archive', 'read-feed', 'install-feed', 'fetch-feed', 'cleanup']

describe('the publication of an installer', () => {
  it('runs the steps of the Mac’s publication without what is the Mac’s: no ticket, no fuses, no executable, no disk image', async () => {
    const w = world()
    expect(await publish(installerInput(), w.deps)).toEqual({ ok: true, dryRun: false })
    expect(w.kinds()).toEqual(FULL_RUN)
    for (const program of ['xcrun', '/usr/bin/unzip', '/usr/bin/plutil', '/usr/bin/zipinfo']) expect(w.ran.map((command) => command.program)).not.toContain(program)
    expect(w.said.at(-1)).toMatch(/Lucium 1\.0\.2 is published on the channel "test"/)
    expect(w.said[0]).toContain('for win32-x64')
  })

  it('asks the script for the feed of that system, and publishes into the folder and the address of that system', async () => {
    const w = world()
    await publish(installerInput(), w.deps)
    const makeFeed = w.ran.find((command) => kindOf(command) === 'make-feed') as Command
    expect(makeFeed.args.slice(2)).toEqual(['https://test.lucium.app/updates/win32-x64/', '--target', WIN, '--kind', 'nsis'])
    const scripts = w.ran.filter((command) => command.program === 'ssh').map((command) => command.args.at(-1) ?? '')
    expect(scripts.some((script) => script.includes('/srv/updates/test-win'))).toBe(true)
    expect(scripts.some((script) => script.includes('/srv/updates/test '))).toBe(false)
    expect(w.ran.filter((command) => command.program === 'curl').every((command) => (command.args.at(-1) ?? '').startsWith('https://test.lucium.app/updates/win32-x64/'))).toBe(true)
  })

  it('writes, signs and publishes a feed that a copy of that system reads and a copy of another does not', async () => {
    const w = world()
    await publish(installerInput(), w.deps)
    const file = JSON.parse(Object.values(w.written)[0] as string) as Record<string, unknown>
    expect(file).toMatchObject({ platform: 'win32', arch: 'x64', kind: 'nsis' })
    expect(Array.isArray(file['signatures'])).toBe(true)
    expect(parseFeed(file, { platform: 'win32', arch: 'x64' })).toMatchObject({ version: VERSION, sha256: HASH, size: SIZE })
    expect(parseFeed(file, { platform: 'darwin', arch: 'arm64' })).toBeNull()
  })

  it('journals the system and the kind, beside the installer’s name, sum and size, and the tag it was built on', async () => {
    const w = world()
    await publish(installerInput(), w.deps)
    expect(w.journal()).toEqual([
      expect.objectContaining({ version: VERSION, channel: 'test', outcome: 'published', platform: WIN, kind: 'nsis', commit: COMMIT, archive: { name: EXE, sha256: HASH, size: SIZE }, dmg: null, tag: { name: `v${VERSION}`, signatureVerified: false } })
    ])
  })

  it('runs nothing that touches the network or the server in a dry run, writes nothing, and prints every command', async () => {
    const w = world()
    expect(await publish(installerInput({ dryRun: true }), w.deps)).toEqual({ ok: true, dryRun: true })
    expect(w.kinds()).toEqual(['git-tag', 'git-tag-verify', 'make-feed'])
    expect(w.ran.filter((command) => NETWORK.includes(command.program))).toEqual([])
    expect(w.written).toEqual({})
    expect(w.appended).toEqual([])
    const printed = w.said.join('\n')
    expect(printed).toContain('(dry run: not run)')
    expect(printed).toContain('/srv/updates/test-win')
    expect(printed).toMatch(/Dry run done: nothing was sent to the server and nothing was written/)
  })

  it('publishes an AppImage and a .deb for their own system and folder', async () => {
    for (const [file, kind, target] of [[APPIMAGE, 'appimage', 'linux-x64-appimage'], [DEB, 'deb', 'linux-x64-deb'], [`Lucium-${VERSION}-linux-arm64.AppImage`, 'appimage', 'linux-arm64-appimage']] as const) {
      const w = world({}, target, file, kind)
      expect(await publish(installerInput({}, target, file, kind), w.deps), file).toEqual({ ok: true, dryRun: false })
      expect(JSON.parse(Object.values(w.written)[0] as string), file).toMatchObject({ platform: 'linux', arch: target.split('-')[1], kind })
      // The folder of its own kind: the file goes where only a feed of that kind lives.
      expect(w.said.join('\n'), file).toContain(`/${kind}`)
    }
  })

  describe('stops before anything is sent when the installer is not the one to publish', () => {
    const cases: Array<[string, World, Partial<PublishInput>, RegExp]> = [
      ['the file is missing', { missing: [`/installers/${EXE}`] }, {}, /does not exist: it is the installer that CI built/],
      ['the extension is another system’s', {}, { archive: `/installers/${APPIMAGE}` }, /is not an installer of win32-x64/],
      ['the kind given is not the extension’s', {}, { target: { id: WIN, kind: 'deb', sha256: HASH } }, /the installer is a nsis and the publication says deb/],
      ['the name is of another version', {}, { archive: '/installers/Lucium-Setup-1.0.1-x64.exe' }, /not named for 1\.0\.2/],
      ['the name is of another architecture', {}, { archive: `/installers/Lucium-Setup-${VERSION}-arm64.exe` }, /does not carry the architecture of win32-x64/],
      ['there is no sum of the CI run', {}, { target: { id: WIN, kind: 'nsis', sha256: '' } }, /no SHA-256 of the CI run/],
      ['the sum is not 64 lowercase hexadecimal digits', {}, { target: { id: WIN, kind: 'nsis', sha256: 'AB'.repeat(32) } }, /no SHA-256 of the CI run/],
      ['the file is not the one of the CI run', { weight: { sha256: 'b'.repeat(64), size: SIZE } }, {}, /not the file of that run/],
      ['the version has no tag', { results: { 'git-tag': done('', 1) } }, {}, /no tag v1\.0\.2/],
      ['Git cannot be asked for the tag', { results: { 'git-tag': done('', 128, 'fatal: not a repository') } }, {}, /cannot ask Git for the tag/],
      ['Git names no commit', { results: { 'git-tag': done('not-a-commit\n') } }, {}, /not a commit/],
      ['the changelog has no date', { changelog: CHANGELOG.replace(' - 2026-11-10', ' - Unreleased') }, {}, /Unreleased/]
    ]
    for (const [name, change, input, message] of cases) {
      it(name, async () => {
        const w = world(change)
        const result = await publish(installerInput(input), w.deps)
        expect(result).toMatchObject({ ok: false, published: 'nothing', problem: expect.stringMatching(message) })
        expect(w.ran.filter((command) => NETWORK.includes(command.program))).toEqual([])
        expect(w.written).toEqual({})
        expect(w.appended).toEqual([])
      })
    }

    it('refuses an installer whose engine run is of another commit, as it does the Mac’s', async () => {
      const w = world({ engineRun: JSON.stringify({ ...ENGINE_RUN, commit: 'f'.repeat(40) }) })
      expect(await publish(installerInput(), w.deps)).toMatchObject({ ok: false, step: 'Check the engine suites', problem: expect.stringContaining('does not show that the engine suites passed on this commit') })
    })
  })

  describe('on the stable channel, which asks what the test channel of the same system shows', () => {
    const stable = (target = WIN, file = EXE, kind = 'nsis'): PublishInput => installerInput({ channelName: 'stable', channel: channelFor('stable', target) }, target, file, kind)

    it('lets in an installer that waited on the test channel of its system and was attested for it', async () => {
      const w = world({}, WIN, EXE, 'nsis', 'stable')
      expect(await publish(stable(), w.deps)).toEqual({ ok: true, dryRun: false })
      expect(w.journal()[0]).toMatchObject({ channel: 'stable', platform: WIN, stable: { attestedBy: 'The maintainer' } })
    })

    it('does not count a publication of the Mac, nor of another system, for the passage through the test channel', async () => {
      for (const other of [undefined, 'linux-x64-appimage']) {
        const w = world({ journal: gate.journalLine(entryOn(other)) })
        const result = await publish(stable(), w.deps)
        expect(result, String(other)).toMatchObject({ ok: false, problem: expect.stringMatching(/journal has no publication of 1\.0\.2 on the test channel/) })
      }
    })

    it('does not take the attestation of the Mac or of another system', async () => {
      const mac = { version: VERSION, archiveSha256: HASH, attestedBy: 'The maintainer', attestedAt: '2026-11-11T18:30:00Z', checks: { netflixPlays: true, touchIdUnlocksTheVault: true, updateFromPreviousVersion: true }, updatedFrom: '1.0.1' }
      const withMacAttestation = await publish(stable(), world({ attestation: JSON.stringify(mac) }).deps)
      expect(withMacAttestation).toMatchObject({ ok: false, problem: expect.stringMatching(/not of win32-x64[\s\S]*installsOnARealMachine is not true/) })
      const forLinux = await publish(stable(), world({ attestation: JSON.stringify({ ...ATTESTATION, platform: 'linux-x64-appimage' }) }).deps)
      expect(forLinux).toMatchObject({ ok: false, problem: expect.stringMatching(/attestation of "linux-x64-appimage", not of win32-x64/) })
    })

    it('asks the checks of an installer, and shows the file to fill in when there is none', async () => {
      const result = await publish(stable(), world({ attestation: null }).deps)
      expect(result).toMatchObject({ ok: false, problem: expect.stringContaining('"platform": "win32-x64"') })
      const problem = result.ok ? '' : result.problem
      expect(problem).toContain('"installsOnARealMachine": false')
      expect(problem).not.toContain('netflixPlays')
      const unmet = await publish(stable(), world({ attestation: JSON.stringify({ ...ATTESTATION, checks: { installsOnARealMachine: true, updateFromPreviousVersion: false } }) }).deps)
      expect(unmet).toMatchObject({ ok: false, problem: expect.stringContaining('checks.updateFromPreviousVersion is not true') })
    })
  })

  it('carries the versions withdrawn from the channel of its system, and not those of another system', async () => {
    const withdrawn = (target: string | undefined): string =>
      gate.withdrawalLine({ at: '2026-11-11T08:00:00.000Z', type: gate.WITHDRAWAL, version: '1.0.1', channel: 'test', outcome: 'withdrawn', offers: 'nothing', to: null, ...(target ? { platform: target } : {}) })
    const published = gate.journalLine(entryOn(WIN, { version: '1.0.1', at: '2026-11-07T10:00:00.000Z' })) + gate.journalLine(entryOn(WIN))
    const carried = async (journal: string): Promise<unknown> => {
      const w = world({ journal })
      await publish(installerInput(), w.deps)
      return (JSON.parse(Object.values(w.written)[0] as string) as { withdrawn?: string[] }).withdrawn
    }
    expect(await carried(published + withdrawn(WIN))).toEqual(['1.0.1'])
    expect(await carried(published + withdrawn(undefined))).toBeUndefined()
    expect(await carried(published + withdrawn('linux-x64-appimage'))).toBeUndefined()
  })
})

describe('the withdrawal of an installer', () => {
  const INPUT: WithdrawInput = { version: VERSION, to: null, channelName: 'test', channel: channelFor('test', WIN), sshKey: SSH_KEY, dryRun: false, journal: '/outside/publish-journal.jsonl', target: WIN }
  const base = 'https://test.lucium.app/updates/win32-x64/'
  const OLD = 'Lucium-Setup-1.0.1-x64.exe'

  function server(change: { listing?: string; kept?: string } = {}) {
    const said: string[] = []
    const ran: Command[] = []
    const appended: string[] = []
    let feedAfter = ''
    const current = signedFeed(feedOf(WIN, EXE, 'nsis', base))
    const kept = signedFeed(change.kept ?? feedOf(WIN, OLD, 'nsis', base, 'f'.repeat(64), '1.0.1'))
    const deps: Pick<PublishDeps, 'say' | 'run' | 'exists' | 'appendText' | 'now' | 'gate' | 'feedKeys'> = {
      say: (line) => said.push(line),
      exists: () => true,
      appendText: (_path, text) => {
        appended.push(text)
      },
      now: () => NOW,
      gate,
      feedKeys: TEST_FEED_KEYS,
      run: (command) => {
        ran.push(command)
        const script = command.args.at(-1) ?? ''
        if (command.program === 'curl') {
          if (command.args.includes('-I')) return done(script.includes('Lucium-Setup-1.0.1') ? '200' : '404')
          return done(feedAfter)
        }
        if (script.startsWith('sudo -n ls')) return done(change.listing ?? `${EXE}\n${OLD}\nfeed.json\nfeed-1.0.1.json\n${EXE}.withdrawn\n`)
        if (script.includes('then sudo -n cat $D/feed.json')) return done(current)
        if (script.startsWith('sudo -n cat ') && script.includes('feed-1.0.1.json')) return done(kept)
        if (script.includes('sha256sum $D/') && script.includes('| wc -c')) return done(`${'f'.repeat(64)}  x\n${SIZE}\n`)
        const writing = /printf %s (\S+) \| base64 -d/.exec(script)
        if (writing) feedAfter = Buffer.from(writing[1] as string, 'base64').toString('utf8')
        return done()
      }
    }
    return { deps, said, ran, appended, scripts: () => ran.map((command) => command.args.at(-1) ?? '') }
  }

  it('goes back to the earlier installer, sets aside only the installer of this system and version, and journals the system', async () => {
    const s = server()
    expect(await withdraw(INPUT, s.deps)).toMatchObject({ ok: true, offered: 'earlier version' })
    const aside = s.scripts().find((script) => script.includes('for F in')) as string
    expect(aside).toContain(`for F in ${EXE} feed-${VERSION}.json;`)
    expect(aside).not.toContain('.dmg')
    expect(aside).not.toContain(OLD)
    expect(s.scripts().some((script) => script.includes(`sha256sum $D/${OLD}`))).toBe(true)
    expect(s.ran.some((command) => command.program === 'curl' && command.args.at(-1) === `${base}${OLD}`)).toBe(true)
    expect(s.appended.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ type: 'withdrawal', version: VERSION, channel: 'test', platform: WIN, to: '1.0.1' })])
    expect(s.said.join('\n')).toContain(`names the installer of ${WIN}`)
    expect(s.said.join('\n')).not.toContain('names the disk image')
  })

  it('changes nothing on the server in a dry run, and says what it would run', async () => {
    const s = server()
    expect(await withdraw({ ...INPUT, dryRun: true }, s.deps)).toMatchObject({ ok: true, dryRun: true })
    expect(s.appended).toEqual([])
    expect(s.said.join('\n')).toContain('(dry run: not run)')
  })

  it('refuses to go back to a feed whose installer is not the one of that version for this system', async () => {
    const s = server({ kept: feedOf(WIN, OLD, 'nsis', base, 'f'.repeat(64), '1.0.1').replace(OLD, 'Lucium-Setup-1.0.0-x64.exe') })
    expect(await withdraw(INPUT, s.deps)).toMatchObject({ ok: false, problem: expect.stringMatching(/not the one of 1\.0\.1 for win32-x64/) })
  })

  it('says so when the folder holds no installer of the version, and still deals with the feed', async () => {
    const s = server({ listing: 'feed.json\nfeed-1.0.1.json\n' })
    expect(await withdraw(INPUT, s.deps)).toMatchObject({ ok: true })
    expect(s.said.join('\n')).toContain(`the folder holds no installer of ${VERSION} for ${WIN}`)
    expect(s.scripts().find((script) => script.includes('for F in'))).toContain(`for F in feed-${VERSION}.json;`)
  })
})
