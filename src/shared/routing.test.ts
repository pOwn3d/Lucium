import { describe, expect, it } from 'vitest'
import { routeFor } from './routing'

const spaces = [{ id: 'perso' }, { id: 'pro' }, { id: 'labo' }]

describe('routeFor', () => {
  it('sends a link to the space whose rule matches the host or a subdomain', () => {
    const routes = [{ host: 'github.com', spaceId: 'pro' }]
    expect(routeFor('https://github.com/a/b', routes, spaces)).toBe('pro')
    expect(routeFor('https://gist.github.com/x', routes, spaces)).toBe('pro')
    expect(routeFor('https://www.github.com/', routes, spaces)).toBe('pro')
  })

  it('prefers the most specific rule', () => {
    const routes = [
      { host: 'google.com', spaceId: 'perso' },
      { host: 'docs.google.com', spaceId: 'pro' }
    ]
    expect(routeFor('https://docs.google.com/d/1', routes, spaces)).toBe('pro')
    expect(routeFor('https://mail.google.com/', routes, spaces)).toBe('perso')
  })

  it('ignores rules pointing to a deleted space, look-alike hosts and unparseable input', () => {
    const routes = [
      { host: 'example.com', spaceId: 'deleted' },
      { host: 'news.org', spaceId: 'labo' }
    ]
    expect(routeFor('https://example.com/', routes, spaces)).toBeUndefined()
    expect(routeFor('https://fakenews.org/', routes, spaces)).toBeUndefined()
    expect(routeFor('pas une url', routes, spaces)).toBeUndefined()
  })

  it('matches regardless of the port', () => {
    expect(routeFor('http://localhost:5173/', [{ host: 'localhost', spaceId: 'labo' }], spaces)).toBe('labo')
  })
})
