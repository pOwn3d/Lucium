// Autoplay: the mode a page gets, what a saved choice may hold, and when a page must be built again.

import { describe, expect, it } from 'vitest'
import {
  AUTOPLAY_LABELS,
  AUTOPLAY_MODES,
  AUTOPLAY_REBUILD_GAP_MS,
  DEFAULT_AUTOPLAY,
  SITE_AUTOPLAY_MAX,
  autoplayKeyOf,
  autoplayModeFor,
  cleanAutoplayPolicy,
  cleanSiteAutoplay,
  mustRebuildForAutoplay,
  siteAutoplayOf,
  withSiteAutoplay,
  type AutoplayMode
} from './autoplay'
import { defaultSettings, type Settings } from './model'
import { privateAction } from './private-window'
import { createInitialState, reduce, type Action } from './sidebar'

const ctx = { now: 1, newId: () => 'id' }
const run = (state: ReturnType<typeof createInitialState>, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)

describe('the general choice', () => {
  it('is Chromium\'s policy by default, never Electron\'s looser one', () => {
    expect(DEFAULT_AUTOPLAY).toBe('block')
    expect(defaultSettings()).toMatchObject({ autoplayPolicy: 'block', siteAutoplay: {} })
    expect(AUTOPLAY_MODES).toEqual(['block', 'allow'])
    for (const mode of AUTOPLAY_MODES) expect(AUTOPLAY_LABELS[mode].name.length).toBeGreaterThan(0)
  })

  it('falls back to Chromium\'s policy for a word it does not know: a damaged file never lets sound start by itself', () => {
    expect(cleanAutoplayPolicy('allow')).toBe('allow')
    for (const bad of ['no-user-gesture-required', 'ALLOW', '', 5, null, undefined, {}, ['allow']]) expect(cleanAutoplayPolicy(bad), String(bad)).toBe('block')
  })
})

describe('the key of a site', () => {
  it('is its host without "www.", from an address or from what was typed', () => {
    expect(autoplayKeyOf('https://www.Example.com/a?b=1')).toBe('example.com')
    expect(autoplayKeyOf('music.example.org')).toBe('music.example.org')
    expect(autoplayKeyOf('  exemple.org ')).toBe('exemple.org')
  })

  it('is nothing for what is not a web host', () => {
    for (const bad of ['', 'pas un hôte', 'about:blank', 'file:///tmp/a.html', 'chrome-extension://abc/p.html', 42, null, undefined]) expect(autoplayKeyOf(bad), String(bad)).toBeNull()
  })
})

describe('the choices of a saved file', () => {
  it('keeps a site written any way under its key, and drops an unknown mode, an invalid host and a prototype key', () => {
    const raw = JSON.parse('{"Example.com":"allow","www.news.example":"block","ok.example":"always","a b":"allow","bad.example":5,"__proto__":"allow","constructor":"block"}')
    expect(cleanSiteAutoplay(raw)).toStrictEqual({ 'example.com': 'allow', 'news.example': 'block', constructor: 'block' })
    for (const bad of [null, [], 'allow', 5, undefined]) expect(cleanSiteAutoplay(bad)).toEqual({})
  })

  it('is bounded', () => {
    const many = Object.fromEntries(Array.from({ length: SITE_AUTOPLAY_MAX + 10 }, (_, i) => [`site${i}.example`, 'allow']))
    expect(Object.keys(cleanSiteAutoplay(many))).toHaveLength(SITE_AUTOPLAY_MAX)
  })

  it('remembers a choice, changes it, and forgets it (the site follows the general choice again)', () => {
    const on = withSiteAutoplay({}, 'https://www.Example.com/x', 'allow')
    expect(on).toEqual({ 'example.com': 'allow' })
    expect(withSiteAutoplay(on, 'example.com', 'block')).toEqual({ 'example.com': 'block' })
    expect(withSiteAutoplay(on, 'example.com', null)).toEqual({})
    expect(on).toEqual({ 'example.com': 'allow' })
  })

  it('refuses a mode it does not know, a site that is not one, and a list that is full', () => {
    const on = { 'example.com': 'allow' } as const
    expect(withSiteAutoplay(on, 'example.com', 'always')).toEqual(on)
    expect(withSiteAutoplay(on, 'pas un hôte', 'block')).toEqual(on)
    const full = Object.fromEntries(Array.from({ length: SITE_AUTOPLAY_MAX }, (_, i) => [`site${i}.example`, 'allow' as const]))
    expect(withSiteAutoplay(full, 'nouveau.example', 'block')).toEqual(full)
    expect(withSiteAutoplay(full, 'site3.example', 'block')['site3.example']).toBe('block')
  })
})

describe('the mode of a page', () => {
  const choices = { 'example.com': 'allow', 'quiet.example.com': 'block' } as const

  it('is its site\'s choice, a parent domain\'s, else the general one; the nearest domain wins', () => {
    expect(siteAutoplayOf(choices, 'https://example.com/')).toBe('allow')
    expect(siteAutoplayOf(choices, 'https://www.example.com/')).toBe('allow')
    expect(siteAutoplayOf(choices, 'https://music.example.com/')).toBe('allow')
    expect(siteAutoplayOf(choices, 'https://quiet.example.com/a')).toBe('block')
    expect(siteAutoplayOf(choices, 'https://deep.quiet.example.com/')).toBe('block')
    expect(siteAutoplayOf(choices, 'https://other.org/')).toBeNull()
    expect(siteAutoplayOf(choices, 'https://notexample.com/')).toBeNull()
    expect(siteAutoplayOf(choices, 'about:blank')).toBeNull()
  })

  it('reads own keys only: a site called "constructor" or "toString" is not a choice', () => {
    expect(siteAutoplayOf({}, 'https://constructor/')).toBeNull()
    expect(siteAutoplayOf({}, 'https://tostring.example/')).toBeNull()
    expect(siteAutoplayOf({}, 'https://hasownproperty/')).toBeNull()
  })

  it('follows the general choice for a site without one, and the site\'s own choice over it', () => {
    expect(autoplayModeFor({ autoplayPolicy: 'block', siteAutoplay: choices }, 'https://example.com/')).toBe('allow')
    expect(autoplayModeFor({ autoplayPolicy: 'allow', siteAutoplay: choices }, 'https://quiet.example.com/')).toBe('block')
    expect(autoplayModeFor({ autoplayPolicy: 'allow', siteAutoplay: choices }, 'https://other.org/')).toBe('allow')
    expect(autoplayModeFor({ autoplayPolicy: 'block', siteAutoplay: {} }, 'https://other.org/')).toBe('block')
  })

  // « Un réglage pour chaque site » is gone: a state file that kept it off no longer hides the choices of the sites, which the Settings list and the
  // site panel offers.
  it('applies the choice of a site even in a state file that kept the old switch of the per-site choices off', () => {
    const kept: Settings = { ...defaultSettings(), autoplayPerSite: false, autoplayPolicy: 'block', siteAutoplay: choices }
    expect(autoplayModeFor(kept, 'https://example.com/')).toBe('allow')
    expect(autoplayModeFor({ ...kept, autoplayPolicy: 'allow' }, 'https://quiet.example.com/')).toBe('block')
    expect(autoplayModeFor(kept, 'https://other.org/')).toBe('block')
  })
})

describe('the action behind the site panel', () => {
  it('sets, changes and clears the choice of a site, and changes nothing for a doubt', () => {
    const start = createInitialState(ctx)
    const allowed = run(start, { type: 'autoplay/site', site: 'https://www.example.com/page', mode: 'allow' })
    expect(allowed.settings.siteAutoplay).toEqual({ 'example.com': 'allow' })
    expect(run(allowed, { type: 'autoplay/site', site: 'example.com', mode: 'allow' })).toBe(allowed)
    expect(run(allowed, { type: 'autoplay/site', site: 'example.com', mode: 'block' }).settings.siteAutoplay).toEqual({ 'example.com': 'block' })
    expect(run(allowed, { type: 'autoplay/site', site: 'example.com', mode: null }).settings.siteAutoplay).toEqual({})
    expect(run(start, { type: 'autoplay/site', site: 'pas un hôte', mode: 'allow' })).toBe(start)
    expect(run(start, { type: 'autoplay/site', site: 'example.com', mode: null })).toBe(start)
    const forged = { type: 'autoplay/site', site: 'example.com', mode: 'always' } as unknown as Action
    expect(run(start, forged)).toBe(start)
  })

  // 1.0.1 reads the choices of the sites only while its switch « Un réglage pour chaque site » is on. This version reads no such switch, so a choice made
  // here must leave it on in the file, or the version that reads the file again does not apply the choice.
  describe('for a file that is read again by 1.0.1', () => {
    const url = 'https://video.example/watch'
    /** What 1.0.1 does with the same settings (`autoplayModeFor` of that version). */
    const modeOf101 = ({ autoplayPerSite, siteAutoplay, autoplayPolicy }: Settings): AutoplayMode => (autoplayPerSite ? siteAutoplayOf(siteAutoplay, url) : null) ?? autoplayPolicy
    const withSwitchOff = (): ReturnType<typeof createInitialState> => run(createInitialState(ctx), { type: 'settings/update', patch: { autoplayPerSite: false } })

    it('leaves the old switch on when a choice is made, so that 1.0.1 applies it as this version does', () => {
      const start = withSwitchOff()
      expect(start.settings.autoplayPerSite).toBe(false)
      const allowed = run(start, { type: 'autoplay/site', site: url, mode: 'allow' })
      expect(autoplayModeFor(allowed.settings, url)).toBe('allow')
      expect(allowed.settings.autoplayPerSite).toBe(true)
      expect(modeOf101(allowed.settings)).toBe('allow')
    })

    it('does so for a choice that was already there as well, and for the removal of one that leaves others', () => {
      const hidden = { ...withSwitchOff(), settings: { ...withSwitchOff().settings, siteAutoplay: { 'video.example': 'allow', 'other.example': 'allow' } as Record<string, AutoplayMode> } }
      expect(run(hidden, { type: 'autoplay/site', site: 'video.example', mode: 'allow' }).settings.autoplayPerSite).toBe(true)
      expect(run(hidden, { type: 'autoplay/site', site: 'other.example', mode: null }).settings.autoplayPerSite).toBe(true)
    })

    it('leaves the key as it is when no choice is left, or when nothing changes, and changes nothing else in the settings', () => {
      const start = withSwitchOff()
      expect(run(start, { type: 'autoplay/site', site: url, mode: null })).toBe(start)
      const added = run(start, { type: 'autoplay/site', site: url, mode: 'allow' })
      const cleared = run(added, { type: 'autoplay/site', site: url, mode: null })
      expect(cleared.settings).toEqual({ ...start.settings, autoplayPerSite: true })
      expect(added.settings).toEqual({ ...start.settings, autoplayPerSite: true, siteAutoplay: { 'video.example': 'allow' } })
      // A profile whose switch was never off keeps it on, with the same state as before.
      const fresh = createInitialState(ctx)
      expect(run(fresh, { type: 'autoplay/site', site: url, mode: 'allow' }).settings).toEqual({ ...fresh.settings, siteAutoplay: { 'video.example': 'allow' } })
    })
  })

  it('is let through by a private window, whose choices last as long as it does', () => {
    const action: Action = { type: 'autoplay/site', site: 'example.com', mode: 'allow' }
    expect(privateAction(action)).toEqual(action)
  })
})

describe('building a page again for another mode', () => {
  const now = 100_000
  it('does nothing while the mode is the one the page was made with, or while it is not known', () => {
    expect(mustRebuildForAutoplay({ applied: 'block', wanted: 'block', lastRebuildAt: undefined, now })).toBe(false)
    expect(mustRebuildForAutoplay({ applied: undefined, wanted: 'allow', lastRebuildAt: undefined, now })).toBe(false)
  })

  it('rebuilds when the site wants another mode', () => {
    expect(mustRebuildForAutoplay({ applied: 'block', wanted: 'allow', lastRebuildAt: undefined, now })).toBe(true)
    expect(mustRebuildForAutoplay({ applied: 'allow', wanted: 'block', lastRebuildAt: now - AUTOPLAY_REBUILD_GAP_MS, now })).toBe(true)
  })

  it('does not rebuild again within the gap: two sites that send each other to the other would rebuild the page for ever', () => {
    expect(mustRebuildForAutoplay({ applied: 'block', wanted: 'allow', lastRebuildAt: now - 1, now })).toBe(false)
    expect(mustRebuildForAutoplay({ applied: 'block', wanted: 'allow', lastRebuildAt: now - AUTOPLAY_REBUILD_GAP_MS + 1, now })).toBe(false)
  })
})
