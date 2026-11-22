// The sheets a launch opens by itself: the welcome once, never over a state that existed; the news once per version, never at the first launch.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayRequest } from '@shared/ipc'
import { defaultSettings } from '@shared/model'
import { LAUNCH_SHEET_DELAY_MS, scheduleLaunchSheet, showLaunchSheet, whatsNewRequest } from './launch-sheets'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')) as { version: string }

function launch(patch: Partial<ReturnType<typeof defaultSettings>>, version = '0.2.0', newProfile = false) {
  let settings = { ...defaultSettings(), ...patch }
  const opened: OverlayRequest[] = []
  const update = vi.fn((next: Partial<typeof settings>) => void (settings = { ...settings, ...next }))
  const result = showLaunchSheet({ newProfile, settings: () => settings, update, open: (request) => opened.push(request) }, version)
  return { result, opened, update, settings: () => settings }
}

describe('the first launch', () => {
  it('opens the legacy welcome sheet for a fresh profile whose guide is already noted as shown', () => {
    const run = launch({ welcomeDone: false, firstLaunchDone: true, lastSeenVersion: '' }, '0.2.0', true)
    expect(run.result).toBe('welcome')
    expect(run.opened).toEqual([{ panel: 'welcome' }])
    expect(run.settings()).toMatchObject({ welcomeDone: true, lastSeenVersion: '0.2.0' })
  })

  it('has no switch: a new profile gets the guide even when its settings carry the switch that used to turn it off', () => {
    const stale = { firstLaunchGuide: false } as Partial<ReturnType<typeof defaultSettings>>
    const run = launch(stale, '0.2.0', true)
    expect(run.result).toBe('firstlaunch')
    expect(run.opened).toEqual([{ panel: 'firstlaunch' }])
  })

  it('opens the first-launch guide by itself on a new profile, with the defaults, and only once', () => {
    const run = launch({}, '0.2.0', true)
    expect(run.result).toBe('firstlaunch')
    expect(run.opened).toEqual([{ panel: 'firstlaunch' }])
    // Noted at once: neither the guide, nor the welcome, nor the news of this version comes at the next launch.
    expect(run.settings()).toMatchObject({ firstLaunchDone: true, welcomeDone: true, lastSeenVersion: '0.2.0' })
    const next: OverlayRequest[] = []
    expect(showLaunchSheet({ newProfile: false, settings: run.settings, update: run.update, open: (request) => next.push(request) }, '0.2.0')).toBeNull()
    expect(next).toEqual([])
    // Even if the next launch were taken for a new one (a state file that could not be written), the flag holds.
    expect(showLaunchSheet({ newProfile: true, settings: run.settings, update: run.update, open: (request) => next.push(request) }, '0.2.0')).toBeNull()
    expect(next).toEqual([])
  })

  it('never opens the guide by itself on an existing profile, whatever its file says (an older file has none of the flags)', () => {
    for (const patch of [{}, { firstLaunchDone: false, welcomeDone: false, lastSeenVersion: '' }, { firstLaunchDone: false, lastSeenVersion: '0.1.0' }]) {
      const run = launch(patch, '0.2.0', false)
      expect(run.result, JSON.stringify(patch)).not.toBe('firstlaunch')
      expect(run.opened.map((request) => request.panel), JSON.stringify(patch)).not.toContain('firstlaunch')
      expect(run.settings().firstLaunchDone, JSON.stringify(patch)).toBe(patch.firstLaunchDone ?? false)
    }
  })

  it('does not open the news in the same launch when the state is still fresh', () => {
    expect(launch({ welcomeDone: false, firstLaunchDone: true, lastSeenVersion: '' }, '0.2.0', true).opened.map((request) => request.panel)).toEqual(['welcome'])
  })

  // A file written before these flags existed has neither `lastSeenVersion` nor `welcomeDone` (both read as their defaults: '' and false). It is a profile that was used.
  it('opens neither the welcome nor the guide on an existing profile whose file is older than the flags, and only notes the version', () => {
    for (const patch of [{}, { welcomeDone: false, lastSeenVersion: '' }, { welcomeDone: false, firstLaunchDone: false, lastSeenVersion: '' }]) {
      const run = launch(patch, '0.2.0', false)
      expect(run.result, JSON.stringify(patch)).toBeNull()
      expect(run.opened, JSON.stringify(patch)).toEqual([])
      expect(run.settings().lastSeenVersion, JSON.stringify(patch)).toBe('0.2.0')
      expect(run.settings().welcomeDone, JSON.stringify(patch)).toBe(false)
    }
  })
})

describe('an update', () => {
  it('opens the news once: the version is noted, so the next launch has nothing to show', () => {
    const run = launch({ lastSeenVersion: '0.1.0' })
    expect(run.result).toBe('whatsnew')
    expect(run.opened).toHaveLength(1)
    expect(run.opened[0]).toMatchObject({ panel: 'whatsnew', sheet: { version: '0.2.0', fromUpdate: true } })
    expect(run.settings().lastSeenVersion).toBe('0.2.0')
    expect(showLaunchSheet({ newProfile: false, settings: run.settings, update: run.update, open: () => undefined }, '0.2.0')).toBeNull()
  })

  it('opens nothing and writes nothing when the function is off', () => {
    const run = launch({ lastSeenVersion: '0.1.0', whatsNewSheet: false })
    expect(run.result).toBeNull()
    expect(run.opened).toEqual([])
    expect(run.update).not.toHaveBeenCalled()
  })

  it('updates the version without opening anything when the state has none recorded yet and the update sheet is not relevant yet', () => {
    const run = launch({ welcomeDone: false, firstLaunchDone: true, lastSeenVersion: '' })
    expect(run.result).toBeNull()
    expect(run.opened).toEqual([])
    expect(run.settings().lastSeenVersion).toBe('0.2.0')
  })

  it('speaks the language of the interface: the French changelog in French, the English one otherwise, with the same changes', () => {
    const pointsOf = (version: string, language: 'fr' | 'en') => (whatsNewRequest(version, false, language) as Extract<OverlayRequest, { panel: 'whatsnew' }>).sheet.points
    // The title check is pinned to a released section: it must not move with every version bump of package.json.
    expect(pointsOf('1.0.0', 'fr')[0]?.title).toBe('Nouveau départ sous le nom Lucium')
    expect(pointsOf('1.0.0', 'en')[0]?.title).toBe('A fresh start under the name Lucium')
    const points = (language: 'fr' | 'en') => pointsOf(pkg.version, language)
    expect(points('fr').length).toBe(points('en').length)
    expect(points('fr').every((point) => !/^[,;:(]/.test(point.text))).toBe(true)
    // Every line of the shipped changelogs shows whole: none ends cut with "…".
    expect([...points('fr'), ...points('en')].filter((point) => point.text.endsWith('…'))).toEqual([])
  })

  it('shows the section being prepared whole as well, in both languages: a build ahead of its notes reads « [Unreleased] »', () => {
    // A version no section names falls back to « [Unreleased] » (shared/whats-new.ts); without one, there is nothing to read and nothing to check.
    const ahead = (language: 'fr' | 'en') => (whatsNewRequest('999.0.0', false, language) as Extract<OverlayRequest, { panel: 'whatsnew' }>).sheet.points
    expect(ahead('fr').length).toBe(ahead('en').length)
    expect([...ahead('fr'), ...ahead('en')].filter((point) => point.text.endsWith('…') || point.title.endsWith('…'))).toEqual([])
  })

  it('carries the changelog shipped with the application, for Aide › Nouveautés too (without "Ne plus montrer")', () => {
    const request = whatsNewRequest('0.2.0', false)
    expect(request).toMatchObject({ panel: 'whatsnew', sheet: { version: '0.2.0', fromUpdate: false } })
    expect((request as Extract<OverlayRequest, { panel: 'whatsnew' }>).sheet.points.length).toBeGreaterThan(0)
  })
})

describe('the timer of the launch sheet', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** A window and the layer of its panels, as the timer reads them. `show` stands for the opening of the panel: on a destroyed window, Electron throws. */
  function target(start: { loading: boolean }) {
    const state = { gone: false, loading: start.loading, loaded: [] as Array<() => void> }
    const show = vi.fn(() => {
      if (state.gone) throw new TypeError('Object has been destroyed')
    })
    scheduleLaunchSheet({ windowGone: () => state.gone, layerLoading: () => state.loading, onceLayerLoaded: (listener) => void state.loaded.push(listener) }, show)
    return { state, show }
  }

  it('shows the sheet once the delay has passed, on a window that is still there', () => {
    const { show } = target({ loading: false })
    vi.advanceTimersByTime(LAUNCH_SHEET_DELAY_MS - 1)
    expect(show).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('opens nothing on a window destroyed before the delay has passed, and throws nothing', () => {
    const { state, show } = target({ loading: false })
    state.gone = true
    expect(() => vi.advanceTimersByTime(LAUNCH_SHEET_DELAY_MS)).not.toThrow()
    expect(show).not.toHaveBeenCalled()
  })

  it('waits for the layer of the panels to draw its first page, then for the delay; a window destroyed in between gets nothing', () => {
    const waiting = target({ loading: true })
    vi.advanceTimersByTime(LAUNCH_SHEET_DELAY_MS * 10)
    expect(waiting.show).not.toHaveBeenCalled()
    expect(waiting.state.loaded).toHaveLength(1)
    waiting.state.loaded[0]!()
    vi.advanceTimersByTime(LAUNCH_SHEET_DELAY_MS)
    expect(waiting.show).toHaveBeenCalledTimes(1)

    const closed = target({ loading: true })
    closed.state.loaded[0]!()
    closed.state.gone = true
    expect(() => vi.advanceTimersByTime(LAUNCH_SHEET_DELAY_MS)).not.toThrow()
    expect(closed.show).not.toHaveBeenCalled()
  })
})

// « Reprendre où vous en étiez ? »: the launch that follows an abnormal exit (shell/clean-exit.ts), when no other sheet takes the launch.
describe('the sheet of the restore after an abnormal exit', () => {
  function afterRun(recovery: { abnormal: boolean; offerable?: number; appLocked?: boolean }, patch: Partial<ReturnType<typeof defaultSettings>> = {}, newProfile = false) {
    const settings = { ...defaultSettings(), ...patch }
    const opened: OverlayRequest[] = []
    const result = showLaunchSheet(
      { newProfile, settings: () => settings, update: () => {}, open: (request) => opened.push(request), recovery: { abnormal: recovery.abnormal, offerable: () => recovery.offerable ?? 3, appLocked: () => recovery.appLocked === true } },
      '0.2.0'
    )
    return { result, opened }
  }
  // A profile that was used and has seen this version: no sheet of its own takes the launch.
  const SEEN = { welcomeDone: true, firstLaunchDone: true, lastSeenVersion: '0.2.0' }

  it('opens after an abnormal exit, over a profile that was used, when there are tabs to choose among', () => {
    const run = afterRun({ abnormal: true }, SEEN)
    expect(run.result).toBe('restore')
    expect(run.opened).toEqual([{ panel: 'restore' }])
  })

  it('does not open after a clean exit, and does not even count the tabs', () => {
    const offerable = vi.fn(() => 3)
    const opened: OverlayRequest[] = []
    const result = showLaunchSheet({ newProfile: false, settings: () => ({ ...defaultSettings(), ...SEEN }), update: () => {}, open: (request) => opened.push(request), recovery: { abnormal: false, offerable, appLocked: () => false } }, '0.2.0')
    expect(result).toBeNull()
    expect(opened).toEqual([])
    expect(offerable).not.toHaveBeenCalled()
  })

  it('does not open over a new profile, over the lock screen, or with fewer than two tabs', () => {
    expect(afterRun({ abnormal: true }, { firstLaunchDone: true, welcomeDone: true, lastSeenVersion: '' }, true).opened.map((request) => request.panel)).not.toContain('restore')
    expect(afterRun({ abnormal: true, appLocked: true }, SEEN).opened).toEqual([])
    expect(afterRun({ abnormal: true, offerable: 1 }, SEEN).opened).toEqual([])
  })

  it('leaves the launch to the news of an update: one sheet at a time', () => {
    const run = afterRun({ abnormal: true }, { welcomeDone: true, firstLaunchDone: true, lastSeenVersion: '0.1.0', whatsNewSheet: true })
    expect(run.opened.map((request) => request.panel)).not.toContain('restore')
  })

  it('is not there for a launch that has no sign to read (the engine test)', () => {
    const opened: OverlayRequest[] = []
    expect(showLaunchSheet({ newProfile: false, settings: () => ({ ...defaultSettings(), ...SEEN }), update: () => {}, open: (request) => opened.push(request) }, '0.2.0')).toBeNull()
    expect(opened).toEqual([])
  })
})
