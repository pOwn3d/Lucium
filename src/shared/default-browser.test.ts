import { describe, expect, it } from 'vitest'
import { WEB_SCHEMES, schemesToRegister } from './default-browser'

describe('schemesToRegister', () => {
  it('lets the packaged application take the web links', () => {
    expect(schemesToRegister(true)).toEqual(['http', 'https'])
    expect(schemesToRegister(true)).toBe(WEB_SCHEMES)
  })

  it('keeps a development copy of Electron out of the default browser: its identifier is the generic one of every Electron application', () => {
    expect(schemesToRegister(false)).toEqual([])
  })
})
