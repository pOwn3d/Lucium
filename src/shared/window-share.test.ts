import { describe, expect, it } from 'vitest'
import { annotateShareEnabled, capturableWindows, listingRefusedForPermission, nativeWindowId, refusalOf, shareNoticeOf, type ShareSource, type WindowExclusions } from './window-share'

describe('listingRefusedForPermission', () => {
  it('lets the listing happen before macOS has asked, since macOS says "denied" then too and the listing is what makes it ask', () => {
    expect(listingRefusedForPermission('denied', null)).toBe(false)
    expect(listingRefusedForPermission('not-determined', null)).toBe(false)
    expect(listingRefusedForPermission('granted', null)).toBe(false)
  })

  it('stops at once for a restricted screen', () => {
    expect(listingRefusedForPermission('restricted', null)).toBe(true)
    expect(listingRefusedForPermission('restricted', 4)).toBe(true)
  })

  it('refuses after the listing while the permission is still missing, and not once it is granted', () => {
    expect(listingRefusedForPermission('denied', 3)).toBe(true)
    expect(listingRefusedForPermission('not-determined', 0)).toBe(true)
    expect(listingRefusedForPermission('not-determined', 2)).toBe(false)
    expect(listingRefusedForPermission('granted', 0)).toBe(false)
  })
})

const sources: ShareSource[] = [
  { id: 'screen:0:0', name: 'Entire Screen' },
  { id: 'window:101:1', name: 'Navigateur' },
  { id: 'window:202:1', name: 'Fenêtre privée' },
  { id: 'window:303:1', name: 'Fenêtre annotée' },
  { id: 'window:404:1', name: 'Notes' }
]

const none: WindowExclusions = { privateWindows: new Set(), ownWindows: new Set() }
const excluded: WindowExclusions = { privateWindows: new Set(['202']), ownWindows: new Set(['303']) }

describe('the prototype switch', () => {
  it('is on by default, and off only with LUCIUM_ANNOTATE=0', () => {
    expect(annotateShareEnabled({})).toBe(true)
    expect(annotateShareEnabled({ LUCIUM_ANNOTATE: '1' })).toBe(true)
    expect(annotateShareEnabled({ LUCIUM_ANNOTATE: '0' })).toBe(false)
  })
})

describe('the native number of a source', () => {
  it('is read from a window id, and is null for a screen', () => {
    expect(nativeWindowId('window:101:1')).toBe('101')
    expect(nativeWindowId('window:-7:0')).toBe('-7')
    expect(nativeWindowId('screen:0:0')).toBeNull()
    expect(nativeWindowId('')).toBeNull()
  })
})

describe('the list of windows that can be shared', () => {
  it('keeps the windows, drops the screens, and leaves out the private and own windows', () => {
    expect(capturableWindows(sources, excluded)).toEqual([
      { id: 'window:101:1', name: 'Navigateur' },
      { id: 'window:404:1', name: 'Notes' }
    ])
  })

  it('never lists a private window', () => {
    expect(capturableWindows(sources, excluded).map((s) => s.id)).not.toContain('window:202:1')
  })
})

describe('the refusal of a window', () => {
  it('lets a normal window through', () => {
    expect(refusalOf('window:101:1', sources, excluded)).toBeNull()
  })

  it('refuses a private window, even when it is given as an id desktopCapturer lists', () => {
    expect(refusalOf('window:202:1', sources, excluded)).toBe('private')
  })

  it("refuses the share's own window", () => {
    expect(refusalOf('window:303:1', sources, excluded)).toBe('own')
  })

  it('refuses a window that is not there any more, and a screen', () => {
    expect(refusalOf('window:999:1', sources, none)).toBe('unknown')
    expect(refusalOf('screen:0:0', sources, none)).toBe('unknown')
  })
})

describe('the notice of the source', () => {
  // The rule the command window and the view both follow: a closed window first, then a window that sends no picture.
  it('says nothing while the window is listed, is on the screen and has a picture', () => {
    expect(shareNoticeOf({ missing: false, hidden: false, blank: false })).toBeNull()
  })

  it('says the window is away when it is listed but not on the screen, or when its picture is black', () => {
    expect(shareNoticeOf({ missing: false, hidden: true, blank: false })).toBe('away')
    expect(shareNoticeOf({ missing: false, hidden: false, blank: true })).toBe('away')
  })

  it('says the window is closed when it is no longer listed, even if the other flags are set', () => {
    expect(shareNoticeOf({ missing: true, hidden: false, blank: false })).toBe('closed')
    expect(shareNoticeOf({ missing: true, hidden: true, blank: true })).toBe('closed')
  })
})
