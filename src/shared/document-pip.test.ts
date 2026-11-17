import { describe, expect, it, vi } from 'vitest'
import {
  adoptionVerdict,
  documentPipBounds,
  documentPipContentBounds,
  documentPipKey,
  documentPipSize,
  documentPipVerdict,
  DocumentPipTicket,
  DOCUMENT_PIP_DEFAULT_SIZE,
  DOCUMENT_PIP_EDGE,
  DOCUMENT_PIP_MIN_SIZE,
  DOCUMENT_PIP_TICKET_MS,
  isBlankWindowUrl,
  isDocumentPipRequest,
  openerNavigationEnds,
  pipNavigationEnds
} from './document-pip'
import { POPUP_FRAME_HEIGHT } from './popup'

const area = { x: 0, y: 25, width: 1600, height: 1000 }

describe('which request is a document Picture-in-Picture window', () => {
  it('is the disposition Electron calls `other`, for a window that starts blank', () => {
    for (const url of ['', 'about:blank', 'about:blank#blocked']) expect(isDocumentPipRequest({ disposition: 'other', url }), url).toBe(true)
  })

  it('is never a tab, a popup or a Shift+click, whatever their address', () => {
    for (const disposition of ['foreground-tab', 'background-tab', 'new-window', 'default', 'save-to-disk', undefined]) {
      expect(isDocumentPipRequest({ disposition, url: 'about:blank' }), String(disposition)).toBe(false)
    }
  })

  it('is not a request of the same disposition that names an address: a document Picture-in-Picture window never loads one', () => {
    for (const url of ['https://site.example/', 'about:srcdoc', 'data:text/html,x', 'javascript:1', 'about:blankx', null]) expect(isDocumentPipRequest({ disposition: 'other', url }), String(url)).toBe(false)
  })

  it('reads a blank address only as one', () => {
    expect(isBlankWindowUrl('about:blank?x')).toBe(true)
    expect(isBlankWindowUrl('about:config')).toBe(false)
    expect(isBlankWindowUrl(undefined)).toBe(false)
  })
})

describe('whether a page may have its window', () => {
  const page = 'https://meet.example/abc'

  it('opens it for a page of the web that a click explains, while the feature is on', () => {
    expect(documentPipVerdict({ on: true, opener: page, gesture: () => true })).toEqual({ kind: 'allow' })
    expect(documentPipVerdict({ on: true, opener: 'http://localhost:8080/', gesture: () => true })).toEqual({ kind: 'allow' })
  })

  it('refuses it while the feature is off, without using up the click', () => {
    const gesture = vi.fn(() => true)
    expect(documentPipVerdict({ on: false, opener: page, gesture })).toEqual({ kind: 'refuse', reason: 'switched-off' })
    expect(gesture).not.toHaveBeenCalled()
  })

  it('refuses it without a click or a key of the user', () => {
    expect(documentPipVerdict({ on: true, opener: page, gesture: () => false })).toEqual({ kind: 'refuse', reason: 'no-gesture' })
  })

  it('refuses it to what is not a page of the web (an extension, a page of Lucium, a blank page), without using up the click', () => {
    for (const opener of ['chrome-extension://abc/panel.html', 'lucium://settings/', 'file:///tmp/a.html', 'about:blank', '']) {
      const gesture = vi.fn(() => true)
      expect(documentPipVerdict({ on: true, opener, gesture }), opener).toEqual({ kind: 'refuse', reason: 'not-a-web-page' })
      expect(gesture).not.toHaveBeenCalled()
    }
  })
})

describe('the yes of the handler', () => {
  it('is taken once, for the tab it was given for', () => {
    const ticket = new DocumentPipTicket()
    ticket.issue(1000, 'tab-1')
    expect(ticket.take(1500)).toBe('tab-1')
    expect(ticket.take(1600)).toBeNull()
  })

  it('is not there before the handler said yes', () => {
    expect(new DocumentPipTicket().take(10)).toBeNull()
  })

  it('does not wait past its time, and a yes past its time is gone for good', () => {
    const ticket = new DocumentPipTicket()
    ticket.issue(1000, 'tab-1')
    expect(ticket.take(1000 + DOCUMENT_PIP_TICKET_MS + 1)).toBeNull()
    expect(ticket.take(1000 + 1)).toBeNull()
    ticket.issue(1000, 'tab-1')
    expect(ticket.take(1000 + DOCUMENT_PIP_TICKET_MS)).toBe('tab-1')
  })

  it('is not taken by a clock that went back', () => {
    const ticket = new DocumentPipTicket()
    ticket.issue(5000, 'tab-1')
    expect(ticket.take(4000)).toBeNull()
  })

  it('keeps the last yes only', () => {
    const ticket = new DocumentPipTicket()
    ticket.issue(1000, 'tab-1')
    ticket.issue(1200, 'tab-2')
    expect(ticket.take(1300)).toBe('tab-2')
  })
})

describe('which window handed over is taken', () => {
  const allowed = { disposition: 'other', allowed: true, contents: true, sameSession: true }

  it('takes the document Picture-in-Picture window the handler allowed, in the session of its page', () => {
    expect(adoptionVerdict(allowed)).toEqual({ adopt: true })
  })

  it('leaves every other window to Electron: a tab, a popup', () => {
    for (const disposition of ['foreground-tab', 'background-tab', 'new-window', 'save-to-disk']) expect(adoptionVerdict({ ...allowed, disposition })).toEqual({ adopt: false, why: 'not-picture-in-picture' })
  })

  it('leaves a window nobody allowed, one that is not a page, and one of another session (a private page stays private)', () => {
    expect(adoptionVerdict({ ...allowed, allowed: false })).toEqual({ adopt: false, why: 'not-allowed' })
    expect(adoptionVerdict({ ...allowed, contents: false })).toEqual({ adopt: false, why: 'no-contents' })
    expect(adoptionVerdict({ ...allowed, sameSession: false })).toEqual({ adopt: false, why: 'other-session' })
  })
})

describe('the size and the place of the window', () => {
  it('has the size the page asked for', () => {
    expect(documentPipSize({ width: 500, height: 320 }, area)).toEqual({ width: 500, height: 320 })
  })

  it('has the default size when the page asked for none, or for nothing that is a size', () => {
    expect(documentPipSize({}, area)).toEqual(DOCUMENT_PIP_DEFAULT_SIZE)
    expect(documentPipSize({ width: 0, height: -4 }, area)).toEqual(DOCUMENT_PIP_DEFAULT_SIZE)
    expect(documentPipSize({ width: Number.NaN, height: Number.POSITIVE_INFINITY }, area)).toEqual(DOCUMENT_PIP_DEFAULT_SIZE)
  })

  it('is never smaller than the minimum, nor larger than its share of the screen', () => {
    expect(documentPipSize({ width: 1, height: 1 }, area)).toEqual(DOCUMENT_PIP_MIN_SIZE)
    const big = documentPipSize({ width: 99_999, height: 99_999 }, area)
    expect(big.width).toBe(1280)
    expect(big.height).toBe(Math.floor((1000 - POPUP_FRAME_HEIGHT) * 0.8))
  })

  it('opens in the bottom right corner of the screen, away from its edges', () => {
    expect(documentPipBounds({ width: 400, height: 300 }, area, null)).toEqual({ x: 1600 - 400 - DOCUMENT_PIP_EDGE, y: 25 + 1000 - 300 - DOCUMENT_PIP_EDGE, width: 400, height: 300 })
  })

  it('opens where the user last left one, kept inside the screen', () => {
    expect(documentPipBounds({ width: 400, height: 300 }, area, { x: 100, y: 200, width: 999, height: 999 })).toEqual({ x: 100, y: 200, width: 400, height: 300 })
    expect(documentPipBounds({ width: 400, height: 300 }, area, { x: 5000, y: -5000, width: 400, height: 300 })).toEqual({ x: 1200, y: 25 + POPUP_FRAME_HEIGHT, width: 400, height: 300 })
  })

  it('stays inside the screen when the page moves or sizes it', () => {
    expect(documentPipContentBounds({ x: -5000, y: -5000, width: 1, height: 1 }, area)).toEqual({ x: 0, y: 25 + POPUP_FRAME_HEIGHT, ...DOCUMENT_PIP_MIN_SIZE })
    expect(documentPipContentBounds({ x: 9000, y: 9000, width: 300, height: 200 }, area)).toEqual({ x: 1300, y: 825, width: 300, height: 200 })
    expect(documentPipContentBounds({ x: Number.NaN, y: Number.NaN, width: 300, height: 200 }, area)).toEqual({ x: 0, y: 25 + POPUP_FRAME_HEIGHT, width: 300, height: 200 })
  })
})

describe('what ends the window', () => {
  it('ends with a navigation of its own document to an address, of any origin', () => {
    expect(pipNavigationEnds({ isMainFrame: true, isSameDocument: false, url: 'https://elsewhere.example/' })).toBe(true)
    expect(pipNavigationEnds({ isMainFrame: true, isSameDocument: false, url: 'https://meet.example/same-origin' })).toBe(true)
  })

  it('does not end with a fragment, a frame inside it, or the blank document it starts from', () => {
    expect(pipNavigationEnds({ isMainFrame: true, isSameDocument: true, url: 'about:blank#x' })).toBe(false)
    expect(pipNavigationEnds({ isMainFrame: false, isSameDocument: false, url: 'https://ads.example/' })).toBe(false)
    expect(pipNavigationEnds({ isMainFrame: true, isSameDocument: false, url: 'about:blank' })).toBe(false)
  })

  it('ends when the page that opened it goes to another document, not when it changes its fragment or a frame', () => {
    expect(openerNavigationEnds({ isMainFrame: true, isSameDocument: false })).toBe(true)
    expect(openerNavigationEnds({ isMainFrame: true, isSameDocument: true })).toBe(false)
    expect(openerNavigationEnds({ isMainFrame: false, isSameDocument: false })).toBe(false)
  })
})

describe('the keys of the window', () => {
  const key = (k: string, extra: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }> = {}) => ({ type: 'keyDown', key: k, meta: false, control: false, alt: false, shift: false, ...extra })

  it('closes it with ⌘W, and lets typing through', () => {
    expect(documentPipKey(key('w', { meta: true }), 'darwin')).toBe('close')
    expect(documentPipKey(key('a'), 'darwin')).toBe('pass')
    expect(documentPipKey(key('c', { meta: true }), 'darwin')).toBe('pass')
  })

  it('keeps ⌘R from reloading it (a reload would close it) and the tab commands from acting behind it', () => {
    expect(documentPipKey(key('r', { meta: true }), 'darwin')).toBe('block')
    expect(documentPipKey(key('t', { meta: true }), 'darwin')).toBe('block')
  })
})
