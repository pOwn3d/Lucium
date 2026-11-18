// The Mac's door (docs/synchronisation.md §6.1) with real TLS over the loopback. The loopback is refused by the real policy, so these tests widen the source filter
// (`allowSource`) except the ones that prove the real policy refuses it.
import { createHash, randomBytes } from 'node:crypto'
import { connect as netConnect, type Socket } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channel } from './channel'
import { encodeFrame } from './frames'
import { FAILURES_PER_MINUTE_BEFORE_REFUSAL, MAX_CONNECTIONS } from './limits'
import { SyncListener, type ListenerDeps, type ListenerEvent, type OpenPairing } from './listener'
import { requestProof } from './pairing-proof'
import { PairingSecret } from './pairing-secret'
import { AddressLimiter } from './rate-limit'
import { closedOrFailed, connectTls, sleep, testIdentity, type TestIdentity } from './sync-net.test-support'
import type { PeerRecord } from './sync-store'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

interface Rig {
  listener: SyncListener
  mac: TestIdentity
  events: ListenerEvent[]
  peers: Map<string, PeerRecord>
  limiter: AddressLimiter
  clock: { now: number }
  sessions: Array<{ peer: PeerRecord; channel: Channel }>
  pairingOffer: { current: ReturnType<OpenPairing> }
  paired: PeerRecord[]
  port: number
}

async function rig(over: Partial<ListenerDeps> = {}, start = true): Promise<Rig> {
  const mac = testIdentity('mac-device-0000000001')
  const clock = { now: 0 }
  const limiter = new AddressLimiter(() => clock.now)
  const peers = new Map<string, PeerRecord>()
  const events: ListenerEvent[] = []
  const sessions: Rig['sessions'] = []
  const pairingOffer: Rig['pairingOffer'] = { current: null }
  const paired: PeerRecord[] = []
  const listener = new SyncListener({
    identity: mac,
    deviceName: () => 'MacBook de test',
    limiter,
    findPeer: (fingerprint) => peers.get(fingerprint),
    openPairing: () => pairingOffer.current,
    runSession: async (channel, peer) => {
      sessions.push({ peer, channel })
      await new Promise<void>(() => undefined)
    },
    onEvent: (event) => void events.push(event),
    allowSource: () => true,
    ...over
  })
  cleanup.push(() => listener.stop())
  const state: Rig = { listener, mac, events, peers, limiter, clock, sessions, pairingOffer, paired, port: 0 }
  if (start) state.port = await listener.start(0)
  return state
}

const peerOf = (id: TestIdentity, name = 'iPhone de test'): PeerRecord => ({ id: id.deviceId, name, platform: 'ios', fingerprint: id.fingerprint.toString('hex'), pairedAt: 1, lastSessionAt: null })

/** What a stranger is told: the first frame the connection yields, parsed. */
async function firstFrame(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let held = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      held = Buffer.concat([held, chunk])
      if (held.length >= 4 && held.length >= 4 + held.readUInt32BE(0)) resolve(JSON.parse(held.subarray(4, 4 + held.readUInt32BE(0)).toString('utf8')) as Record<string, unknown>)
    })
    socket.once('error', reject)
    socket.once('close', () => reject(new Error('closed before a frame')))
  })
}

describe('SyncListener: the source of a connection is looked at before anything else', () => {
  it('refuses the loopback by default: no handshake starts and not a byte is written', async () => {
    const r = await rig({ allowSource: undefined })
    const raw = netConnect({ host: '127.0.0.1', port: r.port })
    const received: Buffer[] = []
    raw.on('data', (chunk: Buffer) => void received.push(chunk))
    raw.on('error', () => undefined)
    // A client hello would start a handshake on any server that listened: this one must close without answering.
    raw.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00, 0x00, 0x01, 0x00]))
    expect(await closedOrFailed(raw)).toMatch(/closed|error/)
    expect(received).toEqual([])
    expect(r.events).toEqual([{ kind: 'refused-source', address: expect.stringMatching(/127\.0\.0\.1/) }])
    expect(r.listener.open().total).toBe(0)
  })

  it('refuses an address that is being refused, without a handshake, and says so', async () => {
    const r = await rig()
    for (let n = 0; n < FAILURES_PER_MINUTE_BEFORE_REFUSAL; n++) r.limiter.recordFailure('::ffff:127.0.0.1')
    r.limiter.recordFailure('127.0.0.1')
    const refused = r.limiter.isRefused('::ffff:127.0.0.1') ? '::ffff:127.0.0.1' : '127.0.0.1'
    for (let n = 0; n < FAILURES_PER_MINUTE_BEFORE_REFUSAL; n++) r.limiter.recordFailure(refused)
    await expect(connectTls(r.port, testIdentity('stranger-0000000001'))).rejects.toBeDefined()
    expect(r.events.some((event) => event.kind === 'refused-limited')).toBe(true)
  })

  it('lets through what the policy allows, and reads the source address as the policy sees it', async () => {
    const seen: Array<string | undefined> = []
    const r = await rig({ allowSource: (address) => (seen.push(address), true) })
    const phone = testIdentity('iphone-0000000001')
    r.peers.set(phone.fingerprint.toString('hex'), peerOf(phone))
    const { socket } = await connectTls(r.port, phone)
    await sleep(50)
    socket.destroy()
    expect(seen[0]).toMatch(/127\.0\.0\.1$/)
  })
})

describe('SyncListener: TLS 1.3, ALPN and a certificate from the client', () => {
  it('offers the certificate of the Mac, which is the one the fingerprint names', async () => {
    const r = await rig()
    const phone = testIdentity('iphone-0000000001')
    r.peers.set(phone.fingerprint.toString('hex'), peerOf(phone))
    const { socket, serverFingerprint } = await connectTls(r.port, phone)
    expect(serverFingerprint.equals(r.mac.fingerprint)).toBe(true)
    expect(socket.getProtocol()).toBe('TLSv1.3')
    expect(socket.alpnProtocol).toBe('lucium-sync/1')
    socket.destroy()
  })

  it('refuses a client that only speaks TLS 1.2, and counts it against its address', async () => {
    const r = await rig()
    await expect(connectTls(r.port, testIdentity('iphone-0000000002'), { maxVersion: 'TLSv1.2' })).rejects.toBeDefined()
    await sleep(30)
    expect(r.events.some((event) => event.kind === 'handshake-failed')).toBe(true)
    expect(r.sessions).toEqual([])
  })

  it('refuses a client that offers no protocol of ours', async () => {
    const r = await rig()
    await expect(connectTls(r.port, testIdentity('iphone-0000000003'), { alpn: ['lucium-sync/2'] })).rejects.toBeDefined()
    await sleep(30)
    expect(r.events.some((event) => event.kind === 'handshake-failed')).toBe(true)
  })

  it('refuses a client that offers no protocol at all, which the handshake alone lets through', async () => {
    const r = await rig()
    const outcome = await connectTls(r.port, testIdentity('iphone-0000000004'), { alpn: [] }).then(
      ({ socket }) => closedOrFailed(socket),
      () => 'error' as const
    )
    expect(outcome).toMatch(/closed|error/)
    await sleep(30)
    expect(r.events.some((event) => event.kind === 'handshake-failed' && /not ours/.test(event.reason))).toBe(true)
    expect(r.sessions).toEqual([])
  })

  it('closes the door on an address after ten failed handshakes in a minute', async () => {
    const r = await rig()
    for (let n = 0; n < FAILURES_PER_MINUTE_BEFORE_REFUSAL; n++) await connectTls(r.port, testIdentity(`iphone-00000001${n}`), { alpn: ['lucium-sync/2'] }).catch(() => undefined)
    await sleep(60)
    expect(r.limiter.isRefused('127.0.0.1') || r.limiter.isRefused('::ffff:127.0.0.1')).toBe(true)
    await expect(connectTls(r.port, testIdentity('iphone-0000000199'))).rejects.toBeDefined()
    expect(r.events.some((event) => event.kind === 'refused-limited')).toBe(true)
  })

  it('refuses a client that presents no certificate: the fingerprint is all there is to go on', async () => {
    const r = await rig()
    const outcome = await connectTls(r.port, testIdentity('anonymous-000000001'), { anonymous: true }).then(
      ({ socket }) => closedOrFailed(socket),
      () => 'error' as const
    )
    expect(outcome).toMatch(/closed|error/)
    await sleep(30)
    expect(r.events.some((event) => event.kind === 'handshake-failed')).toBe(true)
    expect(r.sessions).toEqual([])
  })

  it('does not wait for ever for a handshake: a connection that says nothing is cut and counted', async () => {
    const r = await rig({ handshakeMs: 80 })
    const raw = netConnect({ host: '127.0.0.1', port: r.port })
    raw.on('error', () => undefined)
    expect(await closedOrFailed(raw)).toMatch(/closed|error/)
    expect(r.events).toEqual([{ kind: 'handshake-failed', address: expect.any(String), reason: expect.stringContaining('handshake took more') }])
  })
})

describe('SyncListener: the fingerprint decides', () => {
  it('opens a session for a paired device, handing the flow its channel and its record', async () => {
    const r = await rig()
    const phone = testIdentity('iphone-0000000001')
    r.peers.set(phone.fingerprint.toString('hex'), peerOf(phone))
    const { socket } = await connectTls(r.port, phone)
    const client = new Channel(socket, { phase: 'session', role: 'ios' })
    await sleep(50)
    expect(r.sessions).toHaveLength(1)
    expect(r.sessions[0]?.peer.id).toBe('iphone-0000000001')
    expect(r.listener.open().sessions).toBe(1)
    // The channel is live: what the flow sends, the device reads.
    await r.sessions[0]?.channel.send({ t: 'bye' })
    expect(await client.receive()).toMatchObject({ t: 'bye' })
    socket.destroy()
  })

  it('tells a stranger it is not paired, counts it, and never reads what it sends', async () => {
    const r = await rig()
    const { socket } = await connectTls(r.port, testIdentity('stranger-0000000001'))
    // Sent at once, before the answer: nothing of it may be parsed (a parse of garbage would answer bad-message instead).
    socket.write(Buffer.from([0, 0, 0, 5, 0x7b, 0xff, 0xfe, 0x7d, 0x7d]))
    const told = await firstFrame(socket)
    expect(told).toMatchObject({ v: 1, n: 1, t: 'error', code: 'not-paired', fatal: true })
    expect(r.events.some((event) => event.kind === 'not-paired')).toBe(true)
    expect(r.sessions).toEqual([])
    socket.destroy()
  })

  it('does not take a device by its name or its identifier: a device with a paired device\'s identifier but another certificate is a stranger', async () => {
    const r = await rig()
    const real = testIdentity('iphone-0000000001')
    r.peers.set(real.fingerprint.toString('hex'), peerOf(real))
    const impostor = testIdentity('iphone-0000000001')
    const { socket } = await connectTls(r.port, impostor)
    expect(await firstFrame(socket)).toMatchObject({ t: 'error', code: 'not-paired' })
    expect(r.sessions).toEqual([])
    socket.destroy()
  })

  it('stops letting a device in the moment it is forgotten: the list is read at each connection', async () => {
    const r = await rig()
    const phone = testIdentity('iphone-0000000001')
    r.peers.set(phone.fingerprint.toString('hex'), peerOf(phone))
    const first = await connectTls(r.port, phone)
    await sleep(40)
    expect(r.sessions).toHaveLength(1)
    first.socket.destroy()
    r.peers.clear()
    const second = await connectTls(r.port, phone)
    expect(await firstFrame(second.socket)).toMatchObject({ code: 'not-paired' })
    expect(r.sessions).toHaveLength(1)
    second.socket.destroy()
  })

  it('cuts the connections of a device the moment it is forgotten, and only that device\'s', async () => {
    const r = await rig()
    const a = testIdentity('iphone-0000000001')
    const b = testIdentity('iphone-0000000002')
    for (const phone of [a, b]) r.peers.set(phone.fingerprint.toString('hex'), peerOf(phone))
    const first = await connectTls(r.port, a)
    const second = await connectTls(r.port, b)
    await sleep(60)
    expect(r.listener.dropPeer(a.fingerprint.toString('hex'))).toBe(1)
    expect(await closedOrFailed(first.socket)).toMatch(/closed|error/)
    expect(second.socket.destroyed).toBe(false)
    expect(r.listener.dropPeer(a.fingerprint.toString('hex'))).toBe(0)
    expect(r.listener.dropPeer('f'.repeat(64))).toBe(0)
    second.socket.destroy()
  })

  it('refuses a fifth session: busy', async () => {
    const r = await rig()
    const phones = Array.from({ length: MAX_CONNECTIONS + 1 }, (_, n) => testIdentity(`iphone-000000000${n}`))
    for (const phone of phones) r.peers.set(phone.fingerprint.toString('hex'), peerOf(phone))
    const held: Socket[] = []
    for (const phone of phones.slice(0, MAX_CONNECTIONS)) held.push((await connectTls(r.port, phone)).socket)
    await sleep(60)
    expect(r.sessions).toHaveLength(MAX_CONNECTIONS)
    const extra = await connectTls(r.port, phones[MAX_CONNECTIONS] as TestIdentity)
    expect(await firstFrame(extra.socket)).toMatchObject({ t: 'error', code: 'busy' })
    expect(r.sessions).toHaveLength(MAX_CONNECTIONS)
    for (const socket of [...held, extra.socket]) socket.destroy()
  })

  it('cuts a session that lasts more than the time allowed', async () => {
    const r = await rig({ sessionMaxMs: 80 })
    const phone = testIdentity('iphone-0000000001')
    r.peers.set(phone.fingerprint.toString('hex'), peerOf(phone))
    const { socket } = await connectTls(r.port, phone)
    expect(await firstFrame(socket)).toMatchObject({ t: 'error', code: 'timeout' })
    socket.destroy()
  })

  it('tells the device `internal`, logs it and counts it, when the session flow fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = await rig({
      runSession: () => Promise.reject(new Error('the disk is full'))
    })
    const phone = testIdentity('iphone-0000000001')
    r.peers.set(phone.fingerprint.toString('hex'), peerOf(phone))
    const { socket } = await connectTls(r.port, phone)
    expect(await firstFrame(socket)).toMatchObject({ t: 'error', code: 'internal' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ended on an error'), expect.anything())
    socket.destroy()
    log.mockRestore()
  })
})

describe('SyncListener: a pairing', () => {
  function offer(r: Rig, decision: 'allow' | 'refuse' = 'allow'): { secret: PairingSecret } {
    const secret = new PairingSecret(randomBytes(16), () => r.clock.now)
    r.pairingOffer.current = {
      secret,
      confirm: async () => decision,
      addPeer: (peer) => void (r.paired.push(peer), r.peers.set(peer.fingerprint, peer)),
      hosts: () => ['macbook-de-test.local'],
      now: () => 1_790_000_000_000,
      confirmMs: 200
    }
    return { secret }
  }

  /** The iPhone's half up to its request: takes the challenge, sends a request with the right proof. */
  async function sendRequest(r: Rig, channel: Channel, phone: TestIdentity, serverFingerprint: Buffer, secret: Buffer): Promise<void> {
    const challenge = await channel.receive()
    if (challenge.t !== 'pair.challenge') throw new Error('no challenge')
    const nonce = randomBytes(16)
    await channel.send({
      t: 'pair.request',
      device: { id: phone.deviceId, name: 'iPhone de test', platform: 'ios' },
      nonce: nonce.toString('base64url'),
      proof: requestProof({ secret, fingerprintMac: serverFingerprint, fingerprintPhone: phone.fingerprint, nonceMac: Buffer.from(challenge.nonce, 'base64url'), noncePhone: nonce, idMac: r.mac.deviceId, idPhone: phone.deviceId })
    })
  }

  async function pairOnce(r: Rig, phone: TestIdentity, secret: Buffer): Promise<Record<string, unknown>> {
    const { socket, serverFingerprint } = await connectTls(r.port, phone)
    const channel = new Channel(socket, { phase: 'pairing', role: 'ios' })
    await sendRequest(r, channel, phone, serverFingerprint, secret)
    const answer = (await channel.receive()) as unknown as Record<string, unknown>
    socket.destroy()
    return answer
  }

  it('pairs an unknown device while a pairing is open, and the device is then known: its next connection is a session', async () => {
    const r = await rig()
    const phone = testIdentity('iphone-0000000009')
    const { secret } = offer(r)
    const answer = await pairOnce(r, phone, secret.secret)
    expect(answer).toMatchObject({ t: 'pair.accept', hosts: ['macbook-de-test.local'] })
    expect(r.paired).toEqual([expect.objectContaining({ id: 'iphone-0000000009', fingerprint: phone.fingerprint.toString('hex') })])
    r.pairingOffer.current = null
    const { socket } = await connectTls(r.port, phone)
    await sleep(60)
    expect(r.sessions).toHaveLength(1)
    socket.destroy()
  })

  it('says the pairing ended, with its outcome', async () => {
    const ended: unknown[] = []
    const r = await rig({ onPairingEnded: (outcome) => void ended.push(outcome) })
    const phone = testIdentity('iphone-0000000009')
    const { secret } = offer(r)
    await pairOnce(r, phone, secret.secret)
    await sleep(30)
    expect(ended).toEqual([expect.objectContaining({ outcome: 'paired' })])
  })

  it('counts a pairing that failed against its address, like any other failure', async () => {
    const r = await rig()
    const { secret } = offer(r, 'refuse')
    for (let n = 0; n < FAILURES_PER_MINUTE_BEFORE_REFUSAL; n++) {
      secret.close()
      const answer = await pairOnce(r, testIdentity(`iphone-00000000${n}`), secret.secret)
      expect(answer).toMatchObject({ t: 'error' })
    }
    await sleep(30)
    expect(r.limiter.isRefused('127.0.0.1') || r.limiter.isRefused('::ffff:127.0.0.1')).toBe(true)
  })

  it('does not pair a stranger when no pairing is open, whatever it knows', async () => {
    const r = await rig()
    const phone = testIdentity('iphone-0000000009')
    const { socket } = await connectTls(r.port, phone)
    expect(await firstFrame(socket)).toMatchObject({ code: 'not-paired' })
    expect(r.paired).toEqual([])
    socket.destroy()
  })

  it('runs one pairing at a time: a second stranger meets `busy` while the first one waits for the person, however long it has waited', async () => {
    const r = await rig({ pairingGraceMs: 20 })
    const { secret } = offer(r)
    r.pairingOffer.current = { ...(r.pairingOffer.current as NonNullable<typeof r.pairingOffer.current>), confirm: () => new Promise(() => undefined) }
    const phone = testIdentity('iphone-0000000001')
    const first = await connectTls(r.port, phone)
    await sendRequest(r, new Channel(first.socket, { phase: 'pairing', role: 'ios' }), phone, first.serverFingerprint, secret.secret)
    // Longer than the grace: age alone does not move a connection that has asked to pair.
    await sleep(80)
    const second = await connectTls(r.port, testIdentity('iphone-0000000002'))
    expect(await firstFrame(second.socket)).toMatchObject({ t: 'error', code: 'busy' })
    expect(secret.remainingMs()).toBeGreaterThan(0)
    expect(r.listener.open().pairings).toBe(1)
    first.socket.destroy()
    second.socket.destroy()
  })

  it('does not let a connection that says nothing keep the only place: the next stranger, once the grace is over, takes it, and the silent one is cut and counted', async () => {
    const r = await rig({ pairingGraceMs: 40 })
    const { secret } = offer(r)
    const silent = await connectTls(r.port, testIdentity('iphone-0000000idle'))
    // Read nothing but let the stream flow, so that the end of the connection is seen.
    silent.socket.resume()
    const silentEnds = closedOrFailed(silent.socket)
    await sleep(100)
    const answer = await pairOnce(r, testIdentity('iphone-0000000009'), secret.secret)
    expect(answer).toMatchObject({ t: 'pair.accept' })
    expect(await silentEnds).toMatch(/closed|error/)
    expect(r.paired).toEqual([expect.objectContaining({ id: 'iphone-0000000009' })])
  })

  it('keeps the place of a connection that is still within its grace: the newcomer is told `busy`', async () => {
    const r = await rig({ pairingGraceMs: 60_000 })
    offer(r)
    const young = await connectTls(r.port, testIdentity('iphone-0000000001'))
    await sleep(60)
    const second = await connectTls(r.port, testIdentity('iphone-0000000002'))
    expect(await firstFrame(second.socket)).toMatchObject({ t: 'error', code: 'busy' })
    expect(r.listener.open().pairings).toBe(1)
    young.socket.destroy()
    second.socket.destroy()
  })

  it('counts every silent connection it cuts against its address, so that one address cannot do it for ever', async () => {
    const r = await rig({ pairingGraceMs: 10 })
    offer(r)
    const held: TLSSocket[] = []
    for (let n = 0; n <= FAILURES_PER_MINUTE_BEFORE_REFUSAL; n++) {
      const connection = await connectTls(r.port, testIdentity(`iphone-00000000${n}`)).catch(() => null)
      if (connection !== null) held.push(connection.socket)
      await sleep(40)
    }
    await sleep(40)
    expect(r.limiter.isRefused('127.0.0.1') || r.limiter.isRefused('::ffff:127.0.0.1')).toBe(true)
    for (const socket of held) socket.destroy()
  })
})

describe('SyncListener: the door itself', () => {
  it('holds at most five connections before a handshake: the sixth is cut and counted', async () => {
    const r = await rig({ handshakeMs: 5000 })
    const held: Socket[] = []
    for (let n = 0; n < MAX_CONNECTIONS + 1; n++) {
      const raw = netConnect({ host: '127.0.0.1', port: r.port })
      raw.on('error', () => undefined)
      held.push(raw)
    }
    await sleep(80)
    expect(r.listener.open().total).toBe(MAX_CONNECTIONS + 1)
    const sixth = netConnect({ host: '127.0.0.1', port: r.port })
    sixth.on('error', () => undefined)
    expect(await closedOrFailed(sixth)).toMatch(/closed|error/)
    expect(r.events.some((event) => event.kind === 'refused-full')).toBe(true)
    for (const socket of held) socket.destroy()
  })

  it('closes the port and every connection when it stops, and opens nothing before it starts', async () => {
    const r = await rig({}, false)
    expect(r.listener.port()).toBeNull()
    expect(r.listener.listening()).toBe(false)
    const port = await r.listener.start(0)
    expect(r.listener.listening()).toBe(true)
    const phone = testIdentity('iphone-0000000001')
    r.peers.set(phone.fingerprint.toString('hex'), peerOf(phone))
    const { socket } = await connectTls(port, phone)
    await sleep(40)
    await r.listener.stop()
    expect(await closedOrFailed(socket)).toMatch(/closed|error/)
    expect(r.listener.port()).toBeNull()
    await expect(connectTls(port, phone)).rejects.toBeDefined()
  })

  it('starts once: a second start answers the port it already has', async () => {
    const r = await rig()
    expect(await r.listener.start(0)).toBe(r.port)
  })

  it('rejects, and stays closed, when the port is taken', async () => {
    const first = await rig()
    const second = await rig({}, false)
    await expect(second.listener.start(first.port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(second.listener.listening()).toBe(false)
  })

  it('can stop when it never started, and start again after a stop', async () => {
    const r = await rig({}, false)
    await r.listener.stop()
    const port = await r.listener.start(0)
    expect(port).toBeGreaterThan(0)
    await r.listener.stop()
    expect(await r.listener.start(0)).toBeGreaterThan(0)
  })

  it('answers with the fingerprint of the certificate it was given: the sha-256 of its DER', async () => {
    const r = await rig()
    expect(createHash('sha256').update(r.mac.certificate).digest().equals(r.mac.fingerprint)).toBe(true)
    const { socket, serverFingerprint } = await connectTls(r.port, testIdentity('stranger-0000000001'))
    expect(serverFingerprint.equals(r.mac.fingerprint)).toBe(true)
    socket.write(encodeFrame({ v: 1, n: 1, t: 'bye' }))
    socket.destroy()
  })
})
