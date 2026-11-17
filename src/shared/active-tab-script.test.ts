// chrome.scripting on a tab the user lent with a click (active-tab-script.ts): which tab counts as lent, and what a call hands over.

import { createContext, runInContext, runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { callOf, guardedScript, lentOrigin, lentTab, NO_PAGE_ACCESS, readInjection, refusedByDocument, SCRIPT_MAX_CHARS, SCRIPT_WORLDS_FROM, ScriptWorlds, startsStrict } from './active-tab-script'
import { ActiveTabGrants } from './extension-access'

describe('a tab lent to an extension', () => {
  const both = new Set(['activeTab', 'scripting'])
  const grants = new ActiveTabGrants()
  grants.grant('ext', 7, 'https://site.example/page')

  it('is the tab the user handed over, while it stays on the site it was on', () => {
    expect(lentTab(both, grants, 'ext', 7, 'https://site.example/other')).toBe(true)
    expect(lentTab(both, grants, 'ext', 7, 'https://elsewhere.example/')).toBe(false)
    expect(lentTab(both, grants, 'ext', 8, 'https://site.example/page')).toBe(false)
    expect(lentTab(both, grants, 'other', 7, 'https://site.example/page')).toBe(false)
    expect(lentTab(both, grants, 'ext', 7, undefined)).toBe(false)
  })

  it('needs both permissions in the manifest: a click lends nothing to an extension that did not ask for activeTab', () => {
    expect(lentTab(new Set(['scripting']), grants, 'ext', 7, 'https://site.example/page')).toBe(false)
    expect(lentTab(new Set(['activeTab']), grants, 'ext', 7, 'https://site.example/page')).toBe(false)
  })

  it('is never the Chrome Web Store, a local file, a page of the browser or of an extension', () => {
    const everywhere = new ActiveTabGrants()
    for (const url of ['https://chromewebstore.google.com/detail/x', 'file:///Users/me/page.html', 'chrome-extension://other/page.html', 'lucium://settings', 'about:blank']) {
      everywhere.grant('ext', 7, url)
      expect(lentTab(both, everywhere, 'ext', 7, url), url).toBe(false)
    }
  })
})

describe('the origin a tab was lent on', () => {
  const both = new Set(['activeTab', 'scripting'])

  it('is the origin of the click, kept by the grant, whatever the page the tab shows now (and nothing once it is not lent)', () => {
    const grants = new ActiveTabGrants()
    grants.grant('ext', 7, 'https://site.example/page?x=1#top')
    expect(lentOrigin(both, grants, 'ext', 7, 'https://site.example/other')).toBe('https://site.example')
    expect(lentOrigin(both, grants, 'ext', 7, 'https://elsewhere.example/')).toBeNull()
    expect(lentOrigin(both, grants, 'ext', 8, 'https://site.example/page')).toBeNull()
    expect(lentOrigin(new Set(['scripting']), grants, 'ext', 7, 'https://site.example/page')).toBeNull()
    // The port is part of the origin, as `location.origin` tells it; the default port is not written.
    grants.grant('ext', 9, 'http://127.0.0.1:8080/a')
    grants.grant('ext', 10, 'https://site.example:443/a')
    expect(lentOrigin(both, grants, 'ext', 9, 'http://127.0.0.1:8080/b')).toBe('http://127.0.0.1:8080')
    expect(lentOrigin(both, grants, 'ext', 10, 'https://site.example/b')).toBe('https://site.example')
  })
})

describe('a script that checks the origin of the document that runs it', () => {
  // The code is run for real, by a document stand-in whose `location.origin` is what the renderer says at the moment the script gets there.
  const runIn = (documentOrigin: string, code: string, more: Record<string, unknown> = {}): { value: unknown; world: Record<string, unknown> } => {
    const world: Record<string, unknown> = { location: { origin: documentOrigin }, document: { title: 'the title' }, ...more }
    return { value: runInNewContext(code, world), world }
  }
  const LENT = 'https://site.example'

  it('runs the script of the extension in a document of the origin that was lent, and answers what the script answers', () => {
    expect(runIn(LENT, guardedScript(LENT, callOf('(a, b) => document.title + a + b', ['!', 2]))).value).toBe('the title!2')
    expect(runIn(LENT, guardedScript(LENT, 'document.title')).value).toBe('the title')
    // A function that answers a promise: what the engine awaits is still what the function gave.
    expect(typeof (runIn(LENT, guardedScript(LENT, callOf('async () => 5', []))).value as { then?: unknown }).then).toBe('function')
  })

  it('refuses, in the words of the platform and before a single statement of the script, a document of another origin: another site, another subdomain, another port, another scheme', () => {
    for (const other of ['https://bank.example', 'https://www.site.example', 'https://site.example:8443', 'http://site.example', 'null']) {
      const world: Record<string, unknown> = { location: { origin: other }, document: { title: 'secret' }, touched: false }
      expect(() => runInNewContext(guardedScript(LENT, callOf('() => { touched = true; return document.title }', [])), world), other).toThrow(new Error(NO_PAGE_ACCESS))
      expect(world['touched'], other).toBe(false)
      expect(() => runInNewContext(guardedScript(LENT, 'touched = true; document.title'), world), other).toThrow(new Error(NO_PAGE_ACCESS))
      expect(world['touched'], other).toBe(false)
    }
  })

  it('judges the document at the moment the script runs: the same text is accepted by one document and refused by the next', () => {
    const script = guardedScript(LENT, 'document.title')
    expect(runIn(LENT, script).value).toBe('the title')
    expect(() => runIn('https://bank.example', script)).toThrow(new Error(NO_PAGE_ACCESS))
  })

  it('keeps a file as it is: its "use strict" still holds, a hashbang or leading comments do not break the check, and what it declares stays declared', () => {
    const strictProbe = (code: string): unknown => runIn(LENT, guardedScript(LENT, code)).value
    // In strict mode `this` of a function called by name is undefined; in the other mode it is the global object.
    expect(strictProbe(`'use strict'; (function () { return this === undefined })()`)).toBe(true)
    expect(strictProbe(`/* a license */\n// a line\n"use strict"\n;(function () { return this === undefined })()`)).toBe(true)
    expect(strictProbe('(function () { return this === undefined })()')).toBe(false)
    // A text that only looks like the directive is not one: it is left alone.
    expect(strictProbe(`'use strict'.length > 0 && (function () { return this === undefined })()`)).toBe(false)
    expect(strictProbe('#!/usr/bin/env node\ndocument.title')).toBe('the title')
    const { world } = runIn(LENT, guardedScript(LENT, 'var declared = 7; function named() { return declared }; named()'))
    expect(world['declared']).toBe(7)
  })

  // What the refusal does and does not prevent, written down so that no one states more than is so: no statement of the script runs, but the declarations of the top level
  // of a script are instantiated by the engine before its first statement, so they exist in a document that refused: a function, a var, and the lexical bindings (let, const,
  // class), which stay uninitialized for good (the page's own identifier of that name then throws). Only the world of the page shows it to a page (the isolated world has its
  // own global); and no script reaches a foreign document by the race that was measured. The script is not put in a block to prevent it: that would change what let, const and
  // function mean in a script run as it was written.
  it('runs no statement of the script in a document of another origin, but what it declares at the top level is already there: that is not "nothing of the script"', () => {
    const world: Record<string, unknown> = createContext({ location: { origin: 'https://bank.example' }, touched: false, fetch: () => 'the fetch of the page' })
    const refused = (code: string): void => expect(() => runInContext(guardedScript(LENT, code), world)).toThrow(new Error(NO_PAGE_ACCESS))
    refused("function __plantedFn() { return 'planted' }\nvar __plantedVar = 1\ntouched = true")
    expect(world['touched']).toBe(false)
    // The function was made, and the var declared (not assigned: the assignment is a statement), before the check threw.
    expect(typeof world['__plantedFn']).toBe('function')
    expect(runInContext("'__plantedVar' in globalThis", world)).toBe(true)
    expect(world['__plantedVar']).toBeUndefined()
    // A lexical binding was made too, and is never initialized: the page's own name for it throws from then on, though the property is still on its global object.
    const thrownBy = (code: string): string => {
      try {
        runInContext(code, world)
        return 'no error'
      } catch (error) {
        return (error as Error).name
      }
    }
    expect(thrownBy('fetch()')).toBe('no error')
    refused('let fetch; const __sealed = 1; class __Class {}')
    expect(thrownBy('fetch()')).toBe('ReferenceError')
    expect(thrownBy('__sealed')).toBe('ReferenceError')
    expect(runInContext('globalThis.fetch()', world)).toBe('the fetch of the page')
    // A function written as an expression is a statement: it is never made.
    const expression: Record<string, unknown> = { location: { origin: 'https://bank.example' } }
    expect(() => runInNewContext(guardedScript(LENT, callOf('() => { globalThis.__other = 1 }', [])), expression)).toThrow(new Error(NO_PAGE_ACCESS))
    expect(expression['__other']).toBeUndefined()
  })

  it('writes the origin as a text, so that an origin cannot end the check and run as code', () => {
    // Not an origin a tab can have; a grant never holds one. The check is built so that it would still be only a comparison.
    const hostile = 'https://x.example"); touched = true; ("'
    const world: Record<string, unknown> = { location: { origin: 'https://site.example' }, touched: false }
    expect(() => runInNewContext(guardedScript(hostile, '1'), world)).toThrow(new Error(NO_PAGE_ACCESS))
    expect(world['touched']).toBe(false)
  })

  it('knows its own refusal in whatever words the engine of the page wraps it', () => {
    expect(refusedByDocument(new Error(NO_PAGE_ACCESS))).toBe(true)
    expect(refusedByDocument(new Error(`Error: ${NO_PAGE_ACCESS}`))).toBe(true)
    expect(refusedByDocument(`Uncaught Error: ${NO_PAGE_ACCESS}`)).toBe(true)
    expect(refusedByDocument(new Error('Script failed to execute, this normally means an error was thrown.'))).toBe(false)
    expect(refusedByDocument(undefined)).toBe(false)
  })
})

// The text of the script is the extension's, and it is scanned in the main process before it is sent: the scan must take a time in proportion to the text, whatever the text.
describe('the "use strict" directive a file may begin with', () => {
  /** The pattern the scan replaced: kept here as the reference of what it answers (on short texts only: it takes a time that doubles with each comment). */
  const OLD_PATTERN = /^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(['"])use strict\1(?=\s*(?:;|\r?\n|$))/
  const elapsed = (run: () => unknown): number => {
    const from = performance.now()
    run()
    return performance.now() - from
  }

  it('is answered at once for a file that begins with 30 empty comments (the pattern it replaced took about a second, and twice as long with each one more)', () => {
    expect(elapsed(() => guardedScript('https://a.example', `${'/**/'.repeat(30)}x`))).toBeLessThan(100)
  })

  it('is answered at once for a file that begins with comments, however many: 50 000 empty ones, the worst case of the pattern the scan replaced, took the main process for hours', () => {
    expect(elapsed(() => guardedScript('https://a.example', `${'/**/'.repeat(50_000)}x`))).toBeLessThan(100)
    expect(startsStrict(`${'/**/'.repeat(50_000)}'use strict'`)).toBe(true)
  })

  it('is answered in a time in proportion to the text for 4 MiB of every shape that stressed the pattern', () => {
    const size = 4 * 1024 * 1024
    const shapes: Record<string, string> = {
      comments: `${'/**/'.repeat(size / 4)}x`,
      'comments and blanks': `${'/**/ '.repeat(size / 5)}x`,
      'line comments': `${'//a\n'.repeat(size / 4)}x`,
      'stars and slashes': `${'/***/'.repeat(size / 5)}x`,
      'a comment never closed': `/*${'a'.repeat(size)}`,
      'a comment never closed after many': `${'/**/'.repeat(size / 8)}/*${'a'.repeat(size / 2)}`,
      blanks: `${' '.repeat(size)}x`,
      'a directive after blanks that end the text': `'use strict'${' '.repeat(size)}`,
      'a quote and no directive': `${'"'.repeat(size)}`
    }
    for (const [name, text] of Object.entries(shapes)) expect(elapsed(() => startsStrict(text)), name).toBeLessThan(1000)
  })

  // The same answers as the pattern, on the files that matter and on many texts made of its pieces (the reference runs on short texts, where it is quick).
  it('answers as the pattern it replaced did, on the files that begin with a directive and on those that do not', () => {
    const cases = [
      "'use strict'",
      '"use strict"',
      "'use strict';",
      '"use strict";\nx',
      "'use strict'\nx",
      "'use strict'  \n  x",
      "'use strict'\r\nx",
      "'use strict'   ",
      "'use strict' + x",
      "'use strict'.length",
      "'use strict' x",
      "\"use strict'",
      "'use strict",
      "'use  strict'",
      "'Use Strict'",
      "use strict",
      '',
      ' ',
      '\n\n  ',
      "/* a license */\n// a line\n'use strict'",
      "// only a comment\n'use strict'\nx",
      "// only a comment",
      "// only a comment 'use strict'",
      "/* never closed 'use strict'",
      "/**//**/ /**/\t'use strict';",
      "x = 1; 'use strict'",
      "var a; /* 'use strict' */ x",
      "\u00a0\u2028\ufeff\u3000'use strict'",
      "\u180e'use strict'",
      "\v\f'use strict'\v",
      "'use strict'\u2028x",
      "'use strict'\u00a0x",
      '#!/usr/bin/env node\n"use strict"',
      '//\n//\n//\n"use strict"',
      "/*/ 'use strict'",
      "/*/ */ 'use strict'"
    ]
    for (const text of cases) expect(startsStrict(text), JSON.stringify(text)).toBe(OLD_PATTERN.test(text))
    // Seeded, so that a failure can be replayed: texts of three to eight pieces of what a prologue is made of. The two answer alike on every one but a kind of text: where the
    // pattern, finding no directive after a comment, lets that comment run on to a LATER "*/" (it can cut a run of comments any way it likes) and finds one there. A script
    // engine ends a comment at the first "*/", as the scan does, and a text that is read the pattern's way is a syntax error anyway: those are the only differences allowed.
    const pieces = ["'use strict'", '"use strict"', '/**/', '/*a*/', '/* x */', '//a\n', '//a', ' ', '\n', '\r\n', ';', 'x', "'use strict", 'use strict', '\u00a0', '\u2028', '\ufeff', '\t', "'", '"']
    let seed = 20_261_114
    const next = (): number => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff
    let differing = 0
    for (let run = 0; run < 20_000; run++) {
      let text = ''
      for (let piece = 0, count = 3 + Math.floor(next() * 6); piece < count; piece++) text += pieces[Math.floor(next() * pieces.length)]!
      const before = OLD_PATTERN.test(text)
      const now = startsStrict(text)
      if (before === now) continue
      differing++
      expect({ text, before, now, closesTwice: text.split('*/').length > 2 }, JSON.stringify(text)).toEqual({ text, before: true, now: false, closesTwice: true })
    }
    // Rare, and always of that kind: the loop above is not a way round the comparison.
    expect(differing).toBeLessThan(200)
  })

  it('closes a comment at the first "*/", as a script engine does', () => {
    expect(startsStrict("/* a */ x */ 'use strict'")).toBe(false)
    expect(startsStrict("/* a */ /* b */ 'use strict'")).toBe(true)
  })

  it('puts the directive back before the check only when the file has one, and keeps a hashbang out of the way', () => {
    expect(guardedScript('https://a.example', "'use strict'; x").startsWith("'use strict';if (location.origin")).toBe(true)
    expect(guardedScript('https://a.example', 'x').startsWith('if (location.origin')).toBe(true)
    expect(guardedScript('https://a.example', '#!/usr/bin/env node\n"use strict"; x')).toContain('\n///usr/bin/env node\n"use strict"; x')
  })
})

describe('what a chrome.scripting call hands over', () => {
  it('a function with its arguments, or files, for a tab', () => {
    expect(readInjection({ target: { tabId: 7 }, func: '() => 1', args: [1, 'a'] }, 'script')).toEqual({ tabId: 7, mainWorld: false, func: '() => 1', args: [1, 'a'], userOrigin: false })
    expect(readInjection({ target: { tabId: 7 }, files: ['a.js', 5, 'b.js'], world: 'MAIN' }, 'script')).toEqual({ tabId: 7, mainWorld: true, args: [], files: ['a.js', 'b.js'], userOrigin: false })
    expect(readInjection({ target: { tabId: 7 }, css: 'body{}', origin: 'USER' }, 'css')).toEqual({ tabId: 7, mainWorld: false, args: [], css: 'body{}', userOrigin: true })
  })

  it('refuses a call that names no tab, nothing to do, both a text and files, or a text too long', () => {
    expect(() => readInjection({ func: '() => 1' }, 'script')).toThrow('names no tab')
    expect(() => readInjection({ target: { tabId: 'seven' }, func: '() => 1' }, 'script')).toThrow('names no tab')
    expect(() => readInjection({ target: { tabId: 7 } }, 'script')).toThrow("Exactly one of 'func' and 'files'")
    expect(() => readInjection({ target: { tabId: 7 }, func: '() => 1', files: ['a.js'] }, 'script')).toThrow("Exactly one of 'func' and 'files'")
    expect(() => readInjection({ target: { tabId: 7 }, func: '() => 1' }, 'css')).toThrow("Exactly one of 'css' and 'files'")
    expect(() => readInjection({ target: { tabId: 7 }, func: 'x'.repeat(SCRIPT_MAX_CHARS + 1) }, 'script')).toThrow('too long')
  })

  it('the function is called with its arguments as JSON, so that no argument can end the call and run as code', () => {
    const code = callOf('(a, b) => a + b', ['"); alert(1); ("', 2])
    expect(code).toBe('((a, b) => a + b)(...["\\"); alert(1); (\\"",2])')
    // Run for real: the text comes back as a text.
    expect((0, eval)(code)).toBe('"); alert(1); ("2')
  })

  it('each extension has a world of its own in the page, away from the worlds of the application', () => {
    const worlds = new ScriptWorlds()
    const one = worlds.of('abcdefghijklmnopabcdefghijklmnop')
    expect(one).toBe(worlds.of('abcdefghijklmnopabcdefghijklmnop'))
    expect(one).not.toBe(worlds.of('ponmlkjihgfedcbaponmlkjihgfedcba'))
    expect(one).toBeGreaterThanOrEqual(SCRIPT_WORLDS_FROM)
  })

  it('a world is read back to the extension it was handed to, and to no other (the bridge of a tab asks whose it is)', () => {
    const worlds = new ScriptWorlds()
    const one = worlds.of('abcdefghijklmnopabcdefghijklmnop')
    const two = worlds.of('ponmlkjihgfedcbaponmlkjihgfedcba')
    expect(worlds.extensionOf(one)).toBe('abcdefghijklmnopabcdefghijklmnop')
    expect(worlds.extensionOf(two)).toBe('ponmlkjihgfedcbaponmlkjihgfedcba')
    for (const world of [0, 999, SCRIPT_WORLDS_FROM - 1, two + 1, 4_300_000.5]) expect(worlds.extensionOf(world), String(world)).toBeUndefined()
  })

  it('no two extensions ever share a world, however many there are and whatever their ids', () => {
    const worlds = new ScriptWorlds()
    // Two ids that a number worked out from the letters alone (31 times the number so far, plus the letter, kept under 50 000) gives the same world.
    const folded = (id: string): number => [...id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 50_000, 0)
    const letters = 'abcdefghijklmnop'
    const seen = new Map<number, string>()
    let pair: [string, string] | undefined
    for (let n = 0; pair === undefined; n++) {
      const id = 'a'.repeat(28) + [...n.toString(16).padStart(4, '0')].map((digit) => letters[parseInt(digit, 16)]).join('')
      const other = seen.get(folded(id))
      if (other !== undefined) pair = [other, id]
      seen.set(folded(id), id)
    }
    expect(folded(pair[0])).toBe(folded(pair[1]))
    expect(worlds.of(pair[0])).not.toBe(worlds.of(pair[1]))
    // And none among many: as many worlds as extensions.
    const many = [...seen.values()].map((id) => worlds.of(id))
    expect(new Set(many).size).toBe(many.length)
  })
})
