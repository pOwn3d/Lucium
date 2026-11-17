// The HTML of an article is cleaned before it goes into the reader's document: what the policy of the document does not cover is left out.
import { describe, expect, it } from 'vitest'
import { sanitizeArticleHtml as clean } from './reader-sanitize'

describe('what an article keeps', () => {
  it('leaves the markup of a text as it is: paragraphs, headings, lists, quotes, code, tables', () => {
    const html = '<h2>Titre</h2><p>Un <em>mot</em> et <strong>un autre</strong>.<br></p><ul><li>a</li><li>b</li></ul><blockquote><p>Citation</p></blockquote><pre><code>x &lt; y</code></pre><table><thead><tr><th colspan="2">T</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    expect(clean(html)).toBe(html)
  })

  it('keeps links to web pages, mail and phone addresses, and places in the article, and the language and direction of a run of text', () => {
    const html = '<p><a href="https://exemple.org/a?x=1&amp;y=2" title="Titre">web</a> <a href="http://exemple.org/">http</a> <a href="mailto:a@exemple.org">mail</a> <a href="tel:+33123456789">tel</a> <a href="#note-1">note</a> <span lang="en" dir="ltr">hello</span></p>'
    expect(clean(html)).toBe(html)
  })

  it('keeps the images the policy of the document lets load: web addresses and inline pictures', () => {
    const html = '<figure><img src="https://exemple.org/a.png" alt="Une &quot;image&quot;" width="640" height="480"><img src="http://exemple.org/b.jpg"><img src="data:image/png;base64,iVBORw0KGgo="><figcaption>Légende</figcaption></figure>'
    expect(clean(html)).toBe(html)
  })

  it('shows the first picture of a srcset to an image that has no src, and drops an image with no usable address', () => {
    expect(clean('<img srcset="https://exemple.org/a.png 1x, https://exemple.org/b.png 2x" alt="a">')).toBe('<img alt="a" src="https://exemple.org/a.png">')
    for (const html of ['<img>', '<img alt="x">', '<img src="">', '<img srcset="javascript:alert(1) 1x">']) expect(clean(html), html).toBe('')
  })
})

describe('what an article loses with everything inside it', () => {
  it('drops a script, a style, a frame, an object, an embed, a form and what it holds', () => {
    for (const html of [
      '<script>alert(1)</script>',
      '<script src="https://evil.example/x.js"></script>',
      '<style>body{display:none}</style>',
      '<iframe src="https://evil.example/"></iframe>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '<object data="https://evil.example/x"><param name="a" value="b">texte de repli</object>',
      '<embed src="https://evil.example/x">',
      '<form action="https://evil.example/"><input name="q"><button>Envoyer</button></form>',
      '<noscript><img src="https://evil.example/p.gif"></noscript>',
      '<svg onload="alert(1)"><script>alert(2)</script><a xlink:href="javascript:alert(3)"><text>x</text></a></svg>',
      '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
      '<video src="https://exemple.org/v.mp4">Votre navigateur…</video>',
      '<template><img src="x" onerror="alert(1)"></template>',
      '<textarea><img src=x onerror=alert(1)></textarea>'
    ]) {
      expect(clean(`<p>avant</p>${html}<p>après</p>`), html).toBe('<p>avant</p><p>après</p>')
    }
  })

  it('drops the tags that redirect, change the base of the addresses or load a style sheet', () => {
    for (const html of ['<meta http-equiv="refresh" content="0;url=https://evil.example/">', '<META HTTP-EQUIV=refresh CONTENT="0;url=https://evil.example/">', '<base href="https://evil.example/">', '<link rel="stylesheet" href="https://evil.example/x.css">']) {
      expect(clean(`<p>a</p>${html}<p>b</p>`), html).toBe('<p>a</p><p>b</p>')
    }
  })

  it('finds the end of an element that is nested in itself, and the end of one that holds text that looks like markup', () => {
    expect(clean('<p>a</p><svg><svg></svg><g></g></svg><p>b</p>')).toBe('<p>a</p><p>b</p>')
    expect(clean('<p>a</p><SCRIPT>var t = "</scrip" + "t>"; </ScRiPt ><p>b</p>')).toBe('<p>a</p><p>b</p>')
    expect(clean('<p>a</p><script>if (a < b) {}</script><p>b</p>')).toBe('<p>a</p><p>b</p>')
  })

  it('drops what follows an element that never closes, rather than guessing where it ends', () => {
    expect(clean('<p>a</p><script>alert(1)<p>b</p>')).toBe('<p>a</p>')
    expect(clean('<p>a</p><form><p>b</p>')).toBe('<p>a</p>')
  })

  it('drops comments, declarations and processing instructions', () => {
    expect(clean('<p>a</p><!-- <script>alert(1)</script> --><!DOCTYPE html><?xml version="1.0"?><![CDATA[x]]><p>b</p>')).toBe('<p>a</p><p>b</p>')
    expect(clean('<p>a</p><!-- jamais fermé <p>b</p>')).toBe('<p>a</p>')
  })
})

describe('what an element loses', () => {
  it('loses its handlers, its style, its class, its id and its name, which the scripts of the reader or the layout could mistake for their own', () => {
    expect(clean('<p onclick="alert(1)" onmouseover=alert(2) style="position:fixed;inset:0" class="rp" id="listen-play" name="x" data-a="b">texte</p>')).toBe('<p>texte</p>')
    expect(clean('<img src="https://exemple.org/a.png" onerror="alert(1)" ONLOAD="alert(2)" class="rp" style="width:9999px">')).toBe('<img src="https://exemple.org/a.png">')
    expect(clean('<a href="https://exemple.org/" onclick="alert(1)" target="_blank" ping="https://evil.example/" download>x</a>')).toBe('<a href="https://exemple.org/">x</a>')
  })

  it('loses a link that is not a web address, whatever the way the scheme is written, and keeps its text', () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      '\u0001javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      '&#106;avascript:alert(1)',
      '&#x6A;avascript:alert(1)',
      'javascript&colon;alert(1)',
      'javascript&#58;alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'blob:https://exemple.org/uuid',
      '//evil.example/',
      '/relatif',
      ''
    ]) {
      expect(clean(`<a href="${href}">texte</a>`), href).toBe('<a>texte</a>')
    }
  })

  it('loses an image that is not a picture the policy lets load', () => {
    for (const src of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'data:application/javascript,alert(1)', 'file:///etc/passwd', 'blob:https://exemple.org/uuid', 'ftp://exemple.org/a.png', '//exemple.org/a.png', '&#106;avascript:alert(1)']) {
      expect(clean(`<p>a<img src="${src}">b</p>`), src).toBe('<p>ab</p>')
    }
  })

  it('writes the values of the attributes it keeps with their quotes and brackets escaped, whatever the page wrote', () => {
    expect(clean('<img src="https://exemple.org/a.png" alt=\'a" onerror="alert(1)\'>')).toBe('<img src="https://exemple.org/a.png" alt="a&quot; onerror=&quot;alert(1)">')
    // Written with the one escape of the application: an apostrophe of a value is escaped as the other four characters are.
    expect(clean(`<img src="https://exemple.org/a.png" alt="l'image d&#39;ici <b> &amp; co">`)).toBe('<img src="https://exemple.org/a.png" alt="l&#39;image d&#39;ici &lt;b&gt; &amp; co">')
    expect(clean('<img src=https://exemple.org/a.png?a=1&b=2 alt=un>')).toBe('<img src="https://exemple.org/a.png?a=1&amp;b=2" alt="un">')
    expect(clean('<a href="https://exemple.org/?q=&lt;script&gt;" title="a&gt;b">x</a>')).toBe('<a href="https://exemple.org/?q=&lt;script&gt;" title="a&gt;b">x</a>')
  })

  it('keeps on an element only the attributes it is given, not those of another', () => {
    expect(clean('<p href="https://exemple.org/" src="https://exemple.org/a.png" alt="x" datetime="2026-01-01" open reversed width="10" colspan="2" start="3" onclick="1" tabindex="0">a</p>')).toBe('<p>a</p>')
    expect(clean('<a src="https://exemple.org/a.png" alt="x" width="10" href="https://exemple.org/">a</a>')).toBe('<a href="https://exemple.org/">a</a>')
    expect(clean('<span lang="x onclick=1" dir="sideways" title="t">a</span>')).toBe('<span title="t">a</span>')
  })

  it('keeps a number where a number is expected, and nothing else', () => {
    expect(clean('<td colspan="2" rowspan="3">x</td><td colspan="2;alert(1)" rowspan="-1">y</td>')).toBe('<td colspan="2" rowspan="3">x</td><td>y</td>')
    expect(clean('<img src="https://exemple.org/a.png" width="100%" height="auto">')).toBe('<img src="https://exemple.org/a.png">')
  })

  it('loses its tag and keeps its text when it is not one a reader shows', () => {
    expect(clean('<font color="red">rouge</font> <custom-element foo="bar">neuf</custom-element> <marquee>défile</marquee> <label for="a">label</label>')).toBe('rouge neuf défile label')
    expect(clean('<html><head><title>t</title></head><body><p>a</p></body></html>')).toBe('<p>a</p>')
  })
})

describe('the shape of what comes out', () => {
  it('cannot close the elements around the article: a closing tag with nothing open is dropped', () => {
    expect(clean('<p>a</p></article></main></body></html><p>b</p></div></div>')).toBe('<p>a</p><p>b</p>')
  })

  it('leaves what is open as it is when a closing tag names something that is not: it closes nothing', () => {
    expect(clean('<div><span>a</i>b</span></div>')).toBe('<div><span>ab</span></div>')
    expect(clean('<ul><li>a</p></li></ul>')).toBe('<ul><li>a</li></ul>')
  })

  it('closes what the page left open, and what an end tag closes with it', () => {
    expect(clean('<div><p>a')).toBe('<div><p>a</p></div>')
    expect(clean('<div><span><b>a</div>b')).toBe('<div><span><b>a</b></span></div>b')
  })

  it('writes a lone « < » or a tag that never ends as text, and nothing after it as markup', () => {
    expect(clean('<p>1 < 2 et 3 <3</p>')).toBe('<p>1 &lt; 2 et 3 &lt;3</p>')
    expect(clean('<p>a</p><img src="https://exemple.org/a.png" alt="x')).toBe('<p>a</p>&lt;img src="https://exemple.org/a.png" alt="x')
    expect(clean('<p>a</p><a href="x <b>gras</b>').includes('<b>')).toBe(false)
  })

  it('does not nest deeper than a reader needs, however deep the page does', () => {
    const output = clean('<div>'.repeat(1000) + 'texte' + '</div>'.repeat(1000))
    expect(output.match(/<div>/g)).toHaveLength(100)
    expect(output.match(/<\/div>/g)).toHaveLength(100)
    expect(output).toContain('texte')
  })

  it('is its own fixed point: cleaning what was cleaned changes nothing', () => {
    const html = '<p>a <a href="https://exemple.org/?a=1&amp;b=2" title="t">b</a><img src="https://exemple.org/a.png" alt="x &quot;y&quot;"></p><ul><li>c</li></ul><div><span>1 &lt; 2</span></div>'
    expect(clean(clean(html))).toBe(clean(html))
    const hostile = '<p onclick=x>a<script>b</script><a href="javascript:c">d</a><iframe></iframe><img src=x onerror=y></p></div><div><span>'
    expect(clean(clean(hostile))).toBe(clean(hostile))
  })
})

describe('the time it takes', () => {
  // A hostile page chooses the text: whatever it chooses, it is read once. A pass over two million characters takes well under a second; the bound leaves room for a slow machine.
  const SECONDS = 2
  const taken = (html: string): number => {
    const start = performance.now()
    clean(html)
    return (performance.now() - start) / 1000
  }

  it('stays linear on text made to make a parser start over: tags that never end, quotes that never close, nesting that never closes', () => {
    const size = 2_000_000
    const inputs: Record<string, string> = {
      'tags without end': '<a '.repeat(size / 3),
      'quotes without end': '<a b="'.repeat(size / 6),
      'lone brackets': '<'.repeat(size),
      'elements without end': '<svg>'.repeat(size / 5),
      'elements opened and closed': '<svg></svg>'.repeat(size / 11),
      'nesting': '<div>'.repeat(size / 5),
      'closing tags': '</b>'.repeat(size / 4),
      'references': `<a href="${'&'.repeat(size)}">x</a>`,
      'long run of blanks in a tag': `<a ${' '.repeat(size)}href="https://exemple.org/">x</a>`,
      'comments without end': '<!--'.repeat(size / 4)
    }
    for (const [name, html] of Object.entries(inputs)) expect(taken(html), name).toBeLessThan(SECONDS)
  })
})
