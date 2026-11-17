// The keyboard layout comes from a window (the shell cannot read it) and reaches the switcher of tabs: ⌥A on a French keyboard gives « æ »
// at the place of Q, and only the layout says it is the A of the shortcut. The interface is not trusted: what is not a layout changes nothing.

import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser } from './browser-fake.test-support'
import { sendFrom } from './ipc-fake.test-support'
import { forgetKeyboardLayout, keyboardLayout } from './keyboard-layout'

vi.mock('electron', async () => (await import('./ipc-fake.test-support')).fakeElectron())
const { registerIpc } = await import('./ipc')

const state = createInitialState({ now: 0, newId: () => 'x' })
const store = { get: () => state, subscribe: () => () => {} } as never
registerIpc(fakeBrowser({}).self as never, store, {} as never, new Set([1]))

beforeEach(() => forgetKeyboardLayout())

describe('the keyboard layout a window sends', () => {
  it('is kept for the shell, key by key', () => {
    expect(keyboardLayout()).toBeUndefined()
    sendFrom(1, Channel.keyboardLayout, { KeyQ: 'a', KeyA: 'q' })
    expect(keyboardLayout()?.('KeyQ')).toBe('a')
    expect(keyboardLayout()?.('KeyP')).toBeUndefined()
    expect(keyboardLayout()?.('toString')).toBeUndefined()
  })

  it('changes nothing when it is not a layout', () => {
    sendFrom(1, Channel.keyboardLayout, { KeyQ: 'a' })
    for (const raw of [null, 'KeyQ', ['a'], {}, { 'Key Q': 'a' }, { KeyQ: 7 }, Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`Key${i}`, 'a']))]) sendFrom(1, Channel.keyboardLayout, raw)
    expect(keyboardLayout()?.('KeyQ')).toBe('a')
  })

  it('is handed to the rule that reads the keys of the switcher', () => {
    const browser = readFileSync(new URL('./browser-base.ts', import.meta.url), 'utf8')
    expect(browser).toMatch(/decideCycleKey\(\s*\{[^}]*layout: keyboardLayout\(\)/)
  })

  it('is sent by the window each time it gets the focus', () => {
    const entry = readFileSync(new URL('../../renderer/main.tsx', import.meta.url), 'utf8')
    expect(entry).toContain('reportKeyboardLayout((characters) => api().keyboardLayout(characters), (listener) => api().onWindowFocus(listener))')
  })
})
