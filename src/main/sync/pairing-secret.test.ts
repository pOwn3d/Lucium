// The life of the pairing secret (docs/synchronisation.md §4.5) against the shared vectors, with a clock the test moves.
import { describe, expect, it } from 'vitest'
import { PAIRING_WINDOW_MS } from './limits'
import { PairingSecret, type PairingAnswer } from './pairing-secret'
import { pairingVectors } from './sync-vectors.test-support'

/** Plays the events of a vector: the clock is set to the moment of each, a `request` carries a proof that is right or not. */
function play(events: (typeof pairingVectors.secretLifecycle)[number]['events']): { answers: PairingAnswer[]; proofChecks: number } {
  let now = 1_000_000
  const secret = new PairingSecret(Buffer.alloc(16, 7), () => now)
  const start = now
  const answers: PairingAnswer[] = []
  let proofChecks = 0
  for (const event of events) {
    now = start + event.atMs
    if (event.event === 'close') secret.close()
    else if (event.event === 'request') {
      answers.push(
        secret.attempt(() => {
          proofChecks++
          return event.proof === 'valid'
        })
      )
    }
  }
  return { answers, proofChecks }
}

describe('PairingSecret: the vectors of the specification', () => {
  it.each(pairingVectors.secretLifecycle)('$name', ({ events, expect: expected }) => {
    expect(play(events).answers).toEqual(expected)
  })

  it('does not spend the work of a proof on a secret that is closed, locked, expired or used', () => {
    const { proofChecks } = play([
      { atMs: 1000, event: 'request', proof: 'valid' },
      { atMs: 2000, event: 'request', proof: 'valid' },
      { atMs: 3000, event: 'request', proof: 'invalid' }
    ])
    expect(proofChecks).toBe(1)
  })
})

describe('PairingSecret: the window', () => {
  it('counts down from the moment the secret is made, and stops at zero', () => {
    let now = 5000
    const secret = new PairingSecret(Buffer.alloc(16), () => now)
    expect(secret.remainingMs()).toBe(PAIRING_WINDOW_MS)
    now += 30_000
    expect(secret.remainingMs()).toBe(PAIRING_WINDOW_MS - 30_000)
    now += PAIRING_WINDOW_MS
    expect(secret.remainingMs()).toBe(0)
  })

  it('is closed for good by close(), even before anything was asked', () => {
    const secret = new PairingSecret(Buffer.alloc(16), () => 0)
    secret.close()
    expect(secret.attempt(() => true)).toBe('pairing-closed')
  })
})
