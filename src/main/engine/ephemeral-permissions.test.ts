// The permissions of a private context (ephemeral-scope.ts `setPermissionPolicy`): the engine names a page of the context by its id in the engine
// (`ephemeral:<n>/<id>`), the shell by its own id, and the policy the shell gave is asked with the shell's. A private window used to find no panel for its
// own tab: the question went to a sheet of the system, and the answer was not kept in the window's memory. The engine checks replay it in a private
// window (smoke-windows.ts, smoke-runtime.ts).

import { describe, expect, it, vi } from 'vitest'
import type { PermissionPolicy } from './types'
import type { ElectronEngine, Scope } from './electron-engine'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub({ session: {}, app: { getPath: () => '/tmp' }, net: {}, dialog: {} }))

const { EphemeralScope } = await import('./ephemeral-scope')

function privateContext(): { scope: Scope; policy: () => PermissionPolicy; asked: Array<string | undefined>; panels: string[]; install: (withPanel?: boolean) => void } {
  const scope = { key: 'ephemeral:3', prefix: 'ephemeral:3/', policy: null } as unknown as Scope
  const handle = new EphemeralScope({} as ElectronEngine, scope)
  const asked: Array<string | undefined> = []
  const panels: string[] = []
  const install = (withPanel = true) =>
    handle.setPermissionPolicy({
      lookup: (origin, permission) => (origin === 'https://a.example' && permission === 'geolocation' ? 'deny' : undefined),
      ask: (_origin, _permission, pageId) => (asked.push(pageId), Promise.resolve(true)),
      ...(withPanel ? { hasPanel: (pageId: string) => (panels.push(pageId), pageId === 'tab-1') } : {}),
      screenShareAllowed: () => false
    })
  return { scope, policy: () => scope.policy!, asked, panels, install }
}

describe('the permission policy of a private context', () => {
  it('finds the panel of a tab of the private window, named by its id in the engine', () => {
    const context = privateContext()
    context.install()
    expect(context.policy().hasPanel!('ephemeral:3/tab-1')).toBe(true)
    expect(context.panels).toEqual(['tab-1'])
  })

  it('asks the window with the id the shell gave the page, so that the question goes with the page', async () => {
    const context = privateContext()
    context.install()
    await context.policy().ask('https://a.example', 'geolocation', 'ephemeral:3/tab-1')
    await context.policy().ask('https://a.example', 'geolocation')
    expect(context.asked).toEqual(['tab-1', undefined])
  })

  it('never hands the window a page of another context, and keeps what the policy answers', () => {
    const context = privateContext()
    context.install()
    expect(context.policy().hasPanel!('ephemeral:30/tab-1')).toBe(false)
    expect(context.panels).toEqual([])
    expect(context.policy().lookup('https://a.example', 'geolocation')).toBe('deny')
    expect(context.policy().screenShareAllowed()).toBe(false)
  })

  it('gives no panel test to a policy that has none (every page then has a panel)', () => {
    const context = privateContext()
    context.install(false)
    expect(context.policy().hasPanel).toBeUndefined()
  })
})
