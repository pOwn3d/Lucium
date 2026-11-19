// The Mac's side of a pairing (docs/synchronisation.md §4.1, steps 4 to 9): one connection, from the challenge to the accept. The listener hands it a channel whose
// peer presented an unknown certificate during an open pairing window; the only thing such a connection may say is `pair.request`.
//
//   challenge  the Mac sends a nonce of 16 bytes
//   request    the iPhone sends its identity, its nonce, a proof and a commitment to its fingerprint and a code nonce it keeps back (§4.7); the Mac checks the proof
//              in constant time against what the QR's secret gives for THIS connection (both fingerprints and both nonces are in the transcription) and spends the
//              secret on the first right proof
//   nonce      only after a right proof, the Mac draws its own code nonce and sends it (a secret that is closed, spent, expired or locked gets none)
//   reveal     the iPhone reveals its code nonce; the Mac checks that it opens the commitment, over the fingerprint it SAW in the TLS handshake (review n° 36). The code
//              is made of the two fingerprints and the two code nonces, so that nobody can choose what it says after seeing the other side's half
//   confirm    [Q7] « Un iPhone nommé « … » demande à s'appairer »: Autoriser or Refuser; no answer in a minute is a refusal. The secret is burned in both cases. The sheet
//              shows the code to compare (pairing-compare.ts: the same six characters the iPhone shows, review n° 9), which only exists once the iPhone has revealed, and the address the request came from (n° 21)
//   accept     the Mac sends its identity, its addresses and ITS proof, which the iPhone checks before it writes anything. It has NOT written the iPhone down yet
//   compare    the iPhone shows « Appairer avec « … » ? Code : … » and its person says yes or no: `bye` is yes, an `error` is no (a minute at most). Both ends keep the
//              other only after both persons said yes: a code that is not the same on both screens is a pairing nobody wanted (§4.6)
//   keep       the Mac writes the iPhone in its list and answers `bye`, so that the iPhone that reads it can come back to a Mac that knows it; a list that is full is
//              told as `internal` instead, and the iPhone keeps nothing
//
// The code of an outcome is the one of the catalogue (§7.6); the listener counts the failures per address.

import { randomBytes } from 'node:crypto'
import { CODE_NONCE_BYTES, CONFIRM_MS, HANDSHAKE_TIMEOUT_MS, NONCE_BYTES } from './limits'
import { commitmentOpens } from './pairing-commit'
import { comparisonCode } from './pairing-compare'
import { Channel, ConnectionClosed, ProtocolError } from './channel'
import { acceptProof, proofMatches, requestProof } from './pairing-proof'
import type { PairingSecret } from './pairing-secret'
import type { ErrorCode } from './error-codes'
import type { PeerRecord } from './sync-store'

/** What the person is asked: the name the iPhone gave itself (shown as text, never trusted to recognise it), the code to compare with the iPhone's screen (§4.6) and the address of the connection. */
export interface PairingRequestInfo {
  name: string
  /** Six characters made of the two fingerprints and the two code nonces (pairing-compare.ts): the iPhone shows the same ones if it is the device this Mac is talking to. */
  code: string
  /** Where the request comes from: the person who photographed the QR is called « iPhone de … » too, and is not at the address of their iPhone. */
  address: string
}

export interface PairingContext {
  /** This Mac: its identifier, the name its person sees, and the fingerprint of its certificate. */
  device: { id: string; name: string; fingerprint: Buffer }
  /** The secret of the QR on screen, with its window. */
  secret: PairingSecret
  /** The fingerprint of the certificate the iPhone presented in the TLS handshake (what is pinned, not what it says). */
  peerFingerprint: Buffer
  /** The source address of the connection (the system's, not the device's). */
  peerAddress: string
  /** « Autoriser » or « Refuser » (the sheet of the Settings). A rejected promise is a refusal. */
  confirm: (request: PairingRequestInfo) => Promise<'allow' | 'refuse'>
  /**
   * The person allowed and the Mac now waits for the iPhone's person to compare the code and say yes. The promise settles when the Mac's person gives up on it (closes the
   * sheet, answers « Annuler ») or the window closes: the pairing then ends as a refusal. Absent: nobody can give up, and the wait ends with the iPhone's answer or the time.
   */
  waiting?: (request: PairingRequestInfo) => Promise<void>
  /** Keeps the device: throws when the list is full. */
  addPeer: (peer: PeerRecord) => void
  /** The addresses and the `.local` name the iPhone may come back to (already filtered: local only, at most four). */
  hosts: () => string[]
  /** The port this Mac listens on now (review n° 38): the iPhone keeps it for its next sessions, whatever the QR said. */
  port: () => number
  now: () => number
  /** How long the person has to answer; a test shortens it. */
  confirmMs?: number
  /** How long the iPhone has to reveal its code nonce once it has the Mac's (§4.7); a test shortens it. */
  revealMs?: number
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

    // The commitment of §4.7: the Mac's code nonce goes out only now (after the commitment and a right proof), and the iPhone's must open what it committed to.
    const nonceCodeMac = randomBytes(CODE_NONCE_BYTES)
    await channel.send({ t: 'pair.nonce', nonce: nonceCodeMac.toString('base64url') })
    // The iPhone answers at once (no person is involved yet): the silence it is allowed is the one of the handshake, not the minute of a person.
    channel.allowSilence(ctx.revealMs ?? HANDSHAKE_TIMEOUT_MS)
    const reveal = await channel.receive()
    if (reveal.t === 'error') return { outcome: 'failed', code: reveal.code, detail: 'the iPhone ended the pairing' }
    if (reveal.t !== 'pair.reveal') return fail('bad-message', `a ${reveal.t} is not expected after the code nonce`)
    const nonceCodePhone = Buffer.from(reveal.nonce, 'base64url')
    if (!commitmentOpens(request.commit, ctx.peerFingerprint, nonceCodePhone)) return fail('bad-proof', 'the nonce revealed does not open the commitment')

    const info: PairingRequestInfo = {
      name: request.device.name,
      code: comparisonCode(ctx.device.fingerprint, ctx.peerFingerprint, nonceCodeMac, nonceCodePhone),
      address: ctx.peerAddress
    }
    if ((await askPerson(ctx, info)) !== 'allow') return fail('pairing-refused', 'the person refused')

    const peer: PeerRecord = { id: request.device.id, name: request.device.name, platform: 'ios', fingerprint: ctx.peerFingerprint.toString('hex'), pairedAt: ctx.now(), lastSessionAt: null }
    const proof = acceptProof({ secret: ctx.secret.secret, fingerprintMac: ctx.device.fingerprint, fingerprintPhone: ctx.peerFingerprint, nonceMac, noncePhone, idMac: ctx.device.id, idPhone: request.device.id })
    await channel.send({ t: 'pair.accept', device: { id: ctx.device.id, name: ctx.device.name, platform: 'mac' }, proof, hosts: ctx.hosts(), port: ctx.port() })

    // The iPhone's person compares the code and decides; nothing is kept before they have said yes (§4.6). The silence the channel puts up with is made as long as the time
    // they are given, and the Mac's person can still give up.
    const given = ctx.confirmMs ?? CONFIRM_MS
    channel.allowSilence(given)
    const gaveUp = ctx.waiting?.(info).then(() => 'gave-up' as const)
    const word = await (gaveUp === undefined ? channel.receive() : Promise.race([channel.receive(), gaveUp]))
    if (word === 'gave-up') return fail('pairing-refused', 'the person gave up while the iPhone was asked')
    if (word.t === 'error') return { outcome: 'failed', code: word.code, detail: 'the iPhone did not agree to the pairing' }
    if (word.t !== 'bye') return fail('bad-message', `a ${word.t} is not expected after the accept`)
    try {
      ctx.addPeer(peer)
    } catch (error) {
      console.error('[sync] the iPhone could not be kept in the list of devices:', error)
      return fail('internal', 'the device could not be kept')
    }
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
