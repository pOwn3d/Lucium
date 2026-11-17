// Native messaging of the extensions (`chrome.runtime.connectNative`), the parts that are plain logic: the wire protocol (a 4-byte length, then UTF-8 JSON), the rules of a host
// manifest, and the error texts an extension sees in `chrome.runtime.lastError`. Starting the process is in main/shell/native-messaging.ts.

import { isAbsolutePath, type PlatformId } from './platform'

/** A host may not send more than this per message (the port is closed otherwise). */
export const MAX_HOST_MESSAGE_BYTES = 1024 * 1024
/** The length prefix is 32 bits. */
export const MAX_BROWSER_MESSAGE_BYTES = 0xffffffff

/** The texts the extension API puts in `lastError.message` for each way a native port can end. */
export const NATIVE_ERRORS = {
  notFound: 'Specified native messaging host not found.',
  forbidden: 'Access to the specified native messaging host is forbidden.',
  invalidName: 'Invalid native messaging host name specified.',
  startFailed: 'Failed to start native messaging host.',
  exited: 'Native host has exited.',
  io: 'Error when communicating with the native messaging host.'
} as const

const HOST_NAME = /^([a-z0-9_]+\.)*[a-z0-9_]+$/

export function isValidHostName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && HOST_NAME.test(name)
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** One message as a frame. The length is the number of bytes of the UTF-8 text, not the number of characters. */
export function encodeFrame(message: unknown): Uint8Array {
  const json = JSON.stringify(message)
  if (json === undefined) throw new Error('The message cannot be serialized.')
  const body = encoder.encode(json)
  if (body.length > MAX_BROWSER_MESSAGE_BYTES) throw new Error('The message is too large.')
  const frame = new Uint8Array(4 + body.length)
  new DataView(frame.buffer).setUint32(0, body.length, true)
  frame.set(body, 4)
  return frame
}

export interface DecodeResult {
  messages: unknown[]
  /** Set when the stream is not a valid sequence of frames: the connection must be closed, nothing after it is trustworthy. */
  error: string | null
}

/**
 * Cuts a byte stream into messages. A chunk can hold half a message or several, so what is not complete yet is kept for the next push.
 * A frame longer than `maxBytes` or one that is not JSON ends the stream with an error, and no later byte is read.
 * The bytes wait in one buffer that grows by doubling: a host that writes a message a byte at a time costs as much as one that writes it whole.
 */
export class FrameDecoder {
  private buffer = new Uint8Array(4096)
  private start = 0
  private end = 0
  /** Length of the body of the frame being read, once its 4-byte header has been read. */
  private expected: number | null = null
  private failed: string | null = null

  constructor(private readonly maxBytes = MAX_HOST_MESSAGE_BYTES) {}

  push(chunk: Uint8Array): DecodeResult {
    if (this.failed) return { messages: [], error: this.failed }
    this.append(chunk)
    const messages: unknown[] = []
    for (;;) {
      if (this.expected === null) {
        if (this.end - this.start < 4) break
        const length = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.start, 4).getUint32(0, true)
        if (length > this.maxBytes) return this.fail(messages)
        this.start += 4
        this.expected = length
      }
      if (this.end - this.start < this.expected) break
      try {
        messages.push(JSON.parse(decoder.decode(this.buffer.subarray(this.start, this.start + this.expected))))
      } catch {
        return this.fail(messages)
      }
      this.start += this.expected
      this.expected = null
    }
    return { messages, error: null }
  }

  private append(chunk: Uint8Array): void {
    const live = this.end - this.start
    if (this.end + chunk.length > this.buffer.length) {
      // Room is made first by dropping what was already read, then by a bigger buffer.
      const next = live + chunk.length > this.buffer.length ? new Uint8Array(Math.max(this.buffer.length * 2, live + chunk.length)) : this.buffer
      next.set(this.buffer.subarray(this.start, this.end), 0)
      this.buffer = next
      this.start = 0
      this.end = live
    }
    this.buffer.set(chunk, this.end)
    this.end += chunk.length
  }

  private fail(messages: unknown[]): DecodeResult {
    this.failed = NATIVE_ERRORS.io
    this.buffer = new Uint8Array(0)
    this.start = this.end = 0
    return { messages, error: this.failed }
  }
}

export interface HostManifest {
  name: string
  path: string
  allowedOrigins: string[]
}

export type ManifestCheck = { ok: true; manifest: HostManifest } | { ok: false; error: string }

/**
 * Reads a host manifest (`<name>.json`) and checks that it describes the host asked for and lets this extension talk to it.
 * `path` must be absolute: a relative one would depend on where the browser was started.
 */
export function checkHostManifest(text: string, hostName: string, extensionId: string, platform: PlatformId = 'darwin'): ManifestCheck {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: NATIVE_ERRORS.startFailed }
  }
  const data = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const origins = Array.isArray(data['allowed_origins']) ? data['allowed_origins'].filter((o): o is string => typeof o === 'string') : []
  if (data['name'] !== hostName || data['type'] !== 'stdio' || typeof data['path'] !== 'string' || !isAbsolutePath(data['path'], platform)) {
    return { ok: false, error: NATIVE_ERRORS.startFailed }
  }
  if (!origins.includes(`chrome-extension://${extensionId}/`)) return { ok: false, error: NATIVE_ERRORS.forbidden }
  return { ok: true, manifest: { name: hostName, path: data['path'], allowedOrigins: origins } }
}

/** What a host needs to find its programs and its files, and nothing that holds a secret or changes how a program loads. */
const HOST_ENV_UNIX = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TMPDIR', 'TZ', '__CF_USER_TEXT_ENCODING', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS']
const HOST_ENV_WINDOWS = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'TEMP', 'TMP', 'COMPUTERNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']

/**
 * The environment a native host is started with: the few variables a program needs to run (its search path, its home, the language and
 * the temporary folder), not the browser's whole environment. That one can hold tokens and keys of the user's shell, and variables that
 * change how a program loads code (`DYLD_*`, `LD_PRELOAD`, `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`), none of which a host is owed.
 */
export function hostEnvironment(env: Readonly<Record<string, string | undefined>>, platform: PlatformId = 'darwin'): Record<string, string> {
  const windows = platform === 'win32'
  const allowed = new Set(windows ? HOST_ENV_WINDOWS : HOST_ENV_UNIX)
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    // Windows names do not depend on the case; `LC_*` is the family of locale variables.
    if (typeof value === 'string' && (allowed.has(windows ? name.toUpperCase() : name) || (!windows && name.startsWith('LC_')))) kept[name] = value
  }
  return kept
}

/**
 * Where manifests of native messaging hosts are looked for. Lucium's own folder always counts; the folders Chrome uses
 * (this user's, then the system-wide one) only when the user asked for it, because a host found there is started by Lucium
 * and may be the one Chrome talks to.
 */
export function nativeHostDirs(userData: string, home: string, includeChrome: boolean, platform: PlatformId = 'darwin'): string[] {
  const own = `${userData}/NativeMessagingHosts`
  if (!includeChrome) return [own]
  // Chrome on Windows finds a host through a registry key, not a folder: there is nothing to read here (docs/plateformes.md).
  if (platform === 'win32') return [own]
  if (platform === 'linux') return [own, `${home}/.config/google-chrome/NativeMessagingHosts`, '/etc/opt/chrome/native-messaging-hosts']
  return [own, `${home}/Library/Application Support/Google/Chrome/NativeMessagingHosts`, '/Library/Google/Chrome/NativeMessagingHosts']
}
