import { describe, expect, it } from 'vitest'
import { createInitialState, normalize, reduce, type Ctx } from './sidebar'
import { cleanDeveloperHosts, developerModeLabel, developerModeOpensTools, DEVELOPER_HOSTS_MAX, isDeveloperUrl, setDeveloperHost } from './developer-mode'

describe('developer hosts', () => {
  it('match the site and its subdomains, not look-alikes', () => {
    const hosts = ['localhost', 'example.com']
    expect(isDeveloperUrl('http://localhost:3000/app', hosts)).toBe(true)
    expect(isDeveloperUrl('https://www.example.com/x', hosts)).toBe(true)
    expect(isDeveloperUrl('https://api.example.com/', hosts)).toBe(true)
    expect(isDeveloperUrl('https://notexample.com/', hosts)).toBe(false)
    expect(isDeveloperUrl('https://example.com.evil.org/', hosts)).toBe(false)
    expect(isDeveloperUrl('about:blank', hosts)).toBe(false)
    expect(isDeveloperUrl(null, hosts)).toBe(false)
    expect(isDeveloperUrl('https://example.com/', [])).toBe(false)
  })

  it('turn on once, whatever the address typed, and off for the site and its parents', () => {
    expect(setDeveloperHost([], 'https://www.Example.com/page?x=1', true)).toEqual(['example.com'])
    expect(setDeveloperHost(['example.com'], 'api.example.com', true)).toEqual(['example.com'])
    expect(setDeveloperHost(['example.com', 'localhost'], 'api.example.com', false)).toEqual(['localhost'])
    expect(setDeveloperHost(['a.com'], 'not a host', true)).toEqual(['a.com'])
  })

  it('are cleaned when read from a file: valid hosts only, each once, bounded', () => {
    expect(cleanDeveloperHosts(['A.com', 'a.com', 42, '', 'javascript:alert(1)', 'b.org'])).toEqual(['a.com', 'b.org'])
    expect(cleanDeveloperHosts('nope')).toEqual([])
    expect(cleanDeveloperHosts(Array.from({ length: DEVELOPER_HOSTS_MAX + 20 }, (_, i) => `h${i}.example`))).toHaveLength(DEVELOPER_HOSTS_MAX)
  })

  it('give the menu entry its wording for each state', () => {
    expect(developerModeLabel(false)).toBe('Activer le mode développeur pour ce site')
    expect(developerModeLabel(true)).toBe('Désactiver le mode développeur pour ce site')
  })
})

describe('the developer/site action', () => {
  const ctx: Ctx = { now: 1, newId: () => 'id' }
  const start = createInitialState(ctx)

  it('turns a site on and off in the settings, and leaves the state alone when nothing changes', () => {
    const on = reduce(start, { type: 'developer/site', site: 'https://localhost:3000/', enabled: true }, ctx)
    expect(on.settings.developerHosts).toEqual(['localhost'])
    expect(reduce(on, { type: 'developer/site', site: 'localhost', enabled: true }, ctx)).toBe(on)
    expect(reduce(on, { type: 'developer/site', site: 'localhost', enabled: false }, ctx).settings.developerHosts).toEqual([])
    expect(reduce(start, { type: 'developer/site', site: 'localhost', enabled: false }, ctx)).toBe(start)
  })

  it('only takes a real true from the interface, and drops garbage from a saved file', () => {
    const lax = reduce(start, { type: 'developer/site', site: 'a.com', enabled: 'yes' as unknown as boolean }, ctx)
    expect(lax).toBe(start)
    const saved = normalize({ ...start, settings: { ...start.settings, developerHosts: ['b.org', 7, 'b.org'] as unknown as string[] } })
    expect(saved.settings.developerHosts).toEqual(['b.org'])
  })
})

// The site panel's Developer Mode row, switched on, shows the developer tools too.
describe('the developer tools that follow the site panel\'s Developer Mode row', () => {
  const on = { type: 'developer/site', site: 'a.com', enabled: true } as const
  const off = { type: 'developer/site', site: 'a.com', enabled: false } as const

  it('open when the mode was switched on, and not when it was switched off', () => {
    expect(developerModeOpensTools(on, [], ['a.com'])).toBe(true)
    expect(developerModeOpensTools(off, ['a.com'], [])).toBe(false)
  })

  it('stay shut when nothing changed (a refused action, a site already on) and for any other action', () => {
    expect(developerModeOpensTools(on, [], [])).toBe(false)
    expect(developerModeOpensTools(on, ['a.com'], ['a.com'])).toBe(false)
    expect(developerModeOpensTools({ type: 'tab/select', id: 'x' }, [], ['a.com'])).toBe(false)
  })
})
