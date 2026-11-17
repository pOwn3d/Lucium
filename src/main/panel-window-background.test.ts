// The windows of their own (Réglages, the task manager, the About window) open on the colour of the appearance (shared/panel-window.ts).
// A contract, read from the sources on purpose: the windows are made in the main process (BrowserWindow), which a test without Electron cannot build, and the
// white or black flash of a window that opens on the wrong colour is seen only on screen. The whole main process is read, so that the windows may move from one
// file to another (the split of main/index.ts) without the guard going blind.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Every source of the main process (not its tests), by its path under src/main. */
function mainSources(): Map<string, string> {
  const sources = new Map<string, string>()
  for (const entry of readdirSync(__dirname, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    const path = join(entry.parentPath, entry.name)
    sources.set(relative(__dirname, path), readFileSync(path, 'utf8'))
  }
  return sources
}

describe('the windows of their own, when they are created', () => {
  const sources = mainSources()

  it('are given the background of the appearance: Réglages, the task manager and the About window', () => {
    const given = [...sources.values()].flatMap((source) => source.match(/backgroundColor: panelWindowBackground\(nativeTheme\.shouldUseDarkColors\)/g) ?? [])
    expect(given).toHaveLength(3)
  })

  it('keep no fixed dark ground of the old palette, and Réglages is not given one by its own module', () => {
    for (const [path, source] of sources) expect(source, path).not.toContain("backgroundColor: '#202122'")
    const settingsWindow = sources.get(join('shell', 'settings-window.ts'))
    expect(settingsWindow).toBeDefined()
    expect(settingsWindow).not.toMatch(/backgroundColor/)
  })
})
