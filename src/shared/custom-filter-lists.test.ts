// The user's own filter lists: what is kept of a list found anywhere, what is left out and counted, and what the settings may hold.

import { describe, expect, it } from 'vitest'
import {
  CUSTOM_LISTS_MAX,
  CUSTOM_PASTE_MAX_CHARS,
  CUSTOM_RULES_MAX,
  CUSTOM_RULE_MAX_CHARS,
  CUSTOM_WILDCARDS_MAX,
  cleanCustomFilterLists,
  cleanReviewSummary,
  describeReview,
  isCustomListId,
  listTitleFor,
  reviewCustomList,
  withCustomListEnabled,
  type CustomFilterList
} from './custom-filter-lists'
import { privateAction } from './private-window'
import { createInitialState, reduce, type Action } from './sidebar'
import { interfaceMayDispatch } from './ipc-policy'
import { setLanguage } from './i18n'
import { frenchSpaces } from './french-typography'

const accepts = () => true
/** Reads a list as the engine would, with a parser that refuses the lines containing "REFUSED". */
const review = (text: string, parses: (line: string) => boolean = accepts) => reviewCustomList(text, parses)
const kept = (text: string, parses?: (line: string) => boolean): string[] => {
  const verdict = review(text, parses)
  return verdict.ok ? verdict.review.text.trim().split('\n') : []
}
const counts = (text: string) => {
  const verdict = review(text)
  if (!verdict.ok) throw new Error(verdict.reason)
  return { rules: verdict.review.rules, ignored: verdict.review.ignored, invalid: verdict.review.invalid }
}

describe('a list that is fine', () => {
  it('keeps network rules, exceptions and cosmetic rules, and drops the comments, the header and the blank lines', () => {
    const text = '[Adblock Plus 2.0]\n! Title: Mes règles\n! un commentaire\n\n||pub.example^$third-party\n@@||ok.example^\nexemple.org##.bandeau\n##.pub\n'
    const verdict = review(text)
    expect(verdict).toMatchObject({ ok: true, review: { rules: 4, ignored: 0, invalid: 0, title: 'Mes règles' } })
    expect(kept(text)).toEqual(['||pub.example^$third-party', '@@||ok.example^', 'exemple.org##.bandeau', '##.pub'])
  })

  it('reads any line ending and a byte-order mark', () => {
    expect(kept('﻿||a.example^\r\n||b.example^\r||c.example^\n')).toEqual(['||a.example^', '||b.example^', '||c.example^'])
  })

  it('keeps the options the engine applies, with a domain list', () => {
    expect(kept('||cdn.example/*.js$script,domain=a.example|~b.example\n||x.example^$image,third-party,important')).toHaveLength(2)
  })
})

describe('scripts are never kept, never run', () => {
  // Rules that run code of the list's own, or a scriptlet the library does not have: always left out.
  const scripts = ['example.com##+js(trusted-click-element, button)', 'example.com#%#window.x = 1', 'example.com#$#body { background: red }', 'example.com#?#.ad:has(> .x)', 'example.com##+js(set-constant, adsOn, alert(1))', 'example.com##+js(eval, 1)']

  it('leaves out a scriptlet that is not in the library, an argument that is not allowed, and the scripts of other syntaxes, and counts them', () => {
    for (const rule of scripts) expect(counts(`||garde.example^\n${rule}`), rule).toEqual({ rules: 1, ignored: 1, invalid: 0 })
  })

  it('refuses a scriptlet that names no site: it would run on every page', () => {
    expect(counts('||garde.example^\n##+js(set-constant, adsOn, false)\n##+js(aopr, x)')).toEqual({ rules: 1, ignored: 0, invalid: 2 })
  })

  it('does not put the script in the text that is installed', () => {
    const verdict = review(`||garde.example^\n${scripts.join('\n')}`)
    expect(verdict.ok && verdict.review.text).toBe('||garde.example^\n')
  })

  it('says why a scriptlet was refused', () => {
    const verdict = review('||garde.example^\nexample.com##+js(trusted-click-element, button)\nexample.com##+js(set-constant, a, alert(1))\nexample.com##+js(aopr, "a.__proto__")')
    expect(verdict.ok && verdict.review.samples.map((s) => s.reason)).toEqual([
      frenchSpaces('Scriptlet refusé : Scriptlet « trusted-click-element » inconnu'),
      frenchSpaces('Scriptlet refusé : Arguments refusés pour « set-constant »'),
      frenchSpaces('Scriptlet refusé : Arguments refusés pour « abort-on-property-read »')
    ])
  })

  it('leaves out the rules that change the page or need a script to be evaluated: HTML filters, :style, :remove, extended selectors', () => {
    for (const rule of ['example.com##^script[data-ad]', 'example.com##.ad:has-text(Sponsor)', 'example.com##.ad:style(background: url(https://x.example/y))', 'example.com##.ad:remove()', 'example.com##div:xpath(//a)', 'example.com##.a:matches-css(color: red)', 'example.com##.a:-abp-contains(pub)', 'example.com##.a:upward(2)']) {
      expect(counts(`||garde.example^\n${rule}`), rule).toEqual({ rules: 1, ignored: 1, invalid: 0 })
    }
  })

  it('leaves out the directives of uBlock Origin, which the engine would not honour (the rules around them would lose their condition)', () => {
    expect(counts('!#if env_firefox\n||a.example^\n!#endif\n!#include autre.txt')).toEqual({ rules: 1, ignored: 3, invalid: 0 })
  })
})

describe('what could freeze the browser is left out', () => {
  it('refuses a regular expression, which a crafted one makes take seconds on a short address', () => {
    expect(counts('||garde.example^\n/(a+)+$/\n/ads?\\.example/\n||x.example^$domain=/re.*gex/')).toEqual({ rules: 1, ignored: 3, invalid: 0 })
  })

  it('refuses a regular expression whatever follows its last "$": the engine reads options there that do not look like options', () => {
    // `3p` and `1p` start with a digit, the third has a parenthesis in its domain, the fourth has nothing after the "$".
    for (const rule of ['/(a+)+b/$3p', '/(a+)+b/$1p', '/(a+)+b/$domain=exa(mple.com', '/(a+)+b/$', '@@/(a+)+b/$3p,script']) {
      const verdict = review(`||garde.example^\n${rule}`)
      expect(verdict, rule).toMatchObject({ ok: true, review: { rules: 1, ignored: 1, invalid: 0, text: '||garde.example^\n' } })
      if (verdict.ok) expect(verdict.review.samples[0]?.reason, rule).toContain('Expression régulière')
    }
  })

  it('reads the options behind one written with a digit, and none after a "$" the engine does not cut at', () => {
    // An option the application does not apply is seen behind a party written with a digit.
    expect(counts('||garde.example^\n||a.example^$3p,popup')).toEqual({ rules: 1, ignored: 1, invalid: 0 })
    // An escaped "$" and a "$" before a slash belong to the pattern.
    expect(kept('||a.example/prix\\$popup\n||b.example/a$/b')).toEqual(['||a.example/prix\\$popup', '||b.example/a$/b'])
  })

  it(`allows ${CUSTOM_WILDCARDS_MAX} wildcards at most in a rule`, () => {
    expect(kept('||a.example/*/ads/*.js')).toHaveLength(1)
    expect(counts('||garde.example^\n||a.example/*a*a*b')).toEqual({ rules: 1, ignored: 1, invalid: 0 })
    expect(counts('||garde.example^\n*a*b*c*d')).toEqual({ rules: 1, ignored: 1, invalid: 0 })
  })

  it('refuses a rule that would match everything', () => {
    for (const rule of ['*', '||*^', '^', '|', '||', '$script', '*^*']) expect(counts(`||garde.example^\n${rule}`), rule).toEqual({ rules: 1, ignored: 0, invalid: 1 })
  })

  it('refuses a rule longer than any real one', () => {
    expect(counts(`||garde.example^\n||${'a'.repeat(CUSTOM_RULE_MAX_CHARS)}.example^`)).toEqual({ rules: 1, ignored: 0, invalid: 1 })
  })

  it('refuses a selector that could close the style rule it is written into, or comment out the rest of the style sheet', () => {
    for (const rule of ['exemple.org##.a{}body{background:red}', 'exemple.org##.a}', 'exemple.org##.a/*', 'exemple.org##.a;color:red', 'exemple.org##']) expect(counts(`||garde.example^\n${rule}`), rule).toEqual({ rules: 1, ignored: 0, invalid: 1 })
  })

  it('refuses a selector longer than 1000 characters, well inside the length of a rule, and keeps one at that bound', () => {
    expect(counts(`||garde.example^\nexemple.org##.${'a'.repeat(1000)}`)).toEqual({ rules: 1, ignored: 0, invalid: 1 })
    expect(counts(`||garde.example^\nexemple.org##.${'a'.repeat(999)}`)).toEqual({ rules: 2, ignored: 0, invalid: 0 })
  })

  it('refuses domains that are not host names', () => {
    expect(counts('||garde.example^\n<script>##.ad')).toEqual({ rules: 1, ignored: 0, invalid: 1 })
  })
})

describe('what is not a rule is told', () => {
  it('says what a hosts-file line should be, and refuses a line with a space in its pattern', () => {
    const verdict = review('||garde.example^\n0.0.0.0 pub.example\nvoici une phrase\n')
    expect(verdict).toMatchObject({ ok: true, review: { rules: 1, invalid: 2 } })
    expect(verdict.ok && verdict.review.samples).toEqual([
      { line: 2, text: '0.0.0.0 pub.example', reason: frenchSpaces('Format « hosts » : écrivez ||nom-de-domaine^') },
      { line: 3, text: 'voici une phrase', reason: 'Espace dans le motif' }
    ])
  })

  it('counts what the engine\'s own parser refuses, and keeps it out of the text', () => {
    const verdict = review('||garde.example^\n||REFUSED.example^\n', (line) => !line.includes('REFUSED'))
    expect(verdict).toMatchObject({ ok: true, review: { rules: 1, invalid: 1, text: '||garde.example^\n' } })
  })

  it('leaves out the options this application does not apply, and says which', () => {
    const verdict = review('||garde.example^\n||a.example^$queryprune=utm\n||b.example^$header=x\n||c.example^$replace=/a/b/')
    expect(verdict).toMatchObject({ ok: true, review: { rules: 1, ignored: 3 } })
    expect(verdict.ok && verdict.review.samples.map((s) => s.reason)).toEqual([frenchSpaces('Option « queryprune » non prise en charge'), frenchSpaces('Option « header » non prise en charge'), 'Expression régulière dans une option (refusée)'])
  })

  it('shows a few examples with their line, cut short, and counts all of them', () => {
    const bad = Array.from({ length: 30 }, (_, i) => `mauvaise règle ${i} ${'x'.repeat(300)}`)
    const verdict = review(`||garde.example^\n${bad.join('\n')}`)
    expect(verdict.ok && verdict.review.invalid).toBe(30)
    expect(verdict.ok && verdict.review.samples).toHaveLength(8)
    expect(verdict.ok && verdict.review.samples.every((s) => s.text.length <= 120)).toBe(true)
    expect(verdict.ok && verdict.review.samples[0]!.line).toBe(2)
  })
})

describe('the extended rules that are kept', () => {
  it('keeps a scriptlet of the library with its arguments, and the exception that cancels one', () => {
    const rules = ['example.com##+js(aopr, adsbygoogle)', 'example.com,~sub.example.com##+js(set-constant, adsOn, false)', 'example.com##+js(acs, document.createElement, /\\.fonts\\./)', 'example.com#@#+js()', 'example.com#@#+js(aopr, adsbygoogle)']
    expect(kept(`||garde.example^\n${rules.join('\n')}`)).toEqual(['||garde.example^', ...rules])
  })

  it('keeps $removeparam with one plain name, and the exception that lifts it', () => {
    const rules = ['||t.example^$removeparam=fbclid', '||t.example^$removeparam=utm_source,image', '@@||t.example/ok^$removeparam', '@@||t.example/ok^$removeparam=fbclid']
    expect(counts(rules.join('\n'))).toEqual({ rules: 4, ignored: 0, invalid: 0 })
  })

  it('leaves out $removeparam written as an expression, as an inversion, with a bad name, or with no name', () => {
    const verdict = review('||garde.example^\n||a.example^$removeparam=/^utm_/\n||b.example^$removeparam=~keep\n||c.example^$removeparam=a b\n||d.example^$removeparam')
    expect(verdict).toMatchObject({ ok: true, review: { rules: 1, ignored: 4 } })
    expect(verdict.ok && verdict.review.samples.map((s) => s.reason)).toEqual([
      'Expression régulière dans une option (refusée)',
      frenchSpaces('Paramètre à retirer : un nom simple seulement'),
      frenchSpaces('Paramètre à retirer : un nom simple seulement'),
      frenchSpaces('Retirer tous les paramètres : refusé')
    ])
  })

  it('keeps a $csp made of restricting directives, with or without a closing semicolon, and the exception that lifts it', () => {
    const rules = ["||s.example^$csp=script-src 'none'", "||t.example^$csp=script-src 'self'; frame-src 'none';", '@@||u.example^$csp']
    expect(counts(rules.join('\n'))).toEqual({ rules: 3, ignored: 0, invalid: 0 })
  })

  it('leaves out a $csp that would report to someone, one with a directive that is not offered, and an empty one', () => {
    const verdict = review("||garde.example^\n||a.example^$csp=script-src 'none'; report-uri https://t.example/r\n||b.example^$csp=upgrade-insecure-requests\n||c.example^$csp")
    expect(verdict).toMatchObject({ ok: true, review: { rules: 1, ignored: 3 } })
  })

  it('still leaves out the options this application does not apply', () => {
    expect(counts('||garde.example^\n||a.example^$replace=/a/b/\n||b.example^$queryprune=x\n||c.example^$header=x')).toEqual({ rules: 1, ignored: 3, invalid: 0 })
  })

  it('keeps a redirect rule whatever the resource: the blocker cancels the request when it has no stand-in for it', () => {
    expect(counts('||a.example/x.js$script,redirect=noopjs\n||b.example/x.js$script,redirect-rule=whatever.js')).toEqual({ rules: 2, ignored: 0, invalid: 0 })
  })
})

describe('what is not a list is refused with a sentence', () => {
  it('refuses an empty text, a binary one, a web page, a text with no usable rule and one that is too large', () => {
    expect(review('   \n')).toEqual({ ok: false, reason: 'Le texte est vide.' })
    expect(review('||a.example^\u0000')).toEqual({ ok: false, reason: 'Le contenu est binaire.' })
    expect(review('<!DOCTYPE html><html><body>Connexion</body></html>')).toEqual({ ok: false, reason: 'Ce texte est une page web, pas une liste de règles.' })
    expect(review('! seulement un commentaire\n')).toEqual({ ok: false, reason: 'Aucune règle utilisable.' })
    expect(review('example.com##+js(abort)')).toEqual({ ok: false, reason: 'Aucune règle utilisable. 0 règle invalide, 1 règle ignorée.' })
    expect(review('x'.repeat(CUSTOM_PASTE_MAX_CHARS + 1))).toEqual({ ok: false, reason: 'La liste est trop volumineuse.' })
    expect(reviewCustomList(42 as unknown as string, accepts)).toEqual({ ok: false, reason: 'Le texte est vide.' })
  })

  it('refuses a list with more rules than it may hold', () => {
    const verdict = reviewCustomList(Array.from({ length: CUSTOM_RULES_MAX + 1 }, (_, i) => `||s${i}.example^`).join('\n'), accepts, 20_000_000)
    expect(verdict.ok).toBe(false)
  })
})

describe('the lists the settings hold', () => {
  const list = (patch: Partial<CustomFilterList> = {}): CustomFilterList => ({ id: 'custom-0123abcd', title: 'Mes règles', source: 'paste', sourceName: 'Règles collées', enabled: true, addedAt: 5, ...patch })

  it('recognises the id of a custom list: nothing that could name another file', () => {
    expect(isCustomListId('custom-0123abcd')).toBe(true)
    for (const bad of ['custom-0123ABCD', 'custom-0123abc', 'custom-0123abcde', '../custom-0123abcd', 'easylist', '', 5, null]) expect(isCustomListId(bad), String(bad)).toBe(false)
  })

  it('keeps well-formed entries once and drops the rest', () => {
    const out = cleanCustomFilterLists([list(), list({ title: 'Doublon' }), list({ id: '../../x' }), list({ id: 'custom-ffffffff', title: '  ' }), list({ id: 'custom-eeeeeeee', source: 'url' as 'file' }), 'texte', null])
    expect(out).toEqual([list()])
  })

  it('is bounded', () => {
    const many = Array.from({ length: CUSTOM_LISTS_MAX + 5 }, (_, i) => list({ id: `custom-${String(i).padStart(8, '0')}` }))
    expect(cleanCustomFilterLists(many)).toHaveLength(CUSTOM_LISTS_MAX)
    expect(cleanCustomFilterLists('texte')).toEqual([])
  })

  it('switches a list on or off, and keeps the same array when nothing changes', () => {
    const lists = [list()]
    expect(withCustomListEnabled(lists, 'custom-0123abcd', false)).toEqual([list({ enabled: false })])
    expect(withCustomListEnabled(lists, 'custom-0123abcd', true)).toBe(lists)
    expect(withCustomListEnabled(lists, 'custom-ffffffff', false)).toBe(lists)
    expect(withCustomListEnabled(lists, 'custom-0123abcd', 'yes')).toBe(lists)
  })

  it('names a list: what the user wrote, else the list\'s own title, else the file\'s', () => {
    expect(listTitleFor('  Perso ', 'Titre', 'f.txt')).toBe('Perso')
    expect(listTitleFor('', 'Titre', 'f.txt')).toBe('Titre')
    expect(listTitleFor(undefined, undefined, 'f')).toBe('f')
    expect(listTitleFor(undefined, undefined, '')).toBe('Liste personnalisée')
  })

  it('tells how many rules, and how many were left out', () => {
    expect(describeReview(12, { ignored: 2, invalid: 1, samples: [] })).toBe('12 règles · 2 ignorées · 1 invalide')
    expect(describeReview(1, undefined)).toBe('1 règle')
    expect(describeReview(null, { ignored: 0, invalid: 0, samples: [] })).toBe('')
  })

  it('tells it in English, with the digits of English', () => {
    setLanguage('en')
    try {
      expect(describeReview(12_000, { ignored: 1, invalid: 2, samples: [] })).toBe('12,000 rules · 1 ignored · 2 invalid')
      expect(describeReview(1, undefined)).toBe('1 rule')
    } finally {
      setLanguage('fr')
    }
  })

  it('reads a summary back from an index that was edited by hand', () => {
    expect(cleanReviewSummary({ ignored: 2, invalid: -1, samples: [{ line: 3, text: 'x', reason: 'y' }, { line: 0, text: 'x', reason: 'y' }, 'z', null] })).toEqual({ ignored: 2, invalid: 0, samples: [{ line: 3, text: 'x', reason: 'y' }] })
    expect(cleanReviewSummary('texte')).toBeUndefined()
    expect(cleanReviewSummary(null)).toBeUndefined()
  })
})

describe('the actions behind the settings', () => {
  const ctx = { now: 1, newId: () => 'id' }
  const run = (state: ReturnType<typeof createInitialState>, ...actions: Action[]) => actions.reduce((s, a) => reduce(s, a, ctx), state)
  const list: CustomFilterList = { id: 'custom-0123abcd', title: 'Mes règles', source: 'file', sourceName: 'x.txt', enabled: true, addedAt: 5 }

  it('records a list the main process installed, once, up to the limit, and forgets it when asked', () => {
    const start = createInitialState(ctx)
    const added = run(start, { type: 'filterlist/add', list })
    expect(added.settings.customFilterLists).toEqual([list])
    expect(run(added, { type: 'filterlist/add', list })).toBe(added)
    expect(run(added, { type: 'filterlist/remove', id: 'custom-0123abcd' }).settings.customFilterLists).toEqual([])
    expect(run(added, { type: 'filterlist/remove', id: 'custom-ffffffff' })).toBe(added)
    const full = run(start, ...Array.from({ length: CUSTOM_LISTS_MAX }, (_, i): Action => ({ type: 'filterlist/add', list: { ...list, id: `custom-${String(i).padStart(8, '0')}` } })))
    expect(run(full, { type: 'filterlist/add', list })).toBe(full)
  })

  it('refuses an entry that is not a well-formed list', () => {
    const start = createInitialState(ctx)
    expect(run(start, { type: 'filterlist/add', list: { ...list, id: '../../etc/passwd' } })).toBe(start)
    expect(run(start, { type: 'filterlist/add', list: { ...list, source: 'url' as 'file' } })).toBe(start)
  })

  it('switches a list on and off', () => {
    const added = run(createInitialState(ctx), { type: 'filterlist/add', list })
    expect(run(added, { type: 'filterlist/enable', id: list.id, enabled: false }).settings.customFilterLists[0]!.enabled).toBe(false)
    expect(run(added, { type: 'filterlist/enable', id: list.id, enabled: true })).toBe(added)
  })

  it('is not the interface\'s to add or remove: the main process reads the file and keeps its rules first', () => {
    expect(interfaceMayDispatch({ type: 'filterlist/add', list }, [])).toBe(false)
    expect(interfaceMayDispatch({ type: 'filterlist/remove', id: list.id }, [])).toBe(false)
    expect(interfaceMayDispatch({ type: 'filterlist/enable', id: list.id, enabled: false }, [])).toBe(true)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { customFilterLists: [list] } }, [])).toBe(false)
    expect(interfaceMayDispatch({ type: 'settings/update', patch: { blockCosmetic: false } }, [])).toBe(true)
  })

  it('is refused by a private window, which keeps nothing on disk', () => {
    for (const action of [{ type: 'filterlist/add', list }, { type: 'filterlist/remove', id: list.id }, { type: 'filterlist/enable', id: list.id, enabled: true }] satisfies Action[]) expect(privateAction(action), action.type).toBeNull()
  })
})
