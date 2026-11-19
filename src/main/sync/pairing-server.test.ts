// The Mac's side of a pairing (docs/synchronisation.md §4.1), played against an iPhone written in the test from the same primitives the iPhone's code is held to by
// the vectors: the proofs are recomputed here, not copied.
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channel } from './channel'
import { MAX_INVALID_PROOFS, PAIRING_WINDOW_MS } from './limits'
import { pairingCommitment } from './pairing-commit'
import { comparisonCode } from './pairing-compare'
import { acceptProof, proofMatches, requestProof } from './pairing-proof'
import { PairingSecret } from './pairing-secret'
import { runPairing, type PairingContext, type PairingRequestInfo } from './pairing-server'
import { socketPair } from './sync-net.test-support'
import type { PeerRecord } from './sync-store'

const open: Array<() => void> = []
afterEach(() => {
  while (open.length > 0) open.pop()?.()
})

const MAC_FP = Buffer.alloc(32, 0x11)
const PHONE_FP = Buffer.alloc(32, 0x22)

interface Setup {
  ctx: PairingContext
  secret: PairingSecret
  clock: { now: number }
  added: PeerRecord[]
  /** The name each question named, in order. */
  asked: string[]
  /** What each question carried. */
  requests: PairingRequestInfo[]
  /** Told when the person allowed and the Mac waits for the iPhone's. */
  waited: number[]
}

function setup(over: Partial<PairingContext> & { decision?: 'allow' | 'refuse' | 'throw' | 'never' } = {}): Setup {
  const clock = { now: 0 }
  const secret = new PairingSecret(randomBytes(16), () => clock.now)
  const added: PeerRecord[] = []
  const asked: string[] = []
  const requests: PairingRequestInfo[] = []
  const waited: number[] = []
  const { decision = 'allow', ...rest } = over
  const ctx: PairingContext = {
    device: { id: 'mac-device-0000000001', name: 'MacBook de test', fingerprint: MAC_FP },
    secret,
    peerFingerprint: PHONE_FP,
    peerAddress: '192.168.1.40',
    confirm: (request) => {
      asked.push(request.name)
      requests.push(request)
      if (decision === 'throw') return Promise.reject(new Error('the sheet is gone'))
      if (decision === 'never') return new Promise(() => undefined)
      return Promise.resolve(decision)
    },
    addPeer: (peer) => void added.push(peer),
    hosts: () => ['macbook-de-test.local', '192.168.1.20'],
    port: () => 49213,
    now: () => 1_790_000_000_000,
    waiting: () => {
      waited.push(1)
      return new Promise<void>(() => undefined)
    },
    confirmMs: 80,
    ...rest
  }
  return { ctx, secret, clock, added, asked, requests, waited }
}

/**
 * The iPhone: reads the challenge, answers with a proof made from `secret` (or a wrong one) and a commitment to a code nonce (§4.7), reads the Mac's code nonce and reveals
 * its own, reads what the Mac says next and, when that is the accept, plays what its person decides (§4.6): `accept` says `bye` and reads the Mac's last word, `refuse` says
 * `error` (`pairing-refused`), `silent` says nothing. `commitFingerprint` is the fingerprint the commitment names (the iPhone's own by default), `revealNonce` the nonce it
 * reveals (the one it committed to by default), `skipReveal` sends nothing after the Mac's code nonce.
 */
async function iphone(
  s: Setup,
  phone: Channel,
  options: {
    secret?: Buffer
    fingerprintPhone?: Buffer
    platform?: 'ios' | 'mac'
    wrongProof?: boolean
    decision?: 'accept' | 'refuse' | 'silent'
    onAccept?: () => void
    commitFingerprint?: Buffer
    revealNonce?: Buffer
    skipReveal?: boolean
    /** The commitment as sent: a test can replace it by anything. */
    commit?: string
  } = {}
): Promise<{
  challenge: string
  noncePhone: Buffer
  nonceCodePhone: Buffer
  nonceCodeMac: Buffer | null
  reply: Awaited<ReturnType<Channel['receive']>>
  final: Awaited<ReturnType<Channel['receive']>> | null
}> {
  const challenge = await phone.receive()
  if (challenge.t !== 'pair.challenge') throw new Error(`expected a challenge, got ${challenge.t}`)
  const noncePhone = randomBytes(16)
  const proof = requestProof({ secret: options.secret ?? s.secret.secret, fingerprintMac: MAC_FP, fingerprintPhone: options.fingerprintPhone ?? PHONE_FP, nonceMac: Buffer.from(challenge.nonce, 'base64url'), noncePhone, idMac: 'mac-device-0000000001', idPhone: 'iphone-0000000001' })
  const nonceCodePhone = randomBytes(16)
  const commit = options.commit ?? pairingCommitment(options.commitFingerprint ?? options.fingerprintPhone ?? PHONE_FP, nonceCodePhone)
  await phone.send({
    t: 'pair.request',
    device: { id: 'iphone-0000000001', name: 'iPhone de test', platform: options.platform ?? 'ios' },
    nonce: noncePhone.toString('base64url'),
    proof: options.wrongProof === true ? proof.replace(/.$/, proof.endsWith('A') ? 'B' : 'A') : proof,
    commit
  })
  let nonceCodeMac: Buffer | null = null
  let reply = await phone.receive()
  if (reply.t === 'pair.nonce') {
    nonceCodeMac = Buffer.from(reply.nonce, 'base64url')
    if (options.skipReveal === true) return { challenge: challenge.nonce, noncePhone, nonceCodePhone, nonceCodeMac, reply, final: null }
    await phone.send({ t: 'pair.reveal', nonce: (options.revealNonce ?? nonceCodePhone).toString('base64url') })
    reply = await phone.receive()
  }
  let final: Awaited<ReturnType<Channel['receive']>> | null = null
  if (reply.t === 'pair.accept') {
    options.onAccept?.()
    const decision = options.decision ?? 'accept'
    if (decision === 'accept') {
      await phone.send({ t: 'bye' })
      final = await phone.receive().catch(() => null)
    } else if (decision === 'refuse') await phone.send({ t: 'error', code: 'pairing-refused', fatal: true })
  }
  return { challenge: challenge.nonce, noncePhone, nonceCodePhone, nonceCodeMac, reply, final }
}

async function run(s: Setup, play: (phone: Channel) => Promise<void>): Promise<Awaited<ReturnType<typeof runPairing>>> {
  const sockets = await socketPair()
  open.push(sockets.close)
  const mac = new Channel(sockets.server, { phase: 'pairing', role: 'mac' })
  const phone = new Channel(sockets.client, { phase: 'pairing', role: 'ios' })
  const [outcome] = await Promise.all([runPairing(mac, s.ctx), play(phone)])
  return outcome
}

describe('runPairing: a pairing that goes through', () => {
  it('asks the person, keeps the iPhone, and sends the Mac proof the iPhone can check', async () => {
    const s = setup()
    let seen: Awaited<ReturnType<typeof iphone>> | null = null
    const outcome = await run(s, async (phone) => {
      seen = await iphone(s, phone)
    })
    expect(outcome.outcome).toBe('paired')
    expect(s.asked).toEqual(['iPhone de test'])
    expect(s.added).toEqual([{ id: 'iphone-0000000001', name: 'iPhone de test', platform: 'ios', fingerprint: PHONE_FP.toString('hex'), pairedAt: 1_790_000_000_000, lastSessionAt: null }])
    const { reply, challenge, noncePhone } = seen as unknown as Awaited<ReturnType<typeof iphone>>
    if (reply.t !== 'pair.accept') throw new Error(`expected an accept, got ${reply.t}`)
    expect(reply.device).toEqual({ id: 'mac-device-0000000001', name: 'MacBook de test', platform: 'mac' })
    expect(reply.hosts).toEqual(['macbook-de-test.local', '192.168.1.20'])
    // The port the Mac listens on now (review n° 38): the iPhone keeps it, whatever the QR said.
    expect(reply.port).toBe(49213)
    // The iPhone checks the Mac's proof with the nonces of THIS connection: it is not a proof that another connection could replay.
    const expected = acceptProof({ secret: s.secret.secret, fingerprintMac: MAC_FP, fingerprintPhone: PHONE_FP, nonceMac: Buffer.from(challenge, 'base64url'), noncePhone, idMac: 'mac-device-0000000001', idPhone: 'iphone-0000000001' })
    expect(proofMatches(reply.proof, expected)).toBe(true)
    // ... and it is not the proof of the request: the label keeps them apart.
    expect(reply.proof).not.toBe(requestProof({ secret: s.secret.secret, fingerprintMac: MAC_FP, fingerprintPhone: PHONE_FP, nonceMac: Buffer.from(challenge, 'base64url'), noncePhone, idMac: 'mac-device-0000000001', idPhone: 'iphone-0000000001' }))
  })

  it('keeps the iPhone only after the iPhone says yes too: nothing is written when the accept goes out, and the Mac answers its bye with its own', async () => {
    const s = setup()
    let keptWhenAcceptArrived = -1
    let seen: Awaited<ReturnType<typeof iphone>> | null = null
    const outcome = await run(s, async (phone) => {
      seen = await iphone(s, phone, { onAccept: () => void (keptWhenAcceptArrived = s.added.length) })
    })
    expect(outcome.outcome).toBe('paired')
    expect(keptWhenAcceptArrived).toBe(0)
    expect(s.added).toHaveLength(1)
    // The Mac's last word is a bye, sent AFTER the iPhone was kept: the iPhone that reads it can come back at once to a Mac that knows it.
    expect((seen as unknown as Awaited<ReturnType<typeof iphone>>).final).toMatchObject({ t: 'bye' })
  })

  it('shows the person the same code the iPhone computes from the two fingerprints and the two code nonces, and the address the request came from (review n° 9, 21 and 36)', async () => {
    const s = setup({ peerAddress: '192.168.1.40' })
    let seen: Awaited<ReturnType<typeof iphone>> | null = null
    await run(s, async (phone) => void (seen = await iphone(s, phone)))
    const { nonceCodeMac, nonceCodePhone } = seen as unknown as Awaited<ReturnType<typeof iphone>>
    expect(nonceCodeMac).not.toBeNull()
    expect(s.requests).toEqual([{ name: 'iPhone de test', code: comparisonCode(MAC_FP, PHONE_FP, nonceCodeMac as Buffer, nonceCodePhone), address: '192.168.1.40' }])
    expect(s.requests[0]?.code).toMatch(/^[A-Z2-7]{6}$/)
  })

  it('shows a code that is not the one of the two fingerprints alone: the nonces are in it (review n° 36)', async () => {
    const s = setup()
    await run(s, async (phone) => void (await iphone(s, phone)))
    // The code the pairing showed before the commitment: made of the fingerprints alone, it could be searched for. With the two nonces it differs, here and every time.
    const oldCode = comparisonCode(MAC_FP, PHONE_FP, Buffer.alloc(16), Buffer.alloc(16))
    expect(s.requests[0]?.code).not.toBe(oldCode)
    const other = setup()
    await run(other, async (phone) => void (await iphone(other, phone)))
    expect(other.requests[0]?.code).not.toBe(s.requests[0]?.code)
  })

  it('tells the sheet the person allowed, so that it can say it waits for the iPhone', async () => {
    const s = setup()
    await run(s, async (phone) => void (await iphone(s, phone)))
    expect(s.waited).toEqual([1])
    const refused = setup({ decision: 'refuse' })
    await run(refused, async (phone) => void (await iphone(refused, phone)))
    expect(refused.waited).toEqual([])
  })

  it('makes a proof that holds only for this connection: the same iPhone request on another connection would not match', async () => {
    const first = setup()
    const second = setup()
    const proofs: string[] = []
    for (const s of [first, second]) {
      await run(s, async (phone) => {
        const { reply } = await iphone(s, phone)
        if (reply.t === 'pair.accept') proofs.push(reply.proof)
      })
    }
    expect(proofs).toHaveLength(2)
    expect(proofs[0]).not.toBe(proofs[1])
  })
})

describe('runPairing: the commitment of the iPhone (docs/synchronisation.md §4.7, review n° 36)', () => {
  it('sends its code nonce only after a right proof, and sends it to nobody else', async () => {
    const wrong = setup()
    let seenWrong: Awaited<ReturnType<typeof iphone>> | null = null
    await run(wrong, async (phone) => void (seenWrong = await iphone(wrong, phone, { wrongProof: true })))
    expect((seenWrong as unknown as Awaited<ReturnType<typeof iphone>>).nonceCodeMac).toBeNull()
    const closed = setup()
    closed.secret.close()
    let seenClosed: Awaited<ReturnType<typeof iphone>> | null = null
    await run(closed, async (phone) => void (seenClosed = await iphone(closed, phone)))
    expect((seenClosed as unknown as Awaited<ReturnType<typeof iphone>>).nonceCodeMac).toBeNull()
    const right = setup()
    let seenRight: Awaited<ReturnType<typeof iphone>> | null = null
    await run(right, async (phone) => void (seenRight = await iphone(right, phone)))
    expect((seenRight as unknown as Awaited<ReturnType<typeof iphone>>).nonceCodeMac).toHaveLength(16)
  })

  it('draws a new code nonce for every pairing', async () => {
    const nonces: string[] = []
    for (let n = 0; n < 3; n++) {
      const s = setup()
      await run(s, async (phone) => void nonces.push(((await iphone(s, phone)).nonceCodeMac as Buffer).toString('hex')))
    }
    expect(new Set(nonces).size).toBe(3)
  })

  it('refuses a nonce that does not open the commitment, shows no sheet and keeps nothing', async () => {
    const s = setup()
    let seen: Awaited<ReturnType<typeof iphone>> | null = null
    const outcome = await run(s, async (phone) => void (seen = await iphone(s, phone, { revealNonce: randomBytes(16) })))
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'bad-proof' })
    expect((seen as unknown as Awaited<ReturnType<typeof iphone>>).reply).toMatchObject({ t: 'error', code: 'bad-proof', fatal: true })
    expect(s.asked).toEqual([])
    expect(s.added).toEqual([])
  })

  it('refuses a commitment made over another fingerprint than the one the Mac saw in the TLS handshake: a relayed commitment does not open', async () => {
    const s = setup()
    const outcome = await run(s, async (phone) => void (await iphone(s, phone, { commitFingerprint: Buffer.alloc(32, 0x77) })))
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'bad-proof' })
    expect(s.asked).toEqual([])
    expect(s.added).toEqual([])
  })

  it('shows no sheet before the reveal: a person is never asked to compare a code that nothing commits', async () => {
    const s = setup({ revealMs: 60 })
    const outcome = await run(s, async (phone) => void (await iphone(s, phone, { skipReveal: true })))
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'timeout' })
    expect(s.asked).toEqual([])
    expect(s.added).toEqual([])
  })

  it('refuses a pair.request that has no commitment, which is the form from before: nothing is sent back and nothing kept', async () => {
    const s = setup()
    const outcome = await run(s, async (phone) => {
      const challenge = await phone.receive()
      if (challenge.t !== 'pair.challenge') throw new Error('no challenge')
      const noncePhone = randomBytes(16)
      const proof = requestProof({ secret: s.secret.secret, fingerprintMac: MAC_FP, fingerprintPhone: PHONE_FP, nonceMac: Buffer.from(challenge.nonce, 'base64url'), noncePhone, idMac: 'mac-device-0000000001', idPhone: 'iphone-0000000001' })
      // A request without `commit` is not a message the reader accepts: the cast is the point.
      await phone.send({ t: 'pair.request', device: { id: 'iphone-0000000001', name: 'iPhone de test', platform: 'ios' }, nonce: noncePhone.toString('base64url'), proof } as never)
      await phone.receive().catch(() => undefined)
    })
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'bad-message' })
    expect(s.asked).toEqual([])
    expect(s.added).toEqual([])
  })

  it('refuses a reveal that comes before the Mac has sent its nonce, and one that is not a reveal', async () => {
    const early = setup()
    const outcomeEarly = await run(early, async (phone) => {
      await phone.receive()
      await phone.send({ t: 'pair.reveal', nonce: randomBytes(16).toString('base64url') })
      await phone.receive().catch(() => undefined)
    })
    expect(outcomeEarly).toMatchObject({ outcome: 'failed', code: 'bad-message' })
    const wrongKind = setup()
    const outcomeKind = await run(wrongKind, async (phone) => {
      const challenge = await phone.receive()
      if (challenge.t !== 'pair.challenge') throw new Error('no challenge')
      const noncePhone = randomBytes(16)
      const proof = requestProof({ secret: wrongKind.secret.secret, fingerprintMac: MAC_FP, fingerprintPhone: PHONE_FP, nonceMac: Buffer.from(challenge.nonce, 'base64url'), noncePhone, idMac: 'mac-device-0000000001', idPhone: 'iphone-0000000001' })
      await phone.send({ t: 'pair.request', device: { id: 'iphone-0000000001', name: 'iPhone de test', platform: 'ios' }, nonce: noncePhone.toString('base64url'), proof, commit: pairingCommitment(PHONE_FP, randomBytes(16)) })
      await phone.receive()
      // The Mac waits for a reveal: a second request in its place is not one, and nothing is kept.
      await phone.send({ t: 'pair.request', device: { id: 'iphone-0000000001', name: 'iPhone de test', platform: 'ios' }, nonce: noncePhone.toString('base64url'), proof, commit: pairingCommitment(PHONE_FP, randomBytes(16)) })
      await phone.receive().catch(() => undefined)
    })
    expect(outcomeKind).toMatchObject({ outcome: 'failed', code: 'bad-message' })
    expect(wrongKind.asked).toEqual([])
  })
})

describe('runPairing: what it refuses', () => {
  it('refuses a wrong proof without asking the person, and leaves the secret open for the next try', async () => {
    const s = setup()
    const outcome = await run(s, async (phone) => {
      const { reply } = await iphone(s, phone, { wrongProof: true })
      expect(reply).toMatchObject({ t: 'error', code: 'bad-proof', fatal: true })
    })
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'bad-proof' })
    expect(s.asked).toEqual([])
    expect(s.added).toEqual([])
    expect(s.secret.attempt(() => true)).toBe('accepted')
  })

  it('refuses a proof made with a secret the Mac does not hold', async () => {
    const s = setup()
    const outcome = await run(s, async (phone) => void (await iphone(s, phone, { secret: randomBytes(16) })))
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'bad-proof' })
    expect(s.added).toEqual([])
  })

  it('refuses a proof that names another fingerprint: a man in the middle who presents its own certificate cannot make a proof that holds', async () => {
    const s = setup()
    const outcome = await run(s, async (phone) => void (await iphone(s, phone, { fingerprintPhone: Buffer.alloc(32, 0x99) })))
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'bad-proof' })
    expect(s.asked).toEqual([])
  })

  it(`locks the secret after ${MAX_INVALID_PROOFS} wrong proofs, even against a right one`, async () => {
    const s = setup()
    const codes: string[] = []
    for (let n = 0; n < MAX_INVALID_PROOFS + 1; n++) {
      const outcome = await run(s, async (phone) => void (await iphone(s, phone, { wrongProof: n < MAX_INVALID_PROOFS })))
      codes.push(outcome.outcome === 'failed' ? outcome.code : 'paired')
    }
    expect(codes).toEqual(['bad-proof', 'bad-proof', 'bad-proof', 'bad-proof', 'bad-proof', 'pairing-locked'])
    expect(s.added).toEqual([])
  })

  it('refuses after the window of two minutes, and when the sheet was closed', async () => {
    const late = setup()
    late.clock.now = PAIRING_WINDOW_MS
    expect(await run(late, async (phone) => void (await iphone(late, phone)))).toMatchObject({ outcome: 'failed', code: 'pairing-expired' })
    const closed = setup()
    closed.secret.close()
    expect(await run(closed, async (phone) => void (await iphone(closed, phone)))).toMatchObject({ outcome: 'failed', code: 'pairing-closed' })
    expect(late.asked.concat(closed.asked)).toEqual([])
  })

  it('refuses a second pairing with a secret that has been spent, whether the person refused or not', async () => {
    const s = setup({ decision: 'refuse' })
    expect(await run(s, async (phone) => void (await iphone(s, phone)))).toMatchObject({ outcome: 'failed', code: 'pairing-refused' })
    expect(await run(s, async (phone) => void (await iphone(s, phone)))).toMatchObject({ outcome: 'failed', code: 'pairing-used' })
    expect(s.added).toEqual([])
  })

  it('refuses when the person refuses, and tells the iPhone', async () => {
    const s = setup({ decision: 'refuse' })
    const outcome = await run(s, async (phone) => {
      const { reply } = await iphone(s, phone)
      expect(reply).toMatchObject({ t: 'error', code: 'pairing-refused' })
    })
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'pairing-refused' })
    expect(s.added).toEqual([])
  })

  it('keeps nothing when the iPhone says it is not the Mac of the code, and passes its refusal on', async () => {
    const s = setup()
    const outcome = await run(s, async (phone) => void (await iphone(s, phone, { decision: 'refuse' })))
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'pairing-refused' })
    expect(s.added).toEqual([])
  })

  it('keeps nothing when the iPhone says nothing for the time given to its person, and stops waiting', async () => {
    const s = setup({ confirmMs: 60 })
    const outcome = await run(s, async (phone) => void (await iphone(s, phone, { decision: 'silent' })))
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'timeout' })
    expect(s.added).toEqual([])
  })

  it('keeps nothing when the person gives up on the Mac while the iPhone is asked', async () => {
    let giveUp: () => void = () => undefined
    const s = setup({ confirmMs: 5_000, waiting: () => new Promise<void>((resolve) => void (giveUp = resolve)) })
    const outcome = await run(s, async (phone) => void (await iphone(s, phone, { decision: 'silent', onAccept: () => setTimeout(() => giveUp(), 20) })))
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'pairing-refused' })
    expect(s.added).toEqual([])
  })

  it('counts no answer as a refusal, and stops waiting', async () => {
    const s = setup({ decision: 'never', confirmMs: 50 })
    const outcome = await run(s, async (phone) => void (await iphone(s, phone)))
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'pairing-refused' })
    expect(s.added).toEqual([])
  })

  it('counts a sheet that fails as a refusal, and says so in the log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const s = setup({ decision: 'throw' })
    const outcome = await run(s, async (phone) => void (await iphone(s, phone)))
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'pairing-refused' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('counts as a refusal'), expect.anything())
    log.mockRestore()
  })

  it('pairs an iPhone only: a device that says it is a Mac is refused after the secret is spent', async () => {
    const s = setup()
    const outcome = await run(s, async (phone) => void (await iphone(s, phone, { platform: 'mac' })))
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'bad-message' })
    expect(s.asked).toEqual([])
    expect(s.added).toEqual([])
  })

  it('tells the iPhone `internal` instead of its last bye when the list of devices is full: the iPhone keeps nothing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const s = setup({
      addPeer: () => {
        throw new Error('more than 16 devices are paired')
      }
    })
    const outcome = await run(s, async (phone) => {
      const { final } = await iphone(s, phone)
      expect(final).toMatchObject({ t: 'error', code: 'internal' })
    })
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'internal' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not be kept'), expect.anything())
    log.mockRestore()
  })

  it('refuses anything but a pair.request after the challenge: the channel keeps the order of the phase', async () => {
    const s = setup()
    const outcome = await run(s, async (phone) => {
      await phone.receive()
      await phone.send({ t: 'hello', device: { id: 'iphone-0000000001', name: 'x', platform: 'ios' }, nonce: 'ABEiM0RVZneImaq7zN3u_w', categories: [], baseHash: null, stateVersion: 1, appVersion: '1', now: 1 })
      await phone.receive().catch(() => undefined)
    })
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'bad-message' })
    expect(s.asked).toEqual([])
  })

  it('ends quietly when the iPhone says so with an error of its own', async () => {
    const s = setup()
    const outcome = await run(s, async (phone) => {
      await phone.receive()
      await phone.send({ t: 'error', code: 'invalid-code', fatal: true })
    })
    expect(outcome).toMatchObject({ outcome: 'failed', code: 'invalid-code' })
  })

  it('reports an iPhone that leaves in the middle, with a warning and not an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const s = setup()
    const sockets = await socketPair()
    open.push(sockets.close)
    const mac = new Channel(sockets.server, { phase: 'pairing', role: 'mac' })
    const pending = runPairing(mac, s.ctx)
    sockets.client.destroy()
    expect(await pending).toMatchObject({ outcome: 'failed', code: 'internal' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ended before it was done'))
    warn.mockRestore()
  })
})
