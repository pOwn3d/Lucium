// The list of the hosts blocked on a page, rendered to markup (no window).

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { BlockedHostsList } from './Shields'

const render = (hosts: Array<{ host: string; count: number }>): string => renderToStaticMarkup(createElement(BlockedHostsList, { hosts }))

beforeEach(() => vi.stubGlobal('window', { lucium: {} }))
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

describe('the hosts blocked on a page', () => {
  it('lists each host with its number of requests, in the singular and the plural', () => {
    const html = render([{ host: 'ads2.example', count: 2 }, { host: 'ads1.example', count: 1 }])
    expect(html.indexOf('ads2.example')).toBeLessThan(html.indexOf('ads1.example'))
    expect(html).toContain('2 requêtes')
    expect(html).toContain('1 requête<')
    setLanguage('en')
    expect(render([{ host: 'a.example', count: 1 }])).toContain('1 request<')
  })

  it('says there is nothing to list when the page has no detail', () => {
    expect(render([])).toContain('Aucun détail pour cette page.')
  })

  it('writes a host as text: nothing in it becomes markup', () => {
    const html = render([{ host: '<img src=x onerror=alert(1)>', count: 1 }])
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})
