// The request of the user-script manager: the setting is read at each request, and with the manager switched off the file of the scripts is
// not opened, whatever is asked. The real handler of the feature IPC runs; the manager is a stand-in that counts what is asked of it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { t } from '@shared/i18n'

const manager = vi.hoisted(() => ({ list: vi.fn(() => [{ id: 'us-1' }]), sourceOf: vi.fn(() => 'code'), asked: vi.fn() }))
vi.mock('../userscripts', () => ({
  userScripts: () => {
    manager.asked()
    return manager
  },
  readScriptFile: () => null
}))
vi.mock('electron', () => new Proxy({ app: { getPath: () => '/nonexistent', getAppPath: () => '/nonexistent' }, BrowserWindow: { fromWebContents: () => null } } as Record<string, unknown>, { get: (target, name: string) => (name in target ? target[name] : {}) }))

const { registerFeatureIpc } = await import('./feature-ipc')

beforeEach(() => vi.clearAllMocks())

/** The handler of the channel as the window registered it, over a state whose switch is `settings.userScripts`. */
function handler(settings: { userScripts: boolean }) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc = { on: (channel: string, run: never) => void handlers.set(channel, run), handle: (channel: string, run: never) => void handlers.set(channel, run) }
  const browser = new Proxy({ isPrivate: () => false }, { get: (target, name) => (name in target ? (target as Record<string | symbol, unknown>)[name] : () => undefined) })
  const state = { settings, spaces: [] }
  registerFeatureIpc(ipc as never, () => true, browser as never, { get: () => state } as never, {} as never)
  return { ask: (request: unknown) => handlers.get(Channel.userScripts)!({ sender: {} }, request) as Promise<{ ok: boolean; message?: string; scripts: unknown[] }>, state }
}

describe('the user-script requests while the manager is switched off', () => {
  it('open no file and list nothing, whatever the request', async () => {
    const { ask } = handler({ userScripts: false })
    for (const request of [{ kind: 'list' }, { kind: 'source', id: 'us-000000000000' }, { kind: 'add', text: '// ==UserScript==\n// ==/UserScript==\n' }, { kind: 'bad' }, 'nonsense']) {
      expect(await ask(request), JSON.stringify(request)).toEqual({ ok: false, message: t('userscripts-service.les-scripts-utilisateur-sont-desactives'), scripts: [] })
    }
    expect(manager.asked).not.toHaveBeenCalled()
    expect(manager.list).not.toHaveBeenCalled()
  })

  it('answer again as soon as the switch is on, because the setting is read at each request', async () => {
    const { ask, state } = handler({ userScripts: false })
    expect((await ask({ kind: 'list' })).ok).toBe(false)
    state.settings.userScripts = true
    expect(await ask({ kind: 'list' })).toMatchObject({ ok: true, scripts: [{ id: 'us-1' }] })
    expect(manager.list).toHaveBeenCalled()
    state.settings.userScripts = false
    manager.list.mockClear()
    expect((await ask({ kind: 'list' })).scripts).toEqual([])
    expect(manager.list).not.toHaveBeenCalled()
  })
})
