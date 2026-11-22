import { describe, expect, it } from 'vitest'
import { refererSentTo, withTrimmedReferer } from './referer-trim'

describe('refererSentTo', () => {
  it('keeps only the origin of the page for another site', () => {
    expect(refererSentTo('https://tracker.example/pixel.gif', 'https://news.test/politics/article-42?id=7&token=secret#top')).toBe('https://news.test/')
    expect(refererSentTo('https://tracker.example/', 'http://news.test:8080/a/b?q=1')).toBe('http://news.test:8080/')
  })

  it('leaves the Referer alone for the site itself and its subdomains', () => {
    expect(refererSentTo('https://news.test/app.js', 'https://news.test/a?x=1')).toBeNull()
    expect(refererSentTo('https://cdn.news.test/app.js', 'https://www.news.test/a?x=1')).toBeNull()
  })

  it('leaves alone a Referer that is already an origin, so a request is rewritten once', () => {
    expect(refererSentTo('https://tracker.example/', 'https://news.test/')).toBeNull()
  })

  it('leaves alone what it cannot read: a Referer that is no web address, a request that is none', () => {
    expect(refererSentTo('https://tracker.example/', 'not an address')).toBeNull()
    expect(refererSentTo('https://tracker.example/', 'file:///Users/me/notes.html')).toBeNull()
    expect(refererSentTo('data:text/plain,hello', 'https://news.test/a')).toBeNull()
  })
})

describe('withTrimmedReferer', () => {
  const headers = { Accept: '*/*', Referer: 'https://news.test/a/b?token=1' }

  it('rewrites the Referer of a request to another site, whatever the case of the name, and nothing else', () => {
    expect(withTrimmedReferer('https://tracker.example/p.gif', headers)).toEqual({ Accept: '*/*', Referer: 'https://news.test/' })
    expect(withTrimmedReferer('https://tracker.example/p.gif', { referer: 'https://news.test/a?x=1' })).toEqual({ referer: 'https://news.test/' })
  })

  it('gives back the same object when there is nothing to trim', () => {
    const same = { Referer: 'https://news.test/a?x=1' }
    expect(withTrimmedReferer('https://news.test/b', same)).toBe(same)
    const none = { Accept: '*/*' }
    expect(withTrimmedReferer('https://tracker.example/', none)).toBe(none)
  })
})
