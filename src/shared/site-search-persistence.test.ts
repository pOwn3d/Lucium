import { describe, it, expect } from 'vitest'
import { parseSavedState, persistableState, createInitialState, reduce, type Ctx } from './sidebar'
import { DEFAULT_SITE_SEARCHES } from './model'

const ctx = (): Ctx => ({ now: Date.now(), newId: () => Math.random().toString() })

describe('site search persistence', () => {
  it('preserves custom shortcuts through save/load cycle', () => {
    // Create initial state
    let state = createInitialState(ctx())
    
    // Add a custom shortcut
    const customSearch = { keyword: 'mytest', name: 'My Test', url: 'https://example.com/?q=%s' }
    state = reduce(state, { type: 'settings/update', patch: { siteSearches: [...state.settings.siteSearches, customSearch] } }, ctx())
    
    const beforeCount = state.settings.siteSearches.length
    const hasCustom = state.settings.siteSearches.some(s => s.keyword === 'mytest')
    
    expect(hasCustom).toBe(true)
    expect(beforeCount).toBeGreaterThan(1) // At least custom + some defaults
    
    // Simulate save/load
    const saved = JSON.stringify(persistableState(state))
    const loaded = parseSavedState(saved)
    
    // Check that custom shortcut survived
    expect(loaded.settings.siteSearches.some(s => s.keyword === 'mytest')).toBe(true)
    expect(loaded.settings.siteSearches.some(s => s.keyword === 'g')).toBe(true) // Default Google
    expect(loaded.settings.siteSearches.some(s => s.keyword === 'yt')).toBe(true) // Default YouTube
  })
  
  it('keeps a list the user emptied empty, in memory and through save/load', () => {
    let state = createInitialState(ctx())
    expect(state.settings.siteSearches.length).toBeGreaterThan(0)
    state = reduce(state, { type: 'settings/update', patch: { siteSearches: [] } }, ctx())
    expect(state.settings.siteSearches).toEqual([])

    const loaded = parseSavedState(JSON.stringify(persistableState(state)))
    expect(loaded.settings.siteSearches).toEqual([])
    // And again: a second save of the loaded state does not bring the defaults back either.
    expect(parseSavedState(JSON.stringify(persistableState(loaded))).settings.siteSearches).toEqual([])
  })

  it('keeps a list without any default as it is, in its order, without adding the defaults', () => {
    const own = [
      { keyword: 'zz', name: 'Last', url: 'https://z.example/?q=%s' },
      { keyword: 'aa', name: 'First', url: 'https://a.example/?q=%s' },
    ]
    let state = createInitialState(ctx())
    state = reduce(state, { type: 'settings/update', patch: { siteSearches: own } }, ctx())
    expect(state.settings.siteSearches).toEqual(own)
    expect(parseSavedState(JSON.stringify(persistableState(state))).settings.siteSearches).toEqual(own)
  })

  it('gives the defaults back when the list is missing from the file (repair)', () => {
    const saved = persistableState(createInitialState(ctx()))
    const { siteSearches: _dropped, ...settings } = saved.settings
    const loaded = parseSavedState(JSON.stringify({ ...saved, settings }))
    expect(loaded.settings.siteSearches).toEqual(DEFAULT_SITE_SEARCHES)
  })

  it('gives the defaults back when the list in the file cannot be read (repair)', () => {
    const saved = persistableState(createInitialState(ctx()))
    const unreadable: unknown[] = ['g', 42, null, {}, { keyword: 'g' }, [null, 'yt', { keyword: 'bad key', name: 'x', url: 'https://x.example/?q=%s' }]]
    for (const siteSearches of unreadable) {
      const loaded = parseSavedState(JSON.stringify({ ...saved, settings: { ...saved.settings, siteSearches } }))
      expect(loaded.settings.siteSearches, JSON.stringify(siteSearches)).toEqual(DEFAULT_SITE_SEARCHES)
    }
  })

  it('keeps the search of a site on this machine through the reducer and through save/load (what the discovery of searches adds)', () => {
    const local = { keyword: 'site', name: 'Smoke OS', url: 'http://127.0.0.1:8123/q?term=%s' }
    let state = createInitialState(ctx())
    state = reduce(state, { type: 'settings/update', patch: { siteSearches: [...state.settings.siteSearches, local] } }, ctx())
    expect(state.settings.siteSearches).toContainEqual(local)
    expect(parseSavedState(JSON.stringify(persistableState(state))).settings.siteSearches).toContainEqual(local)
  })

  it('still refuses plain http elsewhere in the reducer', () => {
    let state = createInitialState(ctx())
    const before = state.settings.siteSearches
    state = reduce(state, { type: 'settings/update', patch: { siteSearches: [...before, { keyword: 'bad', name: 'Bad', url: 'http://insecure.example/?q=%s' }] } }, ctx())
    expect(state.settings.siteSearches).toEqual(before)
  })

  it('preserves multiple custom shortcuts mixed with defaults', () => {
    let state = createInitialState(ctx())
    
    // Add multiple custom shortcuts
    const customSearches = [
      { keyword: 'custom1', name: 'Custom One', url: 'https://one.example.com/?q=%s' },
      { keyword: 'custom2', name: 'Custom Two', url: 'https://two.example.com/?q=%s' },
      { keyword: 'custom3', name: 'Custom Three', url: 'https://three.example.com/?q=%s' },
    ]
    state = reduce(state, { type: 'settings/update', patch: { siteSearches: [...state.settings.siteSearches, ...customSearches] } }, ctx())
    
    // Verify all customs are there
    expect(state.settings.siteSearches.some(s => s.keyword === 'custom1')).toBe(true)
    expect(state.settings.siteSearches.some(s => s.keyword === 'custom2')).toBe(true)
    expect(state.settings.siteSearches.some(s => s.keyword === 'custom3')).toBe(true)
    
    // Simulate save/load
    const saved = JSON.stringify(persistableState(state))
    const loaded = parseSavedState(saved)
    
    // All customs should survive
    expect(loaded.settings.siteSearches.some(s => s.keyword === 'custom1')).toBe(true)
    expect(loaded.settings.siteSearches.some(s => s.keyword === 'custom2')).toBe(true)
    expect(loaded.settings.siteSearches.some(s => s.keyword === 'custom3')).toBe(true)
    
    // Some defaults should still be there
    expect(loaded.settings.siteSearches.some(s => s.keyword === 'g')).toBe(true)
    expect(loaded.settings.siteSearches.length).toBeGreaterThan(3)
  })
})
