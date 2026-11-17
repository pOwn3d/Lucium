// Which setting drives what: « Apparence de Lucium » (`interfaceAppearance`) is the only one that moves `nativeTheme.themeSource`, which is global in Electron
// (it turned the Settings and the sidebar dark while macOS was light when it was driven by the appearance asked of the websites); « Apparence demandée aux sites »
// (`websiteAppearance`) goes to the pages, and to nothing else.

import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { followAppearance, type ThemeHost } from './appearance'
import { posix } from '../windows.test-support'

function app(start: Partial<Pick<Settings, 'interfaceAppearance' | 'websiteAppearance'>> = {}) {
  const settings = { interfaceAppearance: 'auto' as Settings['interfaceAppearance'], websiteAppearance: 'auto' as Settings['websiteAppearance'], ...start }
  const listeners: Array<() => void> = []
  const writes: string[] = []
  let source: ThemeHost['themeSource'] = 'system'
  const theme: ThemeHost = {
    get themeSource() {
      return source
    },
    set themeSource(next) {
      writes.push(next)
      source = next
    }
  }
  const schemes: Array<'light' | 'dark' | null> = []
  const engine = { setPageColorScheme: vi.fn((scheme: 'light' | 'dark' | null) => void schemes.push(scheme)) }
  followAppearance({ get: () => ({ settings }), subscribe: (listener) => void listeners.push(listener) }, theme, engine)
  const change = (patch: Partial<typeof settings>): void => {
    Object.assign(settings, patch)
    for (const listener of listeners) listener()
  }
  return { theme, writes, schemes, change }
}

describe('Lucium’s appearance drives nativeTheme, and only that setting does', () => {
  it('is the system’s for Automatique, the forced one otherwise', () => {
    const light = app({ interfaceAppearance: 'light' })
    expect(light.theme.themeSource).toBe('light')
    const dark = app({ interfaceAppearance: 'dark' })
    expect(dark.theme.themeSource).toBe('dark')
    const auto = app()
    expect(auto.theme.themeSource).toBe('system')
    expect(auto.writes).toEqual([])
  })

  // THE GUARD of the bug of 0.2.14: a website appearance of Sombre must not turn the interface dark while macOS is light.
  it('does not follow the appearance asked of the websites', () => {
    const { theme, change } = app()
    change({ websiteAppearance: 'dark' })
    expect(theme.themeSource).toBe('system')
    change({ websiteAppearance: 'light' })
    expect(theme.themeSource).toBe('system')
    const forced = app({ websiteAppearance: 'dark' })
    expect(forced.theme.themeSource).toBe('system')
    expect(forced.writes).toEqual([])
  })

  it('follows each change of Lucium’s appearance, and goes back to the system’s with Automatique', () => {
    const { theme, writes, change } = app({ websiteAppearance: 'dark' })
    change({ interfaceAppearance: 'dark' })
    expect(theme.themeSource).toBe('dark')
    change({ interfaceAppearance: 'light' })
    expect(theme.themeSource).toBe('light')
    change({ interfaceAppearance: 'auto' })
    expect(theme.themeSource).toBe('system')
    expect(writes).toEqual(['dark', 'light', 'system'])
  })

  it('writes nativeTheme only when it changes: macOS redraws every window at each write', () => {
    const { writes, change } = app({ interfaceAppearance: 'dark' })
    change({ websiteAppearance: 'dark' })
    change({ interfaceAppearance: 'dark' })
    change({ websiteAppearance: 'auto' })
    expect(writes).toEqual(['dark'])
  })
})

describe('the appearance asked of the websites goes to the pages', () => {
  it('is nothing for Automatique, and light or dark when asked, whatever Lucium’s appearance is', () => {
    const { schemes, change } = app()
    expect(schemes).toEqual([null])
    change({ websiteAppearance: 'dark' })
    change({ interfaceAppearance: 'light' })
    change({ websiteAppearance: 'light' })
    change({ websiteAppearance: 'auto' })
    expect(schemes).toEqual([null, 'dark', 'dark', 'light', null])
  })

  it('starts from the setting a file was saved with', () => {
    expect(app({ websiteAppearance: 'dark' }).schemes).toEqual(['dark'])
  })

  it('reads a value that is not one of the three as Automatique (the engine is asked for nothing, nativeTheme for the system’s)', () => {
    const { theme, schemes } = app({ interfaceAppearance: 'Dark' as never, websiteAppearance: 'sepia' as never })
    expect(theme.themeSource).toBe('system')
    expect(schemes).toEqual([null])
  })
})

describe('a state saved before the two had names of their own', () => {
  it('has Lucium on Automatique by default: only the websites keep what the single setting said', () => {
    const settings = defaultSettings()
    expect(settings.interfaceAppearance).toBe('auto')
    expect(settings.websiteAppearance).toBe('auto')
  })
})

// Contract: `main()` needs a real Electron. The start of the application hands the two settings to `followAppearance`, and nothing else in the main process writes
// nativeTheme from a setting: the one place that did (the appearance of the websites) turned the whole interface dark.
describe('the main process', () => {
  // That main() follows the two appearances through followAppearance: main-wiring.test.ts, where main() is run.

  it('writes nativeTheme.themeSource nowhere else but in followAppearance and in the development aid of the appearance', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const writers: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/^smoke/.test(name) && /nativeTheme\.themeSource\s*=[^=]|theme\.themeSource\s*=[^=]/.test(readFileSync(path, 'utf8'))) writers.push(posix(path.slice(root.length)))
      }
    }
    walk(root)
    expect(writers.sort()).toEqual(['index.ts', 'shell/appearance.ts'])
    // The development aid is the only write of index.ts, and it takes a word of the environment, not a setting.
    expect(readFileSync(join(root, 'index.ts'), 'utf8').match(/nativeTheme\.themeSource\s*=[^=]/g)).toHaveLength(1)
    expect(readFileSync(join(root, 'index.ts'), 'utf8')).toMatch(/if \(forced === 'dark' \|\| forced === 'light'\) nativeTheme\.themeSource = forced/)
  })
})
