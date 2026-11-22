// The walk of a page from top to bottom, run in the page: it makes lazy images load and shows how far an endless page goes. Shared by the
// full-page capture (electron-page-scripts.ts) and the Markdown export (markdown-picker.ts), so that both read the same page. A leaf: it
// builds a string and imports nothing, so that the isolated-world code can use it without Electron.

/** Pages taller than this are not walked past it (and a capture cuts there): a 100 000 px page would exhaust memory. */
export const SCROLL_WALK_MAX_HEIGHT = 16_000
/** The walk makes at most this many steps, one window each: an endless page ends here. */
export const SCROLL_WALK_MAX_STEPS = 80
/** What the page is given after each step to load what came into view. */
export const SCROLL_WALK_STEP_MS = 120

/**
 * An expression for the page: it finds the main scroller (the document, or the widest and tallest element that scrolls and is bigger than the
 * window), walks it one window at a time (at most `SCROLL_WALK_MAX_STEPS` steps, never past `maxHeight`), leaves it at the bottom, and resolves
 * with `{ view, inner, extra, restore }`: the size of the window, whether the scroller is an element of its own, how far the scroller can go, and
 * the function that puts it back where it was. The caller restores it, once it has read what the walk loaded.
 */
export function scrollWalkSource(maxHeight: number): string {
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
    for (let i = 0; i < ${SCROLL_WALK_MAX_STEPS} && top <= extra() && view.height + extra() < limit + step; i++) {
      scroller.scrollTop = top
      await new Promise((done) => setTimeout(done, ${SCROLL_WALK_STEP_MS}))
      top += step
    }
    scroller.scrollTop = extra()
    await new Promise((done) => setTimeout(done, 150))
    return { view, inner: scroller !== root, extra, restore: () => { scroller.scrollTop = start } }
  })()`
}
