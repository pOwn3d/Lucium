// chrome.scripting for an extension that holds "activeTab" and no host permission: the commonest shape of a Manifest V3 extension. On the
// extension platform a click on its icon lends it the tab, and chrome.scripting then runs its script there. Electron has no way to tell
// Chromium about that loan, so its own chrome.scripting keeps answering "Cannot access contents of the page". When it does, and only for a tab
// the user did hand over (ActiveTabGrants, shared/extension-access.ts), the application runs the script itself.
//
// What that script gets: the page (its document), in a world of its own for the extension (or the page's world, when asked). Chromium gives `chrome.runtime` and the other
// extension APIs only to the worlds it makes itself, so the application makes the few that a script injected on demand needs (shared/lent-tab-runtime.ts): the runtime, the
// messages and the storage, in the world of the extension and nowhere else. Only the top document of the tab is reached.

import type { ActiveTabGrants } from './extension-access'
import { SCRIPT_WORLDS_FROM } from './lent-tab-runtime'
import { isStorePage } from './web-store'

export { SCRIPT_WORLDS_FROM }

/** What Chromium answers an extension that may not touch a page: the same words, so that an extension that looks for them finds them. */
export const NO_PAGE_ACCESS = 'Cannot access contents of the page. Extension manifest must request permission to access the respective host.'

/** The most text one call may hand over to run or to insert. */
export const SCRIPT_MAX_CHARS = 4 * 1024 * 1024

export interface TabInjection {
  tabId: number
  /** True for the world of the page itself (`world: 'MAIN'`). */
  mainWorld: boolean
  /** The text of a function to call, with its arguments. */
  func?: string
  args: unknown[]
  /** Files of the extension to run or to insert, in order. */
  files?: string[]
  css?: string
  userOrigin: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reads what the shim handed over of a chrome.scripting call. Throws, in the words an extension can read, for a call that names nothing to do. */
export function readInjection(raw: unknown, kind: 'script' | 'css'): TabInjection {
  if (!isRecord(raw) || !isRecord(raw['target']) || !Number.isInteger(raw['target']['tabId'])) throw new Error('The call names no tab.')
  const files = Array.isArray(raw['files']) ? raw['files'].filter((file): file is string => typeof file === 'string' && file.length <= 1024).slice(0, 32) : undefined
  const func = typeof raw['func'] === 'string' ? raw['func'] : undefined
  const css = typeof raw['css'] === 'string' ? raw['css'] : undefined
  const text = kind === 'script' ? func : css
  if ((text === undefined) === (files === undefined || files.length === 0)) throw new Error(kind === 'script' ? "Exactly one of 'func' and 'files' must be specified." : "Exactly one of 'css' and 'files' must be specified.")
  if ((text?.length ?? 0) > SCRIPT_MAX_CHARS) throw new Error('The text handed over is too long.')
  return {
    tabId: raw['target']['tabId'] as number,
    mainWorld: raw['world'] === 'MAIN',
    ...(kind === 'script' && func !== undefined ? { func } : {}),
    args: Array.isArray(raw['args']) ? raw['args'] : [],
    ...(text === undefined && files ? { files } : {}),
    ...(kind === 'css' && css !== undefined ? { css } : {}),
    userOrigin: raw['origin'] === 'USER'
  }
}

/** Whether the user handed this tab, where it is now, to this extension: a web page, never the Chrome Web Store. */
export function lentTab(permissions: ReadonlySet<string>, grants: ActiveTabGrants, extensionId: string, tabId: number, url: string | undefined): boolean {
  if (url === undefined || !permissions.has('activeTab') || !permissions.has('scripting')) return false
  if (!/^https?:/i.test(url) || isStorePage(url)) return false
  return grants.has(extensionId, tabId, url)
}

/**
 * The origin the tab was lent on, when it is lent now (the tests of `lentTab`): the origin a script of the extension may run on. Null when it is not lent.
 * It is the origin of the click, kept by the grant, not the one the tab shows when this is asked: that is the point.
 */
export function lentOrigin(permissions: ReadonlySet<string>, grants: ActiveTabGrants, extensionId: string, tabId: number, url: string | undefined): string | null {
  return lentTab(permissions, grants, extensionId, tabId, url) ? (grants.originOf(extensionId, tabId) ?? null) : null
}

/** The script that calls a function of the extension with its arguments (which travel as JSON, as on the extension platform). */
export function callOf(func: string, args: readonly unknown[]): string {
  return `(${func})(...${JSON.stringify(args)})`
}

/**
 * Whether a script begins with the "use strict" directive, after the blanks and the comments that may precede a directive: the check put before it must not take that
 * mode away. A scan from the start of the text, one pass whatever the text is: this runs in the main process on a file the extension chooses, and a pattern that tries
 * every way to cut a run of comments (`(?:…|\/\*[\s\S]*?\*\/)*`) takes a time that doubles with each comment (32 of them stopped the application for seconds).
 * No regular expression is used here for that reason. A blank is what `\s` is (`trim` strips the same characters).
 */
export function startsStrict(text: string): boolean {
  let at = 0
  for (;;) {
    const char = text[at]
    if (char === undefined) return false
    if (char.trim() === '') at++
    else if (text.startsWith('//', at)) {
      // A line comment ends with the line; one that ends with the text leaves no directive after it.
      const lineEnd = text.indexOf('\n', at)
      if (lineEnd < 0) return false
      at = lineEnd + 1
    } else if (text.startsWith('/*', at)) {
      const close = text.indexOf('*/', at + 2)
      if (close < 0) return false
      at = close + 2
    } else break
  }
  const quote = text[at]
  if (quote !== '"' && quote !== "'") return false
  const directive = at + 1 + 'use strict'.length
  if (!text.startsWith('use strict', at + 1) || text[directive] !== quote) return false
  // The directive ends the statement: with a semicolon, at the end of a line, or at the end of the text (more on the same line makes it an expression).
  let end = directive + 1
  let newline = false
  while (end < text.length && text[end]!.trim() === '') {
    if (text[end] === '\n') newline = true
    end++
  }
  return end >= text.length || text[end] === ';' || newline
}

/**
 * A script of the extension, preceded by the check that it runs in the origin the tab was lent on, made by the document that runs it. The browser process
 * judges the tab on the page it knew, and the script reaches the renderer later: in between the tab can have been sent to another origin (chrome.tabs.update
 * asks for no permission), so a check made only there lets the script run in a page it was never lent. Here the document that is about to run the script says
 * whose it is, in the same turn of the script, so that no navigation can come between the check and the script. `location.origin` is the address the document
 * was loaded from, which is what the loan was made on (an opaque origin never reaches here: only a web page is lent), and a page cannot redefine it.
 * The check refuses by throwing; what the extension is answered is the refusal of the extension platform, which the engine makes of it (`runInDocument`, `refusedByDocument`).
 * No statement of the script runs in a document that refuses, but the functions it declares at its top level are made before the first statement, the check included
 * (a script's declarations are instantiated first): in the world of the page they exist in that document. The script is not put in a block to prevent it, which would change
 * what `let`, `const` and `function` mean in a script that is run as it was written. The tests say so (active-tab-script.test.ts).
 */
export function guardedScript(origin: string, code: string): string {
  // A hashbang is only valid at the very start of a script: as a comment it no longer stops the check from being put before it.
  const text = code.startsWith('#!') ? `//${code.slice(2)}` : code
  const strict = startsStrict(text) ? "'use strict';" : ''
  return `${strict}if (location.origin !== ${JSON.stringify(origin)}) throw new Error(${JSON.stringify(NO_PAGE_ACCESS)});\n${text}`
}

/** Whether a script that was run in a page failed because the document was not the one that was lent (`guardedScript`). */
export function refusedByDocument(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).includes(NO_PAGE_ACCESS)
}

/**
 * The isolated world of the page the scripts of one extension run in: its own. The numbers are handed out one after the other and kept, since
 * a number worked out from the id (a hash) can be the same for two extensions, and the script of one would then read the variables of the other.
 */
export class ScriptWorlds {
  private readonly worlds = new Map<string, number>()

  of(extensionId: string): number {
    let world = this.worlds.get(extensionId)
    if (world === undefined) this.worlds.set(extensionId, (world = SCRIPT_WORLDS_FROM + this.worlds.size))
    return world
  }

  /** The extension a world was handed to, or undefined for a world that was handed to none (the preload of a tab asks, to know whose bridge a call comes through). */
  extensionOf(world: number): string | undefined {
    for (const [extensionId, handed] of this.worlds) if (handed === world) return extensionId
    return undefined
  }
}
