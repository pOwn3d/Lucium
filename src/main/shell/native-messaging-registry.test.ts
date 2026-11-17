import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostRegistryKey } from '@shared/native-messaging'
import { NATIVE_ERRORS } from '@shared/native-messaging'
import { onWindows } from '../windows.test-support'
import { NativeHosts } from './native-messaging'
import { exportRegistryKey, registeredManifests, type RunProgram } from './native-messaging-registry'

const reg = (value: string | null) => `Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\x]\r\n${value === null ? '' : `@="${value.replaceAll('\\', '\\\\')}"\r\n`}\r\n`
const collect = async (generator: AsyncIterable<string>): Promise<string[]> => {
  const all: string[] = []
  for await (const path of generator) all.push(path)
  return all
}

describe('registeredManifests', () => {
  it('asks for the keys in Chrome\'s order and gives the manifests they name, in that order', async () => {
    const asked: string[] = []
    const answers: Record<string, string | null> = { 'HKCU 32': null, 'HKCU 64': reg('C:\\user\\m.json'), 'HKLM 32': reg('C:\\machine32\\m.json'), 'HKLM 64': reg('C:\\machine64\\m.json') }
    const exportKey = async (key: HostRegistryKey) => {
      asked.push(`${key.hive} ${key.view}`)
      return answers[`${key.hive} ${key.view}`] ?? null
    }
    expect(await collect(registeredManifests('com.example.host', true, 'win32', exportKey))).toEqual(['C:\\user\\m.json', 'C:\\machine32\\m.json', 'C:\\machine64\\m.json'])
    expect(asked).toEqual(['HKCU 32', 'HKCU 64', 'HKLM 32', 'HKLM 64'])
  })

  it('does not ask for the keys after the one that answered when the caller stops there', async () => {
    const asked: string[] = []
    const exportKey = async (key: HostRegistryKey) => {
      asked.push(`${key.hive} ${key.view}`)
      return reg('C:\\first\\m.json')
    }
    for await (const path of registeredManifests('com.example.host', true, 'win32', exportKey)) {
      expect(path).toBe('C:\\first\\m.json')
      break
    }
    expect(asked).toEqual(['HKCU 32'])
  })

  it('names a manifest once, even when the views both hold it', async () => {
    expect(await collect(registeredManifests('com.example.host', true, 'win32', async () => reg('C:\\same\\m.json')))).toEqual(['C:\\same\\m.json'])
  })

  it('asks for nothing unless the user allowed the hosts of Chrome, and nothing off Windows', async () => {
    const exportKey = vi.fn(async () => reg('C:\\m.json'))
    expect(await collect(registeredManifests('com.example.host', false, 'win32', exportKey))).toEqual([])
    expect(await collect(registeredManifests('com.example.host', true, 'darwin', exportKey))).toEqual([])
    expect(await collect(registeredManifests('com.example.host', true, 'linux', exportKey))).toEqual([])
    expect(exportKey).not.toHaveBeenCalled()
  })

  it('ignores a key without a value, and a value that is not a local path, saying so in the journal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const values = [reg(null), reg('\\\\server\\share\\m.json'), reg('relative\\m.json'), reg('C:\\ok\\m.json')]
      let call = 0
      expect(await collect(registeredManifests('com.example.host', true, 'win32', async () => values[call++] ?? null))).toEqual(['C:\\ok\\m.json'])
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('\\\\server\\share\\m.json'))
    } finally {
      warn.mockRestore()
    }
  })

  it('lets a failure of the registry through: it is not a host that is missing', async () => {
    await expect(collect(registeredManifests('com.example.host', true, 'win32', async () => Promise.reject(new Error('reg.exe did not answer'))))).rejects.toThrow('reg.exe did not answer')
  })
})

describe('exportRegistryKey, with a stand-in for reg.exe', () => {
  const key: HostRegistryKey = { hive: 'HKCU', view: 64, key: 'Software\\Google\\Chrome\\NativeMessagingHosts\\com.example.host' }
  const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])

  /** A reg.exe that writes `file` (the third argument) the way the real one does, or exits with a status, or does not run. */
  const stand = (behaviour: { write?: Buffer; fail?: Error & { code?: unknown; killed?: boolean }; calls?: string[][] }): RunProgram => (_file, args, _options, done) => {
    behaviour.calls?.push(args)
    if (behaviour.write) writeFileSync(args[2]!, behaviour.write)
    done(behaviour.fail ?? null)
    return new PassThrough()
  }

  it('asks reg.exe to export the key of that hive and that view to a file, and reads the file as UTF-16', async () => {
    const calls: string[][] = []
    const text = await exportRegistryKey(key, stand({ write: utf16(reg('C:\\Users\\Léa\\m.json')), calls }))
    expect(text).toContain('@="C:\\\\Users\\\\Léa\\\\m.json"')
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('export')
    expect(calls[0]![1]).toBe(`HKCU\\${key.key}`)
    expect(calls[0]!.slice(3)).toEqual(['/y', '/reg:64'])
  })

  it('takes a status of reg.exe for "no such key", and anything else for a failure', async () => {
    expect(await exportRegistryKey(key, stand({ fail: Object.assign(new Error('exit 1'), { code: 1 }) }))).toBeNull()
    await expect(exportRegistryKey(key, stand({ fail: Object.assign(new Error('spawn reg.exe ENOENT'), { code: 'ENOENT' }) }))).rejects.toThrow('ENOENT')
    await expect(exportRegistryKey(key, stand({ fail: Object.assign(new Error('timed out'), { code: 1, killed: true }) }))).rejects.toThrow('timed out')
  })

  it('fails, and does not say "no such key", when the file it wrote cannot be read', async () => {
    await expect(exportRegistryKey(key, stand({ write: Buffer.alloc(300 * 1024) }))).rejects.toThrow('too-large')
    await expect(exportRegistryKey(key, stand({ write: Buffer.from([0xff, 0xfe, 0x41]) }))).rejects.toThrow('not-text')
    await expect(exportRegistryKey(key, stand({}))).rejects.toThrow('not-found')
  })

  it('leaves nothing in the temporary folder', async () => {
    let file = ''
    const run: RunProgram = (_program, args, _options, done) => {
      file = args[2]!
      writeFileSync(file, utf16(reg('C:\\m.json')))
      done(null)
      return new PassThrough()
    }
    await exportRegistryKey(key, run)
    expect(() => realpathSync(file)).toThrow()
  })
})

// The real reg.exe, on the Windows runner (.github/workflows/windows.yml): a host key written under the user's root, as an installer of a host writes it.
describe.skipIf(!onWindows)('the registry of Windows, read with the reg.exe of the system', () => {
  const name = `com.lucium_test.c427_${process.pid}_${Date.now()}`
  const keyPath = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${name}`
  let root = ''

  afterEach(() => {
    try {
      execFileSync('reg.exe', ['delete', keyPath, '/f'], { stdio: 'ignore' })
    } catch {
      // Nothing was written by the test that did not need it.
    }
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('finds no manifest for a host that no key names, and does not fail for it', async () => {
    expect(await collect(registeredManifests(name, true, 'win32'))).toEqual([])
  })

  it('reads the manifest a key of the user names, accents and spaces in the path included', async () => {
    root = mkdtempSync(join(tmpdir(), 'lucium é registre-'))
    const manifest = join(root, 'Hôte natif', 'com.example.json')
    execFileSync('reg.exe', ['add', keyPath, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f', '/reg:64'], { stdio: 'ignore' })
    expect(await collect(registeredManifests(name, true, 'win32'))).toEqual([manifest])
  })

  it('reads the root of the machine, in both views of the registry', async () => {
    // A key every Windows has, small and without sub-keys (an export goes down the tree: a key of Software\Microsoft holds far more than the bound).
    for (const view of [32, 64] as const) {
      const text = await exportRegistryKey({ hive: 'HKLM', view, key: 'SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage' })
      expect(text).toContain('Windows Registry Editor Version 5.00')
      expect(text).toContain('[HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage]')
    }
  })

  it('starts the host a key names, from the manifest it names, through the whole chain', async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'lucium é hôte-')))
    mkdirSync(join(root, 'Hôte natif'))
    const program = join(root, 'Hôte natif', 'host.exe')
    writeFileSync(program, 'MZ')
    const manifest = join(root, 'Hôte natif', `${name}.json`)
    const extension = 'abcdefghijklmnopabcdefghijklmnop'
    writeFileSync(manifest, JSON.stringify({ name, description: 'x', path: program, type: 'stdio', allowed_origins: [`chrome-extension://${extension}/`] }))
    execFileSync('reg.exe', ['add', keyPath, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f', '/reg:64'], { stdio: 'ignore' })
    const spawned: string[] = []
    const events: unknown[] = []
    const hosts = new NativeHosts({
      dirs: () => [],
      registryManifests: (hostName) => registeredManifests(hostName, true, 'win32'),
      spawn: ((path: string) => {
        spawned.push(path)
        throw new Error('stand-in: not started')
      }) as never,
      deliver: (_ext, _port, event) => events.push(event),
      platform: 'win32'
    })
    hosts.connect(extension, name, 'p1')
    for (let i = 0; i < 100 && events.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50))
    // The program the registry led to was the one asked for (the stand-in refuses to start it, which is the failure the extension sees).
    expect(spawned).toEqual([program])
    expect(events).toEqual([{ type: 'disconnect', error: NATIVE_ERRORS.startFailed }])
    hosts.closeAll()
  })
})
