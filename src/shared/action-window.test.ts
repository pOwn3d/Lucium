import { describe, expect, it } from 'vitest'
import { iconClickTab } from './action-window'

describe('iconClickTab', () => {
  it('takes the tab on screen in the window of the icon, whatever tab the icon carries', () => {
    // Three windows on one profile: the library's single state makes every icon carry the tab of the window that had the focus last (the right one, 103).
    expect(iconClickTab({ shown: 102, named: 103, namedIsHere: false })).toBe(102)
    expect(iconClickTab({ shown: 102, named: undefined, namedIsHere: false })).toBe(102)
    expect(iconClickTab({ shown: 102, named: 102, namedIsHere: true })).toBe(102)
  })

  it('keeps the tab the icon carries for a window that shows none, while that tab is still in the window', () => {
    expect(iconClickTab({ shown: undefined, named: 104, namedIsHere: true })).toBe(104)
  })

  it('does not take the tab the icon carries once it is in another window or gone: the window is given a new tab instead', () => {
    expect(iconClickTab({ shown: undefined, named: 103, namedIsHere: false })).toBeUndefined()
  })

  it('has no tab to give to a window that shows none and whose icon carries none', () => {
    expect(iconClickTab({ shown: undefined, named: undefined, namedIsHere: false })).toBeUndefined()
  })
})
