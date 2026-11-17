import { describe, expect, it } from 'vitest'
import { archiveImageName, cleanText, edgesWithout, exportFileName, withoutTrailing, exportMarkdown, markdownWithImages, MD_LIMITS, parseSnapshot, safeUrl, type MdNode, type MdOptions } from './markdown-export'
import { frenchSpaces } from './french-typography'

// A tiny reader of well-formed markup for the tests: the converter takes the snapshot tree the page sends, and a tree written as HTML is
// easier to read than the same tree written as objects. Only what the tests use: quoted attributes, void tags, no entities.
const VOID = new Set(['br', 'img', 'hr', 'wbr'])
function tree(html: string): MdNode[] {
  const root: { c: MdNode[] } = { c: [] }
  const stack: Array<{ c: MdNode[] }> = [root]
  for (const match of html.matchAll(/<(\/)?([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g)) {
    const top = stack.at(-1)!
    if (match[4] !== undefined) {
      top.c.push(match[4])
      continue
    }
    const [, closing, tag, attributes] = match
    if (closing) {
      stack.pop()
      continue
    }
    const element: { t: string; a?: Record<string, string>; c: MdNode[] } = { t: tag!, c: [] }
    for (const attr of (attributes ?? '').matchAll(/([\w-]+)(?:="([^"]*)")?/g)) (element.a ??= {})[attr[1]!] = attr[2] ?? ''
    top.c.push(element as MdNode)
    if (!VOID.has(tag!)) stack.push(element)
  }
  return root.c
}

const PAGE = 'https://example.com/docs/page?x=1'
const options = (extra: Partial<MdOptions> = {}): MdOptions => ({ url: PAGE, title: 'Titre de la page', withTitle: false, withSource: false, ...extra })
const md = (html: string, extra: Partial<MdOptions> = {}): string => exportMarkdown({ nodes: tree(html), warnings: [], truncated: false }, options(extra))!.markdown
const result = (html: string, extra: Partial<MdOptions> = {}) => exportMarkdown({ nodes: tree(html), warnings: [], truncated: false }, options(extra))!
/** The Markdown of a snapshot written as the page would send it, whatever its shape. */
const fromSnapshot = (nodes: unknown): string => exportMarkdown({ nodes, warnings: [], truncated: false }, options())!.markdown

describe('blocks and inline text', () => {
  it('writes headings, paragraphs, bold, italic and strike-through', () => {
    expect(md('<h1>Titre</h1><p>Un <strong>mot</strong> et <em>un autre</em>, <del>raté</del>.</p><h3>Plus bas</h3>')).toBe('# Titre\n\nUn **mot** et *un autre*, ~~raté~~.\n\n### Plus bas\n')
  })

  it('keeps the spaces outside the markers, where Markdown needs them', () => {
    expect(md('<p>foo<b> bar </b>baz</p>')).toBe('foo **bar** baz\n')
    expect(md('<p><i> </i>seul</p>')).toBe('seul\n')
  })

  it('does not double a marker the text is already inside', () => {
    expect(md('<p><b>a <b>b</b> c</b></p>')).toBe('**a b c**\n')
  })

  it('collapses whitespace the way a page shows it, and turns non-breaking spaces into spaces', () => {
    expect(md('<p>  un \n\n  deux\u00a0\u00a0trois  </p>')).toBe('un deux trois\n')
  })

  it('writes a break as a hard line break, and two breaks as a new paragraph', () => {
    expect(md('<p>ligne un<br>ligne deux</p>')).toBe('ligne un  \nligne deux\n')
    expect(md('<div>un<br><br>deux</div>')).toBe('un\n\ndeux\n')
  })

  it('separates the blocks of a div and its loose text', () => {
    expect(md('<div>avant<p>milieu</p>après</div>')).toBe('avant\n\nmilieu\n\naprès\n')
  })

  it('writes a rule', () => {
    expect(md('<p>a</p><hr><p>b</p>')).toBe('a\n\n---\n\nb\n')
  })

  it('writes a definition list and a details block with their term in bold', () => {
    expect(md('<dl><dt>Terme</dt><dd>Sens</dd></dl>')).toBe('**Terme**\n\nSens\n')
    expect(md('<details><summary>Résumé</summary><p>Suite</p></details>')).toBe('**Résumé**\n\nSuite\n')
  })

  it('ignores what has no text (empty blocks, empty headings)', () => {
    expect(md('<div><p> </p><h2></h2><p>ok</p></div>')).toBe('ok\n')
  })

  it('gives back an empty file for a page with nothing in it', () => {
    expect(md('<div><span> </span></div>')).toBe('')
  })
})

describe('escaping', () => {
  it('escapes what would turn text into syntax', () => {
    expect(md('<p>2 * 3 = 6 and `ticks` and [brackets] and ~tilde~ and back\\slash</p>')).toBe('2 \\* 3 = 6 and \\`ticks\\` and \\[brackets\\] and \\~tilde\\~ and back\\\\slash\n')
  })

  it('leaves an underscore between letters alone and escapes the others', () => {
    expect(md('<p>snake_case_name and _lead and trail_ and a _ b</p>')).toBe('snake_case_name and \\_lead and trail\\_ and a \\_ b\n')
  })

  it('escapes what only matters at the start of a line', () => {
    expect(md('<p># pas un titre</p><p>- pas une liste</p><p>1. pas une liste</p><p>> pas une citation</p><p>---</p>')).toBe(
      '\\# pas un titre\n\n\\- pas une liste\n\n1\\. pas une liste\n\n\\> pas une citation\n\n\\---\n'
    )
    expect(md('<p>#hashtag et C# et 3.14 et a - b</p>')).toBe('#hashtag et C# et 3.14 et a - b\n')
  })

  it('escapes the start of every line of a paragraph with breaks', () => {
    expect(md('<p>un<br>- deux</p>')).toBe('un  \n\\- deux\n')
  })

  it('escapes markup written as text, so a page cannot slip HTML or a link into the file', () => {
    const out = fromSnapshot(['<script>alert(1)</script> and [click](javascript:alert(1)) and &amp; and a < b'])
    expect(out).toBe('\\<script>alert(1)\\</script> and \\[click\\](javascript:alert(1)) and \\&amp; and a < b\n')
  })

  it('keeps a heading from ending in a closing sequence', () => {
    expect(md('<h2>Le langage C #</h2>')).toBe('## Le langage C \\#\n')
  })
})

describe('links', () => {
  it('writes absolute links, with the characters that would break the address encoded', () => {
    expect(md('<p><a href="https://example.com/a b/(x)">le lien</a></p>')).toBe('[le lien](https://example.com/a%20b/%28x%29)\n')
  })

  it('writes a link that shows its own address as an autolink', () => {
    expect(md('<p><a href="https://example.com/a">https://example.com/a</a> et <a href="mailto:a@b.fr">Écrire</a></p>')).toBe('<https://example.com/a> et [Écrire](mailto:a@b.fr)\n')
  })

  it('keeps only the text of a link whose address is unusable, or that leads to the page itself', () => {
    expect(md('<p><a href="javascript:alert(1)">piège</a> <a>sans adresse</a> <a href="https://example.com/docs/page?x=1#haut">haut</a></p>')).toBe('piège sans adresse haut\n')
    expect(md('<p><a href="https://example.com/docs/page?x=2#haut">autre page</a></p>')).toBe('[autre page](https://example.com/docs/page?x=2#haut)\n')
  })

  it('drops a link that has no text', () => {
    expect(md('<p>a<a href="https://example.com/x"></a>b</p>')).toBe('ab\n')
    expect(md('<p>a<a href="https://example.com/x"> </a>b</p>')).toBe('a b\n')
  })

  it('moves the spaces of a link outside its brackets', () => {
    expect(md('<p>a<a href="https://example.com/"> b </a>c</p>')).toBe('a [b](https://example.com/) c\n')
  })

  it('flattens the blocks and the breaks inside a link, and never nests links', () => {
    expect(md('<a href="https://example.com/c"><h3>Titre</h3><p>Texte<br>suite</p></a>')).toBe('[Titre Texte suite](https://example.com/c)\n')
    expect(md('<p><a href="https://example.com/1">un <a href="https://example.com/2">deux</a></a></p>')).toBe('[un deux](https://example.com/1)\n')
  })

  it('keeps links the page shows as stacked blocks apart', () => {
    expect(md('<nav><a href="https://example.com/1" d="b">Un</a><a href="https://example.com/2" d="b">Deux</a></nav>')).toBe('[Un](https://example.com/1)\n\n[Deux](https://example.com/2)\n')
  })
})

describe('images', () => {
  it('writes an image as a reference, listed with its address at the end', () => {
    const out = result('<p>Voici <img src="https://example.com/a.png" alt="Un chat"> et <img src="https://example.com/a.png" alt="Encore"> et <img src="https://example.com/b.jpg"></p>')
    expect(out.markdown).toBe('Voici ![Un chat][image-1] et ![Encore][image-1] et ![Image][image-2]\n\n[image-1]: https://example.com/a.png\n[image-2]: https://example.com/b.jpg\n')
    expect(out.images).toEqual([
      { reference: 'image-1', url: 'https://example.com/a.png', alt: 'Un chat' },
      { reference: 'image-2', url: 'https://example.com/b.jpg', alt: '' }
    ])
  })

  it('escapes the alternative text and the address', () => {
    const out = result('<p><img src="https://example.com/a (1).png" alt="a [b] *c*"></p>')
    expect(out.markdown).toBe('![a \\[b\\] \\*c\\*][image-1]\n\n[image-1]: https://example.com/a%20%281%29.png\n')
  })

  it('does not export an image with no web address, and says so', () => {
    const out = result('<p>x<img src="data:image/png;base64,AAAA" alt="inline"><img alt="rien"></p>')
    expect(out.markdown).toBe('x\n')
    expect(out.images).toEqual([])
    expect(out.warnings).toContain('Une image sans adresse web ne peut pas être exportée.')
  })

  it('keeps an image inside its link', () => {
    expect(md('<a href="https://example.com/p"><img src="https://example.com/i.png" alt="logo"></a>')).toBe('[![logo][image-1]](https://example.com/p)\n\n[image-1]: https://example.com/i.png\n')
  })

  it('rewrites the list of addresses with the paths the images were saved under', () => {
    const out = result('<p><img src="https://example.com/a.png" alt="a"><img src="https://example.com/b.png" alt="b"></p>')
    const local = new Map([['image-1', archiveImageName(0, 'png')]])
    expect(markdownWithImages(out, local)).toBe('![a][image-1]![b][image-2]\n\n[image-1]: images/image-001.png\n[image-2]: https://example.com/b.png\n')
    expect(markdownWithImages(out)).toBe(out.markdown)
  })
})

describe('code', () => {
  it('writes inline code, with a longer fence when the code holds backticks', () => {
    expect(md('<p>Lancez <code>npm test</code> puis <code>a`b</code> et <code>`x`</code>.</p>')).toBe('Lancez `npm test` puis ``a`b`` et `` `x` ``.\n')
    expect(md('<p><code>un\n   deux</code> <kbd>⌘</kbd> <code> </code></p>')).toBe('`un deux` `⌘`\n')
  })

  it('does not interpret the markup inside code', () => {
    expect(md('<p><code>*a* <b>b</b> [c]</code></p>')).toBe('`*a* b [c]`\n')
  })

  it('writes a code block as a fence, with its language, its indentation and its blank lines', () => {
    expect(md('<pre lang="js"><code>if (a) {\n  b()\n\n}</code></pre>')).toBe('```js\nif (a) {\n  b()\n\n}\n```\n')
  })

  it('reads the lines of a highlighted block whose lines are elements', () => {
    expect(md('<pre><code><span>let a = 1</span><br><span>let b = 2</span></code></pre>')).toBe('```\nlet a = 1\nlet b = 2\n```\n')
    expect(md('<pre><div>one</div><div>two</div></pre>')).toBe('```\none\ntwo\n```\n')
  })

  it('copes with code made of a very large number of backtick runs', () => {
    const runs = '` '.repeat(300_000)
    expect(md(`<pre>${runs}</pre><p><code>${runs}</code></p>`).length).toBeGreaterThan(600_000)
  })

  // A page chooses how long its runs of blanks are. Each of these took from half a minute to several minutes while the ends were found by a pattern
  // anchored at the end of the text; found by a loop, they take a few milliseconds. The delay of the test is the bound.
  it('copes with a block of code made of a very long run of blanks before its last character', () => {
    const blanks = ' '.repeat(300_000)
    expect(md(`<pre>a${blanks}b</pre>`)).toBe(`\`\`\`\na${blanks}b\n\`\`\`\n`)
    expect(md(`<pre>a${'\n'.repeat(300_000)}b\n\n \n</pre>`).endsWith('b\n```\n')).toBe(true)
  })

  it('copes with a very long run of unbreakable spaces inside a mark', () => {
    const blanks = '\u00a0'.repeat(300_000)
    expect(md(`<p><b>a${blanks}b</b> <i>c${blanks}d</i> <a href="https://example.com/">e${blanks}f</a></p>`)).toBe('**a b** *c d* [e f](https://example.com/)\n')
  })

  it('copes with a table cell made of a very long run of line breaks between two words', () => {
    const cell = (breaks: number) => md(`<table><tr><th>t</th></tr><tr><td> <br>a${'<br>'.repeat(breaks)}b<br> </td></tr></table>`)
    expect(cell(2)).toBe('| t |\n| --- |\n| a<br>b |\n')
    expect(cell(90_000)).toBe('| t |\n| --- |\n| a<br>b |\n')
  }, 1500)

  it('names a file from a title made of a very long run of dashes', () => {
    expect(exportFileName(`${'-'.repeat(2_000_000)}a`, 'md')).toBe('page.md')
    expect(exportFileName(`a${'-'.repeat(2_000_000)}b`, 'md')).toBe('a.md')
  })

  it('finds the ends of a text without the characters given, from both sides', () => {
    expect(edgesWithout('  a b \u0001', ' \u0001')).toEqual({ start: 2, end: 5 })
    expect(edgesWithout('   ', ' ')).toEqual({ start: 0, end: 0 })
    expect(edgesWithout('', ' ')).toEqual({ start: 0, end: 0 })
    expect(edgesWithout('ab', ' ')).toEqual({ start: 0, end: 2 })
    expect(withoutTrailing('a\n\nb\n\n', '\n')).toBe('a\n\nb')
    expect(withoutTrailing('\n\n', '\n')).toBe('')
  })

  it('opens a longer fence than any backticks in the code, and drops a block with no code', () => {
    expect(md('<pre>```\nx\n```</pre>')).toBe('````\n```\nx\n```\n````\n')
    expect(md('<pre> \n </pre><p>ok</p>')).toBe('ok\n')
  })

  it('escapes nothing inside a block', () => {
    expect(md('<pre># not a title\n- not a list\n* a_b_c</pre>')).toBe('```\n# not a title\n- not a list\n* a_b_c\n```\n')
  })
})

describe('quotes', () => {
  it('prefixes every line of a quote, nested quotes and blank lines included', () => {
    expect(md('<blockquote><p>un</p><p>deux</p><blockquote>dedans</blockquote></blockquote>')).toBe('> un\n>\n> deux\n>\n> > dedans\n')
  })

  it('keeps a list and a code block inside a quote', () => {
    expect(md('<blockquote><ul><li>a</li></ul><pre>x</pre></blockquote>')).toBe('> - a\n>\n> ```\n> x\n> ```\n')
  })
})

describe('lists', () => {
  it('writes bullets and numbers, starting where the list says', () => {
    expect(md('<ul><li>a</li><li>b</li></ul><ol start="3"><li>c</li><li>d</li></ol>')).toBe('- a\n- b\n\n3. c\n4. d\n')
  })

  it('indents nested lists under their item', () => {
    expect(md('<ul><li>un<ul><li>deux<ol><li>trois</li></ol></li></ul></li><li>autre</li></ul>')).toBe('- un\n  - deux\n    1. trois\n- autre\n')
  })

  it('indents the lines of an item as far as its marker is wide', () => {
    const items = Array.from({ length: 10 }, (_, i) => `<li>${i === 9 ? 'dix<ul><li>sous</li></ul>' : 'x'}</li>`).join('')
    expect(md(`<ol>${items}</ol>`).trimEnd().split('\n').slice(-2)).toEqual(['10. dix', '    - sous'])
  })

  it('keeps the paragraphs and the code of an item inside it', () => {
    expect(md('<ul><li><p>un</p><p>deux</p></li><li>code<pre>x</pre></li></ul>')).toBe('- un\n\n  deux\n- code\n\n  ```\n  x\n  ```\n')
  })

  it('puts a list after a numbered start on its own, since it could not interrupt the paragraph', () => {
    expect(md('<ul><li>texte<ol start="2"><li>deux</li></ol></li></ul>')).toBe('- texte\n\n  2. deux\n')
  })

  it('reads whitespace between items, a list placed straight in a list, and stray text', () => {
    expect(md('<ul>\n <li>a</li>\n <ul><li>b</li></ul>\n texte seul\n</ul>')).toBe('- a\n  - b\n- texte seul\n')
  })

  it('skips empty items and empty lists, and writes an item that is outside any list', () => {
    expect(md('<ul><li> </li><li>a</li></ul><ol></ol>')).toBe('- a\n')
    expect(md('<li>seul</li>')).toBe('- seul\n')
  })
})

describe('tables', () => {
  it('writes a simple table with its first row as the header', () => {
    expect(md('<table><thead><tr><th>Nom</th><th>Âge</th></tr></thead><tbody><tr><td>Ana</td><td>30</td></tr><tr><td>Bob</td><td>25</td></tr></tbody></table>')).toBe(
      '| Nom | Âge |\n| --- | --- |\n| Ana | 30 |\n| Bob | 25 |\n'
    )
  })

  it('pads short rows, escapes pipes, and writes the breaks of a cell as <br>', () => {
    expect(md('<table><tr><td>a|b</td><td>c<br>d</td></tr><tr><td>seul</td></tr></table>')).toBe('| a\\|b | c<br>d |\n| --- | --- |\n| seul |  |\n')
  })

  it('escapes the backslash of a cell before the bar written for it, so that `a\\|b` stays a backslash then a bar inside one cell', () => {
    expect(md('<table><tr><td>a\\|b</td></tr></table>')).toBe('| a\\\\\\|b |\n| --- |\n')
  })

  it('keeps links, images and emphasis inside cells', () => {
    expect(md('<table><tr><td><b>x</b></td><td><a href="https://example.com/">l</a></td></tr></table>')).toBe('| **x** | [l](https://example.com/) |\n| --- | --- |\n')
  })

  it('fills the cells a colspan or a rowspan covers, and says so', () => {
    const out = result('<table><tr><th colspan="2">Titre</th></tr><tr><td rowspan="2">a</td><td>b</td></tr><tr><td>c</td></tr></table>')
    expect(out.markdown).toBe('| Titre |  |\n| --- | --- |\n| a | b |\n|  | c |\n')
    expect(out.warnings).toEqual([frenchSpaces('Tableau aux cellules fusionnées : des cellules vides ont été ajoutées.')])
  })

  it('reads a table that holds tables as a layout, cell after cell, and keeps the inner table a table', () => {
    expect(md('<table><tr><td><p>gauche</p></td><td><table><tr><td>a</td><td>b</td></tr></table></td></tr></table>')).toBe('gauche\n\n| a | b |\n| --- | --- |\n')
  })

  it('writes a caption before the table and nothing for an empty table', () => {
    expect(md('<table><caption>Légende</caption><tr><td>x</td></tr></table>')).toBe('Légende\n\n| x |\n| --- |\n')
    expect(md('<table><tr><td> </td></tr></table><p>ok</p>')).toBe('ok\n')
  })

  it('writes the rows of a table the selection cut out of its table', () => {
    expect(md('<tr><td>a</td><td>b</td></tr><tr><td>c</td></tr>')).toBe('a | b\n\nc\n')
  })
})

describe('what the page shows', () => {
  it('unwraps a span or a custom element that holds blocks, so its paragraphs stay apart', () => {
    expect(md('<app-shell><span><p>un</p><p>deux</p></span></app-shell>')).toBe('un\n\ndeux\n')
    expect(md('<div>avant <span>dans <div>bloc</div> après</span> fin</div>')).toBe('avant dans\n\nbloc\n\naprès fin\n')
  })

  it('follows the display the page gave a generic element', () => {
    expect(md('<div d="b"><span d="b">Accueil</span><span d="b">À propos</span></div>')).toBe('Accueil\n\nÀ propos\n')
    expect(md('<section><div d="i">un</div><div d="i">deux</div></section>')).toBe('undeux\n')
  })
})

describe('the document', () => {
  it('puts the title first unless the text has a level-1 heading of its own', () => {
    expect(md('<p>texte</p>', { withTitle: true })).toBe('# Titre de la page\n\ntexte\n')
    expect(md('<h1>Déjà</h1><p>texte</p>', { withTitle: true })).toBe('# Déjà\n\ntexte\n')
    expect(md('<pre># ceci est du code</pre>', { withTitle: true })).toBe('# Titre de la page\n\n```\n# ceci est du code\n```\n')
    expect(md('<p>texte</p>', { withTitle: false })).toBe('texte\n')
  })

  it('escapes the title and gives nothing for an empty page', () => {
    expect(md('<p>x</p>', { withTitle: true, title: 'A * B\n\n  C' })).toBe('# A \\* B C\n\nx\n')
    expect(md('<p> </p>', { withTitle: true, withSource: true })).toBe('')
  })

  it('ends with the address of the page when asked, before the list of images', () => {
    expect(md('<p>x<img src="https://example.com/i.png" alt="i"></p>', { withSource: true })).toBe(frenchSpaces('x![i][image-1]\n\nSource : <https://example.com/docs/page?x=1>\n\n[image-1]: https://example.com/i.png\n'))
  })

  it('leaves the source line out when the address of the page is not a web address', () => {
    expect(md('<p>x</p>', { withSource: true, url: 'file:///tmp/a.html' })).toBe('x\n')
  })

  it('carries the warnings of the page and says when the page was cut', () => {
    const out = exportMarkdown({ nodes: ['x'], warnings: ['iframe : contenu non converti.', 'iframe : contenu non converti.', 12], truncated: true }, options())!
    expect(out.warnings).toEqual(['iframe : contenu non converti.', 'La page est trop volumineuse\u00a0: l’export est tronqué.'])
  })
})

describe('what a hostile page cannot get into the file', () => {
  it('drops scripts, styles, forms and embedded content with everything inside them', () => {
    const out = md(
      '<p>avant</p><script>alert("script")</script><style>p{color:red}</style><noscript>noscript</noscript><template>template</template><iframe>iframe</iframe><button>bouton</button><textarea>area</textarea><select><option>option</option></select><svg>dessin</svg><canvas>toile</canvas><video>video</video><p>après</p>'
    )
    expect(out).toBe('avant\n\naprès\n')
  })

  it('keeps no attribute that is not on the list: no handler, no style, no id', () => {
    const out = fromSnapshot([{ t: 'img', a: { src: 'https://example.com/a.png', alt: 'x', onerror: 'alert(1)', onload: 'alert(2)', style: 'x' } }, { t: 'a', a: { href: 'https://example.com/', onclick: 'alert(3)', target: '_blank' }, c: ['lien'] }])
    expect(out).toBe('![x][image-1][lien](https://example.com/)\n\n[image-1]: https://example.com/a.png\n')
    expect(out).not.toMatch(/alert|onerror|onclick|style|_blank/)
  })

  it('refuses addresses that are not web addresses: javascript, data, blob, file, vbscript, relative', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'blob:https://example.com/1', 'file:///etc/passwd', 'vbscript:x', '/relative', '//example.com/x', '']) {
      expect(fromSnapshot([{ t: 'a', a: { href: bad }, c: ['t'] }, { t: 'img', a: { src: bad } }])).toBe('t\n')
    }
  })

  it('cannot close the link of an address to start another', () => {
    const out = fromSnapshot([{ t: 'a', a: { href: 'https://example.com/a)](javascript:alert(1)' }, c: ['t'] }])
    expect(out).toBe('[t](https://example.com/a%29]%28javascript:alert%281%29)\n')
    expect(out).not.toContain('](javascript')
  })

  it('cannot reach the output through the title, the alternative text or a tag name', () => {
    const out = exportMarkdown({ nodes: [{ t: 'img', a: { src: 'https://example.com/a.png', alt: '](javascript:alert(1)) ![' } }, { t: 'SCRIPT', c: ['x'] }, { t: 'script', c: ['y'] }, { t: 'a b', c: ['z'] }, { t: 'x'.repeat(40), c: ['k'] }], warnings: [], truncated: false }, options({ title: '[t](javascript:1)', withTitle: true }))!.markdown
    expect(out).toBe('# \\[t\\](javascript:1)\n\n![\\](javascript:alert(1)) !\\[][image-1]\n\n[image-1]: https://example.com/a.png\n')
    expect(out).not.toMatch(/[xyz]\n|\bk\b/)
  })

  it('removes control and reordering characters from the text', () => {
    expect(md('<p>a\u0000b\u0001c\u202ed\u2066e\u200bf\ufeffg\u0085h</p>')).toBe('abcdefgh\n')
    expect(cleanText('a\r\nb\rc\u2028d\u0000')).toBe('a\nb\nc\nd')
  })

  it('does not emit raw HTML of its own beyond the <br> of a table cell', () => {
    const out = md('<p><b onclick="x">t</b><span style="x">u</span><font color="red">v</font></p>')
    expect(out).toBe('**t**uv\n')
  })
})

describe('snapshot limits', () => {
  it('refuses what is not a snapshot', () => {
    for (const raw of [null, undefined, 'x', 42, [], {}, { nodes: 'x' }, { nodes: {} }]) expect(exportMarkdown(raw, options())).toBeNull()
    expect(parseSnapshot({ nodes: [] })).toEqual({ nodes: [], warnings: [], truncated: false })
  })

  it('ignores items of the wrong shape instead of failing', () => {
    expect(fromSnapshot([null, 7, [], { t: 7 }, { t: 'p', c: 'not a list' }, { t: 'p', a: 'x', c: [3, { t: 'b', c: ['ok'] }] }])).toBe('**ok**\n')
  })

  it('cuts a tree that is deeper than the limit, and says so', () => {
    let deep: unknown = ['fond']
    for (let i = 0; i < MD_LIMITS.depth + 5; i++) deep = [{ t: 'div', c: deep }]
    const parsed = parseSnapshot({ nodes: deep })!
    expect(parsed.truncated).toBe(true)
    let depth = 0
    for (let level: MdNode[] | undefined = parsed.nodes; level?.[0] && typeof level[0] !== 'string'; level = level[0].c) depth++
    expect(depth).toBe(MD_LIMITS.depth)
  })

  it('cuts a tree that has too many nodes, and says so', () => {
    const nodes = Array.from({ length: MD_LIMITS.nodes + 10 }, () => ({ t: 'span', c: ['x'] }))
    const parsed = parseSnapshot({ nodes })!
    expect(parsed.truncated).toBe(true)
    expect(parsed.nodes.length).toBeLessThanOrEqual(MD_LIMITS.nodes / 2)
  })

  it('cuts text past the limit, in one piece or in many', () => {
    const big = parseSnapshot({ nodes: ['a'.repeat(MD_LIMITS.textChars + 50)] })!
    expect(big.truncated).toBe(true)
    expect((big.nodes[0] as string).length).toBe(MD_LIMITS.textChars)
    const many = parseSnapshot({ nodes: Array.from({ length: 5 }, () => 'b'.repeat(MD_LIMITS.textChars / 2)) })!
    expect(many.truncated).toBe(true)
    expect(many.nodes.join('').length).toBe(MD_LIMITS.textChars)
  })

  it('reads a huge span as the largest one allowed, and ignores one that is not a number', () => {
    const out = fromSnapshot([{ t: 'table', c: [{ t: 'tr', c: [{ t: 'td', a: { colspan: '999999999', rowspan: 'x' }, c: ['a'] }] }] }])
    // The cell and the empty ones its span covers, between the two outer pipes.
    expect(out.split('\n')[0]!.split('|')).toHaveLength(MD_LIMITS.span + 2)
  })

  it('keeps no more warnings than the limit from the start, so a flood of them is not even read', () => {
    const warnings = Array.from({ length: MD_LIMITS.warnings + 30 }, (_, i) => `w${i}`)
    expect(parseSnapshot({ nodes: [], warnings })!.warnings).toEqual(warnings.slice(0, MD_LIMITS.warnings))
  })

  it('limits the warnings it keeps', () => {
    const out = exportMarkdown({ nodes: ['x'], warnings: Array.from({ length: 80 }, (_, i) => `w${i} ${'y'.repeat(500)}`), truncated: false }, options())!
    expect(out.warnings).toHaveLength(MD_LIMITS.warnings)
    expect(out.warnings[0]!.length).toBeLessThanOrEqual(MD_LIMITS.warningChars)
  })
})

describe('safeUrl', () => {
  it('normalises an address and keeps only the schemes it is given', () => {
    expect(safeUrl('https://Example.com/a b', ['https:'])).toBe('https://example.com/a%20b')
    expect(safeUrl('http://example.com', ['https:'])).toBeNull()
    expect(safeUrl('not a url', ['https:'])).toBeNull()
    expect(safeUrl(5, ['https:'])).toBeNull()
    expect(safeUrl(`https://example.com/${'a'.repeat(MD_LIMITS.url)}`, ['https:'])).toBeNull()
  })
})

describe('exportFileName', () => {
  it('makes a file name of a title', () => {
    expect(exportFileName('Cours : Markdown / HTML ?', 'md')).toBe('Cours - Markdown - HTML.md')
    expect(exportFileName('', 'zip')).toBe('page.zip')
    expect(exportFileName('..\\..//évil', 'md')).toBe('évil.md')
    expect(exportFileName('a\u202egpj.exe\u0000', 'md')).toBe('a-gpj.exe.md')
    expect(exportFileName('x'.repeat(300), 'md')).toBe(`${'x'.repeat(100)}.md`)
    expect(exportFileName('...', 'md')).toBe('page.md')
  })
})

describe('archiveImageName', () => {
  it('numbers the images of an archive from 001', () => {
    expect(archiveImageName(0, 'png')).toBe('images/image-001.png')
    expect(archiveImageName(11, 'jpg')).toBe('images/image-012.jpg')
  })
})
