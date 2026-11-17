import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage, tp } from './i18n'
import { frenchSpaces } from './french-typography'
import { TAB_URL_MAX } from './state-clean'
import { WAITING_LINKS_MAX, WaitingLinks } from './waiting-links'

afterEach(() => setLanguage('fr'))

describe('WaitingLinks', () => {
  it('hands back the links in the order they came, once', () => {
    const waiting = new WaitingLinks(['https://a.example/'])
    expect(waiting.add('https://b.example/')).toBe(true)
    expect(waiting.take()).toEqual({ links: ['https://a.example/', 'https://b.example/'], dropped: 0 })
    expect(waiting.take()).toEqual({ links: [], dropped: 0 })
  })

  // Another program sends thousands of links while the application is locked: they must neither pile up nor all open at the unlocking.
  it('keeps the first links up to its ceiling, and counts the ones it dropped', () => {
    const waiting = new WaitingLinks()
    const sent = Array.from({ length: 5000 }, (_, i) => `https://flood.example/${i}`)
    const kept = sent.map((url) => waiting.add(url))
    expect(kept.filter(Boolean)).toHaveLength(WAITING_LINKS_MAX)
    expect(waiting.size).toBe(WAITING_LINKS_MAX)
    const taken = waiting.take()
    expect(taken.links).toEqual(sent.slice(0, WAITING_LINKS_MAX))
    expect(taken.dropped).toBe(5000 - WAITING_LINKS_MAX)
    // The count starts again with the queue.
    waiting.add('https://later.example/')
    expect(waiting.take()).toEqual({ links: ['https://later.example/'], dropped: 0 })
  })

  it('drops a link longer than an address of a tab may be, and counts it', () => {
    const waiting = new WaitingLinks([`https://a.example/${'x'.repeat(TAB_URL_MAX)}`])
    expect(waiting.add('https://b.example/')).toBe(true)
    expect(waiting.take()).toEqual({ links: ['https://b.example/'], dropped: 1 })
  })

  it('applies the ceiling to the links of the command line too', () => {
    const waiting = new WaitingLinks(Array.from({ length: WAITING_LINKS_MAX + 4 }, (_, i) => `https://a.example/${i}`))
    expect(waiting.take().dropped).toBe(4)
  })

  it('has a sentence for the user, in both languages', () => {
    expect(tp('app.liens-en-attente-non-ouverts', 1, { max: WAITING_LINKS_MAX })).toBe(frenchSpaces('1 lien envoyé par une autre application n’a pas été ouvert : Lucium en garde 20 au plus pendant qu’il démarre ou qu’il est verrouillé.'))
    expect(tp('app.liens-en-attente-non-ouverts', 4980, { max: WAITING_LINKS_MAX })).toContain('liens envoyés par une autre application n’ont pas été ouverts')
    setLanguage('en')
    expect(tp('app.liens-en-attente-non-ouverts', 1, { max: WAITING_LINKS_MAX })).toBe('1 link sent by another app wasn’t opened: Lucium keeps at most 20 while it’s starting or locked.')
    expect(tp('app.liens-en-attente-non-ouverts', 3, { max: WAITING_LINKS_MAX })).toBe('3 links sent by another app weren’t opened: Lucium keeps at most 20 while it’s starting or locked.')
  })

  it('is what the links wait in, before the window and during the lock, and the user is told what was dropped', () => {
    // The entry point keeps the links of the very start; the part of it that opens them is shell/external-links-wiring.ts.
    const source = ['index.ts', 'shell/external-links-wiring.ts'].map((file) => readFileSync(join(__dirname, '..', 'main', file), 'utf8')).join('\n')
    expect(source).toContain('const pendingExternalUrls = new WaitingLinks(platform.commandLineLinks(process.argv))')
    expect(source).toContain('const deferredLinks = new WaitingLinks()')
    // No queue of links is a plain array any more.
    expect(source).not.toMatch(/(pendingExternalUrls|deferredLinks)\.(push|splice)\(/)
    expect(source.match(/openWaitingLinks\((pendingExternalUrls|deferredLinks)\)/g)).toHaveLength(2)
    expect(source).toMatch(/if \(dropped > 0\) \{\n\s+console\.warn\([^\n]+\n\s+browser\.showToast\(tp\('app\.liens-en-attente-non-ouverts', dropped, \{ max: WAITING_LINKS_MAX \}\)\)/)
  })
})
