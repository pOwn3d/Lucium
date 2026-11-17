// The recolouring engine of the readable mode (readable-mode.ts holds the choice, dark-sites.ts what a mode gives a page). It runs in an
// isolated world of the page (`READABLE_WORLD`): it sees the page's DOM and styles, the page cannot see it, read its state or change the
// functions it calls. It makes no request of its own: it reads the stylesheets the page already exposes (CSSOM) and the computed styles.
// The copy of a sheet names again the pictures its rules name (`background-image` is repeated, to keep the order of the page's rules):
// that the browser asks for none of them a second time is watched by an end-to-end test (tests/e2e/interface.spec.ts), not shown here.
//
// What it does to a page, for Dark (Light is the mirror):
//  1. Recolours instead of inverting: every colour keeps its hue and as much of its chroma as the sRGB gamut allows (OKLCH), and only its
//     lightness moves, by role: backgrounds go dark, text goes light, borders keep their contrast with the background, dark shadows stay.
//     A copy of each readable stylesheet is made with the same selectors, the same order and importance, and the colours mapped; it is adopted
//     after the page's own sheets, so the cascade of the page is kept (hover states, media queries, layers, custom properties). Custom
//     properties are never changed: a colour property that reads `var(--x)` reads a mapped twin of `--x` instead, made for its role.
//  2. Guarantees contrast: every element is then read (computed style, in slices of time) and text whose colour is still under 4.5 : 1 against
//     what is behind it (3 : 1 for large text, and for the borders of form fields and single-colour icons) gets its lightness nudged, same
//     hue, until it is reached. Colours a sheet that cannot be read gave (another origin), inline styles and colour attributes are mapped here.
//  3. Follows the page: new elements, class and style changes, sheets added later and open shadow roots.
//  4. Leaves images, videos, canvases, frames of other sites, emoji and background images as they are.
//
// `readableKit` (the colour arithmetic and the rewriting of a stylesheet) and `readableEngine` (the part that touches the page) are sent as
// TEXT (their `toString()`): they must stay self-contained, reading no name of this module at run time (types are erased). The file imports
// nothing, so that scripts/readable-bench.mjs loads it with Node's TypeScript stripping, and the tests run the same source.

type Dom = any

/** The isolated world of the readable mode (any number outside the ones Chromium gives extension content scripts, and not one of ours). */
export const READABLE_WORLD = 4_200_097

/** The name the engine keeps its state under, in its own world (the page's world has no such name). */
export const READABLE_STATE = '__luciumReadable'

export type ReadableScheme = 'dark' | 'light'
/** What a colour is for, which decides how its lightness moves. */
export type ColourRole = 'bg' | 'fg' | 'border' | 'shadow'

export interface Rgb {
  /** 0 to 255. */
  r: number
  g: number
  b: number
  /** 0 to 1. */
  a: number
}

export interface Oklch {
  l: number
  c: number
  h: number
}

/** The limits of the engine's work on a page. */
export interface ReadableBudget {
  /** The longest the stylesheets may take at the start: beyond, the engine gives up and the page is inverted instead. */
  startMs: number
  /** The elements read at once at the start, so that what is on screen is right on the first frame. */
  firstChunkMs: number
  /** The time of each later slice (an idle callback). */
  chunkMs: number
  /** The elements read by the first pass at most: a longer page keeps the recoloured sheets, and its elements are read when they change. */
  maxElements: number
  /** The time the engine may spend on a page within `busyWindowMs`: beyond, it stops reading elements (the sheets stay). */
  busyMs: number
  busyWindowMs: number
  /**
   * The rules the engine may write for the elements it reads, one for each set of colours it gives. A page that moves a colour by script
   * (an animation step by step) asks for a new one at every value, and none is ever taken back: beyond, it stops reading elements (the
   * sheets stay), as for a page that keeps it too busy.
   */
  maxRules: number
  /** The values each of the engine's memories may hold (colours worked out, pictures looked at): a full one is emptied and filled again. */
  maxRemembered: number
}

export const READABLE_BUDGET: ReadableBudget = { startMs: 1500, firstChunkMs: 12, chunkMs: 8, maxElements: 60_000, busyMs: 1500, busyWindowMs: 10_000, maxRules: 5000, maxRemembered: 20_000 }

export interface ReadableEngineConfig {
  scheme: ReadableScheme
  /** The way back should the engine fail once started: the inversion, which it then puts on the page itself. */
  fallbackCss: string
  budget: ReadableBudget
}

export type ReadableCommand = 'start' | 'stop' | 'stats'

/** The answer of `start`, read by the shell no further than its shape (`readableStarted`, dark-sites.ts). */
export type ReadableStart = { ok: true; already?: boolean; startMs: number; sheets: number; unreadable: number; scanned: number; marked: number } | { ok: false; reason: string }

/** Contrast thresholds of WCAG 2 (RGAA criteria 3.2 and 3.3): text, large text (24 px, or 18.66 px bold) and the parts of a control. */
export const CONTRAST_TEXT = 4.5
export const CONTRAST_LARGE = 3
export const CONTRAST_UI = 3

// ---------- looking at the page ----------

/**
 * Runs in the page: the luminance (0 to 1) of the colour that is behind five points of the window, found by walking up from the element
 * under each point to the first element with an opaque background; the page's canvas when there is none (the background of the root, else
 * the one of the body, which becomes the canvas's; white unless the page declares a dark colour scheme). A background image with no colour
 * under it counts as unknown (light), the safe side: a page that is inverted by mistake is still readable, and a light one is left alone by Light.
 * Also says whether the page declares no background at all, so that the browser's canvas shows (`bare` when that canvas is white, `bareDark` when
 * a dark colour scheme makes it dark), and whether the document is a PDF by its MIME type (`pdf`: the viewer draws it, whatever the address).
 * It runs in the readable world (`READABLE_WORLD`), so that the page cannot change what it reads, and reads the page as it is without the
 * engine: a page the engine recoloured is suspended for the time of the read (its sheets off and on again in the same task: nothing is painted).
 */
export const DARK_PROBE_SCRIPT = `(() => {
  const engine = globalThis.${READABLE_STATE}
  const resume = engine && typeof engine.suspend === 'function' ? engine.suspend() : null
  try {
    const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    const parse = (value) => {
      const m = /^rgba?\\(([^)]+)\\)$/.exec(value)
      if (!m) return null
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
      return p.length >= 3 && p.every(Number.isFinite) ? { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } : null
    }
    const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
    const solid = (el) => { if (!el) return null; const c = parse(getComputedStyle(el).backgroundColor); return c && c.a >= 0.5 ? c : null }
    const declared = solid(document.documentElement) || solid(document.body)
    const canvas = declared ? luminance(declared) : /dark/.test(getComputedStyle(document.documentElement).colorScheme || '') ? 0 : 1
    const at = (x, y) => {
      for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
        const c = solid(el)
        if (c) return luminance(c)
        if (getComputedStyle(el).backgroundImage !== 'none') return 1
      }
      return canvas
    }
    const w = window.innerWidth, h = window.innerHeight
    return { samples: [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([fx, fy]) => at(Math.floor(w * fx), Math.floor(h * fy))), bare: !declared && canvas === 1, bareDark: !declared && canvas === 0, pdf: document.contentType === 'application/pdf' }
  } finally {
    if (resume) resume()
  }
})()`

// ---------- the colour arithmetic and the rewriting of a stylesheet (self-contained) ----------

/** Everything that does not need the page. Self-contained (see the top of the file). */
export function readableKit() {
  const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
  const toLinear = (c: number): number => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  const toGamma = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255
  const byte = (v: number): number => Math.round(clamp(toGamma(clamp(v, 0, 1)), 0, 255))

  // OKLab (Björn Ottosson), from and to linear sRGB.
  const linearToOklab = (r: number, g: number, b: number): [number, number, number] => {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
  }
  const oklabToLinear = (L: number, a: number, b: number): [number, number, number] => {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3)
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3)
    const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3)
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
  }
  const toOklch = (c: Rgb): Oklch => {
    const [L, A, B] = linearToOklab(toLinear(c.r), toLinear(c.g), toLinear(c.b))
    const h = (Math.atan2(B, A) * 180) / Math.PI
    return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h }
  }
  const inGamut = (lin: [number, number, number]): boolean => lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4)
  /** The sRGB colour of a lightness, chroma and hue; a chroma the gamut cannot hold at that lightness is reduced (the hue is kept). */
  const fromOklch = (l: number, c: number, h: number, a = 1): Rgb => {
    const L = clamp(l, 0, 1)
    const rad = (h * Math.PI) / 180
    const at = (C: number): [number, number, number] => oklabToLinear(L, C * Math.cos(rad), C * Math.sin(rad))
    let lin = at(c)
    if (!inGamut(lin)) {
      let lo = 0
      let hi = c
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2
        if (inGamut(at(mid))) lo = mid
        else hi = mid
      }
      lin = at(lo)
    }
    return { r: byte(lin[0]), g: byte(lin[1]), b: byte(lin[2]), a }
  }
  const fromLinear = (lin: [number, number, number], a: number): Rgb => ({ r: byte(lin[0]), g: byte(lin[1]), b: byte(lin[2]), a })

  // ---- WCAG ----
  /** The relative luminance of WCAG 2. */
  const luminance = (c: Rgb): number => 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b)
  const contrast = (x: Rgb, y: Rgb): number => {
    const a = luminance(x)
    const b = luminance(y)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }
  /** `top` painted over an opaque `bottom` (what the browser shows), opaque. */
  const over = (top: Rgb, bottom: Rgb): Rgb => {
    const a = clamp(top.a, 0, 1)
    return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 }
  }
  /** The contrast of `fg`, faded by `alpha` (its own alpha and the opacity of what holds it), over the opaque `bg`. */
  const contrastOver = (fg: Rgb, bg: Rgb, alpha = fg.a): number => contrast(over({ ...fg, a: alpha }, bg), bg)
  /**
   * The colour nearest to `fg` (same hue, chroma as the gamut allows, only the lightness moves) that reaches `target` over `bg`: toward the
   * side with more room first, then the other. A colour that reaches it already comes back as it is; when no lightness can (a text faded too
   * much), the end that comes closest.
   */
  const reach = (fg: Rgb, bg: Rgb, target: number, alpha = fg.a): Rgb => {
    const ratio = (c: Rgb): number => contrastOver(c, bg, alpha)
    if (ratio(fg) >= target) return fg
    const { l, c, h } = toOklch(fg)
    const toward = (end: number): Rgb | null => {
      if (ratio(fromOklch(end, c, h, fg.a)) < target) return null
      let lo = l
      let hi = end
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2
        if (ratio(fromOklch(mid, c, h, fg.a)) >= target) hi = mid
        else lo = mid
      }
      return fromOklch(hi, c, h, fg.a)
    }
    const lighter = contrast({ r: 255, g: 255, b: 255, a: 1 }, bg) >= contrast({ r: 0, g: 0, b: 0, a: 1 }, bg)
    const found = toward(lighter ? 1 : 0) ?? toward(lighter ? 0 : 1)
    if (found) return found
    const white = { r: 255, g: 255, b: 255, a: fg.a }
    const black = { r: 0, g: 0, b: 0, a: fg.a }
    return ratio(white) >= ratio(black) ? white : black
  }

  // ---- the lightness of each role ----
  /**
   * Where a lightness (OKLab L, 0 to 1) goes, for a role and a scheme. `canvas` is the lightness of the page's own background, which becomes
   * the darkest background in Dark (the lightest in Light). Dark, for a light page: backgrounds lighter than L 0.45 go into 0.20 to 0.42 in reverse
   * order (white is 0.20) and darker ones stay; text darker than 0.65 goes into 0.68 to 0.93 (black is 0.93) and lighter text stays; borders are
   * mirrored into 0.20 to 0.80 so that they keep their contrast with the background; dark shadows stay. A faint background (alpha under 0.25:
   * a hover tint, a stripe) is treated as ink, like text. A strong colour (chroma) mapped as a background keeps a little more light, up to
   * 0.08. Light is the mirror for a dark page.
   */
  const lightness = (L: number, role: ColourRole | 'tint', scheme: ReadableScheme, canvas: number, chroma = 0): number => {
    if (scheme === 'dark') {
      if (role === 'fg' || role === 'tint') return L >= 0.65 ? L : 0.93 - 0.25 * (L / 0.65)
      if (role === 'border' || (role === 'shadow' && L >= 0.5)) return 0.2 + (1 - L) * 0.6
      if (role === 'shadow' || L < 0.45) return L
      const top = clamp(canvas, 0.7, 1)
      if (L >= top) return Math.max(0.14, 0.2 - (L - top) * 0.5)
      // A strong colour (a brand's bar, a button) keeps some of its light, so that it stays that colour and not a muddy brown.
      return 0.2 + 0.22 * Math.pow((top - L) / (top - 0.45), 0.75) + Math.min(0.08, chroma * 0.4)
    }
    if (role === 'fg' || role === 'tint') return L <= 0.45 ? L : 0.2 + 0.28 * ((1 - L) / 0.55)
    if (role === 'border' || (role === 'shadow' && L >= 0.5)) return 0.985 - L * 0.6
    if (role === 'shadow' || L > 0.6) return L
    const base = clamp(canvas, 0, 0.4)
    if (L <= base) return Math.min(1, 0.985 + (base - L) * 0.1)
    return 0.985 - 0.2 * Math.pow((L - base) / (0.6 - base), 0.75)
  }
  // A faint background (a hover, a stripe) is ink; a stronger veil (a backdrop, a shade) is a background, so that a dimming backdrop stays dark.
  const roleOf = (c: Rgb, role: ColourRole): ColourRole | 'tint' => (role === 'bg' && c.a < 0.25 ? 'tint' : role)
  /** A colour mapped for its role: hue kept, chroma as the gamut allows, alpha kept. */
  const recolour = (c: Rgb, role: ColourRole, scheme: ReadableScheme, canvas: number): Rgb => {
    if (c.a === 0) return c
    const o = toOklch(c)
    const l = lightness(o.l, roleOf(c, role), scheme, canvas, o.c)
    return Math.abs(l - o.l) < 0.002 ? c : fromOklch(l, o.c, o.h, c.a)
  }
  /**
   * Whether a colour on the page already belongs to the scheme, so that the element pass leaves it: what `recolour` gives always does (its
   * outputs and the colours it keeps are on one side of these lines), and a colour that came from somewhere the sheets did not reach does not.
   * Borders are mirrored, so only those `recolour` never gives are told (lighter than L 0.82 in Dark, darker than 0.36 in Light).
   */
  const inScheme = (c: Rgb, role: ColourRole, scheme: ReadableScheme): boolean => {
    const { l: L, c: chroma } = toOklch(c)
    const r = roleOf(c, role)
    if (r === 'shadow') return true
    // A strong colour mapped as a background in Dark keeps up to 0.08 more light (see `lightness`).
    if (scheme === 'dark') return r === 'fg' || r === 'tint' ? L >= 0.62 : r === 'border' ? L <= 0.82 : L <= 0.46 + Math.min(0.08, chroma * 0.4)
    return r === 'fg' || r === 'tint' ? L <= 0.5 : r === 'border' ? L >= 0.36 : L >= 0.58
  }

  // ---- reading and writing colours ----
  const NAMES: Record<string, string> = {}
  const NAME_LIST = 'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32'.split(' ')
  for (let i = 0; i + 1 < NAME_LIST.length; i += 2) NAMES[NAME_LIST[i]!] = NAME_LIST[i + 1]!
  const hex = (h: string): Rgb | null => {
    if (!/^[0-9a-f]+$/i.test(h) || ![3, 4, 6, 8].includes(h.length)) return null
    const full = h.length <= 4 ? [...h].map((d) => d + d).join('') : h
    const at = (i: number): number => parseInt(full.slice(i, i + 2), 16)
    return { r: at(0), g: at(2), b: at(4), a: full.length === 8 ? at(6) / 255 : 1 }
  }
  const num = (s: string | undefined, percentOf: number): number => {
    if (s === undefined || s === 'none') return 0
    return s.endsWith('%') ? (parseFloat(s) / 100) * percentOf : parseFloat(s)
  }
  const angle = (s: string | undefined): number => {
    if (s === undefined || s === 'none') return 0
    const v = parseFloat(s)
    return s.endsWith('turn') ? v * 360 : s.endsWith('grad') ? v * 0.9 : s.endsWith('rad') ? (v * 180) / Math.PI : v
  }
  const hslToRgb = (h: number, s: number, l: number, a: number): Rgb => {
    const k = (n: number): number => (n + h / 30) % 12
    const f = (n: number): number => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
    return { r: Math.round(clamp(f(0), 0, 1) * 255), g: Math.round(clamp(f(8), 0, 1) * 255), b: Math.round(clamp(f(4), 0, 1) * 255), a }
  }
  const rgbToHsl = (c: Rgb): [number, number, number] => {
    const r = c.r / 255
    const g = c.g / 255
    const b = c.b / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const l = (max + min) / 2
    const d = max - min
    if (d === 0) return [0, 0, l]
    const s = d / (1 - Math.abs(2 * l - 1))
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    return [(h * 60 + 360) % 360, s, l]
  }
  // CIE Lab (D50) to linear sRGB (D65), the matrices of CSS Color 4.
  const labToLinear = (L: number, a: number, b: number): [number, number, number] => {
    const fy = (L + 16) / 116
    const fx = fy + a / 500
    const fz = fy - b / 200
    const inv = (t: number): number => (t * t * t > 216 / 24389 ? t * t * t : (116 * t - 16) / (24389 / 27))
    const X = 0.96422 * inv(fx)
    const Y = L > 8 ? Math.pow(fy, 3) : L / (24389 / 27)
    const Z = 0.82521 * inv(fz)
    const x = 0.9554734527042182 * X - 0.023098536874261423 * Y + 0.0632593086610217 * Z
    const y = -0.028369706963208136 * X + 1.0099954580058226 * Y + 0.021041398966943008 * Z
    const z = 0.012314001688319899 * X - 0.020507696433477912 * Y + 1.3303659366080753 * Z
    return [3.2409699419045226 * x - 1.537383177570094 * y - 0.4986107602930034 * z, -0.9692436362808796 * x + 1.8759675015077202 * y + 0.04155505740717559 * z, 0.05563007969699366 * x - 0.20397695888897652 * y + 1.0569715142428786 * z]
  }
  const p3ToLinear = (r: number, g: number, b: number): [number, number, number] => {
    const lin = (v: number): number => toLinear(v * 255)
    const R = lin(r)
    const G = lin(g)
    const B = lin(b)
    const X = 0.4865709486482162 * R + 0.26566769316909306 * G + 0.1982172852343625 * B
    const Y = 0.2289745640697488 * R + 0.6917385218365064 * G + 0.079286914093745 * B
    const Z = 0.04511338185890264 * G + 1.043944368900976 * B
    return [3.2409699419045226 * X - 1.537383177570094 * Y - 0.4986107602930034 * Z, -0.9692436362808796 * X + 1.8759675015077202 * Y + 0.04155505740717559 * Z, 0.05563007969699366 * X - 0.20397695888897652 * Y + 1.0569715142428786 * Z]
  }
  /** A CSS colour as the page writes it or as a computed style gives it; null for anything else (a keyword of the system, `currentcolor`, `var()`). */
  const parse = (text: string): Rgb | null => {
    const v = text.trim().toLowerCase()
    if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
    if (v.startsWith('#')) return hex(v.slice(1))
    if (Object.hasOwn(NAMES, v)) return hex(NAMES[v]!)
    const m = /^([a-z-]+)\(([^()]*)\)$/.exec(v)
    if (!m) return null
    const fn = m[1]!
    const [main = '', alphaText] = m[2]!.split('/')
    const parts = main.trim().split(/[\s,]+/).filter(Boolean)
    const alpha = (at: number): number => clamp(alphaText !== undefined ? num(alphaText.trim(), 1) : parts[at] !== undefined ? num(parts[at], 1) : 1, 0, 1)
    const ok = (c: Rgb): Rgb | null => ([c.r, c.g, c.b, c.a].every(Number.isFinite) ? c : null)
    if (fn === 'rgb' || fn === 'rgba') {
      if (parts.length < 3) return null
      return ok({ r: Math.round(clamp(num(parts[0], 255), 0, 255)), g: Math.round(clamp(num(parts[1], 255), 0, 255)), b: Math.round(clamp(num(parts[2], 255), 0, 255)), a: alpha(3) })
    }
    if (fn === 'hsl' || fn === 'hsla') {
      if (parts.length < 3) return null
      return ok(hslToRgb(angle(parts[0]), clamp(num(parts[1], 1) / (parts[1]!.endsWith('%') ? 1 : 100), 0, 1), clamp(num(parts[2], 1) / (parts[2]!.endsWith('%') ? 1 : 100), 0, 1), alpha(3)))
    }
    if (fn === 'hwb') {
      if (parts.length < 3) return null
      let w = clamp(num(parts[1], 1) / (parts[1]!.endsWith('%') ? 1 : 100), 0, 1)
      let bl = clamp(num(parts[2], 1) / (parts[2]!.endsWith('%') ? 1 : 100), 0, 1)
      if (w + bl >= 1) {
        const grey = Math.round((w / (w + bl)) * 255)
        return ok({ r: grey, g: grey, b: grey, a: alpha(3) })
      }
      const pure = hslToRgb(angle(parts[0]), 1, 0.5, 1)
      const f = (x: number): number => Math.round((x / 255) * (1 - w - bl) * 255 + w * 255)
      return ok({ r: f(pure.r), g: f(pure.g), b: f(pure.b), a: alpha(3) })
    }
    if (fn === 'oklch' || fn === 'oklab') {
      if (parts.length < 3) return null
      const L = clamp(num(parts[0], 1), 0, 1)
      if (fn === 'oklch') {
        const lch = fromOklch(L, Math.max(0, num(parts[1], 0.4)), angle(parts[2]), alpha(3))
        return ok(lch)
      }
      return ok(fromLinear(oklabToLinear(L, num(parts[1], 0.4), num(parts[2], 0.4)), alpha(3)))
    }
    if (fn === 'lab' || fn === 'lch') {
      if (parts.length < 3) return null
      const L = clamp(num(parts[0], 100), 0, 100)
      if (fn === 'lab') return ok(fromLinear(labToLinear(L, num(parts[1], 125), num(parts[2], 125)), alpha(3)))
      const C = Math.max(0, num(parts[1], 150))
      const h = (angle(parts[2]) * Math.PI) / 180
      return ok(fromLinear(labToLinear(L, C * Math.cos(h), C * Math.sin(h)), alpha(3)))
    }
    if (fn === 'color') {
      if (parts.length < 4) return null
      const [space, ...rest] = parts
      const ch = (i: number): number => num(rest[i], 1)
      const a = clamp(alphaText !== undefined ? num(alphaText.trim(), 1) : 1, 0, 1)
      if (space === 'srgb') return ok({ r: Math.round(clamp(ch(0), 0, 1) * 255), g: Math.round(clamp(ch(1), 0, 1) * 255), b: Math.round(clamp(ch(2), 0, 1) * 255), a })
      if (space === 'srgb-linear') return ok(fromLinear([ch(0), ch(1), ch(2)], a))
      if (space === 'display-p3') return ok(fromLinear(p3ToLinear(ch(0), ch(1), ch(2)), a))
      return null
    }
    return null
  }
  const format = (c: Rgb): string => {
    const r = Math.round(c.r)
    const g = Math.round(c.g)
    const b = Math.round(c.b)
    return c.a >= 0.999 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.round(c.a * 1000) / 1000})`
  }

  // ---- the stylesheets ----
  /** The properties that hold colours, and the role of their colours. */
  const PROPS: Record<string, ColourRole> = {
    color: 'fg',
    'caret-color': 'fg',
    'text-decoration-color': 'fg',
    'text-emphasis-color': 'fg',
    '-webkit-text-fill-color': 'fg',
    '-webkit-text-stroke-color': 'fg',
    fill: 'fg',
    stroke: 'fg',
    'background-color': 'bg',
    'background-image': 'bg',
    '-webkit-tap-highlight-color': 'bg',
    'border-top-color': 'border',
    'border-right-color': 'border',
    'border-bottom-color': 'border',
    'border-left-color': 'border',
    'border-block-start-color': 'border',
    'border-block-end-color': 'border',
    'border-inline-start-color': 'border',
    'border-inline-end-color': 'border',
    'outline-color': 'border',
    'column-rule-color': 'border',
    'scrollbar-color': 'border',
    'box-shadow': 'shadow',
    'text-shadow': 'shadow'
  }
  /** The shorthands a longhand may come from: a shorthand that holds a `var()` leaves its longhands empty in the CSSOM, and is rewritten whole. */
  const shorthandsOf = (prop: string): string[] => {
    if (prop.startsWith('background-')) return ['background']
    const side = /^border-(top|right|bottom|left)-color$/.exec(prop)
    if (side) return ['border', `border-${side[1]}`, 'border-color']
    const logical = /^border-(block|inline)-(start|end)-color$/.exec(prop)
    if (logical) return ['border', `border-${logical[1]}`, `border-${logical[1]}-${logical[2]}`, `border-${logical[1]}-color`, 'border-color']
    if (prop === 'outline-color') return ['outline']
    if (prop === 'column-rule-color') return ['column-rule']
    if (prop === 'text-decoration-color') return ['text-decoration']
    if (prop === 'text-emphasis-color') return ['text-emphasis']
    return []
  }
  const COLOUR_FUNCTIONS = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/
  const WORD = /-?[a-zA-Z_][\w-]*/y
  const HEX = /#[0-9a-fA-F]+/y
  /** The index of the `)` that closes the `(` at `open` (quotes skipped); the end of the text when there is none. */
  const closing = (text: string, open: number): number => {
    let depth = 0
    for (let i = open; i < text.length; i++) {
      const ch = text[i]
      if (ch === '"' || ch === "'") {
        const end = text.indexOf(ch, i + 1)
        i = end < 0 ? text.length : end
      } else if (ch === '(') depth++
      else if (ch === ')' && --depth === 0) return i
    }
    return text.length
  }
  /** The first comma of `text` outside any parentheses, or -1. */
  const topComma = (text: string): number => {
    let depth = 0
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      else if (ch === ',' && depth === 0) return i
    }
    return -1
  }

  /** How a stylesheet is rewritten: a colour mapped for a role, and the name of the twin of a custom property for a role. */
  interface RewriteContext {
    map(c: Rgb, role: ColourRole): Rgb
    twin(role: ColourRole, name: string): string
    /** The custom properties used for colours, and for which roles (see `collect`). */
    need: Map<string, Set<ColourRole>>
    /** The colours a page writes in a way `parse` does not read (the page resolves them); optional. */
    resolve?(text: string): Rgb | null
    /** Called every so often: throws to stop a rewriting that takes too long. */
    tick?(): void
    /**
     * The declarations of a rule whose colours the CSSOM lost (a shorthand holding a `var()` and a longhand of it set after it in the same block:
     * Chromium then serializes neither), from what the page computes for an element the selector matches; '' when it cannot say.
     */
    recover?(selector: string, lost: Array<[string, ColourRole]>): string
    /** Rewritten values already made, by role and value (a value comes back thousands of times in a big site's sheets). */
    memo?: Map<string, string>
    /** The values `memo` may hold: full, it is emptied before the next one is kept. */
    memoMax?: number
    /**
     * The address of the stylesheet whose rules are being copied (`CSSStyleSheet.href`), absent for a sheet written in the page. Chromium
     * gives a declared `url(../img/x.png)` back as it was written, and the copy is a constructed sheet, whose relative addresses are read
     * from the address of the document: without this, the copy of `/static/css/site.css` would ask for `/img/x.png`.
     */
    base?: string | undefined
  }
  /** Whether a value holds an address (`url()`, or the strings of an `image-set()`). */
  const holdsAddress = (value: string): boolean => value.includes('url(') || value.includes('image-set(')
  const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
  /**
   * A relative address as the sheet at `base` reads it, in full; the address as it is when it is whole already, when it only names a part of
   * the document (`#gradient`: a paint server or a filter of the page itself), or when it cannot be read.
   */
  const absolute = (address: string, base: string): string => {
    const text = address.trim()
    if (text === '' || text.startsWith('#') || SCHEME.test(text)) return address
    try {
      return new URL(text, base).href
    } catch {
      return address
    }
  }
  /** A CSS string (with its quotes) holding `address`. */
  const quoted = (address: string): string => `"${address.replace(/[\\"]/g, '\\$&')}"`
  /** What is between the quotes of a CSS string, its escapes read; null for an escape this does not read (a code point in hexadecimal). */
  const unquoted = (text: string): string | null => {
    const inner = text.slice(1, -1)
    if (!inner.includes('\\')) return inner
    return /\\[0-9a-fA-F\n]/.test(inner) ? null : inner.replace(/\\(.)/g, '$1')
  }
  /** A whole `url(…)` with its address read from `base`; as it is when it has nothing to resolve. */
  const urlFrom = (token: string, base: string): string => {
    if (!token.endsWith(')')) return token
    const inner = token.slice(token.indexOf('(') + 1, -1).trim()
    const first = inner[0]
    const address = first === '"' || first === "'" ? (inner.length >= 2 && inner.endsWith(first) ? unquoted(inner) : null) : /[\\\s"'()]/.test(inner) ? null : inner
    if (address === null) return token
    const whole = absolute(address, base)
    return whole === address ? token : `url(${quoted(whole)})`
  }
  /** Every `url(…)` of a value that is not rewritten for its colours (a keyframe copies all its declarations), read from `base`. */
  const addressesFrom = (value: string, base: string): string => {
    let out = ''
    let i = 0
    while (i < value.length) {
      const ch = value[i]!
      if (ch === '"' || ch === "'") {
        const end = value.indexOf(ch, i + 1)
        const stop = end < 0 ? value.length : end + 1
        out += value.slice(i, stop)
        i = stop
      } else if (value.startsWith('url(', i) && (i === 0 || !/[\w-]/.test(value[i - 1]!))) {
        const close = closing(value, i + 3)
        out += urlFrom(value.slice(i, close + 1), base)
        i = close + 1
      } else {
        out += ch
        i++
      }
    }
    return out
  }
  /** `fn` once per role and value, through `ctx.memo` when it has one. */
  const remembered = (kind: string, value: string, role: ColourRole, ctx: RewriteContext, fn: () => string): string => {
    if (!ctx.memo) return fn()
    // The same relative address is another file in another sheet: such a value is remembered for its sheet only.
    const key = ctx.base !== undefined && holdsAddress(value) ? `${kind}${role}\u0000${value}\u0000${ctx.base}` : `${kind}${role}\u0000${value}`
    let out = ctx.memo.get(key)
    if (out === undefined) {
      out = fn()
      if (ctx.memoMax !== undefined && ctx.memo.size >= ctx.memoMax) ctx.memo.clear()
      ctx.memo.set(key, out)
    }
    return out
  }
  const colourOf = (text: string, ctx: RewriteContext): Rgb | null => parse(text) ?? (ctx.resolve ? ctx.resolve(text) : null)

  /** A value with every colour in it mapped for `role`, and every `var(--x)` reading the twin of `--x` for that role first. */
  /** `addresses`: the strings of the value are addresses (the arguments of an `image-set()`), read from the sheet as a `url()` is. */
  const rewrite = (value: string, role: ColourRole, ctx: RewriteContext, addresses = false): string => {
    let out = ''
    let i = 0
    while (i < value.length) {
      const ch = value[i]!
      if (ch === '"' || ch === "'") {
        const end = value.indexOf(ch, i + 1)
        const stop = end < 0 ? value.length : end + 1
        const text = value.slice(i, stop)
        const address = addresses && ctx.base !== undefined && end >= 0 ? unquoted(text) : null
        const whole = address === null ? null : absolute(address, ctx.base!)
        out += whole === null || whole === address ? text : quoted(whole)
        i = stop
        continue
      }
      if (ch === '#') {
        HEX.lastIndex = i
        const m = HEX.exec(value)
        const c = m ? hex(m[0].slice(1)) : null
        if (m && c) {
          out += format(ctx.map(c, role))
          i += m[0].length
          continue
        }
      }
      if (/[a-zA-Z_-]/.test(ch) && (i === 0 || !/[\w-]/.test(value[i - 1]!))) {
        WORD.lastIndex = i
        const m = WORD.exec(value)
        if (m) {
          const word = m[0]
          const after = i + word.length
          if (value[after] === '(') {
            const close = closing(value, after)
            const inner = value.slice(after + 1, close)
            const name = word.toLowerCase()
            if (name === 'url') out += ctx.base === undefined ? value.slice(i, close + 1) : urlFrom(value.slice(i, close + 1), ctx.base)
            else if (name === 'var') out += rewriteVar(inner, role, ctx)
            else if (COLOUR_FUNCTIONS.test(name) && !inner.includes('(')) {
              const c = colourOf(`${name}(${inner})`, ctx)
              out += c ? format(ctx.map(c, role)) : value.slice(i, close + 1)
            } else out += `${word}(${rewrite(inner, role, ctx, name.endsWith('image-set'))})`
            i = close + 1
            continue
          }
          const lower = word.toLowerCase()
          out += Object.hasOwn(NAMES, lower) ? format(ctx.map(hex(NAMES[lower]!)!, role)) : word
          i = after
          continue
        }
      }
      out += ch
      i++
    }
    return out
  }
  const rewriteVar = (inner: string, role: ColourRole, ctx: RewriteContext): string => {
    const comma = topComma(inner)
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim()
    if (!name.startsWith('--')) return `var(${inner})`
    const fallback = comma < 0 ? '' : `,${rewrite(inner.slice(comma + 1), role, ctx)}`
    return `var(${ctx.twin(role, name)},var(${name}${fallback}))`
  }
  const TRIPLE_RGB = /^\s*(\d{1,3}(?:\.\d+)?)(\s*,\s*|\s+)(\d{1,3}(?:\.\d+)?)\2(\d{1,3}(?:\.\d+)?)\s*$/
  const TRIPLE_HSL = /^\s*(-?\d+(?:\.\d+)?)(?:deg)?(\s*,\s*|\s+)(\d+(?:\.\d+)?)%\2(\d+(?:\.\d+)?)%\s*$/
  /** Whether a custom property may hold a colour: a colour, a reference, or the channels a design system feeds `rgb(var(--x))` or `hsl(var(--x))` with. */
  const colourish = (value: string): boolean =>
    /#[0-9a-f]{3}|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|var|light-dark|color-mix)\(/i.test(value) || TRIPLE_RGB.test(value) || TRIPLE_HSL.test(value) || Object.hasOwn(NAMES, value.trim().toLowerCase())
  /**
   * The twin of a custom property for a role: its colours mapped, its channels mapped in the same notation; '' when the twin would be the property
   * itself (no reference, and no colour the role moves), so that none is written.
   */
  const twinValue = (value: string, role: ColourRole, ctx: RewriteContext): string => {
    let moved = value.includes('var(')
    const watch: RewriteContext = {
      ...ctx,
      map: (c, r) => {
        const out = ctx.map(c, r)
        if (out.r !== c.r || out.g !== c.g || out.b !== c.b || out.a !== c.a) moved = true
        return out
      }
    }
    const twinned = twinOf(value, role, watch)
    return moved ? twinned : ''
  }
  const twinOf = (value: string, role: ColourRole, ctx: RewriteContext): string => {
    const rgb = TRIPLE_RGB.exec(value)
    if (rgb && [rgb[1], rgb[3], rgb[4]].every((v) => Number(v) <= 255)) {
      const c = ctx.map({ r: Number(rgb[1]), g: Number(rgb[3]), b: Number(rgb[4]), a: 1 }, role)
      return [c.r, c.g, c.b].map((v) => Math.round(v)).join(rgb[2])
    }
    const hsl = TRIPLE_HSL.exec(value)
    if (hsl) {
      const c = ctx.map(hslToRgb(Number(hsl[1]), clamp(Number(hsl[3]) / 100, 0, 1), clamp(Number(hsl[4]) / 100, 0, 1), 1), role)
      const [h, s, l] = rgbToHsl(c)
      const round = (v: number): number => Math.round(v * 10) / 10
      return `${round(h)}${hsl[2]}${round(s * 100)}%${hsl[2]}${round(l * 100)}%`
    }
    return rewrite(value, role, ctx)
  }
  const refs = (value: string): string[] => (value.includes('var(') ? [...value.matchAll(/var\(\s*(--[^\s,)]+)/g)].map((m) => m[1]!) : [])

  /** The colour declarations of a block, rewritten (the others are not repeated). `lost` collects those the CSSOM does not give back. */
  const declarations = (style: Dom, ctx: RewriteContext, lost?: Array<[string, ColourRole]>): string => {
    let out = ''
    const done = new Set<string>()
    for (let i = 0; i < style.length; i++) {
      const prop: unknown = style[i]
      // A block of descriptors (not properties) does not index its names: nothing in it is a colour of the page.
      if (typeof prop !== 'string') continue
      const important = style.getPropertyPriority(prop) === 'important' ? ' !important' : ''
      if (prop.startsWith('--')) {
        const roles = ctx.need.get(prop)
        if (!roles || roles.size === 0) continue
        const value: string = style.getPropertyValue(prop)
        if (!colourish(value)) continue
        for (const role of roles) {
          const twinned = remembered('t', value, role, ctx, () => twinValue(value, role, ctx))
          // A twin equal to its property is left out: `var(twin, var(--x))` then reads `--x` itself.
          if (twinned !== '') out += `${ctx.twin(role, prop)}:${twinned}${important};`
        }
        continue
      }
      const role = PROPS[prop]
      if (!role) continue
      const value: string = style.getPropertyValue(prop)
      if (value === '') {
        let found = false
        for (const short of shorthandsOf(prop)) {
          if (done.has(short)) {
            found = true
            break
          }
          const whole: string = style.getPropertyValue(short)
          if (!whole.includes('var(')) continue
          done.add(short)
          found = true
          out += `${short}:${remembered('v', whole, role, ctx, () => rewrite(whole, role, ctx))}${style.getPropertyPriority(short) === 'important' ? ' !important' : ''};`
          break
        }
        if (!found && lost) lost.push([prop, role])
        continue
      }
      // Every colour declaration is repeated, even one kept as it is (`transparent`, `inherit`): the copy keeps the order of the page's rules.
      out += `${prop}:${remembered('v', value, role, ctx, () => rewrite(value, role, ctx))}${important};`
    }
    return out
  }
  /** Every declaration of a keyframe, colours rewritten: a copy of keyframes replaces the page's whole. Null when it holds no colour. */
  const keyframe = (style: Dom, ctx: RewriteContext): string | null => {
    let out = ''
    let coloured = false
    for (let i = 0; i < style.length; i++) {
      const prop: string = style[i]
      const value: string = style.getPropertyValue(prop)
      const role = PROPS[prop]
      if (role && value !== '') coloured = true
      out += `${prop}:${role ? rewrite(value, role, ctx) : ctx.base !== undefined && value.includes('url(') ? addressesFrom(value, ctx.base) : value};`
    }
    return coloured ? out : null
  }
  /**
   * Declarations nested in a rule after other rules (CSS nesting): a rule with a style and nothing else. A block of descriptors that looks the same
   * (`@position-try`) indexes no property name, and `declarations` skips it.
   */
  const nestedDeclarations = (rule: Dom): boolean => rule.type === 0 && !!rule.style && rule.selectorText === undefined && !rule.cssRules
  const ident = (name: string): string => (/^-?[a-zA-Z_][\w-]*$/.test(name) ? name : JSON.stringify(name))
  /** The words that open a grouping rule (`@media …`), or null for a rule that is not one this copies. */
  const prelude = (rule: Dom): string | null => {
    if (rule.type === 4) return `@media ${rule.media.mediaText}`
    if (rule.type === 12) return `@supports ${rule.conditionText}`
    if (rule.type !== 0 || !rule.cssRules) return null
    // A layer block (`@layer name { … }`) joins the page's layer of that name, after its rules; an anonymous one is a new layer.
    if (typeof rule.name === 'string' && !('nameList' in rule) && !('containerName' in rule)) return rule.name ? `@layer ${rule.name}` : '@layer'
    const text = String(rule.cssText)
    const at = text.indexOf('{')
    return text.startsWith('@') && at > 0 ? text.slice(0, at).trim() : null
  }
  /** Calls `visit` for every style rule of `rules`, imported sheets and grouping rules included; counts the sheets it cannot read. */
  const eachStyle = (rules: Dom, visit: (style: Dom) => void, unreadable: { count: number }): void => {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]
      if (rule.type === 1 || nestedDeclarations(rule)) visit(rule.style)
      if (rule.type === 3) {
        try {
          if (rule.styleSheet) eachStyle(rule.styleSheet.cssRules, visit, unreadable)
        } catch {
          unreadable.count++
        }
      } else if (rule.type === 7) for (let k = 0; k < rule.cssRules.length; k++) visit(rule.cssRules[k].style)
      else if (rule.cssRules && rule.type !== 7) eachStyle(rule.cssRules, visit, unreadable)
    }
  }
  /** Notes which custom properties feed which colour roles (`need`) and which custom properties each one reads (`deps`). */
  const collect = (rules: Dom, need: Map<string, Set<ColourRole>>, deps: Map<string, Set<string>>, unreadable: { count: number }): void => {
    const add = (name: string, role: ColourRole): void => {
      const roles = need.get(name) ?? new Set<ColourRole>()
      roles.add(role)
      need.set(name, roles)
    }
    eachStyle(
      rules,
      (style) => {
        for (let i = 0; i < style.length; i++) {
          const prop: unknown = style[i]
          if (typeof prop !== 'string') continue
          if (prop.startsWith('--')) {
            const value: string = style.getPropertyValue(prop)
            if (!value.includes('var(')) continue
            const set = deps.get(prop) ?? new Set<string>()
            for (const name of refs(value)) set.add(name)
            deps.set(prop, set)
            continue
          }
          const role = PROPS[prop]
          if (!role) continue
          let value: string = style.getPropertyValue(prop)
          if (value === '') value = shorthandsOf(prop).map((short) => String(style.getPropertyValue(short))).find((whole) => whole.includes('var(')) ?? ''
          if (value.includes('var(')) for (const name of refs(value)) add(name, role)
        }
      },
      unreadable
    )
  }
  /** Gives each custom property the roles of the properties that read it, through any chain of references. */
  const closeNeed = (need: Map<string, Set<ColourRole>>, deps: Map<string, Set<string>>): void => {
    let changed = true
    while (changed) {
      changed = false
      for (const [name, roles] of need) {
        for (const dep of deps.get(name) ?? []) {
          const set = need.get(dep) ?? new Set<ColourRole>()
          if (!need.has(dep)) need.set(dep, set)
          for (const role of roles)
            if (!set.has(role)) {
              set.add(role)
              changed = true
            }
        }
      }
    }
  }
  /** The text of the copy of `rules`: the same selectors, order, importance and grouping, with only the colour declarations, rewritten. */
  const sheetText = (rules: Dom, ctx: RewriteContext, unreadable: { count: number }, nestedIn = false): string => {
    let out = ''
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]
      if ((i & 127) === 0 && ctx.tick) ctx.tick()
      if (rule.type === 1) {
        const lost: Array<[string, ColourRole]> = []
        let own = declarations(rule.style, ctx, lost)
        if (lost.length > 0 && ctx.recover && !nestedIn) own += ctx.recover(String(rule.selectorText), lost)
        const nested = rule.cssRules && rule.cssRules.length > 0 ? sheetText(rule.cssRules, ctx, unreadable, true) : ''
        if (own || nested) out += `${rule.selectorText}{${own}${nested}}`
      } else if (rule.type === 3) {
        let inner = ''
        // The rules of an imported sheet read their addresses from that sheet, not from the one that imports it.
        const outer = ctx.base
        try {
          if (rule.styleSheet) {
            if (typeof rule.styleSheet.href === 'string' && rule.styleSheet.href !== '') ctx.base = rule.styleSheet.href
            inner = sheetText(rule.styleSheet.cssRules, ctx, unreadable)
          }
        } catch {
          unreadable.count++
        } finally {
          ctx.base = outer
        }
        if (!inner) continue
        if (typeof rule.layerName === 'string') inner = `@layer${rule.layerName ? ` ${rule.layerName}` : ''}{${inner}}`
        if (rule.supportsText) inner = `@supports ${rule.supportsText}{${inner}}`
        if (rule.media && rule.media.mediaText) inner = `@media ${rule.media.mediaText}{${inner}}`
        out += inner
      } else if (rule.type === 7) {
        let frames = ''
        let coloured = false
        for (let k = 0; k < rule.cssRules.length; k++) {
          const frame = keyframe(rule.cssRules[k].style, ctx)
          if (frame !== null) coloured = true
          frames += `${rule.cssRules[k].keyText}{${frame ?? ''}}`
        }
        if (coloured) out += `@keyframes ${ident(String(rule.name))}{${frames}}`
      } else if (nestedDeclarations(rule)) {
        // Declarations nested in a rule after other rules (CSS nesting).
        out += declarations(rule.style, ctx)
      } else {
        const open = prelude(rule)
        if (open === null) continue
        const inner = sheetText(rule.cssRules, ctx, unreadable, nestedIn)
        if (inner) out += `${open}{${inner}}`
      }
    }
    return out
  }

  return { clamp, toOklch, fromOklch, luminance, contrast, over, contrastOver, reach, lightness, recolour, inScheme, parse, format, rewrite, twinValue, colourish, declarations, collect, closeNeed, sheetText, PROPS }
}

export type ReadableKit = ReturnType<typeof readableKit>

// ---------- the engine in the page (self-contained) ----------

/**
 * Runs one command of the engine in `win`, the isolated world's window of the page. `start` recolours the page for `config.scheme` and
 * answers how it went (`ReadableStart`): an engine that throws or takes longer than its budget takes everything of its own back and answers
 * `ok: false`, and the shell inverts the page instead. `stop` takes everything back. `stats` answers what the engine did (for the benchmark).
 */
export function readableEngine(win: Dom, kit: ReadableKit, command: ReadableCommand, config: ReadableEngineConfig | null): unknown {
  const KEY = '__luciumReadable'
  const existing = win[KEY]
  if (command === 'stop') return existing ? existing.stop() : false
  if (command === 'stats') return existing ? existing.stats() : null
  if (command !== 'start' || !config) return { ok: false, reason: 'unknown command' }
  if (existing) {
    if (existing.scheme === config.scheme && !existing.failed) return { ok: true, already: true, ...existing.stats() }
    existing.stop()
  }
  const doc = win.document
  const scheme = config.scheme
  const budget = config.budget
  const now = (): number => win.performance.now()
  const started = now()
  const SVG = 'http://www.w3.org/2000/svg'
  // A name of this document only: what the engine writes in the page (an attribute, the twins of custom properties) names neither the browser nor the mode.
  const token = `r${Math.random().toString(36).slice(2, 8)}`
  const ATTR = `data-${token}`
  const ours = new Set<Dom>()
  const roots = new Set<Dom>()
  const overrides = new Map<Dom, { sheet: Dom; size: number; sig: number }>()
  const attrSheet = new win.CSSStyleSheet()
  ours.add(attrSheet)
  let fallbackSheet: Dom = null
  const combos = new Map<string, string>()
  let newRules: string[] = []
  // What is behind each element's content (opaque colours: one, or the stops of a gradient), null when it is an image; and how faded it is.
  const behindOf = new WeakMap<Dom, Rgb[] | null>()
  const fadeOf = new WeakMap<Dom, number>()
  const stats = { startMs: 0, sheetsMs: 0, sheets: 0, unreadable: 0, unresolved: 0, rejected: 0, recovered: 0, unrecovered: 0, images: 0, unreadImages: 0, scanned: 0, marked: 0, contrast: 0, ui: 0, unknown: 0, busyMs: 0, chunks: 0, capped: false, degraded: false, failed: '' }
  let stopped = false
  let failed = false
  let scheduled = false
  let sheetsDirty = false
  let needSig = 0
  const need = new Map<string, Set<ColourRole>>()
  const busy: Array<[number, number]> = []
  const stack: Dom[] = []
  const forced: boolean[] = []
  let incoming: Array<[Dom, boolean]> = []
  const queued = new WeakSet<Dom>()
  let newRoots: Dom[] = []
  const memo = new Map<string, Rgb>()
  let canvasL = scheme === 'dark' ? 1 : 0.2
  let canvasAfter: Rgb = { r: 18, g: 18, b: 18, a: 1 }

  const style = (el: Dom): Dom => win.getComputedStyle(el)
  let probeCanvas: Dom = null
  /** A colour `parse` does not read, as the page reads it (a canvas resolves any colour syntax the browser knows; nothing is drawn on screen). */
  const resolve = (text: string): Rgb | null => {
    try {
      probeCanvas ??= doc.createElement('canvas').getContext('2d', { willReadFrequently: true })
      if (!probeCanvas) return null
      probeCanvas.fillStyle = '#010203'
      probeCanvas.fillStyle = text
      if (probeCanvas.fillStyle === '#010203') return null
      probeCanvas.clearRect(0, 0, 1, 1)
      probeCanvas.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = probeCanvas.getImageData(0, 0, 1, 1).data
      return { r, g, b, a: a / 255 }
    } catch {
      // The colour is not known: its element is read as if it had none (counted, for the benchmark).
      stats.unresolved++
      return null
    }
  }
  const colour = (text: string): Rgb | null => kit.parse(text) ?? (text && text !== 'none' && !text.includes('url(') ? resolve(text) : null)
  const map = (c: Rgb, role: ColourRole): Rgb => {
    const key = `${role}|${c.r},${c.g},${c.b},${c.a}`
    let out = memo.get(key)
    if (!out) {
      out = kit.recolour(c, role, scheme, canvasL)
      // A page that never shows the same colour twice would fill this for as long as it is open: what is forgotten is worked out again.
      if (memo.size >= budget.maxRemembered) memo.clear()
      memo.set(key, out)
    }
    return out
  }
  const twin = (role: ColourRole, name: string): string => `--${token}-${role}${name}`
  const deadline = { at: started + budget.startMs }
  // The root whose sheets are being copied: a lost declaration is recovered from an element of that root.
  let currentRoot: Dom = doc
  const PSEUDO = /::?(before|after|marker|placeholder|selection|first-line|first-letter|backdrop|file-selector-button)$/i
  /** A computed colour that may be one the engine gave already (a copy adopted earlier) is mapped only when it is not in the scheme. */
  const mapOnce = (c: Rgb, role: ColourRole): Rgb => (kit.inScheme(c, role, scheme) ? c : map(c, role))
  const recover = (selector: string, lost: Array<[string, ColourRole]>): string => {
    let depth = 0
    let from = 0
    const parts: string[] = []
    for (let i = 0; i <= selector.length; i++) {
      const ch = selector[i]
      if (ch === '(' || ch === '[') depth++
      else if (ch === ')' || ch === ']') depth--
      else if ((ch === ',' && depth === 0) || i === selector.length) {
        parts.push(selector.slice(from, i).trim())
        from = i + 1
      }
    }
    for (const part of parts) {
      const pseudo = PSEUDO.exec(part)
      const base = pseudo ? part.slice(0, pseudo.index) || '*' : part
      let el: Dom = null
      try {
        el = currentRoot.querySelector(base)
      } catch {
        // A selector this world cannot query (a pseudo-class of another engine): the next part of the list is tried.
        continue
      }
      if (!el) continue
      const cs = win.getComputedStyle(el, pseudo ? `::${pseudo[1]}` : null)
      let out = ''
      for (const [prop, role] of lost) {
        const value: string = cs.getPropertyValue(prop)
        if (value && value !== 'none') out += `${prop}:${kit.rewrite(value, role, { ...ctx, map: mapOnce, memo: undefined })};`
      }
      stats.recovered++
      return out
    }
    // No element matches it now (a hover state, an element that comes later): the rule keeps the page's colours.
    stats.unrecovered++
    return ''
  }
  const ctx: { map: typeof map; twin: typeof twin; need: typeof need; resolve: typeof resolve; recover: typeof recover; memo: Map<string, string>; memoMax: number; tick(): void; base?: string | undefined } = {
    map,
    twin,
    need,
    resolve,
    recover,
    memo: new Map<string, string>(),
    memoMax: budget.maxRemembered,
    tick: () => {
      if (now() > deadline.at) throw new Error(`the stylesheets took longer than ${budget.startMs} ms`)
    }
  }

  // ---- the stylesheets ----
  const adopted = (root: Dom): Dom[] => [...(root.adoptedStyleSheets ?? [])]
  const sourcesOf = (root: Dom): Dom[] => {
    const list: Dom[] = []
    const sheets = root.styleSheets ?? []
    for (let i = 0; i < sheets.length; i++) if (!sheets[i].disabled) list.push(sheets[i])
    for (const sheet of adopted(root)) if (!ours.has(sheet)) list.push(sheet)
    return list
  }
  const rulesOf = (sheet: Dom): Dom | null => {
    try {
      return sheet.cssRules
    } catch {
      // A sheet of another origin, served without CORS: its rules cannot be read. Its colours are mapped element by element instead.
      return null
    }
  }
  /** Makes or updates the copy of every sheet of every root, and gives each root its copies after the page's own sheets. */
  const refreshSheets = (): void => {
    const begin = now()
    const unreadable = { count: 0 }
    const deps = new Map<string, Set<string>>()
    const fresh = new Map<string, Set<ColourRole>>()
    const all: Array<[Dom, Dom[]]> = []
    // A sheet adopted by many roots (the components of a design system share theirs) is read once.
    const read = new Set<Dom>()
    for (const root of roots) {
      const sources = sourcesOf(root)
      all.push([root, sources])
      for (const sheet of sources) {
        if (read.has(sheet)) continue
        read.add(sheet)
        const rules = rulesOf(sheet)
        if (rules) kit.collect(rules, fresh, deps, unreadable)
      }
    }
    kit.closeNeed(fresh, deps)
    let sig = fresh.size
    for (const [name, roles] of fresh) sig = (sig * 31 + name.length * 7 + roles.size) % 1_000_000_007
    if (sig !== needSig) {
      need.clear()
      for (const [name, roles] of fresh) need.set(name, roles)
      needSig = sig
    }
    unreadable.count = 0
    for (const [root, sources] of all) {
      currentRoot = root
      const copies: Dom[] = []
      for (const sheet of sources) {
        const rules = rulesOf(sheet)
        if (!rules) {
          unreadable.count++
          continue
        }
        let entry = overrides.get(sheet)
        if (!entry || entry.size !== rules.length || entry.sig !== needSig) {
          // A sheet with an address of its own (a `<link>`) reads its relative addresses from it; one written in the page reads them from the document, as its copy does.
          if (typeof sheet.href === 'string' && sheet.href !== '') ctx.base = sheet.href
          let text: string
          try {
            text = kit.sheetText(rules, ctx, unreadable)
          } finally {
            delete ctx.base
          }
          const media = sheet.media && sheet.media.mediaText
          if (media && text) text = `@media ${media}{${text}}`
          const copy = entry ? entry.sheet : new win.CSSStyleSheet()
          copy.replaceSync(text)
          ours.add(copy)
          entry = { sheet: copy, size: rules.length, sig: needSig }
          overrides.set(sheet, entry)
        }
        copies.push(entry.sheet)
      }
      adopt(root, copies)
    }
    stats.sheets = overrides.size
    stats.unreadable = unreadable.count
    stats.sheetsMs += now() - begin
  }
  /** The root's adopted sheets: the page's own, then the copies in the order of their sheets, then the engine's own rules. */
  const adopt = (root: Dom, copies: Dom[]): void => {
    const wanted = [...adopted(root).filter((sheet) => !ours.has(sheet)), ...copies, ...(fallbackSheet ? [fallbackSheet] : []), attrSheet]
    const current = adopted(root)
    if (current.length !== wanted.length || current.some((sheet, i) => sheet !== wanted[i])) root.adoptedStyleSheets = wanted
  }
  /** Whether a sheet changed since its copy was made (a rule added by a script, a sheet that appeared or went), and whether the page took the copies off. */
  const sheetsChanged = (): boolean => {
    for (const root of roots) {
      if (!adopted(root).includes(attrSheet)) return true
      for (const sheet of sourcesOf(root)) {
        const rules = rulesOf(sheet)
        const entry = overrides.get(sheet)
        if (rules ? !entry || entry.size !== rules.length : false) return true
      }
    }
    return false
  }

  // ---- the elements ----
  const parentOf = (el: Dom): Dom => el.parentElement ?? (el.parentNode && el.parentNode.host) ?? null
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'FRAME', 'EMBED', 'OBJECT', 'SOURCE', 'TRACK', 'BR', 'WBR', 'MATH'])
  const FIELDS = new Set(['INPUT', 'SELECT', 'TEXTAREA'])
  const NO_TEXT_INPUTS = /^(hidden|checkbox|radio|range|color|file|image)$/i
  const hasText = (el: Dom): boolean => {
    if (FIELDS.has(el.tagName)) return el.tagName !== 'INPUT' || !NO_TEXT_INPUTS.test(el.type || '')
    for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /\S/.test(n.data)) return true
    return false
  }
  const SIDES = ['top', 'right', 'bottom', 'left']
  /** Whether an inline SVG is the size of an icon (by its own attributes: reading its box would cost a layout). */
  const isIcon = (svg: Dom): boolean => {
    const w = parseFloat(svg.getAttribute('width') ?? '')
    const h = parseFloat(svg.getAttribute('height') ?? '')
    if (w > 0 && h > 0) return w <= 64 && h <= 64
    const box = String(svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
    return box.length === 4 && box[2]! > 0 && box[2]! <= 64 && box[3]! <= 64
  }
  // Pictures that are a drawing of one dark colour on a transparent ground (a logo, a formula, a line drawing), by address: in Dark they would
  // vanish on the dark background, so they are turned light (and the mirror in Light). Photographs and coloured pictures are left as they are.
  const glyphs = new Map<string, boolean>()
  let glyphCanvas: Dom = null
  const isGlyph = (img: Dom): boolean => {
    const src: string = img.currentSrc || img.src || ''
    if (!src || !img.complete || !img.naturalWidth || !img.naturalHeight) return false
    const known = glyphs.get(src)
    if (known !== undefined) return known
    let verdict = false
    try {
      glyphCanvas ??= doc.createElement('canvas').getContext('2d', { willReadFrequently: true })
      // Wide enough for the thin strokes of a wordmark to keep some ink once scaled down, small enough to cost nothing.
      const w = Math.max(16, Math.min(128, img.naturalWidth))
      const h = Math.max(1, Math.min(128, Math.round((w * img.naturalHeight) / img.naturalWidth)))
      glyphCanvas.canvas.width = w
      glyphCanvas.canvas.height = h
      glyphCanvas.clearRect(0, 0, w, h)
      // The picture the page loaded already: drawing it asks the network for nothing.
      glyphCanvas.drawImage(img, 0, 0, w, h)
      const data = glyphCanvas.getImageData(0, 0, w, h).data
      let clear = 0
      let ink = 0
      let sumL = 0
      let sumC = 0
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3] / 255
        if (alpha < 0.05) {
          clear++
          continue
        }
        // Each pixel counts as much as it is opaque: the edges of a stroke, half transparent, count half.
        const o = kit.toOklch({ r: data[i], g: data[i + 1], b: data[i + 2], a: 1 })
        sumL += o.l * alpha
        sumC += o.c * alpha
        ink += alpha
      }
      const pixels = data.length / 4
      if (ink > 0 && clear / pixels >= 0.2) verdict = sumC / ink < 0.06 && (scheme === 'dark' ? sumL / ink < 0.4 : sumL / ink > 0.7)
    } catch {
      // A picture of another origin cannot be read (the canvas is tainted): it keeps its colours. Counted, for the benchmark.
      stats.unreadImages++
    }
    if (glyphs.size >= budget.maxRemembered) glyphs.clear()
    glyphs.set(src, verdict)
    return verdict
  }
  const worst = (fg: Rgb, behind: Rgb[], alpha: number): [number, Rgb] => {
    let low = Infinity
    let at = behind[0]!
    for (const b of behind) {
      const ratio = kit.contrastOver(fg, b, alpha)
      if (ratio < low) {
        low = ratio
        at = b
      }
    }
    return [low, at]
  }
  const decide = (el: Dom, decls: string[]): void => {
    if (decls.length === 0) return
    const body = decls.map((d) => `${d} !important`).join(';')
    let key = combos.get(body)
    if (!key) {
      if (combos.size >= budget.maxRules) {
        // The page asks for more sets of colours than any page has: its elements are no longer read, the rules written so far stay.
        stats.degraded = true
        stack.length = 0
        forced.length = 0
        return
      }
      key = String(combos.size + 1)
      combos.set(body, key)
      newRules.push(`[${ATTR}="${key}"]:not(#${token}):not(#${token}){${body}}`)
    }
    writes.push([el, key])
  }
  let writes: Array<[Dom, string]> = []
  /** The colours behind `el`'s content, computing those of its ancestors first when they are not known yet. */
  const behind = (el: Dom | null): Rgb[] | null => {
    if (!el) return [canvasAfter]
    if (behindOf.has(el)) return behindOf.get(el)!
    const chain: Dom[] = []
    for (let at = el; at && !behindOf.has(at); at = parentOf(at)) chain.push(at)
    for (let i = chain.length - 1; i >= 0; i--) visit(chain[i], false)
    return behindOf.has(el) ? behindOf.get(el)! : [canvasAfter]
  }
  /**
   * Reads one element and decides what it needs: a background, a text colour or borders the sheets did not map, and a text colour that reaches
   * the contrast WCAG asks against what is behind it. Writes nothing (the decisions are written after the slice, all at once). Answers whether
   * its children are to be read.
   */
  const visit = (el: Dom, children: boolean): boolean => {
    stats.scanned++
    const parent = parentOf(el)
    const under = el === doc.documentElement ? [canvasAfter] : behind(parent)
    const parentFade = parent && fadeOf.has(parent) ? fadeOf.get(parent)! : 1
    const cs = style(el)
    if (cs.display === 'none') {
      behindOf.set(el, under)
      fadeOf.set(el, parentFade)
      return false
    }
    const decls: string[] = []
    const svg = el.namespaceURI === SVG
    let bg = svg ? null : colour(cs.backgroundColor)
    if (bg && bg.a > 0 && !kit.inScheme(bg, 'bg', scheme)) {
      bg = map(bg, 'bg')
      decls.push(`background-color:${kit.format(bg)}`)
    }
    let mine: Rgb[] | null = under
    const image: string = svg ? 'none' : cs.backgroundImage
    // An opaque background of its own is what is behind the content again, whatever is under it (a card laid on a photograph).
    if (bg && bg.a >= 0.99) mine = [{ ...bg, a: 1 }]
    else if (mine && bg && bg.a > 0) mine = mine.map((b) => kit.over(bg!, b))
    if (image && image !== 'none') {
      if (/url\(|image-set\(|element\(|cross-fade\(|paint\(/.test(image)) mine = null
      else {
        // A gradient: what is behind the text is each of its stops, over the colour under it (or the stops alone when they are opaque).
        const stops = [...image.matchAll(/(?:rgba?|color|oklch|oklab|lab|lch|hsla?)\([^()]*\)/g)].map((m) => colour(m[0])).filter((c): c is Rgb => c !== null)
        if (stops.some((c) => c.a > 0 && !kit.inScheme(c, 'bg', scheme))) decls.push(`background-image:${kit.rewrite(image, 'bg', ctx)}`)
        const mapped = stops.map((c) => (kit.inScheme(c, 'bg', scheme) ? c : map(c, 'bg'))).slice(0, 4)
        const base = mine ? mine[0]! : null
        if (mapped.length > 0) mine = base ? mapped.map((c) => kit.over(c, base)) : mapped.every((c) => c.a >= 0.99) ? mapped : null
      }
    }
    const opaque = !!bg && bg.a >= 0.99
    const fade = (opaque ? 1 : parentFade) * (parseFloat(cs.opacity) || (cs.opacity === '0' ? 0 : 1))
    behindOf.set(el, mine)
    fadeOf.set(el, opaque ? 1 : fade)
    if (!svg) {
      for (const side of SIDES) {
        if (cs.getPropertyValue(`border-${side}-width`) === '0px' || /none|hidden/.test(cs.getPropertyValue(`border-${side}-style`))) continue
        const c = colour(cs.getPropertyValue(`border-${side}-color`))
        if (c && c.a > 0 && !kit.inScheme(c, 'border', scheme)) decls.push(`border-${side}-color:${kit.format(map(c, 'border'))}`)
      }
    }
    const field = FIELDS.has(el.tagName)
    if (field && under && mine) {
      // The edge of a form field (WCAG 1.4.11): its own background or its border must stand out from what is around it at 3 : 1.
      const around = under[0]!
      if (kit.contrast(mine[0]!, around) < CONTRAST_UI_IN) {
        for (const side of SIDES) {
          if (cs.getPropertyValue(`border-${side}-width`) === '0px' || /none|hidden/.test(cs.getPropertyValue(`border-${side}-style`))) continue
          const c = colour(cs.getPropertyValue(`border-${side}-color`))
          if (!c) continue
          const mapped = kit.inScheme(c, 'border', scheme) ? c : map(c, 'border')
          if (kit.contrastOver(mapped, around) < CONTRAST_UI_IN) {
            decls.push(`border-${side}-color:${kit.format(kit.reach(mapped, around, CONTRAST_UI_IN + 0.1))}`)
            stats.ui++
          }
        }
      }
    }
    if (!svg && hasText(el)) {
      if (!mine) stats.unknown++
      else {
        let fg = colour(cs.color)
        if (fg && fg.a > 0) {
          let changed = false
          if (!kit.inScheme(fg, 'fg', scheme)) {
            fg = map(fg, 'fg')
            changed = true
          }
          const size = parseFloat(cs.fontSize)
          const weight = parseInt(cs.fontWeight, 10)
          const target = (size >= 24 || (size >= 18.66 && weight >= 700) ? CONTRAST_LARGE_IN : CONTRAST_TEXT_IN) + 0.1
          const alpha = fg.a * (fadeOf.get(el) ?? 1)
          const [ratio, against] = worst(fg, mine, alpha)
          // A text faded out of sight (an opacity near 0: a placeholder of an animation) has no contrast to reach.
          if (ratio < target && alpha >= 0.05) {
            fg = kit.reach(fg, against, target, alpha)
            changed = true
            stats.contrast++
          }
          if (changed) decls.push(`color:${kit.format(fg)}`)
        }
      }
    }
    if (svg && el.tagName.toLowerCase() === 'svg') {
      icon(el, under)
      decide(el, decls)
      return false
    }
    // What is behind a picture is always of the scheme here (a background the engine left is in it): only a picture over a picture is not known.
    if (el.tagName === 'IMG' && under && isGlyph(el)) {
      decls.push('filter:invert(1) hue-rotate(180deg)')
      stats.images++
    }
    decide(el, decls)
    return children && !SKIP.has(el.tagName)
  }
  // The thresholds, as the engine's own names (it may read no constant of its module).
  const CONTRAST_TEXT_IN = 4.5
  const CONTRAST_LARGE_IN = 3
  const CONTRAST_UI_IN = 3
  /** A small inline SVG of one colour (an icon) is a graphic of the interface: its colour must stand out at 3 : 1 from what is behind it. Others are pictures, left as they are. */
  const icon = (svg: Dom, under: Rgb[] | null): void => {
    if (!under || !isIcon(svg)) return
    const shapes = [...svg.querySelectorAll('path, circle, rect, ellipse, polygon, polyline, line, text, use')].slice(0, 64)
    const paints = new Map<string, Rgb>()
    const reads: Array<[Dom, Rgb | null, Rgb | null]> = []
    for (const shape of shapes) {
      const cs = style(shape)
      const fill = colour(cs.fill)
      const stroke = cs.stroke === 'none' ? null : colour(cs.stroke)
      for (const c of [fill, stroke]) if (c && c.a > 0) paints.set(kit.format(c), c)
      reads.push([shape, fill, stroke])
    }
    if (paints.size !== 1) return
    const only = [...paints.values()][0]!
    const [ratio, against] = worst(only, under, only.a)
    if (ratio >= CONTRAST_UI_IN) return
    const fixed = kit.format(kit.reach(only, against, CONTRAST_UI_IN + 0.1))
    stats.ui++
    for (const [shape, fill, stroke] of reads) {
      const decls: string[] = []
      if (fill && fill.a > 0) decls.push(`fill:${fixed}`)
      if (stroke && stroke.a > 0) decls.push(`stroke:${fixed}`)
      decide(shape, decls)
    }
  }
  /** Writes what the slice decided: the new rules first, then the attributes that select them. */
  const write = (): void => {
    for (const rule of newRules) {
      try {
        attrSheet.insertRule(rule, attrSheet.cssRules.length)
      } catch {
        // A value the browser refuses (a colour of a syntax it reads differently): its elements keep the colours they have. Counted.
        stats.rejected++
      }
    }
    newRules = []
    for (const [el, key] of writes) {
      if (el.getAttribute(ATTR) !== key) {
        el.setAttribute(ATTR, key)
        stats.marked++
      }
    }
    writes = []
  }
  const strip = (el: Dom): void => {
    if (el.hasAttribute && el.hasAttribute(ATTR)) el.removeAttribute(ATTR)
    if (el.querySelectorAll) for (const marked of el.querySelectorAll(`[${ATTR}]`)) marked.removeAttribute(ATTR)
  }
  const push = (el: Dom, force: boolean): void => {
    stack.push(el)
    forced.push(force)
  }
  const pushChildren = (el: Dom, force: boolean): void => {
    const shadow = el.shadowRoot
    if (shadow && !roots.has(shadow)) newRoots.push(el)
    else if (shadow) for (let c = shadow.lastElementChild; c; c = c.previousElementSibling) push(c, force)
    for (let c = el.lastElementChild; c; c = c.previousElementSibling) push(c, force)
  }
  const registerRoot = (root: Dom): void => {
    roots.add(root)
    observer.observe(root, OBSERVE)
  }
  /** Reads elements until `ms` have gone by; answers whether work remains. */
  const slice = (ms: number): boolean => {
    const begin = now()
    if (sheetsDirty || sheetsChanged()) {
      sheetsDirty = false
      deadline.at = begin + budget.startMs
      refreshSheets()
    }
    if (incoming.length > 0) {
      for (const [el, requeue] of incoming) {
        queued.delete(el)
        if (requeue) strip(el)
        push(el, true)
      }
      incoming = []
    }
    let count = 0
    while (stack.length > 0) {
      if ((count++ & 31) === 0 && now() - begin > ms) break
      const el = stack.pop()
      const force = forced.pop()!
      if (!el.isConnected || (!force && behindOf.has(el))) continue
      if (!force && stats.scanned >= budget.maxElements) {
        stats.capped = true
        stack.length = 0
        forced.length = 0
        break
      }
      if (visit(el, true)) pushChildren(el, force)
    }
    write()
    if (newRoots.length > 0) {
      const hosts = newRoots
      newRoots = []
      for (const host of hosts) if (host.shadowRoot) registerRoot(host.shadowRoot)
      refreshSheets()
      for (const host of hosts) if (host.shadowRoot) for (let c = host.shadowRoot.lastElementChild; c; c = c.previousElementSibling) push(c, true)
    }
    const spent = now() - begin
    stats.busyMs += spent
    stats.chunks++
    busy.push([begin, spent])
    while (busy.length > 0 && busy[0]![0] < begin - budget.busyWindowMs) busy.shift()
    if (busy.reduce((sum, [, d]) => sum + d, 0) > budget.busyMs && !stats.degraded) {
      // Too much work for this page (a page that changes all the time): the recoloured sheets stay, its elements are no longer read.
      stats.degraded = true
      stack.length = 0
      forced.length = 0
    }
    return stack.length > 0 || incoming.length > 0
  }
  const run = (idle?: Dom): void => {
    scheduled = false
    if (stopped || failed) return
    try {
      const ms = idle && !idle.didTimeout && typeof idle.timeRemaining === 'function' ? Math.max(2, Math.min(budget.chunkMs, idle.timeRemaining())) : budget.chunkMs
      if (slice(ms)) schedule()
    } catch (error) {
      fail(error)
    }
  }
  const schedule = (): void => {
    if (scheduled || stopped || failed) return
    scheduled = true
    if (typeof win.requestIdleCallback === 'function') win.requestIdleCallback(run, { timeout: 250 })
    else win.setTimeout(run, 16)
  }

  // ---- what the page does next ----
  const OBSERVE = { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'bgcolor', 'color', 'text', 'fill', 'stroke', 'hidden', 'open'] }
  const COLOUR_STYLE = /color|background|border|fill|stroke|outline|shadow|--/i
  const enqueue = (el: Dom, requeue: boolean): void => {
    if (stats.degraded || queued.has(el)) return
    queued.add(el)
    incoming.push([el, requeue])
  }
  // A record that comes after a stop or a failure is queued for nothing: `schedule` and `run` do no work then.
  const observer = new win.MutationObserver((records: Dom[]) => {
    for (const r of records) {
      const target = r.target
      if (r.type === 'childList') {
        if (target.nodeName === 'STYLE') sheetsDirty = true
        for (const n of r.addedNodes) {
          if (n.nodeType === 3) {
            if (target.nodeType === 1 && target.nodeName !== 'STYLE') enqueue(target, false)
          } else if (n.nodeType === 1) {
            if (n.nodeName === 'STYLE' || n.nodeName === 'LINK') sheetsDirty = true
            else enqueue(n, false)
          }
        }
        for (const n of r.removedNodes) if (n.nodeName === 'STYLE' || n.nodeName === 'LINK') sheetsDirty = true
      } else if (r.type === 'attributes' && target.nodeType === 1) {
        // A style attribute that holds no colour, before or after, changes no colour (an animation moves things sixty times a second).
        if (r.attributeName === 'style' && !COLOUR_STYLE.test(String(target.getAttribute('style') ?? '')) && !COLOUR_STYLE.test(String(r.oldValue ?? ''))) continue
        enqueue(target, true)
      }
    }
    schedule()
  })
  // A stylesheet that arrives later (a <link> loads after its element is added), and a picture that is read once it has loaded.
  const onLoad = (event: Dom): void => {
    const target = event.target
    if (!target) return
    if (target.nodeName === 'LINK') sheetsDirty = true
    else if (target.nodeName === 'IMG') enqueue(target, true)
    else return
    schedule()
  }

  // ---- taking it all back ----
  const cleanup = (): void => {
    observer.disconnect()
    doc.removeEventListener('load', onLoad, true)
    for (const root of roots) {
      try {
        root.adoptedStyleSheets = adopted(root).filter((sheet) => !ours.has(sheet) || sheet === fallbackSheet)
        if (root.querySelectorAll) for (const marked of root.querySelectorAll(`[${ATTR}]`)) marked.removeAttribute(ATTR)
      } catch (error) {
        win.console.warn(`[readable] a part of the page could not be given its colours back: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  const stop = (): boolean => {
    if (stopped) return false
    stopped = true
    cleanup()
    if (fallbackSheet) doc.adoptedStyleSheets = adopted(doc).filter((sheet) => sheet !== fallbackSheet)
    if (win[KEY] === state) delete win[KEY]
    return true
  }
  /** After the start: the engine takes its recolouring back and puts the inversion on the page itself, so that it stays in the scheme asked. */
  const fail = (error: unknown): void => {
    if (failed || stopped) return
    failed = true
    stats.failed = error instanceof Error ? error.message : String(error)
    cleanup()
    try {
      fallbackSheet = new win.CSSStyleSheet()
      fallbackSheet.replaceSync(config.fallbackCss)
      doc.adoptedStyleSheets = [...adopted(doc), fallbackSheet]
      win.console.warn(`[readable] the recolouring stopped (${stats.failed}); the page is inverted instead`)
    } catch (error) {
      win.console.warn(`[readable] the recolouring stopped (${stats.failed}) and the page keeps its own colours: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  /** For the probe of dark-sites.ts: the page as it is without the engine, for the time of a synchronous read. */
  const suspend = (): (() => void) => {
    const sheets = [...ours, ...(fallbackSheet ? [fallbackSheet] : [])]
    const before = sheets.map((sheet) => sheet.disabled)
    for (const sheet of sheets) sheet.disabled = true
    return () => sheets.forEach((sheet, i) => (sheet.disabled = before[i]))
  }
  const state = {
    scheme,
    get failed() {
      return failed
    },
    stop,
    suspend,
    stats: () => ({ ...stats, pending: stack.length + incoming.length, rules: combos.size, remembered: Math.max(memo.size, glyphs.size, ctx.memo.size) })
  }

  try {
    // The page's own canvas, before anything of the engine: its lightness anchors the backgrounds.
    const solid = (el: Dom): Rgb | null => {
      if (!el) return null
      const c = colour(style(el).backgroundColor)
      return c && c.a >= 0.5 ? c : null
    }
    const declared = solid(doc.documentElement) ?? solid(doc.body)
    canvasL = declared ? kit.toOklch(declared).l : /dark/.test(style(doc.documentElement).colorScheme || '') ? 0.18 : 1
    attrSheet.replaceSync(`:root{color-scheme:${scheme} !important}`)
    roots.add(doc)
    refreshSheets()
    // The canvas the page is painted on now: its root's background, else its body's, else the browser's for the scheme.
    canvasAfter = solid(doc.documentElement) ?? solid(doc.body) ?? (scheme === 'dark' ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 })
    canvasAfter = { ...canvasAfter, a: 1 }
    observer.observe(doc, OBSERVE)
    doc.addEventListener('load', onLoad, true)
    win[KEY] = state
    push(doc.documentElement, false)
    const sliced = stats.busyMs
    const more = slice(budget.firstChunkMs)
    stats.startMs = now() - started
    // The work of the whole start (the sheets, then the first slice, which counted itself) is the engine's too.
    stats.busyMs += stats.startMs - (stats.busyMs - sliced)
    if (more) schedule()
    return { ok: true, startMs: stats.startMs, sheets: stats.sheets, unreadable: stats.unreadable, scanned: stats.scanned, marked: stats.marked }
  } catch (error) {
    stopped = true
    cleanup()
    if (win[KEY] === state) delete win[KEY]
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** The source the shell runs in the page's readable world: the engine and its kit as text, the command and the config as JSON. */
export function readableEngineCall(command: ReadableCommand, config?: Omit<ReadableEngineConfig, 'budget'> & { budget?: ReadableBudget }): string {
  const full = config ? { ...config, budget: config.budget ?? READABLE_BUDGET } : null
  return `(${readableEngine.toString()})(window, (${readableKit.toString()})(), ${JSON.stringify(command)}, ${JSON.stringify(full)})`
}

/** The short script that takes the engine off a page (it reads the state the engine left in its world; nothing when there is none). */
export const READABLE_STOP_SCRIPT = `(() => { const engine = globalThis.${READABLE_STATE}; return engine ? engine.stop() : false })()`
