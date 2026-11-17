// The names a page may ask about on the channel of the state of a permission: the main process reads nothing else from that message.

import { describe, expect, it } from 'vitest'
import { PERMISSION_STATE, QUERIED_NAMES, queriedPermission } from './permission-state'

describe('the permission a page asks the state of', () => {
  it('is one of the four the user is asked for, under the name Electron gives it', () => {
    expect(queriedPermission('notifications')).toBe('notifications')
    expect(queriedPermission('geolocation')).toBe('geolocation')
    expect(queriedPermission('camera')).toBe('media')
    expect(queriedPermission('microphone')).toBe('media')
    expect([...QUERIED_NAMES].sort()).toEqual(['camera', 'geolocation', 'microphone', 'notifications'])
  })

  it('is nothing for any other name, a name of the prototype of an object, or a value that is not text', () => {
    for (const raw of ['openExternal', 'display-capture', 'hid', 'media', '', 'constructor', 'toString', '__proto__', 'hasOwnProperty', null, undefined, 7, {}, ['notifications']]) {
      expect(queriedPermission(raw), String(raw)).toBeNull()
    }
  })

  it('travels on a channel of its own', () => {
    expect(PERMISSION_STATE.undecided).toBe('lucium-permission-undecided')
  })
})
