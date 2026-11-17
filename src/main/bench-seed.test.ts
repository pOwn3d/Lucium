import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { luciumSeedState, readStateVersion } from '@shared/bench-core'
import { STATE_VERSION } from '@shared/model'
import { parseSavedState } from '@shared/sidebar'

// The state file that scripts/compare-browsers.mjs puts in the throw-away profile it gives Lucium. It lives in src/main because it reads
// the source of the model, which the web project (no Node types) does not compile.

describe('the profile given to Lucium', () => {
  it('finds the version of the state in the source of the model, which is where the script reads it', () => {
    const source = readFileSync(new URL('../shared/model.ts', import.meta.url), 'utf8')
    expect(readStateVersion(source)).toBe(STATE_VERSION)
    expect(readStateVersion('export const STATE_VERSION = 7\n')).toBe(7)
    expect(readStateVersion('const STATE_VERSION = 7\n')).toBeNull()
    expect(readStateVersion('export const STATE_VERSION = 1 as const')).toBeNull()
  })

  it('is a state the application accepts as it is: one space, no tab, outside links open as tabs', () => {
    const state = parseSavedState(JSON.stringify(luciumSeedState(STATE_VERSION)))
    expect(state.settings.externalLinksInLittleArc).toBe(false)
    // A run of the bench reads no feed of versions: the site would count it as a check by a person.
    expect(state.settings.autoUpdate).toBe(false)
    expect(state.tabs).toEqual([])
    expect(state.spaces).toHaveLength(1)
    expect(state.spaces[0]?.id).toBe('banc')
    expect(state.activeSpaceId).toBe('banc')
    // Every other setting is the application's own default.
    expect(state.settings.sleepAfterMinutes).toBe(30)
  })

  it('is refused with the wrong version, which is how a change of the format is noticed', () => {
    expect(() => parseSavedState(JSON.stringify(luciumSeedState(STATE_VERSION + 1)))).toThrow(/version/)
  })
})
