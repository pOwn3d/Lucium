// A paste of formatted text into a note: what a note knows of it is kept (titles, bold, italic, struck, code, links to a web page or a mail address,
// lists, boxes, quotes, blocks of code), the rest is dropped to its text (spans, tables, styles), and some of it with its text too (scripts, styles,
// forms, frames, pictures); an address that is not a web page nor a mail address is no link. What comes out reads back as what was pasted.
// The documents here are built by a small reader of well-formed HTML (the editor has the browser's DOMParser).

import { describe, expect, it } from 'vitest'
import { blockChars, readDoc } from './note-doc'
import { htmlToNoteMarkdown, PASTE_LIMITS, type PasteNode } from './note-paste'

interface TreeNode extends PasteNode {
  childNodes: TreeNode[]
  attributes?: Record<string, string>
}

const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'area', 'col', 'embed', 'wbr'])
const decode = (text: string): string => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')

/** The body of a well-formed piece of HTML, as a tree of the nodes htmlToNoteMarkdown reads. */
function body(html: string): TreeNode {
  const element = (name: string, attributes: Record<string, string>): TreeNode => ({ nodeType: 1, nodeName: name.toUpperCase(), childNodes: [], attributes, getAttribute: (key) => attributes[key] ?? null })
  const root = element('body', {})
  const stack: TreeNode[] = [root]
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|[^<]+/g)) {
    const [whole, closing, opening, rest] = token
    const top = stack[stack.length - 1]!
    if (whole.startsWith('<!--')) continue
    if (closing !== undefined) {
      const at = stack.map((node) => node.nodeName).lastIndexOf(closing.toUpperCase())
      if (at > 0) stack.length = at
      continue
    }
    if (opening !== undefined) {
      const attributes: Record<string, string> = {}
      for (const [, key, value] of (rest ?? '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attributes[key!.toLowerCase()] = decode(value ?? '')
      const node = element(opening, attributes)
      top.childNodes.push(node)
      if (!VOID.has(opening.toLowerCase())) stack.push(node)
      continue
    }
    top.childNodes.push({ nodeType: 3, nodeName: '#text', childNodes: [], data: decode(whole) })
  }
  return root
}

const paste = (html: string): string => htmlToNoteMarkdown(body(html))

/** What a note made of the paste shows, block by block, as note-doc.test.ts writes it. */
function shows(markdown: string): string[] {
  return readDoc(markdown).blocks.map((block) => {
    const look = blockChars(block)
      .map((char) => `${char.strong ? 'B' : ''}${char.em ? 'I' : ''}${char.strike ? 'S' : ''}${char.code ? 'C' : ''}${char.href && !char.bare ? 'L' : ''}`)
      .join('|')
    return `${block.kind}:${block.text}${/[BISCL]/.test(look) ? ` [${look}]` : ''}`
  })
}

describe('a paste from a web page', () => {
  it('keeps bold, italic, links and lists, written as Markdown', () => {
    const markdown = paste('<p>Un <b>gras</b>, un <em>italique</em>, un <a href="https://example.org/x">lien</a>.</p><ul><li>un</li><li>deux</li></ul><ol start="3"><li>trois</li><li>quatre</li></ol>')
    expect(markdown).toBe('Un **gras**, un *italique*, un [lien](https://example.org/x).\n- un\n- deux\n3. trois\n4. quatre')
  })

  it('keeps titles, quotes, struck text, code and blocks of code, boxes and lists inside lists', () => {
    const markdown = paste(
      '<h1>Titre</h1><h2>Sous-titre</h2><h4>Petit</h4><blockquote><p>cité</p></blockquote><p><code>pnpm test</code> <del>vieux</del></p><pre><code>x = 1\n\ny = 2\n</code></pre><ul><li><input type="checkbox" checked> fait</li><li><input type="checkbox"> à faire</li><li>a<ul><li>b</li></ul></li></ul>'
    )
    expect(markdown).toBe('# Titre\n## Sous-titre\n### Petit\n> cité\n`pnpm test` ~~vieux~~\n```\nx = 1\n\ny = 2\n```\n- [x] fait\n- [ ] à faire\n- a\n  - b')
  })

  it('reads the weight, slant and line of a style (Google Docs writes its bold so, inside a <b> of normal weight)', () => {
    const markdown = paste('<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span style="font-weight:700">gras</span> <span style="font-style:italic">penché</span> <span style="text-decoration:line-through">barré</span> normal</p></b>')
    expect(markdown).toBe('**gras** *penché* ~~barré~~ normal')
  })

  it('keeps a mail link, and the text of a link to anything else', () => {
    expect(paste('<p><a href="mailto:loic@example.org">écrire</a> <a href="javascript:alert(1)">clic</a> <a href="data:text/html,x">data</a> <a href="file:///etc/passwd">fichier</a> <a href="/relatif">relatif</a></p>')).toBe('[écrire](mailto:loic@example.org) clic data fichier relatif')
  })

  it('drops scripts, styles, frames, forms and pictures with their text, and any other element to its text', () => {
    const markdown = paste(
      '<style>p { color: red }</style><p onclick="steal()">a<script>alert(1)</script> <img src="x" onerror="alert(2)"><iframe src="https://evil.example"></iframe><span style="color:red" class="x">rouge</span> <button>Envoyer</button><select><option>choix</option></select><svg><text>dessin</text></svg></p><table><tr><td>c1</td><td>c2</td></tr></table><noscript>sans script</noscript><template><p>caché</p></template>'
    )
    expect(markdown).toBe('a rouge\nc1 c2')
    expect(markdown).not.toMatch(/alert|steal|evil|Envoyer|choix|dessin|caché|sans script|color/)
  })

  it('collapses the blanks of HTML, keeps its line breaks, and leaves out what holds no text', () => {
    expect(paste('<div>  un\n   deux  </div><p></p><div><br></div><p>trois<br>quatre</p>')).toBe('un deux\ntrois\nquatre')
  })

  it('writes a sign of the text so that it stays text, never a mark nor a title', () => {
    const markdown = paste('<p>5 * 3 = *x* et `y`</p><p># pas un titre</p><p>- pas une liste</p>')
    expect(shows(markdown)).toEqual(['paragraph:5 * 3 = *x* et `y`', 'paragraph:# pas un titre', 'paragraph:- pas une liste'])
  })

  it('reads back as what was pasted: each look on its words', () => {
    const markdown = paste('<p><strong>gras <em>et penché</em></strong> puis <a href="https://example.org/"><b>lien gras</b></a></p>')
    expect(shows(markdown)).toEqual(['paragraph:gras et penché puis lien gras [B|B|B|B|B|BI|BI|BI|BI|BI|BI|BI|BI|BI|||||||BL|BL|BL|BL|BL|BL|BL|BL|BL]'])
  })

  it('gives nothing for a page with no text', () => {
    expect(paste('<img src="x"><script>alert(1)</script>')).toBe('')
  })

  it('copes with a block of code made of a very long run of line ends before its last character, and keeps no line end at its end', () => {
    // Longer than the budget of a paste: the block is cut inside the run, and what is left of the run goes like any line end at the end of a block.
    expect(paste(`<pre>a${'\n'.repeat(300_000)}b</pre>`)).toBe(paste('<pre>a</pre>'))
    expect(paste('<pre>a\n\nb\n\n\n</pre>')).toBe(paste('<pre>a\n\nb</pre>'))
  })

  it('stops reading at its limits, deep or long, without failing', () => {
    let deep = 'fond'
    for (let level = 0; level < PASTE_LIMITS.depth + 10; level++) deep = `<span>${deep}</span>`
    expect(paste(`<p>haut ${deep}</p>`)).toBe('haut')
    const many = '<p>x</p>'.repeat(PASTE_LIMITS.nodes)
    expect(paste(many).split('\n').length).toBeLessThan(PASTE_LIMITS.nodes)
  })
})
