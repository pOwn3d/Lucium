// N6: what a tab row says of its page. The reading is a function of the runtime flags the shell keeps, and with the switch off it is the same empty answer for
// every tab (so no class is put on a row, no badge is drawn, and the hover card carries no legend).

import { describe, expect, it } from 'vitest'
import { failedAfter, tabStateClasses, tabStateLabel, tabStateLegend, tabStateNotes, tabStates, TAB_STATE_ORDER, type TabStateInput } from './tab-state'

const awake: TabStateInput = { loading: false, awake: true, audible: false, muted: false }

describe('tabStates', () => {
  it('is empty for every tab while the switch is off: nothing is read, nothing is drawn', () => {
    const busy: TabStateInput = { loading: true, awake: false, audible: true, muted: true, frozen: true, failed: true }
    expect(tabStates(false, busy)).toEqual([])
    expect(tabStates(false, awake)).toEqual([])
    // The same frozen array each time: the off path allocates nothing per row.
    expect(tabStates(false, busy)).toBe(tabStates(false, awake))
    expect(tabStateClasses(tabStates(false, busy))).toEqual([])
    expect(tabStateLegend(false)).toEqual([])
  })

  it('has nothing to say of a tab the shell knows nothing of, or of one that is simply awake', () => {
    expect(tabStates(true, undefined)).toEqual([])
    expect(tabStates(true, awake)).toEqual([])
  })

  it('reads loading, asleep, sound and a failed load', () => {
    expect(tabStates(true, { ...awake, loading: true })).toEqual(['loading'])
    expect(tabStates(true, { ...awake, awake: false })).toEqual(['asleep'])
    expect(tabStates(true, { ...awake, audible: true })).toEqual(['sound'])
    expect(tabStates(true, { ...awake, failed: true })).toEqual(['error'])
  })

  it('keeps a muted tab on the sound mark (so it can be turned back on), though it is no longer audible', () => {
    expect(tabStates(true, { ...awake, muted: true })).toEqual(['sound'])
  })

  it('tells a frozen page from a sleeping one: a frozen page is not awake either, but it is frozen and not asleep', () => {
    expect(tabStates(true, { ...awake, awake: false, frozen: true })).toEqual(['frozen'])
    expect(tabStates(true, { ...awake, awake: false })).toEqual(['asleep'])
  })

  it('lists the states in the order of the legend, and names each by a class of the row', () => {
    const all = tabStates(true, { loading: true, awake: false, audible: true, muted: false, failed: true })
    expect(all).toEqual(['loading', 'asleep', 'sound', 'error'])
    expect(tabStateClasses(all)).toEqual(['st-loading', 'st-asleep', 'st-sound', 'st-error'])
    expect(all.every((state, i, list) => i === 0 || TAB_STATE_ORDER.indexOf(list[i - 1]!) < TAB_STATE_ORDER.indexOf(state))).toBe(true)
  })
})

describe('the words of the states', () => {
  it('has five labels in the legend, one per state', () => {
    expect(tabStateLegend(true)).toEqual(['Chargement', 'En veille', 'Gelé', 'Son', 'Erreur'])
    expect(TAB_STATE_ORDER.map(tabStateLabel)).toEqual(tabStateLegend(true))
  })

  it('gives the card a line for a failed load, a sleeping page (memory released) and a frozen one, and none for the rest', () => {
    expect(tabStateNotes(['error'])).toEqual(['Chargement impossible'])
    expect(tabStateNotes(['asleep'])).toEqual(['Mémoire libérée'])
    expect(tabStateNotes(['frozen'])).toEqual(['Page gardée en mémoire'])
    expect(tabStateNotes(['loading', 'sound'])).toEqual([])
    expect(tabStateNotes([])).toEqual([])
  })

  it('does not say the memory is released twice when the card has a line of resources that says it', () => {
    expect(tabStateNotes(['asleep'], true)).toEqual([])
    expect(tabStateNotes(['asleep', 'error'], true)).toEqual(['Chargement impossible'])
  })
})

describe('failedAfter', () => {
  it('sets when a load ends on one of our error pages, clears when a load starts, and keeps otherwise', () => {
    expect(failedAfter(false, false, true)).toBe(true)
    expect(failedAfter(true, true, false)).toBe(false)
    expect(failedAfter(true, false, false)).toBe(false)
    expect(failedAfter(true, undefined, false)).toBe(true)
    expect(failedAfter(false, undefined, true)).toBe(false)
  })

  it('does not take a load that starts for a failure, even when an error page is still on screen', () => {
    expect(failedAfter(false, true, true)).toBe(false)
  })
})
