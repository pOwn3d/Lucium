// scripts/feed-key.mjs, run as the maintainer runs it, but in a folder of the test: LUCIUM_FEED_KEY_DIR names it and HOME is that folder too, so
// that nothing here can reach the real folder of the keys. The key it makes is a throw-away one.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { UPDATE_FEED_PUBLIC_KEYS } from './update-feed-keys'
import { FEED_KEY_FILE, NEXT_FEED_KEY_FILE, publicKeyOfPrivate, signFeedText, verifyFeed } from './update-feed-signature'

const SCRIPT = fileURLToPath(new URL('../../scripts/feed-key.mjs', import.meta.url))
const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function home(): { dir: string; run: (...args: string[]) => { status: number | null; stdout: string; stderr: string; all: string } } {
  const root = mkdtempSync(join(tmpdir(), 'lucium-feed-key-script-'))
  folders.push(root)
  // A folder that does not exist yet: the script makes it.
  const dir = join(root, 'secrets')
  return {
    dir,
    run: (...args) => {
      const done = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: root, LUCIUM_FEED_KEY_DIR: dir } })
      return { status: done.status, stdout: done.stdout, stderr: done.stderr, all: `${done.stdout}${done.stderr}` }
    }
  }
}
/** The lines of a private key that are the key itself. */
const secretLines = (pem: string): string[] => pem.split('\n').filter((line) => line !== '' && !line.startsWith('-----'))
const modeOf = (path: string): number => statSync(path).mode & 0o777

describe('scripts/feed-key.mjs', () => {
  it('makes the pair once: the private key for its owner only, the public key printed with where it goes', () => {
    const { dir, run } = home()
    const made = run()
    expect(made.status, made.all).toBe(0)
    const pem = readFileSync(join(dir, FEED_KEY_FILE), 'utf8')
    expect(modeOf(join(dir, FEED_KEY_FILE))).toBe(0o600)
    expect(modeOf(dir)).toBe(0o700)
    expect(made.stdout).toContain(`'${publicKeyOfPrivate(pem)}'`)
    expect(made.stdout).toContain('UPDATE_FEED_PUBLIC_KEYS of src/main/update-feed-keys.ts')
    // The key it made signs a feed that its public half checks.
    const feed = signFeedText('{\n  "currentRelease": "0.3.1"\n}\n', [pem])
    expect(verifyFeed(Buffer.from(feed), [publicKeyOfPrivate(pem)]).ok).toBe(true)
  })

  it('never prints the private key, when it makes it or when it shows the public one', () => {
    const { dir, run } = home()
    const made = run()
    const shown = run('--show')
    const again = run()
    expect(shown.status, shown.all).toBe(0)
    const secret = secretLines(readFileSync(join(dir, FEED_KEY_FILE), 'utf8'))
    expect(secret.length).toBeGreaterThan(0)
    for (const line of secret) expect(`${made.all}${shown.all}${again.all}`).not.toContain(line)
    expect(shown.stdout).toMatch(/^feed-key\.pem: public key [A-Za-z0-9+/]{43}= \((NOT )?in src\/main\/update-feed-keys\.ts\)$/m)
  })

  it('refuses to replace a key that is there, and leaves it as it is', () => {
    const { dir, run } = home()
    run()
    const before = readFileSync(join(dir, FEED_KEY_FILE), 'utf8')
    const again = run()
    expect(again.status).toBe(1)
    expect(again.stderr).toMatch(/feed-key\.pem is there already, and is never replaced/)
    expect(readFileSync(join(dir, FEED_KEY_FILE), 'utf8')).toBe(before)
  })

  it('refuses a name that is taken by a link too, and writes nothing through it', () => {
    const { dir, run } = home()
    run()
    const elsewhere = join(dir, 'elsewhere.pem')
    symlinkSync(elsewhere, join(dir, NEXT_FEED_KEY_FILE))
    const next = run('--next')
    expect(next.status).toBe(1)
    expect(() => statSync(elsewhere)).toThrow()
  })

  it('makes the key that takes over only beside a first key, and never in its place', () => {
    const alone = home()
    const refused = alone.run('--next')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toMatch(/--next makes the key that takes over from it/)
    expect(() => statSync(join(alone.dir, NEXT_FEED_KEY_FILE))).toThrow()

    const { dir, run } = home()
    run()
    const first = readFileSync(join(dir, FEED_KEY_FILE), 'utf8')
    const next = run('--next')
    expect(next.status, next.all).toBe(0)
    expect(readFileSync(join(dir, FEED_KEY_FILE), 'utf8')).toBe(first)
    expect(modeOf(join(dir, NEXT_FEED_KEY_FILE))).toBe(0o600)
    expect(publicKeyOfPrivate(readFileSync(join(dir, NEXT_FEED_KEY_FILE), 'utf8'))).not.toBe(publicKeyOfPrivate(first))
    expect(run('--next').status).toBe(1)
  })

  it('shows nothing of a file that is not a key, and says so', () => {
    const { dir, run } = home()
    run()
    writeFileSync(join(dir, FEED_KEY_FILE), 'SECRET-LOOKING-TEXT')
    const shown = run('--show')
    expect(shown.status).toBe(1)
    expect(shown.stderr).toMatch(/cannot be used: not a private key in PEM/)
    expect(shown.all).not.toContain('SECRET-LOOKING-TEXT')
    expect(home().run('--show')).toMatchObject({ status: 1, stderr: expect.stringMatching(/No key of the feed in /) })
  })

  it('makes nothing for an option it does not know', () => {
    const { dir, run } = home()
    for (const args of [['--force'], ['--next', '--show'], ['feed-key.pem']]) expect(run(...args).status, args.join(' ')).toBe(2)
    expect(() => statSync(dir)).toThrow()
  })

  it('--check reads no private key: it stops while the builds carry no public key, and prints the keys once they do', () => {
    const { dir, run } = home()
    const checked = run('--check')
    if (UPDATE_FEED_PUBLIC_KEYS.length === 0) {
      expect(checked.status).toBe(1)
      expect(checked.stderr).toMatch(/❌ src\/main\/update-feed-keys\.ts holds no public key: a copy of this build would refuse every update feed\. Run `node scripts\/feed-key\.mjs` once/)
      expect(checked.stdout).toBe('')
    } else {
      expect(checked.status, checked.all).toBe(0)
      expect(checked.stdout.trim().split('\n')).toEqual([...UPDATE_FEED_PUBLIC_KEYS])
    }
    // The folder of the keys was not even made.
    expect(() => statSync(dir)).toThrow()
  })
})
