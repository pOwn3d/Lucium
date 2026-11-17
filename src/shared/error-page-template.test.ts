// The frame of the error pages: its colours are the design tokens, its tones are the families of failure, and what the engine finds by class stays.

import { describe, expect, it } from 'vitest'
import tokensCss from '../renderer/tokens.css?raw'
import { ERROR_PAGE_STYLE, ERROR_TONES, errorButton, errorFrame, escapeText } from './error-page-template'
import { errorActionUrl, renderErrorPage } from './error-pages'
import { tokenValues, type TokenContext } from './design-tokens'


describe('errorFrame', () => {
  const frame = { tone: 'danger', icon: '<svg></svg>', title: 'Titre <b>', content: '<p>Texte</p>', actions: '<a class="button" href="x">Ok</a>' } as const

  it('draws the icon in a tinted disc of its tone, then the title, the content and the actions', () => {
    const html = errorFrame(frame)
    expect(html).toBe('<div class="ep-icon danger"><svg></svg></div><h1>Titre &lt;b&gt;</h1><p>Texte</p><div class="actions"><a class="button" href="x">Ok</a></div>')
  })

  it('has a tint for each tone of the family, in the stylesheet', () => {
    for (const tone of ERROR_TONES.filter((tone) => tone !== 'neutral')) expect(ERROR_PAGE_STYLE, tone).toContain(`.ep-icon.${tone}`)
    expect(errorFrame({ ...frame, tone: 'neutral' })).toContain('ep-icon neutral')
  })

  it('escapes the title and the label of a button, and the address of a link', () => {
    expect(errorButton('lucium-error:retry?n="x"', 'A & <b>')).toBe('<a class="button" href="lucium-error:retry?n=&quot;x&quot;">A &amp; &lt;b&gt;</a>')
    expect(escapeText(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })

  it('keeps the classes the engine checks find the buttons by: a.button, and a.proceed for the discreet one', () => {
    expect(errorButton('h', 'Réessayer')).toContain('class="button"')
    expect(errorButton('h', 'Continuer', 'proceed')).toContain('class="proceed"')
  })
})

describe('the stylesheet of an error page', () => {
  it('holds the design tokens of tokens.css, so that the page has the same colours as the application: read back from the page, every token has the value it has in the application', () => {
    const contexts: TokenContext[] = [
      { scheme: 'light', hue: 250 },
      { scheme: 'dark', hue: 250 },
      { scheme: 'light', hue: 140 },
      { scheme: 'dark', hue: 60 },
      { scheme: 'light', hue: 250, contrast: true },
      { scheme: 'dark', hue: 250, contrast: 'forced' },
      { scheme: 'light', hue: 250, transparency: true },
      { scheme: 'dark', hue: 250, transparency: 'forced' }
    ]
    for (const context of contexts) {
      const application = tokenValues(tokensCss, context)
      const page = tokenValues(ERROR_PAGE_STYLE, context)
      expect(application.size).toBeGreaterThan(50)
      expect([...page.keys()].sort()).toEqual([...application.keys()].sort())
      for (const [name, value] of application) expect(page.get(name), `${name} ${JSON.stringify(context)}`).toBe(value)
    }
    // The page follows the appearance of the system: without this, light-dark() would always give the light side.
    expect(ERROR_PAGE_STYLE).toMatch(/color-scheme:\s*light dark/)
  })

  it('takes every colour and size from a token: no colour is written in the frame', () => {
    const frameStyle = ERROR_PAGE_STYLE.slice(ERROR_PAGE_STYLE.indexOf('html,body{'))
    expect(frameStyle).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    for (const name of frameStyle.match(/var\((--[a-z0-9-]+)\)/g)?.map((v) => v.slice(4, -1)) ?? []) expect(ERROR_PAGE_STYLE, name).toContain(`${name}:`)
  })

  it('is small enough to travel in every page: the comments and the indentation are gone', () => {
    expect(ERROR_PAGE_STYLE).not.toContain('/*')
    expect(ERROR_PAGE_STYLE.length).toBeLessThan(9000)
  })
})

describe('the pages built on the frame', () => {
  const load = renderErrorPage({ kind: 'load', url: 'https://exemple.fr/', name: 'ERR_CONNECTION_REFUSED', nonce: 'n1' })
  it('are drawn in it, with the retry button where the engine looks for it', () => {
    expect(load.body).toContain('<div class="ep-icon danger">')
    expect(load.body).toContain(`<a class="button" href="${errorActionUrl('retry', 'n1')}">`)
    expect(load.head).toContain('.ep-icon.danger')
  })
  it('give the unsafe connection the colour of a danger', () => {
    const page = renderErrorPage({ kind: 'certificate', url: 'https://x.test/', name: 'ERR_CERT_DATE_INVALID', nonce: 'n2', canGoBack: false, certificate: null })
    expect(page.body).toContain('<div class="ep-icon danger">')
  })
})
