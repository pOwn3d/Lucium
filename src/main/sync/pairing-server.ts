// The Mac's side of a pairing (docs/synchronisation.md §4.1, steps 4 to 9): one connection, from the challenge to the accept. The listener hands it a channel whose
// peer presented an unknown certificate during an open pairing window; the only thing such a connection may say is `pair.request`.
//
//   challenge  the Mac sends a nonce of 16 bytes
//   request    the iPhone sends its identity, its nonce and a proof; the Mac checks it in constant time against what the QR's secret gives for THIS connection
//              (both fingerprints and both nonces are in the transcription) and spends the secret on the first right proof
//   confirm    [Q7] « Un iPhone nommé « … » demande à s'appairer »: Autoriser or Refuser; no answer in a minute is a refusal. The secret is burned in both cases
//   accept     the Mac writes the iPhone in its list, then sends its identity, its addresses and ITS proof, which the iPhone checks before it writes anything
//
// The code of an outcome is the one of the catalogue (§7.6); the listener counts the failures per address.

import { randomBytes } from 'node:crypto'
import { CONFIRM_MS, NONCE_BYTES } from './limits'
import { Channel, ConnectionClosed, ProtocolError } from './channel'
import { acceptProof, proofMatches, requestProof } from './pairing-proof'
import type { PairingSecret } from './pairing-secret'
import type { ErrorCode } from './error-codes'
import type { PeerRecord } from './sync-store'

/** What the person is asked: the name the iPhone gave itself (shown as text, never trusted to recognise it). */
export interface PairingRequestInfo {
  name: string
}

export interface PairingContext {
  /** This Mac: its identifier, the name its person sees, and the fingerprint of its certificate. */
  device: { id: string; name: string; fingerprint: Buffer }
  /** The secret of the QR on screen, with its window. */
  secret: PairingSecret
  /** The fingerprint of the certificate the iPhone presented in the TLS handshake (what is pinned, not what it says). */
  peerFingerprint: Buffer
  /** « Autoriser » or « Refuser » (the sheet of the Settings). A rejected promise is a refusal. */
  confirm: (request: PairingRequestInfo) => Promise<'allow' | 'refuse'>
  /** Keeps the device: throws when the list is full. */
  addPeer: (peer: PeerRecord) => void
  /** The addresses and the `.local` name the iPhone may come back to (already filtered: local only, at most four). */
  hosts: () => string[]
  now: () => number
  /** How long the person has to answer; a test shortens it. */
  confirmMs?: number
  /** Told when the iPhone's `pair.request` has come, whatever its proof: from then on the connection is not a silent one (listener.ts). */
  onRequest?: () => void
}

export type PairingOutcome = { outcome: 'paired'; peer: PeerRecord } | { outcome: 'failed'; code: ErrorCode; detail: string }

/** The answer of the person, or a refusal when they gave none in time (the timer is cleared as soon as an answer comes). */
async function askPerson(ctx: PairingContext, request: PairingRequestInfo): Promise<'allow' | 'refuse'> {
  let timer: NodeJS.Timeout | undefined
  const silence = new Promise<'refuse'>((resolve) => {
    timer = setTimeout(() => resolve('refuse'), ctx.confirmMs ?? CONFIRM_MS)
    timer.unref()
  })
  try {
    return await Promise.race([ctx.confirm(request), silence])
  } catch (error) {
    // The sheet could not be shown or was torn down: that is no consent.
    console.error('[sync] the confirmation of a pairing failed, which counts as a refusal:', error)
    return 'refuse'
  } finally {
    clearTimeout(timer)
  }
}

export async function runPairing(channel: Channel, ctx: PairingContext): Promise<PairingOutcome> {
  const fail = (code: ErrorCode, detail: string): PairingOutcome => {
    channel.fail(code, detail)
    return { outcome: 'failed', code, detail }
  }
  try {
    const nonceMac = randomBytes(NONCE_BYTES)
    await channel.send({ t: 'pair.challenge', nonce: nonceMac.toString('base64url') })
    const request = await channel.receive()
    if (request.t === 'error') return { outcome: 'failed', code: request.code, detail: 'the iPhone ended the pairing' }
    if (request.t !== 'pair.request') return fail('bad-message', `a ${request.t} is not expected in a pairing`)
    ctx.onRequest?.()

    const noncePhone = Buffer.from(request.nonce, 'base64url')
    const expected = requestProof({
      secret: ctx.secret.secret,
      fingerprintMac: ctx.device.fingerprint,
      fingerprintPhone: ctx.peerFingerprint,
      nonceMac,
      noncePhone,
      idMac: ctx.device.id,
      idPhone: request.device.id
    })
    // The state of the secret is asked first (closed, locked, expired, used), the proof only after: a refused secret spends no work on a proof (§4.5).
    const answer = ctx.secret.attempt(() => proofMatches(request.proof, expected))
    if (answer !== 'accepted') return fail(answer === 'bad-proof' ? 'bad-proof' : answer, `the secret answered ${answer}`)
    if (request.device.platform !== 'ios') return fail('bad-message', 'only an iPhone is paired by a code')

    if ((await askPerson(ctx, { name: request.device.name })) !== 'allow') return fail('pairing-refused', 'the person refused')

    const peer: PeerRecord = { id: request.device.id, name: request.device.name, platform: 'ios', fingerprint: ctx.peerFingerprint.toString('hex'), pairedAt: ctx.now(), lastSessionAt: null }
    try {
      ctx.addPeer(peer)
    } catch (error) {
      console.error('[sync] the iPhone could not be kept in the list of devices:', error)
      return fail('internal', 'the device could not be kept')
    }
    const proof = acceptProof({ secret: ctx.secret.secret, fingerprintMac: ctx.device.fingerprint, fingerprintPhone: ctx.peerFingerprint, nonceMac, noncePhone, idMac: ctx.device.id, idPhone: request.device.id })
    await channel.send({ t: 'pair.accept', device: { id: ctx.device.id, name: ctx.device.name, platform: 'mac' }, proof, hosts: ctx.hosts() })
    channel.bye()
    return { outcome: 'paired', peer }
  } catch (error) {
    // The conversation ended under the flow (a bad frame, silence, the iPhone left): the channel already told the peer what it had to; the outcome says why.
    if (error instanceof ProtocolError) return { outcome: 'failed', code: error.code, detail: error.detail }
    if (error instanceof ConnectionClosed) console.warn(`[sync] a pairing ended before it was done: ${error.message}`)
    else console.error('[sync] a pairing ended on an error:', error)
    channel.destroy()
    return { outcome: 'failed', code: 'internal', detail: 'the connection ended before the pairing did' }
  }
}
