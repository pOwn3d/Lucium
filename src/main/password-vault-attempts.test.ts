// The wrong master phrases of the vault are counted on the disk (`passwords.vault.attempts`, vault-attempts.ts), by every path that checks the
// phrase, and a relaunch does not give fresh tries.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportCryptoError } from './export-crypto'
import { PasswordVault, VaultError } from './password-vault'

const PHRASE = 'une phrase maître assez longue'
const NEXT = 'another long enough phrase'
const PARAMS = { N: 2 ** 14, r: 8, p: 1 }
const START = 1_700_000_000_000

let dir: string
let path: string
let attemptsPath: string
let clock: number
let logged: string[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-vault-attempts-'))
  path = join(dir, 'passwords.vault')
  attemptsPath = `${path}.attempts`
  clock = START
  logged = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** A vault object on the same file: a new one is what a relaunch of the application makes. */
const open = (): PasswordVault => new PasswordVault({ path, params: PARAMS, now: () => clock })
const errorOf = async (job: Promise<unknown>): Promise<unknown> => {
  try {
    await job
  } catch (error) {
    return error
  }
  return undefined
}
const isWrongPhrase = (error: unknown): boolean => error instanceof ExportCryptoError && error.kind === 'wrong-passphrase'
const isWait = (error: unknown): boolean => error instanceof VaultError && error.kind === 'wait'
const wrong = (n: number): string => `a wrong phrase number ${n}`
/** A vault with logins, locked, and the application relaunched on it. */
async function lockedVault(): Promise<PasswordVault> {
  const first = open()
  await first.create(PHRASE)
  await first.save({ origin: 'https://example.com', username: 'ana', password: 'S3CRET-p4ss-VALUE' })
  first.lock()
  return open()
}
const attemptsOnDisk = (): unknown => JSON.parse(readFileSync(attemptsPath, 'utf8'))

describe('the count survives a relaunch', () => {
  it('does not give three fresh tries: two wrong phrases, a relaunch, and the next wrong one already starts the wait', async () => {
    const before = await lockedVault()
    for (let n = 1; n <= 2; n++) expect(isWrongPhrase(await errorOf(before.unlock(wrong(n))))).toBe(true)
    expect(before.retryInMs()).toBe(0)
    const relaunched = open()
    expect(isWrongPhrase(await errorOf(relaunched.unlock(wrong(3))))).toBe(true)
    expect(relaunched.retryInMs()).toBe(1000)
  })

  it('keeps the wait running: the right phrase is not even tried by a new process until the wait is over, and then it opens and clears the count', async () => {
    const before = await lockedVault()
    for (let n = 1; n <= 3; n++) await errorOf(before.unlock(wrong(n)))
    const relaunched = open()
    expect(relaunched.retryInMs()).toBe(1000)
    const refused = await errorOf(relaunched.unlock(PHRASE))
    expect(isWait(refused)).toBe(true)
    expect(refused).toMatchObject({ retryInMs: 1000 })
    expect(relaunched.isUnlocked()).toBe(false)
    clock += 400
    expect(relaunched.retryInMs()).toBe(600)
    clock += 600
    await relaunched.unlock(PHRASE)
    expect(relaunched.isUnlocked()).toBe(true)
    expect(relaunched.retryInMs()).toBe(0)
    expect(existsSync(attemptsPath)).toBe(false)
    // Cleared for good: two more wrong phrases are free again.
    relaunched.lock()
    for (let n = 4; n <= 5; n++) await errorOf(relaunched.unlock(wrong(n)))
    expect(open().retryInMs()).toBe(0)
  })

  it('writes a small file only its owner reads, with a count and a time and nothing of the phrase or the vault', async () => {
    const before = process.umask(0)
    try {
      const v = await lockedVault()
      for (let n = 1; n <= 3; n++) await errorOf(v.unlock(wrong(n)))
    } finally {
      process.umask(before)
    }
    expect(statSync(attemptsPath).mode & 0o777).toBe(0o600)
    expect(attemptsOnDisk()).toEqual({ v: 1, failures: 3, until: START + 1000 })
    const text = readFileSync(attemptsPath, 'utf8')
    expect(text.length).toBeLessThan(100)
    for (const secret of [PHRASE, wrong(1), 'ana', 'S3CRET', 'example.com']) expect(text).not.toContain(secret)
    expect(existsSync(`${attemptsPath}.tmp`)).toBe(false)
  })
})

describe('every path that checks the phrase counts and waits', () => {
  type Path = [name: string, run: (v: PasswordVault, phrase: string) => Promise<unknown>]
  const paths: Path[] = [
    ['the change of phrase', (v, phrase) => v.changePhrase(phrase, NEXT)],
    ['the deletion of the vault', (v, phrase) => v.destroy(phrase)],
    ['the key for Touch ID', (v, phrase) => v.keyMaterial(phrase).then(({ material }) => material.fill(0))]
  ]

  for (const [name, run] of paths) {
    it(`counts the wrong phrases of ${name} on the disk and refuses even the right one while the wait lasts, changing nothing`, async () => {
      const v = open()
      await v.create(PHRASE)
      const sealed = readFileSync(path, 'utf8')
      for (let n = 1; n <= 3; n++) expect(isWrongPhrase(await errorOf(run(v, wrong(n)))), `wrong ${n}`).toBe(true)
      expect(attemptsOnDisk()).toEqual({ v: 1, failures: 3, until: START + 1000 })
      expect(v.retryInMs()).toBe(1000)
      // A relaunch finds the same wait: the right phrase is refused, the vault is as it was.
      const relaunched = open()
      expect(isWait(await errorOf(relaunched.unlock(PHRASE)))).toBe(true)
      expect(relaunched.isUnlocked()).toBe(false)
      expect(isWait(await errorOf(run(v, PHRASE)))).toBe(true)
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path, 'utf8')).toBe(sealed)
      expect(v.isUnlocked()).toBe(true)
      // Once the wait is over the right phrase goes through and clears the count.
      clock += 1000
      await run(v, PHRASE)
      expect(existsSync(attemptsPath)).toBe(false)
    })
  }

  it('shares one count between them and the opening: a wrong phrase on each path is three wrong phrases', async () => {
    const v = open()
    await v.create(PHRASE)
    expect(isWrongPhrase(await errorOf(v.changePhrase(wrong(1), NEXT)))).toBe(true)
    expect(isWrongPhrase(await errorOf(v.keyMaterial(wrong(2))))).toBe(true)
    expect(v.retryInMs()).toBe(0)
    expect(isWrongPhrase(await errorOf(v.destroy(wrong(3))))).toBe(true)
    expect(v.retryInMs()).toBe(1000)
    v.lock()
    expect(isWait(await errorOf(v.unlock(PHRASE)))).toBe(true)
  })

  it('clears the count with a right phrase on any of them', async () => {
    const v = open()
    await v.create(PHRASE)
    await errorOf(v.changePhrase(wrong(1), NEXT))
    await errorOf(v.changePhrase(wrong(2), NEXT))
    expect(existsSync(attemptsPath)).toBe(true)
    await v.changePhrase(PHRASE, NEXT)
    expect(existsSync(attemptsPath)).toBe(false)
    await errorOf(v.destroy(wrong(3)))
    await errorOf(v.destroy(wrong(4)))
    expect(v.retryInMs()).toBe(0)
  })
})

describe('Touch ID', () => {
  it('opens the vault with its key during the wait, which is not a phrase tried, and clears the count; a wrong key counts for nothing', async () => {
    const v = open()
    await v.create(PHRASE)
    const secret = await v.keyMaterial(PHRASE)
    v.lock()
    for (let n = 1; n <= 3; n++) await errorOf(v.unlock(wrong(n)))
    expect(v.retryInMs()).toBe(1000)
    await v.unlockWithKey(secret.material)
    expect(v.isUnlocked()).toBe(true)
    expect(v.retryInMs()).toBe(0)
    expect(existsSync(attemptsPath)).toBe(false)
    v.lock()
    await errorOf(v.unlockWithKey(Buffer.alloc(secret.material.length, 1)))
    await errorOf(v.unlockWithKey(Buffer.alloc(secret.material.length, 2)))
    await errorOf(v.unlockWithKey(Buffer.alloc(secret.material.length, 3)))
    expect(v.retryInMs()).toBe(0)
    expect(existsSync(attemptsPath)).toBe(false)
    secret.material.fill(0)
  })
})

describe('only a wrong phrase counts', () => {
  it('does not count a file that was tampered with, a missing vault or a locked vault', async () => {
    const v = await lockedVault()
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    const data = Buffer.from(envelope['data']!, 'base64')
    data[10] = data[10]! ^ 1
    writeFileSync(path, JSON.stringify({ ...envelope, data: data.toString('base64') }))
    for (let n = 0; n < 4; n++) {
      const error = await errorOf(open().unlock(PHRASE))
      expect(error).toBeInstanceOf(ExportCryptoError)
      expect((error as ExportCryptoError).kind).toBe('tampered')
    }
    rmSync(path)
    for (let n = 0; n < 4; n++) expect(await errorOf(open().unlock(PHRASE))).toMatchObject({ kind: 'missing' })
    expect(existsSync(attemptsPath)).toBe(false)
    expect(v.retryInMs()).toBe(0)
  })
})

describe('a vault that is new or gone has no past', () => {
  it('forgets the file of an earlier vault when a new one is made, and removes its own when it is deleted', async () => {
    writeFileSync(attemptsPath, JSON.stringify({ v: 1, failures: 8, until: START + 30_000 }))
    const v = open()
    expect(v.retryInMs()).toBe(30_000)
    await v.create(PHRASE)
    expect(v.retryInMs()).toBe(0)
    expect(existsSync(attemptsPath)).toBe(false)
    expect(open().retryInMs()).toBe(0)

    await errorOf(v.changePhrase(wrong(1), NEXT))
    expect(existsSync(attemptsPath)).toBe(true)
    await v.destroy(PHRASE)
    expect(existsSync(attemptsPath)).toBe(false)
    expect(open().retryInMs()).toBe(0)
  })

  it('removes a file it could not read when the vault is deleted: nothing of the old one is left for the next', async () => {
    await lockedVault()
    writeFileSync(attemptsPath, 'damaged by something else')
    const v = open()
    await v.unlock(PHRASE)
    await v.destroy(PHRASE)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(attemptsPath)).toBe(false)
  })
})

describe('a file that cannot shut the owner out for good', () => {
  const FUTURE = START + 10 * 365 * 24 * 3600 * 1000

  it('is no failure at all when it is damaged, of another shape, or too large to be ours', async () => {
    const bad = [
      '',
      'not json at all',
      '{"v":1,"failures":"8","until":1}',
      '{"v":1,"failures":-8,"until":99999999999999}',
      // A real count, padded past the size a file of ours has: it is not read.
      `{"v":1,"failures":8,"until":${START + 30_000}}${' '.repeat(2000)}`
    ]
    for (const content of bad) {
      // The vault is made first: making a vault removes the file of an earlier one.
      await lockedVault()
      writeFileSync(attemptsPath, content)
      const v = open()
      expect(v.retryInMs(), content.slice(0, 40)).toBe(0)
      await v.unlock(PHRASE)
      expect(v.isUnlocked()).toBe(true)
      rmSync(path)
    }
  })

  it('is no failure at all when it cannot be read, and the reason is logged as a code without the path', async () => {
    const v = await lockedVault()
    // A link to itself where the file goes: reading it fails with a code of the system, the same on every one. (A folder there is not it: on
    // Linux a folder weighs 4096 bytes, more than a file of ours, so it is set aside before any read, with nothing to log.)
    symlinkSync(attemptsPath, attemptsPath)
    const again = open()
    expect(again.retryInMs()).toBe(0)
    await again.unlock(PHRASE)
    expect(again.isUnlocked()).toBe(true)
    expect(logged.join('\n')).toMatch(/count of wrong phrases could not be read.*\(ELOOP\)/)
    expect(logged.join('\n')).not.toContain(dir)
    expect(v.isUnlocked()).toBe(false)
  })

  it('waits no longer than the schedule gives for the count, even when its end is years away', async () => {
    for (const [failures, expected] of [[3, 1000], [5, 4000], [20, 30_000]] as const) {
      writeFileSync(attemptsPath, JSON.stringify({ v: 1, failures, until: FUTURE }))
      expect(open().retryInMs(), `${failures} failures`).toBe(expected)
    }
    // A count the owner is still free in is no wait, whatever the end says.
    writeFileSync(attemptsPath, JSON.stringify({ v: 1, failures: 2, until: FUTURE }))
    expect(open().retryInMs()).toBe(0)
  })

  it('is not needed to go on: a disk that refuses the file is logged, the count of this run still holds, and the vault is not shut for it', async () => {
    const v = await lockedVault()
    // A folder where the temporary file goes: every write of the file fails.
    mkdirSync(`${attemptsPath}.tmp`)
    for (let n = 1; n <= 3; n++) expect(isWrongPhrase(await errorOf(v.unlock(wrong(n))))).toBe(true)
    expect(existsSync(attemptsPath)).toBe(false)
    expect(logged.join('\n')).toMatch(/count of wrong phrases could not be saved/)
    expect(logged.join('\n')).not.toContain(dir)
    // In this run the wait holds; and once it is over the right phrase opens the vault.
    expect(v.retryInMs()).toBe(1000)
    expect(isWait(await errorOf(v.unlock(PHRASE)))).toBe(true)
    clock += 1000
    await v.unlock(PHRASE)
    expect(v.isUnlocked()).toBe(true)
  })
})
