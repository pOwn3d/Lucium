// Autoscroll (Chromium has it on Windows and Linux, not on macOS): a click of the middle button on the page puts an anchor
// where the pointer is, and the page scrolls on its own, faster the further the pointer is from the anchor. Another click, or Escape,
// ends it. A middle click on a link, a field, a button or a media player is left to the page and to the browser (opening the link in a tab).
// The script runs in an isolated world of the main frame (page-tools.ts); the speed curve is a pure function that the script carries
// as its own source, so the test and the page run the same code.

import { toolPreamble, type ToolScripts } from './page-tools'

/** The pointer this close to the anchor (in pixels) scrolls nothing: a click that moved a hair is not a request to move. */
export const AUTOSCROLL_DEAD_ZONE = 12
/** The fastest the page scrolls, in pixels per second. */
export const AUTOSCROLL_MAX_SPEED = 3600

/**
 * Pixels to scroll in `elapsedMs` when the pointer is `offset` pixels from the anchor on one axis (negative: up or left). Zero inside the
 * dead zone, then growing faster than the distance, so that a small move reads slowly and a long one crosses a page in a moment.
 * Self-contained on purpose: the page script is built from this function's source.
 */
export function autoscrollStep(offset: number, elapsedMs: number): number {
  const beyond = Math.abs(offset) - 12
  if (!(beyond > 0)) return 0
  const speed = Math.min(3600, beyond * 8 + (beyond * beyond) / 40)
  return Math.sign(offset) * speed * (Math.min(elapsedMs, 100) / 1000)
}

/** The elements a middle click is left to: they have a meaning of their own for that button. */
export const AUTOSCROLL_IGNORED = 'a[href],area[href],input,textarea,select,button,summary,label,video,audio,iframe,embed,object,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"]'

function installScript(nonce: string): string {
  return `(function () {
  'use strict';
  ${toolPreamble(nonce)}
  if (tools.autoScroll) return;
  const step = ${autoscrollStep.toString()};
  const ignored = ${JSON.stringify(AUTOSCROLL_IGNORED)};
  let anchor = null;
  let marker = null;
  let pointer = { x: 0, y: 0 };
  let frame = 0;
  let last = 0;
  let carry = { x: 0, y: 0 };
  const scroller = (start) => {
    for (let node = start; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      const vertical = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
      const horizontal = /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
      if (vertical || horizontal) return node;
    }
    const root = document.scrollingElement || document.documentElement;
    return root.scrollHeight > root.clientHeight + 1 || root.scrollWidth > root.clientWidth + 1 ? root : null;
  };
  const drawMarker = (x, y) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '28');
    svg.setAttribute('height', '28');
    svg.setAttribute('viewBox', '0 0 28 28');
    const disc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const [name, value] of [['cx', '14'], ['cy', '14'], ['r', '13'], ['fill', 'rgba(30,30,36,0.82)'], ['stroke', 'rgba(255,255,255,0.85)'], ['stroke-width', '1.5']]) disc.setAttribute(name, value);
    const arrows = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrows.setAttribute('d', 'M14 5l4 5h-8zM14 23l4-5h-8zM5 14l5-4v8zM23 14l-5-4v8z');
    arrows.setAttribute('fill', '#fff');
    svg.append(disc, arrows);
    svg.style.cssText = 'position:fixed;left:' + (x - 14) + 'px;top:' + (y - 14) + 'px;width:28px;height:28px;z-index:2147483647;pointer-events:none;margin:0;padding:0';
    document.documentElement.append(svg);
    return svg;
  };
  let target = null;
  const run = (now) => {
    if (!anchor || !target) return;
    const elapsed = last === 0 ? 16 : now - last;
    last = now;
    carry.x += step(pointer.x - anchor.x, elapsed);
    carry.y += step(pointer.y - anchor.y, elapsed);
    const dx = Math.trunc(carry.x);
    const dy = Math.trunc(carry.y);
    if (dx !== 0 || dy !== 0) {
      carry.x -= dx;
      carry.y -= dy;
      target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    }
    frame = requestAnimationFrame(run);
  };
  const stop = () => {
    if (!anchor) return;
    anchor = null;
    target = null;
    cancelAnimationFrame(frame);
    marker && marker.remove();
    marker = null;
    document.documentElement.style.removeProperty('cursor');
  };
  // The click that ends it is not given to the page either, release and click included: it would press whatever lies under the anchor.
  let swallowUntil = 0;
  const onDown = (event) => {
    if (anchor) {
      event.preventDefault();
      event.stopImmediatePropagation();
      stop();
      swallowUntil = performance.now() + 800;
      return;
    }
    if (!event.isTrusted || event.button !== 1 || event.defaultPrevented) return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element || element.closest(ignored)) return;
    const found = scroller(element);
    if (!found) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    target = found;
    anchor = { x: event.clientX, y: event.clientY };
    pointer = { x: event.clientX, y: event.clientY };
    carry = { x: 0, y: 0 };
    last = 0;
    marker = drawMarker(anchor.x, anchor.y);
    document.documentElement.style.setProperty('cursor', 'all-scroll', 'important');
    frame = requestAnimationFrame(run);
  };
  const onMove = (event) => { if (anchor) pointer = { x: event.clientX, y: event.clientY }; };
  const onKey = (event) => { if (anchor && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); stop(); } };
  const onRelease = (event) => { if (event.isTrusted && performance.now() < swallowUntil) { event.preventDefault(); event.stopImmediatePropagation(); } };
  const onWheel = () => stop();
  const onHide = () => stop();
  addEventListener('mousedown', onDown, true);
  addEventListener('mouseup', onRelease, true);
  addEventListener('click', onRelease, true);
  addEventListener('auxclick', onRelease, true);
  addEventListener('mousemove', onMove, true);
  addEventListener('keydown', onKey, true);
  addEventListener('wheel', onWheel, { capture: true, passive: true });
  addEventListener('blur', onHide);
  addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onHide);
  tools.autoScroll = {
    off() {
      stop();
      removeEventListener('mousedown', onDown, true);
      removeEventListener('mouseup', onRelease, true);
      removeEventListener('click', onRelease, true);
      removeEventListener('auxclick', onRelease, true);
      removeEventListener('mousemove', onMove, true);
      removeEventListener('keydown', onKey, true);
      removeEventListener('wheel', onWheel, true);
      removeEventListener('blur', onHide);
      removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
    }
  };
})()`
}

export const AUTOSCROLL_SCRIPTS: ToolScripts = {
  install: installScript,
  uninstall: `(function () { const tools = self.__lucium_tools; if (!tools || !tools.autoScroll) return; try { tools.autoScroll.off() } finally { delete tools.autoScroll } })()`
}
