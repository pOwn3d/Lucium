import { describe, expect, it, vi } from 'vitest'

// The module imports Electron for its default host only: a test gives its own.
vi.mock('electron', () => ({ globalShortcut: { register: () => true, unregister: () => undefined } }))

const { LittleShortcut } = await import('./little-shortcut')

function fakeHost(taken: string[] = []) {
  const held = new Map<string, () => void>()
  return {
    held,
    register: (accelerator: string, callback: () => void) => {
      if (taken.includes(accelerator)) return false
      held.set(accelerator, callback)
      return true
    },
    unregister: (accelerator: string) => void held.delete(accelerator)
  }
}

describe('LittleShortcut', () => {
  it('holds the command’s shortcut system-wide while the setting is on, and runs the action when it is pressed', () => {
    const host = fakeHost()
    const press = vi.fn()
    const shortcut = new LittleShortcut(press, host)
    expect(shortcut.sync(true, 'CmdOrCtrl+Alt+N')).toBe(true)
    host.held.get('CmdOrCtrl+Alt+N')!()
    expect(press).toHaveBeenCalledTimes(1)
  })

  it('lets go when the setting goes off, and when the command has no shortcut', () => {
    const host = fakeHost()
    const shortcut = new LittleShortcut(() => undefined, host)
    shortcut.sync(true, 'CmdOrCtrl+Alt+N')
    expect(shortcut.sync(false, 'CmdOrCtrl+Alt+N')).toBe(false)
    expect(host.held.size).toBe(0)
    shortcut.sync(true, 'CmdOrCtrl+Alt+N')
    expect(shortcut.sync(true, undefined)).toBe(false)
    expect(host.held.size).toBe(0)
  })

  it('follows the shortcut the user gave the command', () => {
    const host = fakeHost()
    const shortcut = new LittleShortcut(() => undefined, host)
    shortcut.sync(true, 'CmdOrCtrl+Alt+N')
    shortcut.sync(true, 'CmdOrCtrl+Alt+L')
    expect([...host.held.keys()]).toEqual(['CmdOrCtrl+Alt+L'])
  })

  it('does not register twice for the same state', () => {
    const host = fakeHost()
    const register = vi.spyOn(host, 'register')
    const shortcut = new LittleShortcut(() => undefined, host)
    shortcut.sync(true, 'CmdOrCtrl+Alt+N')
    shortcut.sync(true, 'CmdOrCtrl+Alt+N')
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('says nothing is held when another application owns the combination', () => {
    const host = fakeHost(['CmdOrCtrl+Alt+N'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const shortcut = new LittleShortcut(() => undefined, host)
    expect(shortcut.sync(true, 'CmdOrCtrl+Alt+N')).toBe(false)
    expect(shortcut.held()).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('taken by another application'))
    warn.mockRestore()
  })

  it('lets go of everything on stop', () => {
    const host = fakeHost()
    const shortcut = new LittleShortcut(() => undefined, host)
    shortcut.sync(true, 'CmdOrCtrl+Alt+N')
    shortcut.stop()
    expect(host.held.size).toBe(0)
  })
})
