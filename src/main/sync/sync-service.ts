// The synchronisation with the iPhone as the Settings page sees it (docs/synchronisation.md §13.1): one object that owns the switch, the listening, the pairing sheet
// and the list of devices, and that the IPC channel (shell/sync-ipc.ts) drives. It holds the pieces of src/main/sync/ together and decides nothing they do not:
//
//   - the switch is OFF by default; turning it on makes the identity (key sealed by the system, certificate);
//   - the Mac LISTENS (the door is open) exactly while the switch is on, the application is unlocked, and an iPhone is paired or a pairing is open (§6.1, decided by the
//     project lead on 19 November 2026: automatic synchronisation). `reconcileListening` is the one place that decides it, and every event that can change the answer
//     (the switch, the lock, a device paired or forgotten, a pairing that ends or expires, the launch) calls it;
//   - « Ajouter un iPhone » opens the door if it is not open, draws a secret, and builds the QR and the code; the sheet is the secret's life (two minutes), and the door
//     closes with it when no iPhone is paired;
//   - when an iPhone proves it holds the secret, the person is asked: Autoriser or Refuser, and no answer in a minute is a refusal [Q7];
//   - the pairing closes when the page is left, when the switch is cut, and when the application locks (the door closes with them);
//   - « Oublier » removes a device and cuts what it has open at once (§12).
//
// The exchange of data itself (the session, §8) is a flow handed in (`runSession`): until it exists, a device that connects is told `internal`, honestly.

import { createHash, randomInt, randomBytes } from 'node:crypto'
import { encodeQr } from '@shared/qr'
import { SYNC_CATEGORIES, type SyncCategory, type SyncLastExchange, type SyncPairingView, type SyncProblem, type SyncStatus } from '@shared/sync-ipc'
import { BaseStore } from './bases'
import type { Channel } from './channel'
import { CONFIRM_MS, FINGERPRINT_BYTES, IDENTITY_REPLACE_DELAY_MS, SECRET_BYTES } from './limits'
import { MarkStore } from './mark-store'
import type { MarkBook } from './marks'
import type { OpenTab } from './messages'
import { runSession as runExchange, type ClosedShownTab, type SessionHost } from './session'
import { MarkTracker } from './sync-tracker'
import { IdentityNotOpenableError, type IdentityStore, type SyncIdentity } from './identity'
import { SyncListener, type ListenerDeps } from './listener'
import { manualAddress, manualCode, qrText } from './pairing-code'
import { PairingSecret } from './pairing-secret'
import type { PairingRequestInfo } from './pairing-server'
import { AddressLimiter } from './rate-limit'
import { ownHosts, type HostEnvironment } from './own-hosts'
import { isResumeId, resumeRows, type ResumeRow, type ResumeTab } from '@shared/sync-resume'
import type { SafeClock } from './safe-clock'
import type { SecretBox } from './secret-box'
import { PORT_MAX, PORT_MIN, type PeerRecord, type SyncStore } from './sync-store'
import { SyncListening, type ListeningCloseReason } from './sync-listening'

/** What a request of the page could not do, with the word the page says it with. */
export class SyncServiceError extends Error {
  constructor(
    readonly problem: SyncProblem,
    detail: string
  ) {
    super(`${problem}: ${detail}`)
    this.name = 'SyncServiceError'
  }
}

/** The part of the listener the service uses: the real one, or a stand-in in a test. */
export interface SyncDoor {
  start(port: number): Promise<number>
  stop(): Promise<void>
  port(): number | null
  dropPeer(fingerprint: string): number
}

export interface SyncServiceDeps {
  store: SyncStore
  identities: IdentityStore
  box: SecretBox
  /** Elapsed milliseconds (a `SafeClock`): the window, the pairing and the question are counted with it. */
  clock: SafeClock
  hostEnv: () => HostEnvironment
  deviceName: () => string
  now: () => number
  /** Whether the application is locked now: nothing opens while it is. */
  isLocked: () => boolean
  /** The session with a paired device (§8), when a test puts its own. Without it, the exchange of `session` below is run, and without that a device is told `internal`. */
  runSession?: (channel: Channel, peer: PeerRecord) => Promise<void>
  /** What the exchange of the data (§8) needs of this device: its state, where its marks and bases are kept, its versions. */
  session?: SessionPorts
  /** Told when anything the page shows changed. */
  onChange?: () => void
  /** A port of the dynamic range, at random. */
  pickPort?: () => number
  /** The door: the real listener, made from what the service gives it, unless a test puts another. */
  makeDoor?: (deps: ListenerDeps) => SyncDoor
  /** Tests only: the source addresses that may connect (the loopback). Nothing else widens the filter of §6.2. */
  allowSource?: ListenerDeps['allowSource']
  confirmMs?: number
  /** How long after a pairing ends the door is looked at again (a test shortens it): the refusal the iPhone is owed must leave before the door can close. */
  settleMs?: number
}

export interface SessionPorts {
  host: SessionHost
  /** Told at every change of the state (the marks follow it while the switch is on). */
  subscribe: (listener: () => void) => () => void
  marksFile: string
  basesDir: string
  appVersion: string
  stateVersion: number
  /** The tabs announced when the category « Onglets ouverts » is common. */
  openTabs?: () => OpenTab[]
  /** Told when a session closed a Today tab that was the selected one of its space (§27.5, [Q11]); the line « Fermé sur l'iPhone » is the interface card's. */
  onShownTabsClosed?: (peerId: string, tabs: ClosedShownTab[]) => void
}

/** The source address of a connection as a person reads it: no `::ffff:` in front of an IPv4 address, no zone (`%en0`), and nothing but what an address is made of. */
export const readableAddress = (address: string): string => address.replace(/^::ffff:/i, '').replace(/%.*$/, '').replace(/[^0-9a-fA-F:.]/g, '').slice(0, 45)

/** A device name as a person reads it: a control character or a mark that turns the text round is a space (a name is shown as written by the other device). */
export const readableName = (name: string): string => name.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').trim()

const EADDRINUSE = 'EADDRINUSE'
/**
 * What the system says of a port it will not give: taken (`EADDRINUSE`), or refused (`EACCES`). The ports of the dynamic range are never ones that need rights, but Windows keeps
 * ranges of them for itself (Hyper-V, WinNAT: `netsh int ipv4 show excludedportrange`) and answers `EACCES` for them: the same remedy as for a port that is taken, another one.
 */
const PORT_UNAVAILABLE: readonly string[] = [EADDRINUSE, 'EACCES']
const PORT_TRIES = 5

export class SyncService {
  private identity: SyncIdentity | null = null
  private identityReplaced = false
  /** How many times the key was found sealed and not opened since the application started: the second time, a new identity is made (review n° 22). */
  /** When the identity first could not be used (on the clock of the windows), or null: a minute after it, the next try may replace the identity (review n° 41). */
  private identityRefusedAt: number | null = null
  private door: SyncDoor | null = null
  private pairing: { secret: PairingSecret; view: Omit<SyncPairingView, 'remainingMs'> } | null = null
  /** The question of [Q7]: asked, then (once the person allowed) waiting for the iPhone's person to compare the code (§4.6). */
  private confirm: { name: string; code: string; address: string; until: number; waiting: boolean; resolve: (decision: 'allow' | 'refuse') => void } | null = null
  /** Ends the wait for the iPhone's person when the Mac's gives up on it. */
  private giveUp: (() => void) | null = null
  private justPaired: string | null = null
  private problem: SyncProblem | null = null
  private readonly limiter: AddressLimiter
  private readonly listening: SyncListening
  /** The decisions of `reconcileListening` run one after the other: two at once could open and close the door in the wrong order. */
  private reconciling: Promise<void> = Promise.resolve()
  private pairingTimer: NodeJS.Timeout | null = null
  private settleTimer: NodeJS.Timeout | null = null
  private marks: MarkBook | null = null
  private marksStore: MarkStore | null = null
  private bases: BaseStore | null = null
  private tracker: MarkTracker | null = null
  private exchanging = false
  private lastExchange: SyncLastExchange | null = null
  /** What the other devices announced as their open tabs: in memory only, never written, forgotten with the window and with the device (§10.4). */
  private readonly announced = new Map<string, { items: OpenTab[]; at: number }>()
  /** The devices that went through a session since the lists were last forgotten: « it sent nothing » is only told after one (§10.4). */
  private readonly sessionSeen = new Set<string>()

  constructor(private readonly deps: SyncServiceDeps) {
    this.limiter = new AddressLimiter(() => deps.clock.elapsed())
    this.listening = new SyncListening({
      door: { start: () => this.startDoor(), stop: () => this.stopDoor() },
      onChange: (state, reason) => {
        if (!state.open && reason !== undefined) this.doorClosed()
        this.changed()
      }
    })
  }

  private changed(): void {
    this.deps.onChange?.()
  }

  // ---------- what the page shows ----------

  status(): SyncStatus {
    const config = this.deps.store.config()
    const pairing = this.livePairing()
    const confirm = this.confirm
    return {
      available: this.deps.box.available(),
      enabled: config.enabled,
      categories: config.categories,
      listening: this.listening.state().open,
      pairing: pairing === null || pairing.view.qr === '' ? null : { ...pairing.view, remainingMs: pairing.secret.remainingMs() },
      confirm: confirm === null ? null : { name: confirm.name, code: confirm.code, address: confirm.address, waiting: confirm.waiting, remainingMs: Math.max(0, confirm.until - this.deps.clock.elapsed()) },
      devices: config.peers.map((peer) => ({ id: peer.id, name: readableName(peer.name), platform: peer.platform, pairedAt: peer.pairedAt, lastSessionAt: peer.lastSessionAt })),
      identityReplaced: this.identityReplaced,
      justPaired: this.justPaired,
      lastExchange: this.lastExchange,
      problem: this.problem
    }
  }

  /** The pairing whose secret still lives; one that has expired is dropped here, so that the sheet closes by itself. */
  private livePairing(): NonNullable<SyncService['pairing']> | null {
    if (this.pairing !== null && this.pairing.secret.remainingMs() === 0) this.dropExpiredPairing()
    return this.pairing
  }

  /** The secret ran out: the sheet goes, and the door with it when nobody is paired (a Mac with no iPhone listens only for the two minutes of a pairing, §4.1, §6.1). */
  private dropExpiredPairing(): void {
    this.pairing = null
    this.clearPairingTimer()
    this.resolveConfirm('refuse')
    this.reconcileLater(0)
  }

  private clearPairingTimer(): void {
    if (this.pairingTimer !== null) clearTimeout(this.pairingTimer)
    this.pairingTimer = null
  }

  /** The door is looked at again when the secret is due to run out: nobody asks the page for its state for this to happen. */
  private armPairingTimer(): void {
    this.clearPairingTimer()
    const wait = (): number => (this.pairing?.secret.remainingMs() ?? 0) + 50
    const fire = (): void => {
      this.pairingTimer = null
      if (this.pairing === null) return
      if (this.pairing.secret.remainingMs() > 0) {
        // The safe clock has not counted it all yet (a sleep, a clock put back): look again later rather than close early.
        this.pairingTimer = setTimeout(fire, wait())
        this.pairingTimer.unref()
        return
      }
      this.dropExpiredPairing()
      this.changed()
    }
    this.pairingTimer = setTimeout(fire, wait())
    this.pairingTimer.unref()
  }

  /** Every request of the page starts here: what the last one left behind is forgotten, except what is shown once. */
  private begin(): void {
    this.problem = null
    this.justPaired = null
  }

  private fail(problem: SyncProblem, detail: string): never {
    this.problem = problem
    this.changed()
    throw new SyncServiceError(problem, detail)
  }

  // ---------- the switch and the categories ----------

  /**
   * Turns the synchronisation on or off. On: the identity is made (the key sealed), and the Mac listens when an iPhone is already paired (the devices are kept while it is
   * off). Off: the pairing and the door close.
   */
  async setEnabled(on: boolean): Promise<void> {
    this.begin()
    if (on) {
      if (!this.deps.box.available()) this.fail('unavailable', 'the system cannot seal the key of the device')
      const identity = this.ensureIdentity()
      this.deps.store.setEnabled(true)
      this.startTracking(identity.deviceId)
      await this.reconcileListening()
    } else {
      this.deps.store.setEnabled(false)
      this.closePairingSheet()
      await this.reconcileListening()
      this.forgetAnnounced()
      this.stopTracking()
    }
    this.changed()
  }

  /**
   * The application starts: when the switch is on, the marks follow the state again (the identifier is read from the file without opening the key, so that the launch
   * never asks the keychain). Off, nothing is done: nothing is read, nothing subscribed.
   */
  start(): void {
    if (!this.deps.store.config().enabled) return
    const device = this.deps.identities.peekDeviceId()
    if (device !== null) this.startTracking(device)
    // The Mac listens from the launch when an iPhone is paired (and the application is not locked: the unlock opens the door). The key is opened by the system's
    // keychain for this; a refusal is logged and shown on the page, never thrown into the launch.
    this.reconcileLater(0)
  }

  private startTracking(deviceId: string): void {
    const ports = this.deps.session
    if (ports === undefined || this.tracker?.running() === true) return
    this.marksStore ??= new MarkStore(ports.marksFile)
    this.bases ??= new BaseStore(ports.basesDir)
    const store = this.marksStore
    this.marks ??= store.load(deviceId)
    const marks = this.marks
    this.tracker = new MarkTracker({ state: ports.host.state, subscribe: ports.subscribe, marks, save: () => store.save(marks), now: this.deps.now })
    this.tracker.start()
  }

  private stopTracking(): void {
    this.tracker?.halt()
    this.tracker = null
  }

  setCategory(category: SyncCategory, on: boolean): void {
    this.begin()
    if (!(SYNC_CATEGORIES as readonly string[]).includes(category)) this.fail('internal', `${category} is not a category`)
    this.deps.store.setCategory(category, on)
    // Unticked: what the iPhone said it had open is forgotten at once, not at the next session.
    if (category === 'openTabs' && !on) this.forgetAnnounced()
    this.changed()
  }

  private ensureIdentity(): SyncIdentity {
    if (this.identity !== null) return this.identity
    try {
      const waited = this.identityRefusedAt !== null && this.deps.clock.elapsed() - this.identityRefusedAt >= IDENTITY_REPLACE_DELAY_MS
      const made = this.deps.identities.loadOrCreate({ replaceUnusable: waited })
      this.identityRefusedAt = null
      this.identity = made.identity
      if (made.replaced) {
        // The old fingerprint is gone with the old key: the devices that were paired to it cannot be recognised any more (§3.3), and what was kept for them goes too.
        for (const peer of this.deps.store.peers()) this.bases?.remove(peer.id)
        this.deps.store.clearPeers()
        this.stopTracking()
        this.marks = null
        this.identityReplaced = true
      }
      return made.identity
    } catch (error) {
      if (error instanceof IdentityNotOpenableError) {
        // The identity cannot be used now (the keychain did not open the key, or the file cannot be read): it and the devices paired to it are kept, and the person is told. If
        // it still cannot be used when they try again a minute after the first refusal (a profile restored on another machine, a key that is gone), a new identity is made then.
        this.identityRefusedAt ??= this.deps.clock.elapsed()
        console.error('[sync] the identity of this Mac could not be used; the devices stay paired, and a new identity is made if it still cannot be used a minute after the first refusal:', error)
        return this.fail('identity-unopenable', 'the key could not be opened')
      }
      console.error('[sync] the identity of this Mac could not be made or read:', error)
      return this.fail('identity', 'the identity could not be made')
    }
  }

  // ---------- the listening ----------

  /**
   * Whether the Mac must listen now (§6.1): the switch is on, the application is unlocked, and an iPhone is paired or a pairing is open. Anything else and no port is open.
   * An application that is locked never listens, whatever else is true.
   */
  private wantsToListen(): boolean {
    if (!this.deps.store.config().enabled || this.deps.isLocked()) return false
    return this.deps.store.peers().length > 0 || this.livePairing() !== null
  }

  private whyNotListening(): ListeningCloseReason {
    if (!this.deps.store.config().enabled) return 'switch-off'
    return this.deps.isLocked() ? 'locked' : 'no-device'
  }

  /**
   * Opens or closes the door so that it matches `wantsToListen`. Calls are run one after the other. A refusal of the system (the port, the key) is the caller's to see: it
   * is told as a problem of the page, and the door stays closed until the next event asks again.
   */
  reconcileListening(): Promise<void> {
    const run = this.reconciling.then(async () => {
      if (this.wantsToListen()) await this.openDoor()
      else await this.listening.close(this.whyNotListening())
    })
    // The chain goes on whatever one decision gave: that decision's error is the one `run` carries to its caller, and the callers that do not wait log it (`reconcileLater`).
    this.reconciling = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** The decision, made later and with nobody waiting: the error is logged with its context, and the page shows the problem. */
  private reconcileLater(delayMs: number): void {
    const run = (): void => void this.reconcileListening().catch((error: unknown) => console.error('[sync] the listening could not be set as it should be:', error))
    if (delayMs <= 0) return run()
    if (this.settleTimer !== null) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      run()
    }, delayMs)
    this.settleTimer.unref()
  }

  private async openDoor(): Promise<void> {
    try {
      this.ensureIdentity()
      await this.listening.open()
    } catch (error) {
      if (error instanceof SyncServiceError) throw error
      console.error('[sync] the door could not be opened:', error)
      return this.fail(PORT_UNAVAILABLE.includes((error as NodeJS.ErrnoException).code ?? '') ? 'port' : 'internal', 'the door could not be opened')
    }
  }

  /** The page was left (another page, the window closed): the sheet of the pairing goes with it; the listening does not depend on the page. */
  async leave(): Promise<void> {
    this.closePairingSheet()
    await this.reconcileListening()
  }

  /** The application locked or unlocked: a lock closes the door and the sheet, an unlock opens the door again when an iPhone is paired. */
  async lockChanged(): Promise<void> {
    if (this.deps.isLocked()) {
      // What the iPhone had open is what a person reads: it does not stay in memory behind a lock.
      this.forgetAnnounced()
    }
    await this.reconcileListening()
  }

  private async startDoor(): Promise<void> {
    const identity = this.ensureIdentity()
    const door = this.deps.makeDoor?.(this.listenerDeps(identity)) ?? new SyncListener(this.listenerDeps(identity))
    const pick = this.deps.pickPort ?? ((): number => randomInt(PORT_MIN, PORT_MAX + 1))
    let port = this.deps.store.port(pick)
    for (let attempt = 1; ; attempt++) {
      try {
        await door.start(port)
        this.door = door
        return
      } catch (error) {
        // A port that is taken or that the system refuses is replaced by another one, kept for next time; any other reason, or too many tries, is the caller's to show.
        if (!PORT_UNAVAILABLE.includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= PORT_TRIES) throw error
        console.warn(`[sync] the port ${port} is taken or refused, trying another one`)
        port = pick()
        this.deps.store.replacePort(port)
      }
    }
  }

  /**
   * The port the door listens on now (review n° 38): the one the door is on, which is not always the one of the QR (a port that is taken or refused is replaced, §6.1). Said to
   * the iPhone in `pair.accept` and in every `hello`, so that it does not keep a port that no longer answers. A door that is not up has no port to say: nothing runs then.
   */
  private currentPort(): number {
    const port = this.door?.port() ?? this.deps.store.config().port
    if (port === null || port === undefined) throw new Error('the Mac has no port to say: the door is not open')
    return port
  }

  private async stopDoor(): Promise<void> {
    const door = this.door
    this.door = null
    await door?.stop()
  }

  /** The door has closed, for whatever reason: nobody can be asked or paired any more. */
  private doorClosed(): void {
    // The list of the iPhone's open tabs is not forgotten here: it stays in memory after the door closes, with its age, until the lock, the quit, the unticked category or the forgotten device.
    this.pairing?.secret.close()
    this.pairing = null
    this.resolveConfirm('refuse')
  }

  private listenerDeps(identity: SyncIdentity): ListenerDeps {
    return {
      identity,
      deviceName: this.deps.deviceName,
      limiter: this.limiter,
      findPeer: (fingerprint) => this.deps.store.findByFingerprint(fingerprint),
      openPairing: () => {
        const pairing = this.livePairing()
        if (pairing === null) return null
        return { secret: pairing.secret, confirm: (request) => this.ask(request), waiting: () => this.waitForPhone(), addPeer: (peer) => this.deps.store.addPeer(peer), hosts: () => ownHosts(this.deps.hostEnv()), port: () => this.currentPort(), now: this.deps.now, ...(this.deps.confirmMs !== undefined ? { confirmMs: this.deps.confirmMs } : {}) }
      },
      runSession: this.deps.runSession ?? (this.deps.session !== undefined ? (channel, peer) => this.exchange(channel, peer, identity.deviceId) : async (channel) => channel.fail('internal', 'the exchange of data is not available yet')),
      onPairingEnded: (outcome) => {
        if (outcome.outcome === 'paired') {
          this.justPaired = readableName(outcome.peer.name)
          this.pairing = null
        } else if (outcome.code === 'pairing-refused') this.pairing = null
        this.resolveConfirm('refuse')
        // A pairing that ended with nobody paired closes the door, but not before the answer the iPhone is owed has left: closing the door drops its connection.
        if (this.pairing === null) this.clearPairingTimer()
        this.reconcileLater(this.deps.settleMs ?? 2000)
        this.changed()
      },
      ...(this.deps.allowSource !== undefined ? { allowSource: this.deps.allowSource } : {})
    }
  }

  // ---------- the pairing ----------

  /** « Ajouter un iPhone »: draws a secret (which makes the Mac listen if it was not), and builds what the sheet shows. */
  async startPairing(): Promise<void> {
    this.begin()
    if (!this.deps.store.config().enabled) this.fail('internal', 'the synchronisation is off')
    if (this.deps.isLocked()) this.fail('locked', 'the application is locked')
    const identity = this.ensureIdentity()
    // The secret exists before the door opens: with nobody paired the door opens for it (`wantsToListen`). The sheet is not shown (`status`) until its QR is built, and a
    // pairing that cannot be shown leaves nothing behind: no secret, no open door.
    const secret = new PairingSecret(randomBytes(SECRET_BYTES), () => this.deps.clock.elapsed())
    this.pairing?.secret.close()
    this.pairing = { secret, view: { qr: '', code: '', address: '' } }
    try {
      await this.reconcileListening()
      this.pairing = { secret, view: this.pairingView(identity, secret) }
    } catch (error) {
      this.closePairingSheet()
      this.reconcileLater(0)
      throw error
    }
    this.armPairingTimer()
    this.changed()
  }

  /** What the sheet shows: the QR, the code to type and the address. Fails (and says why) when this Mac has no address of the local network or the code cannot be drawn. */
  private pairingView(identity: SyncIdentity, secret: PairingSecret): Omit<SyncPairingView, 'remainingMs'> {
    const port = this.door?.port() ?? null
    const hosts = ownHosts(this.deps.hostEnv())
    if (port === null || hosts.length === 0) return this.fail('network', 'this Mac has no address of the local network')
    const fingerprint = identity.fingerprint
    if (fingerprint.length !== FINGERPRINT_BYTES) this.fail('internal', 'the fingerprint is not 32 bytes')
    // The encoder takes 213 bytes: a long list of addresses loses its last ones, never the first (the name, then the IPv4 addresses).
    let text: string | null = null
    for (let used = hosts.length; used >= 1; used--) {
      const candidate = qrText({ fingerprint, secret: secret.secret, port, hosts: hosts.slice(0, used) })
      if (!('error' in encodeQr(candidate))) {
        text = candidate
        break
      }
    }
    if (text === null) this.fail('internal', 'the code cannot be drawn')
    return { qr: text as string, code: manualCode(secret.secret), address: manualAddress(hosts[0] as string, port) }
  }

  /** The sheet and its secret are gone, and the question with them. The door is the caller's to look at again. */
  private closePairingSheet(): void {
    this.pairing?.secret.close()
    this.pairing = null
    this.clearPairingTimer()
    this.resolveConfirm('refuse')
  }

  closePairing(): void {
    this.begin()
    this.closePairingSheet()
    this.reconcileLater(0)
    this.changed()
  }

  /** The question of [Q7]: resolved by `answer`, by the end of the minute, or by the close of the sheet or of the window. */
  private ask(request: PairingRequestInfo): Promise<'allow' | 'refuse'> {
    this.resolveConfirm('refuse')
    return new Promise((resolve) => {
      this.confirm = { name: readableName(request.name), code: request.code, address: readableAddress(request.address), until: this.deps.clock.elapsed() + (this.deps.confirmMs ?? CONFIRM_MS), waiting: false, resolve }
      this.changed()
    })
  }

  /**
   * The person allowed: the Mac waits for the iPhone's person (§4.6). The sheet stays, with the code and « Annuler »; the promise settles when this Mac's person gives up (« Annuler »,
   * the sheet or the window closed), which ends the pairing as a refusal. The end of the wait by the iPhone's answer needs nothing here: the pairing ends and clears the sheet.
   */
  private waitForPhone(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.confirm?.waiting !== true) return resolve()
      this.giveUp = resolve
    })
  }

  /** « Autoriser » or « Refuser » (and « Annuler » while the iPhone is asked). With no question open it does nothing (a late click). */
  answer(allow: boolean): void {
    this.begin()
    this.resolveConfirm(allow ? 'allow' : 'refuse')
    this.changed()
  }

  private resolveConfirm(decision: 'allow' | 'refuse'): void {
    const open = this.confirm
    if (open === null) return
    if (open.waiting) {
      // The person allowed and the iPhone is being asked: only giving up counts now, and it ends the wait.
      if (decision === 'refuse') {
        this.confirm = null
        const giveUp = this.giveUp
        this.giveUp = null
        giveUp?.()
      }
      return
    }
    // « Autoriser » keeps the sheet, now waiting for the iPhone's person; anything else closes it.
    this.confirm = decision === 'allow' ? { ...open, waiting: true, until: this.deps.clock.elapsed() + (this.deps.confirmMs ?? CONFIRM_MS), resolve: () => undefined } : null
    open.resolve(decision)
  }

  // ---------- the devices ----------

  /** « Oublier »: the device is removed, and what it has open is cut at once. */
  forget(id: string, settleMs = 0): void {
    this.begin()
    const peer = this.deps.store.peers().find((one) => one.id === id)
    if (peer === undefined) return
    this.deps.store.forgetPeer(id)
    this.bases?.remove(id)
    this.announced.delete(id)
    this.sessionSeen.delete(id)
    this.door?.dropPeer(peer.fingerprint)
    // The last device gone, the door closes (`wantsToListen`). When the device itself said it forgot the Mac, in its own session, the door waits for the answer it is owed.
    this.reconcileLater(settleMs)
    this.changed()
  }

  /** The open tabs a paired device announced in its last session (in memory only; the screen « Reprise » of card 447 reads them). */
  openTabsFrom(peerId: string): readonly OpenTab[] {
    return this.announced.get(peerId)?.items ?? []
  }

  private forgetAnnounced(): void {
    this.announced.clear()
    this.sessionSeen.clear()
  }

  /**
   * What the command bar shows of the iPhones' open tabs (« Sur l'iPhone »): the rows of every paired iPhone together, the most recent first, each named by the device and its
   * own identifier, and the facts `resumeView` needs for saying why there is no list. Nothing is read from the state and nothing is kept.
   */
  resumeSource(): { paired: boolean; categoryOnHere: boolean; announcedAt: number | null; listAnnounced: boolean; sessionHappened: boolean; rows: ResumeRow[] } {
    const config = this.deps.store.config()
    const phones = this.deps.store.peers().filter((peer) => peer.platform === 'ios')
    const tabs: ResumeTab[] = []
    let announcedAt: number | null = null
    let sessionHappened = false
    for (const phone of phones) {
      sessionHappened ||= this.sessionSeen.has(phone.id)
      const list = this.announced.get(phone.id)
      if (list === undefined) continue
      announcedAt = Math.max(announcedAt ?? 0, list.at)
      for (const tab of list.items) {
        // The line is named by the device, its tab AND a digest of the address it was announced with: a list that comes later with another page under the same tab
        // identifier is another line (a click on the one the person saw opens nothing), and two lines of one list never share a name (the one clicked is the one opened).
        const id = `${phone.id}:${tab.id}:${createHash('sha256').update(tab.url).digest('hex').slice(0, 12)}`
        if (isResumeId(id)) tabs.push({ ...tab, id })
      }
    }
    return { paired: config.enabled && phones.length > 0, categoryOnHere: config.categories.openTabs, announcedAt, listAnnounced: announcedAt !== null, sessionHappened, rows: resumeRows(tabs) }
  }

  /** A session with a paired device: one at a time (a second is told `busy`), the exchange of docs/synchronisation.md §8 with the state and the marks of this device. */
  private async exchange(channel: Channel, peer: PeerRecord, deviceId: string): Promise<void> {
    const ports = this.deps.session
    const { marks, marksStore: files, bases } = this
    if (ports === undefined || marks === null || files === null || bases === null || this.exchanging) {
      channel.fail('busy', 'a session is already running, or the marks are not followed')
      return
    }
    this.exchanging = true
    try {
      const store = this.deps.store
      const result = await runExchange(channel, peer.id, {
        device: { id: deviceId, name: this.deps.deviceName(), platform: 'mac' },
        host: ports.host,
        marks,
        saveMarks: () => files.save(marks),
        bases,
        categories: () => new Set(SYNC_CATEGORIES.filter((category) => store.config().categories[category])),
        now: this.deps.now,
        appVersion: ports.appVersion,
        stateVersion: ports.stateVersion,
        hosts: () => ownHosts(this.deps.hostEnv()),
        port: () => this.currentPort(),
        ...(ports.openTabs !== undefined ? { openTabs: ports.openTabs } : {}),
        onOpenTabs: (id, items) => void this.announced.set(id, { items, at: this.deps.now() }),
        ...(ports.onShownTabsClosed !== undefined ? { onShownTabsClosed: ports.onShownTabsClosed } : {}),
        onUnpair: (id) => this.forget(id, this.deps.settleMs ?? 2000),
        onRefused: (id, refused) => console.warn(`[sync] ${refused.length} entities of ${id} were not taken (${[...new Set(refused.map((one) => one.reason))].join(', ')})`),
        onDone: (id, at) => {
          store.touchSession(id, at)
          this.sessionSeen.add(id)
        },
        onWarning: (id, code) => console.warn(`[sync] ${id} says: ${code}`)
      })
      const known = ['divergence', 'state-too-new', 'locked', 'interrupted'] as const
      this.lastExchange = { at: this.deps.now(), ok: result.ok, code: result.ok ? null : (known as readonly string[]).includes(result.code) ? (result.code as (typeof known)[number]) : 'other' }
      if (!result.ok) console.warn(`[sync] a session with ${peer.id} ended: ${result.code}: ${result.detail}`)
      this.changed()
    } finally {
      this.exchanging = false
    }
  }

  /** The application quits: the door is closed with it. */
  async dispose(): Promise<void> {
    this.stopTracking()
    this.clearPairingTimer()
    if (this.settleTimer !== null) clearTimeout(this.settleTimer)
    this.settleTimer = null
    await this.reconciling
    await this.listening.close('quit')
    this.forgetAnnounced()
  }
}

