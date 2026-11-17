import { describe, expect, it } from 'vitest'
import { isBlockingExempt } from './blocker'

describe('a site with an exception, written as a fully qualified name', () => {
  it('is the same site: a final dot in the address does not take the exception away', () => {
    expect(isBlockingExempt('https://site.example./page', ['site.example'])).toBe(true)
    expect(isBlockingExempt('https://www.site.example./', ['site.example'])).toBe(true)
    expect(isBlockingExempt('https://sub.site.example./', ['site.example'])).toBe(true)
    expect(isBlockingExempt('https://other.example./', ['site.example'])).toBe(false)
    expect(isBlockingExempt('https://notsite.example./', ['site.example'])).toBe(false)
  })
})
