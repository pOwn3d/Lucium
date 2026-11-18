// The iOS application (ios/) lets the person choose the search engine of a profile and writes the choice in the shared state file. The two sides are held
// together by ios/Contracts/search-vectors.json: this suite plays it against the Mac's own code (the list of engines, the editor the Settings window
// writes a profile's engine with, the reader of the saved overrides), and the Swift tests of LuciumKit play the same file against `chooseSearchEngine`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SEARCH_URL, SEARCH_ENGINES, defaultSettings } from '@shared/model-defaults'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { cleanProfileOverrides, profileSearch } from '@shared/profiles'
import { profileEditor } from './CurrentProfileSettings'

interface Vectors {
  engines: { name: string; url: string }[]
  choose: {
    name: string
    before: Partial<Pick<Settings, 'searchUrlTemplate' | 'profiles'>> | null
    profile: string
    choice: string
    after: { searchUrlTemplate: string; profiles: Settings['profiles'] }
    effective: string
  }[]
}

const vectors = JSON.parse(readFileSync(join(__dirname, '../../ios/Contracts/search-vectors.json'), 'utf8')) as Vectors

/** What the Settings window writes when the person picks an engine (or "Comme le profil par défaut") for a profile, applied to the settings it started from. */
function writtenByTheMac(before: Settings, profile: string, choice: string): Settings {
  let after = before
  const snapshot = { state: { settings: before } } as unknown as UiSnapshot
  const set = profileEditor(snapshot, (patch) => {
    after = { ...after, ...patch }
  })
  set(profile, { searchUrlTemplate: choice === 'inherited' ? undefined : choice })
  return after
}

describe('iOS contract: the search engine of a profile', () => {
  it('has vectors to run (an empty file would pass for nothing)', () => {
    expect(vectors.engines).toHaveLength(6)
    expect(vectors.choose.length).toBeGreaterThanOrEqual(8)
  })

  it('offers the engines of the Mac, in its order', () => {
    expect(vectors.engines).toEqual(SEARCH_ENGINES.map(({ name, url }) => ({ name, url })))
    expect(DEFAULT_SEARCH_URL).toBe(vectors.engines[0]!.url)
  })

  it.each(vectors.choose)('$name', ({ before, profile, choice, after, effective }) => {
    const start: Settings = { ...defaultSettings(), ...(before ?? {}) }
    const written = writtenByTheMac(start, profile, choice)
    // What the Mac writes is what the Swift side must write: the general engine and the overrides of the profiles.
    expect({ searchUrlTemplate: written.searchUrlTemplate, profiles: written.profiles }).toEqual(after)
    // The Mac reads the profile back with the engine the iPhone shows and searches with.
    expect(profileSearch(written, profile).url).toBe(effective)
    // The Mac's loader keeps what was written: the override is not dropped as unusable when the file is read again.
    expect(cleanProfileOverrides(written.profiles)).toEqual(written.profiles)
  })
})
