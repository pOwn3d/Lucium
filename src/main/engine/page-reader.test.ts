import { describe, expect, it } from 'vitest'
import { PAGE_WATCH_TEXT_MAX } from '@shared/page-watch'
import { extractScript, isReading, readPageText } from './page-reader'

/** Runs the script against a stand-in document whose elements are found by the selectors listed. */
function run(selector: string | undefined, found: Record<string, { innerText?: string; textContent?: string }>, body = { innerText: 'tout le texte' }): unknown {
  const document = {
    body,
    querySelector: (query: string) => {
      if (query === 'invalid[') throw new SyntaxError('is not a valid selector')
      return found[query] ?? null
    }
  }
  return new Function('document', `return ${extractScript(selector)}`)(document)
}

describe('the script that reads a page', () => {
  it('reads the visible text of the whole page without a selector', () => {
    expect(run(undefined, {})).toEqual({ text: 'tout le texte' })
  })

  it('reads the zone a selector names, and only it', () => {
    expect(run('#prix', { '#prix': { innerText: '12,50 €' } })).toEqual({ text: '12,50 €' })
  })

  it('falls back to the text content of an element that has no layout text', () => {
    expect(run('#x', { '#x': { textContent: 'brut' } })).toEqual({ text: 'brut' })
  })

  it('says a zone is missing when the page has none', () => {
    expect(run('#absente', {})).toEqual({ missing: true })
  })

  it('reports a selector the page cannot use, as a sentence, instead of throwing', () => {
    expect(run('invalid[', {})).toEqual({ error: 'is not a valid selector' })
  })

  it('cuts the text at the bound', () => {
    const result = run(undefined, {}, { innerText: 'x'.repeat(PAGE_WATCH_TEXT_MAX + 100) }) as { text: string }
    expect(result.text).toHaveLength(PAGE_WATCH_TEXT_MAX)
  })

  it('takes the selector as data: one that looks like code is a selector, nothing more', () => {
    for (const hostile of ['"); globalThis.hacked = 1; ("', "'); globalThis.hacked = 1; ('", '`${globalThis.hacked = 1}`', '\\"); globalThis.hacked = 1; //']) {
      expect(() => new Function(extractScript(hostile)), hostile).not.toThrow()
      expect(run(hostile, {}), hostile).toEqual({ missing: true })
      expect((globalThis as { hacked?: number }).hacked, hostile).toBeUndefined()
    }
  })
})

describe('what is refused before any page is made', () => {
  it('a page that is not the web, with the sentence that says so', async () => {
    for (const url of ['file:///etc/hosts', 'chrome-extension://abc/x.html', 'javascript:1', 'about:blank']) {
      expect(await readPageText({} as never, url, { settleMs: 0 })).toEqual({ ok: false, error: 'Seules les pages web (http ou https) peuvent être surveillées.' })
    }
  })

  it('a zone that is not usable as a selector', async () => {
    expect(await readPageText({} as never, 'https://example.org/', { selector: 'a\nb', settleMs: 0 })).toEqual({ ok: false, error: 'Cette zone n’est pas un sélecteur valide.' })
    expect(await readPageText({} as never, 'https://example.org/', { selector: 'a'.repeat(300), settleMs: 0 })).toEqual({ ok: false, error: 'Cette zone n’est pas un sélecteur valide.' })
  })

  it('leaves no reading behind', () => {
    expect(isReading()).toBe(false)
  })
})
