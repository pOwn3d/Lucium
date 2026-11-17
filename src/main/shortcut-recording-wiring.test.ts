// The Shortcuts pane records a press with the keyboard layout it has read: without it, ⌥⌘A on a French keyboard is recorded with the letter a
// US keyboard has at that place. Here because it reads a file (the renderer tests have no `node:fs`).

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pane = readFileSync(new URL('../renderer/SettingsShortcuts.tsx', import.meta.url), 'utf8')

describe('the recording of a shortcut in the Settings', () => {
  it('reads the keyboard layout, and hands it to every press it turns into a shortcut', () => {
    expect(pane).toContain('readKeyboardCharacters()')
    expect(pane).toContain('layout.current = keyLayoutOf(read)')
    // The press is read by one rule (shared/shortcut-view.ts, `recordingStep`), which is the only way of the pane to an accelerator.
    expect(pane).not.toContain('acceleratorFromKeyEvent')
    const calls = pane.match(/recordingStep\([^)]*\)/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call).toBe('recordingStep(e.nativeEvent, platform, layout.current)')
  })

  it('gives a shortcut through the rule that refuses the fixed entries of the menus and the shortcuts of the extensions', () => {
    expect(pane).toContain('const taken = [...FIXED_SHORTCUTS, ...extensions.flatMap(extensionMenuCommands)]')
    expect(pane).toContain('assignShortcut(id, accelerator, bindings, taken, platform)')
    // No other way to a saved accelerator: the only binding the pane writes itself is the empty one (the shortcut turned off).
    expect(pane.match(/\.\.\.bindings, \[[a-z.]+\]: (?!'')/g) ?? []).toEqual([])
    const categories = readFileSync(new URL('../renderer/SettingsCategories.tsx', import.meta.url), 'utf8')
    expect(categories).toContain('extensions={snapshot.extensions.filter((extension) => extension.enabled)}')
  })
})
