// The icons of the tabs of a private window or of a container (ephemeral-scope.ts): fetched through the context's own session and handed to
// the interface as data. What a page declares as its icon is its choice, so the answer is bounded before it is held, and an answer that
// comes late is not shown on the page that took the place of the one that asked.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PageEvents, PageUpdate } from './types'
import type { ElectronEngine, Scope } from './electron-engine'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub({ session: {}, app: { getPath: () => '/tmp' }, net: {}, dialog: {} }))

const { EphemeralScope } = await import('./ephemeral-scope')

const MAX = 256 * 1024
const PNG = { 'content-type': 'image/png' }

type Answer = Response | Promise<Response>

/** A private context whose session answers each address with what the test prepared, and the patches its one page hands the interface. */
function context(answers: Record<string, () => Answer>): { update: (patch: PageUpdate) => void; seen: PageUpdate[]; fetched: string[]; dispose: () => void } {
  const fetched: string[] = []
  const scope = {
    key: 'ephemeral:1',
    prefix: 'ephemeral:1/',
    windowId: 'w1',
    session: {
      fetch: (url: string) => {
        fetched.push(url)
        const answer = answers[url]
        return answer ? Promise.resolve(answer()) : Promise.reject(new TypeError(`cannot reach ${url}`))
      }
    }
  } as unknown as Scope
  let wrapped: PageEvents | undefined
  const host = { createPage: (_opts: unknown, events: PageEvents) => ((wrapped = events), {}) } as unknown as ElectronEngine
  const handle = new EphemeralScope(host, scope)
  const seen: PageUpdate[] = []
  handle.createPage({ id: 't1', profileId: 'default' }, { update: (patch: PageUpdate) => void seen.push(patch) } as unknown as PageEvents)
  // `dispose` wipes the session, which this stand-in does not have: only the flag it raises is of use here.
  return { update: (patch) => wrapped!.update(patch), seen, fetched, dispose: () => void ((handle as unknown as { disposed: boolean }).disposed = true) }
}

/**
 * A body that hands out `chunk` bytes at a time, far beyond what an icon may weigh, and counts what was taken from it. It ends by itself
 * after sixteen times the limit, so that a reader which forgot its bound fails the test instead of filling the memory.
 */
function endless(chunk: number): { body: ReadableStream<Uint8Array>; taken: () => number; cancelled: () => boolean } {
  let taken = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (taken >= 16 * MAX) return controller.close()
        taken += chunk
        controller.enqueue(new Uint8Array(chunk))
      },
      cancel() {
        cancelled = true
      }
    },
    { highWaterMark: 0 }
  )
  return { body, taken: () => taken, cancelled: () => cancelled }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

afterEach(() => vi.restoreAllMocks())

describe('the icon of a private tab', () => {
  it('is handed over as data, and the address never reaches the interface', async () => {
    const c = context({ 'https://a.example/icon.png': () => new Response(new Uint8Array([1, 2, 3]), { headers: PNG }) })
    c.update({ faviconUrl: 'https://a.example/icon.png', title: 'A' })
    await settle()
    expect(c.seen).toEqual([{ title: 'A' }, { faviconUrl: 'data:image/png;base64,AQID' }])
  })

  it('is refused on the length the server declares, without reading the body', async () => {
    const stream = endless(64 * 1024)
    const c = context({ 'https://a.example/big.png': () => new Response(stream.body, { headers: { ...PNG, 'content-length': String(MAX + 1) } }) })
    c.update({ faviconUrl: 'https://a.example/big.png' })
    await settle()
    expect(c.seen).toEqual([])
    expect(stream.taken()).toBe(0)
    expect(stream.cancelled()).toBe(true)
  })

  it('stops reading a body that declares no length as soon as it is too large: what is held is bounded, whatever the server sends', async () => {
    const stream = endless(64 * 1024)
    const c = context({ 'https://a.example/endless.png': () => new Response(stream.body, { headers: PNG }) })
    c.update({ faviconUrl: 'https://a.example/endless.png' })
    await settle()
    expect(c.seen).toEqual([])
    expect(stream.cancelled()).toBe(true)
    // The chunk that crosses the limit is the last one asked for.
    expect(stream.taken()).toBeLessThanOrEqual(MAX + 64 * 1024)
  })

  it('accepts a body of exactly the limit', async () => {
    const c = context({ 'https://a.example/edge.png': () => new Response(new Uint8Array(MAX), { headers: PNG }) })
    c.update({ faviconUrl: 'https://a.example/edge.png' })
    await settle()
    expect(c.seen).toHaveLength(1)
    expect(c.seen[0]!.faviconUrl!.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('is not read at all when the answer is not an image', async () => {
    const stream = endless(1024)
    const c = context({ 'https://a.example/page': () => new Response(stream.body, { headers: { 'content-type': 'text/html' } }) })
    c.update({ faviconUrl: 'https://a.example/page' })
    await settle()
    expect(c.seen).toEqual([])
    expect(stream.taken()).toBe(0)
    expect(stream.cancelled()).toBe(true)
  })

  it('leaves the letter and says what kind of failure it was, never the address, when the icon cannot be fetched', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const c = context({})
    c.update({ faviconUrl: 'https://secret.example/icon.png' })
    await settle()
    expect(c.seen).toEqual([])
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0]![0])).toContain('TypeError')
    expect(JSON.stringify(debug.mock.calls)).not.toContain('secret.example')
    // The failure is remembered: the same address is not asked again.
    c.update({ faviconUrl: 'https://secret.example/icon.png' })
    await settle()
    expect(c.fetched).toEqual(['https://secret.example/icon.png'])
  })
})

describe('an icon that answers late', () => {
  /** An answer the test lets go when it wants. */
  function held(bytes: number[]): { answer: () => Promise<Response>; release: () => void } {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    return { answer: () => gate.then(() => new Response(new Uint8Array(bytes), { headers: PNG })), release }
  }

  it('is not put on the page the tab went to meanwhile', async () => {
    const slow = held([1])
    const c = context({ 'https://a.example/icon.png': slow.answer })
    c.update({ faviconUrl: 'https://a.example/icon.png' })
    c.update({ url: 'https://b.example/', newDocument: true })
    slow.release()
    await settle()
    expect(c.seen).toEqual([{ url: 'https://b.example/', newDocument: true }])
  })

  it('does not replace the newer icon of the same tab', async () => {
    const slow = held([1])
    const c = context({ 'https://a.example/old.png': slow.answer, 'https://b.example/new.png': () => new Response(new Uint8Array([2]), { headers: PNG }) })
    c.update({ faviconUrl: 'https://a.example/old.png' })
    c.update({ faviconUrl: 'https://b.example/new.png' })
    await settle()
    slow.release()
    await settle()
    expect(c.seen).toEqual([{ faviconUrl: 'data:image/png;base64,Ag==' }])
  })

  it('does not replace an icon the page gave as data meanwhile', async () => {
    const slow = held([1])
    const c = context({ 'https://a.example/old.png': slow.answer })
    c.update({ faviconUrl: 'https://a.example/old.png' })
    c.update({ faviconUrl: 'data:image/png;base64,AA==' })
    slow.release()
    await settle()
    expect(c.seen).toEqual([{ faviconUrl: 'data:image/png;base64,AA==' }])
  })

  it('is still shown when only the title or the loading state changed meanwhile', async () => {
    const slow = held([1])
    const c = context({ 'https://a.example/icon.png': slow.answer })
    c.update({ faviconUrl: 'https://a.example/icon.png' })
    c.update({ title: 'A' })
    slow.release()
    await settle()
    expect(c.seen).toEqual([{ title: 'A' }, { faviconUrl: 'data:image/png;base64,AQ==' }])
  })

  it('is not shown once the context is closed', async () => {
    const slow = held([1])
    const c = context({ 'https://a.example/icon.png': slow.answer })
    c.update({ faviconUrl: 'https://a.example/icon.png' })
    c.dispose()
    slow.release()
    await settle()
    expect(c.seen).toEqual([])
  })
})
