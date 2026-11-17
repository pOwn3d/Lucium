import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAGE_GUARD } from '../shared/page-guard'
import { guardWorld } from './guard-world'

// The preload runs in Electron's isolated world; here both worlds are plain Node.
const contextBridge = { executeInMainWorld: vi.fn() }
const ipcRenderer = { sendSync: vi.fn() }
vi.mock('electron', () => ({ contextBridge, ipcRenderer }))

const realType = Object.getOwnPropertyDescriptor(process, 'type')
/** Makes this process look like the one of a service worker, as Electron's preload sees it; the address is the one its main world answers. */
function asServiceWorker(address: string): void {
  Object.defineProperty(process, 'type', { value: 'service-worker', configurable: true })
  delete (globalThis as { location?: unknown }).location
  contextBridge.executeInMainWorld.mockImplementation((script: { func: unknown; args?: unknown[] }) => (script.args === undefined ? address : undefined))
}

async function load(): Promise<void> {
  vi.resetModules()
  await import('./page-guard')
}

beforeEach(() => {
  ;(globalThis as { location?: unknown }).location = { href: 'https://news.test/article' }
  contextBridge.executeInMainWorld.mockReset()
  ipcRenderer.sendSync.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  delete (globalThis as { location?: unknown }).location
  if (realType) Object.defineProperty(process, 'type', realType)
  else delete (process as { type?: unknown }).type
  vi.restoreAllMocks()
})

describe('the page guard preload', () => {
  it('asks the main process on its channel, and hands the answer to the main world', async () => {
    ipcRenderer.sendSync.mockReturnValue({ scriptlets: [{ id: 'abort-on-property-read', args: ['adsbygoogle'] }], fingerprint: { level: 'standard', seed: 7 } })
    await load()
    // The address of the document goes with the question: it is what this document is, whatever the main process last heard of the frame.
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith(PAGE_GUARD.plan, 'https://news.test/article')
    expect(contextBridge.executeInMainWorld).toHaveBeenCalledTimes(1)
    const call = contextBridge.executeInMainWorld.mock.calls[0]![0] as { func: unknown; args: Array<{ scriptlets: unknown[]; fingerprint: { seed: number; maxCores: number } }> }
    // The module is loaded again for each test, so the function is compared by its text, which is what Electron serializes.
    expect(String(call.func)).toBe(String(guardWorld))
    expect(call.args[0]!.scriptlets).toEqual([{ id: 'abort-on-property-read', args: ['adsbygoogle'] }])
    expect(call.args[0]!.fingerprint).toMatchObject({ seed: 7, maxCores: 8 })
  })

  it('does nothing at all when the main process has nothing for this page', async () => {
    for (const answer of [{ scriptlets: [], fingerprint: null }, undefined, null, 'x', 5, {}]) {
      contextBridge.executeInMainWorld.mockReset()
      ipcRenderer.sendSync.mockReturnValue(answer)
      await load()
      expect(contextBridge.executeInMainWorld, JSON.stringify(answer)).not.toHaveBeenCalled()
    }
  })

  it('reads the answer like a message from outside: a scriptlet that is not in the library, or a strength nobody defined, never reaches the page', async () => {
    ipcRenderer.sendSync.mockReturnValue({ scriptlets: [{ id: 'eval', args: ['alert(1)'] }, { id: 'set-constant', args: ['a', 'alert(1)'] }], fingerprint: { level: 'extreme', seed: 1, maxCores: 1 } })
    await load()
    expect(contextBridge.executeInMainWorld).not.toHaveBeenCalled()
  })

  it('only trusts the level of a configuration: its strength comes from the table, not from the message', async () => {
    ipcRenderer.sendSync.mockReturnValue({ scriptlets: [], fingerprint: { level: 'standard', seed: 3, maxCores: 1, canvasMaxPixels: 1e12, pixelsPerAlteration: 1 } })
    await load()
    const config = (contextBridge.executeInMainWorld.mock.calls[0]![0] as { args: Array<{ fingerprint: Record<string, number> }> }).args[0]!.fingerprint
    expect([config['maxCores'], config['canvasMaxPixels'], config['pixelsPerAlteration']]).toEqual([8, 1_048_576, 256])
  })

  it('runs the page unprotected, and says so on the console, when the question fails', async () => {
    ipcRenderer.sendSync.mockImplementation(() => {
      throw new Error('no channel')
    })
    await load()
    expect(contextBridge.executeInMainWorld).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not ask'), 'no channel')
  })

  it('in the service worker of a web site, asks with the address its main world reads, and hands over the answer', async () => {
    asServiceWorker('https://news.test/sw.js')
    ipcRenderer.sendSync.mockReturnValue({ scriptlets: [], fingerprint: { level: 'strict', seed: 9 } })
    await load()
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith(PAGE_GUARD.plan, 'https://news.test/sw.js')
    const handed = contextBridge.executeInMainWorld.mock.calls.filter(([script]) => (script as { args?: unknown[] }).args !== undefined)
    expect(handed).toHaveLength(1)
    expect((handed[0]![0] as { args: Array<{ fingerprint: { seed: number; maxCores: number } }> }).args[0]!.fingerprint).toMatchObject({ seed: 9, maxCores: 4 })
  })

  it('in the service worker of an extension, asks nothing: nobody listens there, and the worker would wait for ever', async () => {
    for (const address of ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/background.js', '']) {
      asServiceWorker(address)
      ipcRenderer.sendSync.mockReset()
      await load()
      expect(ipcRenderer.sendSync, address).not.toHaveBeenCalled()
    }
  })

  it('says so on the console when the main world cannot be reached', async () => {
    ipcRenderer.sendSync.mockReturnValue({ scriptlets: [{ id: 'abort-on-property-read', args: ['a'] }], fingerprint: null })
    contextBridge.executeInMainWorld.mockImplementation(() => {
      throw new Error('no main world')
    })
    await load()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not be installed'), 'no main world')
  })
})

// A sandboxed preload cannot require another file: whatever it imports is bundled into it, and a shared chunk (the bundler makes one for a
// module two entries import) is a file it cannot load. The page guard therefore imports only a few leaf modules, and this lists them.
describe('what the page guard preload is made of', () => {
  const sourceDir = fileURLToPath(new URL('..', import.meta.url))
  const imports = (file: string): string[] => [...readFileSync(file, 'utf8').matchAll(/^import(?!\s+type\b)[^'"]*from\s+['"](\.[^'"]+)['"]/gm)].map((m) => join(dirname(file), `${m[1]}.ts`))

  function closure(entry: string): string[] {
    const seen = new Set<string>()
    const walk = (file: string): void => {
      if (seen.has(file)) return
      seen.add(file)
      for (const next of imports(file)) walk(next)
    }
    walk(entry)
    return [...seen].map((file) => relative(sourceDir, file)).sort()
  }

  it('imports nothing but leaf modules, so that the bundle needs no shared chunk', () => {
    expect(closure(join(sourceDir, 'preload', 'page-guard.ts'))).toEqual(['preload/guard-world.ts', 'preload/page-guard.ts', 'shared/fingerprint-levels.ts', 'shared/page-guard.ts', 'shared/scriptlets.ts'])
  })

  it('has leaf modules that import nothing at run time', () => {
    for (const leaf of ['shared/fingerprint-levels.ts', 'shared/scriptlets.ts', 'preload/guard-world.ts']) expect(imports(join(sourceDir, leaf)), leaf).toEqual([])
  })
})
