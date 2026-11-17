import { afterEach, describe, expect, it } from 'vitest'
import { canReachMainWorld } from './main-world'

const proc = process as unknown as { contextIsolated?: boolean }
const before = { isolated: proc.contextIsolated }

afterEach(() => {
  proc.contextIsolated = before.isolated
})

describe('whether contextBridge can reach the main world of a document', () => {
  it('can in a document with context isolation, which is every tab and every popup of the browser', () => {
    proc.contextIsolated = true
    expect(canReachMainWorld()).toBe(true)
  })

  it('cannot in a document without it (an offscreen document, the background page of a Manifest V2 extension): Electron refuses contextBridge there', () => {
    proc.contextIsolated = false
    expect(canReachMainWorld()).toBe(false)
  })

  it('can where the renderer does not say, so that the attempt is made as it always was and no bridge is lost on a doubt', () => {
    proc.contextIsolated = undefined
    expect(canReachMainWorld()).toBe(true)
  })
})
