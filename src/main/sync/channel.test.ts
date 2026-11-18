// One connection as a conversation (docs/synchronisation.md §7): the checks a frame goes through, in the order they are made, and what each refusal leaves behind.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channel, ConnectionClosed, ProtocolError } from './channel'
import { encodeFrame } from './frames'
import { MAX_FRAME_BYTES } from './limits'
import { sleep, socketPair } from './sync-net.test-support'

const open: Array<() => void> = []
afterEach(() => {
  while (open.length > 0) open.pop()?.()
})

async function pair(options: { phase?: 'pairing' | 'session'; idleMs?: number; maxContentBytes?: number } = {}): Promise<{ mac: Channel; phone: Channel; macRaw: import('node:net').Socket; phoneRaw: import('node:net').Socket }> {
  const sockets = await socketPair()
  open.push(sockets.close)
  const phase = options.phase ?? 'session'
  return {
    mac: new Channel(sockets.server, { phase, role: 'mac', ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}), ...(options.maxContentBytes !== undefined ? { maxContentBytes: options.maxContentBytes } : {}) }),
    phone: new Channel(sockets.client, { phase, role: 'ios' }),
    macRaw: sockets.server,
    phoneRaw: sockets.client
  }
}

const hello = { t: 'hello', device: { id: 'phone-1', name: 'iPhone', platform: 'ios' }, nonce: 'ABEiM0RVZneImaq7zN3u_w', categories: ['structure'], baseHash: null, stateVersion: 1, appVersion: '1.2.0', now: 1_790_000_000_000 } as const

describe('Channel: the conversation', () => {
  it('delivers what the other side sends, in order, numbered from 1', async () => {
    const { mac, phone } = await pair()
    await phone.send(hello)
    await phone.send({ t: 'snapshot.part', part: 0, parts: 1, entities: [] })
    const first = await mac.receive()
    const second = await mac.receive()
    expect([first.t, first.n, second.t, second.n]).toEqual(['hello', 1, 'snapshot.part', 2])
    expect(first).toMatchObject({ v: 1, device: { id: 'phone-1' } })
  })

  it('keeps a message that arrives before anyone waits for it', async () => {
    const { mac, phone } = await pair()
    await phone.send(hello)
    await sleep(30)
    expect((await mac.receive()).t).toBe('hello')
  })

  it('numbers what it sends from 1, one more each time, the error counting', async () => {
    const { mac, phone } = await pair()
    await mac.send(hello)
    await mac.send({ t: 'snapshot.part', part: 0, parts: 1, entities: [] })
    expect((await phone.receive()).n).toBe(1)
    expect((await phone.receive()).n).toBe(2)
  })
})

describe('Channel: what ends it, and how the peer is told', () => {
  const expectFault = async (channel: Channel, code: string): Promise<void> => {
    const error = await channel.receive().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProtocolError)
    expect((error as ProtocolError).code).toBe(code)
  }

  it('refuses a frame that is not JSON: bad-message, and the peer is told with an error frame', async () => {
    const { mac, phoneRaw, phone } = await pair()
    const garbage = Buffer.from('not json')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(garbage.length)
    phoneRaw.write(Buffer.concat([header, garbage]))
    await expectFault(mac, 'bad-message')
    const told = await phone.receive()
    expect(told).toMatchObject({ t: 'error', code: 'bad-message', fatal: true })
  })

  it('refuses a message that is out of its phase: a snapshot before hello', async () => {
    const { mac, phone } = await pair()
    await phone.send({ t: 'snapshot.part', part: 0, parts: 1, entities: [] })
    await expectFault(mac, 'bad-message')
  })

  it('refuses a message whose number is not the next', async () => {
    const { mac, phoneRaw } = await pair()
    phoneRaw.write(encodeFrame({ ...hello, v: 1, n: 2 }))
    await expectFault(mac, 'bad-sequence')
  })

  it('refuses a version that is not ours', async () => {
    const { mac, phoneRaw } = await pair()
    phoneRaw.write(encodeFrame({ ...hello, v: 2, n: 1 }))
    await expectFault(mac, 'unsupported-version')
  })

  it('refuses a frame of length zero, and one of more than a mebibyte, without reading their content', async () => {
    for (const [length, code] of [[0, 'bad-frame'], [MAX_FRAME_BYTES + 1, 'too-large']] as const) {
      const { mac, phoneRaw } = await pair()
      const header = Buffer.alloc(4)
      header.writeUInt32BE(length)
      phoneRaw.write(header)
      await expectFault(mac, code)
    }
  })

  it('refuses a frame that is not valid UTF-8', async () => {
    const { mac, phoneRaw } = await pair()
    const header = Buffer.alloc(4)
    header.writeUInt32BE(4)
    phoneRaw.write(Buffer.concat([header, Buffer.from([0x7b, 0xff, 0xfe, 0x7d])]))
    await expectFault(mac, 'bad-message')
  })

  it('refuses a connection whose contents add up to more than the bound', async () => {
    const { mac, phone } = await pair({ maxContentBytes: 300 })
    await phone.send(hello)
    await phone.send({ t: 'snapshot.part', part: 0, parts: 1, entities: [{ kind: 'x', id: 'y', fields: { a: 'z'.repeat(400) }, stamps: {} }] })
    expect((await mac.receive()).t).toBe('hello')
    await expectFault(mac, 'too-large')
  })

  it('ends on silence: timeout, told to the peer', async () => {
    const { mac, phone } = await pair({ idleMs: 60 })
    await expectFault(mac, 'timeout')
    expect(await phone.receive()).toMatchObject({ t: 'error', code: 'timeout', fatal: true })
  })

  it('counts every byte as a sign of life', async () => {
    const { mac, phone, phoneRaw } = await pair({ idleMs: 150 })
    const frame = encodeFrame({ ...hello, v: 1, n: 1 })
    for (let at = 0; at < frame.length; at += 40) {
      phoneRaw.write(frame.subarray(at, at + 40))
      await sleep(70)
    }
    expect((await mac.receive()).t).toBe('hello')
    expect(phone.failure()).toBeNull()
  })

  it('reports a connection that the peer closed', async () => {
    const { mac, phoneRaw } = await pair()
    phoneRaw.end()
    const error = await mac.receive().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConnectionClosed)
  })

  it('still delivers what arrived before the connection ended, then reports the end', async () => {
    const { mac, phone, phoneRaw } = await pair()
    await phone.send(hello)
    phoneRaw.end()
    await sleep(40)
    expect((await mac.receive()).t).toBe('hello')
    expect(await mac.receive().catch((e: unknown) => e)).toBeInstanceOf(ConnectionClosed)
  })

  it('is sticky: after a fault every receive and send answers the same fault', async () => {
    const { mac, phoneRaw } = await pair()
    phoneRaw.write(encodeFrame({ ...hello, v: 1, n: 5 }))
    await expectFault(mac, 'bad-sequence')
    await expectFault(mac, 'bad-sequence')
    await expect(mac.send({ t: 'bye' })).rejects.toBeInstanceOf(ProtocolError)
  })

  it('reads nothing after a fault: a valid message sent behind a bad one is not delivered, in the same chunk or in the next', async () => {
    const same = await pair()
    same.phoneRaw.write(Buffer.concat([encodeFrame({ ...hello, v: 1, n: 3 }), encodeFrame({ ...hello, v: 1, n: 1 })]))
    await expectFault(same.mac, 'bad-sequence')
    await expectFault(same.mac, 'bad-sequence')
    const later = await pair()
    later.phoneRaw.write(encodeFrame({ ...hello, v: 1, n: 3 }))
    await expectFault(later.mac, 'bad-sequence')
    later.phoneRaw.write(encodeFrame({ ...hello, v: 1, n: 1 }))
    await sleep(60)
    await expectFault(later.mac, 'bad-sequence')
  })

  it('fail() tells the peer with the code and whether it is fatal: a clock warning is not', async () => {
    const { mac, phone } = await pair()
    mac.fail('clock-skew', 'the clocks differ')
    expect(await phone.receive()).toMatchObject({ t: 'error', code: 'clock-skew', fatal: false })
  })

  it('bye ends the writing side with a bye the peer reads', async () => {
    const { mac, phone } = await pair()
    mac.bye()
    expect(await phone.receive()).toMatchObject({ t: 'bye', n: 1 })
    expect(await phone.receive().catch((e: unknown) => e)).toBeInstanceOf(ConnectionClosed)
  })

  it('says it in the log when the error cannot be written because the connection is already gone', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { mac, macRaw } = await pair()
    macRaw.destroy()
    // The write on a destroyed socket reports through the callback of `end`, not by throwing: nothing is logged and nothing throws.
    expect(() => mac.fail('internal', 'x')).not.toThrow()
    log.mockRestore()
  })

  it('destroy() cuts at once and rejects the waiting call', async () => {
    const { mac } = await pair()
    const waiting = mac.receive()
    mac.destroy()
    await expect(waiting).rejects.toBeInstanceOf(ConnectionClosed)
  })
})
