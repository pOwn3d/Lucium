import { describe, expect, it } from 'vitest'
import { copyableUrl, formatCopiedUrl, urlWithHighlight } from './copy-url'

const page = { url: 'https://exemple.fr/article', title: 'Un [bel] article', selection: '' }

describe('formatCopiedUrl', () => {
  it('copies the plain address', () => {
    expect(formatCopiedUrl('plain', page)).toBe('https://exemple.fr/article')
  })

  it('copies a Markdown link and escapes the characters that would break it', () => {
    expect(formatCopiedUrl('markdown', page)).toBe('[Un \\[bel\\] article](https://exemple.fr/article)')
    expect(formatCopiedUrl('markdown', { ...page, title: '  ' })).toBe('[https://exemple.fr/article](https://exemple.fr/article)')
  })

  it('copies a quote with a link that highlights the selection, or just title and address without one', () => {
    const quote = formatCopiedUrl('quote', { ...page, selection: '  une   phrase\nchoisie ' })
    expect(quote).toBe('“une phrase choisie”\n— Un [bel] article\nhttps://exemple.fr/article#:~:text=une%20phrase%20choisie')
    expect(formatCopiedUrl('quote', page)).toBe('Un [bel] article\nhttps://exemple.fr/article')
  })
})

describe('urlWithHighlight', () => {
  it('encodes the characters a text directive reserves', () => {
    expect(urlWithHighlight('https://a.fr/', 'a-b, c&d')).toBe('https://a.fr/#:~:text=a%2Db%2C%20c%26d')
  })

  it('uses the start and end of a long selection', () => {
    const words = Array.from({ length: 12 }, (_, i) => `mot${i + 1}`).join(' ')
    expect(urlWithHighlight('https://a.fr/', words)).toBe('https://a.fr/#:~:text=mot1%20mot2%20mot3%20mot4,mot9%20mot10%20mot11%20mot12')
  })

  it('keeps an existing fragment before the directive and replaces an older directive', () => {
    expect(urlWithHighlight('https://a.fr/p#section', 'texte')).toBe('https://a.fr/p#section:~:text=texte')
    expect(urlWithHighlight('https://a.fr/p#section:~:text=ancien', 'nouveau')).toBe('https://a.fr/p#section:~:text=nouveau')
  })

  it('returns the address untouched for an empty selection or something that is not a URL', () => {
    expect(urlWithHighlight('https://a.fr/', '   ')).toBe('https://a.fr/')
    expect(urlWithHighlight('pas une url', 'texte')).toBe('pas une url')
  })
})

describe('copyableUrl', () => {
  const tracked = 'https://exemple.fr/article?id=7&utm_source=nl&fbclid=zz&gclid=1&mc_eid=a#titre'

  it('copies the address as it is while the setting is off', () => {
    expect(copyableUrl(tracked, false)).toBe(tracked)
  })

  it('removes only the known tracking parameters, keeping the others and the fragment', () => {
    expect(copyableUrl(tracked, true)).toBe('https://exemple.fr/article?id=7#titre')
    expect(copyableUrl('https://exemple.fr/p?utm_medium=x&gclid=2', true)).toBe('https://exemple.fr/p')
  })

  it('copies the Extensions page as chrome://extensions, the address a person sees and can type again, with the setting on or off', () => {
    const id = 'a'.repeat(32)
    for (const strip of [false, true]) {
      expect(copyableUrl('lucium-ui://extensions/', strip)).toBe('chrome://extensions')
      expect(copyableUrl('lucium-ui://extensions/shortcuts', strip)).toBe('chrome://extensions/shortcuts')
      expect(copyableUrl(`lucium-ui://extensions/?id=${id}&profile=work`, strip)).toBe(`chrome://extensions/?id=${id}&profile=work`)
      expect(formatCopiedUrl('markdown', { url: copyableUrl('lucium-ui://extensions/', strip), title: 'Extensions', selection: '' })).toBe('[Extensions](chrome://extensions)')
      // An address that only looks like the page is copied as any address is.
      expect(copyableUrl('lucium-ui://extensions@evil/', strip)).toBe('lucium-ui://extensions@evil/')
    }
  })

  it('hands back the very same text when there is nothing to remove or it is not a web address', () => {
    for (const url of ['https://exemple.fr/p?page=2', 'https://exemple.fr/', 'about:blank', 'file:///tmp/a.html?utm_source=x', 'pas une adresse?utm_source=x', 'https://xn--exmple-cua.fr/p?q=%E9']) {
      expect(copyableUrl(url, true)).toBe(url)
    }
  })

  it('serves the three formats with the cleaned address', () => {
    const clean = copyableUrl(tracked, true)
    expect(formatCopiedUrl('markdown', { url: clean, title: 'T', selection: '' })).toBe('[T](https://exemple.fr/article?id=7#titre)')
    expect(formatCopiedUrl('quote', { url: clean, title: 'T', selection: 'mot' })).toContain('https://exemple.fr/article?id=7#titre:~:text=mot')
  })
})
