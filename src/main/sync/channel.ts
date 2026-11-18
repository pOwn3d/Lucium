// One connection of the synchronisation seen as a conversation (docs/synchronisation.md §7): frames in and out, each message checked as hostile text, numbered,
// and in its phase. A flow (the pairing, the session) asks `receive()` for the next message and `send()` for the next answer; what a peer does wrong ends the
// conversation with the code that says why, and the peer is told with an `error` message before the connection closes.
//
//   - the length of a frame is read before its content (frames.ts); a content that is not UTF-8 is a bad message;
//   - the messages of one direction are numbered from 1 (a gap is `bad-sequence`), and a message out of its phase is a bad message (messages.ts);
//   - the contents of a whole connection may not add up to more than `MAX_SNAPSHOT_BYTES`, nor hold more than `MAX_SESSION_VALUES` values (limits.ts: bytes do not bound the work);
//   - `idleMs` of silence is `timeout`; a connection that ends is `ConnectionClosed`.
//
// A fault is sticky: once the channel has failed, `receive()` answers with the same fault, and the socket is closed. Nothing is read after a fault.

import type { Duplex } from 'node:stream'
import { encodeFrame, FrameReader } from './frames'
import { isFatal, type ErrorCode } from './error-codes'
import { IDLE_TIMEOUT_MS, MAX_SESSION_VALUES, MAX_SNAPSHOT_BYTES, PROTOCOL_VERSION } from './limits'
import { messageText, Numbering, parseMessage, PhaseTracker, type Message, type Phase, type Role, type ValueBudget } from './messages'

/** A peer broke a rule of the protocol, or a limit was reached: the code is the one of the catalogue, the detail is for the log and never shown. */
export class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly detail: string
  ) {
    super(`${code}: ${detail}`)
    this.name = 'ProtocolError'
  }
}

/** The connection ended (by the peer, or by the network) while a message was waited for. */
export class ConnectionClosed extends Error {
  constructor(detail = 'the connection ended') {
    super(detail)
    this.name = 'ConnectionClosed'
  }
}

export interface ChannelOptions {
  phase: Phase
  /** Who receives here: the Mac. The phase tracker is told who it listens for. */
  role?: Role
  idleMs?: number
  /** What the contents of one connection may add up to; a session counts them against the snapshot bound. */
  maxContentBytes?: number
  /** How many values the messages of one connection may hold in all. */
  maxValues?: number
}

/** A message to send: its type and its fields; the version and the number are the channel's. */
export type Outgoing = { t: Message['t'] } & Record<string, unknown>

type Waiter = { resolve: (message: Message) => void; reject: (error: Error) => void }

export class Channel {
  private readonly reader = new FrameReader()
  private readonly incoming = new Numbering()
  private readonly outgoing = new Numbering()
  private readonly phase: PhaseTracker
  private readonly queue: Message[] = []
  private waiter: Waiter | null = null
  private fault: Error | null = null
  /** The contents of the frames delivered so far (the reader's own sum runs ahead when one chunk holds several frames). */
  private contentBytes = 0
  private idle: NodeJS.Timeout | null = null
  private readonly idleMs: number
  private readonly maxContentBytes: number
  private readonly values: ValueBudget

  constructor(
    private readonly socket: Duplex,
    options: ChannelOptions
  ) {
    this.phase = new PhaseTracker(options.role ?? 'mac', options.phase)
    this.idleMs = options.idleMs ?? IDLE_TIMEOUT_MS
    this.maxContentBytes = options.maxContentBytes ?? MAX_SNAPSHOT_BYTES
    this.values = { left: options.maxValues ?? MAX_SESSION_VALUES }
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('end', () => this.stop(new ConnectionClosed()))
    socket.on('close', () => this.stop(new ConnectionClosed()))
    socket.on('error', (error: Error) => this.stop(new ConnectionClosed(`the connection failed: ${error.message}`)))
    this.armIdle()
  }

  /** The error that ended the conversation, if one did. */
  failure(): Error | null {
    return this.fault
  }

  /** (Re)starts the silence timer: every byte received is a sign of life. */
  private armIdle(): void {
    if (this.idle !== null) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.abort(new ProtocolError('timeout', `no message for ${this.idleMs} ms`)), this.idleMs)
    this.idle.unref()
  }

  private onData(chunk: Buffer): void {
    if (this.fault !== null) return
    this.armIdle()
    // A fault ends the batch (every refusal below returns): what is behind a bad frame in the same chunk is never looked at.
    for (const event of this.reader.push(chunk)) {
      if (event.kind === 'error') return this.abort(new ProtocolError(event.code, 'the announced length of a frame is not allowed'))
      this.contentBytes += event.content.length
      if (this.contentBytes > this.maxContentBytes) return this.abort(new ProtocolError('too-large', 'the contents of the connection add up to more than the bound'))
      const text = messageText(event.content)
      if (text === null) return this.abort(new ProtocolError('bad-message', 'a frame is not valid UTF-8'))
      const parsed = parseMessage(text, this.values)
      if (!parsed.ok) return this.abort(new ProtocolError(parsed.code, 'a message is refused'))
      const numbered = this.incoming.accept(parsed.message.n)
      if (!numbered.ok) return this.abort(new ProtocolError(numbered.code, `message number ${parsed.message.n} is not the next`))
      const placed = this.phase.accept(parsed.message.t)
      if (!placed.ok) return this.abort(new ProtocolError(placed.code, `a ${parsed.message.t} is not expected here`))
      this.deliver(parsed.message)
    }
  }

  private deliver(message: Message): void {
    if (this.waiter !== null) {
      const { resolve } = this.waiter
      this.waiter = null
      resolve(message)
    } else this.queue.push(message)
  }

  /** The next message, in order. Rejects with the fault (`ProtocolError`) or with `ConnectionClosed`; a message that arrived before the fault is still delivered. */
  receive(): Promise<Message> {
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.fault !== null) return Promise.reject(this.fault)
    return new Promise<Message>((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  /** Writes a message; resolves when it has been handed to the system (so that a flow that sends a long snapshot does not queue it all in memory). */
  send(body: Outgoing): Promise<void> {
    if (this.fault !== null) return Promise.reject(this.fault)
    const frame = encodeFrame({ v: PROTOCOL_VERSION, n: this.outgoing.next(), ...body })
    return new Promise<void>((resolve, reject) => {
      // A write that fails means the connection is gone (a peer that left, a reset): that is the connection ending, not a fault of the conversation.
      this.socket.write(frame, (error) => (error ? reject(new ConnectionClosed(`the connection failed: ${error.message}`)) : resolve()))
    })
  }

  /**
   * Ends the conversation on a code of the catalogue: the peer is told (`error`, fatal for every code but the clocks), the writing side is closed, and everything
   * after is ignored. The send is best effort: the peer may be gone, and that is not another fault.
   */
  fail(code: ErrorCode, detail: string): void {
    const fault = new ProtocolError(code, detail)
    if (this.fault === null) {
      this.fault = fault
      this.rejectWaiter(fault)
    }
    try {
      const frame = encodeFrame({ v: PROTOCOL_VERSION, n: this.outgoing.next(), t: 'error', code, fatal: isFatal(code), detail: detail.slice(0, 200) })
      this.socket.end(frame)
    } catch (error) {
      // The frame could not be written (the socket is already gone): the connection is closed all the same, and the cause is in the log.
      console.error(`[sync] the error ${code} could not be sent to the peer:`, error)
      this.socket.destroy()
    }
    this.clearIdle()
  }

  /** A normal end: `bye`, then the writing side closed. */
  bye(): void {
    try {
      this.socket.end(encodeFrame({ v: PROTOCOL_VERSION, n: this.outgoing.next(), t: 'bye' }))
    } catch (error) {
      console.error('[sync] the bye could not be sent to the peer:', error)
      this.socket.destroy()
    }
    this.clearIdle()
  }

  /** The connection is cut at once (nothing is sent). */
  destroy(): void {
    this.stop(new ConnectionClosed('the connection was cut here'))
    this.socket.destroy()
  }

  /** A fault of the peer or a limit: the peer is told, and every waiting call rejects. */
  private abort(error: ProtocolError): void {
    if (this.fault !== null) return
    this.fail(error.code, error.detail)
  }

  /** The connection ended: waiting calls reject, unless a fault is already the reason. */
  private stop(error: Error): void {
    if (this.fault === null) this.fault = error
    this.rejectWaiter(this.fault)
    this.clearIdle()
  }

  private rejectWaiter(error: Error): void {
    if (this.waiter === null) return
    const { reject } = this.waiter
    this.waiter = null
    reject(error)
  }

  private clearIdle(): void {
    if (this.idle === null) return
    clearTimeout(this.idle)
    this.idle = null
  }
}
