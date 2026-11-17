// The keys the layer hands to the shell for the panel of ⌃Tab. The layer is told of a panel and receives its keys by two routes, and the keys can
// come first: the engine test of ⌃Tab sent Escape, and the release of ⌃ after a ⌃Tab typed in the interface, before the layer knew that its
// panel was the one of ⌃Tab, and both were lost (the panel stayed up, then showed another tab).

import { describe, expect, it, vi } from 'vitest'
import type { CycleKey } from '@shared/tab-cycle'
import { cycleKeyRelay, HELD_KEYS_MAX, type RelayedKeyEvent } from './cycle-key-relay'

const press = (type: 'keydown' | 'keyup', code: string, control: boolean, shift = false) => ({
  type,
  code,
  key: code === 'ControlLeft' ? 'Control' : code,
  metaKey: false,
  ctrlKey: control,
  altKey: false,
  shiftKey: shift,
  repeat: false,
  preventDefault: vi.fn<() => void>()
}) satisfies RelayedKeyEvent

const relayed = () => {
  const keys: CycleKey[] = []
  const relay = cycleKeyRelay((key) => keys.push(key))
  return { relay, keys, said: () => keys.map((k) => `${k.type}:${k.code}${k.control ? '+ctrl' : ''}`) }
}

describe('the keys the layer hands to the shell for the panel of ⌃Tab', () => {
  it('hands over, once the request arrives, the keys that reached the layer before it, in their order (Escape typed as the panel appears)', () => {
    const { relay, said } = relayed()
    relay.show({ panel: 'commandbar' })
    relay.show(null)
    relay.key(press('keydown', 'Escape', true))
    expect(said()).toEqual([])
    relay.show({ panel: 'tabcycle' })
    expect(said()).toEqual(['keyDown:Escape+ctrl'])
  })

  it('does the same for the very first panel of the layer: a ⌃Tab typed in the interface, released before the request came, ends its panel', () => {
    const { relay, said } = relayed()
    relay.key(press('keyup', 'Tab', true))
    relay.key(press('keyup', 'ControlLeft', false))
    relay.show({ panel: 'tabcycle' })
    expect(said()).toEqual(['keyUp:Tab+ctrl', 'keyUp:ControlLeft'])
  })

  it('reports each key at once while the panel of ⌃Tab is up, and keeps it from the panel', () => {
    const { relay, keys, said } = relayed()
    relay.show({ panel: 'tabcycle' })
    const tab = press('keydown', 'Tab', true, true)
    relay.key(tab)
    expect(said()).toEqual(['keyDown:Tab+ctrl'])
    expect(keys[0]).toEqual({ type: 'keyDown', code: 'Tab', key: 'Tab', meta: false, control: true, alt: false, shift: true, isAutoRepeat: false })
    expect(tab.preventDefault).toHaveBeenCalledOnce()
  })

  it('never reports the keys of another panel, nor those that were waiting for it, and leaves them to it', () => {
    const { relay, said } = relayed()
    relay.show(null)
    const early = press('keydown', 'KeyA', false)
    relay.key(early)
    relay.show({ panel: 'commandbar' })
    const typed = press('keydown', 'KeyB', false)
    relay.key(typed)
    // The panel of ⌃Tab that takes the place of the command bar gets none of them.
    relay.show({ panel: 'tabcycle' })
    expect(said()).toEqual([])
    expect(early.preventDefault).not.toHaveBeenCalled()
    expect(typed.preventDefault).not.toHaveBeenCalled()
  })

  it('drops what was waiting when the layer is closed again before any panel came, and keeps a bounded number of keys', () => {
    const { relay, keys } = relayed()
    relay.key(press('keydown', 'Escape', true))
    relay.show(null)
    for (let i = 0; i < HELD_KEYS_MAX + 5; i++) relay.key(press('keydown', 'Tab', true))
    relay.show({ panel: 'tabcycle' })
    expect(keys).toHaveLength(HELD_KEYS_MAX)
    expect(keys.every((k) => k.code === 'Tab')).toBe(true)
  })
})
