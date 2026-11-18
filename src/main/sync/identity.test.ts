// The identity of the Mac for the synchronisation (docs/synchronisation.md §3.2, §3.3), with files in a scratch folder and a stand-in for the sealing.
import { X509Certificate } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from '../temp-dir'
import { fingerprintOf, keyMatchesCertificate } from './certificate'
import { IdentityNotOpenableError, IdentityStore } from './identity'
import type { SecretBox } from './secret-box'

/** A box that seals by xor-ing with a key of its own: opening what another box sealed fails, as safeStorage does on another machine. */
function box(key: number, available = true): SecretBox {
  const mix = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte) => byte ^ key))
  return {
    available: () => available,
    seal: (plain) => Buffer.concat([Buffer.from([key]), mix(plain)]),
    open: (sealed) => {
      if (sealed[0] !== key) throw new Error('this machine cannot open it')
      return mix(sealed.subarray(1))
    }
  }
}

const quiet = (): ReturnType<typeof vi.spyOn> => vi.spyOn(console, 'error').mockImplementation(() => undefined)

describe('IdentityStore', () => {
  it('makes the identity the first time and gives the same one the next time', () => {
    const path = join(tempDir('lucium-sync-id-'), 'sync-identity.json')
    const store = new IdentityStore(path, box(7))
    expect(store.exists()).toBe(false)
    const first = store.loadOrCreate()
    expect(first).toMatchObject({ created: true, replaced: false })
    const again = new IdentityStore(path, box(7)).loadOrCreate()
    expect(again).toMatchObject({ created: false, replaced: false })
    expect(again.identity.deviceId).toBe(first.identity.deviceId)
    expect(again.identity.fingerprint.equals(first.identity.fingerprint)).toBe(true)
    expect(again.identity.certificate.equals(first.identity.certificate)).toBe(true)
  })

  it('has a device identifier of 16 random bytes in base64url, and a fingerprint that is the SHA-256 of the certificate', () => {
    const { identity } = new IdentityStore(join(tempDir('lucium-sync-id-'), 'id.json'), box(1)).loadOrCreate()
    expect(identity.deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(identity.fingerprint.equals(fingerprintOf(identity.certificate))).toBe(true)
    expect(new X509Certificate(identity.certificate).subject).toBe('CN=lucium-sync')
  })

  it('writes the key sealed, never in the clear: no byte of the PKCS#8 key is in the file', () => {
    const path = join(tempDir('lucium-sync-id-'), 'id.json')
    const { identity } = new IdentityStore(path, box(9)).loadOrCreate()
    const text = readFileSync(path, 'utf8')
    const pkcs8 = identity.privateKey.export({ type: 'pkcs8', format: 'der' })
    expect(text).not.toContain(pkcs8.toString('base64'))
    expect(text).not.toContain(pkcs8.subarray(0, 24).toString('base64').slice(0, 20))
    expect(text).not.toMatch(/PRIVATE KEY/)
    expect(JSON.parse(text)).toMatchObject({ version: 1 })
  })

  // POSIX modes: Windows keeps none, and root writes where a folder is closed.
  it.skipIf(process.platform === 'win32')('writes a file only its owner reads', () => {
    const path = join(tempDir('lucium-sync-id-'), 'id.json')
    new IdentityStore(path, box(2)).loadOrCreate()
    expect(statSync(path).mode & 0o077).toBe(0)
  })

  it('refuses to make an identity when the system cannot seal a key, and writes nothing', () => {
    const path = join(tempDir('lucium-sync-id-'), 'id.json')
    expect(() => new IdentityStore(path, box(3, false)).loadOrCreate()).toThrow(/cannot seal/)
    expect(existsSync(path)).toBe(false)
  })

  // Review n° 22: a keychain that refuses for a moment must not make the paired devices forget.
  it('does not replace an identity it cannot open until it is told to: the file is left as it was, and a key that opens again gives the same identity', () => {
    const log = quiet()
    const path = join(tempDir('lucium-sync-id-'), 'id.json')
    const old = new IdentityStore(path, box(4)).loadOrCreate().identity
    const before = readFileSync(path, 'utf8')
    const refusing = new IdentityStore(path, box(5))
    expect(refusing.load()).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot be opened on this machine'), expect.anything())
    expect(() => refusing.loadOrCreate()).toThrow(IdentityNotOpenableError)
    expect(readFileSync(path, 'utf8')).toBe(before)
    // The keychain answers again: it is the same identity, nothing was lost.
    const again = new IdentityStore(path, box(4)).loadOrCreate()
    expect(again).toMatchObject({ created: false, replaced: false })
    expect(again.identity.fingerprint.equals(old.fingerprint)).toBe(true)
    log.mockRestore()
  })

  it('replaces an identity it cannot open on this machine (a restored profile) once it is told to, and says so', () => {
    const log = quiet()
    const path = join(tempDir('lucium-sync-id-'), 'id.json')
    const old = new IdentityStore(path, box(4)).loadOrCreate().identity
    const made = new IdentityStore(path, box(5)).loadOrCreate({ replaceUnopenable: true })
    expect(made).toMatchObject({ created: true, replaced: true })
    expect(made.identity.fingerprint.equals(old.fingerprint)).toBe(false)
    expect(made.identity.deviceId).not.toBe(old.deviceId)
    log.mockRestore()
  })

  it('replaces at once a file that is not an identity at all (not ours, a certificate that does not parse, a key that is not the certificate\'s): nothing could make it open later', () => {
    const log = quiet()
    const dir = tempDir('lucium-sync-id-')
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    new IdentityStore(a, box(6)).loadOrCreate()
    new IdentityStore(b, box(6)).loadOrCreate()
    writeFileSync(a, JSON.stringify({ ...(JSON.parse(readFileSync(a, 'utf8')) as Record<string, unknown>), sealedKey: (JSON.parse(readFileSync(b, 'utf8')) as { sealedKey: string }).sealedKey }))
    expect(new IdentityStore(a, box(6)).loadOrCreate()).toMatchObject({ created: true, replaced: true })
    writeFileSync(b, 'definitely not json')
    expect(new IdentityStore(b, box(6)).loadOrCreate()).toMatchObject({ created: true, replaced: true })
    log.mockRestore()
  })

  it('does not take a key that does not belong to the certificate', () => {
    const log = quiet()
    const dir = tempDir('lucium-sync-id-')
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    new IdentityStore(a, box(6)).loadOrCreate()
    new IdentityStore(b, box(6)).loadOrCreate()
    const mixed = { ...(JSON.parse(readFileSync(a, 'utf8')) as Record<string, unknown>), sealedKey: (JSON.parse(readFileSync(b, 'utf8')) as { sealedKey: string }).sealedKey }
    writeFileSync(a, JSON.stringify(mixed))
    expect(new IdentityStore(a, box(6)).load()).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('does not belong to its certificate'))
    log.mockRestore()
  })

  it.each([
    ['not JSON', () => 'definitely not json'],
    ['a list', () => '[]'],
    ['another version', (r: Record<string, unknown>) => JSON.stringify({ ...r, version: 2 })],
    ['a device identifier with a space', (r: Record<string, unknown>) => JSON.stringify({ ...r, deviceId: 'a b' })],
    ['a device identifier of 65 characters', (r: Record<string, unknown>) => JSON.stringify({ ...r, deviceId: 'a'.repeat(65) })],
    ['a certificate that is not base64', (r: Record<string, unknown>) => JSON.stringify({ ...r, certificate: '***' })],
    ['a certificate that Node cannot read', (r: Record<string, unknown>) => JSON.stringify({ ...r, certificate: 'AAAA' })],
    ['a sealed key that is not base64', (r: Record<string, unknown>) => JSON.stringify({ ...r, sealedKey: '***' })],
    ['no creation date', (r: Record<string, unknown>) => JSON.stringify({ ...r, createdAt: 'yesterday' })]
  ])('treats a file that is %s as no identity, and logs it', (_name, damage) => {
    const log = quiet()
    const path = join(tempDir('lucium-sync-id-'), 'id.json')
    new IdentityStore(path, box(8)).loadOrCreate()
    const good = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(new IdentityStore(path, box(8)).load()).not.toBeNull()
    writeFileSync(path, damage(good))
    expect(new IdentityStore(path, box(8)).load()).toBeNull()
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('does not read a file larger than a small file may be (a hostile file is not read whole)', () => {
    const log = quiet()
    const path = join(tempDir('lucium-sync-id-'), 'id.json')
    writeFileSync(path, 'x'.repeat(1024 * 1024 + 1))
    expect(new IdentityStore(path, box(8)).load()).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot read'), expect.anything())
    log.mockRestore()
  })

  it('forgets the identity: the next switching on makes a new one', () => {
    const path = join(tempDir('lucium-sync-id-'), 'id.json')
    const store = new IdentityStore(path, box(1))
    const first = store.loadOrCreate().identity
    store.forget()
    expect(existsSync(path)).toBe(false)
    const second = store.loadOrCreate()
    expect(second).toMatchObject({ created: true, replaced: false })
    expect(second.identity.fingerprint.equals(first.fingerprint)).toBe(false)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('throws, and leaves nothing behind, when the file cannot be written', () => {
    const dir = tempDir('lucium-sync-id-')
    chmodSync(dir, 0o500)
    expect(() => new IdentityStore(join(dir, 'id.json'), box(1)).loadOrCreate()).toThrow()
    chmodSync(dir, 0o700)
    expect(existsSync(join(dir, 'id.json'))).toBe(false)
  })

  it('gives a key that matches its certificate, as TLS will need it', () => {
    const { identity } = new IdentityStore(join(tempDir('lucium-sync-id-'), 'id.json'), box(1)).loadOrCreate()
    expect(keyMatchesCertificate(identity.privateKey.export({ type: 'pkcs8', format: 'der' }), identity.certificate)).toBe(true)
  })
})
