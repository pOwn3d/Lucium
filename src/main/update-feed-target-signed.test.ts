// The system a release file is for (shared/update-target.ts) is read from the bytes that the feed key signs: one key signs the feeds of macOS, Windows and Linux,
// so a signed file of one system served at the address of another is a valid file, and only what it says of itself keeps a copy from taking it.
// Every key here is a throw-away pair made by the test.
import { describe, expect, it } from 'vitest'
import { feedAnswer, updateOutcome, type FeedAnswer, type FeedResponse } from '@shared/update-check'
import type { FeedTarget } from '@shared/update-target'
import { newFeedKeyPair, signFeedText } from './update-feed-signature'
import { feedSignatureCheck } from './shell/update-signature'
import { writtenFeed } from './update-feed-keys.test-support'

const pair = newFeedKeyPair()
const MAC: FeedTarget = { platform: 'darwin', arch: 'arm64' }
const WINDOWS: FeedTarget = { platform: 'win32', arch: 'x64' }
const LINUX: FeedTarget = { platform: 'linux', arch: 'x64' }
const SUM = 'ab'.repeat(32)
const ADDRESS = 'https://lucium.app/updates/win32-x64/feed.json'

const release = (url: string) => ({ version: '1.2.0', updateTo: { version: '1.2.0', name: 'Lucium 1.2.0', notes: 'Essai.', pub_date: '2026-12-01T09:00:00Z', url, sha256: SUM, size: 138108571 } })
const windowsFile = { currentRelease: '1.2.0', platform: 'win32', arch: 'x64', kind: 'nsis', page: 'https://lucium.app/telecharger/', releases: [release('https://lucium.app/updates/win32-x64/Lucium-Setup-1.2.0-x64.exe')] }
const macFile = { currentRelease: '1.2.0', page: 'https://lucium.app/telecharger/', releases: [release('https://lucium.app/updates/darwin-arm64/Lucium-1.2.0-arm64.zip')] }
const signed = (feed: unknown): string => signFeedText(writtenFeed(feed), [pair.privatePem])

/** What a copy does with the bytes the server answered: the signature first, then the system it runs on. */
async function offered(text: string, running: FeedTarget): Promise<ReturnType<typeof updateOutcome>> {
  const bytes = new TextEncoder().encode(text)
  const response: FeedResponse = { ok: true, status: 200, url: ADDRESS, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }
  const answer: FeedAnswer = await feedAnswer(ADDRESS, response, feedSignatureCheck(ADDRESS, [pair.publicKey], () => undefined))
  return updateOutcome('1.1.7', ADDRESS, answer, running)
}

describe('the system of a signed release file', () => {
  it('is read by the system it is for, with the sum and the size of its installer', async () => {
    expect(await offered(signed(windowsFile), WINDOWS)).toMatchObject({ kind: 'available', offer: { version: '1.2.0', kind: 'nsis', sha256: SUM, size: 138108571 } })
  })

  it('is refused by every other system, whatever its valid signature: the feed of Windows served to a Mac or to Linux, the feed of macOS served to Windows', async () => {
    expect((await offered(signed(windowsFile), MAC)).kind).toBe('failed')
    expect((await offered(signed(windowsFile), LINUX)).kind).toBe('failed')
    expect((await offered(signed(macFile), WINDOWS)).kind).toBe('failed')
    expect((await offered(signed(macFile), LINUX)).kind).toBe('failed')
    // The file of macOS, signed as it always was, is still read by a Mac.
    expect(await offered(signed(macFile), MAC)).toMatchObject({ kind: 'available', offer: { sha256: SUM } })
  })

  it('cannot be turned into the file of another system after it was signed: platform, arch, kind, sum and installer are all under the signature', async () => {
    const text = signed(windowsFile)
    const changes: Array<[string, string, string]> = [
      ['the platform', '"platform": "win32"', '"platform": "darwin"'],
      ['the architecture', '"arch": "x64"', '"arch": "arm64"'],
      ['the kind', '"kind": "nsis"', '"kind": "zip"'],
      ['the sum', `"sha256": "${SUM}"`, `"sha256": "${'cd'.repeat(32)}"`],
      ['the installer', 'Lucium-Setup-1.2.0-x64.exe', 'Lucium-Setup-1.2.0-evil.exe']
    ]
    for (const [what, from, to] of changes) {
      expect(text, what).toContain(from)
      const answer = await offered(text.replace(from, to), what === 'the platform' ? { platform: 'darwin', arch: 'x64' } : WINDOWS)
      expect(answer.kind, what).toBe('failed')
      expect(answer.kind === 'failed' && answer.reason, what).toMatch(/signature/i)
    }
  })

  it('cannot be given the system by a key added after the signature: the keys outside the signed bytes are never read', async () => {
    const text = signed(macFile)
    // A "platform" written after the signatures changes the file the server holds, not the bytes that were signed: the signature then no longer closes the file.
    const forged = text.replace(/\n}\n$/, ',\n  "platform": "win32",\n  "arch": "x64",\n  "kind": "nsis"\n}\n')
    expect((await offered(forged, WINDOWS)).kind).toBe('failed')
    expect((await offered(forged, MAC)).kind).toBe('failed')
  })
})
