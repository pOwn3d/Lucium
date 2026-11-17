import { describe, expect, it } from 'vitest'
import { createInitialState, parseSavedState, persistableState, reduce } from './sidebar'
import { defaultSettings } from './model'
import { cleanSpellCheck, spellCheckChoiceOf, spellCheckEnabled } from './spell-check'

describe('Edit › Spelling and Grammar › Check Spelling While Typing', () => {
  it('follows the system until the user chooses: on where the system has a checker (macOS), off elsewhere', () => {
    expect(spellCheckEnabled('auto', true)).toBe(true)
    expect(spellCheckEnabled('auto', false)).toBe(false)
  })

  it('keeps the choice the user made, whatever the system would do', () => {
    expect(spellCheckEnabled('on', false)).toBe(true)
    expect(spellCheckEnabled('off', true)).toBe(false)
  })

  it('records a click on the entry as a choice of its own, never as “auto” (the choice must survive a change of default)', () => {
    expect(spellCheckChoiceOf(true)).toBe('on')
    expect(spellCheckChoiceOf(false)).toBe('off')
  })

  it('reads a saved value back as it was written, and anything else as “auto”', () => {
    for (const choice of ['auto', 'on', 'off'] as const) expect(cleanSpellCheck(choice)).toBe(choice)
    for (const bad of [undefined, null, true, false, 0, 1, '', 'ON', 'yes', ['on'], { on: true }]) expect(cleanSpellCheck(bad), JSON.stringify(bad)).toBe('auto')
  })

  it('is “auto” by default: nobody who never touched the entry sees a change', () => {
    expect(defaultSettings().spellCheck).toBe('auto')
  })

  it('survives a restart: written to the state file by the settings update, read back by the next launch', () => {
    const ctx = { now: 1, newId: () => 'x' }
    const initial = createInitialState(ctx)
    const off = reduce(initial, { type: 'settings/update', patch: { spellCheck: spellCheckChoiceOf(false) } }, ctx)
    expect(parseSavedState(JSON.stringify(persistableState(off))).settings.spellCheck).toBe('off')
    const on = reduce(off, { type: 'settings/update', patch: { spellCheck: spellCheckChoiceOf(true) } }, ctx)
    expect(parseSavedState(JSON.stringify(persistableState(on))).settings.spellCheck).toBe('on')
  })

  it('reads a state file written before the setting existed, or damaged, as “auto”', () => {
    const ctx = { now: 1, newId: () => 'x' }
    const saved = JSON.parse(JSON.stringify(persistableState(createInitialState(ctx)))) as { settings: Record<string, unknown> }
    delete saved.settings['spellCheck']
    expect(parseSavedState(JSON.stringify(saved)).settings.spellCheck).toBe('auto')
    saved.settings['spellCheck'] = 'maybe'
    expect(parseSavedState(JSON.stringify(saved)).settings.spellCheck).toBe('auto')
    saved.settings['spellCheck'] = true
    expect(parseSavedState(JSON.stringify(saved)).settings.spellCheck).toBe('auto')
  })
})
