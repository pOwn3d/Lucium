import { describe, expect, it } from 'vitest'
import { checkHostManifest, encodeFrame, FrameDecoder, hostEnvironment, isValidHostName, isRegistryManifestPath, MAX_HOST_MESSAGE_BYTES, NATIVE_ERRORS, nativeHostDirs, nativeHostRegistryKeys, parseRegistryExport } from './native-messaging'

const bytes = (text: string) => new TextEncoder().encode(text)
const frameOf = (json: string) => {
  const body = bytes(json)
  const frame = new Uint8Array(4 + body.length)
  new DataView(frame.buffer).setUint32(0, body.length, true)
  frame.set(body, 4)
  return frame
}

describe('encodeFrame', () => {
  it('puts the number of BYTES of the UTF-8 text in the 4-byte little-endian prefix', () => {
    const frame = encodeFrame({ text: 'héllo ✓ 日本' })
    const json = JSON.stringify({ text: 'héllo ✓ 日本' })
    expect(new DataView(frame.buffer).getUint32(0, true)).toBe(bytes(json).length)
    expect(bytes(json).length).toBeGreaterThan(json.length)
    expect(new TextDecoder().decode(frame.subarray(4))).toBe(json)
  })

  it('refuses what JSON cannot carry', () => {
    expect(() => encodeFrame(undefined)).toThrow('cannot be serialized')
  })
})

describe('FrameDecoder', () => {
  it('reads one message', () => {
    expect(new FrameDecoder().push(encodeFrame({ a: 1 }))).toEqual({ messages: [{ a: 1 }], error: null })
  })

  it('reads several messages that arrive in one chunk', () => {
    const joined = new Uint8Array([...encodeFrame({ n: 1 }), ...encodeFrame({ n: 2 })])
    expect(new FrameDecoder().push(joined).messages).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('keeps half a message until the rest arrives, even when the split is inside the length prefix or inside a character', () => {
    const frame = encodeFrame({ text: 'é✓' })
    for (const cut of [1, 3, 5, frame.length - 2]) {
      const decoder = new FrameDecoder()
      expect(decoder.push(frame.subarray(0, cut))).toEqual({ messages: [], error: null })
      expect(decoder.push(frame.subarray(cut)).messages).toEqual([{ text: 'é✓' }])
    }
  })

  it('reads a message larger than one chunk (the stream of a pipe is cut at 64 KiB)', () => {
    const big = { data: 'x'.repeat(300_000) }
    const frame = encodeFrame(big)
    const decoder = new FrameDecoder()
    const seen: unknown[] = []
    for (let i = 0; i < frame.length; i += 65_536) seen.push(...decoder.push(frame.subarray(i, i + 65_536)).messages)
    expect(seen).toEqual([big])
  })

  it('ends the stream with an I/O error when a host announces more than 1 MiB, and reads nothing after', () => {
    const decoder = new FrameDecoder()
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(0, MAX_HOST_MESSAGE_BYTES + 1, true)
    expect(decoder.push(header).error).toBe(NATIVE_ERRORS.io)
    expect(decoder.push(encodeFrame({ ok: true }))).toEqual({ messages: [], error: NATIVE_ERRORS.io })
  })

  it('accepts a message of exactly 1 MiB', () => {
    const text = JSON.stringify('x'.repeat(MAX_HOST_MESSAGE_BYTES - 2))
    expect(bytes(text).length).toBe(MAX_HOST_MESSAGE_BYTES)
    expect(new FrameDecoder().push(frameOf(text)).error).toBeNull()
  })

  it('ends the stream when a frame is not JSON, keeping the messages read before it', () => {
    const joined = new Uint8Array([...encodeFrame({ n: 1 }), ...frameOf('not json')])
    expect(new FrameDecoder().push(joined)).toEqual({ messages: [{ n: 1 }], error: NATIVE_ERRORS.io })
  })

  it('reads a large message that arrives a byte at a time as fast as one that arrives whole (the cost does not grow with the square of its size)', () => {
    const payload = { data: 'x'.repeat(200_000) }
    const frame = encodeFrame(payload)
    const decoder = new FrameDecoder()
    const seen: unknown[] = []
    const start = performance.now()
    for (let i = 0; i < frame.length; i++) seen.push(...decoder.push(frame.subarray(i, i + 1)).messages)
    expect(seen).toEqual([payload])
    expect(performance.now() - start).toBeLessThan(400)
  })

  it('reads many small messages that straddle the chunks, after the buffer was reused several times', () => {
    const frames = Array.from({ length: 500 }, (_, n) => encodeFrame({ n, pad: 'y'.repeat(n % 97) }))
    const stream = new Uint8Array(frames.reduce((total, f) => total + f.length, 0))
    let offset = 0
    for (const f of frames) {
      stream.set(f, offset)
      offset += f.length
    }
    const decoder = new FrameDecoder()
    const seen: Array<{ n: number }> = []
    for (let i = 0; i < stream.length; i += 61) seen.push(...(decoder.push(stream.subarray(i, i + 61)).messages as Array<{ n: number }>))
    expect(seen.map((m) => m.n)).toEqual(frames.map((_, n) => n))
  })

  it('ends the stream when a frame is not valid UTF-8', () => {
    const frame = new Uint8Array([2, 0, 0, 0, 0xff, 0xfe])
    expect(new FrameDecoder().push(frame).error).toBe(NATIVE_ERRORS.io)
  })
})

describe('isValidHostName', () => {
  it('accepts dotted lowercase names with digits and underscores', () => {
    expect(isValidHostName('com.anthropic.claude_browser_extension')).toBe(true)
    expect(isValidHostName('host')).toBe(true)
  })

  it('refuses what could escape the manifest folder or is not a name', () => {
    for (const name of ['', '../evil', 'a/b', 'A.b', 'a..b', '.a', 'a.', 'a b', 'a\\b', 42, null, 'a'.repeat(256)]) expect(isValidHostName(name)).toBe(false)
  })
})

describe('checkHostManifest', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop'
  const manifest = (patch: Record<string, unknown> = {}) =>
    JSON.stringify({ name: 'com.example.host', description: 'x', path: '/usr/local/bin/host', type: 'stdio', allowed_origins: [`chrome-extension://${id}/`], ...patch })

  it('accepts a manifest that names the host and allows the extension', () => {
    expect(checkHostManifest(manifest(), 'com.example.host', id)).toEqual({
      ok: true,
      manifest: { name: 'com.example.host', path: '/usr/local/bin/host', allowedOrigins: [`chrome-extension://${id}/`] }
    })
  })

  it('refuses an extension that is not in allowed_origins', () => {
    expect(checkHostManifest(manifest(), 'com.example.host', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toEqual({ ok: false, error: NATIVE_ERRORS.forbidden })
    expect(checkHostManifest(manifest({ allowed_origins: ['chrome-extension://*/'] }), 'com.example.host', id)).toEqual({ ok: false, error: NATIVE_ERRORS.forbidden })
  })

  it('refuses a manifest for another host, another type, a relative path or broken JSON', () => {
    const failed = { ok: false, error: NATIVE_ERRORS.startFailed }
    expect(checkHostManifest(manifest({ name: 'com.example.other' }), 'com.example.host', id)).toEqual(failed)
    expect(checkHostManifest(manifest({ type: 'http' }), 'com.example.host', id)).toEqual(failed)
    expect(checkHostManifest(manifest({ path: 'bin/host' }), 'com.example.host', id)).toEqual(failed)
    expect(checkHostManifest(manifest({ path: 7 }), 'com.example.host', id)).toEqual(failed)
    expect(checkHostManifest('{', 'com.example.host', id)).toEqual(failed)
  })
})

describe('nativeHostDirs', () => {
  it('looks only in the data folder of Lucium unless the user chose otherwise', () => {
    expect(nativeHostDirs('/data/lucium', '/Users/me', false)).toEqual(['/data/lucium/NativeMessagingHosts'])
  })

  it('adds the folders of Chrome, the user\'s first and the system-wide one, when asked', () => {
    expect(nativeHostDirs('/data/lucium', '/Users/me', true)).toEqual([
      '/data/lucium/NativeMessagingHosts',
      '/Users/me/Library/Application Support/Google/Chrome/NativeMessagingHosts',
      '/Library/Google/Chrome/NativeMessagingHosts'
    ])
  })
})

describe('nativeHostRegistryKeys', () => {
  const KEY = 'Software\\Google\\Chrome\\NativeMessagingHosts\\com.example.host'

  it('names the keys of Chrome in its order: the 32-bit view before the 64-bit one, the user before the machine', () => {
    expect(nativeHostRegistryKeys('com.example.host', true, 'win32')).toEqual([
      { hive: 'HKCU', view: 32, key: KEY },
      { hive: 'HKCU', view: 64, key: KEY },
      { hive: 'HKLM', view: 32, key: KEY },
      { hive: 'HKLM', view: 64, key: KEY }
    ])
  })

  it('names none unless the user allowed the hosts of Chrome: they are Chrome\'s, as its folders are', () => {
    expect(nativeHostRegistryKeys('com.example.host', false, 'win32')).toEqual([])
  })

  it('names none off Windows, where the manifests are in folders', () => {
    expect(nativeHostRegistryKeys('com.example.host', true, 'darwin')).toEqual([])
    expect(nativeHostRegistryKeys('com.example.host', true, 'linux')).toEqual([])
  })

  it('names none for a name that is not a host name, so that nothing odd reaches a command line', () => {
    for (const name of ['', 'a b', 'a\\b', 'a"b', 'COM.Example', 'a&b', '..', 'a/b']) expect(nativeHostRegistryKeys(name, true, 'win32')).toEqual([])
  })
})

describe('parseRegistryExport', () => {
  const reg = (body: string) => `Windows Registry Editor Version 5.00\r\n\r\n${body}`

  it('reads the default value of the key, with its backslashes unescaped', () => {
    expect(parseRegistryExport(reg('[HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.example.host]\r\n@="C:\\\\Program Files\\\\Host\\\\com.example.host.json"\r\n\r\n'))).toBe('C:\\Program Files\\Host\\com.example.host.json')
  })

  it('keeps an accented path as it is written, and unescapes a quote', () => {
    expect(parseRegistryExport(reg('[HKEY_CURRENT_USER\\Software\\X]\r\n@="C:\\\\Users\\\\Léa \\"Dupont\\"\\\\m.json"\r\n'))).toBe('C:\\Users\\Léa "Dupont"\\m.json')
  })

  it('reads a file with Unix line ends too', () => {
    expect(parseRegistryExport(reg('[HKEY_CURRENT_USER\\Software\\X]\n@="C:\\\\m.json"\n'))).toBe('C:\\m.json')
  })

  it('does not take another value of the key for its default one', () => {
    expect(parseRegistryExport(reg('[HKEY_CURRENT_USER\\Software\\X]\r\n"path"="C:\\\\other.json"\r\n@="C:\\\\m.json"\r\n'))).toBe('C:\\m.json')
    expect(parseRegistryExport(reg('[HKEY_CURRENT_USER\\Software\\X]\r\n"path"="C:\\\\other.json"\r\n'))).toBeNull()
  })

  it('does not take the default value of a sub-key for the one of the key (an export goes down the tree)', () => {
    expect(parseRegistryExport(reg('[HKEY_CURRENT_USER\\Software\\X]\r\n"a"="b"\r\n\r\n[HKEY_CURRENT_USER\\Software\\X\\Sub]\r\n@="C:\\\\sub.json"\r\n'))).toBeNull()
  })

  it('has no value for a key without a default value, for a value that is not a plain string, and for a file that is not an export', () => {
    expect(parseRegistryExport(reg('[HKEY_CURRENT_USER\\Software\\X]\r\n\r\n'))).toBeNull()
    expect(parseRegistryExport(reg('[HKEY_CURRENT_USER\\Software\\X]\r\n@=hex(2):43,00,3a,00,00,00\r\n'))).toBeNull()
    expect(parseRegistryExport(reg('[HKEY_CURRENT_USER\\Software\\X]\r\n@=dword:00000001\r\n'))).toBeNull()
    expect(parseRegistryExport('@="C:\\\\m.json"\r\n')).toBeNull()
    expect(parseRegistryExport('')).toBeNull()
  })
})

describe('isRegistryManifestPath', () => {
  it('accepts a path on a drive', () => {
    expect(isRegistryManifestPath('C:\\Program Files\\Host\\m.json')).toBe(true)
    expect(isRegistryManifestPath('d:/hosts/m.json')).toBe(true)
  })

  it('refuses a network path and a device path, which an installer has no reason to write and which make the machine reach out', () => {
    for (const path of ['\\\\server\\share\\m.json', '\\\\?\\C:\\m.json', '\\\\.\\pipe\\x', '//server/share/m.json']) expect(isRegistryManifestPath(path)).toBe(false)
  })

  it('refuses a path that is not absolute, a bare drive, an environment variable that nobody expanded, and an empty value', () => {
    for (const path of ['m.json', '..\\m.json', 'C:', 'C:m.json', '%ProgramFiles%\\Host\\m.json', '', '(value not set)']) expect(isRegistryManifestPath(path)).toBe(false)
  })
})

describe('hostEnvironment', () => {
  const full = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/me',
    USER: 'me',
    LANG: 'fr_FR.UTF-8',
    LC_ALL: 'fr_FR.UTF-8',
    LC_CTYPE: 'UTF-8',
    TMPDIR: '/var/folders/x/T/',
    __CF_USER_TEXT_ENCODING: '0x1F5:0:0',
    GITHUB_TOKEN: 'ghp_secret',
    OPENAI_API_KEY: 'sk-secret',
    NODE_OPTIONS: '--require /tmp/x.js',
    DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
    LD_PRELOAD: '/tmp/x.so',
    ELECTRON_RUN_AS_NODE: '1',
    SSH_AUTH_SOCK: '/tmp/agent.sock'
  }

  it('keeps what a program needs to find its way (search path, home, language, temporary folder) and drops the rest', () => {
    expect(hostEnvironment(full)).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/me',
      USER: 'me',
      LANG: 'fr_FR.UTF-8',
      LC_ALL: 'fr_FR.UTF-8',
      LC_CTYPE: 'UTF-8',
      TMPDIR: '/var/folders/x/T/',
      __CF_USER_TEXT_ENCODING: '0x1F5:0:0'
    })
  })

  it('leaves out the secrets of the shell and the variables that change how a program loads code', () => {
    const kept = Object.keys(hostEnvironment(full))
    for (const name of ['GITHUB_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'ELECTRON_RUN_AS_NODE', 'SSH_AUTH_SOCK']) expect(kept, name).not.toContain(name)
  })

  it('ignores a variable that is not a string, and matches Unix names exactly (a lower-case path is not PATH)', () => {
    expect(hostEnvironment({ PATH: undefined, path: '/evil', HOME: '/h' })).toEqual({ HOME: '/h' })
  })

  it('knows the variables of Windows, whose names do not depend on the case', () => {
    expect(hostEnvironment({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\me\\AppData', GITHUB_TOKEN: 'x', HOME: '/not-a-windows-variable', LC_ALL: 'C' }, 'win32')).toEqual({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\me\\AppData' })
  })
})
