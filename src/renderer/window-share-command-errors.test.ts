// @vitest-environment happy-dom
// The command window of the annotated share, its script run against its own page: what it says and writes when a request to the main process fails.
// Before, nothing was caught: the button did nothing, the status line kept its last sentence (« Partage en cours » after a stop that had failed), and
// nothing reached the log of the main process.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { ShareState, WindowShareApi } from '@shared/window-share'
import commandHtml from './window-share-command.html?raw'

const IDLE: ShareState = { sharing: null, missing: false, pass: false, passNote: null, shortcut: 'on', hidden: false, blank: false }
const SHARING: ShareState = { ...IDLE, sharing: { id: 'window:1', name: 'Notes' } }
const gone = (): Promise<never> => Promise.reject(new Error('the main process did not answer'))

let api: { [K in keyof WindowShareApi]: ReturnType<typeof vi.fn<WindowShareApi[K]>> }
let tell: (state: ShareState) => void = () => undefined
let logged: ReturnType<typeof vi.spyOn>

/** The page with its script run, as the window loads it. */
async function page(): Promise<void> {
  document.body.innerHTML = /<main[\s\S]*<\/main>/.exec(commandHtml)![0]
  ;(window as unknown as { luciumShare: unknown }).luciumShare = api
  vi.resetModules()
  await import('./window-share-command')
  await turn()
}

const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const status = (): string => document.getElementById('window-share-status')!.textContent ?? ''
const press = async (id: string): Promise<void> => {
  document.getElementById(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await turn()
}
const FAILED = (): string => t('window-share.demande-echouee')

beforeEach(() => {
  setLanguage('fr')
  // The document of the tests has no `Option` constructor, which the script builds the list of the windows with: the same element, made the long way.
  vi.stubGlobal('Option', function (text: string, value: string) {
    const option = document.createElement('option')
    option.textContent = text
    option.value = value
    return option
  })
  logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  api = {
    list: vi.fn(async () => ({ ok: true as const, windows: [{ id: 'window:1', name: 'Notes' }] })),
    start: vi.fn(async () => ({ ok: true as const })),
    stop: vi.fn(async () => undefined),
    onState: vi.fn((listener: (state: ShareState) => void) => {
      tell = listener
      return () => undefined
    }),
    setBrush: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    setPass: vi.fn(async () => undefined),
    setShortcut: vi.fn(async () => undefined)
  } as never
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('a request of the command window that fails', () => {
  it('is said and logged when the windows cannot be listed', async () => {
    api.list.mockImplementation(gone)
    await page()
    expect(status()).toBe(FAILED())
    expect(logged).toHaveBeenCalledWith('[ui] the command window of the share: the list of the windows failed:', expect.stringContaining('the main process did not answer'))
  })

  it('does not say « Partage arrêté » for a stop that failed', async () => {
    api.stop.mockImplementation(gone)
    await page()
    tell(SHARING)
    await press('window-share-toggle')
    expect(api.stop).toHaveBeenCalledTimes(1)
    expect(status()).toBe(FAILED())
    expect(logged).toHaveBeenCalledWith('[ui] the command window of the share: the stop failed:', expect.any(String))
  })

  it('says « Partage arrêté » once the stop was done', async () => {
    await page()
    tell(SHARING)
    await press('window-share-toggle')
    expect(status()).toBe(t('window-share.arrete'))
  })

  it('is said when the share cannot be started', async () => {
    api.start.mockImplementation(gone)
    await page()
    tell(IDLE)
    await press('window-share-toggle')
    expect(api.start).toHaveBeenCalledWith('window:1')
    expect(status()).toBe(FAILED())
  })

  it('is said for the passage mode, a tool, an edit and the switch of the shortcut', async () => {
    for (const name of ['setPass', 'setBrush', 'edit', 'setShortcut'] as const) api[name].mockImplementation(gone)
    await page()
    const tries: Array<[string, () => Promise<void>]> = [
      ['the passage mode', () => press('window-share-mode-pass')],
      ['the brush', async () => {
        document.querySelector<HTMLButtonElement>('#window-share-tools button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await turn()
      }],
      ['the edit undo', () => press('window-share-undo')],
      ['the shortcut of the passage', async () => {
        document.getElementById('window-share-shortcut')!.dispatchEvent(new Event('change', { bubbles: true }))
        await turn()
      }]
    ]
    for (const [what, run] of tries) {
      tell(SHARING)
      expect(status(), what).not.toBe(FAILED())
      await run()
      expect(status(), what).toBe(FAILED())
      expect(logged, what).toHaveBeenCalledWith(`[ui] the command window of the share: ${what} failed:`, expect.any(String))
    }
  })
})

describe('an error of the page that nothing caught', () => {
  it('is written to the console as a `[ui]` line, which the main process relays to its log', async () => {
    await page()
    logged.mockClear()
    const event = new Event('unhandledrejection')
    Object.defineProperty(event, 'reason', { value: new Error('lost') })
    window.dispatchEvent(event)
    expect(logged).toHaveBeenCalledWith('[ui] a promise was rejected and nothing handled it:', expect.stringContaining('lost'))
  })
})
