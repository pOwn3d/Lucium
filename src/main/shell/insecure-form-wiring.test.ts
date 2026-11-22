// The form guard in the shell: the setting gives the engine a question (and takes it away when it goes off), and the question puts the box over the window
// that holds the page. The box itself is tested on a stand-in of the system dialog. The methods run on a stand-in (browser-fake.test-support.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

const showMessageBox = vi.fn()
vi.mock('electron', () => ({ dialog: { showMessageBox }, BrowserWindow: class {} }))
vi.mock('../blocking', () => ({ blockingService: () => ({ configure: vi.fn(), verdict: vi.fn(() => false), noteStopped: vi.fn(), resetPageCount: vi.fn() }) }))
const { Browser } = await import('./browser')
const { askInsecureForm } = await import('./insecure-form-box')
const shell = methodsOf(Browser.prototype)

type Ask = (request: { host: string; pageId?: string }) => Promise<boolean>
const mainWindow = { name: 'main' }
const otherWindow = { name: 'other' }

function windowWith(patch: Partial<Settings>) {
  const state = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), ...patch } }
  const other = { win: otherWindow }
  return fakeBrowser({ store: { get: () => state }, win: mainWindow, extraBlockedHosts: [], containerScopes: new Map(), privateScope: null, ownerOf: (id: string) => (id === 'tab-elsewhere' ? other : undefined), configureFormGuard: shell['configureFormGuard'] })
}
const given = (fake: ReturnType<typeof windowWith>): unknown[] => fake.calls.filter((call) => call.name === 'engine.setInsecureFormGuard').map((call) => call.args[0])

beforeEach(() => showMessageBox.mockReset())

describe('the setting of the form guard', () => {
  it('gives the engine a question while it is on, and null while it is off', () => {
    const on = windowWith({ warnInsecureForm: true })
    shell['configureFormGuard']!.call(on.self)
    expect(given(on)).toEqual([expect.any(Function)])
    const off = windowWith({ warnInsecureForm: false })
    shell['configureFormGuard']!.call(off.self)
    expect(given(off)).toEqual([null])
  })

  it('is given to the engine whenever the blocker is configured (the setting changes through it)', () => {
    const fake = windowWith({ warnInsecureForm: true })
    shell['configureBlocker']!.call(fake.self)
    expect(given(fake)).toHaveLength(1)
  })

  it('puts the box over the window that holds the page, and over the main window for a page that is no tab', async () => {
    showMessageBox.mockResolvedValue({ response: 0 })
    const fake = windowWith({ warnInsecureForm: true })
    shell['configureFormGuard']!.call(fake.self)
    const ask = given(fake)[0] as Ask
    await ask({ host: 'pay.example.net', pageId: 'tab-elsewhere' })
    await ask({ host: 'pay.example.net', pageId: 'popup-1' })
    await ask({ host: 'pay.example.net' })
    expect(showMessageBox.mock.calls.map((call) => call[0])).toEqual([otherWindow, mainWindow, mainWindow])
  })
})

describe('the box before a password goes to an http address', () => {
  it('sends only when « Envoyer quand même » is clicked: « Annuler » is the default and the one Escape presses', async () => {
    showMessageBox.mockResolvedValue({ response: 1 })
    expect(await askInsecureForm(null, 'pay.example.net')).toBe(true)
    const options = showMessageBox.mock.calls[0]![0] as { buttons: string[]; defaultId: number; cancelId: number; detail: string }
    expect([options.defaultId, options.cancelId]).toEqual([0, 0])
    expect(options.buttons).toHaveLength(2)
    expect(options.detail).toContain('pay.example.net')
    showMessageBox.mockResolvedValue({ response: 0 })
    expect(await askInsecureForm(null, 'pay.example.net')).toBe(false)
  })

  it('is a sheet of the window it is given, and a box of its own without one', async () => {
    showMessageBox.mockResolvedValue({ response: 0 })
    await askInsecureForm(mainWindow as never, 'pay.example.net')
    await askInsecureForm(null, 'pay.example.net')
    expect(showMessageBox.mock.calls[0]).toHaveLength(2)
    expect(showMessageBox.mock.calls[1]).toHaveLength(1)
  })

  it('names the host, cut short, and never an address', async () => {
    showMessageBox.mockResolvedValue({ response: 0 })
    await askInsecureForm(null, 'h'.repeat(500))
    const detail = (showMessageBox.mock.calls[0]![0] as { detail: string }).detail
    expect(detail.length).toBeLessThan(500)
    expect(detail).not.toContain('://')
  })
})
