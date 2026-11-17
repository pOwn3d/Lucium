import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DRAG_FAVORITE_TYPE, DRAG_FOLDER_TYPE, DRAG_TYPE } from '../renderer/sidebar-dnd'
import { INTERNAL_DRAG_PREFIX, carriesFiles, isAppUrl, isFromSurface, isMainFrameSender, rendererDevUrl, sourceForView, shouldBlockDrag, type AppRoots } from './surface-guard'

const packaged: AppRoots = { devUrl: null, fileRoot: 'file:///Applications/Lucium.app/Contents/Resources/app.asar/out/renderer/' }
const dev: AppRoots = { devUrl: 'http://localhost:5173', fileRoot: 'file:///work/lucium/out/renderer/' }

describe('isAppUrl', () => {
  it('accepts the built pages of the application, with their query and hash', () => {
    for (const page of ['index', 'overlay', 'settings', 'littlearc', 'taskmanager', 'about']) {
      expect(isAppUrl(`${packaged.fileRoot}${page}.html`, packaged)).toBe(true)
    }
    expect(isAppUrl(`${packaged.fileRoot}index.html?private=1#float`, packaged)).toBe(true)
  })

  it('refuses what is in the folder of the pages and is not a page: a script, a style sheet, a source map, a folder', () => {
    for (const file of ['assets/index-abc123.js', 'assets/index-abc123.js.map', 'assets/index-abc123.css', 'index.js', 'index.html.map', 'assets/', '', 'assets/index.html', 'index.html/x', '.html']) {
      expect(isAppUrl(`${packaged.fileRoot}${file}`, packaged), file).toBe(false)
    }
  })

  it('refuses a remote page, whatever its scheme', () => {
    for (const url of ['https://example.com/', 'http://localhost:5173/index.html', 'data:text/html,<p>x</p>', 'javascript:alert(1)', 'about:blank', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/a.html', 'blob:null/1', 'not a url', '']) {
      expect(isAppUrl(url, packaged), url).toBe(false)
    }
  })

  it('refuses another local file, including one that climbs out of the folder of the pages', () => {
    for (const url of [
      'file:///etc/hosts',
      'file:///Applications/Lucium.app/Contents/Resources/app.asar/out/main/index.js',
      `${packaged.fileRoot}../main/index.js`,
      `${packaged.fileRoot}%2e%2e/main/index.js`,
      `${packaged.fileRoot}..%2fmain%2findex.js`,
      'file://evil-host/Applications/Lucium.app/Contents/Resources/app.asar/out/renderer/index.html',
      // A sibling folder that merely starts with the same letters.
      'file:///Applications/Lucium.app/Contents/Resources/app.asar/out/renderer-evil/index.html'
    ]) {
      expect(isAppUrl(url, packaged), url).toBe(false)
    }
  })

  it('takes the dev server only when one is given (never in a packaged application)', () => {
    expect(isAppUrl('http://localhost:5173/index.html?x=1', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5174/index.html', dev)).toBe(false)
    expect(isAppUrl('https://localhost:5173/index.html', dev)).toBe(false)
    expect(isAppUrl('http://localhost:5173/index.html', packaged)).toBe(false)
    expect(isAppUrl(`${dev.fileRoot}index.html`, dev)).toBe(true)
  })
})

describe('rendererDevUrl', () => {
  it('follows ELECTRON_RENDERER_URL while developing', () => {
    expect(rendererDevUrl('http://localhost:5173', false)).toBe('http://localhost:5173')
    expect(rendererDevUrl(undefined, false)).toBeNull()
    expect(rendererDevUrl('', false)).toBeNull()
  })

  it('ignores it in a packaged application, whatever the environment says', () => {
    expect(rendererDevUrl('https://evil.example/', true)).toBeNull()
  })
})

describe('isFromSurface', () => {
  const main = { id: 'main' }
  const window = { isDestroyed: () => false, webContents: { id: 12 } }
  const fromMain = { senderFrame: main, sender: { id: 12, mainFrame: main } }

  it('hears the top frame of the page of the window', () => {
    expect(isFromSurface(fromMain, window)).toBe(true)
  })

  it('does not hear a frame inside that page', () => {
    expect(isFromSurface({ senderFrame: { id: 'child' }, sender: { id: 12, mainFrame: main } }, window)).toBe(false)
  })

  it('does not hear another page, a window that is gone, or no window', () => {
    expect(isFromSurface({ senderFrame: main, sender: { id: 13, mainFrame: main } }, window)).toBe(false)
    expect(isFromSurface(fromMain, { isDestroyed: () => true, webContents: { id: 12 } })).toBe(false)
    expect(isFromSurface(fromMain, null)).toBe(false)
  })

  it('is what the bar of the annotation, the two windows of a share and the media bridge are heard through', () => {
    const read = (file: string): string => readFileSync(join(__dirname, '..', 'main', file), 'utf8')
    expect(read('shell/page-annotate.ts')).toMatch(/private fromCommand\([^)]*\): boolean \{\n\s+return isFromSurface\(event, this\.command\)/)
    const share = read('shell/window-share.ts')
    expect(share).toMatch(/private fromCommand\([^)]*\): boolean \{\n\s+return isFromSurface\(event, this\.command\)/)
    expect(share).toMatch(/private fromView\([^)]*\): boolean \{\n\s+return isFromSurface\(event, this\.view\)/)
    const bridge = read('engine/electron-engine-preloads.ts')
    expect(bridge.match(/\(isMainFrameSender\(event\) \? this\.pageOfContents\(event\.sender\) : undefined\)\?\.(reportTrackActions|tabVolume)\(/g)).toHaveLength(2)
    // No handler of the bridge reads the page of a sender without that check.
    expect(bridge.slice(bridge.indexOf('listenToMediaBridge'), bridge.indexOf('protected pageDialog'))).not.toMatch(/[^:] this\.pageOfContents\(event\.sender\)\?/)
  })
})

describe('sourceForView', () => {
  const view = { id: 'view' }
  const source = { id: 'window:42:0', name: 'Notes' }

  it('gives the chosen window to the top frame of the view', () => {
    expect(sourceForView(source, view, view)).toBe(source)
  })

  it('refuses a frame inside the view, another page of the partition, and a request that names no frame', () => {
    expect(sourceForView(source, { id: 'child' }, view)).toBeNull()
    expect(sourceForView(source, null, view)).toBeNull()
    expect(sourceForView(source, undefined, undefined)).toBeNull()
    expect(sourceForView(source, null, null)).toBeNull()
  })

  it('refuses while nothing is shared', () => {
    expect(sourceForView(null, view, view)).toBeNull()
  })

  it('is what the partition of the view answers with', () => {
    expect(readFileSync(join(__dirname, '..', 'main', 'shell', 'window-share.ts'), 'utf8')).toMatch(/setDisplayMediaRequestHandler\(\(request, callback\) => \{\n\s+const source = sourceForView\(this\.source, request\.frame, /)
  })
})

describe('isMainFrameSender', () => {
  const main = { id: 'main' }
  it('answers the top frame only', () => {
    expect(isMainFrameSender({ senderFrame: main, sender: { mainFrame: main } })).toBe(true)
    expect(isMainFrameSender({ senderFrame: { id: 'child' }, sender: { mainFrame: main } })).toBe(false)
  })

  it('refuses a message whose frame is gone, even when the web contents has none either', () => {
    expect(isMainFrameSender({ senderFrame: null, sender: { mainFrame: main } })).toBe(false)
    expect(isMainFrameSender({ senderFrame: undefined, sender: { mainFrame: undefined } })).toBe(false)
    expect(isMainFrameSender({ sender: {} })).toBe(false)
  })

  it('refuses a message from a web contents that was destroyed under it (reading its main frame throws)', () => {
    const destroyed = {
      senderFrame: main,
      sender: {
        get mainFrame(): unknown {
          throw new Error('Object has been destroyed')
        }
      }
    }
    expect(isMainFrameSender(destroyed)).toBe(false)
  })
})

describe('shouldBlockDrag', () => {
  it('blocks a link, a file or some text dragged in from outside', () => {
    expect(shouldBlockDrag(['text/uri-list', 'text/plain'], false)).toBe(true)
    expect(shouldBlockDrag(['Files'], false)).toBe(true)
    expect(shouldBlockDrag(['text/plain'], false)).toBe(true)
    expect(shouldBlockDrag([], false)).toBe(true)
  })

  it('lets our own drags through: the tabs, favourites and folders of the sidebar', () => {
    for (const type of [DRAG_TYPE, DRAG_FAVORITE_TYPE, DRAG_FOLDER_TYPE]) {
      expect(type.startsWith(INTERNAL_DRAG_PREFIX), type).toBe(true)
      expect(shouldBlockDrag([type], false), type).toBe(false)
    }
    expect(shouldBlockDrag(['application/x-lucium-tab', 'text/plain'], false)).toBe(false)
  })

  it('does not take a link of a page for one of ours because the page added one of our types to it', () => {
    expect(shouldBlockDrag(['text/uri-list', 'text/plain', 'application/x-lucium-tab'], false)).toBe(true)
    expect(shouldBlockDrag(['Files', 'application/x-lucium-tab'], false)).toBe(true)
  })

  it('lets a text field take dropped text, but never a dropped file', () => {
    expect(shouldBlockDrag(['text/plain'], true)).toBe(false)
    expect(shouldBlockDrag(['text/uri-list', 'text/plain'], true)).toBe(false)
    expect(shouldBlockDrag(['Files'], true)).toBe(true)
  })
})

describe('carriesFiles', () => {
  it('tells a drag of files of the disk from a link, a text and a drag of the interface', () => {
    expect(carriesFiles(['Files'])).toBe(true)
    expect(carriesFiles(['text/uri-list', 'Files'])).toBe(true)
    for (const types of [[], ['text/uri-list'], ['text/plain'], [DRAG_TYPE], ['files']]) expect(carriesFiles(types), types.join()).toBe(false)
  })
})
