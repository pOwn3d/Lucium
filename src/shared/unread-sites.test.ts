// The "unread count" switch of a site: what the list keeps, which pages it covers, what the reducer and a saved file do with it.

import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { privateAction } from './private-window'
import { createInitialState, reduce, type Action } from './sidebar'
import { clampSettings } from './sidebar-state'
import { readUnread } from './tab-messages'
import { SITE_UNREAD_OFF_MAX, cleanSiteUnreadOff, isUnreadOff, withSiteUnreadOff } from './unread-sites'

let counter = 0
const ctx = { now: 1, newId: () => `id${++counter}` }
const run = (state: ReturnType<typeof createInitialState>, action: Action) => reduce(state, action, ctx)

describe('which pages the list covers', () => {
  it('covers a site whose title holds a count or a mark, and not the others (the global badge switch is not part of it)', () => {
    expect(readUnread('(3) Murmure', 'https://murmure.example/')).toEqual({ count: 3 })
    expect(readUnread('* Loic - Slack', 'https://app.slack.com/client/T1')).toEqual({ mark: '*' })
    expect(isUnreadOff(['murmure.example'], 'https://murmure.example/inbox')).toBe(true)
    expect(isUnreadOff(['slack.com'], 'https://app.slack.com/client/T1')).toBe(true)
    expect(isUnreadOff(['autre.example'], 'https://murmure.example/')).toBe(false)
    expect(isUnreadOff([], 'https://murmure.example/')).toBe(false)
    const start = createInitialState(ctx)
    expect(run(start, { type: 'unread/site', site: 'murmure.example', off: true }).settings.tabStateBadges).toBe(start.settings.tabStateBadges)
  })

  it('covers a subdomain and "www.", but not a neighbouring site', () => {
    const list = ['example.com']
    expect(isUnreadOff(list, 'https://example.com/')).toBe(true)
    expect(isUnreadOff(list, 'https://www.example.com/')).toBe(true)
    expect(isUnreadOff(list, 'https://mail.example.com/a')).toBe(true)
    expect(isUnreadOff(list, 'https://notexample.com/')).toBe(false)
    expect(isUnreadOff(list, 'https://example.com.evil.test/')).toBe(false)
    expect(isUnreadOff(list, 'https://example.org/')).toBe(false)
    expect(isUnreadOff(list, 'about:blank')).toBe(false)
    expect(isUnreadOff(['mail.example.com'], 'https://example.com/')).toBe(false)
  })
})

describe('the list in the state', () => {
  it('is empty by default, so that nothing changes for a site until it is turned off', () => {
    expect(defaultSettings().siteUnreadOff).toEqual([])
  })

  it('adds the site of a page under its canonical key, once, and takes it out again', () => {
    const start = createInitialState(ctx)
    const off = run(start, { type: 'unread/site', site: 'https://www.Murmure.example/inbox', off: true })
    expect(off.settings.siteUnreadOff).toEqual(['murmure.example'])
    expect(run(off, { type: 'unread/site', site: 'murmure.example', off: true })).toBe(off)
    // Turning it back on puts the site back: the next title shows the count again.
    expect(run(off, { type: 'unread/site', site: 'murmure.example', off: false }).settings.siteUnreadOff).toEqual([])
    expect(run(start, { type: 'unread/site', site: 'murmure.example', off: false })).toBe(start)
    expect(run(start, { type: 'unread/site', site: 'lucium://settings', off: true })).toBe(start)
  })

  it('treats anything but a real true as "shown again" (the interface is not trusted)', () => {
    const off = run(createInitialState(ctx), { type: 'unread/site', site: 'murmure.example', off: true })
    expect(run(off, { type: 'unread/site', site: 'autre.example', off: 'yes' } as unknown as Action)).toBe(off)
  })

  it('refuses one more site beyond the bound', () => {
    const full = Array.from({ length: SITE_UNREAD_OFF_MAX }, (_, i) => `s${i}.example`)
    expect(withSiteUnreadOff(full, 'plus.example', true)).toEqual(full)
    expect(withSiteUnreadOff(full, 's3.example', false)).toHaveLength(SITE_UNREAD_OFF_MAX - 1)
  })

  it('does not write the choice of a private tab', () => {
    const start = createInitialState(ctx)
    const tab = { ...start.tabs[0]!, id: 'private-tab', private: true }
    const withPrivate = { ...start, tabs: [...start.tabs, tab] }
    expect(run(withPrivate, { type: 'unread/site', site: 'murmure.example', off: true, tabId: 'private-tab' })).toBe(withPrivate)
  })

  it('is let through by a private window, whose store lives as long as the window', () => {
    const action: Action = { type: 'unread/site', site: 'murmure.example', off: true }
    expect(privateAction(action)).toEqual(action)
  })

  it('loads a state file without the key with the default (the count is shown)', () => {
    const { siteUnreadOff: _gone, ...old } = defaultSettings()
    expect(clampSettings(old as never).siteUnreadOff).toEqual([])
  })

  it('reads a saved file with only valid hosts, once each, under their canonical key', () => {
    expect(cleanSiteUnreadOff(['Murmure.EXAMPLE', 'www.murmure.example', 'pas un hôte', 'file:///tmp/a', 42, null])).toEqual(['murmure.example'])
    expect(cleanSiteUnreadOff('murmure.example')).toEqual([])
    const settings = clampSettings({ ...defaultSettings(), siteUnreadOff: ['Murmure.EXAMPLE', 7] } as never)
    expect(settings.siteUnreadOff).toEqual(['murmure.example'])
  })
})
