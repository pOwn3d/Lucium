import { describe, expect, it } from 'vitest'
import { isNavigableUrl } from './url'
import { LOCAL_FILES_MAX, LOCAL_PATH_MAX, localFileUrl, localFileUrls } from './local-documents'

describe('localFileUrl', () => {
  it('gives the file address of a page, a document, a picture, a text, a sound or a video', () => {
    expect(localFileUrl('/Users/jane/Documents/maquette/v1.html')).toBe('file:///Users/jane/Documents/maquette/v1.html')
    for (const name of ['a.htm', 'a.xhtml', 'a.xht', 'a.pdf', 'a.svg', 'a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.avif', 'a.txt', 'a.md', 'a.json', 'a.mp4', 'a.webm', 'a.mp3', 'a.wav']) {
      expect(localFileUrl(`/tmp/${name}`), name).toBe(`file:///tmp/${name}`)
    }
  })

  it('reads the type whatever its case, and from the last dot only', () => {
    expect(localFileUrl('/tmp/PAGE.HTML')).toBe('file:///tmp/PAGE.HTML')
    expect(localFileUrl('/tmp/archive.tar.html')).toBe('file:///tmp/archive.tar.html')
    expect(localFileUrl('/tmp/page.html.zip')).toBeNull()
  })

  it('keeps a space, an accent, a # and a ? in the name instead of letting them cut the address', () => {
    expect(localFileUrl('/tmp/ma page #1?.html')).toBe('file:///tmp/ma%20page%20%231%3F.html')
    expect(localFileUrl('/tmp/été/é.html')).toBe('file:///tmp/%C3%A9t%C3%A9/%C3%A9.html')
    expect(new URL(localFileUrl('/tmp/ma page #1?.html') as string).pathname).toBe('/tmp/ma%20page%20%231%3F.html')
  })

  it('gives an address a tab may open', () => {
    expect(isNavigableUrl(localFileUrl('/tmp/a.html') as string)).toBe(true)
  })

  it('refuses a type a tab would download instead of showing', () => {
    for (const name of ['setup.dmg', 'run.command', 'app.zip', 'script.sh', 'Safari.app', 'a.exe', 'a.js', 'a.html5', 'html', '.html', 'noextension']) {
      expect(localFileUrl(`/tmp/${name}`), name).toBeNull()
    }
  })

  it('refuses what is not an absolute path of a file: a relative path, an address, an empty text, a NUL, a path too long, a value that is not a text', () => {
    for (const path of ['a.html', './a.html', '../a.html', 'file:///tmp/a.html', 'https://example.com/a.html', '', '/tmp/a\0.html']) {
      expect(localFileUrl(path), JSON.stringify(path)).toBeNull()
    }
    expect(localFileUrl(`/${'a'.repeat(LOCAL_PATH_MAX)}.html`)).toBeNull()
    for (const value of [undefined, null, 1, {}, ['/tmp/a.html']]) expect(localFileUrl(value)).toBeNull()
  })
})

describe('localFileUrls', () => {
  it('lists the addresses of the files that open, in order, and counts the others', () => {
    expect(localFileUrls(['/tmp/a.html', '/tmp/b.dmg', '/tmp/c.pdf', 'relative.html'])).toEqual({ urls: ['file:///tmp/a.html', 'file:///tmp/c.pdf'], refused: 2 })
  })

  it('opens no more than the ceiling and counts the rest as left out', () => {
    const paths = Array.from({ length: LOCAL_FILES_MAX + 3 }, (_, i) => `/tmp/${i}.html`)
    const { urls, refused } = localFileUrls(paths)
    expect(urls).toHaveLength(LOCAL_FILES_MAX)
    expect(urls[0]).toBe('file:///tmp/0.html')
    expect(refused).toBe(3)
  })

  it('looks at a huge list only as far as it could open, and still counts all of it', () => {
    const { urls, refused } = localFileUrls(Array.from({ length: 100_000 }, (_, i) => `/tmp/${i}.html`))
    expect(urls).toHaveLength(LOCAL_FILES_MAX)
    expect(refused).toBe(100_000 - LOCAL_FILES_MAX)
  })

  it('opens nothing for a value that is not a list', () => {
    for (const value of [undefined, null, '/tmp/a.html', 3, { 0: '/tmp/a.html', length: 1 }]) expect(localFileUrls(value)).toEqual({ urls: [], refused: 0 })
  })

  it('leaves out the entries that are not texts, without failing', () => {
    expect(localFileUrls([null, 3, {}, '/tmp/a.html'])).toEqual({ urls: ['file:///tmp/a.html'], refused: 3 })
  })
})
