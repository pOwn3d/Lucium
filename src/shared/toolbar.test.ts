import { describe, expect, it } from 'vitest'
import { hostParts, pickThemeColor, toolbarAddress, toolbarIsLight } from './toolbar'

describe('toolbarAddress', () => {
  it('has no host to put in bold for the Extensions page: the bar says chrome://extensions, and with the full URL what follows', () => {
    const id = 'a'.repeat(32)
    expect(toolbarAddress('lucium-ui://extensions/', false)).toEqual({ host: '', rest: '' })
    expect(toolbarAddress('lucium-ui://extensions/', true)).toEqual({ host: '', rest: '' })
    expect(toolbarAddress('lucium-ui://extensions/shortcuts', true)).toEqual({ host: '', rest: '/shortcuts' })
    expect(toolbarAddress(`lucium-ui://extensions/?id=${id}`, true)).toEqual({ host: '', rest: `/?id=${id}` })
    expect(toolbarAddress(`lucium-ui://extensions/?id=${id}`, false)).toEqual({ host: '', rest: '' })
    // An almost-address is read as any address is: its host is the site it names, never the page.
    expect(toolbarAddress('lucium-ui://extensions@evil/', false).host).not.toBe('')
  })

  it('shows the host alone by default, without the scheme and without www', () => {
    expect(toolbarAddress('https://www.example.com/a/b?c=1#d', false)).toEqual({ host: 'example.com', rest: '' })
    expect(toolbarAddress('http://127.0.0.1:8080/x', false)).toEqual({ host: '127.0.0.1:8080', rest: '' })
  })

  it('adds the rest of the address with the full URL (resources.arc.net/hc/en-us)', () => {
    expect(toolbarAddress('https://resources.arc.net/hc/en-us', true)).toEqual({ host: 'resources.arc.net', rest: '/hc/en-us' })
    expect(toolbarAddress('https://example.com/a/b?c=1#d', true)).toEqual({ host: 'example.com', rest: '/a/b?c=1#d' })
  })

  it('drops a lone trailing slash, and the root path altogether', () => {
    expect(toolbarAddress('https://example.com/', true)).toEqual({ host: 'example.com', rest: '' })
    expect(toolbarAddress('https://example.com/docs/', true)).toEqual({ host: 'example.com', rest: '/docs' })
  })

  it('has nothing to show for an address without a host (the toolbar then falls back on the title)', () => {
    expect(toolbarAddress('file:///Users/x/page.html', true)).toEqual({ host: '', rest: '' })
    expect(toolbarAddress('not a url', true)).toEqual({ host: '', rest: '' })
  })
})

describe('hostParts', () => {
  it('keeps the registrable domain apart from the subdomains that may give way', () => {
    expect(hostParts('accounts.example.com.session-check.evil.example')).toEqual({ sub: 'accounts.example.com.session-check.', domain: 'evil.example' })
    expect(hostParts('docs.exemple.fr')).toEqual({ sub: 'docs.', domain: 'exemple.fr' })
    expect(hostParts('login.bank.co.uk')).toEqual({ sub: 'login.', domain: 'bank.co.uk' })
    expect(hostParts('exemple.fr')).toEqual({ sub: '', domain: 'exemple.fr' })
  })

  it('keeps the port with the domain, and a host that is no domain in one part', () => {
    expect(hostParts('a.b.exemple.fr:8443')).toEqual({ sub: 'a.b.', domain: 'exemple.fr:8443' })
    expect(hostParts('localhost:3000')).toEqual({ sub: '', domain: 'localhost:3000' })
    expect(hostParts('192.168.1.20:8080')).toEqual({ sub: '', domain: '192.168.1.20:8080' })
    expect(hostParts('[::1]:3000')).toEqual({ sub: '', domain: '[::1]:3000' })
  })

  it('loses no character of the host', () => {
    for (const host of ['a.b.c.d.exemple.fr', 'alice.github.io', 'x.alice.github.io:81', 'exemple']) expect(Object.values(hostParts(host)).join(''), host).toBe(host)
  })
})

describe('pickThemeColor', () => {
  it('takes the colour a page declares', () => {
    expect(pickThemeColor([{ content: ' #c8102e ', applies: true }])).toBe('#c8102e')
  })

  it('takes the first tag whose media condition holds (one per colour scheme)', () => {
    expect(
      pickThemeColor([
        { content: '#ffffff', applies: false },
        { content: '#101010', applies: true }
      ])
    ).toBe('#101010')
  })

  it('does not fall back on anything else: a page without the tag keeps the default bar', () => {
    expect(pickThemeColor([])).toBeNull()
    expect(pickThemeColor([{ content: '   ', applies: true }])).toBeNull()
  })
})

describe('toolbarIsLight', () => {
  it('follows the colour of the page when it has one, whatever the appearance', () => {
    expect(toolbarIsLight('#ffffff', 'dark')).toBe(true)
    expect(toolbarIsLight('#3f3f3f', 'light')).toBe(false)
  })

  it("falls back on the default bar of the appearance: #3f3f3f in a dark window", () => {
    expect(toolbarIsLight(undefined, 'dark')).toBe(false)
    expect(toolbarIsLight(undefined, 'light')).toBe(true)
  })
})
