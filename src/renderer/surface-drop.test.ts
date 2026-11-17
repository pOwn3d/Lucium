// @vitest-environment happy-dom
// A file of the disk dropped on the interface opens in a tab (the main process checks the paths), and so does a link dragged from another application (the
// interface sends its text, the main process checks it); the interface itself never navigates: the drop is cancelled all the same, and first. A file or a link
// over a field of text or a part that takes files itself, any other text, and a drag of the interface, open nothing.

import { describe, expect, it, vi } from 'vitest'
import { DROPPED_LINKS_TEXT_MAX } from '@shared/dropped-links'
import { LOCAL_FILES_MAX } from '@shared/local-documents'
import { TAKES_FILES_ATTRIBUTE, lockDocumentDrops } from './surface'

interface Transfer {
  types: string[]
  files: { name: string }[]
  dropEffect: string
  getData: (type: string) => string
}

/** The data of a drag by type, as `getData` gives it (a type that is not there gives an empty text). */
const dataOf = (data: Record<string, string>) => ({ getData: (type: string) => data[type] ?? '' })

function setup() {
  const doc = document.implementation.createHTMLDocument('')
  const bridge = { pathOfDroppedFile: vi.fn((file: { name: string }) => `/Users/x/${file.name}`), openLocalFiles: vi.fn(), openDroppedLinks: vi.fn() }
  lockDocumentDrops(doc, () => bridge as never)
  const field = doc.createElement('textarea')
  const notes = doc.createElement('div')
  notes.setAttribute(TAKES_FILES_ATTRIBUTE, '')
  const inside = doc.createElement('span')
  notes.appendChild(inside)
  const plain = doc.createElement('div')
  doc.body.append(field, notes, plain)
  const fire = (type: 'dragover' | 'drop', element: Element, transfer: Partial<Transfer>) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    const dataTransfer: Transfer = { types: ['Files'], files: [], dropEffect: 'move', getData: () => '', ...transfer }
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    element.dispatchEvent(event)
    return { event, dataTransfer }
  }
  return { bridge, field, inside, plain, fire }
}

const files = (...names: string[]) => names.map((name) => ({ name }))

describe('files dropped on the interface', () => {
  it('open in tabs: the drop is cancelled, the paths go to the main process in order, and the drag shows a copy', () => {
    const { bridge, plain, fire } = setup()
    expect(fire('dragover', plain, { files: files('a.html') }).dataTransfer.dropEffect).toBe('copy')
    const { event } = fire('drop', plain, { files: files('a.html', 'b.pdf') })
    expect(event.defaultPrevented).toBe(true)
    expect(bridge.openLocalFiles).toHaveBeenCalledExactlyOnceWith(['/Users/x/a.html', '/Users/x/b.pdf'])
  })

  it('send one path more than the ceiling, so that the main process can say what it left out', () => {
    const { bridge, plain, fire } = setup()
    fire('drop', plain, { files: files(...Array.from({ length: 40 }, (_, i) => `${i}.html`)) })
    expect(bridge.openLocalFiles.mock.calls[0]![0]).toHaveLength(LOCAL_FILES_MAX + 1)
  })

  it('send nothing when the page gave no path for any of them', () => {
    const { bridge, plain, fire } = setup()
    bridge.pathOfDroppedFile.mockReturnValue('')
    fire('drop', plain, { files: files('a.html') })
    expect(bridge.openLocalFiles).not.toHaveBeenCalled()
  })

  it('open nothing over a field of text, and the drop is still cancelled', () => {
    const { bridge, field, fire } = setup()
    expect(fire('dragover', field, { files: files('a.html') }).dataTransfer.dropEffect).toBe('none')
    const { event } = fire('drop', field, { files: files('a.html') })
    expect(event.defaultPrevented).toBe(true)
    expect(bridge.openLocalFiles).not.toHaveBeenCalled()
  })

  it('open nothing over a part that takes files itself, however deep the drop lands in it', () => {
    const { bridge, inside, fire } = setup()
    expect(fire('dragover', inside, { files: files('a.md') }).dataTransfer.dropEffect).toBe('none')
    const { event } = fire('drop', inside, { files: files('a.md') })
    expect(event.defaultPrevented).toBe(true)
    expect(bridge.openLocalFiles).not.toHaveBeenCalled()
  })

  it('send the text of a link dragged from another application to the main process, cancel the drop, and show a copy', () => {
    const { bridge, plain, fire } = setup()
    const types = ['text/uri-list', 'text/plain']
    expect(fire('dragover', plain, { types }).dataTransfer.dropEffect).toBe('copy')
    const { event } = fire('drop', plain, { types, ...dataOf({ 'text/uri-list': 'https://a.example/\r\n', 'text/plain': 'https://a.example/' }) })
    expect(event.defaultPrevented).toBe(true)
    expect(bridge.openDroppedLinks).toHaveBeenCalledExactlyOnceWith('https://a.example/\r\n')
    expect(bridge.openLocalFiles).not.toHaveBeenCalled()
  })

  it('read the text of a link that came as text only (a terminal), and the text when the list of addresses is empty', () => {
    const { bridge, plain, fire } = setup()
    fire('drop', plain, { types: ['text/plain'], ...dataOf({ 'text/plain': 'https://a.example/' }) })
    expect(bridge.openDroppedLinks).toHaveBeenLastCalledWith('https://a.example/')
    fire('drop', plain, { types: ['text/uri-list', 'text/plain'], ...dataOf({ 'text/uri-list': ' \n', 'text/plain': 'https://b.example/' }) })
    expect(bridge.openDroppedLinks).toHaveBeenLastCalledWith('https://b.example/')
  })

  it('send the text as it came, whatever it holds: the interface does not decide what opens', () => {
    const { bridge, plain, fire } = setup()
    fire('drop', plain, { types: ['text/plain'], ...dataOf({ 'text/plain': 'javascript:alert(1)' }) })
    expect(bridge.openDroppedLinks).toHaveBeenCalledExactlyOnceWith('javascript:alert(1)')
  })

  it('send one character more than the ceiling of the text, so that the main process can see it was too long, and not a megabyte', () => {
    const { bridge, plain, fire } = setup()
    fire('drop', plain, { types: ['text/plain'], ...dataOf({ 'text/plain': 'x'.repeat(5_000_000) }) })
    expect(bridge.openDroppedLinks.mock.calls[0]![0]).toHaveLength(DROPPED_LINKS_TEXT_MAX + 1)
  })

  it('send nothing when the drop carries no text', () => {
    const { bridge, plain, fire } = setup()
    fire('drop', plain, { types: ['text/uri-list'], ...dataOf({}) })
    fire('drop', plain, { types: ['text/plain'], ...dataOf({ 'text/plain': '  \n' }) })
    expect(bridge.openDroppedLinks).not.toHaveBeenCalled()
  })

  it('open no link over a field of text or over a part that takes files itself, and the drop over a part that takes files is still cancelled', () => {
    const { bridge, field, inside, fire } = setup()
    const link = { types: ['text/uri-list', 'text/plain'], ...dataOf({ 'text/uri-list': 'https://a.example/', 'text/plain': 'https://a.example/' }) }
    // A field takes the text itself: the drop is not touched there.
    expect(fire('drop', field, link).event.defaultPrevented).toBe(false)
    expect(fire('dragover', inside, link).dataTransfer.dropEffect).toBe('none')
    expect(fire('drop', inside, link).event.defaultPrevented).toBe(true)
    expect(bridge.openDroppedLinks).not.toHaveBeenCalled()
  })

  it('leave the files to their own road when the drag carries a link too (an application that puts the address of the file beside it)', () => {
    const { bridge, plain, fire } = setup()
    fire('drop', plain, { types: ['Files', 'text/uri-list', 'text/plain'], files: files('a.html'), ...dataOf({ 'text/uri-list': 'file:///Users/x/a.html' }) })
    expect(bridge.openLocalFiles).toHaveBeenCalledExactlyOnceWith(['/Users/x/a.html'])
    expect(bridge.openDroppedLinks).not.toHaveBeenCalled()
  })

  it('refuse any other drag from outside without opening anything (a picture, an HTML selection)', () => {
    const { bridge, plain, fire } = setup()
    expect(fire('dragover', plain, { types: ['text/html'] }).dataTransfer.dropEffect).toBe('none')
    const { event } = fire('drop', plain, { types: ['text/html'], ...dataOf({ 'text/html': '<a href="https://a.example/">a</a>' }) })
    expect(event.defaultPrevented).toBe(true)
    expect(bridge.openDroppedLinks).not.toHaveBeenCalled()
    expect(bridge.openLocalFiles).not.toHaveBeenCalled()
  })

  it('cancel the drop before the link is looked at: the page never navigates, even if sending it fails', () => {
    const { bridge, plain } = setup()
    bridge.openDroppedLinks.mockImplementation(() => {
      throw new Error('the main process is gone')
    })
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['text/plain'], files: [], dropEffect: 'none', ...dataOf({ 'text/plain': 'https://a.example/' }) } })
    // The error of the bridge is the page's own to report (the interface logs it); what matters is that the drop was already refused when it happened.
    expect(() => plain.dispatchEvent(event)).toThrow('the main process is gone')
    expect(event.defaultPrevented).toBe(true)
  })

  it('leave a drag of the interface alone', () => {
    const { bridge, plain, fire } = setup()
    const { event, dataTransfer } = fire('drop', plain, { types: ['application/x-lucium-tab'] })
    expect(event.defaultPrevented).toBe(false)
    expect(dataTransfer.dropEffect).toBe('move')
    expect(bridge.openLocalFiles).not.toHaveBeenCalled()
  })

  it('still cancel a link dropped on a page whose bridge has no call for it (the Extensions page, when it is a tab)', () => {
    const doc = document.implementation.createHTMLDocument('')
    const bridge = { pathOfDroppedFile: vi.fn(), openLocalFiles: vi.fn() }
    lockDocumentDrops(doc, () => bridge as never)
    const target = doc.createElement('div')
    doc.body.appendChild(target)
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['text/uri-list'], files: [], dropEffect: 'none', ...dataOf({ 'text/uri-list': 'https://a.example/' }) } })
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(bridge.openLocalFiles).not.toHaveBeenCalled()
  })

  it('still cancel the drop when the bridge is not there', () => {
    const doc = document.implementation.createHTMLDocument('')
    lockDocumentDrops(doc, () => undefined)
    const target = doc.createElement('div')
    doc.body.appendChild(target)
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files', 'text/plain'], files: files('a.html'), dropEffect: 'none', ...dataOf({ 'text/plain': 'https://a.example/' }) } })
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})
