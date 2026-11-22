// The tools that run inside the pages (autoscroll, mouse gestures, synchronized scrolling, Vim-style keys, reading aloud): which ones a page carries,
// and how a page tells the application what happened.
//
// A tool is a script run in an isolated world of the page, in the main frame only: the page cannot read it, call it or change it. The
// scripts speak to the application by writing one line to the page's console (the only way out of a page without a preload of ours),
// and the line carries a secret that the engine drew for that page and that only the scripts know: a page that writes the same words
// to its own console is not believed. Anything that comes back is checked here before it is acted on.

export interface PageTools {
  /** A middle click on the page starts autoscroll. */
  autoScroll: boolean
  /** The right button held and moved draws a gesture. */
  mouseGestures: boolean
  /** The page reports its scroll position, and takes the position of the pane beside it. */
  scrollSync: boolean
  /** Plain keys scroll the page, show link hints and move between tabs (see vim-keys.ts). */
  vimKeys: boolean
  /** The page reports where it stopped scrolling, and goes back to a position it is given (see scroll-memory.ts). */
  scrollMemory: boolean
}

export const NO_PAGE_TOOLS: Readonly<PageTools> = Object.freeze({ autoScroll: false, mouseGestures: false, scrollSync: false, vimKeys: false, scrollMemory: false })

export const TOOL_NAMES = ['autoScroll', 'mouseGestures', 'scrollSync', 'vimKeys', 'scrollMemory'] as const satisfies readonly (keyof PageTools)[]

export const anyPageTool = (tools: PageTools): boolean => TOOL_NAMES.some((name) => tools[name])

export const samePageTools = (a: PageTools, b: PageTools): boolean => TOOL_NAMES.every((name) => a[name] === b[name])

/** An isolated world of its own: not the page's, and none of the ones the engine uses for the reader, the sleep probe or the Markdown picker. */
export const TOOLS_WORLD = 4_200_031

/** What a console line of a tool starts with; the secret of the page and a colon follow, then the message as JSON. */
export const TOOL_CHANNEL = '__lucium_tool__'

/** The directions of a gesture, in the order they were drawn: U, D, L, R. */
export const GESTURE_MAX_STEPS = 8

/** What the Vim-style keys ask of the application. `open-tab` carries the address of a link; the others carry nothing. */
export const VIM_APP_ACTIONS = ['back', 'forward', 'reload', 'tab-previous', 'tab-next', 'find', 'open-tab'] as const
export type VimAppAction = (typeof VIM_APP_ACTIONS)[number]

/** A link address that travels in a console line: longer ones are opened by clicking in the page instead (the line would be refused). */
export const VIM_URL_MAX = 1800

/** The longest line a tool may write: the Vim keys carry an address, the other tools a few characters. */
const TOOL_LINE_MAX = 512
const VIM_LINE_MAX = 2400

export type ToolMessage =
  /** The right button was released: `path` is the gesture drawn, empty for a plain click (the page's menu then opens). */
  | { tool: 'gesture'; path: string }
  /** The page scrolled: the position, as a share (0 to 1) of what can be scrolled on each axis. */
  | { tool: 'scroll'; x: number; y: number }
  /** The scrolling stopped: how far the page is scrolled, in whole pixels from its top (the scroll memory). */
  | { tool: 'scrollpos'; y: number }
  /** The page's own voice stopped, at the end of the text or because it failed. */
  | { tool: 'speech'; state: 'end' | 'error' }
  /** A Vim-style key asked for something only the application can do (go back, change tab, open a link in a tab...). */
  | { tool: 'vim'; action: Exclude<VimAppAction, 'open-tab'> }
  | { tool: 'vim'; action: 'open-tab'; url: string }

/** A command for the scripts of a page. */
export type ToolCommand =
  /** Scrolls the page to the same share of its length as the pane that was scrolled. */
  | { tool: 'scrollSync'; x: number; y: number }
  /** Scrolls the page back to a position it was left at (pixels from the top). */
  | { tool: 'scrollMemory'; y: number }

import { isScrollPx } from './scroll-memory'

const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** An address a page may ask to have opened in a tab: a web page, of a size that fits a console line. */
export function isOpenableLink(url: unknown): url is string {
  return typeof url === 'string' && url.length <= VIM_URL_MAX && URL.canParse(url) && /^https?:$/.test(new URL(url).protocol)
}

/**
 * Reads a console line. `null`: not a line of a tool of this page (an ordinary console message, or someone else's secret). `'invalid'`:
 * it carries this page's secret but says nothing that is allowed, which only a bug of ours can do (the caller logs it).
 */
export function parseToolMessage(text: unknown, nonce: string): ToolMessage | 'invalid' | null {
  const prefix = `${TOOL_CHANNEL}${nonce}:`
  if (typeof text !== 'string' || nonce === '' || !text.startsWith(prefix) || text.length > VIM_LINE_MAX) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(prefix.length))
  } catch {
    return 'invalid'
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'invalid'
  const message = raw as Record<string, unknown>
  // Only the Vim keys write a long line (a link address); a longer line from another tool is not one of ours.
  if (text.length > TOOL_LINE_MAX && message['tool'] !== 'vim') return null
  switch (message['tool']) {
    case 'gesture': {
      const path = message['path']
      return typeof path === 'string' && path.length <= GESTURE_MAX_STEPS && /^[UDLR]*$/.test(path) ? { tool: 'gesture', path } : 'invalid'
    }
    case 'scroll':
      return unit(message['x']) && unit(message['y']) ? { tool: 'scroll', x: message['x'], y: message['y'] } : 'invalid'
    case 'scrollpos':
      return isScrollPx(message['y']) ? { tool: 'scrollpos', y: message['y'] } : 'invalid'
    case 'speech':
      return message['state'] === 'end' || message['state'] === 'error' ? { tool: 'speech', state: message['state'] } : 'invalid'
    case 'vim': {
      const action = message['action']
      if (action === 'open-tab') return isOpenableLink(message['url']) ? { tool: 'vim', action, url: message['url'] } : 'invalid'
      return typeof action === 'string' && (VIM_APP_ACTIONS as readonly string[]).includes(action) ? { tool: 'vim', action: action as Exclude<VimAppAction, 'open-tab'> } : 'invalid'
    }
    default:
      return 'invalid'
  }
}

/** The script that installs a tool in a document, or takes it out; each guards itself against a second run. */
export interface ToolScripts {
  install(nonce: string): string
  uninstall: string
}

/** The text a script writes to the console to report `message` (the scripts build it themselves; the tests build it with this). */
export const toolMessageText = (nonce: string, message: ToolMessage): string => `${TOOL_CHANNEL}${nonce}:${JSON.stringify(message)}`

/** The part every tool script starts with: its place in the world, and the function that reports to the application. */
export const toolPreamble = (nonce: string): string =>
  `const tools = (self.__lucium_tools = self.__lucium_tools || {});
  const report = (message) => console.debug(${JSON.stringify(TOOL_CHANNEL + nonce + ':')} + JSON.stringify(message));`
