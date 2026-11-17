import { describe, expect, it } from 'vitest'
import { compareVersions } from './versions'

describe('compareVersions', () => {
  it('orders dotted numbers numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('v1.0.1', '1.0.2')).toBe(-1)
    expect(compareVersions('2.0.0-beta.1', '1.9.9')).toBe(1)
    expect(compareVersions('1.2.0.1', '1.2')).toBe(1)
  })

  it('does not look at what follows a "-" or a "+": a prerelease equals its release here', () => {
    expect(compareVersions('2.0.0-beta.1', '2.0.0')).toBe(0)
    expect(compareVersions('44.9.3+wvcus', '44.9.3')).toBe(0)
  })

  it('does not rank what is not a version', () => {
    expect(compareVersions('nightly', '1.0.0')).toBe(0)
    expect(compareVersions('', '1.0.0')).toBe(0)
    expect(compareVersions('1.2.3.4.5', '1.0.0')).toBe(0)
  })
})
