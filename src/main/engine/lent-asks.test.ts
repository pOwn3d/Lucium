// What the main process keeps of the asks it makes of the workers for the scripts of lent tabs (lent-asks.ts): a few at once, a few waiting, a budget of text, and an end for each ask, so that a
// script that writes as fast as it can, or a listener that never answers, cannot make the main process grow. On a worker that is a function.

import { describe, expect, it, vi } from 'vitest'
import { ANSWER_WAIT_MS, LENT_ASK_LIMITS, LentAsks } from './lent-asks'
import { PORT_CLOSED, TOO_LONG } from '@shared/lent-tab-runtime'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'
const CLOSED = { ok: false, error: PORT_CLOSED }
const settle = (ms = 2): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A set of asks over a worker that keeps what it is sent (`sent`) and answers when told to; `waitMs` is how long an ask waits. */
function asks(options: { waitMs?: number; limits?: { running: number; waiting: number; characters: number } } = {}) {
  const sent: Array<{ profileId: string; extensionId: string; id: string; op: string; payload: unknown }> = []
  const send = vi.fn(async (profileId: string, extensionId: string, id: string, op: 'message' | 'storage', payload: unknown): Promise<void> => void sent.push({ profileId, extensionId, id, op, payload }))
  const lent = new LentAsks(send, options.limits ?? LENT_ASK_LIMITS, options.waitMs ?? 60_000)
  /** The worker answers the n-th ask it was sent. */
  const answer = (n: number, value: unknown = 'answered', extensionId = EXT, profileId = 'default', characters = 8): boolean => lent.answer(profileId, extensionId, sent[n]!.id, { ok: true, value }, characters)
  return { lent, sent, send, answer }
}

/** Asks `n` times for the same tab and extension, and keeps what each ask resolves with. */
function askMany(lent: LentAsks, n: number, options: { tab?: number; extensionId?: string; characters?: number } = {}): Array<{ settled: boolean; value?: unknown }> {
  return Array.from({ length: n }, (_, i) => {
    const row: { settled: boolean; value?: unknown } = { settled: false }
    void lent.ask('default', options.extensionId ?? EXT, options.tab ?? 7, 'message', { i }, options.characters ?? 10).then((value) => Object.assign(row, { settled: true, value }))
    return row
  })
}

describe('what is asked of a worker for the scripts of lent tabs', () => {
  it('is sent at once, and answered by the worker that was asked, with what it says', async () => {
    const { lent, sent, answer } = asks()
    const result = lent.ask('default', EXT, 7, 'storage', { area: 'local' }, 12)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ profileId: 'default', extensionId: EXT, op: 'storage', payload: { area: 'local' } })
    expect(answer(0, { k: 1 })).toBe(true)
    expect(await result).toEqual({ ok: true, value: { k: 1 } })
    expect(lent.size).toBe(0)
  })

  it('is answered once, and only for the extension and the profile it was sent for', async () => {
    const { lent, sent, answer } = asks()
    const result = lent.ask('default', EXT, 7, 'message', 1, 5)
    expect(answer(0, 'x', OTHER)).toBe(false)
    expect(answer(0, 'x', EXT, 'work')).toBe(false)
    expect(lent.answer('default', EXT, 'no such ask', { ok: true }, 4)).toBe(false)
    expect(lent.answer('default', EXT, 5, { ok: true }, 4)).toBe(false)
    expect(lent.size).toBe(1)
    expect(answer(0, 'first')).toBe(true)
    expect(answer(0, 'again')).toBe(false)
    expect(await result).toEqual({ ok: true, value: 'first' })
    expect(sent).toHaveLength(1)
  })

  it('waits five minutes at most for an answer, and keeps the bounds the security review asked for', () => {
    expect(ANSWER_WAIT_MS).toBeLessThanOrEqual(5 * 60 * 1000)
    expect(LENT_ASK_LIMITS).toEqual({ running: 32, waiting: 256, characters: 16 * 1024 * 1024 })
  })

  it('has ids that are not the order of the asks, so that an answer cannot be made for one that was not given', () => {
    const { lent, sent } = asks()
    askMany(lent, 3)
    const ids = sent.map((each) => each.id)
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('what is kept for one extension: a few asks at once, a few waiting, and no more', () => {
  it('sends 32 at once, makes the next ones wait their turn, and refuses with the words of a closed port beyond 32 running and 256 waiting', async () => {
    const { lent, sent } = asks()
    const rows = askMany(lent, 32 + 256 + 5)
    await settle()
    expect(sent).toHaveLength(32)
    expect(lent.size).toBe(32 + 256)
    // The five that could be kept nowhere were answered at once.
    const refused = rows.filter((row) => row.settled)
    expect(refused).toHaveLength(5)
    for (const row of refused) expect(row.value).toEqual(CLOSED)
  })

  it('sends the next one, in the order they came, when a running one is answered', async () => {
    const { lent, sent, answer } = asks()
    askMany(lent, 40)
    expect(sent).toHaveLength(32)
    answer(0)
    answer(1)
    await settle()
    expect(sent).toHaveLength(34)
    expect((sent[32]!.payload as { i: number }).i).toBe(32)
    expect((sent[33]!.payload as { i: number }).i).toBe(33)
    expect(lent.size).toBe(38)
  })

  it('counts each extension, in each profile, on its own: one that fills its places leaves the others theirs', () => {
    const { lent, sent } = asks()
    askMany(lent, 32 + 256 + 10)
    const before = sent.length
    const other = lent.ask('default', OTHER, 7, 'message', 1, 5)
    const work = lent.ask('work', EXT, 7, 'message', 1, 5)
    expect(sent.length).toBe(before + 2)
    expect(other).toBeInstanceOf(Promise)
    expect(work).toBeInstanceOf(Promise)
  })

  it('does not hold more text than its budget, the ones that wait included: what is over it is refused, and the room comes back as asks end', async () => {
    const { lent, sent, answer } = asks()
    const half = LENT_ASK_LIMITS.characters / 2
    const first = askMany(lent, 1, { characters: half })
    const second = askMany(lent, 1, { characters: half })
    const third = askMany(lent, 1, { characters: 1 })
    await settle()
    expect(first[0]!.settled).toBe(false)
    expect(second[0]!.settled).toBe(false)
    expect(third[0]).toEqual({ settled: true, value: CLOSED })
    expect(sent).toHaveLength(2)
    answer(0)
    await settle()
    const fourth = askMany(lent, 1, { characters: half })
    await settle()
    expect(fourth[0]!.settled).toBe(false)
    expect(sent).toHaveLength(3)
  })

  it('refuses at once an ask that alone is over the budget, without sending it', async () => {
    const { lent, sent } = asks()
    const row = askMany(lent, 1, { characters: LENT_ASK_LIMITS.characters + 1 })
    await settle()
    expect(row[0]).toEqual({ settled: true, value: CLOSED })
    expect(sent).toEqual([])
    expect(lent.size).toBe(0)
  })

  it('keeps a hundred thousand asks that nobody answers to the few it can keep: the rest are answered at once, and what is kept is bounded', async () => {
    const { lent, sent } = asks()
    let closed = 0
    for (let i = 0; i < 100_000; i++) void lent.ask('default', EXT, 7, 'message', { i }, 20).then((value) => (value && (value as { ok: boolean }).ok === false ? closed++ : 0))
    await settle(20)
    expect(lent.size).toBe(32 + 256)
    expect(sent).toHaveLength(32)
    expect(closed).toBe(100_000 - 32 - 256)
  })
})

describe('what a worker answers, which is of any size', () => {
  it('is replaced by an error when it is too long, or when it would pass the budget of the extension with what is kept: the ask ends, its place is free and the next is sent', async () => {
    const { lent, sent, answer } = asks({ limits: { running: 1, waiting: 4, characters: 1000 } })
    const rows = askMany(lent, 3, { characters: 100 })
    expect(sent).toHaveLength(1)
    // Over what is handed over (the size is Infinity): an error, as the words of what is too long.
    expect(answer(0, 'huge', EXT, 'default', Infinity)).toBe(true)
    await settle()
    expect(rows[0]).toEqual({ settled: true, value: { ok: false, error: TOO_LONG } })
    expect(sent).toHaveLength(2)
    // Alone it would fit; with the 100 of the ask that is still kept it does not.
    expect(answer(1, 'big', EXT, 'default', 901)).toBe(true)
    await settle()
    expect(rows[1]).toEqual({ settled: true, value: { ok: false, error: TOO_LONG } })
    expect(sent).toHaveLength(3)
    expect(answer(2, 'fits', EXT, 'default', 900)).toBe(true)
    await settle()
    expect(rows[2]).toEqual({ settled: true, value: { ok: true, value: 'fits' } })
    expect(lent.size).toBe(0)
  })

  it('is replaced by an error when its size is not a number it can trust (a worker cannot make its answer count for nothing)', async () => {
    const { lent, sent, answer } = asks()
    const rows = askMany(lent, 3)
    expect(answer(0, 'x', EXT, 'default', NaN)).toBe(true)
    expect(answer(1, 'x', EXT, 'default', -1)).toBe(true)
    expect(lent.answer('default', EXT, sent[2]!.id, { ok: true, value: 'x' }, undefined as unknown as number)).toBe(true)
    await settle()
    for (const row of rows) expect(row.value).toEqual({ ok: false, error: TOO_LONG })
  })

  it('is kept as it is when it is the size of an answer the budget has room for', async () => {
    const { lent, answer } = asks()
    const row = askMany(lent, 1)
    expect(answer(0, { list: [1, 2, 3] }, EXT, 'default', LENT_ASK_LIMITS.characters - 10)).toBe(true)
    await settle()
    expect(row[0]).toEqual({ settled: true, value: { ok: true, value: { list: [1, 2, 3] } } })
  })

  it('says whether an ask would be kept before its text is read: the same as asking, without asking', async () => {
    const { lent } = asks()
    const half = LENT_ASK_LIMITS.characters / 2
    expect(lent.canKeep('default', EXT, half)).toBe(true)
    expect(lent.canKeep('default', EXT, LENT_ASK_LIMITS.characters + 1)).toBe(false)
    askMany(lent, 1, { characters: half })
    expect(lent.canKeep('default', EXT, half)).toBe(true)
    expect(lent.canKeep('default', EXT, half + 1)).toBe(false)
    // Another extension has its room.
    expect(lent.canKeep('default', OTHER, LENT_ASK_LIMITS.characters)).toBe(true)
    askMany(lent, 31 + 256, { characters: 1 })
    expect(lent.canKeep('default', EXT, 1)).toBe(false)
    expect(lent.size).toBe(288)
  })
})

describe('what ends an ask that was not answered', () => {
  it('is the time it was given, its turn included: the ask is answered with a closed port and its place is free again', async () => {
    const { lent, sent } = asks({ waitMs: 30 })
    const rows = askMany(lent, 40)
    expect(sent).toHaveLength(32)
    await settle(80)
    expect(rows.every((row) => row.settled && JSON.stringify(row.value) === JSON.stringify(CLOSED))).toBe(true)
    expect(lent.size).toBe(0)
    // The table is empty: a new ask is sent at once.
    askMany(lent, 1)
    expect(sent.length).toBeGreaterThan(32)
  })

  it('is the end of the tab (it closes or goes to another document): what its script asked is answered with a closed port, running or waiting, and the table is empty', async () => {
    const { lent } = asks()
    const mine = askMany(lent, 40, { tab: 7 })
    const another = askMany(lent, 2, { tab: 8 })
    expect(lent.size).toBe(42)
    lent.tabGone(7)
    await settle()
    expect(mine.every((row) => row.settled && JSON.stringify(row.value) === JSON.stringify(CLOSED))).toBe(true)
    // What another tab asked is kept; and the places the first tab left are the other's.
    expect(another.every((row) => !row.settled)).toBe(true)
    expect(lent.size).toBe(2)
    lent.tabGone(8)
    expect(lent.size).toBe(0)
  })

  it('is the end of the worker that held it: what was sent to it is answered with a closed port, what waits is sent to the next one', async () => {
    const { lent, sent } = asks()
    const rows = askMany(lent, 40)
    expect(sent).toHaveLength(32)
    lent.workerGone('default', EXT)
    await settle()
    expect(rows.slice(0, 32).every((row) => row.settled && JSON.stringify(row.value) === JSON.stringify(CLOSED))).toBe(true)
    expect(rows.slice(32).every((row) => !row.settled)).toBe(true)
    expect(sent).toHaveLength(40)
    // Another extension's worker, or the same one in another profile, is not this one.
    lent.workerGone('default', OTHER)
    lent.workerGone('work', EXT)
    expect(lent.size).toBe(8)
  })

  it('is the extension leaving the profile: nothing it was asked is kept, running or waiting', async () => {
    const { lent } = asks()
    const mine = askMany(lent, 40)
    const other = askMany(lent, 1, { extensionId: OTHER })
    lent.extensionGone('default', EXT)
    await settle()
    expect(mine.every((row) => row.settled)).toBe(true)
    expect(other[0]!.settled).toBe(false)
    expect(lent.size).toBe(1)
  })

  it('is the worker that cannot be asked: the ask is answered with the reason, and the place goes to the next one', async () => {
    const { lent, send, sent } = asks({ limits: { running: 1, waiting: 4, characters: 1000 } })
    send.mockRejectedValueOnce(new Error('The worker of the extension did not start'))
    const rows = askMany(lent, 2)
    await settle()
    expect(rows[0]).toEqual({ settled: true, value: { ok: false, error: 'The worker of the extension did not start' } })
    expect(sent).toHaveLength(1)
    expect(rows[1]!.settled).toBe(false)
    expect(lent.size).toBe(1)
  })
})
