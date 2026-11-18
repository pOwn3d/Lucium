// The Mac's side of a pairing (docs/synchronisation.md §4.1), played against an iPhone written in the test from the same primitives the iPhone's code is held to by
// the vectors: the proofs are recomputed here, not copied.
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channel } from './channel'
import { MAX_INVALID_PROOFS, PAIRING_WINDOW_MS } from './limits'
import { acceptProof, proofMatches, requestProof } from './pairing-proof'
import { PairingSecret } from './pairing-secret'
import { runPairing, type PairingContext } from './pairing-server'
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
  asked: string[]
}

function setup(over: Partial<PairingContext> & { decision?: 'allow' | 'refuse' | 'throw' | 'never' } = {}): Setup {
  const clock = { now: 0 }
  const secret = new PairingSecret(randomBytes(16), () => clock.now)
  const added: PeerRecord[] = []
  const asked: string[] = []
  const { decision = 'allow', ...rest } = over
  const ctx: PairingContext = {
    device: { id: 'mac-device-0000000001', name: 'MacBook de test', fingerprint: MAC_FP },
    secret,
    peerFingerprint: PHONE_FP,
    confirm: (request) => {
      asked.push(request.name)
      if (decision === 'throw') return Promise.reject(new Error('the sheet is gone'))
      if (decision === 'never') return new Promise(() => undefined)
      return Promise.resolve(decision)
    },
    addPeer: (peer) => void added.push(peer),
    hosts: () => ['macbook-de-test.local', '192.168.1.20'],
    now: () => 1_790_000_000_000,
    confirmMs: 80,
    ...rest
  }
  return { ctx, secret, clock, added, asked }
}

/** The iPhone: reads the challenge, answers with a proof made from `secret` (or a wrong one), and returns what the Mac says next. */
async function iphone(s: Setup, phone: Channel, options: { secret?: Buffer; fingerprintPhone?: Buffer; platform?: 'ios' | 'mac'; wrongProof?: boolean } = {}): Promise<{ challenge: string; noncePhone: Buffer; reply: Awaited<ReturnType<Channel['receive']>> }> {
  const challenge = await phone.receive()
  if (challenge.t !== 'pair.challenge') throw new Error(`expected a challenge, got ${challenge.t}`)
  const noncePhone = randomBytes(16)
  const proof = requestProof({ secret: options.secret ?? s.secret.secret, fingerprintMac: MAC_FP, fingerprintPhone: options.fingerprintPhone ?? PHONE_FP, nonceMac: Buffer.from(challenge.nonce, 'base64url'), noncePhone, idMac: 'mac-device-0000000001', idPhone: 'iphone-0000000001' })
  await phone.send({ t: 'pair.request', device: { id: 'iphone-0000000001', name: 'iPhone de test', platform: options.platform ?? 'ios' }, nonce: noncePhone.toString('base64url'), proof: options.wrongProof === true ? proof.replace(/.$/, proof.endsWith('A') ? 'B' : 'A') : proof })
  return { challenge: challenge.nonce, noncePhone, reply: await phone.receive() }
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
    // The iPhone checks the Mac's proof with the nonces of THIS connection: it is not a proof that another connection could replay.
    const expected = acceptProof({ secret: s.secret.secret, fingerprintMac: MAC_FP, fingerprintPhone: PHONE_FP, nonceMac: Buffer.from(challenge, 'base64url'), noncePhone, idMac: 'mac-device-0000000001', idPhone: 'iphone-0000000001' })
    expect(proofMatches(reply.proof, expected)).toBe(true)
    // ... and it is not the proof of the request: the label keeps them apart.
    expect(reply.proof).not.toBe(requestProof({ secret: s.secret.secret, fingerprintMac: MAC_FP, fingerprintPhone: PHONE_FP, nonceMac: Buffer.from(challenge, 'base64url'), noncePhone, idMac: 'mac-device-0000000001', idPhone: 'iphone-0000000001' }))
  })

  it('writes the iPhone down BEFORE it sends its accept: the iPhone cannot come back to a Mac that forgot it', async () => {
    const s = setup()
    let keptWhenAcceptArrived = -1
    await run(s, async (phone) => {
      const { reply } = await iphone(s, phone)
      if (reply.t === 'pair.accept') keptWhenAcceptArrived = s.added.length
    })
    expect(keptWhenAcceptArrived).toBe(1)
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

  it('tells the iPhone, and does not send its accept, when the list of devices is full', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const s = setup({
      addPeer: () => {
        throw new Error('more than 16 devices are paired')
      }
    })
    const outcome = await run(s, async (phone) => {
      const { reply } = await iphone(s, phone)
      expect(reply).toMatchObject({ t: 'error', code: 'internal' })
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
