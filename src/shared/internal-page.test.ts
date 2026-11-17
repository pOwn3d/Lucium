import { describe, expect, it } from 'vitest'
import { DISPLAY_ORIGIN, INTERNAL_ORIGIN, INTERNAL_PAGES_MATCH, chromeAddressOf, displayAddress, internalPageParts, isInternalOrigin, isInternalPageUrl, isInternalScheme } from './internal-page'

const ID = 'a'.repeat(32)

describe('isInternalPageUrl', () => {
  it('accepts the two documents of the page, with a query or a fragment', () => {
    for (const url of ['lucium-ui://extensions/', 'lucium-ui://extensions/shortcuts', `lucium-ui://extensions/?id=${ID}`, `lucium-ui://extensions/?id=${ID}&profile=work`, 'lucium-ui://extensions/#x', 'lucium-ui://extensions/shortcuts?a=1#b']) {
      expect(isInternalPageUrl(url), url).toBe(true)
    }
  })

  it('reads the parts of an address', () => {
    expect(internalPageParts(`lucium-ui://extensions/?id=${ID}#top`)).toEqual({ path: '/', search: `?id=${ID}`, hash: '#top' })
    expect(internalPageParts('lucium-ui://extensions/shortcuts')).toEqual({ path: '/shortcuts', search: '', hash: '' })
  })

  it('refuses another host, however it is written', () => {
    const refused = [
      'lucium-ui://extensions@evil/',
      'lucium-ui://extensions@evil.example/shortcuts',
      'lucium-ui://user@extensions/',
      'lucium-ui://user:pass@extensions/',
      'lucium-ui://evil/',
      'lucium-ui://extensions.evil.com/',
      'lucium-ui://evil.extensions/',
      'lucium-ui://extensionsx/',
      'lucium-ui://extensions:80/',
      'lucium-ui://extensions:/',
      'lucium-ui://%65xtensions/',
      'lucium-ui://extensions%2f',
      'lucium-ui://extensions%2F..%2F',
      'lucium-ui://extensİons/',
      'lucium-ui://exten\tsions/',
      'lucium-ui://extensions\n/',
      'lucium-ui://extensions /',
      ' lucium-ui://extensions/',
      'lucium-ui://extensions/ '
    ]
    for (const url of refused) expect(isInternalPageUrl(url), JSON.stringify(url)).toBe(false)
  })

  it('refuses another spelling of the scheme', () => {
    for (const url of ['LUCIUM-UI://EXTENSIONS', 'LUCIUM-UI://EXTENSIONS/', 'Lucium-Ui://extensions/', 'lucium-ui://Extensions/', 'lucium-ui:extensions', 'lucium-ui:/extensions/', 'lucium-ui:///extensions/', 'lucium-ui:extensions/', 'lucium-uiX://extensions/', 'xlucium-ui://extensions/', 'chrome://extensions/', 'https://extensions/', 'http://extensions/']) {
      expect(isInternalPageUrl(url), url).toBe(false)
    }
  })

  it('refuses backslashes, control characters and anything outside printable ASCII', () => {
    for (const url of ['lucium-ui://extensions\\@evil/', 'lucium-ui:\\\\extensions\\', 'lucium-ui://extensions/\\..', 'lucium-ui://extensions/?a=\\', 'lucium-ui://extensions/\u0000', 'lucium-ui://extensions/​', 'lucium-ui://extensions/?q=é', 'lucium-ui://extensions/‮']) {
      expect(isInternalPageUrl(url), JSON.stringify(url)).toBe(false)
    }
  })

  it('refuses the files of the bundle and every other path: they are not a page', () => {
    for (const url of ['lucium-ui://extensions', 'lucium-ui://extensions/assets/extensions-abc.js', 'lucium-ui://extensions/extensions.html', 'lucium-ui://extensions//', 'lucium-ui://extensions/shortcuts/', 'lucium-ui://extensions/shortcuts/x', 'lucium-ui://extensions/../', 'lucium-ui://extensions/%2e%2e/', 'lucium-ui://extensions/%73hortcuts', 'lucium-ui://extensions/Shortcuts', 'lucium-ui://extensions?id=1', 'lucium-ui://extensions#x']) {
      expect(isInternalPageUrl(url), url).toBe(false)
    }
  })

  it('refuses what is not text, and an address that is too long', () => {
    for (const value of [undefined, null, 0, {}, [], ['lucium-ui://extensions/'], new String('lucium-ui://extensions/')]) expect(isInternalPageUrl(value)).toBe(false)
    expect(isInternalPageUrl(`lucium-ui://extensions/?x=${'a'.repeat(600)}`)).toBe(false)
  })
})

describe('chromeAddressOf', () => {
  it('is the address of Chrome’s own page, with its slash, which an extension written for Chrome looks for', () => {
    expect(chromeAddressOf('lucium-ui://extensions/')).toBe('chrome://extensions/')
    expect(chromeAddressOf('lucium-ui://extensions/shortcuts')).toBe('chrome://extensions/shortcuts')
    expect(chromeAddressOf(`lucium-ui://extensions/?id=${ID}&profile=work#x`)).toBe(`chrome://extensions/?id=${ID}&profile=work#x`)
  })

  it('leaves every other address as it was, an almost-address of the page included', () => {
    for (const url of ['https://example.org/', 'chrome://extensions/', 'lucium-ui://extensions@evil/', 'LUCIUM-UI://EXTENSIONS/', 'lucium-ui://extensions/assets/a.js', '']) expect(chromeAddressOf(url), url).toBe(url)
  })
})

describe('isInternalScheme', () => {
  it('is any address on the scheme, whatever follows it: no web page has a business with one', () => {
    for (const url of ['lucium-ui://extensions/', 'lucium-ui://evil/', 'lucium-ui://extensions@evil/', 'LUCIUM-UI://EXTENSIONS', 'Lucium-Ui:x', 'lucium-ui:', ' lucium-ui://extensions/', '\n\tlucium-ui://extensions/', 'lucium-ui://extensions/assets/a.js']) {
      expect(isInternalScheme(url), JSON.stringify(url)).toBe(true)
    }
  })

  it('is no other scheme, nor anything that is not text', () => {
    for (const value of ['https://lucium-ui.example/', 'lucium://x', 'lucium-ui-x://a', 'xlucium-ui://a', 'about:blank', 'chrome://extensions', '', undefined, null, 3, {}]) expect(isInternalScheme(value), String(value)).toBe(false)
  })
})

describe('isInternalOrigin', () => {
  it('is an exact match, never a prefix', () => {
    expect(isInternalOrigin('lucium-ui://extensions')).toBe(true)
    expect(INTERNAL_ORIGIN).toBe('lucium-ui://extensions')
    for (const origin of ['lucium-ui://extensions/', 'lucium-ui://extensions.evil.com', 'lucium-ui://extensions@evil', 'lucium-ui://evil', 'LUCIUM-UI://EXTENSIONS', 'null', '', undefined, null, 'https://extensions', 'chrome://extensions']) {
      expect(isInternalOrigin(origin), String(origin)).toBe(false)
    }
  })

  it('the pattern the preload is limited to is the page and nothing that merely starts like it', () => {
    expect(INTERNAL_PAGES_MATCH).toBe('lucium-ui://extensions/*')
  })
})

describe('displayAddress', () => {
  it('says chrome://extensions for the page, as Chrome does', () => {
    expect(displayAddress('lucium-ui://extensions/')).toBe('chrome://extensions')
    expect(displayAddress('lucium-ui://extensions/shortcuts')).toBe('chrome://extensions/shortcuts')
    expect(displayAddress(`lucium-ui://extensions/?id=${ID}`)).toBe(`chrome://extensions/?id=${ID}`)
    expect(displayAddress(`lucium-ui://extensions/?id=${ID}&profile=work`)).toBe(`chrome://extensions/?id=${ID}&profile=work`)
    expect(DISPLAY_ORIGIN).toBe('chrome://extensions')
  })

  it('leaves every other address as it was, an almost-address of the page included', () => {
    for (const url of ['https://example.com/a?b#c', 'about:blank', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html', 'lucium-ui://extensions@evil/', 'LUCIUM-UI://EXTENSIONS', 'lucium-ui://extensions/assets/a.js', '', 'not an address']) {
      expect(displayAddress(url), url).toBe(url)
    }
  })
})
