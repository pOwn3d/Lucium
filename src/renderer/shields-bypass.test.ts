// The row of the site panel for the links of the site: drawn only while the option is on, says the state of this site, and the click writes the
// list of exceptions through the ordinary `settings/update` action.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/model'
import { setLanguage } from '@shared/i18n'

const dispatch = vi.fn()
let settings = defaultSettings()
vi.mock('./api', () => ({
  api: () => ({ dispatch, blockedCount: () => Promise.resolve(0), openOverlay: () => undefined }),
  useSnapshot: () => ({ state: { settings, tabs: [] } })
}))

import { Shields } from './Shields'

const html = (url = 'https://www.exemple.fr/a') => renderToStaticMarkup(createElement(Shields, { url, tabId: 't1' }))

describe('the links row of the site panel', () => {
  it('is absent while the option is off', () => {
    setLanguage('fr')
    settings = { ...defaultSettings(), unwrapRedirects: false }
    expect(html()).not.toContain('Liens de suivi et pages AMP')
  })

  it('says the final addresses are opened for a site that is not excepted', () => {
    setLanguage('fr')
    settings = { ...defaultSettings(), unwrapRedirects: true }
    const out = html()
    expect(out).toContain('Liens de suivi et pages AMP')
    expect(out).toContain('Ouvre l’adresse finale des liens de ce site')
    expect(out).toContain('aria-checked="true"')
  })

  it('says the links are left as they are for a site on the list, in English too', () => {
    setLanguage('en')
    settings = { ...defaultSettings(), unwrapRedirects: true, unwrapExceptions: ['exemple.fr'] }
    const out = html()
    expect(out).toContain('Links left as they are for this site')
    expect(out).toContain('Tracking links and AMP pages')
    setLanguage('fr')
  })
})
