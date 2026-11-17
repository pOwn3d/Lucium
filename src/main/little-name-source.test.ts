// Nothing visible says "Little Arc" in the code or in the user documentation (the catalogues are checked in src/shared/little-name.test.ts).
// Here because it reads files (the shared tests also build for the renderer, which has no `node:fs`).

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from '@shared/i18n-en'
import { fr } from '@shared/i18n-fr'
import { littleForms } from '@shared/little-name'

const ROOT = new URL('../../', import.meta.url).pathname

// "Little Arc" with a space is a word, hence something someone can read; in code, "little-arc" is the area of keys of the catalogues
// (`little-arc-settings.mini-fenetre`) and `LittleArc` an identifier: neither is shown to anyone.
const OLD_NAME_IN_CODE = /\blittle\s+arc\b/i
const OLD_NAME = /\blittle[\s-]+arc\b/i

// The one place that shows the old name on purpose: the guide for people coming from that browser names it beside the name Lucium gives the window
// (shared/arc-guide.ts). The line of that key, in the two catalogues, is left out of the scan; any other line of them, or any other file, is not.
const CATALOGUES = ['src/shared/i18n-fr.ts', 'src/shared/i18n-en.ts']
const SHOWN_ON_PURPOSE = /^ *'arc-guide\.ancien-little-arc': 'Little Arc',\n/m
/** The source of the file as the scan reads it: the line the guide shows on purpose is not in it. */
const scanned = (file: string, source: string): string => (CATALOGUES.includes(file) ? source.replace(SHOWN_ON_PURPOSE, '') : source)

function filesUnder(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(path, keep) : keep(path) ? [path] : []
  })
}

/** The source of a file without its comments: what is left is code and strings (and the text of a page), which someone can see. */
function withoutComments(source: string, html = false): string {
  if (html) return source.replace(/<!--[\s\S]*?-->/g, '')
  let out = ''
  let i = 0
  let quote = ''
  while (i < source.length) {
    const c = source[i]!
    const next = source[i + 1]
    if (quote) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      // A quote ends a string; a newline ends a '…' or "…" string that was mistaken for one (a quote inside a regular expression).
      if (c === quote || (c === '\n' && quote !== '`')) quote = ''
      i++
      continue
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    out += c
    i++
  }
  return out
}

describe('the scan of the code', () => {
  it('drops comments but keeps strings, templates and the text of a page', () => {
    expect(withoutComments("const a = 1 // Little Arc\n/* Little Arc */ const b = 'Little Arc'")).toBe("const a = 1 \n const b = 'Little Arc'")
    expect(withoutComments('const u = "https://x.example/Little Arc" // done')).toBe('const u = "https://x.example/Little Arc" ')
    expect(withoutComments('x = `a // Little Arc ${y}`')).toBe('x = `a // Little Arc ${y}`')
    expect(withoutComments('<!-- Little Arc --><title>Little Arc</title>', true)).toBe('<title>Little Arc</title>')
    expect(OLD_NAME_IN_CODE.test(withoutComments("const a = 'Little Arc'"))).toBe(true)
    expect(OLD_NAME_IN_CODE.test(withoutComments('class LittleArc {}'))).toBe(false)
    expect(OLD_NAME_IN_CODE.test(withoutComments("t('little-arc-settings.mini-fenetre')"))).toBe(false)
  })
})

describe('the line the guide for people coming from Arc shows on purpose', () => {
  const line = "  'arc-guide.ancien-little-arc': 'Little Arc',\n"

  it('is the only line of the two catalogues that the scan lets through', () => {
    for (const file of CATALOGUES) {
      expect(OLD_NAME_IN_CODE.test(scanned(file, line)), file).toBe(false)
      expect(OLD_NAME_IN_CODE.test(scanned(file, `${line}  'menu.autre': 'Little Arc',\n`)), file).toBe(true)
      expect(OLD_NAME_IN_CODE.test(scanned(file, "  'arc-guide.autre-nom': 'Little Arc',\n")), file).toBe(true)
      expect(OLD_NAME_IN_CODE.test(scanned(file, "  'arc-guide.ancien-little-arc': 'Le Little Arc',\n")), file).toBe(true)
    }
  })

  it('is let through in the catalogues only: the same line anywhere else is found', () => {
    expect(OLD_NAME_IN_CODE.test(scanned('src/renderer/Autre.tsx', line))).toBe(true)
    expect(OLD_NAME_IN_CODE.test(scanned('src/shared/i18n.ts', line))).toBe(true)
  })

  it('is in the two catalogues, as that line', () => {
    for (const file of CATALOGUES) expect(SHOWN_ON_PURPOSE.test(readFileSync(join(ROOT, file), 'utf8')), file).toBe(true)
  })
})

describe('the code', () => {
  const sources = filesUnder(join(ROOT, 'src'), (path) => /\.(ts|tsx|html)$/.test(path) && !/\.test\.ts$/.test(path) && !/\/smoke[^/]*\.ts$/.test(path) && !path.endsWith('.d.ts') && !/\/out(-[^/]*)?\//.test(path))

  it('has no text of the interface, window title or label with "Little Arc" (identifiers such as LittleArc are not shown to anyone)', () => {
    expect(sources.length).toBeGreaterThan(100)
    const offending = sources
      .filter((path) => OLD_NAME_IN_CODE.test(withoutComments(scanned(relative(ROOT, path), readFileSync(path, 'utf8')), path.endsWith('.html'))))
      .map((path) => relative(ROOT, path))
    expect(offending).toEqual([])
  })

  it('names the window of the mini window page with the noun of little-name.ts, in the language of the interface', () => {
    // The page itself is titled with the application's name only; its script titles the window through the catalogue, whose texts are built
    // from the noun (code-text-source.test.ts keeps French out of the pages).
    expect(readFileSync(join(ROOT, 'src/renderer/littlearc.html'), 'utf8')).toContain('<title>Lucium</title>')
    expect(readFileSync(join(ROOT, 'src/renderer/littlearc.tsx'), 'utf8')).toContain(`t('littlearc.window-title')`)
    expect(fr['littlearc.window-title']).toBe(littleForms('fr').S)
    expect(en['littlearc.window-title']).toBe(littleForms('en').S)
  })
})

describe('the user documentation', () => {
  // The notice of trademarks is the only line that may still say "Little Arc".
  const NOTICE = /trademark|marque/i
  for (const file of ['README.md', 'README.fr.md', 'SECURITY.md', 'docs/fonctions.md']) {
    it(`${file} calls it by its name`, () => {
      const lines = readFileSync(join(ROOT, file), 'utf8').split('\n')
      const offending = lines.map((line, n) => [n + 1, line] as const).filter(([, line]) => OLD_NAME.test(line) && !NOTICE.test(line))
      expect(offending).toEqual([])
    })
  }
})
