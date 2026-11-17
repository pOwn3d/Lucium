// The animation « Effacer les données du site » draws over the page while it runs (Réglages › Vie privée et sécurité › Effacer les données du
// site › Animation sur la page), ported from the extension this panel comes from: seven loaders, then a tick or a cross for a moment, then
// nothing. Lucium draws it itself, in an isolated world of the tab (`SITE_DATA_OVERLAY_WORLD`): the page can neither see the script nor reach
// into the closed shadow root it draws in, and nothing is left behind once the run is over. Pure: the scripts are text, run by the engine
// (Page.runClearOverlay); the main process decides whether to draw at all (`pageAnimation`: never while motion is reduced).

import { t } from './i18n'

/** An isolated world of its own (the other worlds of Lucium: 4_200_017 to 4_200_099, see `*_WORLD`). */
export const SITE_DATA_OVERLAY_WORLD = 4_200_061

/** The choices of the setting, `none` first: no drawing at all. */
export const SITE_DATA_ANIMATIONS = ['none', 'spinner', 'pacman', 'broom', 'matrix', 'nuke', 'fire', 'bounce'] as const
export type SiteDataAnimation = (typeof SITE_DATA_ANIMATIONS)[number]
export type DrawnAnimation = Exclude<SiteDataAnimation, 'none'>

/** The extension's default. */
export const DEFAULT_SITE_DATA_ANIMATION: SiteDataAnimation = 'spinner'

export const isSiteDataAnimation = (value: unknown): value is SiteDataAnimation => (SITE_DATA_ANIMATIONS as readonly unknown[]).includes(value)

/** A saved or imported choice: a known one, else the default. */
export const cleanSiteDataAnimation = (value: unknown): SiteDataAnimation => (isSiteDataAnimation(value) ? value : DEFAULT_SITE_DATA_ANIMATION)

/** What a run draws on the page: nothing while the system's « Réduire les animations » or Lucium's own is on, whatever was chosen. */
export function pageAnimation(choice: SiteDataAnimation, options: { reducedMotion: boolean }): SiteDataAnimation {
  return options.reducedMotion ? 'none' : choice
}

/** The name of each choice (the setting's tiles) and the words under the drawing. Read when drawn: they follow the language of the moment. */
export const SITE_DATA_ANIMATION_LABELS: Record<SiteDataAnimation, { readonly name: string; readonly text: string }> = {
  none: { get name() { return t('site-data-anim.aucune') }, text: '' },
  spinner: { name: 'Spinner', get text() { return t('site-data-anim.suppression') } },
  pacman: { name: 'Pac-Man', get text() { return t('site-data-anim.miam-miam') } },
  broom: { get name() { return t('site-data-anim.balai') }, get text() { return t('site-data-anim.nettoyage') } },
  matrix: { name: 'Matrix', get text() { return t('site-data-anim.purge') } },
  nuke: { name: 'Nuke', get text() { return t('site-data-anim.destruction') } },
  fire: { get name() { return t('site-data-anim.feu') }, get text() { return t('site-data-anim.ca-brule') } },
  bounce: { get name() { return t('site-data-anim.rebond') }, get text() { return t('site-data-anim.suppression') } }
}

/** One stroke of a glyph on a 24 × 24 grid: a path, or a circle (centre and radius). */
export type GlyphPart = { d: string } | { circle: readonly [number, number, number] }

/** The glyph of each choice, stroked (the setting's tiles draw them; the broom, the bolt and the flame are drawn on the page too). */
export const SITE_DATA_ANIMATION_GLYPHS: Record<SiteDataAnimation, readonly GlyphPart[]> = {
  none: [{ circle: [12, 12, 9] }, { d: 'm5.6 5.6 12.8 12.8' }],
  spinner: [{ d: 'M21 12a9 9 0 1 1-6.219-8.56' }],
  pacman: [{ d: 'M19.8 7.5A9 9 0 1 0 19.8 16.5L12 12Z' }, { circle: [11, 7, 0.6] }],
  broom: [{ d: 'm21 3-8.5 8.5' }, { d: 'M10 9.5 14.5 14' }, { d: 'M10 9.5C6.5 10.5 4 13.5 3 19l2 2c5.5-1 8.5-3.5 9.5-7' }, { d: 'm7.5 21 1.5-3.5' }, { d: 'm3 16.5 3.5-1.5' }],
  matrix: [{ d: 'm4 17 6-6-6-6' }, { d: 'M12 19h8' }],
  nuke: [{ d: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z' }],
  fire: [{ d: 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z' }],
  bounce: [{ circle: [12, 8, 4] }, { d: 'M5 20h14' }, { d: 'M12 14.5v2' }]
}

/** The tick and the cross of the end of a run. */
const DONE_GLYPHS = { ok: [{ d: 'M20 6 9 17l-5-5' }], err: [{ d: 'M18 6 6 18' }, { d: 'm6 6 12 12' }] } as const satisfies Record<'ok' | 'err', readonly GlyphPart[]>

/**
 * The colours of the drawing. It sits over any page, dark in every theme like the extension's, so it takes its colours from the fixed palette
 * of the interface (renderer/palette.css, where each one is named by its value): a page has none of the interface's tokens to read.
 */
export const OVERLAY_COLOURS = {
  box: 'rgb(20 22 34 / 0.86)',
  line: 'rgb(255 255 255 / 0.08)',
  shadow: 'rgb(0 0 0 / 0.4)',
  text: 'rgb(255 255 255 / 0.7)',
  track: 'rgb(255 255 255 / 0.12)',
  dust: 'rgb(255 255 255 / 0.4)',
  ink: '#fff',
  eye: '#000',
  red: '#e5484d',
  yellow: '#ffe082',
  amber: '#f5a524',
  green: '#4fc47f'
} as const

const c = OVERLAY_COLOURS

/** How long the tick or the cross stays, then how long it takes to fade (the extension's 1.2 s and 0.2 s). */
export const OVERLAY_DONE_MS = 1200
export const OVERLAY_FADE_MS = 200
/** How long the loader is on screen at least: an erasure takes a few tens of milliseconds, which is not time to see « Feu » or Pac-Man. */
export const OVERLAY_LOADER_MIN_MS = 1200
/** A drawing whose end never came (the run threw before it could say, the window closed): it takes itself away. */
export const OVERLAY_GIVE_UP_MS = 20_000

const CSS = [
  `.veil{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;animation:in .2s ease}`,
  `.veil.out{animation:out ${OVERLAY_FADE_MS}ms ease forwards}`,
  `.box{position:relative;display:flex;flex-direction:column;align-items:center;gap:10px;padding:24px 32px;background:${c.box};-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border:1px solid ${c.line};border-radius:16px;box-shadow:0 8px 32px ${c.shadow};color:${c.text};font:500 13px/1.3 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;letter-spacing:.3px}`,
  `svg{display:block;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}`,
  `.text{white-space:nowrap}`,
  `.spinner{width:28px;height:28px;box-sizing:border-box;border:3px solid ${c.track};border-top-color:${c.red};border-radius:50%;animation:spin .7s linear infinite}`,
  `.pacman-scene{display:flex;align-items:center;gap:4px;height:32px}`,
  `.pacman{position:relative;width:28px;height:28px;border-radius:50%;background:${c.yellow};animation:chomp .4s ease infinite}`,
  `.pacman::before{content:'';position:absolute;top:4px;left:12px;width:4px;height:4px;border-radius:50%;background:${c.eye}}`,
  `.dots{display:flex;align-items:center;gap:8px}`,
  `.dots span{width:6px;height:6px;border-radius:50%;background:${c.yellow};animation:eat 1.2s ease infinite}`,
  `.broom{width:40px;height:40px;color:${c.ink};transform-origin:70% 30%;animation:sweep .8s ease-in-out infinite}`,
  `.dust{display:flex;gap:6px;margin-top:-6px}`,
  `.dust span{width:3px;height:3px;border-radius:50%;background:${c.dust};animation:float 1s ease infinite}`,
  `.matrix{display:flex;gap:4px;color:${c.green};font:700 18px/1 ui-monospace,'SF Mono',Menlo,monospace}`,
  `.matrix span{opacity:0;animation:drop .6s ease infinite}`,
  `.text.green{color:${c.green}}`,
  `.nuke{width:44px;height:44px;color:${c.amber};animation:shake .15s ease infinite alternate}`,
  `.shockwave{position:absolute;top:24px;left:50%;width:60px;height:60px;margin-left:-30px;border:2px solid ${c.red};border-radius:50%;animation:shock 1.2s ease-out infinite}`,
  `.fire{display:flex;gap:2px}`,
  `.fire svg{width:30px;height:30px;color:${c.amber};animation:flame .5s ease infinite alternate}`,
  `.fire svg:nth-child(2){color:${c.red}}`,
  `.bounce{display:flex;gap:8px;padding-top:18px}`,
  `.bounce span{width:12px;height:12px;border-radius:50%;background:${c.red};animation:bounce .6s ease infinite alternate}`,
  `.bounce span:nth-child(2){background:${c.yellow}}`,
  `.bounce span:nth-child(3){background:${c.green}}`,
  `.done{width:34px;height:34px;stroke-width:3;animation:pop .3s ease}`,
  `.done.ok{color:${c.green}}`,
  `.done.err{color:${c.red}}`,
  `@keyframes in{from{opacity:0}to{opacity:1}}`,
  `@keyframes out{from{opacity:1}to{opacity:0}}`,
  `@keyframes spin{to{transform:rotate(360deg)}}`,
  `@keyframes chomp{0%,100%{clip-path:polygon(100% 50%,50% 0%,0% 0%,0% 100%,50% 100%)}50%{clip-path:polygon(100% 50%,50% 15%,0% 0%,0% 100%,50% 85%)}}`,
  `@keyframes eat{0%,60%{opacity:1;transform:scale(1)}80%,100%{opacity:0;transform:scale(0)}}`,
  `@keyframes sweep{0%,100%{transform:rotate(-15deg)}50%{transform:rotate(15deg)}}`,
  `@keyframes float{0%{opacity:.8;transform:translateY(0) scale(1)}100%{opacity:0;transform:translateY(-16px) scale(.5)}}`,
  `@keyframes drop{0%{opacity:0;transform:translateY(-12px)}30%{opacity:1;transform:translateY(0)}70%{opacity:1}100%{opacity:0;transform:translateY(8px)}}`,
  `@keyframes shake{from{transform:translate(-2px,-1px) rotate(-1deg)}to{transform:translate(2px,1px) rotate(1deg)}}`,
  `@keyframes shock{0%{transform:scale(.5);opacity:.6}100%{transform:scale(4);opacity:0}}`,
  `@keyframes flame{from{transform:translateY(0) scale(1)}to{transform:translateY(-6px) scale(1.15)}}`,
  `@keyframes bounce{from{transform:translateY(0)}to{transform:translateY(-18px)}}`,
  `@keyframes pop{0%{transform:scale(.5);opacity:0}60%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}`
].join('')

/** What each drawing is made of, for the script to build with the DOM calls (a page that requires Trusted Types does not get in the way). */
type Piece = { tag: 'div' | 'span'; className?: string; text?: string; children?: Piece[] } | { glyph: readonly GlyphPart[]; className?: string }

const repeat = (count: number, piece: Piece): Piece[] => Array.from({ length: count }, () => piece)
const span = (text?: string): Piece => ({ tag: 'span', ...(text === undefined ? {} : { text }) })

function drawing(animation: DrawnAnimation): Piece[] {
  switch (animation) {
    case 'spinner':
      return [{ tag: 'div', className: 'spinner' }]
    case 'pacman':
      return [{ tag: 'div', className: 'pacman-scene', children: [{ tag: 'div', className: 'pacman' }, { tag: 'div', className: 'dots', children: repeat(6, span()) }] }]
    case 'broom':
      return [{ glyph: SITE_DATA_ANIMATION_GLYPHS.broom, className: 'broom' }, { tag: 'div', className: 'dust', children: repeat(5, span()) }]
    case 'matrix':
      return [{ tag: 'div', className: 'matrix', children: [...'01C00K1E01'].map((char) => span(char)) }]
    case 'nuke':
      return [{ glyph: SITE_DATA_ANIMATION_GLYPHS.nuke, className: 'nuke' }, { tag: 'div', className: 'shockwave' }]
    case 'fire':
      return [{ tag: 'div', className: 'fire', children: repeat(3, { glyph: SITE_DATA_ANIMATION_GLYPHS.fire }) }]
    case 'bounce':
      return [{ tag: 'div', className: 'bounce', children: repeat(3, span()) }]
  }
}

/** The staggered start of the pieces that move one after the other (the extension's delays). */
const DELAYS: Record<string, number> = { dots: 0.15, dust: 0.2, matrix: 0.08, fire: 0.15, bounce: 0.2 }

/** The name the drawing keeps in the isolated world (the page's own `window` does not see it). */
const STATE = '__luciumSiteDataOverlay'

/** The part both scripts share: building glyphs and pieces with the DOM calls. */
const BUILD = String.raw`
  const SVG = 'http://www.w3.org/2000/svg'
  const glyph = (parts, className) => {
    const svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    if (className) svg.setAttribute('class', className)
    for (const part of parts) {
      const shape = document.createElementNS(SVG, part.d ? 'path' : 'circle')
      if (part.d) shape.setAttribute('d', part.d)
      else ['cx', 'cy', 'r'].forEach((name, i) => shape.setAttribute(name, String(part.circle[i])))
      svg.appendChild(shape)
    }
    return svg
  }
  const build = (piece) => {
    if (piece.glyph) return glyph(piece.glyph, piece.className)
    const element = document.createElement(piece.tag)
    if (piece.className) element.className = piece.className
    if (piece.text) element.textContent = piece.text
    for (const child of piece.children || []) element.appendChild(build(child))
    const step = DELAYS[piece.className]
    if (step) [...element.children].forEach((child, i) => (child.style.animationDelay = (i * step).toFixed(2) + 's'))
    return element
  }
`

/**
 * Draws the animation of a run that starts, in place of one still on the page. Answers true once it is drawn. The drawing never takes a
 * click (pointer-events: none), and takes itself away after `OVERLAY_GIVE_UP_MS` should its end never come.
 */
export function clearingOverlayScript(animation: DrawnAnimation): string {
  const text = SITE_DATA_ANIMATION_LABELS[animation].text
  const pieces: Piece[] = [...drawing(animation), { tag: 'div', className: animation === 'matrix' ? 'text green' : 'text', text }]
  return `(() => {
  const CSS = ${JSON.stringify(CSS)}
  const PIECES = ${JSON.stringify(pieces)}
  const DELAYS = ${JSON.stringify(DELAYS)}
${BUILD}
  const previous = window[${JSON.stringify(STATE)}]
  if (previous) {
    clearTimeout(previous.timer)
    previous.host.remove()
  }
  const host = document.createElement('div')
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none'
  const root = host.attachShadow({ mode: 'closed' })
  // The styles go in a constructable stylesheet: the CSP of a page that forbids inline styles (no 'unsafe-inline') blocks a <style> element, which would leave
  // the drawing without any rule, and does not look at a sheet made by script. A world that cannot make one gets the element.
  let style = null
  try {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(CSS)
    root.adoptedStyleSheets = [sheet]
  } catch (error) {
    style = document.createElement('style')
    style.textContent = CSS
  }
  const veil = document.createElement('div')
  veil.className = 'veil'
  const box = document.createElement('div')
  box.className = 'box'
  box.setAttribute('role', 'status')
  for (const piece of PIECES) box.appendChild(build(piece))
  veil.appendChild(box)
  if (style) root.append(style)
  root.append(veil)
  ;(document.documentElement || document.body).appendChild(host)
  const state = { host, veil, box, timer: 0 }
  state.timer = setTimeout(() => host.remove(), ${OVERLAY_GIVE_UP_MS})
  window[${JSON.stringify(STATE)}] = state
  return true
})()`
}

/**
 * The end of a run: a tick (everything went through) or a cross for `OVERLAY_DONE_MS`, then the drawing fades and is gone. Answers false and
 * draws nothing when there is no drawing on the page any more: a tab sent back to the root of its site is a new document, which must not
 * get a tick it never had a loader for.
 */
export function doneOverlayScript(ok: boolean): string {
  return `(() => {
  const DELAYS = {}
${BUILD}
  const state = window[${JSON.stringify(STATE)}]
  if (!state || !state.host.isConnected) return false
  clearTimeout(state.timer)
  state.box.replaceChildren(glyph(${JSON.stringify(ok ? DONE_GLYPHS.ok : DONE_GLYPHS.err)}, ${JSON.stringify(ok ? 'done ok' : 'done err')}))
  state.timer = setTimeout(() => {
    state.veil.classList.add('out')
    state.timer = setTimeout(() => {
      state.host.remove()
      if (window[${JSON.stringify(STATE)}] === state) delete window[${JSON.stringify(STATE)}]
    }, ${OVERLAY_FADE_MS})
  }, ${OVERLAY_DONE_MS})
  return true
})()`
}
