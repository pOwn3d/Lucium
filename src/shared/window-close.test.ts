import { describe, expect, it } from 'vitest'
import { createInitialState, reduce } from './sidebar'
import { closeWarning, windowTabCount, type WindowCloseFacts } from './window-close'
import { frenchSpaces } from './french-typography'

const facts = (patch: Partial<WindowCloseFacts> = {}): WindowCloseFacts => ({ kind: 'window', windows: 2, quitting: false, tabs: 3, space: 'Travail', ...patch })

describe('closeWarning', () => {
  it('asks before closing a window that shows several tabs while another window stays open', () => {
    expect(closeWarning(facts())).toEqual({ message: frenchSpaces('Fermer cette fenêtre ?'), detail: frenchSpaces('Ses 3 onglets de l’espace « Travail » restent dans la barre latérale des autres fenêtres.') })
  })

  it('never asks about the last window: closing it is quitting, which has its own setting', () => {
    expect(closeWarning(facts({ windows: 1 }))).toBeNull()
    expect(closeWarning(facts({ windows: 1, kind: 'private' }))).toBeNull()
    expect(closeWarning(facts({ windows: 0 }))).toBeNull()
  })

  it('does not ask while the application quits: the question about quitting was already asked', () => {
    expect(closeWarning(facts({ quitting: true }))).toBeNull()
  })

  it('calls a guest window by its name and says it keeps nothing', () => {
    expect(closeWarning(facts({ kind: 'private', guest: true, tabs: 3 }))).toEqual({ message: frenchSpaces('Fermer cette fenêtre invité ?'), detail: frenchSpaces('Ses 3 onglets seront perdus : une fenêtre invité ne garde rien.') })
    expect(closeWarning(facts({ kind: 'private', guest: true, tabs: 1 }))).toBeNull()
    expect(closeWarning(facts({ kind: 'private', guest: true, windows: 1 }))).toBeNull()
  })

  it('does not ask for a window with one tab or none', () => {
    expect(closeWarning(facts({ tabs: 1 }))).toBeNull()
    expect(closeWarning(facts({ tabs: 0 }))).toBeNull()
    expect(closeWarning(facts({ tabs: 2 }))).not.toBeNull()
  })

  it('says a private window loses its tabs, and that the main window takes the others with it', () => {
    expect(closeWarning(facts({ kind: 'private', tabs: 4 }))).toEqual({ message: frenchSpaces('Fermer cette fenêtre privée ?'), detail: frenchSpaces('Ses 4 onglets seront perdus : une fenêtre privée ne garde rien.') })
    expect(closeWarning(facts({ kind: 'main', windows: 3 }))?.detail).toBe('Les 2 autres fenêtres se fermeront avec elle. Les onglets de vos espaces reviendront au prochain lancement.')
    expect(closeWarning(facts({ kind: 'main', windows: 2 }))?.detail).toMatch(/^L’autre fenêtre se fermera avec elle\./)
  })

  it('leaves the space out of the question when there is none to name', () => {
    expect(closeWarning(facts({ space: undefined }))?.detail).toBe('Ses 3 onglets restent dans la barre latérale des autres fenêtres.')
  })
})

describe('windowTabCount', () => {
  const ctx = { now: 1, newId: (() => { let n = 0; return () => `id-${++n}` })() }
  it('counts the tabs of the space on screen for a normal window, and every tab of a private one', () => {
    let state = createInitialState(ctx)
    const first = state.activeSpaceId
    state = reduce(state, { type: 'tab/open', url: 'https://a.example/' }, ctx)
    state = reduce(state, { type: 'tab/open', url: 'https://b.example/' }, ctx)
    state = reduce(state, { type: 'space/create', name: 'Autre', emoji: '🧪', hue: 100 }, ctx)
    state = reduce(state, { type: 'tab/open', url: 'https://c.example/' }, ctx)
    expect(state.activeSpaceId).not.toBe(first)
    expect(windowTabCount(state, 'window')).toBe(1)
    expect(windowTabCount(state, 'main')).toBe(1)
    expect(windowTabCount(state, 'private')).toBe(3)
  })
})
