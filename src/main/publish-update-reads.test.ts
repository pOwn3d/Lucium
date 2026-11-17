import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSha256Line, readFeedCommand, withdrawPlan, type Channel, type Command } from './publish-update'

// The scripts that read the folder of a channel on the server, run for real in a local shell. On the server that folder is readable by root only
// (mode 0700): the account of the publication reads it through `sudo -n`, as it writes it. The tests of publish-update.test.ts and
// withdraw-update.test.ts answer these scripts from a made-up server that recognizes them by their text, so they cannot see what a shell does with
// them: a `[ -f … ]` that is false in a folder nobody may enter, a status that stays 0, a `wc -c < file` opened by the wrong account.
//
// Here the folder is made unreadable with chmod 000, and a stand-in for `sudo` leads the PATH: one that lets the account act as root over that
// folder for the time of the command it runs, and one that refuses as a server does when the account may not use sudo.
// Root opens any folder, so with chmod 000 there would be nothing to see: those runs are left out when the tests themselves run as root.
const asRoot = process.getuid?.() === 0

const ALLOWS = `#!/bin/sh
# Stands for a sudo that lets the account act as root. The folder of the channel is root's alone: it is opened for the time of the command, then closed.
[ "$1" = "-n" ] || { echo "sudo: a password is required" >&2; exit 1; }
shift
chmod 755 "$CHANNEL_FOLDER" 2>/dev/null
"$@"
S=$?
chmod 000 "$CHANNEL_FOLDER" 2>/dev/null
exit $S
`
const REFUSES = `#!/bin/sh
# Stands for the answer of a server where the account may not use sudo without a password.
echo "sudo: a password is required" >&2
exit 1
`
/** `sha256sum` is the tool of the server (GNU coreutils); a Mac has `shasum -a 256`, which prints the same line. */
const SHA256SUM = `#!/bin/sh
exec shasum -a 256 "$@"
`

const hasSha256sum = spawnSync('/bin/sh', ['-c', 'command -v sha256sum'], { encoding: 'utf8' }).status === 0

interface Place {
  base: string
  folder: string
  allowing: string
  refusing: string
  channel: Channel
}
let place: Place

const stand = (dir: string, sudo: string): string => {
  mkdirSync(dir)
  writeFileSync(join(dir, 'sudo'), sudo, { mode: 0o755 })
  if (!hasSha256sum) writeFileSync(join(dir, 'sha256sum'), SHA256SUM, { mode: 0o755 })
  return dir
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'lucium-reads-'))
  const folder = join(base, 'darwin-arm64')
  place = {
    base,
    folder,
    allowing: stand(join(base, 'bin-allowing'), ALLOWS),
    refusing: stand(join(base, 'bin-refusing'), REFUSES),
    channel: { host: 'deploy@updates.example', folder, baseUrl: 'https://lucium.app/updates/darwin-arm64/' }
  }
})

afterEach(() => {
  // A folder closed with chmod 000 cannot be removed until it is open again.
  if (existsSync(place.folder)) chmodSync(place.folder, 0o755)
  rmSync(place.base, { recursive: true, force: true })
})

/** Puts the files in the folder of the channel, then closes it: only `sudo` opens it from here on. */
function fillAndClose(files: Record<string, string>): void {
  mkdirSync(place.folder)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(place.folder, name), text)
  chmodSync(place.folder, 0o000)
}

/** Runs the script of a command in a local shell, as the server's shell would run it, with the stand-in `sudo` first in the PATH. */
function run(command: Command, sudo: 'allows' | 'refuses'): { status: number | null; stdout: string; stderr: string } {
  const bin = sudo === 'allows' ? place.allowing : place.refusing
  const result = spawnSync('/bin/sh', ['-c', command.args.at(-1) ?? ''], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, CHANNEL_FOLDER: place.folder }
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const VERSION = '1.0.2'
const FEED = '{"currentRelease":"1.0.1","note":"read on the server"}\n'
const ARCHIVE = 'the bytes of an archive'
const KEY = '/home/me/.ssh/id_ed25519'
const plan = (): ReturnType<typeof withdrawPlan> => withdrawPlan({ version: VERSION, channel: place.channel, sshKey: KEY })

describe.skipIf(asRoot)('the scripts that read the folder of a channel, run against a folder only root can read', () => {
  it('has a folder the account cannot read: what the tests below stand on', () => {
    fillAndClose({ 'feed.json': FEED })
    expect(() => readdirSync(place.folder)).toThrow(/EACCES/)
  })

  describe('the feed in place', () => {
    it('is printed through sudo, from a folder the account cannot enter', () => {
      fillAndClose({ 'feed.json': FEED, 'feed-1.0.1.json': 'kept' })
      expect(run(readFeedCommand(place.channel, KEY), 'allows')).toEqual({ status: 0, stdout: FEED, stderr: '' })
    })

    it('is nothing, with a status of 0, on a channel that has none yet: a folder without it, and no folder at all', () => {
      fillAndClose({ 'Lucium-1.0.1-arm64.zip': ARCHIVE })
      expect(run(readFeedCommand(place.channel, KEY), 'allows')).toEqual({ status: 0, stdout: '', stderr: '' })
      chmodSync(place.folder, 0o755)
      rmSync(place.folder, { recursive: true })
      expect(run(readFeedCommand(place.channel, KEY), 'allows')).toEqual({ status: 0, stdout: '', stderr: '' })
    })

    it('stops with a status and a message when sudo is refused: a feed that cannot be read is never "no feed yet"', () => {
      fillAndClose({ 'feed.json': FEED })
      const result = run(readFeedCommand(place.channel, KEY), 'refuses')
      expect(result.stdout).toBe('')
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('sudo: a password is required')
      expect(result.stderr).toContain('cannot read the folder of the channel')
    })

    it('is read the same way by a withdrawal', () => {
      fillAndClose({ 'feed.json': FEED })
      expect(run(plan().readFeed, 'allows')).toMatchObject({ status: 0, stdout: FEED })
      expect(run(plan().readFeed, 'refuses')).toMatchObject({ status: 2, stdout: '' })
    })
  })

  describe('the names of the folder', () => {
    it('are listed through sudo, one a line, and are not listed when sudo is refused', () => {
      fillAndClose({ 'feed.json': FEED, 'feed-1.0.1.json': 'kept', 'Lucium-1.0.1-arm64.zip': ARCHIVE })
      const listed = run(plan().list, 'allows')
      expect(listed.status).toBe(0)
      expect(listed.stdout.trim().split('\n').sort()).toEqual(['Lucium-1.0.1-arm64.zip', 'feed-1.0.1.json', 'feed.json'])
      const refused = run(plan().list, 'refuses')
      expect(refused.status).not.toBe(0)
      expect(refused.stdout).toBe('')
      expect(refused.stderr).toContain('sudo: a password is required')
    })
  })

  describe('a kept feed', () => {
    it('is read through sudo, and a missing one, or a refused sudo, is an error', () => {
      fillAndClose({ 'feed-1.0.1.json': FEED })
      const kept = plan().target('1.0.1').readKept
      expect(run(kept, 'allows')).toEqual({ status: 0, stdout: FEED, stderr: '' })
      expect(run(plan().target('1.0.0').readKept, 'allows').status).not.toBe(0)
      const refused = run(kept, 'refuses')
      expect(refused.status).not.toBe(0)
      expect(refused.stdout).toBe('')
    })
  })

  describe('an archive', () => {
    it('is weighed through sudo: its SHA-256, then its size alone on the next line, as the withdrawal reads them', () => {
      fillAndClose({ 'Lucium-1.0.1-arm64.zip': ARCHIVE })
      const weighed = run(plan().target('1.0.1').weighArchive, 'allows')
      expect(weighed.status).toBe(0)
      const [hashLine = '', sizeLine = ''] = weighed.stdout.trim().split('\n')
      expect(parseSha256Line(hashLine)).toBe(createHash('sha256').update(ARCHIVE).digest('hex'))
      expect(Number(sizeLine.trim())).toBe(Buffer.byteLength(ARCHIVE))
    })

    it('is not weighed when sudo is refused, or when the archive is not there', () => {
      fillAndClose({ 'Lucium-1.0.1-arm64.zip': ARCHIVE })
      const refused = run(plan().target('1.0.1').weighArchive, 'refuses')
      expect(refused.status).not.toBe(0)
      expect(refused.stdout).toBe('')
      const missing = run(plan().target('1.0.0').weighArchive, 'allows')
      expect(missing.status).not.toBe(0)
      expect(missing.stdout).toBe('')
    })
  })

  describe('the files of a withdrawn version', () => {
    it('are set aside through sudo, and only the ones that are there', () => {
      fillAndClose({ [`Lucium-${VERSION}-arm64.zip`]: ARCHIVE, [`feed-${VERSION}.json`]: FEED, 'feed.json': FEED, 'Lucium-1.0.1-arm64.zip': ARCHIVE })
      expect(run(plan().setAsideFiles, 'allows')).toEqual({ status: 0, stdout: '', stderr: '' })
      chmodSync(place.folder, 0o755)
      expect(readdirSync(place.folder).sort()).toEqual(['Lucium-1.0.1-arm64.zip', `Lucium-${VERSION}-arm64.zip.withdrawn`, `feed-${VERSION}.json.withdrawn`, 'feed.json'])
    })

    it('are not set aside, and the command fails, when sudo is refused: a file that is still served is never reported as renamed', () => {
      fillAndClose({ [`Lucium-${VERSION}-arm64.zip`]: ARCHIVE, 'feed.json': FEED })
      const result = run(plan().setAsideFiles, 'refuses')
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('cannot set the files aside')
      chmodSync(place.folder, 0o755)
      expect(readdirSync(place.folder).sort()).toEqual([`Lucium-${VERSION}-arm64.zip`, 'feed.json'])
    })
  })
})
