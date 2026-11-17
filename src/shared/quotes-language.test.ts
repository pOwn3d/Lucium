// The quotation marks of the texts the code builds: « … » with spaces in French, “…” in English, never the French ones whatever the language.

import { afterEach, describe, expect, it } from 'vitest'
import { candidatePreview, omniboxFor, rankCandidates } from './command-bar'
import { refusalMessage } from './download-resume'
import { authRequestOf, authText } from './http-auth'
import { getLanguage, quoted, setLanguage } from './i18n'
import type { ExtensionInfo } from './ipc'
import { createInitialState } from './sidebar'
import { frenchSpaces } from './french-typography'

afterEach(() => setLanguage('fr'))

const state = (() => {
  const base = createInitialState({ now: 1, newId: () => 'sp' })
  return { ...base, settings: { ...base.settings, omniboxKeywords: true } }
})()
const extension: ExtensionInfo = { id: 'abcdefghijklmnopabcdefghijklmnop', name: 'GitHub Helper', version: '1.0', profileId: 'default', source: 'unpacked', enabled: true, omniboxKeyword: 'xk' }

describe('quoted', () => {
  it('spaces the quotes the French way, and uses curly ones in English', () => {
    expect(quoted('Zone privée', 'fr')).toBe(frenchSpaces('« Zone privée »'))
    expect(quoted('Private zone', 'en')).toBe('“Private zone”')
  })

  it('follows the language of the process when none is given', () => {
    setLanguage('en')
    expect(getLanguage()).toBe('en')
    expect(quoted('x')).toBe('“x”')
    setLanguage('fr')
    expect(quoted('x')).toBe(frenchSpaces('« x »'))
  })
})

describe('the texts built in code, in English', () => {
  it('quotes the text given to an extension keyword, and puts its colon the English way', () => {
    setLanguage('en')
    expect(omniboxFor('xk react hooks', state, [extension])?.label).toBe('GitHub Helper: “react hooks”')
    setLanguage('fr')
    expect(omniboxFor('xk react hooks', state, [extension])?.label).toBe(frenchSpaces('GitHub Helper : « react hooks »'))
  })

  it('quotes the search in the preview of the highlighted line', () => {
    const at = { now: 1_000_000, mode: 'new' as const, history: [] }
    const search = rankCandidates('something', state, []).find((c) => c.kind === 'open')!
    setLanguage('en')
    expect(candidatePreview(search, { state, ...at }).title).toBe('“something”')
    setLanguage('fr')
    expect(candidatePreview(search, { state, ...at }).title).toBe(frenchSpaces('« something »'))
  })

  it('quotes the realm a site asks a login for', () => {
    const request = authRequestOf('a', { host: 'intranet.example', port: 443, scheme: 'basic', realm: 'Private zone', isProxy: false, url: 'https://intranet.example/doc' })
    setLanguage('en')
    expect(authText(request).message).toBe('intranet.example asks for a username and password (“Private zone”).')
    setLanguage('fr')
    expect(authText(request).message).toContain(frenchSpaces('(« Private zone »)'))
  })

  it('quotes the name of the file whose download cannot be resumed', () => {
    setLanguage('en')
    expect(refusalMessage('archive.zip', 'etag')).toContain('“archive.zip”')
    expect(refusalMessage('archive.zip', 'etag')).not.toMatch(/[«»]/)
    setLanguage('fr')
    expect(refusalMessage('archive.zip', 'etag')).toContain(frenchSpaces('« archive.zip »'))
  })
})
