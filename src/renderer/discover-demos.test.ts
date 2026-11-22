// The animated demos of « Découvrir Lucium » (DiscoverDemo.tsx): a scene drawn in the DOM, a text equivalent that says what it shows, a button that pauses it,
// and nothing that moves before the card is on screen. The motion itself lives in discover-demos.css (discover-demos-styles.test.ts).

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEMO_TEXTS, DISCOVER_DEMOS } from '@shared/discover'
import { setLanguage, t } from '@shared/i18n'
import { DiscoverDemo } from './DiscoverDemo'
import { expandedElements, rendersOf, type Element } from './render.test-support'

beforeEach(() => setLanguage('fr'))
afterEach(() => setLanguage('fr'))

const markup = (demo: (typeof DISCOVER_DEMOS)[number]): string => renderToStaticMarkup(createElement(DiscoverDemo, { demo, name: 'Codes', describedBy: 'card-title' }))
/** The scene: what is inside the stage, between its tags. */
const stageOf = (html: string): string => /<div class="dvd-stage"[^>]*>([\s\S]*?)<\/div><figcaption/.exec(html)?.[1] ?? ''

describe('every demo', () => {
  it('is a figure with a stage that is an image, labelled by its text equivalent, which is written under it in the language of the moment', () => {
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      for (const demo of DISCOVER_DEMOS) {
        const html = markup(demo)
        expect(html, demo).toMatch(new RegExp(`<figure class="dvd" data-demo="${demo}"`))
        expect(html, demo).toMatch(/<div class="dvd-stage" role="img" aria-labelledby="([^"]+)"/)
        const labelled = /aria-labelledby="([^"]+)"/.exec(html)![1]!
        expect(html, demo).toContain(`<figcaption id="${labelled}"`)
        expect(html, `${demo} ${language}`).toContain(t('discover.demo-texte-label'))
        expect(html.replace(/&#x27;/g, '’').replace(/&quot;/g, '"'), `${demo} ${language}`).toContain(t(DEMO_TEXTS[demo]))
      }
    }
  })

  it('has a scene with something in it, and no control inside the stage: a demo adds no stop to the keys', () => {
    for (const demo of DISCOVER_DEMOS) {
      const scene = stageOf(markup(demo))
      expect(scene.length, demo).toBeGreaterThan(80)
      expect(scene, demo).not.toMatch(/<(button|a|input|select|textarea)\b|tabindex/i)
    }
  })

  it('comes from nowhere: no picture, no video, no address, so nothing is downloaded and nothing leaves the machine', () => {
    for (const demo of DISCOVER_DEMOS) expect(markup(demo), demo).not.toMatch(/<(img|video|audio|iframe|object|embed|source)\b|https?:|src=|url\(/i)
  })

  it('writes the words of its scene in the language of the interface, never in the other', () => {
    setLanguage('fr')
    const fr = DISCOVER_DEMOS.map((demo) => stageOf(markup(demo)))
    setLanguage('en')
    const en = DISCOVER_DEMOS.map((demo) => stageOf(markup(demo)))
    expect(fr[0]).toContain('Facture de novembre')
    expect(en[0]).toContain('November invoice')
    expect(en[0]).not.toContain('Facture')
    expect(fr[1]).toContain('Site bloqué pendant la concentration')
    expect(en[1]).toContain('Site blocked while you focus')
    expect(fr[3]).toContain('Code à usage unique')
    expect(en[3]).toContain('One-time code')
    expect(fr[4]).toContain('* recette')
    expect(en[4]).toContain('* recipe')
    expect(fr[7]).toContain('Capture prête')
    expect(en[7]).toContain('Capture ready')
  })
})

describe('the pause', () => {
  const buttonOf = (elements: Element[]): Element => elements.find((element) => element.type === 'button')!

  it('is a button of the card, named by what it says and by the function (« Mettre l’animation en pause, Codes »), that stops the animation', () => {
    const html = markup('totp')
    expect(html).toMatch(/<button type="button" class="tk-btn dvd-pause" aria-label="Mettre l’animation en pause, Codes" aria-describedby="card-title">Mettre l’animation en pause<\/button>/)
    setLanguage('en')
    expect(markup('totp')).toContain('aria-label="Pause the animation, Codes" aria-describedby="card-title">Pause the animation</button>')
  })

  it('shows « Reprendre l’animation » once pressed, marks the figure paused, and gives the animation back on a second press', () => {
    const passes = rendersOf(3, (pass) => {
      const elements = expandedElements(createElement(DiscoverDemo, { demo: 'markdown', name: 'Markdown', describedBy: 'x' }))
      if (pass < 2) (buttonOf(elements).props['onClick'] as () => void)()
      const figure = elements.find((element) => element.type === 'figure')!
      return { label: buttonOf(elements).props['children'], named: buttonOf(elements).props['aria-label'], paused: figure.props['data-paused'], playing: figure.props['data-playing'] }
    })
    expect(passes[0]).toEqual({ label: 'Mettre l’animation en pause', named: 'Mettre l’animation en pause, Markdown', paused: 'false', playing: 'false' })
    expect(passes[1]).toEqual({ label: 'Reprendre l’animation', named: 'Reprendre l’animation, Markdown', paused: 'true', playing: 'false' })
    expect(passes[2]!.paused).toBe('false')
    expect(passes[2]!.label).toBe('Mettre l’animation en pause')
  })

  it('does not start before the card is on screen: nothing runs at rest', () => {
    for (const demo of DISCOVER_DEMOS) expect(markup(demo), demo).toContain('data-playing="false"')
  })
})
