import { describe, expect, it } from 'vitest'
import type { OverlayRequest } from '@shared/ipc'
import { CaptureShelf } from './capture-shelf'

function pngOf(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function setup(enabled = true) {
  const state = { enabled, panel: null as OverlayRequest | null }
  const shelf = new CaptureShelf(
    () => state.enabled,
    () => state.panel
  )
  /** Holds a capture and shows its sheet, as the capture flow does. */
  const hold = (suffix = '-zone') => {
    const held = shelf.hold(pngOf(800, 600), suffix)
    if (held) state.panel = { panel: 'annotate', id: held.id, width: held.width, height: held.height }
    return held
  }
  return { state, shelf, hold }
}

describe('CaptureShelf', () => {
  it('holds nothing while the function is off: the capture goes the way it always went', () => {
    const t = setup(false)
    expect(t.shelf.hold(pngOf(800, 600), '')).toBeNull()
    expect(t.shelf.holding()).toBe(false)
  })

  it('holds nothing of a picture the sheet cannot take, and keeps the capture it already had', () => {
    const t = setup()
    const first = t.hold()!
    expect(t.shelf.hold(Buffer.from('not a png, only text that is long enough to have a header'), '')).toBeNull()
    expect(t.shelf.hold(pngOf(20_000, 20_000), '')).toBeNull()
    expect(t.shelf.get(first.id)?.png).toEqual(pngOf(800, 600))
  })

  it('says the size and an id, and gives the capture back only to the sheet that was opened for it', () => {
    const t = setup()
    const held = t.hold('-page-entiere')!
    expect(held).toMatchObject({ width: 800, height: 600 })
    expect(held.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(t.shelf.get(held.id)).toMatchObject({ id: held.id, suffix: '-page-entiere', width: 800, height: 600 })
  })

  it('gives nothing to another id, to something that is not an id, or when the sheet is not the panel on screen', () => {
    const t = setup()
    const held = t.hold()!
    for (const id of ['11111111-1111-1111-1111-111111111111', '', undefined, null, 5, {}, [held.id]]) expect(t.shelf.get(id), String(id)).toBeNull()
    t.state.panel = null
    expect(t.shelf.get(held.id)).toBeNull()
    t.state.panel = { panel: 'capture' }
    expect(t.shelf.get(held.id)).toBeNull()
    t.state.panel = { panel: 'annotate', id: '22222222-2222-2222-2222-222222222222', width: 800, height: 600 }
    expect(t.shelf.get(held.id)).toBeNull()
  })

  it('gives nothing to a sheet that is still on screen after its capture was replaced by one the sheet does not show', () => {
    const t = setup()
    const first = t.hold()!
    // A second capture is held but its sheet is not on screen: the first sheet is still the panel.
    const second = t.shelf.hold(pngOf(800, 600), '')!
    expect(t.shelf.get(first.id)).toBeNull()
    expect(t.shelf.get(second.id)).toBeNull()
  })

  it('replaces the capture it holds with a new one: the old id reads nothing any more', () => {
    const t = setup()
    const first = t.hold()!
    const second = t.hold()!
    expect(second.id).not.toBe(first.id)
    expect(t.shelf.get(first.id)).toBeNull()
    expect(t.shelf.get(second.id)).not.toBeNull()
  })

  it('lets go of the capture by its id, or whatever it is without one; another id leaves it alone', () => {
    const t = setup()
    const held = t.hold()!
    t.shelf.drop('33333333-3333-3333-3333-333333333333')
    expect(t.shelf.holding()).toBe(true)
    t.shelf.drop(held.id)
    expect(t.shelf.holding()).toBe(false)
    expect(t.shelf.get(held.id)).toBeNull()
    t.hold()
    t.shelf.drop()
    expect(t.shelf.holding()).toBe(false)
  })

  it('reads the setting at each capture', () => {
    const t = setup(false)
    expect(t.hold()).toBeNull()
    t.state.enabled = true
    expect(t.hold()).not.toBeNull()
    t.state.enabled = false
    expect(t.hold()).toBeNull()
  })
})
