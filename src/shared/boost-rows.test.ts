// Renaming and deleting a Tweak quickly from the panel of the site, whose list only switched them on and off.
// The panel of the site and the Tweak editor that use these are drawn in renderer/boost-rows-panel.test.ts.

import { describe, expect, it } from 'vitest'
import { BOOST_NAME_MAX } from './boost-share'
import { renamedBoost, siteBoosts } from './boost-rows'

describe('renaming a Tweak from the panel of the site', () => {
  it('gives the name typed, trimmed', () => {
    expect(renamedBoost('  Mode lecture  ', 'Zoom')).toBe('Mode lecture')
  })

  it('has nothing to save for an empty name, white space only, or the name it already has', () => {
    expect(renamedBoost('', 'Zoom')).toBeNull()
    expect(renamedBoost('   \t ', 'Zoom')).toBeNull()
    expect(renamedBoost('Zoom', 'Zoom')).toBeNull()
    expect(renamedBoost(' Zoom ', 'Zoom')).toBeNull()
  })

  it('cuts a name at the length a Tweak name may have, and keeps no control character', () => {
    expect(renamedBoost('x'.repeat(BOOST_NAME_MAX + 30), 'Zoom')).toBe('x'.repeat(BOOST_NAME_MAX))
    expect(renamedBoost('Ma\u0000Retouche\n2', 'Zoom')).toBe('Ma Retouche 2')
  })
})

// The editor shows the Tweaks the site already has while a new one is made: they were only in the menu of the title.
describe('the strip of the Tweaks of the site in the editor', () => {
  const saved = [{ id: 'a', name: 'Zoom' }, { id: 'b', name: 'Mode lecture' }]

  it('lists the saved Tweaks, the open one under the name being typed', () => {
    expect(siteBoosts(saved, 'b', 'Lecture sombre')).toEqual([
      { id: 'a', name: 'Zoom', current: false, stored: true },
      { id: 'b', name: 'Lecture sombre', current: true, stored: true }
    ])
  })

  it('adds a new Tweak that is not saved yet at the end, and says it cannot be deleted', () => {
    expect(siteBoosts(saved, 'new', 'Retouche 3')).toEqual([
      { id: 'a', name: 'Zoom', current: false, stored: true },
      { id: 'b', name: 'Mode lecture', current: false, stored: true },
      { id: 'new', name: 'Retouche 3', current: true, stored: false }
    ])
  })

  it('has one chip only for the open Tweak, and nothing for a site that has none yet', () => {
    expect(siteBoosts([], 'new', 'Retouche 1')).toEqual([{ id: 'new', name: 'Retouche 1', current: true, stored: false }])
    expect(siteBoosts(saved, 'a', 'Zoom').filter((c) => c.current)).toHaveLength(1)
  })

})
