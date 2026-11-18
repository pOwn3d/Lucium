// Engine checks for the synchronisation with the iPhone (docs/synchronisation.md §3.3, §6, §17), in a real Electron and its throw-away profile. WRITTEN AND NEVER RUN on
// the machine it was written on (AGENTS.md §1: a run opens windows and takes the keyboard); `LUCIUM_SMOKE_ONLY=sync` runs it alone, and a maintainer runs it before the
// first build that carries the synchronisation. It is not part of the chain of `pnpm test:engine` until someone has seen it green.
//
// What it settles, which the unit tests (Node, a stand-in for Electron) cannot:
//   - `safeStorage` seals and opens a key in this engine (the keychain stand-in of the throw-away profile, main/index.ts), and the identity made over it is read back;
//   - the hand-written certificate is read by the engine's own `X509Certificate`, and a TLS 1.3 session with ALPN between two such certificates is made by the engine's TLS
//     (BoringSSL), with the fingerprint pinned;
//   - the door opens only when the window is opened, answers a paired device and refuses a stranger, and closes with the window (no port left open);
//   - a pairing goes through end to end, with the question answered;
//   - what the engine says of its host name, so that « le nom `.local` du Mac » (§5) is read from a fact: it is reported, not asserted.
// The page of the Settings is not driven: the window it needs is the maintainer's to look at (AGENTS.md §1).

import { randomBytes, X509Certificate } from 'node:crypto'
import { hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { SmokeContext } from './smoke'
import { noteCheck, waiterOf } from './smoke-kit'
import { certificatePem, fingerprintOf, makeDeviceCertificate, privateKeyOf } from './sync/certificate'
import { Channel } from './sync/channel'
import { IdentityStore } from './sync/identity'
import { readQr } from './sync/pairing-code'
import { requestProof } from './sync/pairing-proof'
import { ownHosts } from './sync/own-hosts'
import { SafeClock } from './sync/safe-clock'
import { electronSecretBox } from './sync/secret-box-electron'
import { SyncService } from './sync/sync-service'
import { SyncStore } from './sync/sync-store'
import { tempDir } from './temp-dir'

type Check = (name: string, ok: boolean, detail?: string) => void

const waitFor = waiterOf(8000, 25)

function dial(port: number, identity: { certificate: Buffer; privateKey: ReturnType<typeof privateKeyOf> }): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, key: identity.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: certificatePem(identity.certificate), rejectUnauthorized: false, ALPNProtocols: ['lucium-sync/1'], minVersion: 'TLSv1.2' })
    socket.once('secureConnect', () => resolve(socket))
    socket.once('error', reject)
  })
}

export async function smokeSync(_ctx: SmokeContext, check: Check): Promise<void> {
  // 1. The sealing of the key by this engine.
  const box = electronSecretBox()
  check('safeStorage can seal a key in this engine', box.available())
  const probe = randomBytes(48)
  check('a key sealed by safeStorage is opened back to the same bytes, and the sealed bytes are not the key', box.open(box.seal(probe)).equals(probe) && !box.seal(probe).includes(probe))

  // 2. The identity made over it, read back, and its certificate read by the engine.
  const dir = tempDir('lucium-smoke-sync-')
  const identities = new IdentityStore(join(dir, 'sync-identity.json'), box)
  const made = identities.loadOrCreate()
  const again = new IdentityStore(join(dir, 'sync-identity.json'), box).loadOrCreate()
  check('the identity is made, then read again the same', made.created && !again.created && again.identity.fingerprint.equals(made.identity.fingerprint))
  const parsed = new X509Certificate(made.identity.certificate)
  check('the engine reads the hand-written certificate: name, signature and fingerprint', parsed.subject === 'CN=lucium-sync' && parsed.verify(parsed.publicKey) && fingerprintOf(made.identity.certificate).equals(Buffer.from(parsed.fingerprint256.replaceAll(':', ''), 'hex')))

  // 3. What the engine says of the host, reported.
  const hosts = ownHosts({ hostname: hostname(), interfaces: networkInterfaces() })
  check(`host name of this engine (reported, not asserted): ${hostname()}; hosts written in a QR: ${hosts.join(', ') || 'none'}`, true)

  // 4. The service over the real door, on the loopback (the only widening of the source filter is the test's).
  const store = new SyncStore(join(dir, 'sync.json'))
  const service = new SyncService({
    store,
    identities,
    box,
    clock: new SafeClock(),
    hostEnv: () => ({ hostname: 'macbook-de-test.local', interfaces: {} }),
    deviceName: () => 'Mac de test',
    now: () => Date.now(),
    isLocked: () => false,
    allowSource: () => true
  })
  try {
    await service.setEnabled(true)
    check('switching on opens nothing: the window is closed and the status says so', !service.status().window.open && service.status().enabled)
    // No address of the local network in the stand-in environment: the QR cannot be written, and the service says `network` instead of showing a code nobody can read.
    const refused = await service.startPairing().then(() => 'opened', (error: { problem?: string }) => error.problem ?? 'other')
    check('without an address of the local network the sheet is refused with `network`', refused === 'network')
    await service.closeWindow()

    const lan = new SyncService({
      store,
      identities,
      box,
      clock: new SafeClock(),
      hostEnv: () => ({ hostname: 'macbook-de-test.local', interfaces: { en0: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: null }] } }),
      deviceName: () => 'Mac de test',
      now: () => Date.now(),
      isLocked: () => false,
      allowSource: () => true
    })
    await lan.startPairing()
    const sheet = lan.status().pairing
    const reading = readQr(sheet?.qr ?? '')
    check('the sheet carries a QR that reads back, with the fingerprint of this Mac', reading.ok && reading.fingerprint.equals(made.identity.fingerprint))
    if (!reading.ok) throw new Error('the QR cannot be read back')
    const phone = makeDeviceCertificate()
    const phoneIdentity = { certificate: phone.certificate, privateKey: privateKeyOf(phone.privateKey) }
    const socket = await dial(reading.port, phoneIdentity)
    check('TLS 1.3 with ALPN lucium-sync/1 between two hand-written certificates, in this engine', socket.getProtocol() === 'TLSv1.3' && socket.alpnProtocol === 'lucium-sync/1')
    const channel = new Channel(socket, { phase: 'pairing', role: 'ios' })
    const challenge = await channel.receive()
    if (challenge.t !== 'pair.challenge') throw new Error('no challenge')
    const nonce = randomBytes(16)
    await channel.send({
      t: 'pair.request',
      device: { id: 'iphone-smoke-000001', name: 'iPhone de test', platform: 'ios' },
      nonce: nonce.toString('base64url'),
      proof: requestProof({ secret: reading.secret, fingerprintMac: made.identity.fingerprint, fingerprintPhone: fingerprintOf(phone.certificate), nonceMac: Buffer.from(challenge.nonce, 'base64url'), noncePhone: nonce, idMac: '', idPhone: 'iphone-smoke-000001' })
    })
    await waitFor(() => lan.status().confirm !== null)
    check('the person is asked, by name, before the iPhone is kept', lan.status().confirm?.name === 'iPhone de test' && lan.status().devices.length === 0)
    lan.answer(true)
    const accepted = await channel.receive()
    // The iPhone's person compares the code and says yes (§4.6): nothing is kept before.
    check('allowed is not paired: the iPhone is not listed before its own person has said yes', accepted.t === 'pair.accept' && lan.status().devices.length === 0 && lan.status().confirm?.waiting === true)
    await channel.send({ t: 'bye' })
    const last = await channel.receive()
    await waitFor(() => lan.status().devices.some((d) => d.id === 'iphone-smoke-000001'))
    check('a pairing goes through end to end: the iPhone is listed once both persons said yes', last.t === 'bye' && lan.status().devices.some((d) => d.id === 'iphone-smoke-000001'))
    socket.destroy()

    const stranger = makeDeviceCertificate()
    const strangerSocket = await dial(reading.port, { certificate: stranger.certificate, privateKey: privateKeyOf(stranger.privateKey) })
    const told = await new Promise<string>((resolve) => void strangerSocket.once('data', (data: Buffer) => resolve(data.subarray(4).toString())))
    check('a device that is not paired is told not-paired', told.includes('not-paired'))
    strangerSocket.destroy()

    await lan.closeWindow()
    const closed = await dial(reading.port, phoneIdentity).then(
      (open) => (open.destroy(), false),
      () => true
    )
    check('no port is left open once the window is closed', closed && !lan.status().window.open)
    await lan.dispose()
  } finally {
    await service.dispose()
  }
}

/** `LUCIUM_SMOKE_ONLY=sync`: these checks with their own report. */
export async function runSyncSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeSync(ctx, (name, ok, detail) => noteCheck(checks, name, ok, detail))
  } catch (error) {
    noteCheck(checks, 'smokeSync ran to the end', false, String((error as Error).stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_SYNC ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
