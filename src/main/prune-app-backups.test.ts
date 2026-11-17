import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// scripts/prune-app-backups.sh: the copies of the application scripts/build-drm-release.sh sets aside at each installation. The script is run
// here for real, on a folder of the test: it only ever looks inside the folder it is given.
const PRUNE = fileURLToPath(new URL('../../scripts/prune-app-backups.sh', import.meta.url))
const release = readFileSync(fileURLToPath(new URL('../../scripts/build-drm-release.sh', import.meta.url)), 'utf8')

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** A folder of copies holding one folder (with an app inside) per name. */
function copies(names: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'lucium-app-backups-'))
  folders.push(root)
  for (const name of names) {
    mkdirSync(join(root, name, 'Lucium.app'), { recursive: true })
    writeFileSync(join(root, name, 'Lucium.app', 'Info.plist'), name)
  }
  return root
}

const prune = (...args: string[]): { status: number | null; out: string; err: string } => {
  const result = spawnSync('bash', [PRUNE, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  return { status: result.status, out: result.stdout, err: result.stderr }
}
const left = (root: string): string[] => readdirSync(root).sort()

const DATES = ['20261101-090000', '20261103-101500', '20261105-235959', '20261109-000001', '20261111-083000']

describe('scripts/prune-app-backups.sh', () => {
  it('keeps the three newest copies and removes the older ones, saying which', () => {
    const root = copies(DATES)
    expect(prune(root)).toEqual({ status: 0, out: 'removed 20261101-090000\nremoved 20261103-101500\n', err: '' })
    expect(left(root)).toEqual(DATES.slice(2))
    expect(existsSync(join(root, '20261111-083000', 'Lucium.app', 'Info.plist'))).toBe(true)
  })

  it('keeps as many as it is told, and removes nothing when there are no more than that', () => {
    const one = copies(DATES)
    expect(prune(one, '1').out).toBe(DATES.slice(0, 4).map((name) => `removed ${name}\n`).join(''))
    expect(left(one)).toEqual(['20261111-083000'])
    for (const count of ['5', '12']) {
      const all = copies(DATES)
      expect(prune(all, count)).toEqual({ status: 0, out: '', err: '' })
      expect(left(all)).toEqual(DATES)
    }
    const none = copies(DATES)
    expect(prune(none, '0').status).toBe(0)
    expect(left(none)).toEqual([])
  })

  it('never removes what is not a folder named by a date: a file, a link, a folder named by hand', () => {
    const root = copies([...DATES, 'garder-0.2.15', '20261101-0900', '20261101-090000-copie'])
    writeFileSync(join(root, '20261001-000000'), 'a file with the name of a copy')
    const elsewhere = copies(['cible'])
    symlinkSync(join(elsewhere, 'cible'), join(root, '20261002-000000'))
    expect(prune(root, '1').status).toBe(0)
    expect(left(root)).toEqual(['20261001-000000', '20261002-000000', '20261101-0900', '20261101-090000-copie', '20261111-083000', 'garder-0.2.15'])
    // The folder the link points at is whole.
    expect(existsSync(join(elsewhere, 'cible', 'Lucium.app', 'Info.plist'))).toBe(true)
  })

  it('does nothing in a folder that does not exist or is empty', () => {
    const root = copies([])
    expect(prune(root)).toEqual({ status: 0, out: '', err: '' })
    expect(prune(join(root, 'absent'))).toEqual({ status: 0, out: '', err: '' })
    expect(left(root)).toEqual([])
  })

  it('refuses a call without a folder or with a count that is not a whole number, and removes nothing', () => {
    const root = copies(DATES)
    expect(prune().status).toBe(2)
    for (const count of ['-1', 'deux', '1.5', '3 ']) {
      const result = prune(root, count)
      expect(result.status, count).toBe(2)
      expect(result.err, count).toContain('whole number')
    }
    expect(left(root)).toEqual(DATES)
  })
})

describe('scripts/build-drm-release.sh and the copies it sets aside', () => {
  it('prunes the folder of the copies after the new application is in place, never before', () => {
    const install = release.indexOf('ditto "$APP" /Applications/Lucium.app')
    const pruned = release.indexOf('scripts/prune-app-backups.sh" "$BACKUPS" "${LUCIUM_APP_BACKUPS_KEEP:-3}"')
    expect(install).toBeGreaterThan(-1)
    expect(pruned).toBeGreaterThan(install)
    expect(release).toContain('BACKUPS="$HOME/Library/Application Support/lucium-app-backups"')
  })
})
