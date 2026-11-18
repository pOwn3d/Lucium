// The messages of the synchronisation (docs/synchronisation.md §7) against the shared vectors, and what the vectors do not say: that a field this version does
// not know does not come out, that a nesting of a hundred thousand levels cannot exhaust the stack, that a text which is not UTF-8 is not a message.
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, isFatal } from './error-codes'
import { messageText, Numbering, parseMessage, PhaseTracker, STAMP, type MessageType } from './messages'
import { messageVectors, textOfVector } from './sync-vectors.test-support'

describe('parseMessage: the vectors of the specification', () => {
  it.each(messageVectors.messages)('$name', (vector) => {
    const parsed = parseMessage(textOfVector(vector))
    expect(parsed.ok ? { ok: true } : { ok: false, code: parsed.code }).toEqual(vector.expect)
  })

  it('refuses, in the vectors, with codes that are in the catalogue', () => {
    for (const vector of messageVectors.messages) if (!vector.expect.ok) expect(ERROR_CODES as readonly string[], vector.name).toContain(vector.expect.code)
  })
})

describe('parseMessage: what comes out', () => {
  const hello = (extra: Record<string, unknown> = {}): string => {
    const base = messageVectors.messages.find((v) => v.name === 'a hello from an iPhone')?.message as Record<string, unknown>
    return JSON.stringify({ ...base, ...extra })
  }

  it('gives back a typed message with the fields its type knows, and drops an unknown one', () => {
    const parsed = parseMessage(hello({ futureField: { a: [1, 2, 3] } }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(Object.keys(parsed.message).sort()).toEqual(['appVersion', 'baseHash', 'categories', 'device', 'n', 'nonce', 'now', 'stateVersion', 't', 'v'])
    expect(parsed.message).not.toHaveProperty('futureField')
  })

  it('keeps the unknown fields of an entity of a snapshot: they cross (§11.6)', () => {
    const base = messageVectors.messages.find((v) => v.name === 'a snapshot part with one entity')?.message as { entities: { fields: Record<string, unknown> }[] }
    const message = JSON.parse(JSON.stringify(base)) as typeof base
    message.entities[0]!.fields['aFieldOfALaterVersion'] = [1, { deeper: true }]
    const parsed = parseMessage(JSON.stringify(message))
    expect(parsed.ok && parsed.message.t === 'snapshot.part' && parsed.message.entities[0]?.fields['aFieldOfALaterVersion']).toEqual([1, { deeper: true }])
  })

  it('reads a negative zero as zero, at any depth', () => {
    const message = JSON.parse(hello()) as Record<string, unknown>
    message['now'] = 0
    const text = JSON.stringify(message).replace('"now":0', '"now":-0')
    expect(text).toContain('-0')
    const parsed = parseMessage(text)
    expect(parsed.ok && parsed.message.t === 'hello' && Object.is(parsed.message.now, 0)).toBe(true)
    const inList = parseMessage(JSON.stringify({ v: 1, t: 'snapshot.part', n: 1, part: 0, parts: 1, entities: [{ kind: 'x', id: 'y', fields: { list: [0, 1] }, stamps: {} }] }).replace('[0,1]', '[-0,1]'))
    expect(inList.ok && inList.message.t === 'snapshot.part' && Object.is((inList.message.entities[0]?.fields['list'] as number[])[0], 0)).toBe(true)
  })

  it('refuses a mark of a field that is not written the way a mark is', () => {
    const base = messageVectors.messages.find((v) => v.name === 'a snapshot part with one entity')?.message as { entities: { stamps: Record<string, string> }[] }
    for (const stamp of ['not-a-mark', '1790000000123-0003', '1790000000123-GGGG-dev', '179000000012-0003-dev', '']) {
      const message = JSON.parse(JSON.stringify(base)) as typeof base
      message.entities[0]!.stamps['name'] = stamp
      expect(parseMessage(JSON.stringify(message)), stamp).toEqual({ ok: false, code: 'bad-message' })
    }
    expect(STAMP.test('0')).toBe(true)
  })

  it('refuses text that is not JSON, and a frame that is not valid UTF-8, without throwing', () => {
    expect(parseMessage('{"v":1,')).toEqual({ ok: false, code: 'bad-message' })
    expect(messageText(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))).toBeNull()
    expect(messageText(Buffer.from('{"é":1}', 'utf8'))).toBe('{"é":1}')
  })

  it('does not take a type that the object itself holds for one of ours', () => {
    for (const t of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(parseMessage(JSON.stringify({ v: 1, t, n: 1 })), t).toEqual({ ok: false, code: 'unknown-type' })
  })

  it('survives a nesting of a hundred thousand levels (it is refused, the stack is not exhausted)', () => {
    const depth = 100_000
    const text = `{"v":1,"t":"bye","n":1,"x":${'['.repeat(depth)}${']'.repeat(depth)}}`
    expect(parseMessage(text)).toEqual({ ok: false, code: 'bad-message' })
  })

  it('counts the bytes of a key as it counts those of a text', () => {
    const key = 'k'.repeat(65_537)
    expect(parseMessage(`{"v":1,"t":"bye","n":1,"${key}":1}`)).toEqual({ ok: false, code: 'bad-message' })
  })
})

describe('Numbering (§7.1)', () => {
  it.each(messageVectors.sequences)('numbers: $name', ({ ns, expect: expected }) => {
    const numbering = new Numbering()
    let verdict: { ok: true } | { ok: false; code: string; at?: number } = { ok: true }
    for (const [at, n] of ns.entries()) {
      const one = numbering.accept(n)
      if (!one.ok) {
        verdict = { ok: false, code: one.code, at }
        break
      }
    }
    expect(verdict).toEqual(expected)
  })

  it('numbers what it sends from 1, one more each time', () => {
    const numbering = new Numbering()
    expect([numbering.next(), numbering.next(), numbering.next()]).toEqual([1, 2, 3])
  })

  it('does not move on when a number is refused: the connection ends there', () => {
    const numbering = new Numbering()
    expect(numbering.accept(2)).toEqual({ ok: false, code: 'bad-sequence' })
    expect(numbering.accept(1)).toEqual({ ok: true })
  })
})

describe('PhaseTracker (§7.4): the vectors of the specification', () => {
  it.each(messageVectors.transitions)('order: $name', (vector) => {
    const tracker = new PhaseTracker(vector.receiver, vector.phase)
    for (const type of vector.history) tracker.accept(type as MessageType)
    expect(tracker.accept(vector.type as MessageType)).toEqual(vector.expect)
  })

  it('says where the exchange stands', () => {
    const tracker = new PhaseTracker('mac', 'session')
    expect(tracker.has('hello')).toBe(false)
    tracker.accept('hello')
    expect(tracker.has('hello')).toBe(true)
    tracker.accept('snapshot.part')
    expect(tracker.has('snapshot.end')).toBe(false)
  })

  it('does not record a message it refused', () => {
    const tracker = new PhaseTracker('mac', 'session')
    expect(tracker.accept('snapshot.part').ok).toBe(false)
    expect(tracker.has('snapshot.part')).toBe(false)
  })
})

describe('the catalogue of the errors (§7.6)', () => {
  it('ends the connection for every code but the clocks', () => {
    for (const code of ERROR_CODES) expect(isFatal(code), code).toBe(code !== 'clock-skew')
  })
})
