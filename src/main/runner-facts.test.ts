// scripts/runner-facts.cjs runs inside Electron, which the unit tests do not start: it is loaded here against a stand-in of the `electron` module.

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const nodeModule = require('node:module') as { _load: (this: unknown, request: string, ...rest: unknown[]) => unknown }
const script = fileURLToPath(new URL('../../scripts/runner-facts.cjs', import.meta.url))

const display = { bounds: { x: 0, y: 0, width: 1024, height: 768 }, workArea: { x: 0, y: 31, width: 1024, height: 674 }, scaleFactor: 1 }

/** Loads the script with `electron` answered by the stand-in, and waits for what it does once the application is ready. */
async function load(electron: Record<string, unknown>): Promise<void> {
  const original = nodeModule._load
  nodeModule._load = function (this: unknown, request: string, ...rest: unknown[]) {
    return request === 'electron' ? electron : original.call(this, request, ...rest)
  }
  try {
    delete require.cache[script]
    require(script)
  } finally {
    nodeModule._load = original
  }
  await new Promise((resolve) => setTimeout(resolve, 10))
}

afterEach(() => vi.restoreAllMocks())

describe('scripts/runner-facts.cjs', () => {
  it('says what the screen and the animation settings are, then quits', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const app = { whenReady: () => Promise.resolve(), quit: vi.fn(), exit: vi.fn() }
    await load({
      app,
      screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display] },
      systemPreferences: { getAnimationSettings: () => ({ shouldRenderRichAnimation: false, scrollAnimationsEnabledBySystem: true, prefersReducedMotion: true }) }
    })
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      'runner-facts: screen 1024 x 768 at (0, 0), work area 1024 x 674, scale 1, 1 display(s)',
      'runner-facts: animations {"shouldRenderRichAnimation":false,"scrollAnimationsEnabledBySystem":true,"prefersReducedMotion":true}'
    ])
    expect(app.quit).toHaveBeenCalledOnce()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('fails with the reason when the machine cannot be read, instead of going on with no facts', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const app = { whenReady: () => Promise.resolve(), quit: vi.fn(), exit: vi.fn() }
    await load({
      app,
      screen: {
        getPrimaryDisplay: () => {
          throw new Error('no display')
        },
        getAllDisplays: () => []
      },
      systemPreferences: { getAnimationSettings: () => ({}) }
    })
    expect(error).toHaveBeenCalledWith('runner-facts: the machine cannot be read:', expect.objectContaining({ message: 'no display' }))
    expect(app.exit).toHaveBeenCalledWith(1)
    expect(app.quit).not.toHaveBeenCalled()
  })
})
