// The fingerprint protection of the frames and the dedicated workers of a page (engine/inner-guard.ts): what is sent over the protocol session of the
// page, in which order, and what is never left waiting. The debugger is a stand-in; that a real page obeys these commands is the engine test's to say
// (src/main/smoke-probes-web.ts).

import { describe, expect, it, vi } from 'vitest'
import { FINGERPRINT_LEVELS, type FingerprintConfig } from '@shared/fingerprint'
import { frameGuardSource, workerGuardSource, type InnerTable } from '@shared/inner-guard'
import { InnerGuard, innerGuardFor, innerGuardOf } from './inner-guard'
import { OwnSession } from './own-session'
import { fakeDebugger, settle, type FakeDebugger } from './protocol.test-support'

const GUARD = '(function guard() {})'
const strict = (seed: number): FingerprintConfig => ({ ...FINGERPRINT_LEVELS.strict, seed })
const standard = (seed: number): FingerprintConfig => ({ ...FINGERPRINT_LEVELS.standard, seed })
const table = (origin: string, config: FingerprintConfig | null): InnerTable => ({ current: { origin, config }, fallback: standard(1000) })
const NEWS = table('https://news.test', strict(7))

function setup(dbg: FakeDebugger = fakeDebugger()) {
  const session = new OwnSession(dbg)
  const warn = vi.fn()
  let alive = true
  const guard = new InnerGuard({ debugger: dbg, session, guardText: GUARD, alive: () => alive, warn })
  const methods = (sessionId?: string): string[] => dbg.sent.filter((c) => c.sessionId === sessionId).map((c) => c.method)
  const attach = (type: string, sessionId: string, parent = ''): void => dbg.emit('Target.attachedToTarget', { sessionId, targetInfo: { type }, waitingForDebugger: true }, parent)
  return { dbg, session, guard, warn, methods, attach, die: () => void (alive = false) }
}

describe('the protection of the frames and the workers of a page', () => {
  it('costs nothing while nothing is asked: no session, no listener, no command', () => {
    const { dbg, guard } = setup()
    guard.set(null)
    guard.refresh()
    guard.stepAside()
    expect([dbg.calls, dbg.sent, dbg.listeners('message'), dbg.listeners('detach'), guard.on]).toEqual([[], [], 0, 0, false])
  })

  it('attaches one session, asks to be handed the frames of other sites and the workers at their start, and registers the script every document runs first', async () => {
    const { dbg, guard, warn } = setup()
    guard.set(NEWS)
    await settle()
    expect(dbg.calls).toEqual(['attach'])
    // The Page domain comes before the script: without it, a script is registered and never run.
    expect(dbg.sent.map((c) => c.method)).toEqual(['Target.setAutoAttach', 'Page.enable', 'Page.addScriptToEvaluateOnNewDocument'])
    expect(dbg.sent[0]!.params).toMatchObject({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    // A service worker is never held: an attached session would keep it running for ever.
    expect((dbg.sent[0]!.params as { filter: unknown[] }).filter[0]).toEqual({ type: 'service_worker', exclude: true })
    expect(dbg.sent[2]!.params).toEqual({ source: frameGuardSource(GUARD, NEWS) })
    expect(guard.on).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('sends nothing more for a new document of the same page, and replaces the script when the page or the strength changes: the new one is in before the old one is out', async () => {
    const { dbg, guard } = setup()
    guard.set(NEWS)
    await settle()
    guard.set({ ...NEWS })
    await settle()
    expect(dbg.sent).toHaveLength(3)
    const other = table('https://other.test', standard(9))
    guard.set(other)
    await settle()
    expect(dbg.sent.slice(3).map((c) => [c.method, c.params])).toEqual([
      ['Page.addScriptToEvaluateOnNewDocument', { source: frameGuardSource(GUARD, other) }],
      ['Page.removeScriptToEvaluateOnNewDocument', { identifier: '1' }]
    ])
    expect(dbg.calls).toEqual(['attach'])
  })

  it('takes the script it replaces out with the very next command, before any answer: no document starts with both', async () => {
    const { dbg, guard } = setup()
    guard.set(NEWS)
    await settle()
    const other = table('https://other.test', strict(9))
    // No wait: what the session reads right after the new script is the removal of the old one.
    guard.set(other)
    expect(dbg.sent.slice(-2).map((c) => [c.method, c.params])).toEqual([
      ['Page.addScriptToEvaluateOnNewDocument', { source: frameGuardSource(GUARD, other) }],
      ['Page.removeScriptToEvaluateOnNewDocument', { identifier: '1' }]
    ])
  })

  it('registers no script before the page is known: the first page of a tab gets its own script, and no stale one beside it', async () => {
    const { dbg, guard } = setup()
    guard.set({ current: null, fallback: standard(1000) })
    await settle()
    expect(dbg.sent.map((c) => c.method)).toEqual(['Target.setAutoAttach', 'Page.enable'])
    guard.set(NEWS)
    await settle()
    expect(dbg.sent.slice(2).map((c) => [c.method, c.params])).toEqual([['Page.addScriptToEvaluateOnNewDocument', { source: frameGuardSource(GUARD, NEWS) }]])
  })

  it('keeps one script at the end of changes that come faster than their answers', async () => {
    const { dbg, guard } = setup()
    guard.set(NEWS)
    guard.set(table('https://b.test', strict(2)))
    guard.set(table('https://c.test', strict(3)))
    await settle()
    const added = dbg.sent.filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument').length
    const removed = dbg.sent.filter((c) => c.method === 'Page.removeScriptToEvaluateOnNewDocument').map((c) => (c.params as { identifier: string }).identifier)
    expect(added - removed.length).toBe(1)
    expect(new Set(removed).size).toBe(removed.length)
    // The one left is the last asked for.
    expect(dbg.sent.filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument').at(-1)!.params).toEqual({ source: frameGuardSource(GUARD, table('https://c.test', strict(3))) })
  })

  it('gives a frame of another site the same script and the same watch, then lets it go', async () => {
    const { dbg, guard, methods, attach } = setup()
    guard.set(NEWS)
    await settle()
    attach('iframe', 'F1')
    await settle()
    expect(methods('F1')).toEqual(['Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger'])
    expect(dbg.sent.find((c) => c.sessionId === 'F1' && c.method === 'Page.addScriptToEvaluateOnNewDocument')!.params).toEqual({ source: frameGuardSource(GUARD, NEWS) })
    // The page changes: the frame's session follows, until the frame is gone.
    guard.set(table('https://other.test', null))
    await settle()
    expect(methods('F1').slice(4)).toEqual(['Page.addScriptToEvaluateOnNewDocument', 'Page.removeScriptToEvaluateOnNewDocument'])
    dbg.emit('Target.detachedFromTarget', { sessionId: 'F1' })
    guard.set(NEWS)
    await settle()
    expect(methods('F1')).toHaveLength(6)
  })

  it('lets a frame or a worker go once the event that hands it over is over, never from within it', async () => {
    // Electron emits the event inside the call that attaches the target, before the browser holds the frame: a resume sent then is lost.
    const { guard, methods, attach } = setup()
    guard.set(NEWS)
    await settle()
    attach('iframe', 'F1')
    attach('worker', 'W1')
    attach('service_worker', 'S1')
    expect([...methods('F1'), ...methods('W1'), ...methods('S1')]).not.toContain('Runtime.runIfWaitingForDebugger')
    expect(methods(undefined)).not.toContain('Target.detachFromTarget')
    await settle()
    for (const id of ['F1', 'W1', 'S1']) expect(methods(id).at(-1), id).toBe('Runtime.runIfWaitingForDebugger')
    expect(methods(undefined).at(-1)).toBe('Target.detachFromTarget')
  })

  it('makes a worker evaluate the guard with what the page gets before it is let go, and watches the workers it starts', async () => {
    const { dbg, guard, methods, attach, warn } = setup()
    guard.set(NEWS)
    await settle()
    attach('worker', 'W1')
    attach('worker', 'W2', 'W1')
    await settle()
    for (const id of ['W1', 'W2']) expect(methods(id), id).toEqual(['Runtime.evaluate', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger'])
    expect(dbg.sent.find((c) => c.sessionId === 'W1')!.params).toEqual({ expression: workerGuardSource(GUARD, strict(7)) })
    expect(warn).not.toHaveBeenCalled()
  })

  it('lets the worker of a site left out go as it is, and gives a worker the strength of the moment while no page is known yet', async () => {
    const left = setup()
    left.guard.set(table('https://skip.test', null))
    left.attach('worker', 'W1')
    await settle()
    expect(left.methods('W1')).toEqual(['Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger'])

    const early = setup()
    early.guard.set({ current: null, fallback: standard(1000) })
    early.attach('worker', 'W1')
    await settle()
    expect(early.dbg.sent.find((c) => c.method === 'Runtime.evaluate')!.params).toEqual({ expression: workerGuardSource(GUARD, standard(1000)) })
  })

  it('says so when the guard threw in a worker', async () => {
    const { dbg, guard, attach, warn } = setup()
    dbg.answer = (command) => (command.method === 'Runtime.evaluate' ? { exceptionDetails: { text: 'Uncaught' } } : { identifier: 'x' })
    guard.set(NEWS)
    attach('worker', 'W1')
    await settle()
    expect(warn).toHaveBeenCalledWith('the guard threw in a worker, which runs unprotected', 'Uncaught')
  })

  it('lets go, and gives back, a target that is not its to protect (a service worker that slipped through, anything unknown)', async () => {
    const { guard, methods, attach } = setup()
    guard.set(NEWS)
    await settle()
    attach('service_worker', 'S1')
    attach('other', 'O1', 'F9')
    await settle()
    expect(methods('S1')).toEqual(['Runtime.runIfWaitingForDebugger'])
    expect(methods('O1')).toEqual(['Runtime.runIfWaitingForDebugger'])
    expect(methods(undefined).slice(3)).toEqual(['Target.detachFromTarget'])
    expect(methods('F9')).toEqual(['Target.detachFromTarget'])
  })

  it('never leaves a frame or a worker waiting: it is let go when every command before failed, and the failures are told', async () => {
    const { dbg, guard, methods, attach, warn } = setup()
    guard.set(NEWS)
    await settle()
    dbg.answer = (command) => {
      if (command.method !== 'Runtime.runIfWaitingForDebugger') throw new Error('refused')
      return {}
    }
    attach('iframe', 'F1')
    attach('worker', 'W1')
    await settle()
    expect(methods('F1').at(-1)).toBe('Runtime.runIfWaitingForDebugger')
    expect(methods('W1').at(-1)).toBe('Runtime.runIfWaitingForDebugger')
    expect(warn.mock.calls.map(([what]) => what)).toEqual(expect.arrayContaining(['the command Page.addScriptToEvaluateOnNewDocument failed', 'the command Runtime.evaluate failed', 'the command Target.setAutoAttach failed']))
  })

  it('lets a frame go, and says why, when its script could not even be written', async () => {
    const { guard, methods, attach, warn } = setup()
    const broken: InnerTable = { ...NEWS }
    guard.set(broken)
    await settle()
    // A table that cannot be turned into text: nothing like it is ever built, which is why the frame must still be let go if it happens.
    ;(broken as { current: unknown }).current = { origin: 'https://news.test', config: 1n }
    attach('iframe', 'F1')
    await settle()
    expect(methods('F1')).toEqual(['Page.enable', 'Runtime.runIfWaitingForDebugger'])
    expect(warn).toHaveBeenCalledWith('cannot protect a iframe of the page', expect.any(TypeError))
  })

  it('says so when what it asked of a shared session cannot be taken back, or when its own session cannot be detached', async () => {
    const shared = setup()
    shared.session.acquire('color-scheme')
    shared.guard.set(NEWS)
    await settle()
    shared.dbg.answer = () => {
      throw new Error('refused')
    }
    shared.guard.set(null)
    await settle()
    expect(shared.warn.mock.calls.map(([what]) => what)).toEqual([
      'the command Target.setAutoAttach failed while the protection of the frames was taken away',
      'the command Page.removeScriptToEvaluateOnNewDocument failed while the protection of the frames was taken away',
      'the command Page.disable failed while the protection of the frames was taken away'
    ])

    const alone = setup()
    alone.guard.set(NEWS)
    await settle()
    const stuck = new Error('cannot detach')
    alone.dbg.detach = () => {
      throw stuck
    }
    alone.guard.set(null)
    expect(alone.warn).toHaveBeenCalledWith('cannot detach the session that protected the frames and the workers of the page', stuck)
  })

  it('asks again at the next document for a script that could not be registered, instead of believing it is there', async () => {
    const { dbg, guard, warn } = setup()
    dbg.answer = () => {
      throw new Error('not now')
    }
    guard.set(NEWS)
    await settle()
    expect(warn).toHaveBeenCalledWith('the command Page.addScriptToEvaluateOnNewDocument failed', expect.any(Error))
    dbg.answer = () => ({ identifier: 'late' })
    guard.set({ ...NEWS })
    await settle()
    expect(dbg.sent.filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(2)
  })

  it('never takes a session that is someone else\'s, and comes at the next document once it is free', async () => {
    const { dbg, guard, warn } = setup()
    dbg.attachForeign()
    guard.set(NEWS)
    expect([dbg.calls, dbg.sent, guard.on]).toEqual([[], [], false])
    expect(warn).not.toHaveBeenCalled()
    dbg.detach()
    guard.refresh()
    await settle()
    expect(guard.on).toBe(true)
    expect(dbg.sent.map((c) => c.method)).toEqual(['Target.setAutoAttach', 'Page.enable', 'Page.addScriptToEvaluateOnNewDocument'])
  })

  it('says why when the session cannot be attached, and tries again later', () => {
    const { dbg, guard, warn } = setup()
    dbg.attachFails = new Error('target crashed')
    guard.set(NEWS)
    expect(warn).toHaveBeenCalledWith('cannot attach the session that protects the frames and the workers of the page', dbg.attachFails)
    expect(guard.on).toBe(false)
    dbg.attachFails = null
    guard.refresh()
    expect(guard.on).toBe(true)
  })

  it('steps aside for an extension that debugs the page (the session is detached, nothing of ours is left listening), and comes back afterwards', async () => {
    const { dbg, guard } = setup()
    guard.set(NEWS)
    await settle()
    guard.stepAside()
    expect([dbg.isAttached(), dbg.listeners('message'), dbg.listeners('detach'), guard.on]).toEqual([false, 0, 0, false])
    const before = dbg.sent.length
    // A frame that shows up while we are away is not ours to answer.
    dbg.emit('Target.attachedToTarget', { sessionId: 'F1', targetInfo: { type: 'iframe' } })
    expect(dbg.sent).toHaveLength(before)
    guard.refresh()
    await settle()
    expect(dbg.calls).toEqual(['attach', 'detach', 'attach'])
    expect(dbg.sent.slice(before).map((c) => c.method)).toEqual(['Target.setAutoAttach', 'Page.enable', 'Page.addScriptToEvaluateOnNewDocument'])
  })

  it('gives the session back when the protection goes off; shared with the colour scheme, it stays and what we asked is taken back by hand', async () => {
    const alone = setup()
    alone.guard.set(NEWS)
    await settle()
    alone.guard.set(null)
    expect(alone.dbg.calls).toEqual(['attach', 'detach'])
    alone.guard.refresh()
    expect(alone.dbg.calls).toEqual(['attach', 'detach'])

    const shared = setup()
    shared.session.acquire('color-scheme')
    shared.guard.set(NEWS)
    await settle()
    const before = shared.dbg.sent.length
    shared.guard.set(null)
    await settle()
    expect(shared.dbg.calls).toEqual(['attach'])
    expect(shared.dbg.sent.slice(before).map((c) => [c.method, c.params])).toEqual([
      ['Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }],
      ['Page.removeScriptToEvaluateOnNewDocument', { identifier: '1' }],
      ['Page.disable', {}]
    ])
    expect(shared.session.holds('color-scheme')).toBe(true)
  })

  it('forgets a session detached from outside (DevTools, a crash) and attaches a new one at the next document, with its script', async () => {
    const { dbg, guard, warn } = setup()
    guard.set(NEWS)
    await settle()
    dbg.lose()
    expect([guard.on, dbg.listeners('message')]).toEqual([false, 0])
    guard.set({ ...NEWS })
    await settle()
    expect(dbg.calls).toEqual(['attach', 'attach'])
    expect(dbg.sent.filter((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(2)
    expect(warn).not.toHaveBeenCalled()
  })

  it('sends nothing to a page that is gone, and says nothing of the commands that end with it', async () => {
    const { dbg, guard, warn, die } = setup()
    guard.set(NEWS)
    await settle()
    die()
    dbg.answer = () => {
      throw new Error('target closed')
    }
    const before = dbg.sent.length
    guard.set(table('https://other.test', strict(2)))
    await settle()
    guard.set(null)
    expect(dbg.sent).toHaveLength(before)
    expect(warn).not.toHaveBeenCalled()
    expect(dbg.calls).toEqual(['attach'])
  })

  it('says nothing of the commands that fail because their frame or worker went before they were read', async () => {
    const { dbg, guard, attach, warn } = setup()
    guard.set(NEWS)
    await settle()
    dbg.answer = () => {
      throw new Error('session not found')
    }
    attach('worker', 'W1')
    attach('iframe', 'F1')
    dbg.emit('Target.detachedFromTarget', { sessionId: 'W1' })
    dbg.emit('Target.detachedFromTarget', { sessionId: 'F1' })
    await settle()
    expect(warn).not.toHaveBeenCalled()
  })

  it('is one per web contents', () => {
    const owner = {}
    expect(innerGuardOf(owner)).toBeUndefined()
    const { guard } = setup()
    const make = vi.fn(() => guard)
    expect(innerGuardFor(owner, make)).toBe(guard)
    expect(innerGuardFor(owner, make)).toBe(guard)
    expect(make).toHaveBeenCalledTimes(1)
    expect(innerGuardOf(owner)).toBe(guard)
  })
})
