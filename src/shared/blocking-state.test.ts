// How the blocker's settings live in the state: the action behind the site switch, what an older save gets, what a private window may do.

import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { privateAction } from './private-window'
import { createInitialState, normalize, reduce, type Action } from './sidebar'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const run = (state: ReturnType<typeof createInitialState>, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)

describe('the site switch (blocking/exempt-site)', () => {
  it('adds a site to the exceptions once, as a host, and takes it out again', () => {
    const start = createInitialState(ctx)
    const on = run(start, { type: 'blocking/exempt-site', site: 'https://www.Exemple.org/page', exempt: true })
    expect(on.settings.blockExceptions).toEqual(['exemple.org'])
    expect(run(on, { type: 'blocking/exempt-site', site: 'exemple.org', exempt: true })).toBe(on)
    expect(run(on, { type: 'blocking/exempt-site', site: 'exemple.org', exempt: false }).settings.blockExceptions).toEqual([])
  })

  it('does nothing for something that is not a host', () => {
    const start = createInitialState(ctx)
    expect(run(start, { type: 'blocking/exempt-site', site: 'pas un hôte', exempt: true })).toBe(start)
  })

  it('treats anything but a real true as "blocked again" (the renderer is not trusted)', () => {
    const on = run(createInitialState(ctx), { type: 'blocking/exempt-site', site: 'exemple.org', exempt: true })
    const forged = { type: 'blocking/exempt-site', site: 'autre.net', exempt: 'yes' } as unknown as Action
    expect(run(on, forged).settings.blockExceptions).toEqual(['exemple.org'])
  })
})

describe('the mode of a site (blocking/site-mode)', () => {
  it('sets the mode of a site by its host, and gives it back to the general mode with null', () => {
    const start = createInitialState(ctx)
    const strict = run(start, { type: 'blocking/site-mode', site: 'https://www.YouTube.com/watch?v=1', mode: 'strict' })
    expect(strict.settings.blockModeSites).toEqual({ 'youtube.com': 'strict' })
    expect(strict.settings.blockMode).toBe('standard')
    expect(run(strict, { type: 'blocking/site-mode', site: 'youtube.com', mode: 'strict' })).toBe(strict)
    expect(run(strict, { type: 'blocking/site-mode', site: 'youtube.com', mode: null }).settings.blockModeSites).toEqual({})
  })

  it('refuses a mode that is not one of the two, and a site with no host', () => {
    const start = createInitialState(ctx)
    expect(run(start, { type: 'blocking/site-mode', site: 'youtube.com', mode: 'aggressive' } as unknown as Action)).toBe(start)
    expect(run(start, { type: 'blocking/site-mode', site: 'pas un hôte', mode: 'strict' })).toBe(start)
  })

  it('does nothing from a private tab: its choices are not written', () => {
    const start = createInitialState(ctx)
    const withPrivate = { ...start, tabs: [{ id: 'p1', private: true, url: 'https://youtube.com/' }] } as unknown as typeof start
    const action: Action = { type: 'blocking/site-mode', site: 'youtube.com', mode: 'strict', tabId: 'p1' }
    expect(run(withPrivate, action)).toBe(withPrivate)
    // A tab of the window (or no tab at all) is the one the choice is written for.
    expect(run(start, { ...action, tabId: undefined }).settings.blockModeSites).toEqual({ 'youtube.com': 'strict' })
  })

  it('is cleaned when a saved file or the settings window brings it in', () => {
    const state = createInitialState(ctx)
    const broken = { ...state, settings: { ...state.settings, blockModeSites: { 'WWW.Youtube.com': 'strict', 'bad host': 'strict', 'news.test': 'aggressive', 'constructor': 'standard' } } }
    expect(normalize(broken as typeof state).settings.blockModeSites).toEqual({ 'youtube.com': 'strict', constructor: 'standard' })
    const old = { ...state, settings: (({ blockModeSites: _m, ...legacy }) => legacy)(state.settings) as typeof state.settings }
    expect(normalize(old as typeof state).settings.blockModeSites).toEqual({})
  })
})

describe('the settings of a saved file', () => {
  it('start with ads, trackers and cookie banners blocked, cosmetic filtering on, and are filled in for an older save', () => {
    const settings = defaultSettings()
    expect(settings).toMatchObject({ blockAds: true, blockTrackers: true, blockCookieBanners: true, blockCosmetic: true, filterUpdateDays: 4, disabledFilterLists: [], blockExceptions: [] })
    const old = createInitialState(ctx)
    const { blockExceptions: _a, blockCosmetic: _b, filterUpdateDays: _c, disabledFilterLists: _d, ...legacy } = old.settings
    const loaded = normalize({ ...old, settings: legacy as typeof old.settings })
    expect(loaded.settings).toMatchObject({ blockCosmetic: true, filterUpdateDays: 4, disabledFilterLists: [], blockExceptions: [] })
  })

  it('drops what a hand-edited file got wrong', () => {
    const state = createInitialState(ctx)
    const broken = { ...state, settings: { ...state.settings, blockExceptions: ['Exemple.org', 'x y', 5], filterUpdateDays: -2, disabledFilterLists: ['../etc', 'easylist'] } }
    expect(normalize(broken as typeof state).settings).toMatchObject({ blockExceptions: ['exemple.org'], filterUpdateDays: 4, disabledFilterLists: ['easylist'] })
  })

  it('are cleaned when the settings window changes them', () => {
    const next = run(createInitialState(ctx), { type: 'settings/update', patch: { blockExceptions: ['A.test', 'a.test', 'bad host'], filterUpdateDays: 400 } })
    expect(next.settings.blockExceptions).toEqual(['a.test'])
    expect(next.settings.filterUpdateDays).toBe(4)
  })
})

describe('in a private window', () => {
  it('the site switch works for that window, and the other blocking settings stay the main window\'s', () => {
    const action: Action = { type: 'blocking/exempt-site', site: 'exemple.org', exempt: true }
    expect(privateAction(action)).toEqual(action)
    expect(privateAction({ type: 'settings/update', patch: { blockExceptions: ['x.test'], blockAds: true } })).toBeNull()
  })
})
