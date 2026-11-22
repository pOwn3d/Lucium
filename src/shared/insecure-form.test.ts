import { describe, expect, it } from 'vitest'
import { FORM_ACTION_MAX, parseFormAsk } from './form-guard-wire'
import { insecureTarget } from './insecure-form'

describe('where a form with a password would send it, in the clear', () => {
  it('is a public host reached over http, with its port', () => {
    expect(insecureTarget('http://login.example.com/session', 'https://example.com/')).toEqual({ host: 'login.example.com' })
    expect(insecureTarget('http://203.0.113.9:8080/in', 'https://example.com/')).toEqual({ host: '203.0.113.9:8080' })
  })

  it('is read against the page, as the browser does (a relative action of an http page is http)', () => {
    expect(insecureTarget('/login', 'http://shop.example.com/cart')).toEqual({ host: 'shop.example.com' })
    expect(insecureTarget('//other.example.net/in', 'http://shop.example.com/cart')).toEqual({ host: 'other.example.net' })
    expect(insecureTarget('/login', 'https://shop.example.com/cart')).toBeNull()
  })

  it('is nothing for https, and for what is no web address', () => {
    for (const action of ['https://example.com/in', 'ftp://example.com/', 'javascript:void(0)', 'data:text/html,x', 'mailto:me@example.com']) expect(insecureTarget(action, 'https://example.com/'), action).toBeNull()
    expect(insecureTarget('http://', 'https://example.com/')).toBeNull()
  })

  it('is nothing for this machine and the local network, where no one can sign a certificate', () => {
    for (const action of ['http://localhost:3000/in', 'http://127.0.0.1/in', 'http://192.168.1.1/login', 'http://10.0.0.5/', 'http://nas.local/', 'http://router/', 'http://[::1]/']) expect(insecureTarget(action, 'https://example.com/'), action).toBeNull()
  })

  it('is nothing when the page has no address to read a relative action against', () => {
    expect(insecureTarget('/login', '')).toBeNull()
    expect(insecureTarget('http://example.com/in', '')).toEqual({ host: 'example.com' })
  })
})

describe('the message of the preload', () => {
  it('is exactly an address', () => {
    expect(parseFormAsk({ action: 'http://example.com/in' })).toEqual({ action: 'http://example.com/in' })
  })

  it('is refused when it is anything else: another shape, more keys, an empty or too long address', () => {
    for (const raw of [null, undefined, 'http://example.com', [], 3, {}, { action: '' }, { action: 4 }, { action: 'x', more: 1 }, { url: 'http://example.com' }, { action: 'a'.repeat(FORM_ACTION_MAX + 1) }]) expect(parseFormAsk(raw), JSON.stringify(raw)).toBeNull()
    expect(parseFormAsk({ action: 'a'.repeat(FORM_ACTION_MAX) })).not.toBeNull()
  })
})
