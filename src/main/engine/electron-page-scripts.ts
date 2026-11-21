// What the page of the engine (electron-page.ts and its layers) runs in a document, with the worlds its scripts live in, its bounds of
// time and of size, and the small helpers its layers share. Moved out of electron-page.ts as it was.

import { clipboard } from 'electron'
import { isInternalPageUrl } from '@shared/internal-page'
import { isViewSourceUrl } from '@shared/url'
import { AUTOSCROLL_SCRIPTS } from '@shared/autoscroll'
import { SELECTOR_FOR } from '@shared/element-selector'
import { GESTURE_SCRIPTS } from '@shared/gestures'
import type { PageTools, ToolScripts } from '@shared/page-tools'
import { SCROLL_SYNC_SCRIPTS } from '@shared/scroll-sync'
import { VIM_KEY_SCRIPTS } from '@shared/vim-keys'

/** A frame that does not answer a media question within this long is left out of it (a hung or frozen page must not hold the player). */
export const MEDIA_SCRIPT_TIMEOUT_MS = 3000
// The zoom of the PDF viewer is driven through its own toolbar: the browser-level zoom does not move it. If a Chromium update changes
// the toolbar, the script answers false and the engine test says so.
export function pdfZoomScript(step: -1 | 0 | 1): string {
  return `(() => {
    const toolbar = document.querySelector('pdf-viewer')?.shadowRoot?.querySelector('viewer-toolbar')?.shadowRoot
    const controls = toolbar?.querySelector('#zoom-controls')
    const input = controls?.querySelector('input')
    if (!controls || !input || controls.children.length < 3) return false
    if (${step} === 1) controls.lastElementChild.click()
    else if (${step} === -1) controls.firstElementChild.click()
    else { input.value = '100'; input.dispatchEvent(new Event('change', { bubbles: true })) }
    return true
  })()`
}
const NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'about:', 'chrome-extension:', 'devtools:'])

export const SELECTION_PREVIEW_CHARS = 28
/** A held page menu (mouse gestures) opens by itself after this long if the button is never released as far as we can tell. */
export const HELD_MENU_MAX_MS = 15_000
/** …and this long after the release if the script of the page has said nothing. */
export const HELD_MENU_FALLBACK_MS = 350
/** The script's answer to a release counts for the menu that follows it for this long (systems that ask for the menu at the release). */
export const VERDICT_FRESH_MS = 400
/** The scripts of each in-page tool. */
export const TOOL_SCRIPTS: Record<keyof PageTools, ToolScripts> = { autoScroll: AUTOSCROLL_SCRIPTS, mouseGestures: GESTURE_SCRIPTS, scrollSync: SCROLL_SYNC_SCRIPTS, vimKeys: VIM_KEY_SCRIPTS }

/** Electron 45's clipboard writes are asynchronous: a failure must be reported, not left as an unhandled rejection. */
export function copyText(text: string): void {
  clipboard.writeText(text).catch((error: unknown) => console.error('[engine] cannot write to the clipboard:', error))
}

/** Where a page of the web may send its tab (a link, a script, a restored history): the web, a file, the pages of extensions. Never the Extensions page (`lucium-ui:`). */
export function isNavigable(url: string): boolean {
  return URL.canParse(url) && NAVIGABLE_PROTOCOLS.has(new URL(url).protocol)
}

/**
 * What the shell may load in a tab: what a page may (`isNavigable`), the source view of a web page, and the Extensions page. The last is the one address
 * only the shell sends a tab to (`Page.loadURL`, from the state of the tab); the guards of the page, which read `isNavigable`, never let a page of the web go there.
 */
export function isShellNavigable(url: string): boolean {
  return isNavigable(url) || isViewSourceUrl(url) || isInternalPageUrl(url)
}

// Pages taller than this are cut: a 100 000 px screenshot would exhaust memory.
export const CAPTURE_MAX_HEIGHT = 16_000
// Pages wider than this too: a page sets its own width as freely as its height.
export const CAPTURE_MAX_WIDTH = 16_000

/** The part of a page a full-page capture takes: from the top left corner, at most `CAPTURE_MAX_WIDTH` by `CAPTURE_MAX_HEIGHT`, at least one pixel each way. */
export function fullPageClip(size: { width: number; height: number }): { x: 0; y: 0; width: number; height: number; scale: 1 } {
  const side = (value: number, max: number): number => (Number.isFinite(value) ? Math.min(Math.max(Math.ceil(value), 1), max) : 1)
  return { x: 0, y: 0, width: side(size.width, CAPTURE_MAX_WIDTH), height: side(size.height, CAPTURE_MAX_HEIGHT), scale: 1 }
}
/**
 * Run in the page before a full-page capture. A page often scrolls in a container of its own (the document is as tall as the window): the
 * size of the document says nothing then. This finds the main scroller (the document, or the widest and tallest element that scrolls
 * and is bigger than the window), walks it from top to bottom one window at a time so that lazy images load and endless pages show how far
 * they go (never past `maxHeight`), puts it back where it was, and answers how tall the window must be for the whole of it to show.
 */
export function prepareFullCaptureScript(maxHeight: number): string {
  return `(async () => {
    const view = { width: innerWidth, height: innerHeight }
    const scrolls = (el) => {
      const style = getComputedStyle(el)
      return /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1 && el.clientWidth >= view.width * 0.5 && el.clientHeight >= view.height * 0.5
    }
    const root = document.scrollingElement || document.documentElement
    let scroller = root
    if (root.scrollHeight <= view.height + 1) {
      let best = 0
      for (const el of document.body ? document.body.querySelectorAll('*') : []) {
        if (!scrolls(el)) continue
        const room = el.scrollHeight - el.clientHeight
        if (room > best) { best = room; scroller = el }
      }
    }
    const start = scroller.scrollTop
    const extra = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    const limit = ${maxHeight}
    const step = Math.max(200, scroller.clientHeight || view.height)
    let top = 0
    for (let i = 0; i < 80 && top <= extra() && view.height + extra() < limit + step; i++) {
      scroller.scrollTop = top
      await new Promise((done) => setTimeout(done, 120))
      top += step
    }
    scroller.scrollTop = extra()
    await new Promise((done) => setTimeout(done, 150))
    const height = view.height + extra()
    scroller.scrollTop = start
    return { width: view.width, height, inner: scroller !== root }
  })()`
}

/** What the preparation script answered, read field by field: a page can run scripts of its own, so nothing is taken as the type it should have. */
export function readCaptureSize(raw: unknown): { width: number; height: number; inner: boolean } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { width, height, inner } = raw as { width?: unknown; height?: unknown; inner?: unknown }
  return typeof width === 'number' && typeof height === 'number' && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height, inner: inner === true } : null
}

// Eraser picker: highlights what is under the pointer; a click returns a CSS selector, Escape cancels.
export const PICK_ELEMENT = `new Promise((resolve) => {
  const box = document.createElement('div')
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #ff3b7a;background:rgba(255,59,122,.18);border-radius:3px'
  document.documentElement.appendChild(box)
  let target = null
  ${SELECTOR_FOR}
  const move = (e) => {
    target = e.target
    const r = target.getBoundingClientRect()
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
  }
  const finish = (value) => {
    removeEventListener('mousemove', move, true); removeEventListener('click', click, true); removeEventListener('keydown', key, true)
    box.remove(); resolve(value)
  }
  const click = (e) => { e.preventDefault(); e.stopPropagation(); finish(target ? selectorFor(target) : null) }
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(null) } }
  addEventListener('mousemove', move, true); addEventListener('click', click, true); addEventListener('keydown', key, true)
})`

// Sleep checks run in an isolated world: it sees the page's DOM and events but not its scripts, and the page cannot see it.
// Any number outside the ones Chromium hands to extension content scripts would do.
export const SLEEP_WORLD = 4_200_017
/** The world that reads which search engines a document declares (see shared/opensearch.ts). */
export const SEARCH_DISCOVERY_WORLD = 4_200_072
export const SLEEP_PROBE_TIMEOUT_MS = 3000
/** How long a page closed for a sleep may take to say whether it lets itself go (its `beforeunload`; Chromium's own bound is shorter). */
export const RELEASE_ANSWER_MS = 5000
// Remembers the fields the user typed in (trusted input events only: autofill and scripts do not count) until their form is
// submitted or they are empty again. The page's own value tracking is not enough: React-style inputs keep it in sync. A box ticked, a
// button chosen or an option picked in a form counts the same while it differs from what the page gave and the form is not sent.
// Events do not cross frames: the document of a frame of the same site (an editor in a frame: TinyMCE, CKEditor, a mail composer) is
// watched from the moment the focus goes into it, which is before anything can be typed there. A frame of another site cannot be reached
// from here (its `beforeunload` still holds a sleep: `release`). Elements are told by their tag, not by `instanceof`: a frame's
// elements are of its own constructors.
export const TRACK_INPUT = `(() => {
  if (self.__luciumUnsent) return
  const typed = new Set()
  const hooked = new WeakSet()
  const TEXT_TYPES = /^(text|search|email|url|tel|password|number|date|datetime-local|month|time|week)$/i
  const CHOICE_TYPES = /^(checkbox|radio)$/i
  const tag = (el) => (el && el.nodeType === 1 ? String(el.tagName).toUpperCase() : '')
  const isText = (el) => tag(el) === 'TEXTAREA' || (tag(el) === 'INPUT' && TEXT_TYPES.test(el.type)) || (tag(el) !== '' && el.isContentEditable === true)
  const isChoice = (el) => !!el.form && ((tag(el) === 'INPUT' && CHOICE_TYPES.test(el.type)) || tag(el) === 'SELECT')
  const changed = (el) => (tag(el) === 'SELECT' ? [...el.options].some((o) => o.selected !== o.defaultSelected) : el.checked !== el.defaultChecked)
  const filled = (el) => el.isConnected && (isChoice(el) ? changed(el) : 'value' in el ? String(el.value) !== '' : (el.textContent || '').trim() !== '')
  const note = (e) => { if (e.isTrusted && (isText(e.target) || isChoice(e.target))) typed.add(e.target) }
  const sent = (e) => { for (const el of [...typed]) if (e.target.contains && e.target.contains(el)) typed.delete(el) }
  const reach = (doc) => {
    let el = doc.activeElement
    while (tag(el) === 'IFRAME' || tag(el) === 'FRAME') {
      let inner = null
      try { inner = el.contentDocument } catch { /* a frame of another site: out of reach from here; its beforeunload still holds a sleep */ }
      if (!inner) return
      hook(inner)
      el = inner.activeElement
    }
  }
  const hook = (doc) => {
    if (!doc || hooked.has(doc)) return
    hooked.add(doc)
    doc.addEventListener('input', note, true)
    doc.addEventListener('change', note, true)
    doc.addEventListener('submit', sent, true)
    const view = doc.defaultView
    if (view) view.addEventListener('blur', () => setTimeout(() => reach(doc), 0), true)
  }
  hook(document)
  self.__luciumUnsent = () => { for (const el of [...typed]) { if (filled(el)) return true; typed.delete(el) } return false }
})()`

/** How long the page may take to answer the picture-in-picture request before the command gives up. */
export const PIP_TIMEOUT_MS = 4000

/** The promise, or 'timeout' when it has not settled in time. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}
