import { describe, expect, it } from 'vitest'
import { monogramFor } from './favicon'

describe('the stand-in icon of a page without an icon', () => {
  it('takes the first letter of the domain, without www', () => {
    expect(monogramFor('https://www.exemple.fr/article')?.letter).toBe('E')
    expect(monogramFor('https://github.com/x')?.letter).toBe('G')
  })

  it('keeps the same colour for the same domain, and gives no icon without an address', () => {
    expect(monogramFor('https://github.com/a')?.hue).toBe(monogramFor('https://github.com/b')?.hue)
    // The colour tells two sites apart: it is not one colour for all.
    expect(monogramFor('https://github.com/a')?.hue).not.toBe(monogramFor('https://www.exemple.fr/')?.hue)
    expect(monogramFor('pas une adresse')).toBeNull()
    expect(monogramFor(undefined)).toBeNull()
  })

  it('gives no icon to an address without a host that starts with a letter or a digit: the globe stays, not an empty square', () => {
    for (const address of ['about:blank', 'file:///Users/x/a.html', 'http://[::1]/']) expect(monogramFor(address), address).toBeNull()
  })

  it('gives none to the Extensions page, which has an icon of its own: no E for its word of a host', () => {
    for (const address of ['lucium-ui://extensions/', 'lucium-ui://extensions/shortcuts', `lucium-ui://extensions/?id=${'a'.repeat(32)}`]) expect(monogramFor(address), address).toBeNull()
    // An address that only looks like the page is read as any address is: the letter of its site.
    expect(monogramFor('lucium-ui://extensions@evil/')?.letter).toBe('E')
  })
})
