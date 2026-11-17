// @vitest-environment happy-dom
// A file of the disk dropped on the interface opens in a tab (the main process checks the paths), and the interface itself never navigates: the drop is
// cancelled all the same. A link, or a file over a field of text or a part that takes files itself, opens nothing.

import { describe, expect, it, vi } from 'vitest'
import { LOCAL_FILES_MAX } from '@shared/local-documents'
import { TAKES_FILES_ATTRIBUTE, lockDocumentDrops } from './surface'

interface Transfer {
  types: string[]
  files: { name: string }[]
  dropEffect: string
}

function setup() {
  const doc = document.implementation.createHTMLDocument('')
  const bridge = { pathOfDroppedFile: vi.fn((file: { name: string }) => `/Users/x/${file.name}`), openLocalFiles: vi.fn() }
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
    const dataTransfer: Transfer = { types: ['Files'], files: [], dropEffect: 'move', ...transfer }
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

  it('open nothing for a link dragged from another application, and refuse it', () => {
    const { bridge, plain, fire } = setup()
    expect(fire('dragover', plain, { types: ['text/uri-list', 'text/plain'] }).dataTransfer.dropEffect).toBe('none')
    const { event } = fire('drop', plain, { types: ['text/uri-list', 'text/plain'] })
    expect(event.defaultPrevented).toBe(true)
    expect(bridge.openLocalFiles).not.toHaveBeenCalled()
  })

  it('leave a drag of the interface alone', () => {
    const { bridge, plain, fire } = setup()
    const { event, dataTransfer } = fire('drop', plain, { types: ['application/x-lucium-tab'] })
    expect(event.defaultPrevented).toBe(false)
    expect(dataTransfer.dropEffect).toBe('move')
    expect(bridge.openLocalFiles).not.toHaveBeenCalled()
  })

  it('still cancel the drop when the bridge is not there', () => {
    const doc = document.implementation.createHTMLDocument('')
    lockDocumentDrops(doc, () => undefined)
    const target = doc.createElement('div')
    doc.body.appendChild(target)
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: files('a.html'), dropEffect: 'none' } })
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})
