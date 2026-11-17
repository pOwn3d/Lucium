// scripts/build-drm-release.sh and the public key of the update feed. The script signs with the maintainer's identity and builds for two
// minutes, so it is never run whole here: its two passages about the key are cut out of its text and run alone, in a folder of the test, with a
// stand-in for `node` (the real check of the list, `feed-key.mjs --check`, is feed-key-script.test.ts's). Nothing they could let through reaches
// a build or a signature, because neither is in them.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { onWindows } from './windows.test-support'

const script = readFileSync(fileURLToPath(new URL('../../scripts/build-drm-release.sh', import.meta.url)), 'utf8')
const between = (from: string, to: string): string => {
  const start = script.indexOf(from)
  const end = script.indexOf(to, start + from.length)
  if (start < 0 || end < 0) throw new Error(`scripts/build-drm-release.sh no longer holds "${from.trim()}" followed by "${to.trim()}"`)
  return script.slice(start, end)
}
/** Before the build: the list of keys is asked for. */
const ASKS = between('\nFEED_KEYS=""\n', '\n# The commit this build is of')
/** After the build: each key is looked for in app.asar. */
const LOOKS = between('\nif [ -n "$FEED_KEYS" ]; then\n  while IFS= read -r FEED_KEY', '\n# The update feeds are in app.asar')
// Made up for this test (a pattern repeated twice, not a key anybody holds): the scanner takes a base64 string of this length for a key.
const KEY = 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=' // gitleaks:allow
const OTHER = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), 'lucium-build-feed-key-'))
  folders.push(root)
  return root
}

/** The passage before the build, with a `node` that answers `--check` as told: these keys, this exit code. */
function ask(options: { feed?: string; notarize?: boolean; keys?: string; status?: number }): { status: number | null; output: string } {
  const root = folder()
  mkdirSync(join(root, 'bin'))
  // The stand-in records that it was called, and with what.
  writeFileSync(join(root, 'bin', 'node'), `#!/bin/sh\necho "$*" >> "${root}/calls"\nprintf '%s' "$FAKE_KEYS"\nexit "$FAKE_STATUS"\n`)
  chmodSync(join(root, 'bin', 'node'), 0o755)
  writeFileSync(join(root, 'passage.sh'), `set -euo pipefail\nUPDATE_FEED="\${T_FEED-}"\nNOTARIZE="\${T_NOTARIZE-0}"\n${ASKS}\necho "REACHED the build"\n`)
  const result = spawnSync('bash', [join(root, 'passage.sh')], {
    encoding: 'utf8',
    cwd: root,
    env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, T_FEED: options.feed ?? '', T_NOTARIZE: options.notarize ? '1' : '0', FAKE_KEYS: options.keys ?? '', FAKE_STATUS: String(options.status ?? 0) }
  })
  let calls = ''
  try {
    calls = readFileSync(join(root, 'calls'), 'utf8')
  } catch (error) {
    // No file: the stand-in was never called, which is what some tests look for. Anything else is a failure of the test itself.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}${calls ? `CALLED node ${calls}` : ''}` }
}

/** The passage after the build, on an app.asar that holds `asar`. */
function look(keys: string, asar: string): { status: number | null; output: string } {
  const root = folder()
  mkdirSync(join(root, 'Lucium.app', 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(root, 'Lucium.app', 'Contents', 'Resources', 'app.asar'), asar)
  writeFileSync(join(root, 'passage.sh'), `set -euo pipefail\nAPP="${join(root, 'Lucium.app')}"\nFEED_KEYS="$T_KEYS"\n${LOOKS}\necho "REACHED the rest"\n`)
  const result = spawnSync('bash', [join(root, 'passage.sh')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', T_KEYS: keys } })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

// Windows: these run the bash script of the build with a stand-in `node` written as a shell script; it is the maintainer's release tooling, run on the maintainer's Mac (docs/community/release-process.md).
const itRunsBash = it.skipIf(onWindows)

describe('build-drm-release.sh, before the build', () => {
  itRunsBash('stops a build with an update feed while the public key of the feed is not filled in, and says what to run', () => {
    const result = ask({ feed: 'https://lucium.app/updates/darwin-arm64/feed.json', status: 1 })
    expect(result.status).toBe(2)
    expect(result.output).not.toContain('REACHED')
    expect(result.output).toMatch(/No build with an update feed, and no build to hand out, without the public key of the feed in src\/main\/update-feed-keys\.ts/)
    expect(result.output).toMatch(/Run once: node scripts\/feed-key\.mjs/)
    expect(result.output).toContain('CALLED node scripts/feed-key.mjs --check')
  })

  itRunsBash('stops a build to hand out (--notarize) the same way, with or without a feed', () => {
    expect(ask({ notarize: true, status: 1 }).status).toBe(2)
    expect(ask({ notarize: true, feed: 'https://lucium.app/updates/darwin-arm64/feed.json', status: 1 }).status).toBe(2)
  })

  itRunsBash('stops too when the check answers no key at all', () => {
    const result = ask({ notarize: true, status: 0, keys: '' })
    expect(result.status).toBe(2)
    expect(result.output).not.toContain('REACHED')
  })

  itRunsBash('goes on with the keys once they are filled in, and names them', () => {
    const result = ask({ feed: 'https://lucium.app/updates/darwin-arm64/feed.json', notarize: true, keys: `${KEY}\n${OTHER}\n` })
    expect(result.status).toBe(0)
    expect(result.output).toContain(`Public key(s) of the update feed built in: ${KEY} ${OTHER}`)
    expect(result.output).toContain('REACHED the build')
  })

  itRunsBash('asks nothing of a build for this Mac alone: no feed, not notarized', () => {
    expect(ask({ status: 1 })).toEqual({ status: 0, output: 'REACHED the build\n' })
  })

  it('asks before the build starts', () => {
    expect(script.indexOf('node scripts/feed-key.mjs --check')).toBeGreaterThan(0)
    expect(script.indexOf('node scripts/feed-key.mjs --check')).toBeLessThan(script.indexOf('node scripts/package-drm.mjs'))
  })
})

describe('build-drm-release.sh, after the build', () => {
  itRunsBash('goes on when app.asar holds every key', () => {
    const result = look(`${KEY}\n${OTHER}`, `…const k=["${KEY}","${OTHER}"];…`)
    expect(result.status).toBe(0)
    expect(result.output).toMatch(/Public key\(s\) of the update feed in app\.asar[\s\S]*REACHED the rest/)
  })

  itRunsBash('stops when app.asar lacks a key: that build would refuse every feed', () => {
    for (const asar of ['nothing of a key', `…["${KEY}"]…`]) {
      const result = look(`${KEY}\n${OTHER}`, asar)
      expect(result.status).toBe(1)
      expect(result.output).not.toContain('REACHED')
      expect(result.output).toMatch(/The public key \S+ of the update feed is not in .*app\.asar: this build would refuse every feed\. Nothing is installed/)
    }
  })

  itRunsBash('looks for nothing in a build that asked for no key', () => {
    expect(look('', 'nothing of a key')).toEqual({ status: 0, output: 'REACHED the rest\n' })
  })

  it('looks before anything is notarized or installed', () => {
    const at = script.indexOf('of the update feed is not in $APP/Contents/Resources/app.asar')
    expect(at).toBeGreaterThan(script.indexOf('node scripts/package-drm.mjs'))
    for (const later of ['xcrun notarytool submit', 'ditto "$APP" /Applications/Lucium.app']) {
      expect(script, later).toContain(later)
      expect(at, later).toBeLessThan(script.indexOf(later))
    }
  })
})
