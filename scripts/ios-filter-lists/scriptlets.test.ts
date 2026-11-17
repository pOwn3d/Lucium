import { describe, expect, it } from 'vitest'
import { parseScriptletCall } from '../../src/shared/scriptlets'
import { convertList, toAsciiDomain } from './abp-to-webkit'
import { buildEmbedded, type ListInput, type ListSource } from './embedded-lists'
import { ScriptletCollector, splitScriptletArguments } from './scriptlets'

const collect = (text: string): ReturnType<typeof convertList> => convertList(text, { scriptlets: new ScriptletCollector(parseScriptletCall, toAsciiDomain) })

describe('splitScriptletArguments', () => {
  it('splits at the commas that are not escaped and trims each part', () => {
    expect(splitScriptletArguments('+js(set-constant, a.b, true)')).toEqual(['set-constant', 'a.b', 'true'])
    expect(splitScriptletArguments('+js(aeld, click, a\\, b)')).toEqual(['aeld', 'click', 'a, b'])
    expect(splitScriptletArguments('+js()')).toEqual([''])
  })

  it('refuses what is not a call', () => {
    expect(splitScriptletArguments('+js(set-constant, a.b')).toBeNull()
    expect(splitScriptletArguments('div.ad')).toBeNull()
  })
})

describe('the scriptlets of a list', () => {
  it('keeps a call the Mac’s library accepts, by site, and writes none of it as a WebKit rule', () => {
    const converted = collect('site.example##+js(set-constant, adsLoaded, false)\nother.example,third.example##+js(abort-on-property-read, ads)')
    expect(converted.scriptlets.domains).toEqual({
      'other.example': [['abort-on-property-read', ['ads']]],
      'site.example': [['set-constant', ['adsLoaded', 'false']]],
      'third.example': [['abort-on-property-read', ['ads']]]
    })
    expect(converted.scriptlets.calls).toBe(3)
    expect(converted.cosmetic).toEqual([])
    expect(converted.stats.dropped).toEqual({})
  })

  it('reads the short names of the lists (`set`, `aopr`) as the library does', () => {
    expect(collect('a.example##+js(set, x, true)\nb.example##+js(aopr.js, y)').scriptlets.domains).toEqual({
      'a.example': [['set-constant', ['x', 'true']]],
      'b.example': [['abort-on-property-read', ['y']]]
    })
  })

  it('leaves out, and counts by reason, what the library refuses or a table of sites cannot say', () => {
    const converted = collect(
      [
        'a.example##+js(trusted-click-element, button)',
        'a.example##+js(set-constant, a.b, not-a-constant)',
        '##+js(set-constant, x, true)',
        'google.*##+js(set-constant, x, true)',
        '~a.example##+js(set-constant, x, true)',
        'a.example##+js(set-constant, x, true, extra, a, b)',
        'a.example##+js(set-constant, x, true'
      ].join('\n')
    )
    expect(converted.scriptlets).toEqual({ domains: {}, calls: 0 })
    expect(converted.stats.dropped).toEqual({
      'scriptlet:unknown-name:trusted-click-element': 1,
      'scriptlet:arguments:set-constant': 1,
      'scriptlet:generic': 1,
      'scriptlet:entity': 1,
      'scriptlet:negated-domain': 1,
      'scriptlet:arguments': 1,
      // `+js(` without its closing parenthesis is no scriptlet filter at all: the cosmetic reader counts it as the scriptlet it was meant to be.
      'scriptlet:malformed': 1
    })
  })

  it('counts them as before when no collector is given (the converter alone knows nothing of scriptlets)', () => {
    expect(convertList('a.example##+js(set-constant, x, true)').stats.dropped).toEqual({ 'cosmetic:scriptlet': 1 })
  })

  it('keeps a call once per site, whatever the number of times a list says it', () => {
    expect(collect('a.example##+js(aopr, x)\na.example##+js(aopr, x)\na.example##+js(aopr, y)').scriptlets.calls).toBe(2)
  })

  it('turns an exception into the removal of the call it names, from the site and its subdomains', () => {
    const converted = collect(
      ['a.example##+js(aopr, x)', 'a.example##+js(aopr, y)', 'sub.a.example##+js(aopr, x)', 'a.example#@#+js(aopr, x)', 'b.example##+js(aopr, z)', 'b.example#@#+js()'].join('\n')
    )
    expect(converted.scriptlets.domains).toEqual({ 'a.example': [['abort-on-property-read', ['y']]] })
  })

  it('applies an exception that comes before the rule it cancels, as the lists allow', () => {
    expect(collect('a.example#@#+js(aopr, x)\na.example##+js(aopr, x)').scriptlets).toEqual({ domains: {}, calls: 0 })
  })

  it('says where a call does not apply when the exception is for a subdomain of the site the rule names', () => {
    expect(collect('a.example##+js(aopr, x)\nsub.a.example#@#+js(aopr, x)').scriptlets.domains).toEqual({ 'a.example': [['abort-on-property-read', ['x'], ['sub.a.example']]] })
  })

  it('writes internationalised sites in ASCII and refuses a name that is not a site', () => {
    expect(Object.keys(collect('bücher.example##+js(aopr, x)').scriptlets.domains)).toEqual(['xn--bcher-kva.example'])
    expect(collect('a b.example##+js(aopr, x)').scriptlets.calls).toBe(0)
  })

  it('writes the sites in lower case', () => {
    expect(Object.keys(collect('Site.Example##+js(aopr, x)').scriptlets.domains)).toEqual(['site.example'])
  })
})

describe('the table in the embedded files', () => {
  const source: ListSource = {
    id: 'sample',
    title: { en: 'Sample', fr: 'Exemple' },
    category: 'ads',
    author: { en: 'The authors', fr: 'Les auteurs' },
    license: { en: 'GPL-3.0', fr: 'GPL-3.0' },
    licenseUrl: 'https://example.org/licence',
    homepage: 'https://example.org/',
    sourceUrl: 'https://example.org/list.txt'
  }
  const text = '||ads.example^\na.example##+js(aopr, x)\nb.example##+js(set, y, true)\n'
  const input: ListInput = { source, text, fetchedAt: '2026-11-17T20:00:00Z', converted: collect(text) }

  it('is a file of the list, named after it, that the registry counts in calls and that WebKit never reads', () => {
    const { files, registry } = buildEmbedded([input], '2026-11-17T20:05:00Z', 150_000)
    expect(JSON.parse(files['sample.scriptlets.json']!)).toEqual({
      schema: 1,
      domains: { 'a.example': [['abort-on-property-read', ['x']]], 'b.example': [['set-constant', ['y', 'true']]] }
    })
    expect(registry.lists[0]!.files.map((file) => [file.kind, file.rules])).toEqual([['network', 2], ['scriptlets', 2]])
  })

  it('is not written for a list that has no scriptlet', () => {
    const plain: ListInput = { ...input, text: '||ads.example^\n', converted: collect('||ads.example^\n') }
    expect(Object.keys(buildEmbedded([plain], '2026-11-17T20:05:00Z', 150_000).files)).not.toContain('sample.scriptlets.json')
  })
})
