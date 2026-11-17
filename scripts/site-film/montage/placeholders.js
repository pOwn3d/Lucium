// The neutral drawings of the montage page: a sober window of Lucium for each shot that is not captured yet, made of grey shapes only (no text,
// no brand, no interface that is not in the application), laid out so that the places of scenes.ts (HOTSPOTS) fall on the matching parts. They
// are drawn in the pixels of the capture they stand for (1440 × 900 for the main window), in the light or dark theme, tinted with the colour of
// the space. The colours of the spaces, the favourites and the favicons are those of the demonstration (scripts/site-captures/demo.ts), given
// by the plan of the film (`colors`). `label`: the id of the shot, small, in a corner (`pnpm film:site --labels`).
'use strict'
;(() => {
  const PALETTES = {
    light: { page: '#f3f2ef', card: '#ffffff', chrome: '#ffffff', line: '#e4e4e9', bar: 'rgba(0,0,0,0.13)', barSoft: 'rgba(0,0,0,0.07)', side: 0.24, sideBase: '#ffffff', row: 'rgba(255,255,255,0.42)', dim: 'rgba(0,0,0,0.16)', panel: '#2a2a2d', sheet: '#ffffff' },
    dark: { page: '#1c1c1e', card: '#2a2a2c', chrome: '#242426', line: '#3a3a3c', bar: 'rgba(255,255,255,0.20)', barSoft: 'rgba(255,255,255,0.09)', side: 0.34, sideBase: '#1c1c1e', row: 'rgba(255,255,255,0.10)', dim: 'rgba(0,0,0,0.42)', panel: '#2a2a2d', sheet: '#2a2a2c' }
  }
  const ACCENT = '#0071e3'
  const LIGHTS = ['#ff5f57', '#febc2e', '#28c840']
  // Set by svg() from the plan: the first colour of each space, the colours of the favourites and of the favicons of the demonstration.
  let SPACES = ['#808080']
  let FAVORITES = ['#808080']
  let ICONS = ['#808080']

  const hex = (c) => {
    const v = c.replace('#', '')
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16))
  }
  const mix = (a, b, k) => {
    const [x, y] = [hex(a), hex(b)]
    return `rgb(${x.map((v, i) => Math.round(v * k + y[i] * (1 - k))).join(',')})`
  }
  // A small deterministic sequence for the lengths of the bars: the same drawing every time.
  const seq = (seed) => {
    let s = seed >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 4294967296
    }
  }

  function canvas(W, H) {
    const parts = []
    const rect = (x, y, w, h, fill, rx = 0, extra = '') => parts.push(`<rect x="${x * W}" y="${y * H}" width="${w * W}" height="${h * H}" rx="${rx}" fill="${fill}" ${extra}/>`)
    // In pixels, for the small things that keep their size.
    const px = (x, y, w, h, fill, rx = 0, extra = '') => parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" ${extra}/>`)
    const circle = (cx, cy, r, fill, extra = '') => parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${extra}/>`)
    const raw = (s) => parts.push(s)
    return { W, H, rect, px, circle, raw, parts }
  }

  function lights(c, x = 20, y = 20) {
    LIGHTS.forEach((color, i) => c.circle(x + i * 20, y, 6.5, color))
  }

  // Text lines: grey bars of varying length inside a box (fractions), one every `step` pixels.
  function lines(c, p, x, y, w, h, step = 26, seed = 1, thick = 9) {
    const next = seq(seed)
    const count = Math.max(1, Math.floor((h * c.H) / step))
    for (let i = 0; i < count; i++) {
      const len = i === count - 1 ? 0.35 + next() * 0.3 : 0.72 + next() * 0.28
      c.px(x * c.W, y * c.H + i * step, w * c.W * len, thick, p.barSoft, thick / 2)
    }
  }

  function sidebarRow(c, p, y, indent, color, len, selected) {
    if (selected) c.px(24, y - 17, 292, 34, p.row, 9)
    c.px(34 + indent, y - 8, 16, 16, color, 4)
    c.px(60 + indent, y - 4, len, 8, p.bar, 4)
  }

  /** The main window of Lucium: the sidebar of a space and the frame of the page. Returns the box of the page, in fractions. */
  function mainWindow(c, p, tint, theme) {
    const side = mix(tint, p.sideBase, p.side)
    c.rect(0, 0, 1, 1, p.page)
    c.rect(0, 0, 0.2243, 1, side)
    lights(c)
    c.px(84, 13, 17, 14, 'none', 3, `stroke="${p.bar}" stroke-width="2"`)
    // Favourites
    for (let i = 0; i < 4; i++) {
      c.px(8 + i * 78.5, 44, 70, 46, p.row, 10)
      c.px(8 + i * 78.5 + 26, 58, 18, 18, FAVORITES[i % FAVORITES.length], 5)
    }
    // The space and its tabs
    c.px(16, 108, 18, 18, mix(tint, '#ffffff', 0.8), 5)
    c.px(42, 113, 58, 9, p.bar, 4.5)
    sidebarRow(c, p, 158, 0, ICONS[0], 118, false)
    sidebarRow(c, p, 199, 0, ICONS[1], 96, true)
    c.px(20, 233, 20, 15, 'none', 3, `stroke="${p.bar}" stroke-width="2"`)
    c.px(48, 236, 70, 8, p.bar, 4)
    sidebarRow(c, p, 281, 0, ICONS[1], 104, false)
    sidebarRow(c, p, 322, 0, ICONS[2], 98, false)
    c.px(20, 356, 20, 15, 'none', 3, `stroke="${p.bar}" stroke-width="2"`)
    c.px(48, 359, 96, 8, p.bar, 4)
    c.px(18, 400, 76, 7, p.barSoft, 3.5)
    c.px(208, 400, 88, 7, p.barSoft, 3.5)
    c.px(20, 436, 12, 2, p.bar, 1)
    c.px(25, 431, 2, 12, p.bar, 1)
    c.px(48, 436, 84, 8, p.barSoft, 4)
    sidebarRow(c, p, 481, -16, ICONS[4], 124, false)
    sidebarRow(c, p, 522, -16, ICONS[5], 138, false)
    // The foot: tools, spaces, new space
    for (let i = 0; i < 4; i++) c.px(17 + i * 34, 868, 14, 14, 'none', 3, `stroke="${p.bar}" stroke-width="2"`)
    c.px(162, 860, 30, 30, p.row, 8)
    SPACES.forEach((color, i) => c.px(170 + i * 35, 868, 14, 14, mix(color, p.sideBase, 0.75), 4))
    c.px(292, 874, 14, 2, p.bar, 1)
    c.px(298, 868, 2, 14, p.bar, 1)
    // The frame of the page: its toolbar, then the page itself
    c.rect(0.2264, 0.0089, 0.7653, 0.9822, p.page, 12)
    c.rect(0.2264, 0.0089, 0.7653, 0.04, p.chrome, 12)
    c.px(0.565 * c.W, 22, 150, 9, p.barSoft, 4.5)
    for (let i = 0; i < 3; i++) c.px(340 + i * 34, 19, 14, 14, 'none', 3, `stroke="${p.barSoft}" stroke-width="2"`)
    return { x: 0.2264, y: 0.0489, w: 0.7653, h: 0.9422 }
  }

  // A generic web page in a box: a header, a list on the left, a card with text on the right.
  function page(c, p, box, seed = 3) {
    const { x, y, w } = box
    c.rect(x, y, w, 0.07, p.card)
    c.px((x + 0.02) * c.W, (y + 0.022) * c.H, 24, 24, ICONS[seed % ICONS.length], 6)
    c.px((x + 0.05) * c.W, (y + 0.03) * c.H, 70, 10, p.bar, 5)
    for (let i = 0; i < 3; i++) c.px((x + 0.12 + i * 0.05) * c.W, (y + 0.031) * c.H, 50, 8, p.barSoft, 4)
    c.rect(x + w - 0.13, y + 0.02, 0.11, 0.032, p.page, 8)
    c.rect(x + 0.035, y + 0.11, w * 0.25, 0.63, p.card, 14)
    for (let i = 0; i < 6; i++) {
      c.px((x + 0.05) * c.W, (y + 0.15 + i * 0.095) * c.H, 140, 10, p.bar, 5)
      c.px((x + 0.05) * c.W, (y + 0.18 + i * 0.095) * c.H, 190, 7, p.barSoft, 3.5)
    }
    c.rect(x + 0.06 + w * 0.25, y + 0.11, w * 0.64, 0.61, p.card, 14)
    c.px((x + 0.085 + w * 0.25) * c.W, (y + 0.15) * c.H, 300, 20, p.bar, 7)
    lines(c, p, x + 0.085 + w * 0.25, y + 0.22, w * 0.56, 0.42, 30, seed)
  }

  function card(c, p, x, y, w, h, extra = '') {
    c.rect(x, y, w, h, p.card, 14, extra)
  }

  const DRAW = {
    main(c, p, tint, theme) {
      page(c, p, mainWindow(c, p, tint, theme))
    },
    command(c, p, tint, theme) {
      page(c, p, mainWindow(c, p, tint, theme))
      c.rect(0.25, 0.14, 0.5, 0.3733, p.panel, 16, 'stroke="#46464a" stroke-width="1.5"')
      c.px(0.27 * c.W, 0.155 * c.H, 16, 16, 'none', 8, 'stroke="#8e8e93" stroke-width="2"')
      c.px(0.29 * c.W, 0.158 * c.H, 110, 12, '#e5e5ea', 6)
      for (let i = 0; i < 3; i++) c.px((0.265 + i * 0.065) * c.W, 0.198 * c.H, 82, 22, '#3a3a3e', 11)
      c.rect(0.25, 0.235, 0.5, 0.0015, '#46464a')
      c.rect(0.2563, 0.27, 0.315, 0.04, '#3d3f66', 8)
      c.px(0.27 * c.W, 0.282 * c.H, 120, 10, '#d1d1d6', 5)
      c.px(0.27 * c.W, 0.355 * c.H, 90, 9, '#8e8e93', 4.5)
      c.rect(0.5854, 0.25, 0.1542, 0.13, '#1c1c1e', 10)
      c.px(0.625 * c.W, 0.305 * c.H, 70, 18, '#e5e5ea', 6)
    },
    split2(c, p, tint, theme) {
      mainWindow(c, p, tint, theme)
      c.rect(0.2264, 0.0089, 0.3819, 0.9822, p.page, 12, `stroke="${ACCENT}" stroke-width="2"`)
      c.rect(0.6125, 0.0089, 0.3792, 0.9822, p.page, 12)
      for (let i = 0; i < 2; i++) {
        c.rect(0.25 + i * 0.175, 0.2, 0.16, 0.6, p.barSoft, 12)
        for (let k = 0; k < 3; k++) card(c, p, 0.258 + i * 0.175, 0.26 + k * 0.17, 0.144, 0.14)
      }
      card(c, p, 0.63, 0.14, 0.34, 0.6)
      lines(c, p, 0.65, 0.2, 0.3, 0.5, 30, 5)
    },
    split4(c, p, tint, theme) {
      mainWindow(c, p, tint, theme)
      const boxes = [[0.2264, 0.0089], [0.6125, 0.0089], [0.2264, 0.5044], [0.6125, 0.5044]]
      boxes.forEach(([x, y], i) => {
        c.rect(x, y, i % 2 ? 0.3792 : 0.3819, 0.4867, p.page, 12, i === 0 ? `stroke="${ACCENT}" stroke-width="2"` : '')
        card(c, p, x + 0.02, y + 0.07, 0.34, 0.36)
        lines(c, p, x + 0.04, y + 0.12, 0.3, 0.26, 30, 7 + i)
      })
    },
    peek(c, p, tint, theme) {
      page(c, p, mainWindow(c, p, tint, theme))
      c.rect(0.2264, 0.0089, 0.7653, 0.9822, p.dim, 12)
      c.rect(0.2708, 0.05, 0.6771, 0.9367, p.page, 14, `stroke="${ACCENT}" stroke-width="2.5"`)
      c.rect(0.2708, 0.05, 0.6771, 0.06, p.chrome, 14)
      c.rect(0.65, 0.062, 0.14, 0.035, ACCENT, 8)
      c.rect(0.3, 0.2, 0.62, 0.3, p.card, 16)
      c.circle(0.37 * c.W, 0.33 * c.H, 40, mix('#f2b72e', p.card, 0.8))
      c.px(0.43 * c.W, 0.27 * c.H, 220, 24, p.bar, 8)
      c.px(0.43 * c.W, 0.33 * c.H, 140, 50, p.bar, 10)
      card(c, p, 0.3, 0.535, 0.3, 0.42)
      card(c, p, 0.62, 0.535, 0.3, 0.16)
      lines(c, p, 0.32, 0.6, 0.26, 0.32, 40, 9)
    },
    resource(c, p, tint, theme) {
      page(c, p, mainWindow(c, p, tint, theme))
      c.rect(0.0063, 0.57, 0.2125, 0.3733, p.card, 14, `stroke="${p.line}" stroke-width="1"`)
      c.px(22, 0.592 * c.H, 90, 9, p.bar, 4.5)
      c.rect(0.0125, 0.614, 0.2, 0.008, p.barSoft, 4)
      c.rect(0.0125, 0.614, 0.03, 0.008, ACCENT, 4)
      for (let i = 0; i < 5; i++) {
        const y = 0.655 + i * 0.047
        c.px(24, y * c.H, 16, 16, ICONS[i], 4)
        c.px(50, y * c.H + 2, 110, 8, p.bar, 4)
        c.px(50, y * c.H + 16, 100, 3, ACCENT, 1.5)
        c.px(246, y * c.H, 20, 20, p.barSoft, 5)
        c.px(272, y * c.H, 20, 20, p.barSoft, 5)
      }
      c.rect(0.0875, 0.8833, 0.1229, 0.045, mix(ACCENT, p.card, 0.14), 9)
    },
    little(c, p, tint) {
      c.rect(0, 0, 1, 1, p.page)
      c.rect(0, 0, 1, 0.1, mix(tint, p.sideBase, p.side))
      lights(c, 20, 30)
      c.rect(0.1, 0.02, 0.58, 0.06, p.row, 10)
      c.rect(0.7, 0.02, 0.24, 0.06, '#1c1c1e', 10)
      c.rect(0, 0.1, 1, 0.05, mix(tint, p.sideBase, p.side * 0.6))
      page(c, p, { x: 0, y: 0.15, w: 1, h: 0.85 }, 7)
    },
    settings(c, p, tint, theme) {
      settingsFrame(c, p)
      c.rect(0.0256, 0.3447, 0.9333, 0.0763, mix(ACCENT, p.card, 0.1), 14)
      c.circle(0.065 * c.W, 0.383 * c.H, 13, 'none', `stroke="${ACCENT}" stroke-width="5"`)
      c.px(0.1 * c.W, 0.365 * c.H, 180, 10, p.bar, 5)
      c.px(0.1 * c.W, 0.39 * c.H, 300, 7, p.barSoft, 3.5)
      c.rect(0.814, 0.367, 0.126, 0.032, ACCENT, 7)
      c.px(0.0256 * c.W, 0.48 * c.H, 90, 14, p.bar, 7)
      card(c, p, 0.0256, 0.5237, 0.9333, 0.128, `stroke="${p.line}" stroke-width="1"`)
      for (let i = 0; i < 2; i++) {
        const y = 0.543 + i * 0.064
        c.px(0.04 * c.W, y * c.H, 230, 10, p.bar, 5)
        c.px(0.04 * c.W, (y + 0.022) * c.H, 280, 7, p.barSoft, 3.5)
        c.px(0.9 * c.W, y * c.H, 36, 18, i === 0 ? '#3b3fd8' : p.line, 9)
        c.circle((i === 0 ? 0.9 * c.W + 27 : 0.9 * c.W + 9), y * c.H + 9, 7, '#ffffff')
      }
      lines(c, p, 0.0256, 0.67, 0.9, 0.05, 18, 4, 7)
      c.px(0.0256 * c.W, 0.76 * c.H, 220, 14, p.bar, 7)
      card(c, p, 0.0256, 0.8, 0.9333, 0.11, `stroke="${p.line}" stroke-width="1"`)
    },
    guide(c, p) {
      settingsFrame(c, p)
      c.px(0.0256 * c.W, 0.355 * c.H, 200, 8, p.bar, 4)
      c.px(0.0256 * c.W, 0.39 * c.H, 80, 7, p.barSoft, 3.5)
      c.rect(0.0256, 0.416, 0.949, 0.006, p.line, 3)
      c.rect(0.0256, 0.416, 0.19, 0.006, '#3b3fd8', 3)
      c.px(0.0256 * c.W, 0.448 * c.H, 280, 14, p.bar, 7)
      ;[0.4737, 0.5658, 0.6526].forEach((y, i) => {
        card(c, p, 0.0256, y, 0.9487, 0.0789, i === 0 ? 'stroke="#3b3fd8" stroke-width="2"' : `stroke="${p.line}" stroke-width="1"`)
        c.circle(0.052 * c.W, (y + 0.026) * c.H, 6, i === 0 ? '#3b3fd8' : 'none', `stroke="${i === 0 ? '#3b3fd8' : p.bar}" stroke-width="1.5"`)
        c.px(0.072 * c.W, (y + 0.018) * c.H, 160 - i * 30, 9, p.bar, 4.5)
        c.px(0.072 * c.W, (y + 0.048) * c.H, 330, 7, p.barSoft, 3.5)
      })
      c.rect(0.0256, 0.749, 0.086, 0.032, p.line, 7)
      c.rect(0.765, 0.749, 0.11, 0.032, p.line, 7)
      c.rect(0.886, 0.749, 0.088, 0.032, '#3b3fd8', 7)
    },
    sheet(c, p, tint, theme) {
      page(c, p, mainWindow(c, p, tint, theme))
      c.rect(0, 0, 1, 1, p.dim)
      c.rect(0.3, 0.17, 0.4, 0.66, p.sheet, 18, `stroke="${p.line}" stroke-width="1"`)
      c.px(0.33 * c.W, 0.21 * c.H, 240, 16, p.bar, 8)
      c.px(0.33 * c.W, 0.25 * c.H, 380, 8, p.barSoft, 4)
      SPACES.forEach((color, i) => {
        const y = 0.31 + i * 0.13
        c.px(0.33 * c.W, y * c.H, 18, 18, mix(color, '#ffffff', 0.85), 5)
        c.px(0.355 * c.W, y * c.H + 4, 120, 10, p.bar, 5)
        for (let k = 0; k < 2; k++) {
          c.px(0.355 * c.W, (y + 0.035 + k * 0.032) * c.H, 14, 14, ICONS[(i * 2 + k) % ICONS.length], 4)
          c.px(0.373 * c.W, (y + 0.035 + k * 0.032) * c.H + 3, 160 - k * 30, 7, p.barSoft, 3.5)
        }
        c.px(0.665 * c.W, y * c.H, 18, 18, ACCENT, 5)
      })
      c.rect(0.5, 0.758, 0.09, 0.036, p.line, 8)
      c.rect(0.6, 0.758, 0.08, 0.036, ACCENT, 8)
    },
    site(c, p, tint, theme, voted = false) {
      const box = mainWindow(c, p, tint, theme)
      c.rect(box.x, box.y, box.w, 0.07, p.card)
      c.circle((box.x + 0.03) * c.W, (box.y + 0.035) * c.H, 13, mix('#21acd8', '#0b2238', 0.6))
      for (let i = 0; i < 5; i++) c.px((box.x + 0.07 + i * 0.06) * c.W, (box.y + 0.03) * c.H, 56, 8, p.barSoft, 4)
      c.rect(box.x + box.w - 0.1, box.y + 0.018, 0.08, 0.034, ACCENT, 9)
      c.px(0.29 * c.W, 0.18 * c.H, 420, 30, p.bar, 10)
      c.px(0.29 * c.W, 0.24 * c.H, 560, 10, p.barSoft, 5)
      ;[0.3, 0.465, 0.63].forEach((y, i) => {
        card(c, p, 0.29, y, 0.64, 0.14, `stroke="${p.line}" stroke-width="1"`)
        c.px(0.31 * c.W, (y + 0.035) * c.H, 300 - i * 40, 14, p.bar, 7)
        lines(c, p, 0.31, y + 0.075, 0.45, 0.05, 20, 11 + i, 7)
        const filled = voted && i === 0
        c.rect(0.83, y + 0.047, 0.07, 0.045, filled ? ACCENT : 'none', 11, `stroke="${ACCENT}" stroke-width="2"`)
        c.px(0.848 * c.W, (y + 0.065) * c.H, 40, 8, filled ? '#ffffff' : mix(ACCENT, p.card, 0.6), 4)
      })
    },
    'site-voted'(c, p, tint, theme) {
      DRAW.site(c, p, tint, theme, true)
    },
    'other-app'(c, p) {
      c.rect(0, 0, 1, 1, p.card)
      c.rect(0, 0, 1, 0.075, p.chrome)
      c.rect(0, 0.075, 1, 0.0015, p.line)
      lights(c, 22, 27)
      c.rect(0, 0.075, 0.28, 0.925, p.page)
      for (let i = 0; i < 7; i++) {
        c.px(24, (0.12 + i * 0.1) * c.H, 200, 10, p.bar, 5)
        c.px(24, (0.12 + i * 0.1) * c.H + 22, 160, 7, p.barSoft, 3.5)
      }
      c.px(0.32 * c.W, 0.14 * c.H, 360, 22, p.bar, 8)
      lines(c, p, 0.32, 0.23, 0.6, 0.18, 30, 21)
      c.px(0.32 * c.W, 0.46 * c.H - 5, 0.1 * c.W - 12, 9, p.barSoft, 4.5)
      c.rect(0.42 - 0.08, 0.46 - 0.008, 0.16, 0.016, mix(ACCENT, p.card, 0.85), 4)
      c.rect(0.42 - 0.08, 0.46 + 0.012, 0.16, 0.003, ACCENT)
      lines(c, p, 0.32, 0.52, 0.6, 0.3, 30, 22)
    },
    reader(c, p, tint, theme) {
      const box = mainWindow(c, p, tint, theme)
      c.rect(box.x, box.y, box.w, box.h, p.card)
      c.px(0.47 * c.W, 0.12 * c.H, 460, 30, p.bar, 10)
      c.px(0.47 * c.W, 0.18 * c.H, 200, 9, p.barSoft, 4.5)
      lines(c, p, 0.47, 0.25, 0.4, 0.66, 32, 31, 10)
    },
    pdf(c, p, tint, theme) {
      const box = mainWindow(c, p, tint, theme)
      c.rect(box.x, box.y, box.w, box.h, theme === 'dark' ? '#0f0f10' : '#dcdce0')
      c.rect(0.48, 0.09, 0.26, 0.9, '#ffffff', 4)
      c.px(0.5 * c.W, 0.15 * c.H, 200, 18, 'rgba(0,0,0,0.16)', 6)
      for (let i = 0; i < 18; i++) c.px(0.5 * c.W, (0.21 + i * 0.038) * c.H, 300 - (i % 5) * 26, 7, 'rgba(0,0,0,0.08)', 3.5)
    },
    translate(c, p, tint, theme) {
      const box = mainWindow(c, p, tint, theme)
      page(c, p, box, 8)
      c.rect(0.62, 0.075, 0.2, 0.04, mix(ACCENT, p.card, 0.14), 10)
      c.px(0.635 * c.W, 0.09 * c.H, 18, 10, ACCENT, 3)
      c.px(0.655 * c.W, 0.09 * c.H, 120, 9, mix(ACCENT, p.card, 0.6), 4.5)
    },
    notes(c, p, tint, theme) {
      page(c, p, mainWindow(c, p, tint, theme), 5)
      c.rect(0.73, 0.06, 0.255, 0.92, p.card, 14, `stroke="${p.line}" stroke-width="1"`)
      c.px(0.75 * c.W, 0.1 * c.H, 160, 14, p.bar, 7)
      lines(c, p, 0.75, 0.16, 0.21, 0.7, 30, 41)
    },
    themes(c, p, tint, theme) {
      const box = mainWindow(c, p, tint, theme)
      c.rect(box.x, box.y, box.w, box.h, p.page)
      card(c, p, 0.33, 0.14, 0.56, 0.72)
      const colors = [...SPACES, ...ICONS].slice(0, 12)
      colors.forEach((color, i) => c.circle((0.39 + (i % 6) * 0.083) * c.W, (0.33 + Math.floor(i / 6) * 0.2) * c.H, 38, color, i === 0 ? `stroke="${ACCENT}" stroke-width="5"` : ''))
      c.rect(0.37, 0.72, 0.48, 0.012, p.line, 6)
      c.rect(0.37, 0.72, 0.3, 0.012, ACCENT, 6)
    },
    vault(c, p, tint, theme) {
      const box = mainWindow(c, p, tint, theme)
      c.rect(box.x, box.y, box.w, box.h, p.page)
      card(c, p, 0.44, 0.18, 0.4, 0.64)
      const cx = 0.64 * c.W
      const cy = 0.38 * c.H
      for (let i = 0; i < 4; i++) c.circle(cx, cy, 18 + i * 14, 'none', `stroke="${ACCENT}" stroke-width="5" stroke-dasharray="${40 + i * 18} ${14 + i * 6}" stroke-linecap="round"`)
      for (let i = 0; i < 3; i++) {
        c.px(0.48 * c.W, (0.56 + i * 0.07) * c.H, 22, 22, ICONS[i + 3], 6)
        c.px(0.51 * c.W, (0.56 + i * 0.07) * c.H + 6, 180, 9, p.bar, 4.5)
        for (let k = 0; k < 6; k++) c.circle((0.72 + k * 0.013) * c.W, (0.56 + i * 0.07) * c.H + 11, 4, p.bar)
      }
    },
    extensions(c, p, tint, theme) {
      const box = mainWindow(c, p, tint, theme)
      c.rect(box.x, box.y, box.w, box.h, p.page)
      c.px(0.27 * c.W, 0.1 * c.H, 260, 26, p.bar, 9)
      for (let i = 0; i < 9; i++) {
        const x = 0.27 + (i % 3) * 0.235
        const y = 0.2 + Math.floor(i / 3) * 0.25
        card(c, p, x, y, 0.21, 0.2)
        c.px((x + 0.02) * c.W, (y + 0.035) * c.H, 46, 46, ICONS[i % ICONS.length], 12)
        c.px((x + 0.075) * c.W, (y + 0.045) * c.H, 120, 10, p.bar, 5)
        c.px((x + 0.075) * c.W, (y + 0.08) * c.H, 90, 7, p.barSoft, 3.5)
        c.px((x + 0.155) * c.W, (y + 0.14) * c.H, 44, 22, i % 4 === 3 ? p.line : '#3b3fd8', 11)
      }
    }
  }

  function settingsFrame(c, p) {
    c.rect(0, 0, 1, 1, p.card)
    c.rect(0, 0, 1, 0.21, p.chrome)
    lights(c, 16, 16)
    c.px(c.W / 2 - 40, 0.03 * c.H, 80, 11, p.bar, 5.5)
    c.rect(0.0154, 0.0855, 0.9692, 0.0395, p.page, 8, `stroke="${p.line}" stroke-width="1"`)
    for (let i = 0; i < 8; i++) {
      const x = 0.075 + i * 0.1215
      if (i === 4) c.rect(x - 0.057, 0.132, 0.115, 0.068, mix(ACCENT, p.card, 0.14), 8)
      c.circle(x * c.W, 0.152 * c.H, 7, 'none', `stroke="${i === 4 ? '#3b3fd8' : p.bar}" stroke-width="1.6"`)
      c.px(x * c.W - 24, 0.172 * c.H, 48, 7, i === 4 ? '#3b3fd8' : p.barSoft, 3.5)
    }
    c.rect(0, 0.21, 1, 0.0015, p.line)
    c.px(0.0256 * c.W, 0.238 * c.H, 220, 18, p.bar, 8)
    c.px(0.0256 * c.W, 0.274 * c.H, 330, 8, p.barSoft, 4)
    c.rect(0.68, 0.237, 0.29, 0.04, p.page, 14)
  }

  function svg(name, width, height, theme, tint, label, colors) {
    SPACES = colors.spaces
    FAVORITES = colors.favorites
    ICONS = colors.icons
    const draw = DRAW[name] ?? DRAW.main
    const p = PALETTES[theme === 'dark' ? 'dark' : 'light']
    const c = canvas(width, height)
    draw(c, p, tint || SPACES[0], theme)
    if (label) c.raw(`<text x="18" y="${height - 18}" font-family="ui-monospace, Menlo, monospace" font-size="${Math.round(width / 60)}" fill="#8e8e93">${label}</text>`)
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${c.parts.join('')}</svg>`
  }

  window.FilmPlaceholders = { svg, names: Object.keys(DRAW) }
})()
