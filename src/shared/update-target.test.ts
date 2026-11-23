import { describe, expect, it } from 'vitest'
import { INSTALLER_KINDS, SHA256_HEX, readFeedIdentity, runningTarget, type FeedTarget } from './update-target'

const MAC: FeedTarget = { platform: 'darwin', arch: 'arm64' }
const WINDOWS: FeedTarget = { platform: 'win32', arch: 'x64' }
const LINUX_X64: FeedTarget = { platform: 'linux', arch: 'x64' }
const LINUX_ARM: FeedTarget = { platform: 'linux', arch: 'arm64' }
const SYSTEMS = [MAC, WINDOWS, LINUX_X64, LINUX_ARM]
const idOf = (target: FeedTarget): string => `${target.platform}-${target.arch}`
const says = (target: FeedTarget, kind?: string): Record<string, unknown> => ({ platform: target.platform, arch: target.arch, ...(kind === undefined ? {} : { kind }) })

describe('runningTarget', () => {
  it('is the platform and the architecture of the process, any Unix other than macOS counting as Linux', () => {
    expect(runningTarget('darwin', 'arm64')).toEqual(MAC)
    expect(runningTarget('win32', 'x64')).toEqual(WINDOWS)
    expect(runningTarget('linux', 'arm64')).toEqual(LINUX_ARM)
    expect(runningTarget('freebsd', 'x64')).toEqual(LINUX_X64)
  })

  it('has an empty architecture for anything that is not a word: it matches no file', () => {
    expect(runningTarget('linux', undefined).arch).toBe('')
  })
})

describe('readFeedIdentity: a file is read only by the system it is for', () => {
  it('takes a file that says it is for this system, with the installer it names', () => {
    expect(readFeedIdentity(says(MAC, 'zip'), MAC)).toEqual({ ok: true, kind: 'zip', legacy: false })
    expect(readFeedIdentity(says(WINDOWS, 'nsis'), WINDOWS)).toEqual({ ok: true, kind: 'nsis', legacy: false })
    expect(readFeedIdentity(says(LINUX_X64, 'appimage'), LINUX_X64)).toEqual({ ok: true, kind: 'appimage', legacy: false })
    expect(readFeedIdentity(says(LINUX_ARM, 'deb'), LINUX_ARM)).toEqual({ ok: true, kind: 'deb', legacy: false })
  })

  it('refuses a file for another system, every pair of the four: only a system reads its own', () => {
    for (const file of SYSTEMS) {
      const kind = INSTALLER_KINDS[idOf(file)]![0]
      for (const reader of SYSTEMS) {
        expect(readFeedIdentity(says(file, kind), reader).ok, `${idOf(file)} read by ${idOf(reader)}`).toBe(file === reader)
      }
    }
  })

  it('refuses a file for the same system of another architecture, and a file for a system no build exists for, even on that system', () => {
    expect(readFeedIdentity(says(LINUX_X64, 'appimage'), LINUX_ARM).ok).toBe(false)
    expect(readFeedIdentity(says({ platform: 'darwin', arch: 'x64' }, 'zip'), { platform: 'darwin', arch: 'x64' }).ok).toBe(false)
    expect(readFeedIdentity(says({ platform: 'win32', arch: 'arm64' }, 'nsis'), { platform: 'win32', arch: 'arm64' }).ok).toBe(false)
  })

  it('takes no word of Object.prototype for a system', () => {
    for (const word of ['__proto__', 'constructor', 'toString']) {
      expect(readFeedIdentity({ platform: word, arch: word, kind: 'zip' }, { platform: 'linux', arch: word }).ok, word).toBe(false)
    }
  })

  it('refuses a file that gives only a part of its identity, or gives it as something else than words', () => {
    expect(readFeedIdentity({ platform: 'win32', kind: 'nsis' }, WINDOWS).ok).toBe(false)
    expect(readFeedIdentity({ arch: 'x64', kind: 'nsis' }, WINDOWS).ok).toBe(false)
    expect(readFeedIdentity({ kind: 'zip' }, MAC).ok).toBe(false)
    expect(readFeedIdentity({ platform: ['win32'], arch: 'x64', kind: 'nsis' }, WINDOWS).ok).toBe(false)
    expect(readFeedIdentity({ platform: 'win32', arch: 64, kind: 'nsis' }, WINDOWS).ok).toBe(false)
    expect(readFeedIdentity({ platform: null, arch: null, kind: null }, WINDOWS).ok).toBe(false)
  })

  it('refuses an installer the system does not take, and an installer that is not named where it must be', () => {
    expect(readFeedIdentity(says(WINDOWS, 'zip'), WINDOWS).ok).toBe(false)
    expect(readFeedIdentity(says(WINDOWS, 'appimage'), WINDOWS).ok).toBe(false)
    expect(readFeedIdentity(says(LINUX_X64, 'nsis'), LINUX_X64).ok).toBe(false)
    expect(readFeedIdentity(says(LINUX_X64, 'rpm'), LINUX_X64).ok).toBe(false)
    expect(readFeedIdentity(says(MAC, 'nsis'), MAC).ok).toBe(false)
    expect(readFeedIdentity(says(WINDOWS), WINDOWS).ok).toBe(false)
    expect(readFeedIdentity(says(LINUX_X64), LINUX_X64).ok).toBe(false)
    expect(readFeedIdentity({ ...says(WINDOWS), kind: 7 }, WINDOWS).ok).toBe(false)
  })

  it('reads a file for macOS that names no installer as the archive Squirrel installs', () => {
    expect(readFeedIdentity(says(MAC), MAC)).toEqual({ ok: true, kind: 'zip', legacy: false })
  })

  it('reads the files written before the keys existed as the files of macOS, for a Mac only', () => {
    expect(readFeedIdentity({}, MAC)).toEqual({ ok: true, kind: 'zip', legacy: true })
    for (const reader of [WINDOWS, LINUX_X64, LINUX_ARM]) expect(readFeedIdentity({}, reader).ok, idOf(reader)).toBe(false)
  })
})

describe('SHA256_HEX', () => {
  it('is 64 lowercase hexadecimal digits, as the release file writes it', () => {
    expect(SHA256_HEX.test('ab'.repeat(32))).toBe(true)
    for (const bad of ['', 'ab'.repeat(31), 'ab'.repeat(33), 'AB'.repeat(32), `${'a'.repeat(63)}g`, ` ${'a'.repeat(64)}`, `${'a'.repeat(64)}\n`]) expect(SHA256_HEX.test(bad), bad).toBe(false)
  })
})
