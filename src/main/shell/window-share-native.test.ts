import { describe, expect, it, vi } from 'vitest'
import { loadNativeAccess } from './window-share-native'

describe('the native calls of the passage mode', () => {
  it('are not loaded off macOS, and nothing is sent there', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    try {
      await expect(loadNativeAccess()).rejects.toThrow('macOS')
    } finally {
      platform.mockRestore()
    }
  })
})

// koffi replaced: each library hands back recorders of its calls, a symbol is a token naming it, and a pointer read from a symbol names it too.
const ffi = vi.hoisted(() => ({ calls: [] as Array<{ name: string; args: unknown[] }> }))
vi.mock('koffi', () => {
  const decode = (pointer: { symbol: string }) => ({ value: pointer.symbol })
  const load = () => ({
    func: (definition: string) => {
      const name = /(\w+)\(/.exec(definition)?.[1] ?? definition
      return (...args: unknown[]) => {
        ffi.calls.push({ name, args })
        return name === 'CFDictionaryCreateMutable' ? { dictionary: true } : name === 'CFStringCreateWithCString' ? { made: args[1] } : name === 'AXIsProcessTrustedWithOptions' ? false : null
      }
    },
    symbol: (name: string) => ({ symbol: name })
  })
  return { load, decode, struct: () => undefined }
})

describe('the request for the Accessibility permission', () => {
  // Guard: macOS reads the option with its own constant. In a dictionary with NULL callbacks (keys compared by pointer), a key made from the text
  // « AXTrustedCheckOptionPrompt » was never found: the system did not ask, and the passage mode always ended on the note « accessibility ».
  it('puts the system’s constant in a dictionary of CF objects, so that macOS finds the option and asks', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      const access = await loadNativeAccess()
      ffi.calls.length = 0
      access.trusted(true)
      const create = ffi.calls.find((call) => call.name === 'CFDictionaryCreateMutable')!
      expect(create.args.slice(2)).toEqual([{ symbol: 'kCFTypeDictionaryKeyCallBacks' }, { symbol: 'kCFTypeDictionaryValueCallBacks' }])
      const set = ffi.calls.find((call) => call.name === 'CFDictionarySetValue')!
      expect(set.args[1]).toEqual({ value: 'kAXTrustedCheckOptionPrompt' })
      expect(set.args[2]).toEqual({ value: 'kCFBooleanTrue' })
      expect(ffi.calls.find((call) => call.name === 'AXIsProcessTrustedWithOptions')!.args[0]).toEqual({ dictionary: true })
    } finally {
      platform.mockRestore()
    }
  })

  it('asks nothing without the prompt', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      const access = await loadNativeAccess()
      ffi.calls.length = 0
      access.trusted(false)
      expect(ffi.calls.map((call) => call.name)).toEqual(['AXIsProcessTrustedWithOptions'])
      expect(ffi.calls[0]!.args).toEqual([null])
    } finally {
      platform.mockRestore()
    }
  })
})
