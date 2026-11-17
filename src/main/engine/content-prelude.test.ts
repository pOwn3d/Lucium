// The few lines that give the content scripts of a Web Store extension chrome.storage.sync and chrome.extension.inIncognitoContext: which manifests get them, what is written where, and what they do.

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MANIFEST_BACKUP, PRELUDE_FILE, PRELUDE_SOURCE, prepareContentPrelude, prepareContentPreludeSafely, withContentPrelude } from './content-prelude'
import { tempDir } from '../temp-dir'

/** A write that stops after `breakAfter.bytes` bytes and fails, as a full disk or a crash would leave it. Null: the real write. */
const breakAfter = vi.hoisted(() => ({ bytes: null as number | null, paths: [] as string[], leavesFolder: false }))

vi.mock('../durable-write', async (original) => {
  const real = await original<typeof import('../durable-write')>()
  const { writeFileSync: write, mkdirSync: mkdir } = await import('node:fs')
  return {
    ...real,
    writeDurableFileAsync: async (path: string, data: string | Uint8Array) => {
      breakAfter.paths.push(path)
      if (breakAfter.bytes === null) return real.writeDurableFileAsync(path, data)
      // A folder under that name is something the clean-up cannot remove.
      if (breakAfter.leavesFolder) mkdir(path)
      else write(path, String(data).slice(0, breakAfter.bytes))
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  breakAfter.bytes = null
  breakAfter.paths = []
  breakAfter.leavesFolder = false
})

const manifest = (over: Record<string, unknown> = {}) => ({
  manifest_version: 3,
  name: 'X',
  version: '1',
  permissions: ['storage', 'tabs'],
  content_scripts: [
    { matches: ['https://*/*'], js: ['content.js'], run_at: 'document_end' },
    { matches: ['https://*/*'], js: ['page.js'], world: 'MAIN' },
    { matches: ['https://*/*'], css: ['style.css'] }
  ],
  ...over
})

describe('withContentPrelude', () => {
  it('puts the prelude first in the scripts of the isolated world, and nowhere else', () => {
    const patched = withContentPrelude(manifest()) as ReturnType<typeof manifest>
    expect(patched.content_scripts[0]!.js).toEqual([PRELUDE_FILE, 'content.js'])
    expect(patched.content_scripts[0]).toMatchObject({ run_at: 'document_end', matches: ['https://*/*'] })
    // The script of the page's own world has no chrome.storage; a stylesheet-only entry has nothing to run.
    expect(patched.content_scripts[1]!.js).toEqual(['page.js'])
    expect(patched.content_scripts[2]).toEqual({ matches: ['https://*/*'], css: ['style.css'] })
  })

  it('is also put in the content scripts of an extension that does not ask for storage (Vimium reads chrome.extension, not chrome.storage.sync)', () => {
    const patched = withContentPrelude(manifest({ permissions: ['tabs'] })) as ReturnType<typeof manifest>
    expect(patched.content_scripts[0]!.js).toEqual([PRELUDE_FILE, 'content.js'])
    expect((withContentPrelude(manifest({ permissions: undefined })) as ReturnType<typeof manifest>).content_scripts[0]!.js).toEqual([PRELUDE_FILE, 'content.js'])
  })

  it('changes nothing for an extension with no content script of the isolated world', () => {
    expect(withContentPrelude(manifest({ content_scripts: undefined }))).toBeNull()
    expect(withContentPrelude(manifest({ content_scripts: [{ matches: ['https://*/*'], js: ['page.js'], world: 'MAIN' }, { matches: ['https://*/*'], css: ['a.css'] }] }))).toBeNull()
    expect(withContentPrelude(null)).toBeNull()
    expect(withContentPrelude('x')).toBeNull()
  })

  it('is applied once', () => {
    const once = withContentPrelude(manifest())
    expect(withContentPrelude(once)).toBeNull()
  })
})

describe('prepareContentPrelude', () => {
  const folder = (value: unknown = manifest()): string => {
    const dir = tempDir('lucium-prelude-')
    writeFileSync(join(dir, 'manifest.json'), typeof value === 'string' ? value : JSON.stringify(value))
    return dir
  }

  it('writes the prelude, lists it in the manifest and keeps the manifest as it was', async () => {
    const original = JSON.stringify(manifest())
    const dir = folder(original)
    expect(await prepareContentPrelude(dir)).toBe(true)
    expect(readFileSync(join(dir, PRELUDE_FILE), 'utf8')).toBe(PRELUDE_SOURCE)
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).content_scripts[0].js).toEqual([PRELUDE_FILE, 'content.js'])
    expect(readFileSync(join(dir, MANIFEST_BACKUP), 'utf8')).toBe(original)
  })

  it('reads a manifest that starts with a byte order mark', async () => {
    const dir = folder(`\uFEFF${JSON.stringify(manifest())}`)
    expect(await prepareContentPrelude(dir)).toBe(true)
  })

  it('does nothing the second time, and never replaces the backup', async () => {
    const original = JSON.stringify(manifest())
    const dir = folder(original)
    await prepareContentPrelude(dir)
    expect(await prepareContentPrelude(dir)).toBe(false)
    expect(readFileSync(join(dir, MANIFEST_BACKUP), 'utf8')).toBe(original)
  })

  it('leaves an extension with no content script alone: no file, no backup', async () => {
    const dir = folder(manifest({ content_scripts: undefined }))
    expect(await prepareContentPrelude(dir)).toBe(false)
    expect(existsSync(join(dir, PRELUDE_FILE))).toBe(false)
    expect(existsSync(join(dir, MANIFEST_BACKUP))).toBe(false)
  })

  it('gives a folder prepared by an older prelude the file of today, and leaves the manifest and its backup alone', async () => {
    const original = JSON.stringify(manifest())
    const dir = folder(original)
    await prepareContentPrelude(dir)
    const listed = readFileSync(join(dir, 'manifest.json'), 'utf8')
    writeFileSync(join(dir, PRELUDE_FILE), '// an older prelude\n', 'utf8')
    expect(await prepareContentPrelude(dir)).toBe(true)
    expect(readFileSync(join(dir, PRELUDE_FILE), 'utf8')).toBe(PRELUDE_SOURCE)
    expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toBe(listed)
    expect(readFileSync(join(dir, MANIFEST_BACKUP), 'utf8')).toBe(original)
    // Brought up to date once: the next load changes nothing.
    expect(await prepareContentPrelude(dir)).toBe(false)
  })

  it('writes the file again when the manifest lists it and the file is gone', async () => {
    const dir = folder()
    await prepareContentPrelude(dir)
    rmSync(join(dir, PRELUDE_FILE))
    expect(await prepareContentPrelude(dir)).toBe(true)
    expect(readFileSync(join(dir, PRELUDE_FILE), 'utf8')).toBe(PRELUDE_SOURCE)
  })

  it('leaves the manifest as it was, and nothing beside it, when the write stops short: the extension still loads', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const original = JSON.stringify(manifest())
    const dir = folder(original)
    breakAfter.bytes = 40
    await expect(prepareContentPrelude(dir)).rejects.toThrow(/no space left/)
    expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toBe(original)
    expect(breakAfter.paths).toEqual([join(dir, 'manifest.json.lucium-tmp')])
    expect(readdirSync(dir).sort()).toEqual([PRELUDE_FILE, 'manifest.json', MANIFEST_BACKUP].sort())
    // The load that asked goes on, and says which folder it could not prepare.
    expect(await prepareContentPreludeSafely(dir)).toBe(false)
    expect(error).toHaveBeenCalledWith(expect.stringContaining(dir), expect.anything())
    // Once the disk takes the write again, the folder is prepared.
    breakAfter.bytes = null
    expect(await prepareContentPrelude(dir)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).content_scripts[0].js).toEqual([PRELUDE_FILE, 'content.js'])
    expect(readdirSync(dir)).not.toContain('manifest.json.lucium-tmp')
  })

  it('says it when what a failed write left beside the manifest cannot be removed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dir = folder()
    breakAfter.bytes = 40
    breakAfter.leavesFolder = true
    await expect(prepareContentPrelude(dir)).rejects.toThrow(/no space left/)
    expect(error).toHaveBeenCalledWith(expect.stringContaining(join(dir, 'manifest.json.lucium-tmp')), expect.any(Error))
  })

  it('makes a manifest that was cut short again from the copy kept beside it, says so with the folder, and prepares the folder', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const original = JSON.stringify(manifest())
    const dir = folder(original)
    await prepareContentPrelude(dir)
    const prepared = readFileSync(join(dir, 'manifest.json'), 'utf8')
    // What a crash in the middle of a write in place left: the first bytes of the manifest.
    writeFileSync(join(dir, 'manifest.json'), prepared.slice(0, 60))
    expect(await prepareContentPrelude(dir)).toBe(true)
    expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toBe(prepared)
    expect(readFileSync(join(dir, MANIFEST_BACKUP), 'utf8')).toBe(original)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain(dir)
    expect(String(warn.mock.calls[0]![0])).toContain(MANIFEST_BACKUP)
  })

  it('does not go back to a copy that is no better than the manifest: the failure is the manifest’s, and nothing is written', async () => {
    for (const copy of ['{ cut', '"a string"', 'null']) {
      const dir = folder('{ not json')
      writeFileSync(join(dir, MANIFEST_BACKUP), copy)
      await expect(prepareContentPrelude(dir)).rejects.toThrow(SyntaxError)
      expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toBe('{ not json')
      expect(readFileSync(join(dir, MANIFEST_BACKUP), 'utf8')).toBe(copy)
    }
  })

  it('keeps the manifest the store delivered, not a file of that name the package brought with it', async () => {
    const original = JSON.stringify(manifest())
    const dir = folder(original)
    writeFileSync(join(dir, MANIFEST_BACKUP), JSON.stringify(manifest({ permissions: ['<all_urls>', 'debugger'] })))
    expect(await prepareContentPrelude(dir)).toBe(true)
    expect(readFileSync(join(dir, MANIFEST_BACKUP), 'utf8')).toBe(original)
  })

  it('keeps the copy it has when the manifest already lists the prelude somewhere (an older rule listed it in fewer entries)', async () => {
    const original = JSON.stringify(manifest())
    const partly = manifest({ content_scripts: [{ matches: ['https://*/*'], js: [PRELUDE_FILE, 'content.js'] }, { matches: ['https://*/*'], js: ['other.js'] }] })
    const dir = folder(partly)
    writeFileSync(join(dir, MANIFEST_BACKUP), original)
    expect(await prepareContentPrelude(dir)).toBe(true)
    expect(readFileSync(join(dir, MANIFEST_BACKUP), 'utf8')).toBe(original)
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).content_scripts[1].js).toEqual([PRELUDE_FILE, 'other.js'])
  })

  it('does not stop a load: a manifest that cannot be read is logged with its folder, and the extension loads as delivered', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dir = folder('{ not json')
    expect(await prepareContentPreludeSafely(dir)).toBe(false)
    expect(error).toHaveBeenCalledWith(expect.stringContaining(dir), expect.anything())
    expect(await prepareContentPreludeSafely(join(dir, 'missing'))).toBe(false)
  })
})

describe('the prelude itself', () => {
  const run = (local: Record<string, unknown>) => {
    const chrome = { storage: { local } as Record<string, unknown> }
    new Function('chrome', PRELUDE_SOURCE)(chrome)
    return chrome.storage['sync'] as Record<string, unknown> & { get: (...a: unknown[]) => unknown }
  }

  it('makes chrome.storage.sync the local area, with the limits of the sync one', () => {
    const get = vi.fn(function (this: unknown, key: string) { return { this: this === local, key } })
    const local = { get, QUOTA_BYTES: 10485760 }
    const sync = run(local)
    expect(sync.get('a')).toEqual({ this: true, key: 'a' })
    expect(sync['QUOTA_BYTES']).toBe(102400)
    expect(sync['QUOTA_BYTES_PER_ITEM']).toBe(8192)
    expect(sync['MAX_ITEMS']).toBe(512)
  })

  it('gives chrome.extension its flag when a content script finds none, and keeps the one it finds', () => {
    const bare: Record<string, unknown> = {}
    new Function('chrome', PRELUDE_SOURCE)(bare)
    expect(bare['extension']).toEqual({ inIncognitoContext: false })
    const given = { inIncognitoContext: true }
    const kept: Record<string, unknown> = { extension: given }
    new Function('chrome', PRELUDE_SOURCE)(kept)
    expect(kept['extension']).toBe(given)
  })

  it('sets storage.sync up even when chrome.extension cannot be defined', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const chrome: Record<string, unknown> = { storage: { local: { get: () => 1 } } }
    Object.preventExtensions(chrome)
    expect(() => new Function('chrome', PRELUDE_SOURCE)(chrome)).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('chrome.extension'), expect.anything())
    expect((chrome['storage'] as Record<string, unknown>)['sync']).toBeDefined()
  })

  it('does nothing when there is no chrome.storage.local', () => {
    const chrome = { storage: {} as Record<string, unknown> }
    new Function('chrome', PRELUDE_SOURCE)(chrome)
    expect('sync' in chrome.storage).toBe(false)
    expect(() => new Function('chrome', PRELUDE_SOURCE)({})).not.toThrow()
  })
})

describe('the paste command of a content script', () => {
  const g = globalThis as Record<string, any>
  afterEach(() => {
    delete g['Document']
  })

  /** A content script as Electron gives it: a Document that refuses `paste` (its own answer), and the runtime of an extension. */
  function inContentScript(permissions: string[] | undefined, options: { native?: (command: string) => boolean; connect?: () => unknown } = {}) {
    const posted: unknown[] = []
    const ports: string[] = []
    let disconnected: (() => void) | undefined
    class FakeDocument {}
    const proto = FakeDocument.prototype as Record<string, unknown>
    proto['execCommand'] = function (command: string) {
      return options.native ? options.native(command) : false
    }
    proto['queryCommandEnabled'] = () => false
    proto['queryCommandSupported'] = () => false
    g['Document'] = FakeDocument
    const connect = vi.fn((info: { name: string }) => {
      if (options.connect) return options.connect()
      ports.push(info.name)
      return { postMessage: (message: unknown) => posted.push(message), onDisconnect: { addListener: (fn: () => void) => void (disconnected = fn) } }
    })
    const chrome = { runtime: { getManifest: () => ({ permissions }), connect } }
    new Function('chrome', PRELUDE_SOURCE)(chrome)
    return { doc: new FakeDocument() as any, posted, ports, connect, disconnect: () => disconnected?.() }
  }

  it('asks the main process to paste, over a port of its own, where Electron refuses the command (an extension that holds clipboardRead)', () => {
    const { doc, posted, ports } = inContentScript(['storage', 'clipboardRead'])
    expect(doc.execCommand('paste')).toBe(true)
    expect(ports).toEqual(['__lucium-paste'])
    expect(posted).toEqual([{ type: 'paste' }])
    expect(doc.execCommand('PASTE')).toBe(true)
    expect(posted).toHaveLength(2)
  })

  it('keeps its port for the next paste, and opens another one when it was closed', () => {
    const { doc, connect, disconnect } = inContentScript(['clipboardRead'])
    doc.execCommand('paste')
    doc.execCommand('paste')
    expect(connect).toHaveBeenCalledTimes(1)
    disconnect()
    doc.execCommand('paste')
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('leaves the browser\'s own paste to it where it is allowed: nothing is pasted twice', () => {
    const { doc, posted, connect } = inContentScript(['clipboardRead'], { native: () => true })
    expect(doc.execCommand('paste')).toBe(true)
    expect(connect).not.toHaveBeenCalled()
    expect(posted).toEqual([])
  })

  it('does not touch any other command, whatever it answers', () => {
    const { doc, connect } = inContentScript(['clipboardRead'], { native: (command) => command === 'insertText' })
    expect(doc.execCommand('insertText', false, 'x')).toBe(true)
    expect(doc.execCommand('bold')).toBe(false)
    expect(connect).not.toHaveBeenCalled()
  })

  it('says the command is there and enabled, and leaves the answer of the others', () => {
    const { doc } = inContentScript(['clipboardRead'])
    expect(doc.queryCommandEnabled('paste')).toBe(true)
    expect(doc.queryCommandSupported('Paste')).toBe(true)
    expect(doc.queryCommandEnabled('bold')).toBe(false)
    expect(doc.queryCommandSupported('bold')).toBe(false)
  })

  it('is not set up for an extension that does not hold clipboardRead: without the permission there is nothing to give', () => {
    for (const permissions of [['storage', 'clipboardWrite'], [], undefined]) {
      const { doc, connect } = inContentScript(permissions)
      expect(doc.execCommand('paste')).toBe(false)
      expect(doc.queryCommandEnabled('paste')).toBe(false)
      expect(connect).not.toHaveBeenCalled()
    }
  })

  it('says no, and why, when the main process cannot be reached: the page is not told it was pasted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { doc } = inContentScript(['clipboardRead'], {
      connect: () => {
        throw new Error('Extension context invalidated.')
      }
    })
    expect(doc.execCommand('paste')).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('a paste could not be asked for'), expect.anything())
  })

  it('does not stop the rest of the prelude when the manifest cannot be read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    class FakeDocument {}
    ;(globalThis as Record<string, any>)['Document'] = FakeDocument
    const chrome: Record<string, any> = {
      runtime: {
        getManifest: () => {
          throw new Error('no manifest')
        }
      },
      storage: { local: { get: () => 1 } }
    }
    expect(() => new Function('chrome', PRELUDE_SOURCE)(chrome)).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the paste command could not be set up'), expect.anything())
    expect(chrome['storage'].sync).toBeDefined()
  })
})
