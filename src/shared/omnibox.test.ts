import { describe, expect, it } from 'vitest'
import { OMNIBOX_DISPOSITIONS, OMNIBOX_TEXT_MAX, deliverOmnibox, omniboxKeywordOf, omniboxTarget, parseOmniboxRequest, splitOmniboxInput } from './omnibox'
import { omniboxFor, rankCandidates } from './command-bar'
import type { ExtensionInfo } from './ipc'
import type { SidebarState } from './model'
import { createInitialState, reduce } from './sidebar'
import { frenchSpaces } from './french-typography'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'.slice(0, 32)

describe('the keyword of a manifest', () => {
  it('is read from omnibox.keyword', () => {
    expect(omniboxKeywordOf({ omnibox: { keyword: 'gh' } })).toBe('gh')
    expect(omniboxKeywordOf({ omnibox: { keyword: '!' } })).toBe('!')
    expect(omniboxKeywordOf({ omnibox: { keyword: 'x'.repeat(30) } })).toBe('x'.repeat(30))
  })

  it('is nothing for a manifest without one, or with one that cannot be typed', () => {
    for (const manifest of [undefined, null, 3, 'omnibox', [], {}, { omnibox: null }, { omnibox: 'gh' }, { omnibox: {} }, { omnibox: { keyword: '' } }, { omnibox: { keyword: 'g h' } }, { omnibox: { keyword: ' gh' } }, { omnibox: { keyword: 'x'.repeat(31) } }, { omnibox: { keyword: 'a\u0000b' } }, { omnibox: { keyword: 'a\nb' } }, { omnibox: { keyword: 42 } }, { omnibox: { keyword: ['gh'] } }]) {
      expect(omniboxKeywordOf(manifest), JSON.stringify(manifest)).toBeUndefined()
    }
  })
})

describe('what is typed in the bar', () => {
  it('splits into the keyword and the text after the first space', () => {
    expect(splitOmniboxInput('gh react hooks')).toEqual({ keyword: 'gh', text: 'react hooks' })
    expect(splitOmniboxInput('  gh  react')).toEqual({ keyword: 'gh', text: ' react' })
    expect(splitOmniboxInput('gh ')).toEqual({ keyword: 'gh', text: '' })
    expect(splitOmniboxInput('gh\tx')).toEqual({ keyword: 'gh', text: 'x' })
  })

  it('is nothing without a space after the first word, or when the first word is longer than a keyword', () => {
    expect(splitOmniboxInput('gh')).toBeNull()
    expect(splitOmniboxInput('')).toBeNull()
    expect(splitOmniboxInput('   ')).toBeNull()
    expect(splitOmniboxInput(`${'x'.repeat(31)} text`)).toBeNull()
  })

  it('keeps no more text than the extension may be given', () => {
    expect(splitOmniboxInput(`gh ${'a'.repeat(OMNIBOX_TEXT_MAX + 500)}`)!.text).toHaveLength(OMNIBOX_TEXT_MAX)
  })
})

describe('the request of the bar', () => {
  const good = { extensionId: ID, text: 'react hooks', disposition: 'currentTab' }

  it('is accepted with an extension id, a text and one of the three places', () => {
    for (const disposition of OMNIBOX_DISPOSITIONS) expect(parseOmniboxRequest({ ...good, disposition })).toEqual({ ...good, disposition })
    expect(parseOmniboxRequest({ ...good, text: '' })).toEqual({ ...good, text: '' })
    expect(parseOmniboxRequest({ ...good, text: 'é'.repeat(OMNIBOX_TEXT_MAX) })).not.toBeNull()
  })

  it('is refused when it is not exactly that', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'gh',
      [],
      [good],
      {},
      { ...good, extensionId: 'short' },
      { ...good, extensionId: ID.toUpperCase() },
      { ...good, extensionId: `${ID}a` },
      { ...good, extensionId: 42 },
      { ...good, text: 42 },
      { ...good, text: undefined },
      { ...good, text: 'a'.repeat(OMNIBOX_TEXT_MAX + 1) },
      { ...good, disposition: 'newWindow' },
      { ...good, disposition: undefined },
      { ...good, disposition: 'constructor' },
      { ...good, extra: true },
      JSON.parse(`{"extensionId":"${ID}","text":"x","disposition":"currentTab","__proto__":{"x":1}}`)
    ]
    for (const raw of bad) expect(parseOmniboxRequest(raw), JSON.stringify(raw)).toBeNull()
  })
})

// ---------- the row of the command bar ----------

function stateOf(patch: Partial<SidebarState['settings']> = {}): SidebarState {
  const state = createInitialState({ now: 1, newId: () => 'sp' })
  return { ...state, settings: { ...state.settings, ...patch } }
}

const ext = (patch: Partial<ExtensionInfo> = {}): ExtensionInfo => ({ id: ID, name: 'GitHub Helper', version: '1.0', profileId: 'default', source: 'unpacked', enabled: true, omniboxKeyword: 'xk', ...patch })

describe('the extension row of the command bar', () => {
  const on = stateOf({ omniboxKeywords: true })

  it('hands the text after the keyword to the extension that declared it', () => {
    expect(omniboxFor('xk react hooks', on, [ext()])).toEqual({ kind: 'omnibox', id: `omnibox:${ID}`, label: frenchSpaces('GitHub Helper : « react hooks »'), detail: 'Mot-clé d’extension', extensionId: ID, text: 'react hooks' })
  })

  it('names the extension alone when the keyword is typed with its space and nothing else', () => {
    expect(omniboxFor('xk ', on, [ext()])).toMatchObject({ label: 'GitHub Helper', text: '' })
  })

  it('does not care for the case of the keyword', () => {
    expect(omniboxFor('XK x', on, [ext()])).toMatchObject({ extensionId: ID, text: 'x' })
    expect(omniboxFor('xk x', on, [ext({ omniboxKeyword: 'XK' })])).toMatchObject({ extensionId: ID })
  })

  it('is nothing while the function is off, whatever is typed', () => {
    expect(omniboxFor('xk react', stateOf({ omniboxKeywords: false }), [ext()])).toBeNull()
    expect(rankCandidates('xk react', stateOf({ omniboxKeywords: false }), [], [], [ext()]).some((c) => c.kind === 'omnibox')).toBe(false)
  })

  it('is nothing for a word that is no keyword, an extension that is off or in another profile, or a keyword without its space', () => {
    expect(omniboxFor('hg react', on, [ext()])).toBeNull()
    expect(omniboxFor('xk', on, [ext()])).toBeNull()
    expect(omniboxFor('xk react', on, [ext({ enabled: false })])).toBeNull()
    expect(omniboxFor('xk react', on, [ext({ profileId: 'work' })])).toBeNull()
    expect(omniboxFor('xk react', on, [ext({ omniboxKeyword: undefined })])).toBeNull()
    expect(omniboxFor('xk react', on, [])).toBeNull()
  })

  it('goes to the first extension listed when two share a keyword', () => {
    expect(omniboxFor('xk x', on, [ext({ id: OTHER, name: 'Premier' }), ext({ name: 'Second' })])).toMatchObject({ extensionId: OTHER })
  })

  it('leads the list and stands for the web search of the same words', () => {
    const rows = rankCandidates('xk react hooks', on, [], [], [ext()])
    expect(rows[0]!.kind).toBe('omnibox')
    expect(rows.some((c) => c.kind === 'open')).toBe(false)
  })

  it('leaves the user’s own site searches first: their keyword wins', () => {
    let state = reduce(on, { type: 'settings/update', patch: { siteSearches: [{ keyword: 'xk', name: 'GitHub', url: 'https://github.com/search?q=%s' }] } }, { now: 1, newId: () => 'x' })
    state = { ...state, settings: { ...state.settings, omniboxKeywords: true } }
    const rows = rankCandidates('xk react', state, [], [], [ext()])
    expect(rows[0]).toMatchObject({ kind: 'open', id: 'open:site' })
    expect(rows.some((c) => c.kind === 'omnibox')).toBe(false)
  })

  it('still searches the web for text that is not a keyword', () => {
    const rows = rankCandidates('react hooks', on, [], [], [ext()])
    expect(rows[0]).toMatchObject({ kind: 'open', search: true })
  })
})

describe('the extension a request is for', () => {
  const request = { extensionId: ID, text: 'x', disposition: 'currentTab' } as const
  const one = ext({ omniboxKeyword: 'xk' })

  it('is the one that is on in the profile and declared a keyword', () => {
    expect(omniboxTarget(true, false, 'default', [one], request)).toBe(one)
  })

  it('is none, with the reason, while the function is off, in a private window, for an extension that is off or elsewhere, or without a keyword', () => {
    expect(omniboxTarget(false, false, 'default', [one], request)).toContain('off')
    expect(omniboxTarget(true, true, 'default', [one], request)).toContain('private')
    expect(omniboxTarget(true, false, 'default', [], request)).toContain('not on')
    expect(omniboxTarget(true, false, 'default', [{ ...one, enabled: false }], request)).toContain('not on')
    expect(omniboxTarget(true, false, 'work', [one], request)).toContain('not on')
    expect(omniboxTarget(true, false, 'default', [{ ...one, id: OTHER }], request)).toContain('not on')
    expect(omniboxTarget(true, false, 'default', [{ ...one, omniboxKeyword: undefined }], request)).toContain('no keyword')
  })
})

describe('what the extension is told', () => {
  const request = { extensionId: ID, text: 'react hooks', disposition: 'newForegroundTab' } as const

  it('is that input started, then the text and the place', async () => {
    const told: Array<[string, unknown[]]> = []
    await deliverOmnibox(async (event, args) => void told.push([event, args]), request)
    expect(told).toEqual([['onInputStarted', []], ['onInputEntered', ['react hooks', 'newForegroundTab']]])
  })

  it('stops at the first failure, and says it: the text is not sent to a worker that could not be reached', async () => {
    const told: string[] = []
    await expect(
      deliverOmnibox(async (event) => {
        told.push(event)
        throw new Error('The worker did not start')
      }, request)
    ).rejects.toThrow('The worker did not start')
    expect(told).toEqual(['onInputStarted'])
  })

  it('does not send the text when only the second event fails: the failure reaches the caller', async () => {
    await expect(
      deliverOmnibox(async (event) => {
        if (event === 'onInputEntered') throw new Error('gone')
      }, request)
    ).rejects.toThrow('gone')
  })
})
