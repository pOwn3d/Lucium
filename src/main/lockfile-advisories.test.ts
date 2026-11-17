// No version of a package that a published advisory names is resolved by the lockfile. Dependabot alerts on the lockfile (pnpm-lock.yaml) of the repository, and
// a development tool that is not shipped still runs on the machine of whoever builds: a version in a range below stays out, by a newer parent or by an entry of
// `overrides` in pnpm-workspace.yaml. To add an advisory, add its row; the test then names the package, the advisory and the versions that are in it.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface Advisory {
  id: string
  pkg: string
  /** The first version that is affected. */
  from: string
  /** The first version that is fixed: the range is `from <= version < before`. */
  before: string
}

const ADVISORIES: readonly Advisory[] = [
  // minimatch: denial of service through the amplification of globparts (medium; electron-builder, development only).
  { id: 'GHSA-g3hv-75wg-m249', pkg: 'minimatch', from: '7.0.0', before: '11.0.1' },
  // minimatch: quadratic compile time of long wildcard patterns (a regression of 11.0.0).
  { id: 'GHSA-cf2h-pxjq-68xw', pkg: 'minimatch', from: '11.0.0', before: '11.0.7' }
]

const parts = (version: string): [number, number, number] => {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number)
  return [major, minor, patch]
}

/** Negative, zero or positive as `a` is before, equal to or after `b` (plain `x.y.z` versions). */
const compare = (a: string, b: string): number => {
  const [left, right] = [parts(a), parts(b)]
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

const isAffected = (advisory: Advisory, version: string): boolean => compare(version, advisory.from) >= 0 && compare(version, advisory.before) < 0

/**
 * Every `name@x.y.z` the lockfile resolves: the entries of its `packages:` sections, which are the ones with a `resolution`. The file holds more than one document (the
 * tools of pnpm itself come first), so the whole text is read. A peer suffix or a prerelease tag is not a plain version and is skipped.
 */
const resolved = (lockfile: string): Array<{ name: string; version: string }> =>
  [...lockfile.matchAll(/^ {2}'?((?:@[^/@'\s]+\/)?[^@'\s]+)@(\d+\.\d+\.\d+)'?:\n {4}resolution:/gm)].map((match) => ({ name: match[1]!, version: match[2]! }))

describe('the versions the advisories name', () => {
  it('knows which versions are in a range: the first affected one, the last one, and the fix itself', () => {
    const [denial, quadratic] = ADVISORIES
    expect(['6.2.3', '7.0.0', '9.0.9', '10.2.6', '11.0.0', '11.0.1'].map((version) => isAffected(denial!, version))).toEqual([false, true, true, true, true, false])
    expect(['3.1.5', '5.1.9', '10.2.6', '11.0.0', '11.0.6', '11.0.7', '11.0.8', '12.0.0'].map((version) => isAffected(quadratic!, version))).toEqual([false, false, false, true, true, false, false, false])
  })

  it('reads the packages of a lockfile of several documents, scoped ones included, and not the snapshots', () => {
    const lockfile = "lockfileVersion: '9.0'\n\npackages:\n\n  '@scope/pkg@1.2.3':\n    resolution: {}\n\n  minimatch@11.0.8:\n    resolution: {}\n\n  other@2.0.0-beta.1:\n    resolution: {}\n\nsnapshots:\n\n  minimatch@3.1.5: {}\n\n---\nlockfileVersion: '9.0'\npackages:\n\n  minimatch@5.1.9:\n    resolution: {}\n"
    expect(resolved(lockfile)).toEqual([
      { name: '@scope/pkg', version: '1.2.3' },
      { name: 'minimatch', version: '11.0.8' },
      { name: 'minimatch', version: '5.1.9' }
    ])
  })

  it('are not in pnpm-lock.yaml', () => {
    const installed = resolved(readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8'))
    // The lockfile is read at all: the packages of the project are there.
    expect(installed.some((entry) => entry.name === 'minimatch')).toBe(true)
    const found = ADVISORIES.flatMap((advisory) => installed.filter((entry) => entry.name === advisory.pkg && isAffected(advisory, entry.version)).map((entry) => `${entry.name}@${entry.version} (${advisory.id})`))
    expect(found, 'a version named by an advisory is resolved: raise its parent, or add an entry to `overrides` in pnpm-workspace.yaml').toEqual([])
  })
})
