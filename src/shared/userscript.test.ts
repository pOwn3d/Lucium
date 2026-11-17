import { describe, expect, it } from 'vitest'
import {
  SENSITIVE_HOSTS,
  USER_SCRIPTS_MAX,
  USER_SCRIPT_MAX_BYTES,
  cleanUserScripts,
  isSensitiveUrl,
  isUserScriptId,
  newUserScriptId,
  parseUserScript,
  parseUserScriptRequest,
  sameScript,
  storedForm,
  userScriptMatches,
  wrapUserScript,
  type UserScript
} from './userscript'
import { setLanguage } from './i18n'
import { frenchSpaces } from './french-typography'

const script = (header: string, body = 'document.title = "x"'): string => `// ==UserScript==\n${header}\n// ==/UserScript==\n${body}\n`
const GOOD = script('// @name Mon script\n// @match https://*.example.com/*')

const ok = (source: string) => {
  const parsed = parseUserScript(source)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed
}
const refusal = (source: unknown): string => {
  const parsed = parseUserScript(source)
  return parsed.ok ? '' : parsed.error
}

describe('parseUserScript', () => {
  it('reads the name, the patterns, the timing and the credits of a header', () => {
    const { meta, warnings } = ok(
      script(
        ['// @name         Lisible', '// @namespace    https://exemple.fr/', '// @version      1.2', '// @description  Rend la page lisible', '// @author       Moi', '// @match        https://*.example.com/docs/*', '// @match        http://localhost:3000/*', '// @exclude      https://www.example.com/docs/private*', '// @run-at       document-end', '// @grant        none'].join('\n')
      )
    )
    expect(meta).toEqual({
      name: 'Lisible',
      namespace: 'https://exemple.fr/',
      version: '1.2',
      description: 'Rend la page lisible',
      matches: ['https://*.example.com/docs/*', 'http://localhost:3000/*'],
      excludes: ['https://www.example.com/docs/private*'],
      runAt: 'document-end'
    })
    expect(warnings).toEqual([])
  })

  it('runs at idle unless told otherwise, and says when there is no @grant', () => {
    const parsed = ok(GOOD)
    expect(parsed.meta.runAt).toBe('document-idle')
    expect(parsed.warnings.join(' ')).toMatch(/Aucun @grant/)
  })

  it('accepts @grant none and nothing else', () => {
    expect(ok(script('// @name A\n// @match https://a.example/*\n// @grant none')).warnings).toEqual([])
    for (const grant of ['GM_setValue', 'GM_xmlhttpRequest', 'unsafeWindow', 'GM.getValue', '', 'none GM_setValue']) {
      expect(refusal(script(`// @name A\n// @match https://a.example/*\n// @grant ${grant}`)), grant).toMatch(/@grant/)
    }
    // One privileged grant among harmless ones is still a refusal.
    expect(refusal(script('// @name A\n// @match https://a.example/*\n// @grant none\n// @grant GM_getValue'))).toMatch(/@grant/)
  })

  it('refuses code loaded from elsewhere', () => {
    expect(refusal(script('// @name A\n// @match https://a.example/*\n// @require https://cdn.example/lib.js'))).toMatch(/@require/)
  })

  it('reads a key named like a property of every object as an unknown key, not as one of its own', () => {
    // `constructor` is on the prototype of the table of keys that are read but not acted on: it must not be taken for one of them.
    expect(ok(script('// @name A\n// @match https://a.example/*\n// @grant none\n// @constructor x')).warnings).toEqual([frenchSpaces('@constructor n’est pas pris en charge : ignoré.')])
  })

  it('says what is refused and what is left out in English, with the quotes of English', () => {
    setLanguage('en')
    try {
      expect(refusal(script('// @name A\n// @match nope'))).toBe('Invalid @match pattern: “nope”.')
      expect(refusal(script('// @name A\n// @match https://a.example/*\n// @grant'))).toBe('This script asks for @grant (empty): the GM_* functions and unsafeWindow aren’t provided. Only “@grant none” is accepted.')
      expect(ok(script('// @name A\n// @match https://a.example/*\n// @grant none\n// @updateURL x\n// @downloadURL y')).warnings).toEqual(['Automatic updates aren’t supported: a script is replaced by importing it again.'])
    } finally {
      setLanguage('fr')
    }
  })

  it('needs a name and at least one pattern a page can match', () => {
    expect(refusal(script('// @match https://a.example/*'))).toMatch(/nom/)
    expect(refusal(script('// @name A'))).toMatch(/Aucun @match/)
    expect(refusal(script('// @name A\n// @match'))).toMatch(/sans motif/)
    expect(refusal(script('// @name A\n// @include /regex/'))).toMatch(/Aucun @match/)
  })

  it('refuses a pattern that is not a match pattern, and one that is not a web page', () => {
    for (const pattern of ['example.com', 'https://example.com', 'https://*.*.example/*', 'ftp://example.com/*', 'file:///*', 'chrome://settings/*']) {
      expect(refusal(script(`// @name A\n// @match ${pattern}`)), pattern).not.toBe('')
    }
    expect(ok(script('// @name A\n// @match <all_urls>')).meta.matches).toEqual(['<all_urls>'])
  })

  it('reads an @include that is a match pattern as one, and warns about one that is not', () => {
    const { meta, warnings } = ok(script('// @name A\n// @match https://a.example/*\n// @include https://b.example/*\n// @include /^https:\\/\\/c\\.example/\n// @include *://d.example/*'))
    expect(meta.matches).toEqual(['https://a.example/*', 'https://b.example/*', '*://d.example/*'])
    expect(warnings.some((w) => w.includes('@include'))).toBe(true)
  })

  it('maps document-body to document-end and refuses a timing it does not know', () => {
    expect(ok(script('// @name A\n// @match https://a.example/*\n// @run-at document-body')).meta.runAt).toBe('document-end')
    expect(refusal(script('// @name A\n// @match https://a.example/*\n// @run-at context-menu'))).toMatch(/@run-at/)
  })

  it('warns that document-start comes a little late, and that a script for every site is not for sign-in pages', () => {
    expect(ok(script('// @name A\n// @match <all_urls>\n// @run-at document-start\n// @grant none')).warnings.join(' ')).toMatch(/document-start.*après les premiers scripts/s)
    expect(ok(script('// @name A\n// @match *://*/*\n// @grant none')).warnings.join(' ')).toMatch(/tous les sites/)
  })

  it('says what it ignores, and keeps quiet about credits', () => {
    const { warnings } = ok(script('// @name A\n// @match https://a.example/*\n// @grant none\n// @author Moi\n// @license MIT\n// @updateURL https://x.example/a.user.js\n// @resource css https://x.example/a.css\n// @strange yes'))
    expect(warnings.join(' ')).toMatch(/Mise à jour automatique/)
    expect(warnings.join(' ')).toMatch(/@resource/)
    expect(warnings.join(' ')).toMatch(/@strange/)
    expect(warnings.join(' ')).not.toMatch(/@author|@license/)
  })

  it('takes the plain @name, not its translations', () => {
    expect(ok(script('// @name:fr Nom français\n// @name English\n// @match https://a.example/*')).meta.name).toBe('English')
  })

  it('needs the header to be there and closed', () => {
    expect(refusal('console.log(1)')).toMatch(/introuvable/)
    expect(refusal('// ==UserScript==\n// @name A\n// @match https://a.example/*\nconsole.log(1)')).toMatch(/non fermé/)
    expect(refusal(undefined)).not.toBe('')
    expect(refusal(42)).not.toBe('')
  })

  it('refuses a script that is too big, to the byte, not to the character', () => {
    const filler = (bytes: number) => `// ${'x'.repeat(bytes)}\n`
    const base = script('// @name A\n// @match https://a.example/*\n// @grant none')
    expect(parseUserScript(base + filler(USER_SCRIPT_MAX_BYTES - base.length - 4)).ok).toBe(true)
    expect(refusal(base + filler(USER_SCRIPT_MAX_BYTES))).toMatch(/trop gros/)
    // Two bytes per character: under the limit in characters, over it in bytes.
    expect(refusal(base + `// ${'é'.repeat(USER_SCRIPT_MAX_BYTES / 2)}\n`)).toMatch(/trop gros/)
  })

  // Reading the code is the only guard: a line that is not drawn in the order it runs is refused, with the line to look at.
  it('refuses a script that holds a character that changes the reading direction of a line, and names the line', () => {
    for (const hidden of ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069']) {
      expect(refusal(script('// @name A\n// @match https://a.example/*', `const ok = true\nif (ok) {${hidden} run() }`)), `U+${hidden.codePointAt(0)!.toString(16)}`).toMatch(/^La ligne 6 contient des caractères qui changent le sens de lecture/)
    }
    expect(refusal(script(`// @name A\u202E\n// @match https://a.example/*`))).toMatch(/ligne 2/)
  })

  // An honest script holds some of them (the joiner of a composed emoji, a soft hyphen in a sentence): it is taken, and the person is told where to look.
  it('takes a script that holds another invisible character, at the import as well, and warns with its line', () => {
    for (const hidden of ['\u200B', '\u200D', '\u200F', '\u00AD', '\uFEFF', '\u0007']) {
      const parsed = parseUserScript(script('// @name A\n// @match https://a.example/*', `const ok = true\nif (ok) {${hidden} run() }`))
      expect(parsed.ok && parsed.warnings, `U+${hidden.codePointAt(0)!.toString(16)}`).toContain(frenchSpaces('Ce script contient des caractères invisibles (première ligne concernée : 6). Relisez-la avec attention avant de l’activer.'))
    }
    const named = parseUserScript(script(`// @name A\u200B\n// @match https://a.example/*`))
    expect(named.ok && named.warnings.some((warning) => /ligne concernée\s: 2/.test(warning))).toBe(true)
    // The byte order mark an editor writes at the very start of a file hides nothing; a second one does.
    expect(ok(`\uFEFF\n${GOOD}`).warnings.some((warning) => /invisible/.test(warning))).toBe(false)
    expect(ok(`\uFEFF\uFEFF\n${GOOD}`).warnings.some((warning) => /ligne concernée\s: 1/.test(warning))).toBe(true)
    expect(ok(GOOD).warnings.some((warning) => /invisible/.test(warning))).toBe(false)
  })

  it('keeps a stored script that holds such a character', () => {
    const source = script('// @name A\n// @match https://a.example/*', 'run(\u200B)')
    expect(cleanUserScripts({ scripts: [{ id: newUserScriptId(), source, enabled: true }] })).toMatchObject({ dropped: 0, scripts: [{ enabled: true }] })
  })

  it('refuses a binary file, a header line that is absurdly long, and too many patterns', () => {
    expect(refusal(`${GOOD}\0`)).toMatch(/octets nuls/)
    expect(refusal(script(`// @name A\n// @match https://a.example/*\n// @description ${'x'.repeat(5000)}`))).toMatch(/trop longue/)
    const many = Array.from({ length: 70 }, (_, i) => `// @match https://s${i}.example/*`).join('\n')
    expect(refusal(script(`// @name A\n${many}`))).toMatch(/Trop de motifs/)
  })

  it('takes a long run of spaces in a header line without taking long', () => {
    const started = Date.now()
    parseUserScript(script(`// @name A\n// @match https://a.example/*\n// @description x${' '.repeat(1900)}y`))
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('strips control characters from what it shows', () => {
    const kept = parseUserScript(script('// @name A\u0007B\n// @match https://a.example/*'))
    expect(kept.ok && kept.meta.name).toBe('A B')
  })
})

describe('a script whose text is not what it shows', () => {
  const body = (text: string): string => script('// @name A\n// @match https://a.example/*\n// @grant none', text)

  it('is refused when a line holds a character that reorders it, with the number of the line', () => {
    // The header and its two fences take five lines: the body starts at line 6.
    for (const hidden of ['‮', '‪', '⁦', '⁩']) expect(refusal(body(`const ok = 1\nif (admin${hidden}) { steal() }`))).toBe(frenchSpaces('La ligne 7 contient des caractères qui changent le sens de lecture : le code affiché ne serait pas celui qui s’exécute.'))
    // In the header as well: a name is read before anything else.
    expect(refusal(script('// @name A‮gnp.exe\n// @match https://a.example/*'))).toMatch(/^La ligne 2 /)
  })

  it('is refused when it holds a line end that is not drawn (U+2028, U+2029): what follows a comment would run unseen', () => {
    for (const hidden of ['\u2028', '\u2029']) {
      expect(refusal(body(`const ok = 1\n// a note${hidden}steal()`)), `U+${hidden.codePointAt(0)!.toString(16)}`).toBe(frenchSpaces('La ligne 7 contient une fin de ligne invisible : du code pourrait s’exécuter à la suite de ce qui se lit comme un commentaire.'))
      expect(cleanUserScripts({ scripts: [{ id: newUserScriptId(), source: body(`a()${hidden}`), enabled: true, allowPrivate: false, importedAt: 1 }] })).toEqual({ scripts: [], dropped: 1 })
    }
  })

  it('is kept out of the stored list as well: a script accepted by an earlier version does not run on', () => {
    const stored = { scripts: [{ id: newUserScriptId(), source: body('a()‮'), enabled: true, allowPrivate: false, importedAt: 1 }] }
    expect(cleanUserScripts(stored)).toEqual({ scripts: [], dropped: 1 })
    expect(cleanUserScripts({ scripts: [{ ...stored.scripts[0], source: body('a()') }] }).dropped).toBe(0)
  })

  it('is taken with a warning that names the line when it holds another invisible character', () => {
    const parsed = parseUserScript(body('const a = "x​y"'))
    expect(parsed.ok && parsed.warnings).toEqual([frenchSpaces('Ce script contient des caractères invisibles (première ligne concernée : 6). Relisez-la avec attention avant de l’activer.')])
  })

  it('says nothing of a byte order mark at the start of the file, nor of a plain script', () => {
    expect(ok(`﻿${body('a()')}`).warnings).toEqual([])
    expect(ok(body('a()\tb()')).warnings).toEqual([])
  })
})

describe('isSensitiveUrl', () => {
  it('knows sign-in, payment, password and store pages, with their subdomains', () => {
    for (const url of ['https://accounts.google.com/signin', 'https://www.paypal.com/', 'https://bitwarden.com/', 'https://vault.bitwarden.com/', 'https://login.microsoftonline.com/', 'https://chromewebstore.google.com/detail/x', 'https://appleid.apple.com/', 'https://login.example.org/', 'https://secure.example.org/', 'https://pay.shop.example/', 'https://mabanque.bank/', 'https://checkout.stripe.com/c/pay']) {
      expect(isSensitiveUrl(url), url).toBe(true)
    }
    for (const host of SENSITIVE_HOSTS) expect(isSensitiveUrl(`https://${host}/`), host).toBe(true)
  })

  it('leaves ordinary sites alone, including one that merely contains such a word', () => {
    for (const url of ['https://example.com/', 'https://www.google.com/', 'https://news.ycombinator.com/', 'http://localhost:3000/', 'https://notpaypal.com/', 'https://example.com/authors/jane', 'https://example.com/blog/loginfo', 'https://example.com/?next=/login', 'https://example.com/#contact', 'https://example.com/oauth-guide/intro', 'https://paypal.com.evil.example/', 'https://bitwarden.com.evil.example/']) {
      expect(isSensitiveUrl(url), url).toBe(false)
    }
  })

  it('knows a sign-in or payment page by its path, on any site', () => {
    for (const url of ['https://github.com/login', 'https://www.amazon.com/ap/signin', 'https://www.facebook.com/login/', 'https://www.boursorama.com/connexion/', 'https://id.atlassian.com/login', 'https://shop.example/checkout', 'https://example.com/users/sign_in', 'https://example.com/account/LOGIN.ASPX', 'https://example.org/o/oauth2/v2/auth?x=1', 'https://example.org/auth/realms/main', 'https://example.org/login.php', 'https://example.com/#/login', 'https://example.com/#!/connexion?next=/home']) {
      expect(isSensitiveUrl(url), url).toBe(true)
    }
  })

  it('knows the pages that ask for a card or a new password by their path', () => {
    for (const url of ['https://shop.example/payment', 'https://shop.example/pay', 'https://shop.example/fr/paiement/', 'https://app.example/settings/billing', 'https://example.com/signup', 'https://example.com/users/sign_up', 'https://example.com/password/new', 'https://example.com/#/payments']) {
      expect(isSensitiveUrl(url), url).toBe(true)
    }
    for (const url of ['https://example.com/payments-guide', 'https://example.com/blog/paying-less', 'https://example.com/passwordless-news', 'https://example.com/?to=/billing']) expect(isSensitiveUrl(url), url).toBe(false)
  })

  it('reads a segment as the site does: letters written as escapes, and no parameter after a ";"', () => {
    for (const url of ['https://example.com/%6cogin', 'https://example.com/%4Cogin', 'https://example.com/login;jsessionid=ABC123', 'https://example.com/app/checkout;step=2/card', 'https://example.com/%6Cogin.php;x=1']) {
      expect(isSensitiveUrl(url), url).toBe(true)
    }
    // An escape that is not one, and a ";" that follows another word, change nothing.
    for (const url of ['https://example.com/%zzlogin', 'https://example.com/100%', 'https://example.com/news;login']) expect(isSensitiveUrl(url), url).toBe(false)
  })

  it('knows the first label behind a "www."', () => {
    for (const url of ['https://www.login.exemple.fr/', 'https://www.secure.example.org/compte', 'https://www.pay.example/']) expect(isSensitiveUrl(url), url).toBe(true)
    for (const url of ['https://www.example.com/', 'https://www.loginfo.example/', 'https://wwwlogin.example.com/']) expect(isSensitiveUrl(url), url).toBe(false)
  })

  it('knows the first labels on a host of two labels as well (login.gov)', () => {
    for (const url of ['https://login.gov/', 'https://pay.example/', 'https://secure.example/x']) expect(isSensitiveUrl(url), url).toBe(true)
    for (const url of ['https://example.gov/', 'https://loginfo.example/']) expect(isSensitiveUrl(url), url).toBe(false)
  })

  it('treats whatever is not a web page as sensitive', () => {
    for (const url of ['file:///etc/hosts', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/a.html', 'about:blank', 'data:text/html,hi', 'javascript:alert(1)', 'not a url', '', 'view-source:https://example.com/']) {
      expect(isSensitiveUrl(url), url).toBe(true)
    }
  })
})

describe('userScriptMatches', () => {
  const base = { enabled: true, allowPrivate: false, matches: ['https://*.example.com/*'], excludes: ['https://www.example.com/private*'] }

  it('runs on the pages the patterns name and not on the others', () => {
    expect(userScriptMatches(base, 'https://docs.example.com/a', false)).toBe(true)
    expect(userScriptMatches(base, 'https://example.com/', false)).toBe(true)
    expect(userScriptMatches(base, 'http://docs.example.com/a', false)).toBe(false)
    expect(userScriptMatches(base, 'https://example.org/', false)).toBe(false)
    expect(userScriptMatches(base, 'https://example.com.evil.io/', false)).toBe(false)
  })

  it('does not run while it is switched off', () => {
    expect(userScriptMatches({ ...base, enabled: false }, 'https://docs.example.com/', false)).toBe(false)
  })

  it('keeps out of a private window unless that script was allowed there', () => {
    expect(userScriptMatches(base, 'https://docs.example.com/', true)).toBe(false)
    expect(userScriptMatches({ ...base, allowPrivate: true }, 'https://docs.example.com/', true)).toBe(true)
    expect(userScriptMatches({ ...base, allowPrivate: true }, 'https://docs.example.com/', false)).toBe(true)
  })

  it('honours the exclusions, as match patterns or as globs', () => {
    expect(userScriptMatches(base, 'https://www.example.com/private/area', false)).toBe(false)
    expect(userScriptMatches({ ...base, excludes: ['https://*.example.com/*/edit'] }, 'https://docs.example.com/page/edit', false)).toBe(false)
    expect(userScriptMatches({ ...base, excludes: ['*://docs.example.com/*?debug*'] }, 'https://docs.example.com/page?debug=1', false)).toBe(false)
  })

  it('never runs on a sensitive page, even for a script that asks for every site', () => {
    const everywhere = { enabled: true, allowPrivate: true, matches: ['<all_urls>'], excludes: [] }
    expect(userScriptMatches(everywhere, 'https://news.example/', false)).toBe(true)
    for (const url of ['https://accounts.google.com/', 'https://www.paypal.com/', 'https://login.example.org/', 'file:///etc/hosts']) {
      expect(userScriptMatches(everywhere, url, false), url).toBe(false)
      expect(userScriptMatches(everywhere, url, true), url).toBe(false)
    }
    // Asking for a sensitive site by name changes nothing.
    expect(userScriptMatches({ ...everywhere, matches: ['https://accounts.google.com/*'] }, 'https://accounts.google.com/signin', false)).toBe(false)
  })
})

describe('wrapUserScript', () => {
  const sample: UserScript = { id: 'us-abcdef123456', name: 'Mon "script"', source: GOOD, runAt: 'document-end', matches: [], excludes: [], enabled: true, allowPrivate: false, importedAt: 0 }

  it('runs the script in a function of its own, in the page\'s world, and keeps a failure from breaking the page', () => {
    const code = wrapUserScript(sample)
    expect(code).toContain('(function () {\n// ==UserScript==')
    expect(code).toContain('.call(window)')
    expect(code).toContain('try {')
    expect(code).toContain('catch (error)')
    expect(code).toContain('//# sourceURL=userscript-us-abcdef123456.user.js')
  })

  it('says a failure of the script in the console of the page with the name of the script, and nothing there names the browser', () => {
    const said: unknown[][] = []
    const fake = { document: { readyState: 'complete' }, console: { error: (...args: unknown[]) => void said.push(args) } }
    const code = wrapUserScript({ ...sample, source: 'throw new Error("broken")' })
    new Function('window', 'document', 'console', code)(fake, fake.document, fake.console)
    expect(said).toHaveLength(1)
    expect(said[0]!.slice(0, 3)).toEqual(['[user script]', sample.name, 'failed:'])
    expect((said[0]![3] as Error).message).toBe('broken')
    // The page's own scripts can read what the console is given, and the name of a script in a stack: neither says which browser runs it.
    expect(code).not.toMatch(/lucium/i)
  })

  it('is valid JavaScript for every timing, and runs the script', () => {
    for (const runAt of ['document-start', 'document-end', 'document-idle'] as const) {
      const code = wrapUserScript({ ...sample, runAt, source: 'globalThis.__ran = (globalThis.__ran || 0) + 1' })
      expect(() => new Function(code)).not.toThrow()
    }
  })

  it('runs at once for document-end and waits for the load for document-idle', () => {
    const run = (runAt: UserScript['runAt'], readyState: string) => {
      const timers: Array<() => void> = []
      const listeners: Array<() => void> = []
      const fake = { __ran: 0, document: { readyState }, setTimeout: (fn: () => void) => void timers.push(fn), addEventListener: (_: string, fn: () => void) => void listeners.push(fn), console: { error: () => {} } } as Record<string, any>
      const code = wrapUserScript({ ...sample, runAt, source: 'window.__ran++' })
      new Function('window', 'document', 'setTimeout', 'addEventListener', 'console', code.replace(/^\(\(\) =>/, '(() =>'))(fake, fake['document'], fake['setTimeout'], fake['addEventListener'], fake['console'])
      return { ran: fake['__ran'] as number, timers, listeners, fake }
    }
    expect(run('document-end', 'interactive').ran).toBe(1)
    const idle = run('document-idle', 'interactive')
    expect(idle.ran).toBe(0)
    expect(idle.listeners).toHaveLength(1)
    idle.listeners[0]!()
    idle.timers[0]!()
    expect(idle.fake['__ran']).toBe(1)
    const done = run('document-idle', 'complete')
    expect(done.timers).toHaveLength(1)
    done.timers[0]!()
    expect(done.fake['__ran']).toBe(1)
  })

  it('lets a script that throws fail on its own: the error goes to the console with the script\'s name', () => {
    const logged: unknown[][] = []
    const code = wrapUserScript({ ...sample, runAt: 'document-end', source: 'throw new Error("boom")' })
    new Function('window', 'console', code)({}, { error: (...args: unknown[]) => void logged.push(args) })
    expect(logged).toHaveLength(1)
    expect(logged[0]![1]).toBe('Mon "script"')
    expect(String(logged[0]![3])).toContain('boom')
  })

  it('keeps a line comment at the end of the script from swallowing the end of the function', () => {
    const code = wrapUserScript({ ...sample, source: 'window.__x = 1 // no newline after me' })
    expect(() => new Function(code)).not.toThrow()
  })

  it('does not let an id put anything into the source URL', () => {
    expect(wrapUserScript({ ...sample, id: 'us-a\nb;alert(1)' })).toContain('\n//# sourceURL=userscript-us-abalert1.user.js')
  })
})

describe('what is kept', () => {
  const stored = (over: Record<string, unknown> = {}) => ({ id: 'us-abcdef123456', source: GOOD, enabled: true, allowPrivate: false, importedAt: 5, ...over })

  it('reads a script again from its text, so that what is shown, kept and run is one thing', () => {
    const { scripts, dropped } = cleanUserScripts({ version: 1, scripts: [stored()] })
    expect(dropped).toBe(0)
    expect(scripts[0]).toMatchObject({ id: 'us-abcdef123456', name: 'Mon script', matches: ['https://*.example.com/*'], enabled: true, importedAt: 5 })
    expect(storedForm(scripts[0]!)).toEqual(stored())
  })

  it('drops an entry whose text is no longer a script Lucium accepts, and says how many', () => {
    const bad = [stored({ id: 'us-aaaaaaaaaaaa', source: 'alert(1)' }), stored({ id: 'us-bbbbbbbbbbbb', source: script('// @name A\n// @match https://a.example/*\n// @grant GM_setValue') }), stored({ id: 'bad id' }), null, 'x', stored({ source: 3 })]
    const { scripts, dropped } = cleanUserScripts({ scripts: [...bad, stored({ id: 'us-cccccccccccc' })] })
    expect(scripts.map((one) => one.id)).toEqual(['us-cccccccccccc'])
    expect(dropped).toBe(bad.length)
  })

  it('repairs the flags of an entry: only true turns anything on', () => {
    const { scripts } = cleanUserScripts({ scripts: [stored({ enabled: 'yes', allowPrivate: 1, importedAt: 'now' })] })
    expect(scripts[0]).toMatchObject({ enabled: false, allowPrivate: false, importedAt: 0 })
  })

  it('keeps the first of two entries with one id, and no more than the limit', () => {
    expect(cleanUserScripts({ scripts: [stored(), stored({ importedAt: 9 })] }).scripts).toHaveLength(1)
    const many = Array.from({ length: USER_SCRIPTS_MAX + 5 }, (_, i) => stored({ id: `us-${String(i).padStart(12, '0')}` }))
    const cleaned = cleanUserScripts({ scripts: many })
    expect(cleaned.scripts).toHaveLength(USER_SCRIPTS_MAX)
    expect(cleaned.dropped).toBe(5)
  })

  it('reads anything that is not a file of ours as an empty one', () => {
    for (const raw of [null, undefined, 'x', 3, [], {}, { scripts: 'x' }]) expect(cleanUserScripts(raw)).toEqual({ scripts: [], dropped: 0 })
  })

  it('makes ids that pass its own check, and that differ', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newUserScriptId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(isUserScriptId(id)).toBe(true)
    expect(isUserScriptId('us-')).toBe(false)
    expect(isUserScriptId('__proto__')).toBe(false)
  })

  it('knows the same script by its namespace and name', () => {
    expect(sameScript({ name: 'A', namespace: 'x' }, { name: 'A', namespace: 'x' })).toBe(true)
    expect(sameScript({ name: 'A' }, { name: 'A', namespace: '' })).toBe(true)
    expect(sameScript({ name: 'A', namespace: 'x' }, { name: 'A', namespace: 'y' })).toBe(false)
    expect(sameScript({ name: 'A' }, { name: 'B' })).toBe(false)
  })
})

describe('parseUserScriptRequest', () => {
  const id = 'us-abcdef123456'

  it('reads each kind of request', () => {
    expect(parseUserScriptRequest({ kind: 'list' })).toEqual({ kind: 'list' })
    expect(parseUserScriptRequest({ kind: 'pick-file' })).toEqual({ kind: 'pick-file' })
    expect(parseUserScriptRequest({ kind: 'source', id })).toEqual({ kind: 'source', id })
    expect(parseUserScriptRequest({ kind: 'remove', id })).toEqual({ kind: 'remove', id })
    expect(parseUserScriptRequest({ kind: 'add', text: GOOD })).toEqual({ kind: 'add', text: GOOD })
    expect(parseUserScriptRequest({ kind: 'set-enabled', id, enabled: true })).toEqual({ kind: 'set-enabled', id, enabled: true })
    expect(parseUserScriptRequest({ kind: 'set-private', id, allow: false })).toEqual({ kind: 'set-private', id, allow: false })
  })

  it('refuses everything else', () => {
    for (const bad of [null, undefined, 'list', [], {}, { kind: 'other' }, { kind: 'source', id: '../etc' }, { kind: 'remove' }, { kind: 'add', text: 3 }, { kind: 'add', text: 'x'.repeat(USER_SCRIPT_MAX_BYTES + 2) }, { kind: 'set-enabled', id, enabled: 'true' }, { kind: 'set-private', id: 'x', allow: true }, { kind: '__proto__' }]) {
      expect(parseUserScriptRequest(bad), JSON.stringify(bad)?.slice(0, 40)).toBeNull()
    }
  })
})
