// What a page reads of a permission nobody answered yet (permission-state.ts): "default" and "prompt" where Electron alone says "denied", and
// what Chromium says once somebody answered. Run on stand-ins of `Notification` and `PermissionStatus` shaped as Chromium's (accessors, the first
// on the constructor, the second on the prototype).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipcRenderer = { sendSync: vi.fn() }
vi.mock('electron', () => ({ ipcRenderer }))

const { mainWorldPermissionState, undecided } = await import('./permission-state')

const g = globalThis as Record<string, any>

/** A page at this protocol where Chromium answers `real` for every permission. `status(name)` is what `permissions.query` would resolve with. */
function page(protocol: string, real: { value: string }) {
  g['location'] = { protocol }
  class Notification {
    static get permission(): string {
      return real.value
    }
  }
  class PermissionStatus {
    readonly #name: string
    constructor(name: string) {
      this.#name = name
    }
    get name(): string {
      return this.#name
    }
    get state(): string {
      return real.value
    }
  }
  g['Notification'] = Notification
  g['PermissionStatus'] = PermissionStatus
  return { status: (name: string) => new PermissionStatus(name) }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  ipcRenderer.sendSync.mockReset()
})
afterEach(() => {
  delete g['Notification']
  delete g['PermissionStatus']
  delete g['location']
  vi.restoreAllMocks()
})

describe('what a page reads of a permission', () => {
  it('is "default" and "prompt" for a site nobody answered, where Chromium alone says "denied"', () => {
    const real = { value: 'denied' }
    const { status } = page('https:', real)
    const asked: string[] = []
    mainWorldPermissionState((name) => (asked.push(name), true))
    expect(g['Notification'].permission).toBe('default')
    expect(status('notifications').state).toBe('prompt')
    expect(status('camera').state).toBe('prompt')
    expect(asked).toEqual(['notifications', 'notifications', 'camera'])
  })

  it('is "denied" for a site the user refused: the browser says somebody answered', () => {
    const { status } = page('https:', { value: 'denied' })
    mainWorldPermissionState(() => false)
    expect(g['Notification'].permission).toBe('denied')
    expect(status('notifications').state).toBe('denied')
  })

  it('is what Chromium says once it is not "denied", and the browser is not even asked', () => {
    const real = { value: 'granted' }
    const { status } = page('https:', real)
    const ask = vi.fn(() => true)
    mainWorldPermissionState(ask)
    expect(g['Notification'].permission).toBe('granted')
    expect(status('notifications').state).toBe('granted')
    expect(ask).not.toHaveBeenCalled()
  })

  it('follows an answer given later: the same status object reads "prompt", then what was answered', () => {
    const real = { value: 'denied' }
    const { status } = page('https:', real)
    let answered = false
    mainWorldPermissionState(() => !answered)
    const kept = status('notifications')
    expect(kept.state).toBe('prompt')
    real.value = 'granted'
    answered = true
    expect(kept.state).toBe('granted')
    expect(g['Notification'].permission).toBe('granted')
  })

  it('leaves a page that is not of the web as it is (an extension, a local file)', () => {
    for (const protocol of ['chrome-extension:', 'file:', 'about:']) {
      const { status } = page(protocol, { value: 'denied' })
      const ask = vi.fn(() => true)
      mainWorldPermissionState(ask)
      expect(g['Notification'].permission, protocol).toBe('denied')
      expect(status('notifications').state, protocol).toBe('denied')
      expect(ask).not.toHaveBeenCalled()
    }
  })

  it('keeps the accessors where the page looks for them, as functions the page cannot tell from the native ones by their place', () => {
    page('https:', { value: 'denied' })
    mainWorldPermissionState(() => true)
    expect(typeof Object.getOwnPropertyDescriptor(g['Notification'], 'permission')!.get).toBe('function')
    expect(typeof Object.getOwnPropertyDescriptor(g['PermissionStatus'].prototype, 'state')!.get).toBe('function')
  })

  it('says why when the page cannot be given it, and does not stop the page', () => {
    page('https:', { value: 'denied' })
    Object.freeze(g['Notification'])
    expect(() => mainWorldPermissionState(() => true)).not.toThrow()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('the state of the permissions could not be set up'), expect.any(String))
    expect(g['Notification'].permission).toBe('denied')
  })
})

describe('the question the preload puts to the browser', () => {
  it('is asked for a permission the user is asked for, and true only when the browser says so', () => {
    ipcRenderer.sendSync.mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValueOnce('yes')
    expect(undecided('notifications')).toBe(true)
    expect(undecided('camera')).toBe(false)
    expect(undecided('geolocation')).toBe(false)
    expect(ipcRenderer.sendSync.mock.calls).toEqual([
      ['lucium-permission-undecided', 'notifications'],
      ['lucium-permission-undecided', 'camera'],
      ['lucium-permission-undecided', 'geolocation']
    ])
  })

  it('is not asked for any other name: the page reads what Chromium says', () => {
    expect(undecided('midi')).toBe(false)
    expect(undecided('constructor')).toBe(false)
    expect(ipcRenderer.sendSync).not.toHaveBeenCalled()
  })

  it('answers no, and says why, when the browser cannot be reached', () => {
    ipcRenderer.sendSync.mockImplementation(() => {
      throw new Error('channel closed')
    })
    expect(undecided('notifications')).toBe(false)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not be asked of the browser'), 'channel closed')
  })
})
