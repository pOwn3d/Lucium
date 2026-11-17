import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { checkHostManifest, encodeFrame, FrameDecoder, hostEnvironment, isValidHostName, NATIVE_ERRORS } from '@shared/native-messaging'
import type { PlatformId } from '@shared/platform'
import { readBoundedText } from './bounded-file'

/** What happens on a port, for the context that opened it. */
export type PortEvent = { type: 'message'; message: unknown } | { type: 'disconnect'; error: string | null }

export interface NativeHostsOptions {
  /**
   * The folders whose `<host name>.json` manifests may start a host. Lucium's own folder only: the hosts that other
   * browsers registered for themselves are not started unless the user copies their manifest here.
   */
  dirs: () => string[]
  /**
   * Windows: the manifests the registry names for a host (Chrome's keys), asked for only when no folder has the manifest. Empty when there is nothing to
   * look for there; it throws when the registry cannot be read, and the port ends as a host that did not start.
   */
  registryManifests?: (hostName: string) => AsyncIterable<string>
  deliver: (extensionId: string, portId: string, event: PortEvent) => void
  spawn?: typeof nodeSpawn
  /** The system whose rules read a manifest (the form of an absolute path). macOS when not given. */
  platform?: PlatformId
  /** The environment the host's own is made from (see `hostEnvironment`). The process's when not given. */
  env?: () => Readonly<Record<string, string | undefined>>
}

/** An extension cannot start more hosts than this at once. */
const MAX_PORTS_PER_EXTENSION = 16
/** A host that does not leave when its pipe closes is stopped after this, and killed for good if it ignores that too. */
const KILL_AFTER_MS = 2000
const KILL_FOR_GOOD_AFTER_MS = 2000
/** A host manifest is a few lines of JSON; a file larger than this is not one. */
const MAX_MANIFEST_BYTES = 64 * 1024
/** What a port holds for a host that is not running yet: a page that posts in a loop must not fill the memory while the host starts. */
const MAX_QUEUED_MESSAGES = 256
const MAX_QUEUED_BYTES = 16 * 1024 * 1024
/** What may wait in the pipe of a running host that does not read its input: past this the port ends, as a host that stopped reading. */
const MAX_UNREAD_BYTES = MAX_QUEUED_BYTES

interface Port {
  key: string
  extensionId: string
  /** Messages posted before the process was running, already framed. */
  queued: Uint8Array[]
  queuedBytes: number
  child: ChildProcessWithoutNullStreams | null
  closed: boolean
  /** Where the events of this port go instead of to a context (the port of `sendOnce`, which no extension can see). */
  listener?: (event: PortEvent) => void
}

/**
 * Native messaging: an extension talks to a program of the user's through its standard input and output. The program is
 * named in a manifest the user (or an installer) put in a known folder, and the manifest says which extensions may start it. Every
 * way a port can end becomes a disconnect with the error text of the API, so an extension sees the errors it is written for.
 */
export class NativeHosts {
  private readonly ports = new Map<string, Port>()
  private readonly spawnProcess: typeof nodeSpawn

  constructor(private readonly options: NativeHostsOptions) {
    this.spawnProcess = options.spawn ?? nodeSpawn
  }

  /** Opens a port to a host. Failures are reported as a disconnect, never thrown: the extension already holds the port object. */
  connect(extensionId: string, hostName: string, portId: string, listener?: (event: PortEvent) => void): void {
    const key = `${extensionId}:${portId}`
    if (this.ports.has(key)) return
    const port: Port = { key, extensionId, queued: [], queuedBytes: 0, child: null, closed: false, listener }
    this.ports.set(key, port)
    if (this.countFor(extensionId) > MAX_PORTS_PER_EXTENSION) return this.close(port, NATIVE_ERRORS.startFailed)
    void this.start(port, hostName).catch((error: unknown) => {
      console.error(`[native] cannot start ${hostName} for ${extensionId}:`, error)
      this.close(port, NATIVE_ERRORS.startFailed)
    })
  }

  post(extensionId: string, portId: string, message: unknown): void {
    const port = this.ports.get(`${extensionId}:${portId}`)
    if (!port || port.closed) return
    const frame = this.frame(port, message)
    if (!frame) return
    if (port.child) return void this.write(port, port.child, frame)
    port.queued.push(frame)
    port.queuedBytes += frame.length
    // A host that is slow to start is waited for, but not for ever many messages.
    if (port.queued.length > MAX_QUEUED_MESSAGES || port.queuedBytes > MAX_QUEUED_BYTES) this.close(port, NATIVE_ERRORS.io)
  }

  /** The extension closed its end: the host's input is closed, and it is stopped if it does not leave by itself. */
  disconnect(extensionId: string, portId: string): void {
    const port = this.ports.get(`${extensionId}:${portId}`)
    if (port) this.close(port, null, false)
  }

  /** `chrome.runtime.sendNativeMessage`: one message, the first reply, and the host is closed. */
  sendOnce(extensionId: string, hostName: string, message: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const portId = randomUUID()
      let settled = false
      this.connect(extensionId, hostName, portId, (event) => {
        if (settled) return
        settled = true
        if (event.type === 'message') resolve(event.message)
        else reject(new Error(event.error ?? NATIVE_ERRORS.exited))
        this.disconnect(extensionId, portId)
      })
      this.post(extensionId, portId, message)
    })
  }

  /** Closes every port an extension has open (it was unloaded, or its context went away). */
  disconnectExtension(extensionId: string): void {
    for (const port of [...this.ports.values()]) if (port.extensionId === extensionId) this.close(port, null, false)
  }

  /** The browser is quitting: nothing is left to wait for the hosts that ignore a closed pipe, so they are killed at once. */
  closeAll(): void {
    for (const port of [...this.ports.values()]) {
      const child = port.child
      this.close(port, null, false)
      if (child && child.exitCode === null) child.kill('SIGKILL')
    }
  }

  openCount(): number {
    return this.ports.size
  }

  private countFor(extensionId: string): number {
    let count = 0
    for (const port of this.ports.values()) if (port.extensionId === extensionId) count++
    return count
  }

  private emit(port: Port, event: PortEvent): void {
    if (port.listener) return port.listener(event)
    this.options.deliver(port.extensionId, port.key.slice(port.extensionId.length + 1), event)
  }

  private async resolveHost(extensionId: string, hostName: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    if (!isValidHostName(hostName)) return { ok: false, error: NATIVE_ERRORS.invalidName }
    for (const dir of this.options.dirs()) {
      const found = await this.fromManifest(join(dir, `${hostName}.json`), extensionId, hostName)
      if (found) return found
    }
    // Last, the registry keys of Chrome (Windows): a manifest of Lucium's own folder is the user's choice and wins over what an installer wrote there.
    if (this.options.registryManifests) {
      try {
        for await (const file of this.options.registryManifests(hostName)) {
          const found = await this.fromManifest(file, extensionId, hostName)
          if (found) return found
        }
      } catch (error) {
        console.warn(`[native] the registry cannot be read for ${hostName}:`, (error as Error).message)
        return { ok: false, error: NATIVE_ERRORS.startFailed }
      }
    }
    return { ok: false, error: NATIVE_ERRORS.notFound }
  }

  /** The program a manifest names, once the manifest has been read and checked; null when there is no manifest at that place (the next one is looked at). */
  private async fromManifest(file: string, extensionId: string, hostName: string): Promise<{ ok: true; path: string } | { ok: false; error: string } | null> {
    // A manifest is a few lines: a path that comes from the registry is not trusted to lead to one (a device, a huge file).
    const read = await readBoundedText(file, MAX_MANIFEST_BYTES)
    if (!read.ok) {
      // A manifest that is not at this place is the normal case: look in the next one. Anything else is worth knowing.
      if (read.reason === 'not-found') return null
      console.warn(`[native] cannot read the manifest of ${hostName} at ${file}: ${read.reason}${read.detail ? ` (${read.detail})` : ''}`)
      return { ok: false, error: NATIVE_ERRORS.startFailed }
    }
    const check = checkHostManifest(read.text, hostName, extensionId, this.options.platform)
    if (!check.ok) return check
    // The program that was looked at is the one that is started: the link is followed once, here, and the file it leads to is what is run.
    let real: string
    try {
      real = await realpath(check.manifest.path)
    } catch (error) {
      console.warn(`[native] the program of ${hostName} (${check.manifest.path}) cannot be resolved:`, (error as Error).message)
      return { ok: false, error: NATIVE_ERRORS.startFailed }
    }
    const info = await stat(real).catch(() => null)
    if (!info?.isFile()) return { ok: false, error: NATIVE_ERRORS.startFailed }
    return { ok: true, path: real }
  }

  private async start(port: Port, hostName: string): Promise<void> {
    const host = await this.resolveHost(port.extensionId, hostName)
    if (port.closed) return
    if (!host.ok) return this.close(port, host.error)
    // The host is started with the origin of the extension as its only argument, as the protocol says.
    const child = this.spawnProcess(host.path, [`chrome-extension://${port.extensionId}/`], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: hostEnvironment(this.options.env?.() ?? process.env, this.options.platform) })
    port.child = child
    const decoder = new FrameDecoder()
    child.stdout.on('data', (chunk: Buffer) => {
      const { messages, error } = decoder.push(chunk)
      for (const message of messages) if (!port.closed) this.emit(port, { type: 'message', message })
      if (error) this.close(port, error)
    })
    // Nobody reads a host's diagnostics, but a pipe nobody drains blocks the host.
    child.stderr.on('data', () => {})
    // A pipe that breaks is the host's end, not an uncaught exception of the browser.
    child.stdout.on('error', () => this.close(port, NATIVE_ERRORS.io))
    child.stderr.on('error', () => {})
    // A host that has already left makes a write fail (EPIPE): to the extension that is the host having exited.
    child.stdin.on('error', () => this.close(port, NATIVE_ERRORS.exited))
    child.on('error', (error) => {
      console.warn(`[native] ${hostName} could not be started:`, error.message)
      this.close(port, NATIVE_ERRORS.startFailed)
    })
    child.on('exit', () => this.close(port, NATIVE_ERRORS.exited))
    port.queuedBytes = 0
    for (const frame of port.queued.splice(0)) if (!this.write(port, child, frame)) return
  }

  /**
   * Hands a frame to the host. Node keeps in memory whatever the pipe does not take: a host that stops reading while the page goes on
   * posting would fill the browser's memory, so past a bound the port ends with the API's I/O error and what waits is dropped.
   */
  private write(port: Port, child: ChildProcessWithoutNullStreams, frame: Uint8Array): boolean {
    child.stdin.write(frame)
    if (child.stdin.writableLength <= MAX_UNREAD_BYTES) return true
    this.close(port, NATIVE_ERRORS.io)
    child.stdin.destroy()
    return false
  }

  /** The message as the host wants it, or null (and the port is closed) when it cannot be sent. */
  private frame(port: Port, message: unknown): Uint8Array | null {
    try {
      return encodeFrame(message)
    } catch (error) {
      console.warn(`[native] a message of ${port.extensionId} cannot be sent:`, (error as Error).message)
      this.close(port, NATIVE_ERRORS.io)
      return null
    }
  }

  /** Ends a port. `error` null means the extension itself closed it (no disconnect event for the one who asked). */
  private close(port: Port, error: string | null, notify = true): void {
    if (port.closed) return
    port.closed = true
    this.ports.delete(port.key)
    const child = port.child
    if (child && child.exitCode === null) {
      child.stdin.end()
      // Closing the pipe is the polite way; a host that does not take the hint is stopped, and one that ignores that is killed.
      const stop = setTimeout(() => child.kill(), KILL_AFTER_MS)
      const kill = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS + KILL_FOR_GOOD_AFTER_MS)
      stop.unref()
      kill.unref()
      child.once('exit', () => {
        clearTimeout(stop)
        clearTimeout(kill)
      })
    }
    if (notify) this.emit(port, { type: 'disconnect', error })
  }
}
