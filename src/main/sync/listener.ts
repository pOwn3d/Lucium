// The Mac's door for the synchronisation (docs/synchronisation.md §6.1): a TLS 1.3 server with the certificates of both sides pinned by fingerprint. It exists only
// while the synchronisation window is open (sync-window.ts starts and stops it); outside a window no port is open.
//
// The order of what happens to a connection is the point of this file:
//   1. the SOURCE address is looked at first, on the raw socket, before a byte is read and before a handshake: a connection that does not come from the local
//      network (§6.2), or from an address that is being refused (§6.1), is closed at once. For that the server is a plain `net.Server` and the TLS is put on each
//      accepted socket by hand (`tls.TLSSocket`, `isServer`): the handshake of a stranger never starts;
//   2. at most 5 connections are open at once (4 sessions and 1 pairing) before the handshake counts; the handshake has 10 seconds;
//   3. TLS 1.3 only, ALPN `lucium-sync/1`, and the client MUST present a certificate; the certificate is self-signed, so the chain is not judged (`rejectUnauthorized:
//      false`): the code compares the fingerprint itself, and only that;
//   4. the fingerprint of the certificate decides what the connection may do: the one of a paired device opens a session; an unknown one may only pair, and only
//      while a pairing is open; anything else is told `not-paired` and closed, and counts as a failure of its address. Nothing a connection says is read before then;
//   5. a pairing has ONE place. The connection that holds it may not keep it by saying nothing: until it has sent its `pair.request` it is safe for
//      `PAIRING_REQUEST_GRACE_MS`, and after that the next stranger takes its place (it is cut and counted as a failure of its address). One that has sent its request is
//      never moved: it is waiting for the person, or already refused.
//
// The checks that decide are not here but passed in (the list of devices, the open pairing, the session), so that each is tested alone.

import { createHash } from 'node:crypto'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { createSecureContext, TLSSocket, type SecureContext } from 'node:tls'
import { ALPN, HANDSHAKE_TIMEOUT_MS, IDLE_TIMEOUT_MS, MAX_CONNECTIONS, MAX_PAIRING_CONNECTIONS, PAIRING_REQUEST_GRACE_MS, PROTOCOL_VERSION, SESSION_MAX_MS } from './limits'
import { isLocalSource } from './address-policy'
import { certificatePem } from './certificate'
import { Channel } from './channel'
import { isFatal, type ErrorCode } from './error-codes'
import { encodeFrame } from './frames'
import { runPairing, type PairingContext, type PairingOutcome } from './pairing-server'
import type { AddressLimiter } from './rate-limit'
import type { SyncIdentity } from './identity'
import type { PeerRecord } from './sync-store'

/** What an open pairing gives the listener to run one: the context of the flow (the secret, the confirmation); null when no pairing is open. */
export type OpenPairing = (peerFingerprint: Buffer) => Omit<PairingContext, 'peerFingerprint' | 'peerAddress' | 'device'> | null

export interface ListenerDeps {
  identity: SyncIdentity
  /** The name this Mac gives itself (what the iPhone shows). */
  deviceName: () => string
  limiter: AddressLimiter
  /** The paired device of a fingerprint, in lower-case hexadecimal, or undefined. */
  findPeer: (fingerprint: string) => PeerRecord | undefined
  /** The pairing that is open now, if one is. */
  openPairing: OpenPairing
  /** A session with a paired device: the flow of session.ts. It owns the channel until it returns. */
  runSession: (channel: Channel, peer: PeerRecord) => Promise<void>
  /** Told when a pairing ended, whatever way. */
  onPairingEnded?: (outcome: PairingOutcome) => void
  /** Told of what the door did, for the log and for the state the page shows. */
  onEvent?: (event: ListenerEvent) => void
  /**
   * The source addresses that may connect. The default is the local network (§6.2); a test that talks over the loopback widens it, and nothing else does.
   */
  allowSource?: (address: string | undefined) => boolean
  idleMs?: number
  handshakeMs?: number
  sessionMaxMs?: number
  /** How long a connection that has not yet asked to pair keeps the only place of a pairing (a test shortens it). */
  pairingGraceMs?: number
  /** A monotonic millisecond clock (a test puts its own). */
  clock?: () => number
}

export type ListenerEvent =
  | { kind: 'refused-source'; address: string | undefined }
  | { kind: 'refused-limited'; address: string }
  | { kind: 'refused-full'; address: string }
  | { kind: 'handshake-failed'; address: string; reason: string }
  | { kind: 'socket-error'; address: string; reason: string }
  | { kind: 'not-paired'; address: string }
  | { kind: 'session'; peer: PeerRecord }
  | { kind: 'pairing'; address: string }

const sha256 = (data: Buffer): Buffer => createHash('sha256').update(data).digest()

/** How long a connection we refused is given to take the `error` we wrote before it is cut. */
const REFUSAL_GRACE_MS = 1000

export class SyncListener {
  private server: Server | null = null
  private context: SecureContext | null = null
  private readonly sockets = new Set<Socket>()
  private sessions = 0
  /** The connections that hold a place of a pairing, with when they took it and whether they have asked to pair yet. */
  private readonly pairings = new Map<TLSSocket, { since: number; requested: boolean }>()
  /** The connections of each paired device, by fingerprint (lower-case hexadecimal): « Oublier » cuts them at once (§12). */
  private readonly byFingerprint = new Map<string, Set<TLSSocket>>()

  constructor(private readonly deps: ListenerDeps) {}

  /** A device was forgotten: every connection it has is cut now, not at its next session (§12: the Mac refuses at once). Returns how many were cut. */
  dropPeer(fingerprint: string): number {
    const sockets = this.byFingerprint.get(fingerprint)
    if (sockets === undefined) return 0
    for (const socket of sockets) socket.destroy()
    this.byFingerprint.delete(fingerprint)
    return sockets.size
  }

  /** The port the door listens on, or null while it is closed. */
  port(): number | null {
    const address = this.server?.address()
    return address !== null && address !== undefined && typeof address === 'object' ? (address as AddressInfo).port : null
  }

  listening(): boolean {
    return this.server !== null
  }

  /** How many connections are in progress: those that passed the door and have not ended. */
  open(): { sessions: number; pairings: number; total: number } {
    return { sessions: this.sessions, pairings: this.pairings.size, total: this.sockets.size }
  }

  /**
   * Opens the door on `port` on every interface (the source of each connection is looked at, §6.2). Rejects when the port is taken (`EADDRINUSE`): the caller draws
   * another one and says so. A second call while open does nothing.
   */
  start(port: number): Promise<number> {
    if (this.server !== null) return Promise.resolve(this.port() ?? port)
    this.context = createSecureContext({ key: this.deps.identity.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: certificatePem(this.deps.identity.certificate), minVersion: 'TLSv1.3' })
    const server = createServer({ noDelay: true }, (socket) => this.admit(socket))
    return new Promise<number>((resolve, reject) => {
      server.once('error', (error) => {
        this.context = null
        reject(error)
      })
      server.listen({ port, host: '::', ipv6Only: false }, () => {
        this.server = server
        server.on('error', (error) => console.error('[sync] the listening socket failed:', error))
        resolve((server.address() as AddressInfo).port)
      })
    })
  }

  /** Closes the door and every connection in progress; resolves when the port is released. Nothing stays open after the window. */
  stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.context = null
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.byFingerprint.clear()
    this.pairings.clear()
    if (server === null) return Promise.resolve()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private admit(raw: Socket): void {
    const address = raw.remoteAddress
    const allow = this.deps.allowSource ?? isLocalSource
    // 1. The source, before anything is read or any handshake starts.
    if (!allow(address)) {
      this.deps.onEvent?.({ kind: 'refused-source', address })
      raw.destroy()
      return
    }
    const from = address as string
    if (this.deps.limiter.isRefused(from)) {
      this.deps.onEvent?.({ kind: 'refused-limited', address: from })
      raw.destroy()
      return
    }
    // 2. At most four sessions and one pairing: the handshakes in progress count too.
    if (this.sockets.size >= MAX_CONNECTIONS + MAX_PAIRING_CONNECTIONS || this.context === null) {
      this.deps.onEvent?.({ kind: 'refused-full', address: from })
      this.deps.limiter.recordFailure(from)
      raw.destroy()
      return
    }
    this.sockets.add(raw)
    raw.once('close', () => this.sockets.delete(raw))

    // 3. TLS 1.3, ALPN, a certificate from the client; the chain is not judged, the fingerprint is.
    const tls = new TLSSocket(raw, { isServer: true, secureContext: this.context, requestCert: true, rejectUnauthorized: false, ALPNProtocols: [ALPN] })
    const handshake = setTimeout(() => this.failHandshake(tls, from, 'the handshake took more than the time allowed'), this.deps.handshakeMs ?? HANDSHAKE_TIMEOUT_MS)
    handshake.unref()
    const onHandshakeError = (error: Error): void => {
      clearTimeout(handshake)
      this.failHandshake(tls, from, error.message)
    }
    tls.once('error', onHandshakeError)
    // An error of the raw socket (a connection reset) reaches the TLS socket too; this one says where it came from.
    raw.on('error', (error) => this.deps.onEvent?.({ kind: 'socket-error', address: from, reason: error.message }))
    tls.once('secure', () => {
      clearTimeout(handshake)
      // From here an error is that of an established connection: the flow that owns it (or the refusal below) deals with it, not the handshake.
      tls.off('error', onHandshakeError)
      tls.on('error', (error: Error) => this.deps.onEvent?.({ kind: 'socket-error', address: from, reason: error.message }))
      this.classify(tls, from)
    })
  }

  private failHandshake(tls: TLSSocket, address: string, reason: string): void {
    this.deps.onEvent?.({ kind: 'handshake-failed', address, reason })
    this.deps.limiter.recordFailure(address)
    tls.destroy()
  }

  /** The handshake is done: what the fingerprint of the client's certificate lets this connection do. */
  private classify(tls: TLSSocket, address: string): void {
    if (tls.getProtocol() !== 'TLSv1.3' || tls.alpnProtocol !== ALPN) return this.failHandshake(tls, address, `protocol ${String(tls.getProtocol())} / ${String(tls.alpnProtocol)} is not ours`)
    const certificate = tls.getPeerX509Certificate()
    if (certificate === undefined) return this.failHandshake(tls, address, 'the client presented no certificate')
    const fingerprint = sha256(certificate.raw)
    const peer = this.deps.findPeer(fingerprint.toString('hex'))
    const offer = this.deps.openPairing(fingerprint)
    // A device the Mac already knows, while a pairing is open and its place is free: the person opened « Ajouter un iPhone » and this is the device that scans. It forgot the Mac and
    // the Mac did not forget it (the `unpair` was lost: the Mac was off, or was being replaced), so it is led through the pairing, which replaces its record. Taken for a session
    // it would be told `hello` where it waits for `pair.challenge`, and could never pair again until the person forgot it on the Mac first (the trial of 19 November 2026).
    // The pairing still needs the secret of the QR, so a known fingerprint gives nothing more than the QR does; with no pairing open, or its place taken, it keeps its session.
    if (peer !== undefined && (offer === null || this.pairings.size >= MAX_PAIRING_CONNECTIONS)) return this.startSession(tls, address, peer)
    if (offer === null || (this.pairings.size >= MAX_PAIRING_CONNECTIONS && !this.takeSilentPlace())) {
      // A stranger, or a pairing already running: told once, closed, counted. What it sends is never read.
      this.deps.onEvent?.({ kind: 'not-paired', address })
      this.deps.limiter.recordFailure(address)
      this.refuse(tls, offer === null ? 'not-paired' : 'busy', 'this device is not paired')
      return
    }
    this.startPairing(tls, address, fingerprint, offer)
  }

  /**
   * Frees a place of a pairing for a newcomer when one of the connections that hold them has not asked to pair within the grace it was given. It is cut at once (its flow
   * ends as a failed pairing, which counts against its address). Whether a place was freed.
   */
  private takeSilentPlace(): boolean {
    const now = (this.deps.clock ?? (() => performance.now()))()
    const grace = this.deps.pairingGraceMs ?? PAIRING_REQUEST_GRACE_MS
    for (const [holder, state] of this.pairings) {
      if (state.requested || now - state.since < grace) continue
      this.pairings.delete(holder)
      holder.destroy()
      return true
    }
    return false
  }

  /**
   * Tells a connection why it is refused and cuts it, without reading a byte of what it sends: the one frame written is the first of the connection (number 1), and no
   * reader is attached, so a stranger's frames are never parsed.
   */
  private refuse(tls: TLSSocket, code: ErrorCode, detail: string): void {
    tls.end(encodeFrame({ v: PROTOCOL_VERSION, n: 1, t: 'error', code, fatal: isFatal(code), detail }))
    setTimeout(() => tls.destroy(), REFUSAL_GRACE_MS).unref()
  }

  private startSession(tls: TLSSocket, address: string, peer: PeerRecord): void {
    if (this.sessions >= MAX_CONNECTIONS) {
      this.refuse(tls, 'busy', 'too many sessions are open')
      return
    }
    this.sessions++
    const live = this.byFingerprint.get(peer.fingerprint) ?? new Set<TLSSocket>()
    live.add(tls)
    this.byFingerprint.set(peer.fingerprint, live)
    tls.once('close', () => {
      live.delete(tls)
      if (live.size === 0 && this.byFingerprint.get(peer.fingerprint) === live) this.byFingerprint.delete(peer.fingerprint)
    })
    this.deps.onEvent?.({ kind: 'session', peer })
    const channel = new Channel(tls, { phase: 'session', idleMs: this.deps.idleMs ?? IDLE_TIMEOUT_MS })
    const limit = setTimeout(() => channel.fail('timeout', 'the session lasted more than the time allowed'), this.deps.sessionMaxMs ?? SESSION_MAX_MS)
    limit.unref()
    tls.once('close', () => {
      clearTimeout(limit)
      this.sessions--
    })
    this.deps.runSession(channel, peer).catch((error: unknown) => {
      console.error(`[sync] a session with ${peer.id} ended on an error:`, error)
      this.deps.limiter.recordFailure(address)
      channel.fail('internal', 'the session failed')
    })
  }

  private startPairing(tls: TLSSocket, address: string, peerFingerprint: Buffer, offer: NonNullable<ReturnType<OpenPairing>>): void {
    const place = { since: (this.deps.clock ?? (() => performance.now()))(), requested: false }
    this.pairings.set(tls, place)
    this.deps.onEvent?.({ kind: 'pairing', address })
    const channel = new Channel(tls, { phase: 'pairing', idleMs: this.deps.idleMs ?? IDLE_TIMEOUT_MS })
    tls.once('close', () => void this.pairings.delete(tls))
    const onRequest = (): void => {
      place.requested = true
      offer.onRequest?.()
    }
    void runPairing(channel, { ...offer, onRequest, device: { id: this.deps.identity.deviceId, name: this.deps.deviceName(), fingerprint: this.deps.identity.fingerprint }, peerFingerprint, peerAddress: address }).then((outcome) => {
      if (outcome.outcome === 'failed') this.deps.limiter.recordFailure(address)
      this.deps.onPairingEnded?.(outcome)
    })
  }
}
