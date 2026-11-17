import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceleratorFromKeyEvent } from '@shared/keybindings'
import { readKeyboardLayout, reportKeyboardLayout } from './keyboard-layout'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the keyboard layout read for the recording of a shortcut', () => {
  it('says what a key gives alone, so that ⌥⌘A on a French keyboard is recorded with A', async () => {
    const layout = await readKeyboardLayout({ keyboard: { getLayoutMap: async () => new Map([['KeyQ', 'a']]) } })
    expect(layout?.('KeyQ')).toBe('a')
    expect(layout?.('KeyP')).toBeUndefined()
    expect(acceleratorFromKeyEvent({ code: 'KeyQ', key: 'æ', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }, 'darwin', layout)).toBe('CmdOrCtrl+Alt+A')
  })

  it('is absent, without a word, where the engine does not give it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(readKeyboardLayout({})).resolves.toBeUndefined()
    await expect(readKeyboardLayout({ keyboard: {} })).resolves.toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('is absent when the engine fails to read it, and the failure is written in the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = { keyboard: { getLayoutMap: () => Promise.reject(new DOMException('refused', 'SecurityError')) } }
    await expect(readKeyboardLayout(failing)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the keyboard layout could not be read'), 'SecurityError')
  })
})

describe('the keyboard layout the window sends to the shell', () => {
  const french = { keyboard: { getLayoutMap: async () => new Map([['KeyQ', 'a'], ['KeyA', 'q']]) } }
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('is sent each time the window gets the focus, and not when it loses it', async () => {
    const sent: Array<Record<string, string>> = []
    let tell: (focused: boolean) => void = () => {}
    const stopped = vi.fn()
    const stop = reportKeyboardLayout((characters) => sent.push(characters), (listener) => ((tell = listener), stopped), french)
    tell(true)
    await settled()
    expect(sent).toEqual([{ KeyQ: 'a', KeyA: 'q' }])
    tell(false)
    await settled()
    expect(sent).toHaveLength(1)
    tell(true)
    await settled()
    expect(sent).toHaveLength(2)
    stop()
    expect(stopped).toHaveBeenCalledOnce()
  })

  it('sends nothing when the layout cannot be read, or is empty', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sent: unknown[] = []
    for (const source of [{}, { keyboard: { getLayoutMap: () => Promise.reject(new Error('refused')) } }, { keyboard: { getLayoutMap: async () => new Map<string, string>() } }]) {
      reportKeyboardLayout((characters) => sent.push(characters), (listener) => (listener(true), () => {}), source)
    }
    await settled()
    expect(sent).toEqual([])
  })
})
