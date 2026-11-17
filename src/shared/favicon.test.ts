import { describe, expect, it } from 'vitest'
import {
  FAVICON_CANDIDATES_MAX,
  FAVICON_FILE_MAX,
  FAVICON_HTML_MAX,
  FAVICON_URL_MAX,
  acceptIcon,
  fillIcons,
  hasIcon,
  iconAllowedFor,
  iconCandidates,
  iconTarget,
  iconsWanted,
  isPublicHost,
  parseIconLinks,
  pickIcon,
  sniffImage,
  type IconFill
} from './favicon'
import type { SidebarState } from './model'
import { privateAction } from './private-window'
import { createInitialState, reduce, type Ctx } from './sidebar'

const PAGE = 'https://exemple.fr/accueil/index.html'
const ICO = 'https://exemple.fr/favicon.ico'

const urls = (html: string, page = PAGE): string[] => parseIconLinks(html, page).map((l) => l.url)
const head = (...links: string[]): string => `<!doctype html><html><head><meta charset="utf-8"><title>Un site</title>${links.join('\n')}</head><body>x</body></html>`

describe('the icons a page declares', () => {
  it('reads the link tags whatever the quotes, the order of the attributes and the case', () => {
    const html = head(
      `<link rel="icon" href="/a.png">`,
      `<link href='/b.png' rel='icon'>`,
      `<LINK REL=icon HREF=/c.png>`,
      `<link\n  rel="icon"\n  type="image/png"\n  href="/d.png"\n/>`,
      `<link rel = "icon"   href = "/e.png" >`
    )
    expect(urls(html)).toEqual(['https://exemple.fr/a.png', 'https://exemple.fr/b.png', 'https://exemple.fr/c.png', 'https://exemple.fr/d.png', 'https://exemple.fr/e.png'])
  })

  it('knows the four rels of an icon, and nothing else that looks like one', () => {
    const html = head(
      `<link rel="shortcut icon" href="/shortcut.ico">`,
      `<link rel="SHORTCUT   ICON" href="/spaced.ico">`,
      `<link rel="apple-touch-icon" href="/apple.png">`,
      `<link rel="apple-touch-icon-precomposed" href="/precomposed.png">`,
      `<link rel="mask-icon" href="/mask.svg" color="red">`,
      `<link rel="stylesheet" href="/style.css">`,
      `<link rel="preload" as="image" href="/hero.png">`,
      `<link rel="manifest" href="/site.webmanifest">`,
      `<link rel="canonical" href="https://exemple.fr/">`,
      `<link href="/sans-rel.png">`,
      `<a rel="icon" href="/not-a-link.png">`
    )
    expect(urls(html).sort()).toEqual(['https://exemple.fr/apple.png', 'https://exemple.fr/precomposed.png', 'https://exemple.fr/shortcut.ico', 'https://exemple.fr/spaced.ico'])
  })

  it('resolves relative addresses against the page: same folder, parent folder, root, other host, protocol-relative', () => {
    const html = head(`<link rel="icon" href="i1.png">`, `<link rel="icon" href="../i2.png">`, `<link rel="icon" href="/i3.png">`, `<link rel="icon" href="//cdn.exemple.fr/i4.png">`, `<link rel="icon" href="https://autre.example/i5.png">`)
    expect(urls(html)).toEqual(['https://exemple.fr/accueil/i1.png', 'https://exemple.fr/i2.png', 'https://exemple.fr/i3.png', 'https://cdn.exemple.fr/i4.png', 'https://autre.example/i5.png'])
  })

  it('applies <base href>, the first one that has an address, even to a link that stands before it', () => {
    const html = `<head><link rel="icon" href="i.png"><base target="_blank"><base href="https://cdn.exemple.fr/assets/"><base href="https://autre.example/"></head>`
    expect(urls(html)).toEqual(['https://cdn.exemple.fr/assets/i.png'])
    expect(urls(`<base href="/static/"><link rel="icon" href="i.png">`)).toEqual(['https://exemple.fr/static/i.png'])
    expect(urls(`<base href="sous/"><link rel="icon" href="i.png">`)).toEqual(['https://exemple.fr/accueil/sous/i.png'])
  })

  it('ignores a <base> that is not a web address, and keeps the page as the base', () => {
    for (const base of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/', 'mailto:a@b.c', '', 'http://']) {
      expect(urls(`<base href="${base}"><link rel="icon" href="/i.png">`), base).toEqual(['https://exemple.fr/i.png'])
    }
  })

  it('does not see a link inside a comment, a script, a style, a title, a textarea or a noscript', () => {
    const link = `<link rel="icon" href="/cache.png">`
    const html = head(
      `<!-- ${link} -->`,
      `<!--[if IE]>${link}<![endif]-->`,
      `<script>var s = '${link}'; if (a < b) {}</script>`,
      `<style>/* ${link} */</style>`,
      `<textarea>${link}</textarea>`,
      `<noscript>${link}</noscript>`,
      `<SCRIPT type="text/x-template">${link}</SCRIPT >`,
      `<link rel="icon" href="/vrai.png">`
    ).replace('<title>Un site</title>', `<title>${link}</title>`)
    expect(urls(html)).toEqual(['https://exemple.fr/vrai.png'])
  })

  it('reads on after the comments that browsers close early, and stops at one that never ends', () => {
    expect(urls(`<!--><link rel="icon" href="/a.png">`)).toEqual(['https://exemple.fr/a.png'])
    expect(urls(`<!---><link rel="icon" href="/a.png">`)).toEqual(['https://exemple.fr/a.png'])
    expect(urls(`<!-- jamais fermé <link rel="icon" href="/a.png">`)).toEqual([])
  })

  it('does not end a tag at a ">" inside a quoted value, and keeps the first of two attributes of one name', () => {
    expect(urls(`<link title="a > b" rel="icon" href="/i.png">`)).toEqual(['https://exemple.fr/i.png'])
    expect(urls(`<link rel="icon" href="/premier.png" href="/second.png">`)).toEqual(['https://exemple.fr/premier.png'])
  })

  it('decodes the character references an address is written with', () => {
    expect(urls(`<link rel="icon" href="/i.png?v=1&amp;w=2">`)).toEqual(['https://exemple.fr/i.png?v=1&w=2'])
    expect(urls(`<link rel="icon" href="&#47;i&#x2e;png">`)).toEqual(['https://exemple.fr/i.png'])
  })

  it('trims the address and the line breaks a browser would drop, drops the fragment, ignores an empty one', () => {
    expect(urls(`<link rel="icon" href="  /i.png\n">`)).toEqual(['https://exemple.fr/i.png'])
    expect(urls(`<link rel="icon" href="/i.s\tvg#dark">`)).toEqual(['https://exemple.fr/i.svg'])
    expect(urls(`<link rel="icon" href="">`)).toEqual([])
    expect(urls(`<link rel="icon" href="   ">`)).toEqual([])
    expect(urls(`<link rel="icon">`)).toEqual([])
  })

  it('stops reading at 64 KB: an icon declared beyond is not looked for', () => {
    const padding = `<!-- ${'x'.repeat(FAVICON_HTML_MAX)} -->`
    expect(urls(`${padding}<link rel="icon" href="/loin.png">`)).toEqual([])
    expect(urls(`<link rel="icon" href="/près.png">${padding}`)).toEqual(['https://exemple.fr/pr%C3%A8s.png'])
  })

  it('a tag the text ends inside is not read', () => {
    expect(urls(`<link rel="icon" href="/ok.png"><link rel="icon" href="/coupé`)).toEqual(['https://exemple.fr/ok.png'])
    expect(urls(`<link rel="icon" href="/ok.png"><link rel="icon"`)).toEqual(['https://exemple.fr/ok.png'])
    expect(urls(`<link rel="icon" href="/ok.png"><link`)).toEqual(['https://exemple.fr/ok.png'])
  })
})

describe('the addresses an icon may have', () => {
  it('never keeps data:, javascript:, file:, blob:, ftp: or any other scheme than https (http only for an http page)', () => {
    const bad = [
      'data:image/png;base64,iVBORw0KGgo=',
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'jav\tascript:alert(1)',
      ' javascript:alert(1)',
      'file:///etc/passwd',
      'blob:https://exemple.fr/1',
      'ftp://exemple.fr/i.ico',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/i.png',
      'view-source:https://exemple.fr/i.png',
      'about:blank',
      'http://exemple.fr/i.png'
    ]
    for (const href of bad) expect(urls(`<link rel="icon" href="${href}">`), href).toEqual([])
    expect(urls(`<link rel="icon" href="http://exemple.fr/i.png">`, 'http://exemple.fr/')).toEqual(['http://exemple.fr/i.png'])
    expect(urls(`<link rel="icon" href="https://exemple.fr/i.png">`, 'http://exemple.fr/')).toEqual(['https://exemple.fr/i.png'])
  })

  it('refuses a login in the address, an address that is not valid and one too long to be stored', () => {
    const bad = ['https://moi:secret@exemple.fr/i.png', 'https://moi@exemple.fr/i.png', 'https://:secret@exemple.fr/i.png', 'https://exemple.fr:99999/i.png', 'https://[::1/i.png', 'https://exe mple.fr/i.png']
    for (const href of bad) expect(urls(`<link rel="icon" href="${href}">`), href).toEqual([])
    const long = `https://exemple.fr/${'a'.repeat(FAVICON_URL_MAX)}.png`
    expect(urls(`<link rel="icon" href="${long}">`)).toEqual([])
    const justFits = `https://exemple.fr/${'a'.repeat(FAVICON_URL_MAX - 'https://exemple.fr/'.length)}`
    expect(urls(`<link rel="icon" href="${justFits}">`)).toEqual([justFits])
  })

  it('iconAllowedFor says the same for a stored address', () => {
    expect(iconAllowedFor('https://exemple.fr/i.png', 'https://exemple.fr/')).toBe(true)
    expect(iconAllowedFor('https://cdn.autre.example/i.png', 'https://exemple.fr/')).toBe(true)
    expect(iconAllowedFor('http://exemple.fr/i.png', 'https://exemple.fr/')).toBe(false)
    expect(iconAllowedFor('http://exemple.fr/i.png', 'http://exemple.fr/')).toBe(true)
    expect(iconAllowedFor('http://exemple.fr/i.png', 'not an address')).toBe(false)
    for (const bad of ['data:image/png;base64,AAAA', 'javascript:1', 'file:///a.png', 'https://u:p@exemple.fr/i.png', '', 'exemple.fr/i.png', 42, null, undefined, {}, ['https://exemple.fr/i.png']]) {
      expect(iconAllowedFor(bad, 'https://exemple.fr/'), String(bad)).toBe(false)
    }
    expect(iconAllowedFor(`https://exemple.fr/${'a'.repeat(FAVICON_URL_MAX)}`, 'https://exemple.fr/')).toBe(false)
  })
})

describe('choosing the best icon', () => {
  it('prefers the size nearest to 32 to 64 px: a small one loses to a right-sized one, which beats a huge one', () => {
    const html = head(
      `<link rel="icon" sizes="16x16" href="/p16.png" type="image/png">`,
      `<link rel="icon" sizes="48x48" href="/p48.png" type="image/png">`,
      `<link rel="icon" sizes="512x512" href="/p512.png" type="image/png">`
    )
    expect(iconCandidates(html, PAGE)).toEqual(['https://exemple.fr/p48.png', 'https://exemple.fr/p16.png', 'https://exemple.fr/p512.png', ICO])
    expect(pickIcon(html, PAGE)).toBe('https://exemple.fr/p48.png')
    // 32 and 64 are both inside the wanted band; 31 and 65 are not.
    expect(pickIcon(head(`<link rel="icon" sizes="31x31" href="/a.png">`, `<link rel="icon" sizes="32x32" href="/b.png">`), PAGE)).toBe('https://exemple.fr/b.png')
    expect(pickIcon(head(`<link rel="icon" sizes="128x128" href="/a.png">`, `<link rel="icon" sizes="64x64" href="/b.png">`), PAGE)).toBe('https://exemple.fr/b.png')
  })

  it('takes the declared size nearest to the wanted one out of several, and treats "any" as a perfect fit', () => {
    expect(pickIcon(head(`<link rel="icon" sizes="16x16" href="/a.png">`, `<link rel="icon" sizes="16x16 32x32 256x256" href="/b.png">`), PAGE)).toBe('https://exemple.fr/b.png')
    expect(pickIcon(head(`<link rel="icon" sizes="32x32" href="/a.png">`, `<link rel="icon" sizes="any" href="/b.svg" type="image/svg+xml">`), PAGE)).toBe('https://exemple.fr/a.png')
    expect(pickIcon(head(`<link rel="icon" sizes="16x16" href="/a.png">`, `<link rel="icon" sizes="any" href="/b.svg">`), PAGE)).toBe('https://exemple.fr/b.svg')
    expect(pickIcon(head(`<link rel="icon" sizes="16x16" href="/a.png">`, `<link rel="icon" sizes="AnY" href="/b.ico">`), PAGE)).toBe('https://exemple.fr/b.ico')
    // Sizes written the wrong way are no size at all.
    expect(parseIconLinks(head(`<link rel="icon" sizes="grand" href="/a.png">`, `<link rel="icon" sizes="32 x 32" href="/b.png">`, `<link rel="icon" sizes="0x0 99999999x1" href="/c.png">`), PAGE).map((l) => l.size)).toEqual([0, 0, 0])
  })

  it('at an equal size prefers png, then svg, then ico, then any other format', () => {
    const html = head(`<link rel="icon" sizes="32x32" href="/a.gif">`, `<link rel="icon" sizes="32x32" href="/b.ico">`, `<link rel="icon" sizes="32x32" href="/c.svg">`, `<link rel="icon" sizes="32x32" href="/d.png">`)
    expect(iconCandidates(html, PAGE).slice(0, 3)).toEqual(['https://exemple.fr/d.png', 'https://exemple.fr/c.svg', 'https://exemple.fr/b.ico'])
  })

  it('reads the format from type= before the extension, and from the extension without it', () => {
    const links = parseIconLinks(head(`<link rel="icon" href="/x" type="image/svg+xml">`, `<link rel="icon" href="/y.png" type="image/x-icon">`, `<link rel="icon" href="/z.ICO?v=2">`, `<link rel="icon" href="/w">`), PAGE)
    expect(links.map((l) => l.format)).toEqual(['svg', 'ico', 'ico', 'other'])
  })

  it('keeps the apple-touch-icons as a fallback: after every plain icon, whatever the sizes', () => {
    const html = head(`<link rel="apple-touch-icon" sizes="64x64" href="/apple.png">`, `<link rel="icon" sizes="16x16" href="/petit.png">`)
    expect(iconCandidates(html, PAGE)).toEqual(['https://exemple.fr/petit.png', 'https://exemple.fr/apple.png', ICO])
    expect(pickIcon(head(`<link rel="apple-touch-icon" href="/apple.png">`), PAGE)).toBe('https://exemple.fr/apple.png')
    expect(pickIcon(head(`<link rel="apple-touch-icon-precomposed" href="/apple.png">`), PAGE)).toBe('https://exemple.fr/apple.png')
  })

  it('puts the icon meant for a dark appearance after the others', () => {
    const html = head(`<link rel="icon" href="/sombre.png" media="(prefers-color-scheme: dark)">`, `<link rel="icon" href="/clair.png" media="(prefers-color-scheme: light)">`)
    expect(iconCandidates(html, PAGE)[0]).toBe('https://exemple.fr/clair.png')
    expect(iconCandidates(head(`<link rel="icon" href="/sombre.png" media="(prefers-color-scheme:dark)">`), PAGE)[0]).toBe('https://exemple.fr/sombre.png')
  })

  it('ends with /favicon.ico of the origin of the page, once, and gives only that for a page that declares nothing', () => {
    expect(iconCandidates('', PAGE)).toEqual([ICO])
    expect(iconCandidates(head(), 'https://exemple.fr:8443/a/b?c=1#d')).toEqual(['https://exemple.fr:8443/favicon.ico'])
    expect(iconCandidates(head(`<link rel="icon" href="/favicon.ico">`, `<link rel="icon" href="/favicon.ico#x">`), PAGE)).toEqual([ICO])
    // <base> moves the declared icons, not the place /favicon.ico is looked for.
    expect(iconCandidates(`<base href="https://cdn.exemple.fr/x/">`, PAGE)).toEqual([ICO])
  })

  it('gives at most FAVICON_CANDIDATES_MAX addresses, the last one /favicon.ico, no duplicate', () => {
    const many = Array.from({ length: 30 }, (_, i) => `<link rel="icon" sizes="${i + 1}x${i + 1}" href="/i${i}.png">`)
    const out = iconCandidates(head(...many, ...many), PAGE)
    expect(out).toHaveLength(FAVICON_CANDIDATES_MAX)
    expect(out.at(-1)).toBe(ICO)
    expect(new Set(out).size).toBe(out.length)
    // None of the 30 sizes reaches the wanted band: the nearest to it, 30, is first.
    expect(out[0]).toBe('https://exemple.fr/i29.png')
  })

  it('does not count against the limit the addresses the caller will not ask for', () => {
    const links = Array.from({ length: 5 }, (_, i) => `<link rel="icon" href="https://interdit.example/${i}.png">`).concat([`<link rel="icon" href="/bon.png">`])
    expect(iconCandidates(head(...links), PAGE).includes('https://exemple.fr/bon.png')).toBe(false)
    expect(iconCandidates(head(...links), PAGE, (address) => !address.includes('interdit'))).toEqual(['https://exemple.fr/bon.png', ICO])
    // The last resort is not for the caller to filter out.
    expect(iconCandidates('', PAGE, () => false)).toEqual([ICO])
  })

  it('keeps only 64 links of a page, so that a page of nothing but links costs no more than a page of 64', () => {
    const many = Array.from({ length: 500 }, (_, i) => `<link rel="icon" href="/i${i}.png">`).join('')
    expect(parseIconLinks(many, PAGE)).toHaveLength(64)
  })

  it('gives nothing for a page address that is not a web address', () => {
    for (const page of ['file:///a.html', 'data:text/html,x', 'about:blank', 'not an address', '', 'javascript:1', 'https://u:p@exemple.fr/']) {
      expect(iconCandidates(head(`<link rel="icon" href="https://exemple.fr/i.png">`), page), page).toEqual([])
      expect(pickIcon(head(), page), page).toBeNull()
    }
  })
})

describe('the site an address stands for', () => {
  it('is the origin of a web address, with its port, and nothing for the rest', () => {
    expect(iconTarget('https://Exemple.FR/a/b?c#d')).toEqual({ origin: 'https://exemple.fr', root: 'https://exemple.fr/', hostname: 'exemple.fr', host: 'exemple.fr', secure: true })
    expect(iconTarget('http://exemple.fr:8080/x')).toMatchObject({ origin: 'http://exemple.fr:8080', host: 'exemple.fr:8080', secure: false })
    for (const bad of ['file:///a', 'about:blank', 'data:text/html,x', 'javascript:1', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/p.html', 'ftp://exemple.fr/', 'https://u:p@exemple.fr/', 'x', '', 42, null, undefined, `https://exemple.fr/${'a'.repeat(FAVICON_URL_MAX)}`]) {
      expect(iconTarget(bad), String(bad)).toBeNull()
    }
  })

  it('knows which hosts are on the public Internet: not this machine, the local network, or a bare name', () => {
    for (const host of ['exemple.fr', 'www.exemple.fr', 'sub.domaine.co.uk', '93.184.216.34', '8.8.8.8', '[2606:2800:220:1:248:1893:25c8:1946]']) expect(isPublicHost(host), host).toBe(true)
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.1.254', '169.254.169.254', '0.0.0.0', '100.64.0.1', 'imprimante.local', 'nas', 'intranet', 'wiki.corp', 'serveur.internal', 'box.lan', 'routeur.home.arpa', '[::1]', '[fe80::1]', '[fd00::1]', '[::ffff:127.0.0.1]', '']) {
      expect(isPublicHost(host), host).toBe(false)
    }
    // The usual ways to write the loopback address all come out as 127.0.0.1 once parsed.
    for (const address of ['http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::ffff:7f00:1]/']) {
      expect(isPublicHost(iconTarget(address)!.hostname), address).toBe(false)
    }
  })

  it('knows an item that shows an icon from one that does not', () => {
    for (const yes of ['https://exemple.fr/i.png', 'http://exemple.fr/i.png', 'data:image/png;base64,AAAA', 'HTTPS://EXEMPLE.FR/I.PNG']) expect(hasIcon(yes), yes).toBe(true)
    for (const no of ['', undefined, null, 42, 'javascript:1', 'file:///a.png', 'data:text/html,x', 'exemple.fr/i.png', {}]) expect(hasIcon(no), String(no)).toBe(false)
  })
})

describe('what is read from the page is bounded and never throws', () => {
  // A small generator with a fixed seed: the same hostile pages on every run.
  const seeded = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const PIECES = [
    '<', '>', '</', '/>', '<!--', '-->', '<!', '<?', '"', "'", '=', ' ', '\n', '\t', '\0', '&', '&amp;', '&#', ';', '<link', '<LINK ', '<base', 'rel=', 'rel="icon"', "rel='shortcut icon'", 'href=', 'href="/a.png"', 'href=javascript:alert(1)',
    'href="data:image/png;base64,AAAA"', 'sizes="32x32"', 'sizes=any', 'type="image/png"', 'media="(prefers-color-scheme: dark)"', '<script>', '</script>', '<style>', '</style>', '<title>', '</title>', '<textarea>', '<noscript>', '<plaintext>',
    'https://', 'http://', '//', '..', '%', '%00', '‮', '\ud800', 'é', '😀', 'a'.repeat(5000), ' '.repeat(300)
  ]

  it('survives pages made of random pieces of markup: no exception, every address allowed, the list bounded', () => {
    const next = seeded(20260101)
    for (let n = 0; n < 1500; n++) {
      let html = ''
      const length = 1 + Math.floor(next() * 80)
      for (let i = 0; i < length; i++) html += PIECES[Math.floor(next() * PIECES.length)]
      const page = n % 3 === 0 ? 'http://exemple.fr/' : PAGE
      const out = iconCandidates(html, page)
      expect(out.length, html.slice(0, 80)).toBeLessThanOrEqual(FAVICON_CANDIDATES_MAX)
      expect(out.length).toBeGreaterThanOrEqual(1)
      expect(new Set(out).size).toBe(out.length)
      for (const url of out) expect(iconAllowedFor(url, page), `${url} from ${html.slice(0, 80)}`).toBe(true)
      expect(out.at(-1)).toBe(new URL('/favicon.ico', page).href)
    }
  })

  it('reads a page of 64 KB of hostile markup in a few milliseconds, whatever its shape', () => {
    const shapes: Record<string, string> = {
      'lone brackets': '<'.repeat(FAVICON_HTML_MAX + 10),
      'open tags': '<link '.repeat(20000),
      'open quote': '<a "'.repeat(20000),
      'open comments': '<!--'.repeat(20000),
      'comments': '<!---->'.repeat(10000),
      'scripts': '<script>'.repeat(10000),
      'end tags': '</x'.repeat(20000),
      'a long attribute': `<link rel="icon" href="${'a'.repeat(FAVICON_HTML_MAX)}`,
      'many attributes': `<link ${'a=1 '.repeat(15000)}>`,
      'many links': '<link rel=icon href=/a.png>'.repeat(3000),
      'entities': `<link rel="icon" href="${'&amp;'.repeat(10000)}">`,
      'spaces': `<link${' '.repeat(FAVICON_HTML_MAX)}`
    }
    for (const [name, html] of Object.entries(shapes)) {
      const start = performance.now()
      const out = iconCandidates(html, PAGE)
      expect(performance.now() - start, name).toBeLessThan(500)
      expect(out.length, name).toBeGreaterThanOrEqual(1)
      expect(out.length, name).toBeLessThanOrEqual(FAVICON_CANDIDATES_MAX)
    }
  })

  it('answers with nothing but /favicon.ico for anything that is not text', () => {
    for (const html of [undefined, null, 42, {}, [], Symbol.for('x')] as unknown[]) expect(iconCandidates(html as string, PAGE)).toEqual([ICO])
  })
})

describe('what an answer must be to be kept as an icon', () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1])
  const ICON = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0])
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
  const SVG = bytes('<?xml version="1.0"?><!-- logo --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>')

  it('knows the pictures a browser shows as an icon by their first bytes', () => {
    expect(sniffImage(PNG)).toBe('png')
    expect(sniffImage(ICON)).toBe('ico')
    expect(sniffImage(bytes('GIF89a....................'))).toBe('gif')
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]))).toBe('jpeg')
    expect(sniffImage(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]))).toBe('webp')
    expect(sniffImage(SVG)).toBe('svg')
    expect(sniffImage(Uint8Array.from([0xef, 0xbb, 0xbf, ...SVG]))).toBe('svg')
    expect(sniffImage(bytes('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg></svg>'))).toBe('svg')
    for (const not of ['<!doctype html><html><body>404</body></html>', 'Not found', '{"error":"nope"}', '<html><svg></svg></html>', '']) expect(sniffImage(bytes(not)), not).toBeNull()
    // An icon file that holds no image is not one.
    expect(sniffImage(Uint8Array.from([0, 0, 1, 0, 0, 0, 0, 0]))).toBeNull()
  })

  it('accepts a picture sent as an image, or as binary data, and refuses everything the page itself should have been', () => {
    expect(acceptIcon('image/png', PNG)).toBe(true)
    expect(acceptIcon('image/x-icon', ICON)).toBe(true)
    expect(acceptIcon('image/vnd.microsoft.icon; charset=binary', ICON)).toBe(true)
    expect(acceptIcon('IMAGE/PNG', PNG)).toBe(true)
    expect(acceptIcon('application/octet-stream', PNG)).toBe(true)
    expect(acceptIcon(null, PNG)).toBe(true)
    expect(acceptIcon('', ICON)).toBe(true)
    // The usual trap: an HTML error page with a 200, announced as an image or not.
    const page = bytes('<!doctype html><html><head><title>Introuvable</title></head><body>Cette page est introuvable sur ce site.</body></html>')
    expect(acceptIcon('text/html', page)).toBe(false)
    expect(acceptIcon('image/x-icon', page)).toBe(false)
    expect(acceptIcon('image/png', page)).toBe(false)
    // A picture announced as text or as a document is not trusted either.
    expect(acceptIcon('text/html', PNG)).toBe(false)
    expect(acceptIcon('text/plain', PNG)).toBe(false)
    expect(acceptIcon('application/json', PNG)).toBe(false)
    expect(acceptIcon('application/pdf', PNG)).toBe(false)
  })

  it('shows a vector picture only when it is announced as one (the interface would draw nothing otherwise)', () => {
    expect(acceptIcon('image/svg+xml', SVG)).toBe(true)
    expect(acceptIcon('image/svg+xml; charset=utf-8', SVG)).toBe(true)
    for (const type of ['application/octet-stream', 'image/png', 'text/xml', 'text/html', '', null]) expect(acceptIcon(type, SVG), String(type)).toBe(false)
  })

  it('refuses a body that is too small to be a picture or larger than the limit', () => {
    expect(acceptIcon('image/png', PNG.subarray(0, 15))).toBe(false)
    expect(acceptIcon('image/png', new Uint8Array(0))).toBe(false)
    const atLimit = new Uint8Array(FAVICON_FILE_MAX)
    atLimit.set(PNG)
    expect(acceptIcon('image/png', atLimit)).toBe(true)
    expect(acceptIcon('image/png', new Uint8Array(FAVICON_FILE_MAX + 1).fill(0).map((_, i) => PNG[i] ?? 0))).toBe(false)
  })
})

// ---------- applying what was found ----------

function makeCtx(): Ctx {
  let n = 0
  return { now: 1_000_000, newId: () => `id${++n}` }
}

/** A state with three favourites and four tabs (one pinned) in the first space, none of them with an icon. */
function stateWithItems(): SidebarState {
  const ctx = makeCtx()
  let state = createInitialState(ctx)
  for (const [i, host] of ['a', 'b', 'c'].entries()) state = reduce(state, { type: 'favorite/add', url: `https://${host}.example/accueil`, title: `Favori ${host}`, toIndex: i }, ctx)
  for (const host of ['p', 'q', 'r', 's']) state = reduce(state, { type: 'tab/open', url: `https://${host}.example/page`, background: true }, ctx)
  state = reduce(state, { type: 'tab/pin', id: state.tabs[0]!.id }, ctx)
  return state
}

const fill = (kind: IconFill['kind'], id: string, origin: string, faviconUrl: string): IconFill => ({ kind, id, origin, faviconUrl })

describe('giving the icons that were found to the items that have none', () => {
  it('sets the icon of a favourite and of a tab through the reducer', () => {
    const state = stateWithItems()
    const [fa, fb] = state.favorites
    const tab = state.tabs[2]!
    const next = reduce(state, { type: 'favicon/fill', entries: [fill('favorite', fa!.id, 'https://a.example', 'https://a.example/icone.png'), fill('tab', tab.id, 'https://r.example', 'https://cdn.example/r.svg')] }, makeCtx())
    expect(next.favorites.map((f) => f.faviconUrl)).toEqual(['https://a.example/icone.png', undefined, undefined])
    expect(next.tabs.find((t) => t.id === tab.id)?.faviconUrl).toBe('https://cdn.example/r.svg')
    expect(next.favorites[1]).toBe(fb)
    expect(next.tabs.filter((t) => t.faviconUrl)).toHaveLength(1)
  })

  it('never gives a private tab a remote address as its icon', () => {
    const state = stateWithItems()
    const tab = state.tabs[2]!
    const withPrivate = { ...state, tabs: state.tabs.map((t) => (t.id === tab.id ? { ...t, private: true } : t)) }
    expect(fillIcons(withPrivate, [fill('tab', tab.id, 'https://r.example', 'https://cdn.example/r.svg')])).toBe(withPrivate)
    expect(fillIcons(state, [fill('tab', tab.id, 'https://r.example', 'https://cdn.example/r.svg')])).not.toBe(state)
  })

  it('never replaces an icon that is already there: the page that loaded is the source of truth', () => {
    const state = stateWithItems()
    const withOwn = { ...state, favorites: state.favorites.map((f, i) => (i === 0 ? { ...f, faviconUrl: 'https://a.example/propre.png' } : f)), tabs: state.tabs.map((t, i) => (i === 1 ? { ...t, faviconUrl: 'data:image/png;base64,AAAA' } : t)) }
    const next = reduce(withOwn, { type: 'favicon/fill', entries: [fill('favorite', withOwn.favorites[0]!.id, 'https://a.example', 'https://a.example/trouvee.png'), fill('tab', withOwn.tabs[1]!.id, 'https://q.example', 'https://q.example/trouvee.png')] }, makeCtx())
    expect(next).toBe(withOwn)
  })

  it('replaces what is not a usable icon: an address the interface cannot load is no icon', () => {
    const state = stateWithItems()
    const broken = { ...state, favorites: state.favorites.map((f, i) => (i === 0 ? { ...f, faviconUrl: 'javascript:alert(1)' } : f)) }
    const next = reduce(broken, { type: 'favicon/fill', entries: [fill('favorite', broken.favorites[0]!.id, 'https://a.example', 'https://a.example/i.png')] }, makeCtx())
    expect(next.favorites[0]!.faviconUrl).toBe('https://a.example/i.png')
  })

  it('leaves an item alone when it is no longer on the origin the icon was looked up for', () => {
    const state = stateWithItems()
    const fav = state.favorites[0]!
    expect(fillIcons(state, [fill('favorite', fav.id, 'https://autre.example', 'https://a.example/i.png')])).toBe(state)
    expect(fillIcons(state, [fill('favorite', fav.id, 'http://a.example', 'https://a.example/i.png')])).toBe(state)
    expect(fillIcons(state, [fill('favorite', fav.id, 'https://a.example:444', 'https://a.example/i.png')])).toBe(state)
    expect(fillIcons(state, [fill('favorite', fav.id, 'https://a.example', 'https://a.example/i.png')])).not.toBe(state)
  })

  it('refuses an icon that is not an address that may stand for the item', () => {
    const state = stateWithItems()
    const fav = state.favorites[0]!
    for (const icon of ['data:image/png;base64,AAAA', 'javascript:alert(1)', 'file:///etc/passwd', 'http://a.example/i.png', 'https://moi:secret@a.example/i.png', `https://a.example/${'a'.repeat(FAVICON_URL_MAX)}`, 'a.example/i.png', '']) {
      expect(fillIcons(state, [fill('favorite', fav.id, 'https://a.example', icon)]), icon).toBe(state)
    }
    // An http page may have an http icon.
    const http = reduce(createInitialState(makeCtx()), { type: 'favorite/add', url: 'http://vieux.example/', title: 'Vieux' }, makeCtx())
    expect(fillIcons(http, [fill('favorite', http.favorites[0]!.id, 'http://vieux.example', 'http://vieux.example/favicon.ico')]).favorites[0]!.faviconUrl).toBe('http://vieux.example/favicon.ico')
  })

  it('ignores an entry for an item that is gone, of a kind that does not exist, or that is not an entry', () => {
    const state = stateWithItems()
    const fav = state.favorites[0]!
    const entries: unknown[] = [
      fill('favorite', 'inconnu', 'https://a.example', 'https://a.example/i.png'),
      fill('tab', fav.id, 'https://a.example', 'https://a.example/i.png'),
      { kind: 'dossier', id: fav.id, origin: 'https://a.example', faviconUrl: 'https://a.example/i.png' },
      { kind: 'favorite', id: fav.id, origin: 'https://a.example' },
      { kind: 'favorite', id: 7, origin: 'https://a.example', faviconUrl: 'https://a.example/i.png' },
      null,
      42,
      'texte',
      []
    ]
    expect(fillIcons(state, entries)).toBe(state)
    for (const notEntries of [undefined, null, 42, 'texte', {}, { length: 1, 0: fill('favorite', fav.id, 'https://a.example', 'https://a.example/i.png') }]) expect(fillIcons(state, notEntries), String(notEntries)).toBe(state)
  })

  it('keeps the first icon given for an item, and reads no more than a thousand entries', () => {
    const state = stateWithItems()
    const fav = state.favorites[0]!
    const first = fillIcons(state, [fill('favorite', fav.id, 'https://a.example', 'https://a.example/1.png'), fill('favorite', fav.id, 'https://a.example', 'https://a.example/2.png')])
    expect(first.favorites[0]!.faviconUrl).toBe('https://a.example/1.png')
    const flood: IconFill[] = Array.from({ length: 1000 }, (_, i) => fill('favorite', `x${i}`, 'https://a.example', 'https://a.example/i.png'))
    expect(fillIcons(state, [...flood, fill('favorite', fav.id, 'https://a.example', 'https://a.example/i.png')])).toBe(state)
  })

  it('does not touch what it does not fill: the other items keep their identity', () => {
    const state = stateWithItems()
    const next = fillIcons(state, [fill('favorite', state.favorites[1]!.id, 'https://b.example', 'https://b.example/i.png')])
    expect(next.tabs).toBe(state.tabs)
    expect(next.favorites[0]).toBe(state.favorites[0])
    expect(next.favorites[2]).toBe(state.favorites[2])
    expect(fillIcons(state, [fill('tab', state.tabs[0]!.id, 'https://p.example', 'https://p.example/i.png')]).favorites).toBe(state.favorites)
  })

  it('is not an action a private window accepts', () => {
    expect(privateAction({ type: 'favicon/fill', entries: [] })).toBeNull()
  })
})

describe('which items want an icon', () => {
  function worldState() {
    const ctx = makeCtx()
    let state = createInitialState(ctx)
    const home = state.spaces[0]!.id
    state = reduce(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200 }, ctx)
    const work = state.activeSpaceId
    state = reduce(state, { type: 'space/select', id: home }, ctx)
    state = reduce(state, { type: 'favorite/add', url: 'https://fav1.example/', title: 'Un' }, ctx)
    state = reduce(state, { type: 'favorite/add', url: 'https://fav2.example/', title: 'Deux' }, ctx)
    for (const [url, spaceId] of [['https://today1.example/', home], ['https://pin1.example/', home], ['https://pin2.example/', home], ['https://today2.example/', home], ['https://elsewhere.example/', work]] as const) {
      state = reduce(state, { type: 'tab/open', url, spaceId, background: true }, ctx)
    }
    for (const t of state.tabs.filter((t) => t.url.includes('pin'))) state = reduce(state, { type: 'tab/pin', id: t.id }, ctx)
    return { state, home, work }
  }
  const byUrl = (state: SidebarState, url: string) => state.tabs.find((t) => t.url === url)!

  it('lists the favourites first, then the pinned tabs, then the tabs of Today, of the space being shown only', () => {
    const { state } = worldState()
    const jobs = iconsWanted([state], () => false)
    expect(jobs.map((j) => [j.rank, j.url])).toEqual([[0, 'https://fav1.example/'], [0, 'https://fav2.example/'], [1, 'https://pin1.example/'], [1, 'https://pin2.example/'], [2, 'https://today1.example/'], [2, 'https://today2.example/']])
    expect(jobs.map((j) => j.id.split(':')[0])).toEqual(['favorite', 'favorite', 'tab', 'tab', 'tab', 'tab'])
  })

  it('follows the space being shown: the other space comes in when it is selected', () => {
    const { state, work } = worldState()
    const shown = reduce(state, { type: 'space/select', id: work }, makeCtx())
    expect(iconsWanted([shown], () => false).map((j) => j.url)).toEqual(['https://fav1.example/', 'https://fav2.example/', 'https://elsewhere.example/'])
  })

  it('leaves out what has an icon, an emoji, or a page in memory', () => {
    const { state } = worldState()
    const withIcons = {
      ...state,
      favorites: state.favorites.map((f, i) => (i === 0 ? { ...f, faviconUrl: 'https://fav1.example/i.png' } : f)),
      tabs: state.tabs.map((t) => (t.url.startsWith('https://pin1') ? { ...t, faviconUrl: 'data:image/png;base64,AAAA' } : t.url.startsWith('https://pin2') ? { ...t, icon: '🔥' } : t))
    }
    const live = byUrl(withIcons, 'https://today1.example/').id
    expect(iconsWanted([withIcons], (id) => id === live).map((j) => j.url)).toEqual(['https://fav2.example/', 'https://today2.example/'])
  })

  // The lookup would ask the site of a private tab again, and the interface would load the icon through its own session, whose
  // disk cache keeps the host after the private session is gone.
  it('leaves out a private tab of a normal window, sleeping or not', () => {
    const { state } = worldState()
    const withPrivate = { ...state, tabs: state.tabs.map((t) => (t.url.startsWith('https://pin1') || t.url.startsWith('https://today2') ? { ...t, private: true } : t)) }
    expect(iconsWanted([withPrivate], () => false).map((j) => j.url)).toEqual(['https://fav1.example/', 'https://fav2.example/', 'https://pin2.example/', 'https://today1.example/'])
  })

  it('leaves out what is not a web page, and a home page that is blank', () => {
    const { state } = worldState()
    const odd = { ...state, favorites: [{ id: 'f1', url: 'file:///etc/hosts', title: 'x' }, { id: 'f2', url: 'about:blank', title: 'y' }, { id: 'f3', url: 'https://ok.example/', title: 'z' }], tabs: state.tabs.map((t) => ({ ...t, url: t.url.startsWith('https://today') ? 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/p.html' : t.url })) }
    expect(iconsWanted([odd], () => false).map((j) => j.url)).toEqual(['https://ok.example/', 'https://pin1.example/', 'https://pin2.example/'])
  })

  it('joins the spaces shown by several windows without asking twice for a tab', () => {
    const { state, work } = worldState()
    const second = reduce(state, { type: 'space/select', id: work }, makeCtx())
    const jobs = iconsWanted([state, second], () => false)
    expect(jobs.map((j) => j.url)).toEqual(['https://fav1.example/', 'https://fav2.example/', 'https://pin1.example/', 'https://pin2.example/', 'https://today1.example/', 'https://today2.example/', 'https://elsewhere.example/'])
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length)
    // Two windows on the same space show the same tabs: each is asked for once.
    expect(iconsWanted([state, state], () => false)).toEqual(iconsWanted([state], () => false))
    expect(iconsWanted([], () => false)).toEqual([])
  })
})
