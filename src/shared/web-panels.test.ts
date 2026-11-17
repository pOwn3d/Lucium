import { describe, expect, it } from 'vitest'
import type { Space } from './model'
import { defaultTheme } from './theme'
import { WEB_PANELS_MAX, WEB_PANEL_TITLE_MAX, cleanWebPanels, parseWebPanelRequest, webPanelRefusal, webPanelTitle, webPanelUrl, withWebPanel, withoutWebPanel } from './web-panels'

const space = (over: Partial<Space> = {}): Space => ({ id: 'sp', name: 'Perso', emoji: '🏠', theme: defaultTheme(), profileId: 'default', ...over })

describe('webPanelUrl', () => {
  it('accepts a web page, as it was written', () => {
    expect(webPanelUrl('https://web.whatsapp.com/')).toBe('https://web.whatsapp.com/')
    expect(webPanelUrl('http://localhost:3000/agenda?vue=semaine#top')).toBe('http://localhost:3000/agenda?vue=semaine#top')
  })

  it('refuses everything that is not a web page, or that hides something', () => {
    for (const bad of [
      '',
      ' https://example.org/',
      'https://example.org/ ',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html',
      'view-source:https://example.org/',
      'about:blank',
      'ftp://example.org/',
      'https://user:secret@example.org/',
      'https://user@example.org/',
      'https://exa\nmple.org/',
      'example.org',
      `https://example.org/${'a'.repeat(2100)}`,
      null,
      undefined,
      42,
      {}
    ]) {
      expect(webPanelUrl(bad), String(bad).slice(0, 40)).toBeNull()
    }
  })
})

describe('webPanelTitle', () => {
  it('keeps a title, trimmed and cut, and falls back to the site\'s name', () => {
    expect(webPanelTitle('  WhatsApp  ', 'https://web.whatsapp.com/')).toBe('WhatsApp')
    expect(webPanelTitle('', 'https://www.example.org/x')).toBe('example.org')
    expect(webPanelTitle(undefined, 'https://mail.example.org/')).toBe('mail.example.org')
    expect(webPanelTitle('x'.repeat(500), 'https://example.org/')).toHaveLength(WEB_PANEL_TITLE_MAX)
  })

  it('turns control characters into spaces so a title is one line', () => {
    expect(webPanelTitle('Agenda\n\u0000Équipe', 'https://example.org/')).toBe('Agenda  Équipe')
  })
})

describe('cleanWebPanels', () => {
  it('repairs a list entry by entry: a bad one costs only itself', () => {
    const list = cleanWebPanels([
      { id: 'a', url: 'https://a.example/', title: 'A' },
      { id: 'b', url: 'javascript:alert(1)', title: 'B' },
      { id: '', url: 'https://c.example/' },
      { url: 'https://d.example/' },
      null,
      'https://e.example/',
      { id: 'f', url: 'https://f.example/' },
      { id: 'a', url: 'https://other.example/' },
      { id: 'g', url: 'https://a.example/' },
      { id: '__proto__', url: 'https://h.example/' }
    ])
    expect(list).toEqual([
      { id: 'a', url: 'https://a.example/', title: 'A' },
      { id: 'f', url: 'https://f.example/', title: 'f.example' }
    ])
  })

  it('stops at the limit', () => {
    const many = Array.from({ length: WEB_PANELS_MAX + 5 }, (_, i) => ({ id: `p${i}`, url: `https://site${i}.example/` }))
    expect(cleanWebPanels(many)).toHaveLength(WEB_PANELS_MAX)
  })

  it('reads anything that is not a list as an empty one', () => {
    for (const odd of [undefined, null, 'x', 5, {}, { id: 'a', url: 'https://a.example/' }]) expect(cleanWebPanels(odd)).toEqual([])
  })
})

describe('adding and removing a site', () => {
  it('adds at the end, with the title or the site\'s name', () => {
    const one = withWebPanel(space(), { id: 'p1', url: 'https://a.example/', title: 'Alpha' })
    const two = withWebPanel(one, { id: 'p2', url: 'https://b.example/' })
    expect(two.webPanels).toEqual([
      { id: 'p1', url: 'https://a.example/', title: 'Alpha' },
      { id: 'p2', url: 'https://b.example/', title: 'b.example' }
    ])
  })

  it('refuses a site that is not a web page, one that is there already and one past the limit, and says which', () => {
    const full = space({ webPanels: Array.from({ length: WEB_PANELS_MAX }, (_, i) => ({ id: `p${i}`, url: `https://site${i}.example/`, title: `S${i}` })) })
    expect(webPanelRefusal(undefined, 'file:///etc/hosts')).toBe('invalid')
    expect(webPanelRefusal([{ id: 'p', url: 'https://a.example/', title: 'A' }], 'https://a.example/')).toBe('duplicate')
    expect(webPanelRefusal(full.webPanels, 'https://new.example/')).toBe('full')
    expect(webPanelRefusal(full.webPanels, 'https://site3.example/')).toBe('duplicate')
    expect(webPanelRefusal(undefined, 'https://a.example/')).toBeNull()
    expect(withWebPanel(full, { id: 'x', url: 'https://new.example/' })).toBe(full)
    expect(withWebPanel(space(), { id: 'x', url: 'javascript:1' })).toEqual(space())
  })

  it('removes a site, and drops the list altogether with the last one', () => {
    const base = space({ webPanels: [{ id: 'p1', url: 'https://a.example/', title: 'A' }, { id: 'p2', url: 'https://b.example/', title: 'B' }] })
    const one = withoutWebPanel(base, 'p1')
    expect(one.webPanels).toEqual([{ id: 'p2', url: 'https://b.example/', title: 'B' }])
    const none = withoutWebPanel(one, 'p2')
    expect('webPanels' in none).toBe(false)
    expect(withoutWebPanel(base, 'unknown')).toBe(base)
    expect(withoutWebPanel(space(), 'p1')).toEqual(space())
  })
})

describe('parseWebPanelRequest', () => {
  it('accepts opening a panel by its id, and adding the page on screen', () => {
    expect(parseWebPanelRequest({ op: 'open', panelId: 'p1' })).toEqual({ op: 'open', panelId: 'p1' })
    expect(parseWebPanelRequest({ op: 'add' })).toEqual({ op: 'add' })
    expect(parseWebPanelRequest({ op: 'close' })).toEqual({ op: 'close' })
  })

  it('refuses the rest, and ignores any address the request carries: the main process takes the page itself', () => {
    for (const bad of [null, undefined, 'open', [], {}, { op: 'open' }, { op: 'open', panelId: '' }, { op: 'open', panelId: 3 }, { op: 'open', panelId: 'x'.repeat(300) }, { op: 'remove', panelId: 'p1' }]) {
      expect(parseWebPanelRequest(bad), JSON.stringify(bad)).toBeNull()
    }
    expect(parseWebPanelRequest({ op: 'add', url: 'https://evil.example/' })).toEqual({ op: 'add' })
  })
})
