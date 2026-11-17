import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFrame, FrameDecoder, hostEnvironment, MAX_HOST_MESSAGE_BYTES, NATIVE_ERRORS } from '@shared/native-messaging'
import type { PlatformId } from '@shared/platform'
import { onWindows } from '../windows.test-support'
import { NativeHosts, type PortEvent } from './native-messaging'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
/**
 * The system whose rules read the manifests here: the manifest names the program by a path the machine of the run writes (`C:\…` on Windows), and a
 * path of the other form is refused as not absolute. The application hands its own system in (`currentPlatform().id`), as the tests do.
 */
const SYSTEM: PlatformId = onWindows ? 'win32' : 'darwin'

/** A host that never reads its input once started: what is written to it stays in the pipe's buffer. */
let deafHosts = false

class FakeChild extends EventEmitter {
  stdin: Writable = deafHosts ? new Writable({ write: () => {} }) : new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  kill = vi.fn()
  /** What the extension sent, decoded. */
  received: unknown[] = []
  constructor() {
    super()
    const decoder = new FrameDecoder()
    this.stdin.on('data', (chunk: Buffer) => this.received.push(...decoder.push(chunk).messages))
  }
  reply(message: unknown): void {
    this.stdout.write(Buffer.from(encodeFrame(message)))
  }
  leave(): void {
    this.exitCode = 0
    this.emit('exit', 0)
  }
}

let dir: string
let chromeDir: string
let binary: string
let children: FakeChild[]
let spawned: Array<{ path: string; args: string[] }>
let environments: Array<Record<string, string> | undefined>
let root: string
let events: Array<{ portId: string; event: PortEvent }>
let hosts: NativeHosts

const manifest = (name: string, origins: string[] = [`chrome-extension://${EXT}/`]) => JSON.stringify({ name, description: 'x', path: binary, type: 'stdio', allowed_origins: origins })
/** Lets the lookups on disk and the spawns finish: waits until nothing new has started for a while (a fixed pause is too short when the machine is busy). */
const settle = async (): Promise<void> => {
  let last = -1
  let quiet = 0
  for (let i = 0; i < 300 && quiet < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 15))
    const now = spawned.length + events.length
    quiet = now === last ? quiet + 1 : 0
    last = now
  }
}
const lastEvent = () => events.at(-1)?.event

beforeEach(() => {
  // The real path: the temporary folder of macOS is behind a link (/var -> /private/var), and the host is started by the path it leads to.
  deafHosts = false
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lucium-native-')))
  dir = join(root, 'own')
  chromeDir = join(root, 'chrome')
  mkdirSync(dir)
  mkdirSync(chromeDir)
  binary = join(root, 'host-binary')
  writeFileSync(binary, '#!/bin/sh\n')
  // The application starts the real path of the file (fs.promises.realpath); on Windows the temporary folder may be written with an 8.3 short name
  // (RUNNER~1) that only the native call expands.
  binary = realpathSync.native(binary)
  children = []
  spawned = []
  environments = []
  events = []
  const spawn = ((path: string, args: string[], options?: { env?: Record<string, string> }) => {
    spawned.push({ path, args })
    environments.push(options?.env)
    const child = new FakeChild()
    children.push(child)
    return child
  }) as never
  hosts = new NativeHosts({
    dirs: () => [dir],
    spawn,
    deliver: (_ext, portId, event) => events.push({ portId, event }),
    platform: SYSTEM
  })
})

afterEach(() => {
  hosts.closeAll()
  rmSync(join(dir, '..'), { recursive: true, force: true })
})

describe('NativeHosts.connect', () => {
  it('starts the host named in a manifest of its folder, with the extension origin as argument, and carries messages both ways', async () => {
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    hosts.connect(EXT, 'com.example.host', 'p1')
    hosts.post(EXT, 'p1', { hello: 'é' })
    await settle()
    expect(spawned).toEqual([{ path: binary, args: [`chrome-extension://${EXT}/`] }])
    expect(children[0]!.received).toEqual([{ hello: 'é' }])
    children[0]!.reply({ answer: 42 })
    await settle()
    expect(events).toEqual([{ portId: 'p1', event: { type: 'message', message: { answer: 42 } } }])
  })

  it('starts the program a link leads to, not the link: the file that was looked at is the one that runs', async () => {
    const link = join(root, 'host-link')
    symlinkSync(binary, link)
    writeFileSync(join(dir, 'com.example.host.json'), JSON.stringify({ name: 'com.example.host', description: 'x', path: link, type: 'stdio', allowed_origins: [`chrome-extension://${EXT}/`] }))
    hosts.connect(EXT, 'com.example.host', 'p1')
    await settle()
    expect(spawned).toEqual([{ path: binary, args: [`chrome-extension://${EXT}/`] }])
  })

  it('reports a link that leads nowhere as a failure to start, and says so in the journal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const link = join(root, 'dangling')
      symlinkSync(join(root, 'gone'), link)
      writeFileSync(join(dir, 'com.example.host.json'), JSON.stringify({ name: 'com.example.host', description: 'x', path: link, type: 'stdio', allowed_origins: [`chrome-extension://${EXT}/`] }))
      hosts.connect(EXT, 'com.example.host', 'p1')
      await settle()
      expect(lastEvent()).toEqual({ type: 'disconnect', error: NATIVE_ERRORS.startFailed })
      expect(spawned).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('com.example.host'), expect.stringContaining('ENOENT'))
    } finally {
      warn.mockRestore()
    }
  })

  it('starts the host with the few variables it needs, not with the whole environment of the browser', async () => {
    // What the system's own list lets through (Windows names do not depend on the case) and what no host is owed, on each system.
    const owed: Record<string, string> = onWindows ? { Path: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\me' } : { PATH: '/usr/bin:/bin', HOME: '/Users/me', LC_ALL: 'fr_FR.UTF-8' }
    const refused: Record<string, string> = { GITHUB_TOKEN: 'ghp_secret', NODE_OPTIONS: '--require /tmp/x.js', DYLD_INSERT_LIBRARIES: '/tmp/x.dylib', ELECTRON_RUN_AS_NODE: '1', AWS_SECRET_ACCESS_KEY: 'k' }
    const withEnv = new NativeHosts({
      dirs: () => [dir],
      spawn: ((_path: string, _args: string[], options?: { env?: Record<string, string> }) => {
        environments.push(options?.env)
        return new FakeChild()
      }) as never,
      deliver: () => {},
      platform: SYSTEM,
      env: () => ({ ...owed, ...refused })
    })
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    withEnv.connect(EXT, 'com.example.host', 'p1')
    await settle()
    expect(environments).toEqual([owed])
    withEnv.closeAll()
  })

  it('takes that environment from the process\'s own when none is given', async () => {
    process.env['LUCIUM_TEST_SECRET'] = 'must-not-reach-a-host'
    try {
      writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
      hosts.connect(EXT, 'com.example.host', 'p1')
      await settle()
      expect(environments).toHaveLength(1)
      expect(environments[0]).toEqual(hostEnvironment(process.env, SYSTEM))
      expect(environments[0]).not.toHaveProperty('LUCIUM_TEST_SECRET')
    } finally {
      delete process.env['LUCIUM_TEST_SECRET']
    }
  })

  it('reads a reply that arrives in pieces', async () => {
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    hosts.connect(EXT, 'com.example.host', 'p1')
    await settle()
    const frame = Buffer.from(encodeFrame({ big: 'x'.repeat(5000) }))
    children[0]!.stdout.write(frame.subarray(0, 3))
    children[0]!.stdout.write(frame.subarray(3, 2000))
    children[0]!.stdout.write(frame.subarray(2000))
    await settle()
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toMatchObject({ type: 'message' })
  })

  it('reports a host that has no manifest as not found', async () => {
    hosts.connect(EXT, 'com.example.missing', 'p1')
    await settle()
    expect(lastEvent()).toEqual({ type: 'disconnect', error: NATIVE_ERRORS.notFound })
    expect(spawned).toEqual([])
  })

  it('does not look in any folder but its own: a manifest registered for another browser starts nothing', async () => {
    writeFileSync(join(chromeDir, 'com.example.host.json'), manifest('com.example.host'))
    hosts.connect(EXT, 'com.example.host', 'p1')
    await settle()
    expect(lastEvent()).toEqual({ type: 'disconnect', error: NATIVE_ERRORS.notFound })
    expect(spawned).toEqual([])
  })

  it('refuses an extension that the manifest does not allow, without starting the host', async () => {
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host', ['chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/']))
    hosts.connect(EXT, 'com.example.host', 'p1')
    await settle()
    expect(lastEvent()).toEqual({ type: 'disconnect', error: NATIVE_ERRORS.forbidden })
    expect(spawned).toEqual([])
  })

  it('refuses a name that could point outside the folder, and reads no file for it', async () => {
    writeFileSync(join(dir, '..', 'evil.json'), manifest('evil'))
    hosts.connect(EXT, '../evil', 'p1')
    await settle()
    expect(lastEvent()).toEqual({ type: 'disconnect', error: NATIVE_ERRORS.invalidName })
    expect(spawned).toEqual([])
  })

  it('reports a manifest whose program is not there as a failure to start', async () => {
    writeFileSync(join(dir, 'com.example.host.json'), JSON.stringify({ name: 'com.example.host', description: 'x', path: join(dir, 'nothing'), type: 'stdio', allowed_origins: [`chrome-extension://${EXT}/`] }))
    hosts.connect(EXT, 'com.example.host', 'p1')
    await settle()
    expect(lastEvent()).toEqual({ type: 'disconnect', error: NATIVE_ERRORS.startFailed })
  })

  it('ends the port with an I/O error when the host sends a message above 1 MiB, and stops the host', async () => {
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    hosts.connect(EXT, 'com.example.host', 'p1')
    await settle()
    const header = Buffer.alloc(4)
    header.writeUInt32LE(MAX_HOST_MESSAGE_BYTES + 1, 0)
    children[0]!.stdout.write(header)
    await settle()
    expect(lastEvent()).toEqual({ type: 'disconnect', error: NATIVE_ERRORS.io })
    expect(children[0]!.stdin.writableEnded).toBe(true)
  })

  it('tells the extension when the host leaves', async () => {
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    hosts.connect(EXT, 'com.example.host', 'p1')
    await settle()
    children[0]!.leave()
    expect(lastEvent()).toEqual({ type: 'disconnect', error: NATIVE_ERRORS.exited })
    expect(hosts.openCount()).toBe(0)
  })

  it('closes the host input when the extension disconnects, without telling the extension back', async () => {
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    hosts.connect(EXT, 'com.example.host', 'p1')
    await settle()
    hosts.disconnect(EXT, 'p1')
    expect(children[0]!.stdin.writableEnded).toBe(true)
    expect(events).toEqual([])
    expect(hosts.openCount()).toBe(0)
  })

  it('does not let one extension start more than 16 hosts at once', async () => {
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    for (let i = 0; i < 17; i++) hosts.connect(EXT, 'com.example.host', `p${i}`)
    // 17 manifest lookups on disk: a fixed pause is too short on a busy machine, so wait for the outcome itself.
    await vi.waitFor(() => {
      expect(spawned).toHaveLength(16)
      expect(events.filter((e) => e.event.type === 'disconnect' && e.event.error === NATIVE_ERRORS.startFailed)).toHaveLength(1)
    })
  })
})

describe('NativeHosts and a host that does not leave', () => {
  const started = async (): Promise<FakeChild> => {
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    hosts.connect(EXT, 'com.example.host', 'p1')
    await settle()
    return children[0]!
  }

  it('stops a host that ignores the closed pipe, then kills one that ignores that too', async () => {
    const child = await started()
    vi.useFakeTimers()
    try {
      hosts.disconnect(EXT, 'p1')
      expect(child.kill).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2000)
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.kill).toHaveBeenLastCalledWith()
      vi.advanceTimersByTime(2000)
      expect(child.kill).toHaveBeenCalledTimes(2)
      expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a host that left by itself alone', async () => {
    const child = await started()
    vi.useFakeTimers()
    try {
      hosts.disconnect(EXT, 'p1')
      child.leave()
      vi.advanceTimersByTime(10_000)
      expect(child.kill).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('kills the hosts at once when the browser quits: there is no time left to wait for them', async () => {
    const child = await started()
    hosts.closeAll()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(hosts.openCount()).toBe(0)
  })
})

describe('NativeHosts and a page that writes faster than the host starts', () => {
  it('ends the port with an I/O error once too many messages wait for the host, and never starts it', async () => {
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    hosts.connect(EXT, 'com.example.host', 'p1')
    for (let i = 0; i < 300; i++) hosts.post(EXT, 'p1', { i })
    await settle()
    expect(lastEvent()).toEqual({ type: 'disconnect', error: NATIVE_ERRORS.io })
    expect(spawned).toEqual([])
  })

  it('ends it too when what waits is too heavy', async () => {
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    hosts.connect(EXT, 'com.example.host', 'p1')
    for (let i = 0; i < 20; i++) hosts.post(EXT, 'p1', 'x'.repeat(1024 * 1024))
    await settle()
    expect(lastEvent()).toEqual({ type: 'disconnect', error: NATIVE_ERRORS.io })
  })

  it('still hands the host everything that waited, in order, when it starts in time', async () => {
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    hosts.connect(EXT, 'com.example.host', 'p1')
    for (let i = 0; i < 100; i++) hosts.post(EXT, 'p1', { i })
    await settle()
    expect(children[0]!.received).toEqual(Array.from({ length: 100 }, (_, i) => ({ i })))
  })
})

describe('NativeHosts and a host that stops reading its input', () => {
  it('ends the port with an I/O error once too much waits in its pipe, and lets go of it, instead of filling the memory of the browser', async () => {
    deafHosts = true
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    hosts.connect(EXT, 'com.example.host', 'p1')
    await settle()
    expect(spawned).toHaveLength(1)
    for (let i = 0; i < 20; i++) hosts.post(EXT, 'p1', 'x'.repeat(1024 * 1024))
    expect(lastEvent()).toEqual({ type: 'disconnect', error: NATIVE_ERRORS.io })
    expect(hosts.openCount()).toBe(0)
    expect(children[0]!.stdin.destroyed).toBe(true)
  })

  it('counts what waited for the host to start among what waits in its pipe', async () => {
    deafHosts = true
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    hosts.connect(EXT, 'com.example.host', 'p1')
    for (let i = 0; i < 15; i++) hosts.post(EXT, 'p1', 'x'.repeat(1024 * 1024))
    await settle()
    expect(spawned).toHaveLength(1)
    expect(lastEvent()).toBeUndefined()
    for (let i = 0; i < 3; i++) hosts.post(EXT, 'p1', 'x'.repeat(1024 * 1024))
    expect(lastEvent()).toEqual({ type: 'disconnect', error: NATIVE_ERRORS.io })
  })
})

describe('NativeHosts and a pipe that breaks', () => {
  it('ends the port instead of throwing in the main process when the output of the host fails', async () => {
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    hosts.connect(EXT, 'com.example.host', 'p1')
    await settle()
    expect(() => children[0]!.stdout.emit('error', new Error('EIO'))).not.toThrow()
    expect(() => children[0]!.stderr.emit('error', new Error('EIO'))).not.toThrow()
    expect(lastEvent()).toEqual({ type: 'disconnect', error: NATIVE_ERRORS.io })
  })
})

describe('NativeHosts.sendOnce', () => {
  it('resolves with the first reply and closes the host', async () => {
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    const answer = hosts.sendOnce(EXT, 'com.example.host', { ping: 1 })
    await settle()
    expect(children[0]!.received).toEqual([{ ping: 1 }])
    children[0]!.reply({ pong: 1 })
    await expect(answer).resolves.toEqual({ pong: 1 })
    expect(children[0]!.stdin.writableEnded).toBe(true)
    // The port of a one-shot message is never shown to a context.
    expect(events).toEqual([])
  })

  it('rejects with the API\'s error when the host does not exist, or leaves without answering', async () => {
    await expect(hosts.sendOnce(EXT, 'com.example.missing', {})).rejects.toThrow(NATIVE_ERRORS.notFound)
    writeFileSync(join(dir, 'com.example.host.json'), manifest('com.example.host'))
    const answer = hosts.sendOnce(EXT, 'com.example.host', {})
    await settle()
    children[0]!.leave()
    await expect(answer).rejects.toThrow(NATIVE_ERRORS.exited)
  })
})
