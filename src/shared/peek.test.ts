import { describe, expect, it } from 'vitest'
import { PEEK_BORDER, PEEK_PAGE_RADIUS, PEEK_RADIUS, isPeekOpenKey, peekAccent, peekAddress, peekAddressParts, peekCardRect, peekOnAccent, peekPageRect } from './peek'
import { hostParts } from './toolbar'

describe('peekCardRect', () => {
  it('is 88 % of the page card wide (the actions are in the header, no column of round buttons beside it), 2 px short of its top and bottom', () => {
    expect(peekCardRect({ x: 323, y: 10, width: 1357, height: 868 })).toEqual({ x: 323 + 82, y: 12, width: 1194, height: 864 })
  })

  it('leaves equal margins left and right, and 2 px above and below', () => {
    const stage = { x: 100, y: 50, width: 1000, height: 600 }
    const card = peekCardRect(stage)
    expect(card.x - stage.x).toBe(stage.x + stage.width - (card.x + card.width))
    expect(card.y - stage.y).toBe(2)
    expect(stage.y + stage.height - (card.y + card.height)).toBe(2)
  })

  it('never goes negative on a stage that is smaller than its insets', () => {
    expect(peekCardRect({ x: 0, y: 0, width: 0, height: 3 }).height).toBe(0)
  })
})

describe('peekPageRect', () => {
  const card = { x: 400, y: 12, width: 1000, height: 800 }

  it('puts the previewed page inside the edge of the card and under the 40 px header', () => {
    expect(peekPageRect(card, 40, PEEK_BORDER)).toEqual({ x: 402, y: 54, width: 996, height: 800 - 40 - 4 })
  })

  it('keeps the page inside the card on every side (nothing of it covers the edge)', () => {
    const page = peekPageRect(card, 40, PEEK_BORDER)
    expect(page.x).toBeGreaterThanOrEqual(card.x + PEEK_BORDER)
    expect(page.x + page.width).toBeLessThanOrEqual(card.x + card.width - PEEK_BORDER)
    expect(page.y + page.height).toBe(card.y + card.height - PEEK_BORDER)
  })

  it('never has a negative size on a card smaller than its header', () => {
    expect(peekPageRect({ x: 0, y: 0, width: 3, height: 30 }, 40, 2)).toMatchObject({ width: 0, height: 0 })
  })

  it('rounds the page one edge-width less than the card, so that the two curves are concentric', () => {
    expect(PEEK_PAGE_RADIUS).toBe(PEEK_RADIUS - PEEK_BORDER)
  })
})

describe('peekAccent', () => {
  it('is the accent of the tokens for the hue of the space: darker on a light window, lighter on a dark one', () => {
    expect(peekAccent(222, false)).toBe('hsl(222 78% 44%)')
    expect(peekAccent(222, true)).toBe('hsl(222 80% 66%)')
  })

  it('wraps a hue out of range and falls back to blue for one that is not a number', () => {
    expect(peekAccent(-30, false)).toBe('hsl(330 78% 44%)')
    expect(peekAccent(390, false)).toBe('hsl(30 78% 44%)')
    expect(peekAccent(Number.NaN, false)).toBe('hsl(222 78% 44%)')
  })
})

describe('peekOnAccent', () => {
  it('is white on the accent of a light window, and the dark ink of the tokens on a dark one', () => {
    expect(peekOnAccent(222, false)).toBe('#ffffff')
    expect(peekOnAccent(222, true)).toBe('#0c0f1a')
  })

  it('is the dark ink on the greens and yellows (60 to 170) in a light window too, where white does not read', () => {
    expect(peekOnAccent(60, false)).toBe('#0c0f1a')
    expect(peekOnAccent(140, false)).toBe('#0c0f1a')
    expect(peekOnAccent(170, false)).toBe('#0c0f1a')
    expect(peekOnAccent(59, false)).toBe('#ffffff')
    expect(peekOnAccent(171, false)).toBe('#ffffff')
    expect(peekOnAccent(500, false)).toBe('#0c0f1a')
  })
})

describe('isPeekOpenKey', () => {
  const key = (patch: object) => ({ key: 'Enter', meta: true, shift: false, alt: false, control: false, ...patch })

  it('is ⌘↩ and nothing else', () => {
    expect(isPeekOpenKey(key({}), 'darwin')).toBe(true)
    expect(isPeekOpenKey(key({ meta: false }), 'darwin')).toBe(false)
    expect(isPeekOpenKey(key({ key: 'Escape' }), 'darwin')).toBe(false)
    expect(isPeekOpenKey(key({ shift: true }), 'darwin')).toBe(false)
    expect(isPeekOpenKey(key({ alt: true }), 'darwin')).toBe(false)
    expect(isPeekOpenKey(key({ control: true }), 'darwin')).toBe(false)
  })
})

describe('peekAddress', () => {
  it('drops the scheme and www but keeps host, path and query', () => {
    expect(peekAddress('https://www.iana.org/domains/example?x=1')).toBe('iana.org/domains/example?x=1')
    expect(peekAddress('http://localhost:3000/a/b')).toBe('localhost:3000/a/b')
  })

  it('drops a lone trailing slash only', () => {
    expect(peekAddress('https://example.com/')).toBe('example.com')
    expect(peekAddress('https://example.com/docs/')).toBe('example.com/docs')
  })

  it('leaves what is not a URL as it is', () => {
    expect(peekAddress('about:blank')).toBe('about:blank')
    expect(peekAddress('')).toBe('')
  })
})

describe('the site in the header of the preview', () => {
  it('is the host of the address, never the name written before an @', () => {
    expect(peekAddressParts('https://www.bank.example@evil.example/')).toEqual({ host: 'evil.example', rest: '', insecure: false })
    expect(peekAddress('https://www.bank.example@evil.example/')).toBe('evil.example')
    expect(peekAddress('https://user:secret@site.example/path')).toBe('site.example/path')
  })

  it('comes apart from the path, so that the header can keep the registrable domain of a long host whole', () => {
    const long = 'https://accounts.bank.example.session-check.evil.example/sign-in?next=1'
    const parts = peekAddressParts(long)
    expect(parts).toEqual({ host: 'accounts.bank.example.session-check.evil.example', rest: '/sign-in?next=1', insecure: false })
    expect(hostParts(parts.host).domain).toBe('evil.example')
  })

  it('says when the page comes over plain http, since the scheme is not shown', () => {
    expect(peekAddressParts('http://site.example/a').insecure).toBe(true)
    expect(peekAddressParts('https://site.example/a').insecure).toBe(false)
  })

  it('leaves what is not an address as one text', () => {
    expect(peekAddressParts('about:blank')).toEqual({ host: '', rest: 'about:blank', insecure: false })
    expect(peekAddressParts('')).toEqual({ host: '', rest: '', insecure: false })
  })
})
