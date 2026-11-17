// What a surface of our own interface (main window, panels layer, floating sidebar, Settings, task manager, mini window, private
// windows) may do about navigation and dropped items. Every one of them shares the preload and so `window.lucium`: if one
// ever shows a remote page (a link or a file dropped on it, a redirect, window.open), that page would inherit the whole API.
// Pure rules here; the Electron wiring is in main/shell/surface-guard.ts and the drop handlers in renderer/surface.ts.

/** Where the interface comes from: the dev server while developing, the built pages of the application otherwise. */
export interface AppRoots {
  /** The URL of electron-vite's dev server, or null (always null in a packaged application). */
  devUrl: string | null
  /** The `file:` URL of the folder that holds the built pages, ending with a slash. */
  fileRoot: string
}

/**
 * The dev server the interface is loaded from, or null. Only a build that is not packaged honours `ELECTRON_RENDERER_URL`: in an
 * application a user runs, an environment variable must not be able to replace the interface with any page of its choosing.
 */
export function rendererDevUrl(envValue: string | undefined, packaged: boolean): string | null {
  return !packaged && envValue ? envValue : null
}

/** True when `url` is a page of our own interface and nothing else. Anything that does not parse is not. */
export function isAppUrl(url: string, roots: AppRoots): boolean {
  if (!URL.canParse(url)) return false
  const target = new URL(url)
  if (roots.devUrl !== null && URL.canParse(roots.devUrl)) {
    const dev = new URL(roots.devUrl)
    if ((dev.protocol === 'http:' || dev.protocol === 'https:') && target.origin === dev.origin) return true
  }
  if (target.protocol !== 'file:' || !URL.canParse(roots.fileRoot)) return false
  const root = new URL(roots.fileRoot)
  if (root.protocol !== 'file:' || target.host !== root.host) return false
  // The parser has already resolved `..` and `%2e%2e`; an encoded separator is how a path would still climb out of the folder.
  if (/%2f|%5c|%00/i.test(target.pathname)) return false
  const prefix = root.pathname.endsWith('/') ? root.pathname : `${root.pathname}/`
  // A page, never a script, a style sheet or a source map of the folder: a surface shown one of those would print the code of the interface as text.
  return target.pathname.startsWith(prefix) && /^[^/]+\.html$/.test(target.pathname.slice(prefix.length))
}

/** The part of an IPC event this module reads (Electron's `IpcMainEvent` and `IpcMainInvokeEvent` both have it). */
export interface FrameEvent {
  senderFrame?: unknown
  sender: { mainFrame?: unknown }
}

/**
 * True when the message comes from the top frame of its web contents. A subframe of an interface surface is not ours (and a
 * message from a frame that is already gone cannot be placed), so it is never answered.
 */
export function isMainFrameSender(event: FrameEvent): boolean {
  try {
    const frame = event.senderFrame
    return frame !== null && frame !== undefined && frame === event.sender.mainFrame
  } catch {
    // The web contents was destroyed under the message: there is no main frame to compare with.
    return false
  }
}

/** The part of a window of ours a message is checked against. */
export interface SurfaceWindow {
  isDestroyed(): boolean
  webContents: { id: number }
}

/**
 * True when the message comes from the top frame of the page of `window`, a window of ours that is still there. The channels a surface has
 * for itself (the bar of the annotation, the two windows of a share) are heard through this: a frame that got into such a window is not it.
 */
export function isFromSurface(event: FrameEvent & { sender: { id: number } }, window: SurfaceWindow | null): boolean {
  return window !== null && !window.isDestroyed() && event.sender.id === window.webContents.id && isMainFrameSender(event)
}

/**
 * What a request to capture gets in the partition of the view of a share: the source the user chose, for the top frame of the view and for
 * nothing else. Null (a refusal) while nothing is shared, for a frame inside the view and for any other page that came to live in the partition.
 */
export function sourceForView<S>(source: S | null, asking: unknown, viewFrame: unknown): S | null {
  return source !== null && asking !== null && asking !== undefined && asking === viewFrame ? source : null
}

/** The data types of the drags that start inside our own interface (a tab, a favourite, a folder of the sidebar). */
export const INTERNAL_DRAG_PREFIX = 'application/x-lucium-'

/** The data type of a drag that carries files of the disk. */
const FILES_TYPE = 'Files'

/** What makes a document navigate when it is dropped: a file, or an address. */
const NAVIGATING_TYPES = [FILES_TYPE, 'text/uri-list']

/** Whether a drag carries files of the disk (the Finder's), which the window opens in tabs rather than only refusing. */
export function carriesFiles(types: readonly string[]): boolean {
  return types.includes(FILES_TYPE)
}

/**
 * Whether a drag over the interface must be refused. Dropping a link or a file on a document makes it navigate there, which for an
 * interface surface means leaving it. Only our own drags are let through (a page could add one of our types to a link it lets the
 * user drag, so a drag that also carries an address or a file is not ours). A text field may still take dropped text, but not files.
 */
export function shouldBlockDrag(types: readonly string[], overEditableField: boolean): boolean {
  const carriesNavigation = NAVIGATING_TYPES.some((type) => types.includes(type))
  if (!carriesNavigation && types.some((type) => type.startsWith(INTERNAL_DRAG_PREFIX))) return false
  if (overEditableField && !carriesFiles(types)) return false
  return true
}
