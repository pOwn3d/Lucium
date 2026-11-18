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
import { handleSyncRequest, registerSyncIpc } from './sync-ipc'

type Handler = (event: { sender: object }, raw: unknown) => Promise<SyncReply>

const STATUS: SyncStatus = { available: true, enabled: false, categories: { structure: true, settings: false, archive: false, openTabs: false }, window: { open: false, remainingMs: 0 }, pairing: null, confirm: null, devices: [], identityReplaced: false, justPaired: null, problem: null }

/** A service that records what it is asked, and answers the state it was given. */
function fakeService(over: Partial<Record<keyof SyncService, unknown>> = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const record = (name: string) => (...args: unknown[]) => void calls.push([name, ...args])
  const service = {
    status: () => STATUS,
    setEnabled: async (on: boolean) => record('setEnabled')(on),
    setCategory: record('setCategory'),
    openWindow: async () => record('openWindow')(),
    prolong: record('prolong'),
    closeWindow: async (reason: string) => record('closeWindow')(reason),
    startPairing: async () => record('startPairing')(),
    closePairing: record('closePairing'),
    answer: record('answer'),
    forget: record('forget'),
    leave: async () => record('leave')(),
    ...over
  } as unknown as SyncService
  return { service, calls }
}

function windowSync(options: { trusted?: boolean; private?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const ipc: ScopedIpc = { on: () => undefined, handle: (channel, listener) => void handlers.set(channel, listener as unknown as Handler) }
  const guard = vi.fn(() => options.trusted ?? true)
  registerSyncIpc(ipc, guard, { isPrivate: () => options.private === true } as never)
  const sender = {}
  return { guard, sender, ask: (raw: unknown) => handlers.get(Channel.syncRequest)!({ sender }, raw) }
}

afterEach(() => {
  setSyncService(null)
  vi.restoreAllMocks()
})

describe('the channel of the synchronisation page: who may ask', () => {
  it('registers one channel, on the name the interface sends to', () => {
    const handlers: string[] = []
    registerSyncIpc({ on: () => undefined, handle: (channel) => void handlers.push(channel) }, () => true, { isPrivate: () => false } as never)
    expect(handlers).toEqual(['lucium:sync'])
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
    [{ kind: 'open-window' }, [['openWindow']]],
    [{ kind: 'prolong' }, [['prolong']]],
    [{ kind: 'close-window' }, [['closeWindow', 'manual']]],
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
      openWindow: async () => {
        throw new SyncServiceError(problem, 'x')
      }
    })
    const reply = await handleSyncRequest(service, { kind: 'open-window' })
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
