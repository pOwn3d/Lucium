// The rule of the automatic Picture in Picture, on made-up videos: only a video being watched floats by itself when its tab is left, and a site
// where the user closed the floating window twice gets no more of it for the session.

import { describe, expect, it } from 'vitest'
import { AUTO_PIP_CLOSES_PER_SITE, AUTO_PIP_MIN_BOX, AUTO_PIP_MIN_CALL_TILE, AUTO_PIP_MIN_PLAYED_SECONDS, AutoPipMemory, autoFloatVerdict, autoWindowWasClosed, floatingOnReturn, type WatchedVideoFacts } from './auto-pip'
import { en } from './i18n-en'
import { fr } from './i18n-fr'

/** A film watched with sound, in a player of the usual size, for a minute already. */
const watched: WatchedVideoFacts = { playing: true, muted: false, volume: 1, audio: true, width: 854, height: 480, playedSeconds: 60 }
const video = (facts: Partial<WatchedVideoFacts>): WatchedVideoFacts => ({ ...watched, ...facts })

describe('a video that floats by itself when its tab is left', () => {
  it('is one watched with sound', () => {
    expect(autoFloatVerdict(watched)).toBe('float')
    // The page cannot always tell whether it has an audio track: it is given the benefit of the doubt.
    expect(autoFloatVerdict(video({ audio: null }))).toBe('float')
    // A vertical video counts as well.
    expect(autoFloatVerdict(video({ width: 405, height: 720 }))).toBe('float')
  })

  it('is not the muted loop at the back of a page', () => {
    expect(autoFloatVerdict(video({ muted: true, width: 1440, height: 810, playedSeconds: 300 }))).toBe('silent')
    // A decorative loop is often not muted but has no sound at all.
    expect(autoFloatVerdict(video({ audio: false, width: 1440, height: 810, playedSeconds: 300 }))).toBe('silent')
  })

  it('is not a short ad in the column of an article, played muted in its box', () => {
    expect(autoFloatVerdict(video({ muted: true, width: 300, height: 250, playedSeconds: 8 }))).toBe('silent')
    // Even with its sound on, a box of an ad is too small.
    expect(autoFloatVerdict(video({ width: 300, height: 250, playedSeconds: 8 }))).toBe('small')
  })

  it('is not a video turned down to nothing', () => {
    expect(autoFloatVerdict(video({ volume: 0 }))).toBe('silent')
  })

  it('is not a tiny one (a preview, an avatar) nor one hidden to carry a sound', () => {
    expect(autoFloatVerdict(video({ width: 160, height: 90 }))).toBe('small')
    expect(autoFloatVerdict(video({ width: 0, height: 0 }))).toBe('small')
    expect(autoFloatVerdict(video({ width: AUTO_PIP_MIN_BOX.long - 1, height: AUTO_PIP_MIN_BOX.short }))).toBe('small')
    expect(autoFloatVerdict(video({ width: AUTO_PIP_MIN_BOX.long, height: AUTO_PIP_MIN_BOX.short - 1 }))).toBe('small')
    expect(autoFloatVerdict(video({ width: AUTO_PIP_MIN_BOX.long, height: AUTO_PIP_MIN_BOX.short }))).toBe('float')
    expect(autoFloatVerdict(video({ width: AUTO_PIP_MIN_BOX.short, height: AUTO_PIP_MIN_BOX.long }))).toBe('float')
  })

  it('is the feed of a video call, muted and without an audio track of its own: the call plays its sound through other elements', () => {
    expect(autoFloatVerdict(video({ live: true, muted: true, audio: false }))).toBe('float')
    expect(autoFloatVerdict(video({ live: true, muted: true, audio: false, width: 240, height: 135 }))).toBe('float')
    expect(autoFloatVerdict(video({ live: true, muted: true, audio: false, width: 120, height: 68 }))).toBe('small')
    expect(autoFloatVerdict(video({ live: true, width: AUTO_PIP_MIN_CALL_TILE.long, height: AUTO_PIP_MIN_CALL_TILE.short }))).toBe('float')
    expect(autoFloatVerdict(video({ live: true, width: AUTO_PIP_MIN_CALL_TILE.long - 1, height: AUTO_PIP_MIN_CALL_TILE.short }))).toBe('small')
    expect(autoFloatVerdict(video({ muted: true, audio: false }))).toBe('silent')
  })

  it('is not a paused one, whatever else it has', () => {
    expect(autoFloatVerdict(video({ playing: false }))).toBe('paused')
    expect(autoFloatVerdict(video({ playing: false, muted: true, width: 10, height: 10 }))).toBe('paused')
  })

  it('is not one that has only just started: a page opened and left at once', () => {
    expect(autoFloatVerdict(video({ playedSeconds: AUTO_PIP_MIN_PLAYED_SECONDS - 0.01 }))).toBe('just-started')
    expect(autoFloatVerdict(video({ playedSeconds: AUTO_PIP_MIN_PLAYED_SECONDS }))).toBe('float')
  })

  it('is decided by a function the page can run from its source alone (the page script carries it)', () => {
    const inPage = new Function(`return ${autoFloatVerdict.toString()}`)() as typeof autoFloatVerdict
    for (const facts of [watched, video({ muted: true }), video({ width: 300, height: 250 }), video({ playedSeconds: 1 }), video({ playing: false })]) {
      expect(inPage(facts)).toBe(autoFloatVerdict(facts))
    }
  })

  it('is described in the setting with the numbers of the rule', () => {
    for (const text of [fr['features.une-video-que-vous-regardez-flotte-dans'], en['features.une-video-que-vous-regardez-flotte-dans']]) {
      expect(text).toContain(`${AUTO_PIP_MIN_PLAYED_SECONDS} `)
      expect(text).toContain(`${AUTO_PIP_MIN_BOX.long} × ${AUTO_PIP_MIN_BOX.short}`)
    }
  })
})

describe('the sites where the floating window was closed', () => {
  it('get no more of it for the session once it was closed twice', () => {
    const memory = new AutoPipMemory()
    expect(AUTO_PIP_CLOSES_PER_SITE).toBe(2)
    for (let time = 1; time <= AUTO_PIP_CLOSES_PER_SITE; time++) {
      expect(memory.allows('videos.example')).toBe(true)
      memory.floated('tab-1', 'videos.example')
      // The tab comes back and its video no longer floats: the user closed the window meanwhile.
      const site = memory.returning('tab-1')
      expect(site).toBe('videos.example')
      memory.closed(site!)
    }
    expect(memory.allows('videos.example')).toBe(false)
    // Another site is not concerned, and a new session starts afresh.
    expect(memory.allows('news.example')).toBe(true)
    expect(new AutoPipMemory().allows('videos.example')).toBe(true)
  })

  it('only count a window the rule opened, for the tab that comes back, once', () => {
    const memory = new AutoPipMemory()
    expect(memory.returning('tab-1')).toBeNull()
    memory.floated('tab-1', 'videos.example')
    expect(memory.returning('tab-2')).toBeNull()
    expect(memory.returning('tab-1')).toBe('videos.example')
    expect(memory.returning('tab-1')).toBeNull()
  })

  it('do not count a window that a picture asked for by hand replaced', () => {
    const memory = new AutoPipMemory()
    memory.floated('tab-1', 'videos.example')
    memory.floatedByHand()
    expect(memory.returning('tab-1')).toBeNull()
  })

  it('do not count a window that another tab left took over', () => {
    const memory = new AutoPipMemory()
    memory.floated('tab-1', 'videos.example')
    memory.floated('tab-2', 'films.example')
    expect(memory.returning('tab-1')).toBeNull()
    expect(memory.returning('tab-2')).toBe('films.example')
  })
})

describe('Lucium’s floating window when the tab it shows comes back', () => {
  it('goes back to the tab when the automatic picture opened it, comes back in front when it was asked for by hand, and is left alone when there is none', () => {
    expect(floatingOnReturn('twitch.tv', true)).toBe('release')
    expect(floatingOnReturn(null, true)).toBe('show')
    expect(floatingOnReturn('twitch.tv', false)).toBe('none')
    expect(floatingOnReturn(null, false)).toBe('none')
  })

  it('does not count a window that gave its video back as one the user closed, but counts one that is gone', () => {
    expect(autoWindowWasClosed('twitch.tv', true, false)).toBe(false)
    expect(autoWindowWasClosed('twitch.tv', false, true)).toBe(false)
    expect(autoWindowWasClosed('twitch.tv', false, false)).toBe(true)
    expect(autoWindowWasClosed(null, false, false)).toBe(false)
  })
})
