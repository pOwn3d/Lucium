import { describe, expect, it } from 'vitest'
import { iconSent, iconShown, unmarked, type IconMark } from './icon-mark'

const NONE: IconMark = { base: undefined, marked: false }
const ICON = 'https://app.example/icon.png'
const ALERT = 'https://app.example/icon-alert.png'

describe('the dot of a tab whose icon moved', () => {
  it('shows a dot when the icon changes while the tab is in the background and its page has loaded', () => {
    const base = iconSent(NONE, ICON, false)
    expect(base.marked).toBe(false)
    expect(iconSent(base, ALERT, false).marked).toBe(true)
  })

  it('shows nothing for the first icon a page sends, nor for a change while the page loads (a site sets its icon twice)', () => {
    const first = iconSent(NONE, '/favicon.ico', true)
    expect(first.marked).toBe(false)
    expect(iconSent(first, ICON, true)).toEqual({ base: ICON, marked: false })
  })

  it('shows nothing when the address is the same as the base, and keeps the dot until the tab is shown', () => {
    const base = iconSent(NONE, ICON, false)
    expect(iconSent(base, ICON, false).marked).toBe(false)
    const marked = iconSent(base, ALERT, false)
    expect(iconSent(marked, ICON, false).marked).toBe(true)
  })

  it('does not mark a tab on screen, and the icon it shows becomes the base', () => {
    const base = iconSent(NONE, ICON, false)
    expect(iconSent(base, ALERT, true)).toEqual({ base: ALERT, marked: false })
  })

  it('clears the dot when the tab is shown, and the icon it has then is the base', () => {
    const marked = iconSent(iconSent(NONE, ICON, false), ALERT, false)
    expect(marked.marked).toBe(true)
    expect(iconShown(ALERT)).toEqual({ base: ALERT, marked: false })
    // Once shown, a change that comes from the same icon is news again: the base is the icon that was on screen.
    expect(iconSent(iconShown(ALERT), ICON, false).marked).toBe(true)
  })

  it('has no base for a tab whose page gave no icon, so the next one is taken as the base', () => {
    expect(iconShown(undefined)).toEqual({ base: undefined, marked: false })
    expect(iconSent(iconShown(undefined), ICON, false)).toEqual({ base: ICON, marked: false })
  })
})

describe('the runtime entry of a tab once it is shown', () => {
  it('loses its dot and keeps the rest of its state', () => {
    const entry = { loading: false, awake: true, changedIcon: true as const }
    const shown = unmarked(entry)
    expect(shown).toEqual({ loading: false, awake: true })
    expect('changedIcon' in shown).toBe(false)
  })
})
