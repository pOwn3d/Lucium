// @vitest-environment happy-dom
// The two guides at the head of « Découvrir Lucium » (DiscoverTip.tsx, DiscoverPath.tsx), drawn and used in a document: the tip of the day shows by default,
// « Compris » puts it away for the day, « Ne plus afficher » turns it off in one click and the box turns it back on, « Essayer » does the real thing and puts the tip
// away; the path ticks by hand and by « Essayer », shows its progress, starts over, and both are left out while a search narrows the list. Each write goes to the
// settings through the one `settings/update` action, nothing else.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISCOVER_ENTRIES, DISCOVER_EXTRAS, discoverName, discoverOff } from '@shared/discover'
import { DISCOVER_PATH_STEPS, dayKey, discoverTipEntry } from '@shared/discover-tips'
import { frenchSpaces } from '@shared/french-typography'
import { setLanguage } from '@shared/i18n'
import { defaultSettings, type Settings, type SidebarState } from '@shared/model'
import { createInitialState } from '@shared/sidebar'

const holder = vi.hoisted(() => ({ snapshot: null as unknown, asked: [] as Array<[string, unknown[]]> }))
vi.mock('./api', () => {
  const act = new Proxy({}, { get: (_target, name: string) => (...args: unknown[]) => void holder.asked.push([name, args]) })
  return { api: () => act, useSnapshot: () => holder.snapshot }
})

import { Discover } from './Discover'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

function show(settings: Partial<Settings> = {}): void {
  const state: SidebarState = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), ...settings } }
  holder.snapshot = { state, runtime: { tabs: {}, canGoBack: false, canGoForward: false }, platform: 'darwin' }
  act(() => root.render(createElement(Discover)))
}

beforeEach(() => {
  setLanguage('fr')
  holder.asked = []
  holder.snapshot = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setLanguage('fr')
})

const settings = defaultSettings()
const todaysTip = discoverTipEntry([...DISCOVER_ENTRIES, ...DISCOVER_EXTRAS], dayKey(new Date()), (e) => discoverOff(e, settings))!
const tip = (): HTMLElement | null => host.querySelector<HTMLElement>('.dv-tip')
const path = (): HTMLElement => host.querySelector<HTMLElement>('.dv-path')!
const buttonIn = (within: ParentNode | null, label: string): HTMLButtonElement | undefined => [...(within?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label)
const click = (el: Element | undefined | null): void => void act(() => (el as HTMLElement).click())
const patches = (): Array<Record<string, unknown>> =>
  holder.asked.filter(([name]) => name === 'dispatch').map(([, args]) => (args[0] as { type: string; patch: Record<string, unknown> }).patch)
const box = (step: string): HTMLInputElement => [...path().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.id.endsWith(`-${step}`))!
const type = (value: string): void => {
  const field = host.querySelector<HTMLInputElement>('input[type="search"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the tip of the day', () => {
  it('shows by default, as a titled section: the function of the day, where to find it, and its three buttons named by the function', () => {
    show()
    const card = tip()!
    expect(card).not.toBeNull()
    expect(card.getAttribute('aria-labelledby')).toBeTruthy()
    expect(host.querySelector(`#${card.getAttribute('aria-labelledby')}`)?.textContent).toBe('Astuce du jour')
    expect(card.textContent).toContain(discoverName(todaysTip))
    expect(card.textContent).toContain('Où')
    for (const b of card.querySelectorAll('button')) expect(b.getAttribute('aria-label')!.startsWith(b.textContent!)).toBe(true)
    expect(buttonIn(card, 'Compris')?.getAttribute('aria-label')).toBe(`Compris, ranger l’astuce ${discoverName(todaysTip)} jusqu’à demain`)
    expect(buttonIn(card, 'Ne plus afficher')).toBeDefined()
  })

  it('is not drawn again the same day once it was put away, and nothing is said of a tip that is not there', () => {
    show({ discoverTipDay: dayKey(new Date()) })
    expect(tip()).toBeNull()
    expect(host.querySelector('.dv-tipbox input')).not.toBeNull()
  })

  it('is drawn again the next day', () => {
    show({ discoverTipDay: '2020-01-01' })
    expect(tip()).not.toBeNull()
  })

  it('« Compris » writes the day it was put away and says so, and the focus goes to the box', () => {
    show()
    click(buttonIn(tip(), 'Compris'))
    expect(patches()).toEqual([{ discoverTipDay: dayKey(new Date()) }])
    expect(host.querySelector('.dv-tipzone [role="status"]')?.textContent).toBe(frenchSpaces('Astuce rangée : une nouvelle demain.'))
    expect(document.activeElement).toBe(host.querySelector('.dv-tipbox input'))
  })

  it('« Ne plus afficher » switches it off in one click, says so, and keeps the focus on the box that turns it back on', () => {
    show()
    click(buttonIn(tip(), 'Ne plus afficher'))
    expect(patches()).toEqual([{ discoverTip: false }])
    expect(host.querySelector('.dv-tipzone [role="status"]')?.textContent).toContain('désactivée')
    expect(document.activeElement).toBe(host.querySelector('.dv-tipbox input'))
  })

  it('is not drawn at all when the person switched it off, and the box, unchecked, turns it back on at once', () => {
    show({ discoverTip: false })
    expect(tip()).toBeNull()
    const input = host.querySelector<HTMLInputElement>('.dv-tipbox input')!
    expect(input.checked).toBe(false)
    click(input)
    expect(patches()).toEqual([{ discoverTip: true, discoverTipDay: '' }])
  })

  // A fixed clock, so that each kind of function the tip may offer is tried: the day is found in the calendar, then the clock is set to it.
  const onADayWhenTheTipIs = (kind: 'open' | 'call' | 'setting' | 'hint'): string => {
    for (let n = 0; n < 400; n++) {
      const day = dayKey(new Date(2027, 0, 1 + n))
      if (discoverTipEntry([...DISCOVER_ENTRIES, ...DISCOVER_EXTRAS], day, (e) => discoverOff(e, settings))?.try.kind === kind) return day
    }
    throw new Error(`no day shows a tip of kind ${kind}`)
  }
  const setClock = (day: string): void => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${day}T12:00:00`))
  }
  afterEach(() => vi.useRealTimers())

  it('« Essayer » puts the tip away for the day, then leaves the panel for the real thing', () => {
    const day = onADayWhenTheTipIs('open')
    setClock(day)
    show()
    click(buttonIn(tip(), 'Essayer'))
    expect(patches()[0]).toEqual({ discoverTipDay: day })
    expect(holder.asked.map(([name]) => name)).toEqual(expect.arrayContaining(['dispatch', 'closeOverlay', 'openOverlay']))
  })

  it('offers « Régler » alone for a function that is a setting, and no button for one that needs a page', () => {
    setClock(onADayWhenTheTipIs('setting'))
    show()
    expect(buttonIn(tip(), 'Essayer')).toBeUndefined()
    click(buttonIn(tip(), 'Régler'))
    expect(holder.asked.map(([name]) => name)).toEqual(expect.arrayContaining(['closeOverlay', 'openOverlay']))
    act(() => root.unmount())
    root = createRoot(host)
    setClock(onADayWhenTheTipIs('hint'))
    show()
    expect(buttonIn(tip(), 'Essayer')).toBeUndefined()
    expect(buttonIn(tip(), 'Régler')).toBeUndefined()
    expect(buttonIn(tip(), 'Compris')).toBeDefined()
  })

  it('has its box in the page whatever the tip is: a labelled checkbox, checked while the tip is on', () => {
    show()
    const input = host.querySelector<HTMLInputElement>('.dv-tipbox input')!
    expect(input.checked).toBe(true)
    expect(input.closest('label')?.textContent).toBe('Afficher une astuce du jour')
  })

  it('speaks English too', () => {
    setLanguage('en')
    show()
    expect(host.querySelector('.dv-tip h3')?.textContent).toBe('Tip of the day')
    expect(buttonIn(tip(), 'Got it')).toBeDefined()
    expect(host.querySelector('.dv-tipbox')?.textContent).toBe('Show a tip of the day')
  })
})

describe('the path « Parcours de découverte »', () => {
  it('is a titled list of boxes, one per step, in the order of the path, each box described by the line of its function', () => {
    show()
    expect(path().querySelector('h3')?.textContent).toBe('Parcours de découverte')
    const boxes = [...path().querySelectorAll<HTMLInputElement>('ol input[type="checkbox"]')]
    expect(boxes).toHaveLength(DISCOVER_PATH_STEPS.length)
    for (const input of boxes) {
      expect(input.checked).toBe(false)
      expect(host.querySelector(`label[for="${input.id}"]`)?.textContent).toBeTruthy()
      expect(host.querySelector(`#${input.getAttribute('aria-describedby')}`)?.textContent).toBeTruthy()
    }
    expect(path().textContent).toContain(frenchSpaces(`Étapes essayées : 0 sur ${DISCOVER_PATH_STEPS.length}.`))
  })

  it('shows the ticks that were kept and counts them', () => {
    show({ discoverPath: ['command-bar', 'capture'] })
    expect(box('command-bar').checked).toBe(true)
    expect(box('capture').checked).toBe(true)
    expect(box('spaces').checked).toBe(false)
    expect(path().textContent).toContain(frenchSpaces(`Étapes essayées : 2 sur ${DISCOVER_PATH_STEPS.length}.`))
  })

  it('ticks a step by hand, keeping the others, and unticks it again', () => {
    show({ discoverPath: ['capture'] })
    click(box('spaces'))
    expect(patches()).toEqual([{ discoverPath: ['spaces', 'capture'] }])
    holder.asked = []
    click(box('capture'))
    expect(patches()).toEqual([{ discoverPath: [] }])
  })

  it('« Essayer » ticks the step, then leaves the panel for the real thing', () => {
    show()
    const step = box('command-bar').closest('li')!
    const button = buttonIn(step, 'Essayer')!
    expect(button.getAttribute('aria-label')).toMatch(/^Essayer, /)
    click(button)
    expect(patches()).toEqual([{ discoverPath: ['command-bar'] }])
    expect(holder.asked.map(([name]) => name)).toEqual(expect.arrayContaining(['dispatch', 'closeOverlay', 'openOverlay']))
  })

  it('offers « Régler » alone for a step that is a setting, and ticks it too', () => {
    show()
    const step = box('protection').closest('li')!
    expect(buttonIn(step, 'Essayer')).toBeUndefined()
    click(buttonIn(step, 'Régler'))
    expect(patches()).toEqual([{ discoverPath: ['protection'] }])
  })

  it('says it is complete when every step is ticked', () => {
    show({ discoverPath: [...DISCOVER_PATH_STEPS] })
    expect(path().textContent).toContain('Parcours terminé.')
  })

  it('starts over: « Recommencer » unticks everything and says so', () => {
    show({ discoverPath: ['command-bar', 'spaces'] })
    click(buttonIn(path(), 'Recommencer'))
    expect(patches()).toEqual([{ discoverPath: [] }])
    expect(path().querySelector('[role="status"]')?.textContent).toBe('Parcours remis à zéro.')
  })

  it('ignores a saved step that no longer exists instead of counting it', () => {
    show({ discoverPath: ['gone', 'command-bar'] })
    expect(path().textContent).toContain(frenchSpaces(`Étapes essayées : 1 sur ${DISCOVER_PATH_STEPS.length}.`))
  })

  it('speaks English too', () => {
    setLanguage('en')
    show()
    expect(path().querySelector('h3')?.textContent).toBe('Discovery path')
    expect(path().textContent).toContain(`Steps tried: 0 of ${DISCOVER_PATH_STEPS.length}.`)
    expect(buttonIn(path(), 'Start over')).toBeDefined()
  })
})

describe('the front door', () => {
  it('is put before the cards, and does not take a card\'s place in the count or in the list', () => {
    show()
    const body = host.querySelector('.dv-body')!
    expect(body.firstElementChild?.classList.contains('dv-guides')).toBe(true)
    expect(host.querySelectorAll('article.dv-card').length).toBeGreaterThan(0)
  })

  it('gives way to the results as soon as a search or a filter narrows the list', () => {
    show()
    type('capture')
    expect(host.querySelector('.dv-guides')).toBeNull()
    type('')
    expect(host.querySelector('.dv-guides')).not.toBeNull()
  })

  it('leaves the other controls of the panel alone: the same two chips pressed, the same status', () => {
    show()
    expect(host.querySelectorAll('.tk-chip[aria-pressed="true"]')).toHaveLength(2)
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite')
  })
})
