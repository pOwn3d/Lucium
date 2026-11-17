// What a script injected into a tab the user lent with a click is given of its extension, and what it may ask (lent-tab-runtime.ts): the worlds a bridge may be made in, the calls
// the main process takes from it, and what it is told of the other side.

import { describe, expect, it, vi } from 'vitest'
import { Channel } from './ipc-channels'
import {
  answerText,
  isLentWorld,
  isLentOp,
  LENT_CALL_MAX,
  LENT_CHANNEL,
  LENT_OPS,
  LENT_PAYLOAD_MAX,
  readLentAnswer,
  readLentCall,
  SCRIPT_WORLDS_COUNT,
  SCRIPT_WORLDS_FROM,
  senderOfExtension,
  senderOfScript,
  sizeAtMost,
  TOO_LONG
} from './lent-tab-runtime'

const ID = 'abcdefghijklmnopabcdefghijklmnop'

describe('the channels of a lent tab', () => {
  it('are written once, in this module, and are the ones the main process listens to (the preload reads them here, not from the list of the application)', () => {
    expect(Channel.lentTabAttach).toBe(LENT_CHANNEL.attach)
    expect(Channel.lentTabAttached).toBe(LENT_CHANNEL.attached)
    expect(Channel.lentTabCall).toBe(LENT_CHANNEL.call)
    expect(new Set(Object.values(LENT_CHANNEL)).size).toBe(3)
    for (const name of Object.values(LENT_CHANNEL)) expect(name).toMatch(/^lucium:lent-tab-/)
  })
})

describe('the worlds a bridge may be made in', () => {
  it('are the isolated worlds handed to extensions, and no other: never the page (0), never the preload\'s own (999), never one of the application', () => {
    expect(isLentWorld(SCRIPT_WORLDS_FROM)).toBe(true)
    expect(isLentWorld(SCRIPT_WORLDS_FROM + SCRIPT_WORLDS_COUNT - 1)).toBe(true)
    for (const world of [0, 1, 999, 1000, 4_200_001, SCRIPT_WORLDS_FROM - 1, SCRIPT_WORLDS_FROM + SCRIPT_WORLDS_COUNT, -4_300_000, 4_300_000.5, NaN, Infinity, '4300000', null, undefined, {}]) expect(isLentWorld(world), String(world)).toBe(false)
  })
})

describe('a call of a script of a lent tab', () => {
  it('is a message for the worker of its extension, whatever the message is', () => {
    expect(readLentCall('send', JSON.stringify({ message: { type: 'mount', n: [1, 2] } }))).toEqual({ op: 'send', message: { type: 'mount', n: [1, 2] } })
    expect(readLentCall('send', JSON.stringify({ message: null }))).toEqual({ op: 'send', message: null })
    expect(readLentCall('send', JSON.stringify({ message: 'text' }))).toEqual({ op: 'send', message: 'text' })
  })

  it('is a call of the local or the sync storage, with the one argument it takes', () => {
    expect(readLentCall('storage', JSON.stringify({ area: 'local', method: 'get', args: ['probe'] }))).toEqual({ op: 'storage', area: 'local', method: 'get', args: ['probe'] })
    expect(readLentCall('storage', JSON.stringify({ area: 'sync', method: 'set', args: [{ a: 1 }] }))).toEqual({ op: 'storage', area: 'sync', method: 'set', args: [{ a: 1 }] })
    expect(readLentCall('storage', JSON.stringify({ area: 'local', method: 'clear', args: [] }))).toEqual({ op: 'storage', area: 'local', method: 'clear', args: [] })
  })

  it('is nothing else: not another storage area, not another method of the storage, not another operation', () => {
    for (const area of ['session', 'managed', 'LOCAL', '', undefined]) expect(() => readLentCall('storage', JSON.stringify({ area, method: 'get', args: [] })), String(area)).toThrow('not offered')
    for (const method of ['setAccessLevel', 'getKeys', 'onChanged', '__proto__', undefined]) expect(() => readLentCall('storage', JSON.stringify({ area: 'local', method, args: [] })), String(method)).toThrow('not offered')
    for (const op of ['connect', 'scripting', 'eval', '', undefined, 4]) expect(() => readLentCall(op, JSON.stringify({ message: 1 })), String(op)).toThrow('not offered')
    expect(() => readLentCall('storage', JSON.stringify({ area: 'local', method: 'get', args: ['a', 'b'] }))).toThrow('one argument at most')
    expect(() => readLentCall('storage', JSON.stringify({ area: 'local', method: 'get', args: 'a' }))).toThrow('one argument at most')
  })

  it('is refused when it carries no JSON, an object that is not one, no message, or too much text', () => {
    expect(() => readLentCall('send', { message: 1 })).toThrow('no text')
    expect(() => readLentCall('send', undefined)).toThrow('no text')
    expect(() => readLentCall('send', '{not json')).toThrow('not JSON')
    expect(() => readLentCall('send', '[1]')).toThrow('no object')
    expect(() => readLentCall('send', 'null')).toThrow('no object')
    expect(() => readLentCall('send', '{}')).toThrow('no message')
    expect(() => readLentCall('send', JSON.stringify({ message: 'x'.repeat(LENT_CALL_MAX) }))).toThrow('too long')
  })

  // What parsing costs is what the cap is for: a text of brackets is small to the budget (it counts characters) and large to the heap, and the main process is held by the reading of it.
  it('is refused for its length before anything of it is parsed: five million brackets never reach JSON.parse', () => {
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expect(() => readLentCall('send', '['.repeat(5 * 1024 * 1024))).toThrow(TOO_LONG)
      expect(() => readLentCall('storage', '{'.repeat(LENT_CALL_MAX + 1))).toThrow(TOO_LONG)
      expect(parse).not.toHaveBeenCalled()
      // What is at the cap is read.
      expect(readLentCall('send', JSON.stringify({ message: 'x'.repeat(LENT_CALL_MAX - 20) }))).toMatchObject({ op: 'send' })
      expect(parse).toHaveBeenCalledOnce()
    } finally {
      parse.mockRestore()
    }
  })

  it('is one of the two the bridge offers, and nothing else', () => {
    expect(LENT_OPS).toEqual(['send', 'storage'])
    for (const op of ['send', 'storage']) expect(isLentOp(op), op).toBe(true)
    for (const op of ['connect', 'SEND', '', 'x'.repeat(1e6), undefined, null, 5, ['send'], { toString: () => 'send' }]) expect(isLentOp(op), String(op).slice(0, 20)).toBe(false)
  })
})

describe('what the other side answers', () => {
  it('is a value or an error, as the worker gives it, and anything else is "no answer"', () => {
    expect(readLentAnswer({ ok: true, value: { a: 1 } })).toEqual({ ok: true, value: { a: 1 } })
    expect(readLentAnswer({ ok: true })).toEqual({ ok: true })
    expect(readLentAnswer({ ok: false, error: 'Nope.' })).toEqual({ ok: false, error: 'Nope.' })
    for (const raw of [undefined, null, 'text', 4, [], { ok: 'yes' }, { ok: false }, { ok: false, error: 5 }]) expect(readLentAnswer(raw), JSON.stringify(raw)).toEqual({ ok: false, error: 'The extension gave no answer.' })
  })

  it('goes back to the script as JSON, an error too (an answer is never thrown)', () => {
    expect(JSON.parse(answerText({ ok: false, error: 'Could not.' }))).toEqual({ ok: false, error: 'Could not.' })
    expect(JSON.parse(answerText({ ok: true, value: [1] }))).toEqual({ ok: true, value: [1] })
  })
})

describe('how long a value would be as JSON, counted without writing it', () => {
  it('is its length in characters, near enough: strings by their length, the rest by what it usually takes', () => {
    expect(sizeAtMost('abc', 100)).toBe(5)
    expect(sizeAtMost({ a: 'abc' }, 100)).toBeGreaterThanOrEqual(JSON.stringify({ a: 'abc' }).length)
    expect(sizeAtMost([1, 2, 3, true, null, undefined, () => 1], 1000)).toBeGreaterThanOrEqual(JSON.stringify([1, 2, 3, true, null]).length)
    expect(sizeAtMost({ ok: true, value: { list: ['x'.repeat(50)], n: 1 } }, 1000)).toBeGreaterThanOrEqual(JSON.stringify({ ok: true, value: { list: ['x'.repeat(50)], n: 1 } }).length)
    expect(sizeAtMost(undefined, 10)).toBe(0)
  })

  it('is Infinity as soon as it is over the limit, for a string, a nest, an array of many items and a wide object, and does not walk the rest', () => {
    expect(sizeAtMost('x'.repeat(17 * 1024 * 1024), LENT_PAYLOAD_MAX)).toBe(Infinity)
    expect(sizeAtMost({ ok: true, value: { big: 'x'.repeat(17 * 1024 * 1024) } }, LENT_PAYLOAD_MAX)).toBe(Infinity)
    expect(sizeAtMost(new Array(20_000_000).fill(1), LENT_PAYLOAD_MAX)).toBe(Infinity)
    // Holes, undefined and functions are written as `null`: twenty million of them are a hundred million characters.
    expect(sizeAtMost(new Array(20_000_000), LENT_PAYLOAD_MAX)).toBe(Infinity)
    expect(sizeAtMost(new Array(5_000_000).fill(undefined), LENT_PAYLOAD_MAX)).toBe(Infinity)
    expect(sizeAtMost(new Array(5_000_000).fill(() => 1), LENT_PAYLOAD_MAX)).toBe(Infinity)
    expect(sizeAtMost(Array.from({ length: 1000 }, () => 'y'.repeat(100)), 50_000)).toBe(Infinity)
    expect(sizeAtMost(Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`key${i}`, 1])), 20_000)).toBe(Infinity)
    expect(sizeAtMost(['x'.repeat(100)], 50)).toBe(Infinity)
  })

  it('counts a typed array as the object of items JSON makes of it, and refuses a cycle and a nest too deep', () => {
    expect(sizeAtMost(new Uint8Array(3_000_000), LENT_PAYLOAD_MAX)).toBe(Infinity)
    const cycle: Record<string, unknown> = { a: 1 }
    cycle['self'] = cycle
    expect(sizeAtMost(cycle, LENT_PAYLOAD_MAX)).toBe(Infinity)
    let deep: unknown = 1
    for (let i = 0; i < 100; i++) deep = [deep]
    expect(sizeAtMost(deep, LENT_PAYLOAD_MAX)).toBe(Infinity)
    let shallow: unknown = 1
    for (let i = 0; i < 20; i++) shallow = [shallow]
    expect(sizeAtMost(shallow, LENT_PAYLOAD_MAX)).not.toBe(Infinity)
  })

  it('does not write the value out to count it', () => {
    const write = vi.spyOn(JSON, 'stringify')
    try {
      sizeAtMost({ ok: true, value: 'x'.repeat(1000) }, LENT_PAYLOAD_MAX)
      sizeAtMost('x'.repeat(20 * 1024 * 1024), LENT_PAYLOAD_MAX)
      expect(write).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
    }
  })
})

describe('who a message comes from', () => {
  it('the script of a tab is its extension, speaking from the page it runs in, in the top frame; the origin is the page\'s', () => {
    expect(senderOfScript(ID, 'https://meet.example.org/room/1?x=1')).toEqual({ id: ID, url: 'https://meet.example.org/room/1?x=1', origin: 'https://meet.example.org', frameId: 0, documentLifecycle: 'active' })
    expect(senderOfScript(ID, '').origin).toBe('')
    expect(senderOfScript(ID, 'data:text/html,hi').origin).toBe('data:text/html,hi')
  })

  it('the worker is the extension, at an address of its own: the one it says, if it is its own, else the root of the extension', () => {
    expect(senderOfExtension(ID, `chrome-extension://${ID}/background.js`)).toEqual({ id: ID, url: `chrome-extension://${ID}/background.js`, origin: `chrome-extension://${ID}` })
    for (const url of [undefined, 5, 'https://evil.example/', 'chrome-extension://other/background.js', `chrome-extension://${ID}evil/x`, `chrome-extension://${ID}/${'a'.repeat(3000)}`]) {
      expect(senderOfExtension(ID, url), String(url)).toEqual({ id: ID, url: `chrome-extension://${ID}/`, origin: `chrome-extension://${ID}` })
    }
  })
})
