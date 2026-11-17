// What a local page opened in a tab may load from the disk (the fuse grantFileProtocolExtraPrivileges stays on, so the refusal of Chrome
// is made by the hook of the sessions of pages). The engine check of the same rule, in Electron: src/main/smoke-runtime.ts ("a local page reads nothing else of the disk").

import { describe, expect, it, vi } from 'vitest'
import { answerLocalFile, isWideFolder, localFileVerdict, localPageRead, localPathSegments, PendingReads, REFUSED_READ, sharedWithLocalPage, stillInside } from './local-file-guard'

// The rule is judged as macOS writes the paths whatever the machine of the run (a Windows runner included): the Windows cases name 'win32'.
const HOME = '/Users/me'
const PAGE = 'file:///Users/me/Sites/demo/index.html'
const verdict = (url: string, resourceType: string, topUrl: string | null = PAGE) => localFileVerdict({ url, resourceType, topUrl }, HOME, 'darwin')
const WINDOWS_HOME = 'C:\\Users\\me'
const WINDOWS_PAGE = 'file:///C:/Users/me/Sites/demo/index.html'
const onWindowsDisk = (url: string, resourceType: string, topUrl: string | null = WINDOWS_PAGE) => localFileVerdict({ url, resourceType, topUrl }, WINDOWS_HOME, 'win32')

describe('the requests a local page makes for files of the disk', () => {
  it('refuses a fetch or an XMLHttpRequest for any other file, the private files of the user first', () => {
    for (const target of ['file:///Users/me/.ssh/id_ed25519', 'file:///Users/me/Library/Application%20Support/Lucium/state.json', 'file:///Users/me/Sites/demo/data.json', 'file:///etc/hosts']) {
      expect(verdict(target, 'xhr')).toEqual({ allow: false })
    }
  })

  it('refuses a frame or an object of another file, whose text the page could read, but not of a PDF beside it', () => {
    expect(verdict('file:///Users/me/.ssh/id_ed25519', 'subFrame')).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Sites/demo/other.html', 'subFrame')).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Sites/demo/notes.txt', 'object')).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Sites/demo/guide.pdf', 'subFrame')).toEqual({ allow: true, confine: { file: '/Users/me/Sites/demo/guide.pdf', root: '/Users/me/Sites/demo' } })
  })

  it('lets the page show what lies in its folder: images, styles, scripts, fonts and media, by their extension', () => {
    expect(verdict('file:///Users/me/Sites/demo/style.css', 'stylesheet')).toEqual({ allow: true, confine: { file: '/Users/me/Sites/demo/style.css', root: '/Users/me/Sites/demo' } })
    expect(verdict('file:///Users/me/Sites/demo/img/Photo%201.JPG', 'image')).toEqual({ allow: true, confine: { file: '/Users/me/Sites/demo/img/Photo 1.JPG', root: '/Users/me/Sites/demo' } })
    for (const [url, type] of [['app.js', 'script'], ['font.woff2', 'font'], ['clip.mp4', 'media'], ['logo.svg', 'image']] as const) {
      expect(verdict(`file:///Users/me/Sites/demo/${url}`, type).allow).toBe(true)
    }
  })

  it('refuses a JSON or text module, which Chromium reports as a script, and a file whose extension does not match the kind', () => {
    expect(verdict('file:///Users/me/Sites/demo/data.json', 'script')).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Sites/demo/secret', 'script')).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Sites/demo/notes.txt', 'stylesheet')).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Sites/demo/style.css', 'other')).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Sites/demo/style.css', 'ping')).toEqual({ allow: false })
  })

  it('refuses what is outside the folder of the page, hidden, or written to climb out of it', () => {
    expect(verdict('file:///Users/me/Pictures/me.jpg', 'image')).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Sites/other/me.jpg', 'image')).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Sites/demo/.git/logo.png', 'image')).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Sites/demo/..%2F..%2FPictures%2Fme.jpg', 'image')).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Sites/demo/%2e%2e/%2e%2e/Pictures/me.jpg', 'image')).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Sites/demo/a%00.png', 'image')).toEqual({ allow: false })
    expect(verdict('file://server/share/demo/logo.png', 'image', 'file://server/share/demo/index.html')).toEqual({ allow: false })
  })

  it('gives a page lying directly in a wide folder only the folder its browser saved beside it', () => {
    const saved = 'file:///Users/me/Downloads/Ma%20page.html'
    expect(verdict('file:///Users/me/Downloads/Ma%20page_files/logo.png', 'image', saved)).toEqual({ allow: true, confine: { file: '/Users/me/Downloads/Ma page_files/logo.png', root: '/Users/me/Downloads/Ma page_files' } })
    expect(verdict('file:///Users/me/Downloads/scan-passeport.jpg', 'image', saved)).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Downloads/Vacances/photo.jpg', 'image', saved)).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Pictures/photo.jpg', 'image', 'file:///Users/me/page.html')).toEqual({ allow: false })
    expect(verdict('file:///tmp/photo.jpg', 'image', 'file:///tmp/page.html')).toEqual({ allow: false })
  })

  it('lets the document itself through: its navigation, and the PDF viewer reading the file it shows', () => {
    expect(verdict('file:///Users/me/Sites/demo/index.html', 'mainFrame', 'https://example.com/')).toEqual({ allow: true })
    expect(verdict('file:///Users/me/Downloads/guide.pdf', 'other', 'file:///Users/me/Downloads/guide.pdf#page=2')).toEqual({ allow: true })
    expect(verdict('file:///Users/me/Downloads/guide.pdf', 'subFrame', 'file:///Users/me/Downloads/guide.pdf')).toEqual({ allow: true })
  })

  it('refuses every file a page that is not local asks for, and a request no page makes', () => {
    expect(verdict('file:///Users/me/Sites/demo/logo.png', 'image', 'https://example.com/')).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Sites/demo/logo.png', 'image', 'about:blank')).toEqual({ allow: false })
    expect(verdict('file:///Users/me/Sites/demo/logo.png', 'image', null)).toEqual({ allow: false })
  })

  it('writes the path of a file of Windows with its drive and its backslashes, the one the links are followed from', () => {
    expect(onWindowsDisk('file:///C:/Users/me/Sites/demo/img/Photo%201.JPG', 'image')).toEqual({ allow: true, confine: { file: 'C:\\Users\\me\\Sites\\demo\\img\\Photo 1.JPG', root: 'C:\\Users\\me\\Sites\\demo' } })
    expect(onWindowsDisk('file:///C:/Users/me/Sites/demo/data.json', 'xhr')).toEqual({ allow: false })
    expect(onWindowsDisk('file:///C:/Users/me/Sites/other/me.jpg', 'image')).toEqual({ allow: false })
  })

  it('judges a page lying in a wide folder of Windows as it does on the Mac: only the folder its browser saved beside it', () => {
    const saved = 'file:///C:/Users/me/Downloads/Ma%20page.html'
    expect(onWindowsDisk('file:///C:/Users/me/Downloads/Ma%20page_files/logo.png', 'image', saved)).toEqual({
      allow: true,
      confine: { file: 'C:\\Users\\me\\Downloads\\Ma page_files\\logo.png', root: 'C:\\Users\\me\\Downloads\\Ma page_files' }
    })
    expect(onWindowsDisk('file:///C:/Users/me/Downloads/scan-passeport.jpg', 'image', saved)).toEqual({ allow: false })
    expect(onWindowsDisk('file:///C:/logo.png', 'image', 'file:///C:/page.html')).toEqual({ allow: false })
  })

  it('refuses an address of Windows that names no drive: the path it would give is relative to the current drive', () => {
    expect(onWindowsDisk('file:///Users/me/Sites/demo/logo.png', 'image', 'file:///Users/me/Sites/demo/index.html')).toEqual({ allow: false })
  })
})

describe('the folders and paths the rule reads', () => {
  it('decodes the segments of a local address and refuses one that hides a separator', () => {
    expect(localPathSegments('file:///Users/me/a%20b/c.html')).toEqual(['Users', 'me', 'a b', 'c.html'])
    expect(localPathSegments('file:///a/b%5Cc')).toBeNull()
    expect(localPathSegments('https://example.com/a')).toBeNull()
    expect(localPathSegments('not a url')).toBeNull()
    expect(localPathSegments('file:///a/%E0%A4%A')).toBeNull()
  })

  it('takes the root, its folders, the home folder and its folders for wide ones', () => {
    const home = ['Users', 'me']
    expect(isWideFolder([], home)).toBe(true)
    expect(isWideFolder(['tmp'], home)).toBe(true)
    expect(isWideFolder(['Volumes', 'Clé'], home)).toBe(true)
    expect(isWideFolder(['Users', 'me'], home)).toBe(true)
    expect(isWideFolder(['Users', 'me', 'Downloads'], home)).toBe(true)
    expect(isWideFolder(['Users', 'me', 'Downloads', 'site'], home)).toBe(false)
    expect(isWideFolder(['Volumes', 'Clé', 'site'], home)).toBe(false)
  })
})

describe('the links of the folder', () => {
  it('lets a file through only if its real path is still inside the folder', async () => {
    const real: Record<string, string> = { '/Users/me/Sites/demo': '/Users/me/Sites/demo', '/Users/me/Sites/demo/logo.png': '/Users/me/Sites/demo/logo.png', '/Users/me/Sites/demo/link.png': '/Users/me/Pictures/me.png', '/Users/me/Sites/demo/hidden.png': '/Users/me/Sites/demo/.cache/x.png' }
    const resolve = async (path: string) => {
      const found = real[path]
      if (found === undefined) throw new Error('ENOENT')
      return found
    }
    const root = '/Users/me/Sites/demo'
    expect(await stillInside({ file: '/Users/me/Sites/demo/logo.png', root }, resolve, 'darwin')).toBe(true)
    expect(await stillInside({ file: '/Users/me/Sites/demo/link.png', root }, resolve, 'darwin')).toBe(false)
    expect(await stillInside({ file: '/Users/me/Sites/demo/hidden.png', root }, resolve, 'darwin')).toBe(false)
    expect(await stillInside({ file: '/Users/me/Sites/demo/missing.png', root }, resolve, 'darwin')).toBe(false)
  })

  it('follows the links of a Windows disk the same way: the real path is still inside the folder, written with backslashes', async () => {
    const root = 'C:\\Users\\me\\Sites\\demo'
    const real: Record<string, string> = { [root]: root, [`${root}\\logo.png`]: `${root}\\logo.png`, [`${root}\\link.png`]: 'C:\\Users\\me\\Pictures\\me.png', [`${root}\\hidden.png`]: `${root}\\.cache\\x.png` }
    const resolve = async (path: string) => real[path] ?? Promise.reject(new Error('ENOENT'))
    expect(await stillInside({ file: `${root}\\logo.png`, root }, resolve, 'win32')).toBe(true)
    expect(await stillInside({ file: `${root}\\link.png`, root }, resolve, 'win32')).toBe(false)
    expect(await stillInside({ file: `${root}\\hidden.png`, root }, resolve, 'win32')).toBe(false)
    expect(await stillInside({ file: `${root}\\missing.png`, root }, resolve, 'win32')).toBe(false)
  })

  it('answers the hook exactly once: refused at once, let through, or once the link is followed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refused = vi.fn()
    answerLocalFile({ url: 'file:///Users/me/.ssh/id_ed25519', resourceType: 'xhr', topUrl: PAGE }, HOME, refused, undefined, 'darwin')
    expect(refused).toHaveBeenCalledExactlyOnceWith({ cancel: true })
    expect(warn).toHaveBeenCalledWith('[engine] refused a xhr request of a page for a local file')

    const opened = vi.fn()
    answerLocalFile({ url: PAGE, resourceType: 'mainFrame', topUrl: null }, HOME, opened, undefined, 'darwin')
    expect(opened).toHaveBeenCalledExactlyOnceWith({ cancel: false })

    const linked = vi.fn()
    answerLocalFile({ url: 'file:///Users/me/Sites/demo/link.png', resourceType: 'image', topUrl: PAGE }, HOME, linked, async (path) => (path.endsWith('link.png') ? '/Users/me/Pictures/me.png' : path), 'darwin')
    await vi.waitFor(() => expect(linked).toHaveBeenCalledExactlyOnceWith({ cancel: true }))
    warn.mockRestore()
  })
})

describe('what a local page asks the web to read', () => {
  const LOCAL = 'file:///Users/me/Downloads/page.html'
  const SECRET = 'http://127.0.0.1:8384/rest/config'
  /** A request as Chromium sends it: it names the way it was made (`Sec-Fetch-Mode`). */
  const ask = (over: Partial<Parameters<typeof localPageRead>[0]> & { mode?: string | null } = {}) => {
    const { mode = 'cors', ...rest } = over
    return localPageRead({ url: SECRET, resourceType: 'xhr', frameOrigin: 'file://', topUrl: LOCAL, requestHeaders: mode === null ? {} : { 'Sec-Fetch-Mode': mode }, ...rest })
  }

  it('is a read to judge: fetch, XMLHttpRequest, a module, a font or an image asked for with `crossorigin`', () => {
    expect(ask()).toEqual({ credentials: false })
    for (const resourceType of ['xhr', 'script', 'font', 'image', 'other']) expect(ask({ resourceType }), resourceType).toEqual({ credentials: false })
    expect(ask({ url: 'https://api.example/me' })).toEqual({ credentials: false })
  })

  it('notes what identifies the user to the server: cookies, an HTTP login, whatever the case of the header', () => {
    expect(ask({ requestHeaders: { 'sec-fetch-mode': 'cors', Cookie: 'sid=1' } })).toEqual({ credentials: true })
    expect(ask({ requestHeaders: { 'Sec-Fetch-Mode': 'cors', authorization: 'Basic placeholder' } })).toEqual({ credentials: true })
  })

  it('is not judged when the page only shows the answer: an image, a style sheet, a classic script, media (a page saved from the web)', () => {
    for (const resourceType of ['image', 'stylesheet', 'script', 'media']) expect(ask({ resourceType, mode: 'no-cors' }), resourceType).toBeNull()
  })

  it('is judged whatever way the page says it asks: a fetch in the mode `same-origin` or `no-cors` is a read like the others', () => {
    // With universal access the page gets the answer in each of these modes, and it chooses the mode itself.
    for (const mode of ['cors', 'same-origin', 'no-cors', 'SAME-ORIGIN', 'a-mode-of-tomorrow']) expect(ask({ mode }), mode).toEqual({ credentials: false })
    expect(ask({ requestHeaders: { 'Sec-Fetch-Mode': 'same-origin', Cookie: 'sid=1' } })).toEqual({ credentials: true })
    // The script of a worker and a text track are asked for in the mode `same-origin`; a beacon and what has no kind of its own in `no-cors`.
    for (const resourceType of ['script', 'other', 'media', 'image', 'stylesheet']) expect(ask({ resourceType, mode: 'same-origin' }), resourceType).toEqual({ credentials: false })
    for (const resourceType of ['xhr', 'other', 'ping', 'font', 'object']) expect(ask({ resourceType, mode: 'no-cors' }), resourceType).toEqual({ credentials: false })
  })

  it('is not judged for the handshake of a websocket, which no fetch can name', () => {
    expect(ask({ resourceType: 'webSocket', mode: 'websocket' })).toBeNull()
  })

  it('is refused outright when a local file asks with neither frame nor page behind it: a shared worker of a local page', () => {
    const worker = { frameOrigin: null, topUrl: null }
    for (const mode of ['cors', 'same-origin', 'no-cors', null]) expect(ask({ ...worker, initiatorOrigin: 'file://', mode }), String(mode)).toBe(REFUSED_READ)
    expect(ask({ ...worker, initiatorOrigin: 'FILE://', resourceType: 'script' })).toBe(REFUSED_READ)
    // The worker of a site, and what the browser asks by itself, are no business of this guard.
    expect(ask({ ...worker, initiatorOrigin: 'https://site.example' })).toBeNull()
    expect(ask({ ...worker, initiatorOrigin: 'null' })).toBeNull()
    expect(ask({ ...worker })).toBeNull()
    // With a page behind it, the request is judged on its answer as before, not refused.
    expect(ask({ frameOrigin: null, initiatorOrigin: 'file://' })).toEqual({ credentials: false })
  })

  it('is not judged for a navigation: the tab going to a site, a frame of a site in the page', () => {
    expect(ask({ resourceType: 'mainFrame', mode: 'navigate' })).toBeNull()
    expect(ask({ resourceType: 'subFrame', mode: 'navigate' })).toBeNull()
    expect(ask({ resourceType: 'subFrame', mode: 'cors' })).toBeNull()
    expect(ask({ resourceType: 'object', mode: 'navigate' })).toBeNull()
  })

  it('is not judged for a document of the web: a page of a site, and a frame of a site inside a local page', () => {
    expect(ask({ frameOrigin: 'https://site.example', topUrl: 'https://site.example/' })).toBeNull()
    expect(ask({ frameOrigin: 'https://player.example', topUrl: LOCAL })).toBeNull()
    expect(ask({ frameOrigin: null, topUrl: 'https://site.example/' })).toBeNull()
    expect(ask({ frameOrigin: null, topUrl: null })).toBeNull()
  })

  it('is judged on the top document when the request names no frame (a worker of a local page)', () => {
    expect(ask({ frameOrigin: null })).toEqual({ credentials: false })
  })

  it('is judged by its kind when the request does not say how it was made: fetch, XMLHttpRequest and fonts are read by the page', () => {
    expect(ask({ mode: null })).toEqual({ credentials: false })
    expect(ask({ mode: null, resourceType: 'font' })).toEqual({ credentials: false })
    expect(ask({ mode: null, resourceType: 'image' })).toBeNull()
    expect(ask({ mode: null, resourceType: 'script' })).toBeNull()
  })

  it('is nothing for an address that is not of the web', () => {
    expect(ask({ url: 'file:///Users/me/.ssh/id_ed25519' })).toBeNull()
    expect(ask({ url: 'ws://127.0.0.1:9/' })).toBeNull()
  })
})

describe('whether a server shares its answer with a local page', () => {
  const plain = { credentials: false }
  const signedIn = { credentials: true }

  it('does not, when the answer says nothing: the case of a service of the machine, of a router, of a site the user is signed in to', () => {
    expect(sharedWithLocalPage(plain, undefined)).toBe(false)
    expect(sharedWithLocalPage(plain, {})).toBe(false)
    expect(sharedWithLocalPage(plain, { 'Content-Type': ['text/plain'] })).toBe(false)
  })

  it('does, for a request that carries nothing of the user, when the server shares with everyone or with the origin "null"', () => {
    expect(sharedWithLocalPage(plain, { 'Access-Control-Allow-Origin': ['*'] })).toBe(true)
    expect(sharedWithLocalPage(plain, { 'access-control-allow-origin': 'null' })).toBe(true)
  })

  it('does not, when the server shares with a site: a local page is no site', () => {
    expect(sharedWithLocalPage(plain, { 'Access-Control-Allow-Origin': ['https://site.example'] })).toBe(false)
    expect(sharedWithLocalPage(plain, { 'Access-Control-Allow-Origin': ['file://'] })).toBe(false)
    expect(sharedWithLocalPage(plain, { 'Access-Control-Allow-Origin': ['*', 'https://site.example'] })).toBe(false)
  })

  it('asks more of a request that carries cookies or a login: the origin "null" by name, and the credentials allowed', () => {
    expect(sharedWithLocalPage(signedIn, { 'Access-Control-Allow-Origin': ['*'] })).toBe(false)
    expect(sharedWithLocalPage(signedIn, { 'Access-Control-Allow-Origin': ['null'] })).toBe(false)
    expect(sharedWithLocalPage(signedIn, { 'Access-Control-Allow-Origin': ['null'], 'Access-Control-Allow-Credentials': ['false'] })).toBe(false)
    expect(sharedWithLocalPage(signedIn, { 'Access-Control-Allow-Origin': ['null'], 'Access-Control-Allow-Credentials': ['true'] })).toBe(true)
  })
})

describe('the reads of local pages that wait for their answer', () => {
  it('hands a read back once, when its answer comes', () => {
    const reads = new PendingReads()
    expect(reads.note(7, { credentials: true }, 0)).toBe(true)
    expect(reads.take(7)).toEqual({ credentials: true })
    expect(reads.take(7)).toBeUndefined()
    expect(reads.take(8)).toBeUndefined()
  })

  it('forgets a request that is no read any more (a redirect judged again)', () => {
    const reads = new PendingReads()
    reads.note(7, { credentials: false }, 0)
    reads.forget(7)
    expect(reads.take(7)).toBeUndefined()
  })

  it('refuses a new read when it is full, rather than forget one that waits: a flood cannot push a read out', () => {
    const reads = new PendingReads(2, 1000)
    expect(reads.note(1, { credentials: false }, 0)).toBe(true)
    expect(reads.note(2, { credentials: false }, 10)).toBe(true)
    expect(reads.note(3, { credentials: false }, 20)).toBe(false)
    expect(reads.take(1)).toEqual({ credentials: false })
    expect(reads.take(3)).toBeUndefined()
    // The same request noted again takes no second place.
    expect(reads.note(2, { credentials: true }, 30)).toBe(true)
    expect(reads.take(2)).toEqual({ credentials: true })
  })

  it('makes room by dropping the reads that never got an answer, once they are stale', () => {
    const reads = new PendingReads(2, 1000)
    reads.note(1, { credentials: false }, 0)
    reads.note(2, { credentials: false }, 900)
    expect(reads.note(3, { credentials: false }, 1500)).toBe(true)
    expect(reads.take(1)).toBeUndefined()
    expect(reads.take(2)).toEqual({ credentials: false })
    expect(reads.take(3)).toEqual({ credentials: false })
  })
})
