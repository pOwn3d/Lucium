// The interface asks no site for a picture. The icon of a tab, a favourite, a bookmark or a page read later is drawn from the copy the main
// process downloaded in the profile of the tab (shared/site-icon.ts, main/engine/site-icons.ts): the pages of the interface may not load a
// picture of the web at all, and every component that draws an icon of the state goes through `iconSource`.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ICON_SCHEME, iconSource } from '@shared/site-icon'
import { Favicon } from './SidebarRows'

const HERE = __dirname

const sourcesOf = (dir: string): Array<{ file: string; text: string }> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourcesOf(path)
    return entry.name.endsWith('.tsx') ? [{ file: path.slice(HERE.length + 1), text: readFileSync(path, 'utf8') }] : []
  })

/** Where a page may load a picture from: its `img-src`, or its `default-src` when it names none. */
const imageSources = (html: string): string[] => {
  const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
  const policy = content.split(';').map((part) => part.trim().split(/\s+/))
  return (policy.find((words) => words[0] === 'img-src') ?? policy.find((words) => words[0] === 'default-src'))?.slice(1) ?? []
}

describe('the pages of the interface', () => {
  const pages = readdirSync(HERE).filter((file) => file.endsWith('.html'))

  it('are all read', () => {
    expect(pages.length).toBeGreaterThanOrEqual(11)
  })

  for (const page of pages) {
    it(`${page} may load no picture from a web address`, () => {
      const sources = imageSources(readFileSync(join(HERE, page), 'utf8'))
      expect(sources).toContain("'self'")
      for (const refused of ['http:', 'https:', '*', 'ws:', 'wss:']) expect(sources, refused).not.toContain(refused)
      expect(sources.filter((source) => /^https?:\/\//.test(source))).toEqual([])
    })
  }

  // The window, the layer of the command bar and the mini window are the three that draw icons of sites.
  for (const page of ['index.html', 'overlay.html', 'littlearc.html']) {
    it(`${page} may draw the copies the main process keeps of the icons`, () => {
      expect(imageSources(readFileSync(join(HERE, page), 'utf8'))).toContain(`${ICON_SCHEME}:`)
    })
  }
})

describe('the components that draw an icon of the state', () => {
  const sources = sourcesOf(HERE)

  it('never give an <img> the address the state holds: it goes through iconSource', () => {
    // Every <img> whose source is read from something called an icon. Left out: the pictures the application comes with (ICON_PICTURES), the icon of an
    // extension served by the extension library (crx:), and the picture of an extension, which is data its package holds (extension-review.ts,
    // extension-page.ts), never an address.
    const direct = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/<img\b[^>]*?\bsrc=\{([^}]*)\}/g)]
        .filter((match) => /favicon|\bicon\b/i.test(match[1]!) && !/iconSource\(|ICON_PICTURES|^`crx:\/\//.test(match[1]!))
        .map((match) => `${file}: src={${match[1]}}`)
    )
    expect(direct.filter((line) => !/^(ExtensionReview|ExtensionsPage)\.tsx: /.test(line))).toEqual([])
  })

  it('are the eight that did, each drawing what iconSource gives', () => {
    const using = sources.filter(({ text }) => /iconSource\(/.test(text)).map(({ file }) => file).sort()
    expect(using).toEqual(['Bookmarks.tsx', 'CommandBar.tsx', 'Panels.tsx', 'ReadLater.tsx', 'SidebarRows.tsx', 'TabCycle.tsx', 'TabGrid.tsx', 'TabSearch.tsx', 'littlearc.tsx'])
  })
})

describe('the icon of a row of the sidebar', () => {
  const drawn = (faviconUrl: string | undefined): string => renderToStaticMarkup(createElement(Favicon, { tab: { url: 'https://exemple.fr/page', title: 'Exemple', ...(faviconUrl !== undefined ? { faviconUrl } : {}) } }))

  it('is asked of the main process by the address the page declared, never of the site', () => {
    const markup = drawn('https://cdn.exemple.fr/favicon.png?v=3')
    expect(markup).toContain(`src="${iconSource('https://cdn.exemple.fr/favicon.png?v=3')}"`)
    expect(markup).not.toMatch(/src="https?:/)
  })

  it('is the picture itself for a private tab, whose session handed it over as data', () => {
    expect(drawn('data:image/png;base64,AAAA')).toContain('src="data:image/png;base64,AAAA"')
  })

  it('is the letter of the site when the state holds something that is neither', () => {
    for (const odd of ['file:///Users/me/secret.png', 'javascript:alert(1)', undefined]) {
      const markup = drawn(odd)
      expect(markup).not.toContain('<img')
      expect(markup).toContain('monogram')
    }
  })
})
