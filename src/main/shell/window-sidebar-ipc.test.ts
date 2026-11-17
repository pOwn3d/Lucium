// The channel of « Barre de cette fenêtre » (Channel.windowSidebar): the interface of a window asks its own browser to dock its sidebar or to choose its side.
// The interface is not trusted: a message from a surface the guard refuses, or of a shape that is none of the four changes, changes nothing. The tooltip of a
// tile of a column docked at the right opens to the left of it, on the page.

import { describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
vi.mock('./window-manager-holder', () => ({ getWindowManager: () => ({}) }))
const { registerUsageIpc } = await import('./usage-ipc')

function wired(trusted: boolean) {
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  const ipc = { on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => void listeners.set(channel, listener), handle: () => {} }
  const changes: unknown[] = []
  const browser = { changeWindowSidebar: (change: unknown) => void changes.push(change), closeOverlay: () => {} }
  registerUsageIpc(ipc as never, () => trusted, browser as never, { get: () => ({ settings: {} }) } as never, {} as never)
  const send = (raw: unknown) => listeners.get(Channel.windowSidebar)!({ sender: {} }, raw)
  return { send, changes }
}

describe('the channel of the sidebar of a window', () => {
  it('hands the four changes to the browser of the window that sent them', () => {
    const { send, changes } = wired(true)
    send({ op: 'dock', docked: true })
    send({ op: 'toggle-dock' })
    send({ op: 'side', side: null })
    send({ op: 'toggle-side' })
    expect(changes).toEqual([{ op: 'dock', docked: true }, { op: 'toggle-dock' }, { op: 'side', side: null }, { op: 'toggle-side' }])
  })

  it('refuses a change of another shape, whole, and says so in the log', () => {
    const { send, changes } = wired(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    send({ op: 'side', side: 'top' })
    send({ op: 'settings/update', patch: { sidebarRight: true } })
    send('dock')
    expect(changes).toEqual([])
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  it('does nothing for a surface the guard refuses (not one of the window, or the application locked)', () => {
    const { send, changes } = wired(false)
    send({ op: 'dock', docked: true })
    expect(changes).toEqual([])
  })
})
