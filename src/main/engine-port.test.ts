import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { posix } from './windows.test-support'

// The port of the engine kept watertight. `docs/architecture.md` promises that everything that depends on Electron is behind
// `src/main/engine/types.ts` (`Engine`, `Page`), so that a second engine could be written without touching the rest. `src/shared` is the
// logic the interface and the state share with the main process: it must never know Electron at all. This test freezes the state of the
// two folders and only lets it improve:
//  - a file of `src/shared/` or `src/main/engine/` that is not in ALLOWED and imports Electron (or one of its libraries) fails the test;
//  - a file of ALLOWED that no longer imports a module it lists, or that disappeared, fails the test too (the ratchet): the list only
//    shrinks, and the person who removed the import removes the line.
// Not covered: `src/main/shell/`, `src/preload/` and the root of `src/main/`, which import Electron by design today (windows, menus, preloads).
// Tests (`*.test.ts`) are left out: they mock or type against Electron without shipping it. This test lives in src/main, not src/shared: the web
// configuration (tsconfig.web.json) has no Node types, and src/shared is what it types.

// A module that only exists for Electron: the runtime, its subpaths (`electron/main`), and the libraries made for it.
const ELECTRON_BOUND = /^electron(?:$|[/-])/

const SCANNED_DIRS = ['src/shared', 'src/main/engine']

// Every file that imports Electron today, as listed by a `grep` of the two folders (tests left out), with what it does with
// it. `imports` is the exact set of Electron-bound modules the file may import.
const ALLOWED: Record<string, { imports: string[]; why: string }> = {
  'src/main/engine/electron-engine.ts': {
    imports: ['electron'],
    why: 'The port itself: the one implementation of Engine/Page over Electron, the last layer of ElectronEngine (the pages and the private contexts; the layers below are the electron-engine-*.ts, M-31). Stays.'
  },
  'src/main/engine/electron-engine-base.ts': {
    imports: ['electron', 'electron-chrome-extensions'],
    why: 'The port itself: a layer of ElectronEngine (the fields, the constructor), cut out of electron-engine.ts as it was (M-31, 2026-11-03). Stays.'
  },
  'src/main/engine/electron-engine-bridge.ts': {
    imports: ['electron'],
    why: 'The port itself: a layer of ElectronEngine (the bridge between the extensions and the tabs), cut out of electron-engine.ts as it was (M-31, 2026-11-03). Stays.'
  },
  'src/main/engine/electron-engine-preloads.ts': {
    imports: ['electron'],
    why: 'The port itself: a layer of ElectronEngine (the preloads of the pages), cut out of electron-engine.ts as it was (M-31, 2026-11-03). Stays.'
  },
  'src/main/engine/electron-engine-network.ts': {
    imports: ['electron'],
    why: 'The port itself: a layer of ElectronEngine (the network policies and the request hooks), cut out of electron-engine.ts as it was (M-31, 2026-11-03). Stays.'
  },
  'src/main/engine/electron-engine-extensions.ts': {
    imports: ['electron'],
    why: 'The port itself: a layer of ElectronEngine (loading the extensions), cut out of electron-engine.ts as it was (M-31, 2026-11-03). Stays.'
  },
  'src/main/engine/electron-engine-profile.ts': {
    imports: ['electron', 'electron-chrome-extensions'],
    why: 'The port itself: a layer of ElectronEngine (the wiring of a profile), cut out of electron-engine.ts as it was (M-31, 2026-11-03). Stays.'
  },
  'src/main/engine/electron-engine-permissions.ts': {
    imports: ['electron'],
    why: 'The port itself: a layer of ElectronEngine (the permissions and their questions), cut out of electron-engine.ts as it was (M-31, 2026-11-03). Stays.'
  },
  'src/main/engine/document-pip-windows.ts': {
    imports: ['electron'],
    why: 'The windows of document Picture-in-Picture: the window Chromium makes is taken from Electron (its internal event) and shown in a BaseWindow of the application, as PopupWindows does for popups.'
  },
  'src/main/engine/electron-engine-downloads.ts': {
    imports: ['electron'],
    why: 'The port itself: a layer of ElectronEngine (the downloads), cut out of electron-engine.ts as it was (M-31, 2026-11-03). Stays.'
  },
  'src/main/engine/electron-page.ts': {
    imports: ['electron', 'electron-chrome-extensions'],
    why: 'The port itself too: the Page half of the implementation over Electron (WebContents, menus, clipboard, the tabs of the extensions), moved out of electron-engine.ts as it was (2026-11-03). Stays.'
  },
  'src/main/engine/electron-page-base.ts': {
    imports: ['electron'],
    why: 'The port itself: a layer of ElectronPage (what the page holds, its frames, its style sheets, its view in the window), cut out of electron-page.ts as it was. Stays.'
  },
  'src/main/engine/electron-page-content.ts': {
    imports: ['electron'],
    why: 'Type only: a layer of ElectronPage (what is read from the document and run in it), cut out of electron-page.ts as it was. Stays.'
  },
  'src/main/engine/electron-page-media.ts': {
    imports: ['electron'],
    why: 'Type only: a layer of ElectronPage (the in-page tools, reading aloud, the media), cut out of electron-page.ts as it was. Stays.'
  },
  'src/main/engine/electron-page-lifecycle.ts': {
    imports: ['electron'],
    why: 'The port itself: a layer of ElectronPage (sleep, the view lent or moved to another window, the end), cut out of electron-page.ts as it was. Stays.'
  },
  'src/main/engine/electron-page-scripts.ts': {
    imports: ['electron'],
    why: 'The port itself: the clipboard helper of the page menu, with the scripts and the bounds of ElectronPage, moved out of electron-page.ts as they were. Stays.'
  },
  'src/main/engine/ece-router.ts': {
    imports: ['electron', 'electron-chrome-extensions'],
    why: 'Type only: the shape of the library whose router it guards, and (`electron`, added by the merge of 2026-10-26: the context-menu entries of extensions) the params of a page menu. Goes away with the library (or becomes a contract test).'
  },
  'src/main/engine/extension-console.ts': {
    imports: ['electron'],
    why: 'Added by the merge of 2026-10-26 (page Extensions). Type only (Session, WebContents): reads the console of the extension pages of a session. Belongs behind the port (an Engine method that streams the logs).'
  },
  'src/main/engine/extension-dev.ts': {
    imports: ['electron'],
    why: 'Added by the merge of 2026-10-26 (page Extensions). Reload/unpacked-load of extensions and their icons (app, nativeImage, webContents, Session). Belongs behind the port (Engine methods for the developer actions).'
  },
  'src/main/engine/error-pages.ts': {
    imports: ['electron'],
    why: 'Replaces the document of a failed load and covers a crashed renderer (WebContents, shell.openExternal). Candidate for the port: needs a Page method for "replace the document".'
  },
  'src/main/engine/markdown-picker.ts': {
    imports: ['electron'],
    why: 'Type only (WebContents): scripts run in an isolated world. Candidate for the port: takes a Page-level `runIsolated`.'
  },
  'src/main/engine/page-cover.ts': {
    imports: ['electron'],
    why: 'A WebContentsView laid over a page (crash cover, reader). Electron view primitive; belongs behind the port.'
  },
  'src/main/engine/page-reader.ts': {
    imports: ['electron'],
    why: 'Reads a watched page in a hidden WebContentsView. Electron view primitive; belongs behind the port.'
  },
  'src/main/engine/popup-windows.ts': {
    imports: ['electron'],
    why: 'Real windows for `window.open` with a feature list (BrowserWindow, screen). Electron window primitive; belongs behind the port.'
  },
  'src/main/engine/reader-mode.ts': {
    imports: ['electron'],
    why: 'Type only (BrowserWindow, Input, WebContents): Readability runs in an isolated world of the page.'
  },
  'src/main/engine/tab-capture-helper.ts': {
    imports: ['electron'],
    why: 'The helper page of a capture of the sound of a tab by an extension: a window that is never shown (BrowserWindow, Session) that asks for the stream and answers the offer of the extension page. Electron window primitive; belongs behind the port.'
  },
  'src/main/engine/unload-guard.ts': {
    imports: ['electron'],
    why: 'Added by the merge of 2026-10-26 (beforeunload). The sheet « Quitter ce site ? » on the window of the page (dialog, BrowserWindow). Belongs behind the port (a Page-level prompt).'
  },
  'src/main/engine/web-auth.ts': {
    imports: ['electron'],
    why: 'The sign-in window of chrome.identity.launchWebAuthFlow (BrowserWindow). Goes away with a Chromium-side identity API.'
  },
  'src/main/engine/web-store.ts': {
    imports: ['electron', 'electron-chrome-web-store'],
    why: 'Drives electron-chrome-web-store (ipcMain, net, session, nativeImage). Goes away with the library.'
  }
}

/** The Electron-bound modules a source file imports (static, re-exported, side-effect, dynamic and `require`), sorted and without duplicates. */
export function electronImports(source: string): string[] {
  // Comment lines are dropped so that a sentence such as "from 'electron'" in a comment is not an import.
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n')
  const found = new Set<string>()
  const patterns = [
    /\bfrom\s*['"]([^'"\n]+)['"]/g, // import … from 'x' / export … from 'x'
    /^\s*import\s*['"]([^'"\n]+)['"]/gm, // import 'x'
    /\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g // require('x') / import('x')
  ]
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) if (ELECTRON_BOUND.test(match[1]!)) found.add(match[1]!)
  return [...found].sort()
}

/** What is wrong with the files given (path → source), compared with the list. Empty when the port is as tight as the list says. */
export function portViolations(files: Record<string, string>, allowed: Record<string, { imports: string[] }>): string[] {
  const problems: string[] = []
  for (const [file, source] of Object.entries(files)) {
    const imports = electronImports(source)
    const entry = allowed[file]
    if (!entry) {
      if (imports.length) problems.push(`${file} imports ${imports.join(', ')}: a new file of the port side must not (put the Electron part behind Engine/Page in electron-engine.ts)`)
      continue
    }
    const extra = imports.filter((name) => !entry.imports.includes(name))
    if (extra.length) problems.push(`${file} now imports ${extra.join(', ')}, which the list does not allow`)
    const gone = entry.imports.filter((name) => !imports.includes(name))
    if (gone.length) problems.push(`${file} no longer imports ${gone.join(', ')}: remove it from ALLOWED (the list only shrinks)`)
  }
  for (const file of Object.keys(allowed)) if (!(file in files)) problems.push(`${file} is in ALLOWED but is not a file of the scanned folders any more: remove it from the list`)
  return problems
}

function sourcesOf(dir: string, root: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) Object.assign(out, sourcesOf(path, root))
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out[posix(relative(root, path))] = readFileSync(path, 'utf8')
  }
  return out
}

describe('electronImports', () => {
  it('finds static, type, multi-line, re-exported, side-effect, dynamic and require imports of Electron and its libraries', () => {
    const source = [
      "import { app } from 'electron'",
      "import type { WebContents } from 'electron'",
      'import {',
      '  BrowserWindow,',
      '  type Session',
      "} from 'electron/main'",
      "export { ElectronChromeExtensions } from 'electron-chrome-extensions'",
      "import 'electron-chrome-web-store'",
      "const lazy = await import('electron')",
      "const old = require('electron')"
    ].join('\n')
    expect(electronImports(source)).toEqual(['electron', 'electron-chrome-extensions', 'electron-chrome-web-store', 'electron/main'])
  })

  it('ignores comments, other modules and names that only look like Electron', () => {
    const source = [
      "// import { app } from 'electron'",
      " * import { app } from 'electron'",
      "/* import { app } from 'electron' */",
      "import { join } from 'node:path'",
      "import { electronic } from './electronic'",
      "import { x } from '@shared/electron-notes'",
      "const REFERENCE_KEYS = ['machine', 'os', 'electron']",
      "const name = 'electron'"
    ].join('\n')
    expect(electronImports(source)).toEqual([])
  })
})

describe('portViolations', () => {
  const allowed = { 'src/main/engine/electron-engine.ts': { imports: ['electron'] } }
  // The listed file as the list says it is, to which each case adds what it tries.
  const base = { 'src/main/engine/electron-engine.ts': "import { app } from 'electron'" }

  it('fails on a new file that imports Electron, and says what to do', () => {
    const problems = portViolations({ ...base, 'src/shared/new-thing.ts': "import { app } from 'electron'" }, allowed)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('src/shared/new-thing.ts imports electron')
  })

  it('fails on a new file that imports a library made for Electron', () => {
    expect(portViolations({ ...base, 'src/main/engine/other.ts': "import type { ElectronChromeExtensions } from 'electron-chrome-extensions'" }, allowed)).toHaveLength(1)
  })

  it('fails on a listed file that imports one more Electron module than the list allows', () => {
    const problems = portViolations({ 'src/main/engine/electron-engine.ts': "import { app } from 'electron'\nimport { x } from 'electron-chrome-web-store'" }, allowed)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('electron-chrome-web-store')
  })

  it('fails when a listed file no longer imports Electron (the ratchet: the list only shrinks)', () => {
    const problems = portViolations({ 'src/main/engine/electron-engine.ts': "import { join } from 'node:path'" }, allowed)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('remove it from ALLOWED')
  })

  it('fails when a listed file is gone', () => {
    expect(portViolations({ 'src/shared/pure.ts': "import { z } from './z'" }, allowed)).toHaveLength(1)
  })

  it('accepts a tree that is exactly what the list says, and files that do not touch Electron', () => {
    expect(portViolations({ 'src/main/engine/electron-engine.ts': "import { app } from 'electron'", 'src/shared/pure.ts': "import { z } from './z'" }, allowed)).toEqual([])
  })
})

describe('the port of the engine', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const files: Record<string, string> = {}
  for (const dir of SCANNED_DIRS) Object.assign(files, sourcesOf(join(root, dir), root))

  it('scans the two folders (a rename of one of them must not turn the test into a no-op)', () => {
    expect(Object.keys(files).filter((file) => file.startsWith('src/shared/')).length).toBeGreaterThan(100)
    expect(Object.keys(files).filter((file) => file.startsWith('src/main/engine/')).length).toBeGreaterThan(20)
    expect(files['src/main/engine/types.ts']).toBeDefined()
  })

  it('lets no new file of src/shared or src/main/engine import Electron, and only lets the list of those that do shrink', () => {
    expect(portViolations(files, ALLOWED)).toEqual([])
  })

  it('keeps src/shared free of Electron altogether', () => {
    expect(Object.keys(ALLOWED).filter((file) => file.startsWith('src/shared/'))).toEqual([])
  })

  it('gives a reason for every file of the list', () => {
    for (const [file, entry] of Object.entries(ALLOWED)) {
      expect(entry.imports.length, file).toBeGreaterThan(0)
      expect(entry.why.length, file).toBeGreaterThan(20)
    }
  })
})
