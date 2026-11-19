// The channel of the page « Synchronisation » as `registerIpc` registers it for a window (docs/synchronisation.md §13.1, AGENTS.md §6): who may ask, what is refused before
// anything is done, what each request does to the service, and what a failure tells. The parsing of a request is tested alone (shared/sync-ipc.test.ts) and the service too
// (sync/sync-service.test.ts); here it is the handler that is run.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { t } from '@shared/i18n'
import type { SyncReply, SyncStatus } from '@shared/sync-ipc'
import { setSyncService } from '../sync/registry'
import { SyncServiceError, type SyncService } from '../sync/sync-service'
import type { ScopedIpc } from './ipc-scope'
import type { SyncResumeReply, ResumeRow } from '@shared/sync-resume'
import { handleSyncRequest, handleSyncResume, registerSyncIpc } from './sync-ipc'

type Handler = (event: { sender: object }, raw: unknown) => Promise<SyncReply>

const STATUS: SyncStatus = { available: true, enabled: false, categories: { structure: true, settings: false, archive: false, openTabs: false }, listening: false, pairing: null, confirm: null, devices: [], identityReplaced: false, justPaired: null, lastExchange: null, problem: null }

/** A service that records what it is asked, and answers the state it was given. */
function fakeService(over: Partial<Record<keyof SyncService, unknown>> = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const record = (name: string) => (...args: unknown[]) => void calls.push([name, ...args])
  const service = {
    status: () => STATUS,
    setEnabled: async (on: boolean) => record('setEnabled')(on),
    setCategory: record('setCategory'),
    startPairing: async () => record('startPairing')(),
    closePairing: record('closePairing'),
    answer: record('answer'),
    forget: record('forget'),
    leave: async () => record('leave')(),
    ...over
  } as unknown as SyncService
  return { service, calls }
}

function windowSync(options: { trusted?: boolean; private?: boolean; state?: unknown; dispatch?: (action: unknown) => void; locked?: string[] } = {}) {
  const handlers = new Map<string, Handler>()
  const ipc: ScopedIpc = { on: () => undefined, handle: (channel, listener) => void handlers.set(channel, listener as unknown as Handler) }
  const guard = vi.fn(() => options.trusted ?? true)
  registerSyncIpc(ipc, guard, { isPrivate: () => options.private === true, dispatch: options.dispatch ?? (() => undefined) } as never, { get: () => (options.state ?? { spaces: [], activeSpaceId: '' }) as never })
  const sender = {}
  return { guard, sender, ask: (raw: unknown) => handlers.get(Channel.syncRequest)!({ sender }, raw), resume: (raw: unknown) => handlers.get(Channel.syncResume)!({ sender }, raw) as unknown as SyncResumeReply }
}

afterEach(() => {
  setSyncService(null)
  vi.restoreAllMocks()
})

describe('the channel of the synchronisation page: who may ask', () => {
  it('registers one channel, on the name the interface sends to', () => {
    const handlers: string[] = []
    registerSyncIpc({ on: () => undefined, handle: (channel) => void handlers.push(channel) }, () => true, { isPrivate: () => false } as never, { get: () => ({}) as never })
    expect(handlers).toEqual(['lucium:sync', 'lucium:sync-resume'])
  })

  it('asks the guard of the window first, and does nothing for a sender it does not trust', async () => {
    const { service, calls } = fakeService()
    setSyncService(service)
    const w = windowSync({ trusted: false })
    expect(await w.ask({ kind: 'enable', on: true })).toEqual({ ok: false, message: t('feature.demande-refusee'), status: null })
    expect(w.guard).toHaveBeenCalledWith(w.sender, 'lucium:sync')
    expect(calls).toEqual([])
  })

  it('refuses it all in a private window: nothing of the synchronisation is for it', async () => {
    const { service, calls } = fakeService()
    setSyncService(service)
    const w = windowSync({ private: true })
    expect(await w.ask({ kind: 'status' })).toMatchObject({ ok: false, status: null })
    expect(calls).toEqual([])
  })

  it('says it is not available when no service was made, and does not throw', async () => {
    const w = windowSync()
    expect(await w.ask({ kind: 'status' })).toEqual({ ok: false, message: t('feature.demande-invalide'), status: null })
  })
})

describe('the channel of the synchronisation page: what is refused before anything happens', () => {
  it.each([
    ['nothing', undefined],
    ['a kind that does not exist', { kind: 'export-key' }],
    ['a field more', { kind: 'status', path: '/etc' }],
    ['enable with a text', { kind: 'enable', on: 'true' }],
    ['a category that does not exist', { kind: 'category', category: 'passwords', on: true }],
    ['forget with a path', { kind: 'forget', id: '../x' }],
    ['a list', [{ kind: 'status' }]]
  ])('%s: refused with a sentence, the service is not touched', async (_name, raw) => {
    const { service, calls } = fakeService()
    setSyncService(service)
    const reply = await windowSync().ask(raw)
    expect(reply).toEqual({ ok: false, message: t('feature.demande-invalide'), status: STATUS })
    expect(calls).toEqual([])
  })
})

describe('the channel of the synchronisation page: what each request does', () => {
  it.each([
    [{ kind: 'status' }, []],
    [{ kind: 'enable', on: true }, [['setEnabled', true]]],
    [{ kind: 'enable', on: false }, [['setEnabled', false]]],
    [{ kind: 'category', category: 'openTabs', on: true }, [['setCategory', 'openTabs', true]]],
    [{ kind: 'pair-start' }, [['startPairing']]],
    [{ kind: 'pair-close' }, [['closePairing']]],
    [{ kind: 'answer', allow: true }, [['answer', true]]],
    [{ kind: 'answer', allow: false }, [['answer', false]]],
    [{ kind: 'forget', id: 'iphone-1' }, [['forget', 'iphone-1']]],
    [{ kind: 'leave' }, [['leave']]]
  ])('%j reaches the service as %j and answers the state', async (request, expected) => {
    const { service, calls } = fakeService()
    setSyncService(service)
    expect(await windowSync().ask(request)).toEqual({ ok: true, status: STATUS })
    expect(calls).toEqual(expected)
  })
})

describe('handleSyncRequest: what a failure says', () => {
  it.each(['unavailable', 'port', 'identity', 'locked', 'network', 'internal'] as const)('tells a failure named `%s` in the words of the catalogue, with the state', async (problem) => {
    const { service } = fakeService({
      startPairing: async () => {
        throw new SyncServiceError(problem, 'x')
      }
    })
    const reply = await handleSyncRequest(service, { kind: 'pair-start' })
    expect(reply).toEqual({ ok: false, message: t(`sync.error.${problem}`), status: STATUS })
    expect(t(`sync.error.${problem}`)).not.toBe(`sync.error.${problem}`)
  })

  it('tells any other failure as `internal`, and logs it with its cause: nothing is swallowed', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { service } = fakeService({
      startPairing: async () => {
        throw new Error('the disk is gone')
      }
    })
    const reply = await handleSyncRequest(service, { kind: 'pair-start' })
    expect(reply).toEqual({ ok: false, message: t('sync.error.internal'), status: STATUS })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[sync]'), expect.objectContaining({ message: 'the disk is gone' }))
  })

  it('never puts the text of an error in the sentence the page shows', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { service } = fakeService({
      setEnabled: async () => {
        throw new Error('/Users/someone/secret-path')
      }
    })
    const reply = await handleSyncRequest(service, { kind: 'enable', on: true })
    expect(JSON.stringify(reply)).not.toContain('secret-path')
  })
})

// ---------- « Sur l'iPhone »: the list of the command bar and the opening of a line ----------

const ROW: ResumeRow = { id: 'phone:t1', url: 'https://reading.example/article?token=abc', title: 'Article', host: 'reading.example', spaceId: 'sp-phone', lastActiveAt: 9 }
const SOURCE = { paired: true, categoryOnHere: true, announcedAt: 9, listAnnounced: true, sessionHappened: true, rows: [ROW] }
const STATE = { spaces: [{ id: 'sp-phone' }, { id: 'sp-screen' }], activeSpaceId: 'sp-screen' } as never

function resumePorts(over: { locked?: string[]; state?: unknown } = {}) {
  const dispatched: unknown[] = []
  return { dispatched, ports: { state: () => (over.state ?? STATE) as never, isSpaceLocked: (id: string) => (over.locked ?? []).includes(id), dispatch: (action: unknown) => void dispatched.push(action) } }
}
const source = (over: Partial<typeof SOURCE> = {}) => ({ resumeSource: () => ({ ...SOURCE, ...over }) })

describe('the list « Sur l\'iPhone » of the command bar', () => {
  it('gives the lines without their address or their space', () => {
    const { ports, dispatched } = resumePorts()
    const reply = handleSyncResume(source(), ports, { kind: 'list' })
    expect(reply).toEqual({ ok: true, view: { availability: 'list', lines: [{ id: 'phone:t1', title: 'Article', host: 'reading.example', lastActiveAt: 9 }], announcedAt: 9 } })
    expect(JSON.stringify(reply)).not.toContain('token')
    expect(JSON.stringify(reply)).not.toContain('sp-phone')
    expect(dispatched).toEqual([])
  })

  it('gives no line while the category is off here, or no iPhone is paired', () => {
    const { ports } = resumePorts()
    expect(handleSyncResume(source({ categoryOnHere: false }), ports, { kind: 'list' })).toMatchObject({ ok: true, view: { availability: 'disabled-here', lines: [] } })
    expect(handleSyncResume(source({ paired: false }), ports, { kind: 'list' })).toMatchObject({ ok: true, view: { availability: 'not-paired', lines: [] } })
  })

  it('opens the address the service holds, in the space the iPhone had it in', () => {
    const { ports, dispatched } = resumePorts()
    expect(handleSyncResume(source(), ports, { kind: 'open', id: 'phone:t1' }).ok).toBe(true)
    expect(dispatched).toEqual([{ type: 'tab/open', url: 'https://reading.example/article?token=abc', spaceId: 'sp-phone' }])
  })

  it('opens it in the space on screen when this Mac has no such space, or when it is locked', () => {
    for (const mac of [{ locked: ['sp-phone'] }, { state: { spaces: [{ id: 'sp-screen' }], activeSpaceId: 'sp-screen' } }]) {
      const { ports, dispatched } = resumePorts(mac)
      expect(handleSyncResume(source(), ports, { kind: 'open', id: 'phone:t1' }).ok).toBe(true)
      expect(dispatched).toEqual([{ type: 'tab/open', url: ROW.url, spaceId: 'sp-screen' }])
    }
  })

  it('opens nothing when both spaces are locked', () => {
    const { ports, dispatched } = resumePorts({ locked: ['sp-phone', 'sp-screen'] })
    expect(handleSyncResume(source(), ports, { kind: 'open', id: 'phone:t1' })).toEqual({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('opens nothing for a line that is not in the list, or while no list is shown', () => {
    const { ports, dispatched } = resumePorts()
    expect(handleSyncResume(source(), ports, { kind: 'open', id: 'phone:other' })).toEqual({ ok: false })
    expect(handleSyncResume(source({ categoryOnHere: false }), ports, { kind: 'open', id: 'phone:t1' })).toEqual({ ok: false })
    expect(handleSyncResume(source({ paired: false }), ports, { kind: 'open', id: 'phone:t1' })).toEqual({ ok: false })
    expect(dispatched).toEqual([])
  })

  it('opens no address that is not a web page, whatever the service holds', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/hosts', 'data:text/html,hi', 'ftp://files.example/', 'lucium-ui://extensions/']) {
      const { ports, dispatched } = resumePorts()
      expect(handleSyncResume(source({ rows: [{ ...ROW, url }] }), ports, { kind: 'open', id: 'phone:t1' })).toEqual({ ok: false })
      expect(dispatched, url).toEqual([])
    }
  })
})

describe('the channel of the list « Sur l\'iPhone »: who may ask', () => {
  it('refuses a sender the guard does not trust, a private window, a missing service and a request that is not one', () => {
    setSyncService({ resumeSource: () => SOURCE } as unknown as SyncService)
    const dispatched: unknown[] = []
    const dispatch = (action: unknown) => void dispatched.push(action)
    expect(windowSync({ trusted: false, state: STATE, dispatch }).resume({ kind: 'list' })).toEqual({ ok: false })
    expect(windowSync({ private: true, state: STATE, dispatch }).resume({ kind: 'list' })).toEqual({ ok: false })
    expect(windowSync({ state: STATE, dispatch }).resume({ kind: 'open', id: 'a b' })).toEqual({ ok: false })
    expect(windowSync({ state: STATE, dispatch }).resume({ kind: 'open', id: 'phone:t1', url: 'https://evil.example/' })).toEqual({ ok: false })
    expect(windowSync({ state: STATE, dispatch }).resume(null)).toEqual({ ok: false })
    expect(dispatched).toEqual([])
    setSyncService(null)
    expect(windowSync({ state: STATE, dispatch }).resume({ kind: 'list' })).toEqual({ ok: false })
  })

  it('answers the list and opens a line for a trusted sender in a normal window', () => {
    setSyncService({ resumeSource: () => SOURCE } as unknown as SyncService)
    const dispatched: unknown[] = []
    const w = windowSync({ state: STATE, dispatch: (action) => void dispatched.push(action) })
    expect(w.resume({ kind: 'list' })).toMatchObject({ ok: true, view: { availability: 'list' } })
    expect(w.resume({ kind: 'open', id: 'phone:t1' }).ok).toBe(true)
    expect(dispatched).toHaveLength(1)
  })
})
