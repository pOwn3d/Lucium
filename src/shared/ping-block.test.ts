import { describe, expect, it } from 'vitest'
import { pingBlockedFor } from './ping-block'

const ask = (url: string, pageUrl: string | null, resourceType = 'ping') => ({ url, resourceType, pageUrl })
const on = { blockPings: true, blockExceptions: [] as string[] }

describe('pingBlockedFor', () => {
  it('cancels a ping (hyperlink auditing, sendBeacon) to another site than the page', () => {
    expect(pingBlockedFor(ask('https://tracker.example/collect', 'https://news.test/a'), on)).toBe(true)
  })

  it('lets a ping of the site itself or of its subdomains through', () => {
    expect(pingBlockedFor(ask('https://news.test/hit', 'https://news.test/a'), on)).toBe(false)
    expect(pingBlockedFor(ask('https://stats.news.test/hit', 'https://www.news.test/a'), on)).toBe(false)
  })

  it('does nothing while the option is off', () => {
    expect(pingBlockedFor(ask('https://tracker.example/collect', 'https://news.test/a'), { ...on, blockPings: false })).toBe(false)
  })

  it('judges the type of the request, never another kind', () => {
    for (const type of ['xhr', 'image', 'script', 'mainFrame', 'subFrame', 'other']) expect(pingBlockedFor(ask('https://tracker.example/x', 'https://news.test/a', type), on), type).toBe(false)
  })

  it('leaves a request alone when the page it belongs to is unknown', () => {
    expect(pingBlockedFor(ask('https://tracker.example/collect', null), on)).toBe(false)
    expect(pingBlockedFor(ask('https://tracker.example/collect', 'about:blank'), on)).toBe(false)
  })

  it('lets pings through on the sites of the list of exceptions, subdomains included', () => {
    const excepted = { ...on, blockExceptions: ['news.test'] }
    expect(pingBlockedFor(ask('https://tracker.example/collect', 'https://news.test/a'), excepted)).toBe(false)
    expect(pingBlockedFor(ask('https://tracker.example/collect', 'https://www.news.test/a'), excepted)).toBe(false)
    expect(pingBlockedFor(ask('https://tracker.example/collect', 'https://other.test/a'), excepted)).toBe(true)
  })
})
