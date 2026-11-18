// The sealing of the device key by `safeStorage` (docs/synchronisation.md §3.3), with a stand-in for Electron: the bytes travel as base64 text, both ways.
import { describe, expect, it, vi } from 'vitest'

const calls: string[] = []
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => {
      calls.push(`encrypt:${plain}`)
      return Buffer.from(`sealed(${plain})`)
    },
    decryptString: (sealed: Buffer) => {
      calls.push('decrypt')
      return /^sealed\((.*)\)$/.exec(sealed.toString())?.[1] ?? ''
    }
  }
}))

describe('electronSecretBox', () => {
  it('seals the bytes as base64 text and opens them back to the same bytes', async () => {
    const { electronSecretBox } = await import('./secret-box-electron')
    const box = electronSecretBox()
    const key = Buffer.from([0, 1, 2, 250, 251, 252, 255])
    expect(box.available()).toBe(true)
    const sealed = box.seal(key)
    expect(calls).toContain(`encrypt:${key.toString('base64')}`)
    expect(box.open(sealed).equals(key)).toBe(true)
  })

  it('does not hand the key to the system in any other form than a base64 string', async () => {
    calls.length = 0
    const { electronSecretBox } = await import('./secret-box-electron')
    electronSecretBox().seal(Buffer.from('abc'))
    expect(calls).toEqual(['encrypt:YWJj'])
  })
})
