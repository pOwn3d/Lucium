import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EXTENSION_FRAME_MATCHES, ExtensionPreloads, LIBRARY_PRELOAD_IDS, readablePreloadPath, registerLimitedPreload, type ScriptedSession } from './extension-runtime'
import type { PreloadScriptRegistration } from './switched-preload'

class FakeSession implements ScriptedSession {
  scripts: PreloadScriptRegistration[] = []
  failOn = new Set<string>()
  /** An Electron that does not take `matches`. */
  refusesMatches = false
  registerPreloadScript(script: PreloadScriptRegistration): string {
    if (this.failOn.has(script.id)) throw new Error(`cannot register ${script.id}`)
    if (this.refusesMatches && script.matches) throw new Error('unknown option matches')
    this.scripts.push(script)
    return script.id
  }
  unregisterPreloadScript(id: string): void {
    this.scripts = this.scripts.filter((s) => s.id !== id)
  }
  getPreloadScripts() {
    return [...this.scripts]
  }
  ids = () => this.scripts.map((s) => s.id)
}

/** What ensureProfile does, in the order it does it: the library registers its two scripts when it is set up; ours wait. */
function setup(report = vi.fn()) {
  const ses = new FakeSession()
  ses.registerPreloadScript({ id: 'crx-mv2-preload', type: 'frame', filePath: '/lib/preload.js' })
  ses.registerPreloadScript({ id: 'crx-mv3-preload', type: 'service-worker', filePath: '/lib/preload.js' })
  const runtime = new ExtensionPreloads(
    ses,
    {
      before: () => void ses.registerPreloadScript({ id: 'shims-frame', type: 'frame', filePath: '/app/shims.js' }),
      after: () => void ses.registerPreloadScript({ id: 'patches-frame', type: 'frame', filePath: '/app/shims.js' })
    },
    'the test session',
    report
  )
  return { ses, runtime, report }
}

describe('the preload scripts of the extension runtime', () => {
  it('leaves a session with no script at all until an extension is about to be loaded there', () => {
    const { ses, runtime } = setup()
    expect(runtime.holdLibrary()).toEqual([])
    expect(ses.ids()).toEqual([])
    expect(runtime.active).toBe(false)
  })

  it('puts them in at the first load, in the order the shims need: ours, the library\'s, ours again', () => {
    const { ses, runtime } = setup()
    runtime.holdLibrary()
    runtime.activate()
    expect(ses.ids()).toEqual(['shims-frame', 'crx-mv2-preload', 'crx-mv3-preload', 'patches-frame'])
    expect(runtime.active).toBe(true)
    // The library's scripts come back as they were (same type, same file), the one of frames for the pages of extensions only.
    expect(ses.scripts[1]).toEqual({ id: 'crx-mv2-preload', type: 'frame', filePath: '/lib/preload.js', matches: ['chrome-extension://*/*'] })
    expect(ses.scripts[2]).toEqual({ id: 'crx-mv3-preload', type: 'service-worker', filePath: '/lib/preload.js' })
  })

  it('gives the script of frames to every page, as before, where Electron refuses to limit it, and says so', () => {
    const { ses, runtime, report } = setup()
    ses.refusesMatches = true
    runtime.holdLibrary()
    runtime.activate()
    expect(ses.ids()).toEqual(['shims-frame', 'crx-mv2-preload', 'crx-mv3-preload', 'patches-frame'])
    expect(ses.scripts[1]).toEqual({ id: 'crx-mv2-preload', type: 'frame', filePath: '/lib/preload.js' })
    expect(report).toHaveBeenCalledWith(expect.stringContaining('could not be limited to the pages of extensions'), expect.any(Error))
  })

  it('does it once, however many extensions are loaded', () => {
    const { ses, runtime } = setup()
    runtime.holdLibrary()
    runtime.activate()
    runtime.activate()
    runtime.activate()
    expect(ses.ids()).toEqual(['shims-frame', 'crx-mv2-preload', 'crx-mv3-preload', 'patches-frame'])
  })

  it('tells which library script it did not find, and leaves the ones it never held alone', () => {
    const ses = new FakeSession()
    ses.registerPreloadScript({ id: 'crx-mv2-preload', type: 'frame', filePath: '/lib/preload.js' })
    const runtime = new ExtensionPreloads(ses, { before: () => undefined, after: () => undefined }, 'x')
    expect(runtime.holdLibrary()).toEqual(['crx-mv3-preload'])
    runtime.activate()
    expect(ses.ids()).toEqual(['crx-mv2-preload'])
  })

  it('keeps a library script it could not take out where it is, and says so', () => {
    const report = vi.fn()
    const { ses, runtime } = setup(report)
    const real = ses.unregisterPreloadScript.bind(ses)
    ses.unregisterPreloadScript = (id) => {
      if (id === 'crx-mv3-preload') throw new Error('refused')
      real(id)
    }
    expect(runtime.holdLibrary()).toEqual(['crx-mv3-preload'])
    expect(report).toHaveBeenCalledTimes(1)
    expect(String(report.mock.calls[0]![0])).toContain('crx-mv3-preload')
    runtime.activate()
    // Not registered twice: it never left.
    expect(ses.ids().filter((id) => id === 'crx-mv3-preload')).toHaveLength(1)
  })

  it('reports a script that cannot be registered and still puts in the others', () => {
    const report = vi.fn()
    const { ses, runtime } = setup(report)
    runtime.holdLibrary()
    ses.failOn.add('crx-mv2-preload')
    runtime.activate()
    expect(report).toHaveBeenCalledTimes(1)
    expect(String(report.mock.calls[0]![0])).toContain('crx-mv2-preload')
    expect(ses.ids()).toEqual(['shims-frame', 'crx-mv3-preload', 'patches-frame'])
    expect(runtime.active).toBe(true)
  })

  it('reports a failing step and goes on with the rest', () => {
    const report = vi.fn()
    const ses = new FakeSession()
    const runtime = new ExtensionPreloads(
      ses,
      {
        before: () => {
          throw new Error('shims broken')
        },
        after: () => void ses.registerPreloadScript({ id: 'patches-frame', type: 'frame', filePath: '/app/shims.js' })
      },
      'the test session',
      report
    )
    runtime.activate()
    expect(report).toHaveBeenCalledTimes(1)
    expect(ses.ids()).toEqual(['patches-frame'])
  })
})

describe('the library\'s scripts in the packaged application (Chromium cannot read them inside app.asar)', () => {
  // Written by the path module of the system, as the library's own path is (with backslashes on Windows).
  const LIBRARY = join('node_modules', 'electron-chrome-extensions', 'dist', 'chrome-extension-api.preload.js')
  const PACKED = join('/Applications/Lucium.app/Contents/Resources', 'app.asar', LIBRARY)
  const UNPACKED = join('/Applications/Lucium.app/Contents/Resources', 'app.asar.unpacked', LIBRARY)

  it('are put back from the unpacked copy when the build unpacked them, and from where they were otherwise', () => {
    expect(readablePreloadPath(PACKED, (path) => path === UNPACKED)).toBe(UNPACKED)
    // A build that did not unpack the file: the library's own path, which the frames can still use.
    expect(readablePreloadPath(PACKED, () => false)).toBe(PACKED)
    // Outside a packaged application (development, the tests) nothing is looked for.
    const exists = vi.fn(() => true)
    const development = join('/repo', LIBRARY)
    expect(readablePreloadPath(development, exists)).toBe(development)
    expect(exists).not.toHaveBeenCalled()
  })

  it('are registered from the unpacked copy at the first load, the service worker\'s as the frame\'s', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'lucium-asar-')))
    try {
      const packed = join(root, 'app.asar', 'lib', 'preload.js')
      const unpacked = join(root, 'app.asar.unpacked', 'lib', 'preload.js')
      mkdirSync(dirname(unpacked), { recursive: true })
      writeFileSync(unpacked, '')
      const ses = new FakeSession()
      ses.registerPreloadScript({ id: 'crx-mv2-preload', type: 'frame', filePath: packed })
      ses.registerPreloadScript({ id: 'crx-mv3-preload', type: 'service-worker', filePath: packed })
      const runtime = new ExtensionPreloads(ses, { before: () => {}, after: () => {} }, 'the test session')
      runtime.holdLibrary()
      runtime.activate()
      expect(ses.scripts).toEqual([
        { id: 'crx-mv2-preload', type: 'frame', filePath: unpacked, matches: ['chrome-extension://*/*'] },
        { id: 'crx-mv3-preload', type: 'service-worker', filePath: unpacked }
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('what the extension library registers (the names this relies on)', () => {
  it('still gives its two preload scripts the ids that are held back', () => {
    const entry = createRequire(import.meta.url).resolve('electron-chrome-extensions')
    const source = readFileSync(entry, 'utf8')
    for (const id of LIBRARY_PRELOAD_IDS) expect(source, `electron-chrome-extensions no longer registers "${id}": update LIBRARY_PRELOAD_IDS (src/main/engine/extension-runtime.ts)`).toContain(`id: "${id}"`)
  })
})

describe('a script limited to some documents', () => {
  const limited = (): PreloadScriptRegistration => ({ id: 'lucium-shims-frame', type: 'frame', filePath: '/out/preload/extension-shims.js', matches: [...EXTENSION_FRAME_MATCHES] })

  it('is registered for the pages of extensions only', () => {
    const ses = new FakeSession()
    const refused = vi.fn()
    registerLimitedPreload(ses, limited(), refused)
    expect(ses.scripts).toEqual([{ id: 'lucium-shims-frame', type: 'frame', filePath: '/out/preload/extension-shims.js', matches: ['chrome-extension://*/*'] }])
    expect(refused).not.toHaveBeenCalled()
  })

  it('goes in every document, and says why, on an Electron that refuses the limit: the extensions keep their APIs', () => {
    const ses = new FakeSession()
    ses.refusesMatches = true
    const refused = vi.fn()
    registerLimitedPreload(ses, limited(), refused)
    expect(ses.scripts).toEqual([{ id: 'lucium-shims-frame', type: 'frame', filePath: '/out/preload/extension-shims.js' }])
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ message: 'unknown option matches' }))
  })

  it('throws as Electron does when the script cannot be registered at all, or has no limit to give up', () => {
    const ses = new FakeSession()
    ses.failOn.add('lucium-shims-frame')
    expect(() => registerLimitedPreload(ses, limited(), vi.fn())).toThrow('cannot register lucium-shims-frame')
    const { matches: _all, ...everywhere } = limited()
    expect(() => registerLimitedPreload(ses, everywhere, vi.fn())).toThrow('cannot register lucium-shims-frame')
  })
})
