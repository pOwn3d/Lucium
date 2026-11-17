// The private context of a window and the containers get what the settings say of downloads, like the profiles: « Ouvrir sans conserver », the
// question of the place, and the downloads folder of the profile whose space holds the tab. The real `configurePrivateContext` of the shell runs
// on a stand-in for the window (browser-fake.test-support.ts).

import { describe, expect, it, vi } from 'vitest'
import type { Settings, SidebarState } from '@shared/model'
import { createInitialState, reduce } from '@shared/sidebar'
import type { DownloadPolicy } from '../engine/types'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

function contextOf(settings: Partial<Settings>) {
  let n = 0
  const ctx = { now: 1, newId: () => `id${++n}` }
  let state: SidebarState = reduce(createInitialState(ctx), { type: 'settings/update', patch: { privateTabs: true } }, ctx)
  state = reduce(state, { type: 'tab/open', url: 'https://prive.example/', private: true }, ctx)
  const tab = state.tabs.find((item) => item.private === true)!
  const profile = state.spaces.find((space) => space.id === tab.spaceId)!.profileId
  state = { ...state, settings: { ...state.settings, ...settings, profiles: { ...state.settings.profiles, [profile]: { ...state.settings.profiles[profile], downloadDir: '/Users/moi/Travail' } } } }
  let policy: DownloadPolicy | undefined
  let resolver: ((context: string, pageId?: string) => string | undefined) | undefined
  const scope = {
    setDownloadNamer: () => undefined,
    setRequestBlocker: () => undefined,
    setPrivacy: () => undefined,
    setDownloadPolicy: (given: DownloadPolicy) => void (policy = given),
    setDownloadDirResolver: (given: typeof resolver) => void (resolver = given)
  }
  const fake = fakeBrowser({ store: { get: () => state }, scopeGuards: new Map([[scope, { configure: () => undefined }]]), downloadPolicyOfSettings: shell['downloadPolicyOfSettings'], downloadDirOfTab: shell['downloadDirOfTab'] })
  fake.self['group'] = new Set([fake.self])
  shell['configurePrivateContext']!.call(fake.self, scope)
  return { policy: policy!, resolver: resolver!, tab }
}

describe('what a private context or a container is told of downloads', () => {
  it('« Ouvrir sans conserver » and the question of the place follow the settings, as they do for a profile', () => {
    const on = contextOf({ openUnsaved: true, downloadAskWhere: true })
    expect(on.policy.openUnsaved).toBe(true)
    expect(on.policy.ask).toBeTypeOf('function')
    const off = contextOf({ openUnsaved: false, downloadAskWhere: false })
    expect(off.policy).toEqual({ ask: null, openUnsaved: false })
  })

  it('a download goes to the folder of the profile whose space holds the tab it started from', () => {
    const w = contextOf({})
    expect(w.resolver('ephemeral:1', w.tab.id)).toBe('/Users/moi/Travail')
  })

  it('and to the folder of the system when no tab started it, or a tab that is gone', () => {
    const w = contextOf({})
    expect(w.resolver('ephemeral:1', undefined)).toBeUndefined()
    expect(w.resolver('ephemeral:1', 'tab-gone')).toBeUndefined()
  })
})
