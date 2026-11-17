// The montage page of the film. `window.film.load(plan)` builds every scene once (scripts/site-film/layout.ts makes the plan); then
// `window.film.frame(state)` puts the scenes of one frame in place (timeline.ts, frameState) and resolves once the images it shows are decoded.
// Every style is computed from the time of the frame: no CSS animation, no clock, no random number, so a frame always gives the same picture.
'use strict'
;(() => {
  const stage = document.getElementById('stage')
  const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
  const lerp = (a, b, u) => a + (b - a) * u
  /** How far `t` is into a stretch that starts at `start` and lasts `duration` (0 before, 1 after). */
  const between = (t, start, duration) => (duration <= 0 ? (t >= start ? 1 : 0) : clamp((t - start) / duration))
  const ease = {
    out: (u) => 1 - Math.pow(1 - u, 3),
    outQuint: (u) => 1 - Math.pow(1 - u, 5),
    inOut: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
    sine: (u) => -(Math.cos(Math.PI * u) - 1) / 2
  }
  const COLORS = {
    light: { text: '#1d1d1f', muted: '#6e6e73' },
    dark: { text: '#f5f5f7', muted: '#86868b' }
  }
  const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
  /** Two colours `#rrggbb` mixed: `k` 0 gives the first, 1 the second. */
  const mixColor = (a, b, k) => {
    const [x, y] = [hex(a), hex(b)]
    return `#${x.map((v, i) => Math.round(lerp(v, y[i], k)).toString(16).padStart(2, '0')).join('')}`
  }
  const CURSOR = '<svg viewBox="0 0 28 40" width="28" height="40"><path d="M3 2.5v29l7.2-6.6 4.6 10.6 4.6-2-4.5-10.4h10z" fill="#000" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/></svg>'

  let W = 1920
  let H = 1080
  let FPS = 30
  let scenes = []
  let labels = false
  /** The colours of the demonstration, for the neutral drawings. */
  let colors = null
  /** The decodes a frame waits for (an image whose source changed: a clip), and the images that could not be decoded. */
  const pending = []
  const broken = []

  function el(tag, cls, parent) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (parent) parent.appendChild(node)
    return node
  }
  const place = (node, b) => Object.assign(node.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` })
  const show = (node, on) => {
    node.style.display = on ? '' : 'none'
  }
  /** Sets the source of an image only when it changes, and makes the frame wait for its decode. */
  function setSrc(img, src) {
    if (img.getAttribute('src') === src) return
    img.setAttribute('src', src)
    pending.push(img.decode().catch(() => broken.push(src)))
  }

  // ---------- media: a capture, a screen recording, or a neutral drawing ----------

  function mediaLayer(media, parent) {
    if (media.kind === 'placeholder') {
      const holder = el('div', 'layer', parent)
      holder.innerHTML = window.FilmPlaceholders.svg(media.placeholder, media.width, media.height, media.theme, media.tint, labels ? media.shot : '', colors)
      const svg = holder.firstChild
      svg.setAttribute('width', '100%')
      svg.setAttribute('height', '100%')
      return { node: holder, media }
    }
    const img = el('img', 'layer', parent)
    img.setAttribute('src', media.kind === 'clip' ? media.frames[0] : media.url)
    img.alt = ''
    return { node: img, media }
  }

  /** The frame of a clip at a time of its scene. */
  function clipFrame(layer, at, t) {
    const frames = layer.media.frames
    setSrc(layer.node, frames[clamp(Math.floor((t - at) * FPS + 1e-6), 0, frames.length - 1)])
  }

  const REVEAL = { rise: 0.6, pop: 0.32, fade: 0.4 }

  /** A window of the application: its shadow, its stills stacked in order (a reveal adds the piece that moves), and the veils of its rings. */
  function makeWindow(parent, stills, size, rings) {
    const root = el('div', 'win', parent)
    root.style.width = `${size.width}px`
    root.style.height = `${size.height}px`
    el('div', 'shadow', root)
    const body = el('div', 'body', root)
    const layers = stills.map((still) => {
      const base = mediaLayer(still.media, body)
      let piece = null
      if (still.reveal) {
        piece = mediaLayer(still.media, body)
        const [x, y, w, h] = still.reveal.rect
        piece.node.style.clipPath = `inset(${y * 100}% ${(1 - x - w) * 100}% ${(1 - y - h) * 100}% ${x * 100}%)`
        piece.node.style.transformOrigin = `${(x + w / 2) * 100}% ${(y + h / 2) * 100}%`
      }
      return { still, base, piece }
    })
    const veils = (rings || [])
      .filter((ring) => ring.veil)
      .map((ring) => {
        const node = el('div', 'veil', body)
        const pad = 6
        const [x, y, w, h] = ring.rect
        place(node, { x: x * size.width - pad, y: y * size.height - pad, w: w * size.width + 2 * pad, h: h * size.height + 2 * pad })
        return { ring, node }
      })
    return { root, body, layers, veils, size }
  }

  function setHole(node, rect, size) {
    const [x, y, w, h] = rect
    const s = node.style
    s.maskImage = s.webkitMaskImage = 'linear-gradient(#000 0 0), linear-gradient(#000 0 0)'
    s.maskSize = s.webkitMaskSize = `${size.width}px ${size.height}px, ${w * size.width}px ${h * size.height}px`
    s.maskPosition = s.webkitMaskPosition = `0 0, ${x * size.width}px ${y * size.height}px`
    s.maskRepeat = s.webkitMaskRepeat = 'no-repeat'
    s.maskComposite = 'exclude'
    s.webkitMaskComposite = 'xor'
  }
  function clearMask(node) {
    const s = node.style
    s.maskImage = s.webkitMaskImage = ''
  }

  /** The stills of a window at a time: the newest one that has fully come in hides those under it; the next one fades or is revealed. */
  function updateStills(win, t) {
    const progress = (still, k) => (k === 0 ? 1 : between(t, still.at, still.reveal ? REVEAL[still.reveal.motion] : still.fade))
    let top = 0
    win.layers.forEach((layer, k) => {
      if (progress(layer.still, k) >= 1) top = k
    })
    win.layers.forEach((layer, k) => {
      const { still, base, piece } = layer
      const p = progress(still, k)
      const on = k >= top && (k === 0 || t >= still.at)
      show(base.node, on)
      if (piece) show(piece.node, on && k > top)
      if (!on) return
      if (still.media.kind === 'clip') clipFrame(base, still.at, t)
      if (k === top) {
        base.node.style.opacity = '1'
        clearMask(base.node)
        return
      }
      if (!still.reveal) {
        base.node.style.opacity = String(ease.inOut(p))
        return
      }
      const e = ease.out(p)
      setHole(base.node, still.reveal.rect, win.size)
      base.node.style.opacity = String(ease.inOut(p))
      if (still.media.kind === 'clip') clipFrame(piece, still.at, t)
      const motion = still.reveal.motion
      const [, , , rh] = still.reveal.rect
      if (motion === 'rise') {
        const distance = Math.min(win.size.height * 0.25, rh * win.size.height * 0.4) + 30
        piece.node.style.transform = `translateY(${((1 - e) * distance).toFixed(2)}px)`
        piece.node.style.opacity = String(clamp(p * 2.2))
      } else if (motion === 'pop') {
        piece.node.style.transform = `scale(${(0.965 + 0.035 * e).toFixed(4)})`
        piece.node.style.opacity = String(ease.out(clamp(p * 1.6)))
      } else {
        piece.node.style.transform = ''
        piece.node.style.opacity = String(ease.inOut(p))
      }
    })
  }

  // ---------- the camera: where the window is, and how large ----------

  function camera(plan, t, size) {
    const B = plan.window
    const M = plan.geometry.media
    const keys = plan.camera
    if (!keys.length) return { s: B.scale, tx: B.x, ty: B.y }
    const resolve = (key) => {
      const f = key.focus || [0.5, 0.5]
      const A = key.to ? [M.x + key.to[0] * M.w, M.y + key.to[1] * M.h] : [B.x + f[0] * B.w, B.y + f[1] * B.h]
      return { z: key.zoom, f, A }
    }
    let a = keys[0]
    let b = keys[0]
    let u = 0
    if (t >= keys[keys.length - 1].at) a = b = keys[keys.length - 1]
    else if (t > keys[0].at) {
      for (let i = 0; i < keys.length - 1; i++) {
        if (t >= keys[i].at && t < keys[i + 1].at) {
          a = keys[i]
          b = keys[i + 1]
          u = ease.sine((t - a.at) / (b.at - a.at))
          break
        }
      }
    }
    const ra = resolve(a)
    const rb = resolve(b)
    const z = Math.exp(lerp(Math.log(ra.z), Math.log(rb.z), u))
    const f = [lerp(ra.f[0], rb.f[0], u), lerp(ra.f[1], rb.f[1], u)]
    const A = [lerp(ra.A[0], rb.A[0], u), lerp(ra.A[1], rb.A[1], u)]
    const s = B.scale * z
    return { s, tx: A[0] - s * f[0] * size.width, ty: A[1] - s * f[1] * size.height }
  }
  const toScreen = (cam, size, fx, fy) => [cam.tx + cam.s * fx * size.width, cam.ty + cam.s * fy * size.height]
  const applyCamera = (node, cam) => {
    node.style.transform = `translate(${cam.tx.toFixed(2)}px, ${cam.ty.toFixed(2)}px) scale(${cam.s.toFixed(5)})`
  }

  // ---------- rings, marks, keys, pointer ----------

  /** How visible a ring is: in over a third of a second, out over a quarter. */
  const ringLevel = (ring, t) => ease.out(between(t, ring.from, 0.35)) * (1 - ease.inOut(between(t, ring.to - 0.25, 0.25)))

  function makeRings(parent, rings) {
    return rings.map((ring) => ({ ring, node: el('div', 'ring', parent) }))
  }
  function updateRings(rings, veils, cam, size, t) {
    for (const { ring, node } of rings) {
      const level = ringLevel(ring, t)
      show(node, level > 0.001)
      if (level <= 0.001) continue
      const pad = 8
      const [x, y] = toScreen(cam, size, ring.rect[0], ring.rect[1])
      const w = ring.rect[2] * size.width * cam.s
      const h = ring.rect[3] * size.height * cam.s
      const grow = 1 + 0.04 * (1 - level)
      place(node, { x: x - pad, y: y - pad, w: w + 2 * pad, h: h + 2 * pad })
      node.style.opacity = String(level)
      node.style.transform = `scale(${grow.toFixed(4)})`
    }
    for (const { ring, node } of veils) node.style.opacity = String(ringLevel(ring, t))
  }

  function makeMarks(parent, marks) {
    return marks.map((mark) => ({ mark, node: el('div', 'mark', parent) }))
  }
  function updateMarks(marks, cam, size, t) {
    for (const { mark, node } of marks) {
      const grow = ease.out(between(t, mark.from, 0.5))
      const level = 1 - between(t, mark.to - 0.25, 0.25)
      show(node, grow > 0 && level > 0)
      if (!(grow > 0 && level > 0)) continue
      const [x1, y1] = toScreen(cam, size, mark.line[0], mark.line[1])
      const [x2, y2] = toScreen(cam, size, mark.line[2], mark.line[3])
      const length = Math.hypot(x2 - x1, y2 - y1)
      const angle = Math.atan2(y2 - y1, x2 - x1)
      Object.assign(node.style, { left: `${x1}px`, top: `${y1 - 2}px`, width: `${length}px`, opacity: String(level) })
      node.style.transform = `rotate(${angle}rad) scaleX(${grow.toFixed(4)})`
    }
  }

  function makeKeys(parent, keys, size) {
    return keys.map((k) => {
      const node = el('div', 'keys', parent)
      node.style.fontSize = `${size}px`
      const caps = k.keys.map((label) => {
        const cap = el('div', 'key', node)
        cap.textContent = label
        return cap
      })
      return { k, node, caps }
    })
  }
  function updateKeys(keys, cam, size, t) {
    for (const { k, node, caps } of keys) {
      const level = ease.out(between(t, k.at - 0.45, 0.3)) * (1 - ease.inOut(between(t, k.at + 0.2, 0.25)))
      show(node, level > 0.001)
      if (level <= 0.001) continue
      const down = t >= k.at - 0.04 && t < k.at + 0.14
      caps.forEach((cap) => cap.classList.toggle('down', down))
      const [x, y] = toScreen(cam, size, k.point[0], k.point[1])
      const lift = (1 - level) * 18 + (down ? 3 : 0)
      Object.assign(node.style, { left: `${x - node.offsetWidth / 2}px`, top: `${y - node.offsetHeight / 2}px`, opacity: String(level) })
      node.style.transform = `translateY(${lift.toFixed(2)}px) scale(${(0.97 + 0.03 * level).toFixed(4)})`
    }
  }

  function makeCursor(parent, keys) {
    if (!keys.length) return null
    const node = el('div', 'cursor', parent)
    node.innerHTML = CURSOR
    const ripple = el('div', 'ripple', parent)
    const hints = keys.filter((k) => k.key).map((k) => {
      const hint = el('div', 'keys', parent)
      hint.style.fontSize = '26px'
      const cap = el('div', 'key', hint)
      cap.textContent = k.key
      return { k, node: hint, cap }
    })
    return { keys, node, ripple, hints }
  }
  function updateCursor(cursor, cam, size, t) {
    if (!cursor) return
    const { keys, node, ripple, hints } = cursor
    const first = keys[0]
    const last = keys[keys.length - 1]
    const level = ease.out(between(t, first.at - 0.55, 0.3)) * (1 - between(t, last.at + 0.7, 0.35))
    const screen = (k) => toScreen(cam, size, k.point[0], k.point[1])
    let pos = screen(first)
    if (t >= last.at) pos = screen(last)
    else if (t > first.at) {
      for (let i = 0; i < keys.length - 1; i++) {
        const a = keys[i]
        const b = keys[i + 1]
        if (t >= a.at && t < b.at) {
          const span = Math.min(0.85, b.at - a.at)
          const u = ease.inOut(between(t, b.at - span, span))
          const [ax, ay] = screen(a)
          const [bx, by] = screen(b)
          const dist = Math.hypot(bx - ax, by - ay)
          // A slight arc, as a hand moves.
          const bow = Math.sin(Math.PI * u) * 0.12 * dist
          const nx = dist > 0 ? -(by - ay) / dist : 0
          const ny = dist > 0 ? (bx - ax) / dist : 0
          pos = [lerp(ax, bx, u) + nx * bow, lerp(ay, by, u) + ny * bow]
          break
        }
      }
    }
    let press = 0
    let wave = -1
    for (const k of keys) {
      if (!k.click) continue
      const age = t - k.at
      if (age >= -0.06 && age < 0.18) press = Math.max(press, Math.sin(Math.PI * clamp((age + 0.06) / 0.24)))
      if (age >= 0 && age < 0.5) wave = age / 0.5
    }
    const scale = cam.s * (1 - 0.14 * press)
    show(node, level > 0.001)
    node.style.opacity = String(level)
    node.style.transform = `translate(${(pos[0] - 3).toFixed(2)}px, ${(pos[1] - 2.5).toFixed(2)}px) scale(${scale.toFixed(4)})`
    show(ripple, wave >= 0 && level > 0.001)
    if (wave >= 0) {
      const r = 6 + 30 * ease.out(wave)
      Object.assign(ripple.style, { left: `${pos[0] - r}px`, top: `${pos[1] - r}px`, width: `${2 * r}px`, height: `${2 * r}px`, opacity: String(0.6 * (1 - wave)) })
    }
    for (const hint of hints) {
      const on = ease.out(between(t, hint.k.at - 0.6, 0.25)) * (1 - between(t, hint.k.at + 0.35, 0.25)) * level
      show(hint.node, on > 0.001)
      if (on <= 0.001) continue
      hint.cap.classList.toggle('down', t >= hint.k.at - 0.05 && t < hint.k.at + 0.2)
      Object.assign(hint.node.style, { left: `${pos[0] + 26 * cam.s}px`, top: `${pos[1] + 34 * cam.s}px`, opacity: String(on) })
    }
  }

  // ---------- text ----------

  /**
   * The lines of a scene in its box. Inline: the lines follow each other on one line (the first dark, the others grey), and the line shrinks to
   * fit its box, or wraps between lines when that would make it too small. Stacked: one line under the other, each wrapping in the box. Lines
   * with a style (the address, the small print) always get a row of their own.
   */
  function makeText(parent, plan, box, size, align, flow) {
    const node = el('div', `text ${align} ${flow}`, parent)
    place(node, box)
    node.style.fontSize = `${size}px`
    const rows = []
    let row = null
    const lines = plan.lines.map((line, i) => {
      if (line.style || !row || flow === 'stack') {
        row = el('div', `row${line.style ? ` ${line.style}` : ''}`, node)
        rows.push(row)
      } else row.appendChild(document.createTextNode(' '))
      const mask = el('span', 'line', row)
      const inner = el('span', '', mask)
      inner.textContent = line.text
      if (flow === 'stack') inner.style.display = 'block'
      return { line, inner, index: i }
    })
    if (flow === 'inline') {
      for (const r of rows) {
        r.style.whiteSpace = 'nowrap'
        const ratio = box.w / Math.max(1, r.scrollWidth)
        if (ratio < 1) {
          if (ratio >= 0.8) r.style.fontSize = `${ratio}em`
          else r.style.whiteSpace = 'normal'
        }
      }
    }
    return { node, lines }
  }
  function updateText(text, plan, t) {
    const palette = COLORS[plan.backdrop === 'dark' ? 'dark' : 'light']
    const visible = text.lines.filter((l) => t >= l.line.at)
    for (const l of text.lines) {
      const p = between(t, l.line.at, 0.8)
      const e = ease.outQuint(p)
      const from = plan.textMotion === 'fall' ? -1 : 1
      l.inner.style.transform = `translateY(${(from * (1 - e) * 108).toFixed(2)}%)`
      l.inner.style.opacity = String(ease.out(clamp(p * 1.4)))
      if (l.line.style) continue
      let grey = 0
      if (plan.focusLines) {
        const next = visible.find((v) => v.index > l.index && !v.line.style)
        grey = next ? ease.inOut(between(t, next.line.at, 0.45)) : 0
      } else if (plan.layout !== 'center' && l.index > 0) grey = 1
      l.inner.style.color = mixColor(palette.text, palette.muted, grey)
    }
  }

  // ---------- the scenes ----------

  function textBoxOf(plan) {
    const geo = plan.geometry
    if (plan.kind === 'icon') return { x: 0, y: H / 2 + (W > H ? 105 : 120), w: W, h: 150 }
    if (plan.kind === 'closing') return { x: 0, y: H / 2 - 20, w: W, h: 300 }
    return geo.text
  }

  function buildScene(plan, data) {
    const section = el('section', `scene ${plan.backdrop}`, stage)
    const geo = plan.geometry
    if (geo.tile) {
      const bg = el('div', 'tilebg', section)
      place(bg, geo.tile)
      bg.style.borderRadius = `${geo.tile.radius}px`
    }
    const media = el('div', 'media', section)
    if (geo.tile) {
      const tile = geo.tile
      media.style.clipPath = `inset(${tile.y}px ${W - tile.x - tile.w}px ${H - tile.y - tile.h}px ${tile.x}px round ${tile.radius}px)`
    }
    // A screen recording shows the gesture itself: the windows that slide (spaces) or open (little) give way to it.
    const recorded = (plan.kind === 'spaces' || plan.kind === 'little') && plan.stills.some((s) => s.media.kind === 'clip')
    const builder = BUILDERS[recorded ? 'window' : plan.kind]
    const updateMedia = builder(plan, media, data, section)
    const text = makeText(section, plan, textBoxOf(plan), geo.size, geo.align, geo.flow)
    return {
      plan,
      el: section,
      update(t) {
        updateMedia(t)
        updateText(text, plan, t)
      }
    }
  }

  const BUILDERS = {
    window(plan, media) {
      const size = { width: plan.stills[0].media.width, height: plan.stills[0].media.height }
      const win = makeWindow(media, plan.stills, size, plan.rings)
      const rings = makeRings(media, plan.rings)
      const marks = makeMarks(media, plan.marks)
      const keys = makeKeys(media, plan.keys, W > H ? 54 : 44)
      const cursor = makeCursor(media, plan.cursor)
      return (t) => {
        const cam = camera(plan, t, size)
        if (plan.enter === 'rise') {
          const u = ease.outQuint(between(t, 0, 1.35))
          cam.ty += (1 - u) * (H - plan.window.y + 80)
        }
        applyCamera(win.root, cam)
        updateStills(win, t)
        updateRings(rings, win.veils, cam, size, t)
        updateMarks(marks, cam, size, t)
        updateKeys(keys, cam, size, t)
        updateCursor(cursor, cam, size, t)
      }
    },

    /** Windows side by side, one per space, that slide like the spaces do; the background takes a breath of the colour of each space. */
    spaces(plan, media, data, section) {
      const B = plan.window
      const wins = plan.stills.map((still) => makeWindow(media, [{ ...still, at: 0, fade: 0 }], { width: still.media.width, height: still.media.height }, []))
      // Wide enough that the neighbours are out of the frame when a window has settled.
      const gap = Math.max(W * 0.07, B.x + 60)
      return (t) => {
        let pos = 0
        let dip = 0
        plan.stills.forEach((still, k) => {
          if (k === 0) return
          const u = between(t, still.at, 1.0)
          pos += ease.inOut(u)
          dip = Math.max(dip, Math.sin(Math.PI * u))
        })
        const index = Math.min(Math.floor(pos), plan.stills.length - 1)
        const frac = pos - index
        const tintA = plan.stills[index].media.tint
        const tintB = plan.stills[Math.min(index + 1, plan.stills.length - 1)].media.tint
        section.style.background = mixColor('#ffffff', mixColor(tintA, tintB, frac), 0.06)
        const shrink = 1 - 0.07 * dip
        wins.forEach((win, k) => {
          const s = B.scale * shrink
          const w = win.size.width * s
          const h = win.size.height * s
          const x = B.x + (B.w - w) / 2 + (k - pos) * (B.w + gap)
          const y = B.y + (B.h - h) / 2
          show(win.root, x < W && x + w > 0)
          applyCamera(win.root, { s, tx: x, ty: y })
          updateStills(win, t)
        })
      }
    },

    /** A neutral window (or the capture of another application), the pointer clicks a link in it, and the small window opens above. */
    little(plan, media) {
      const [back, front] = plan.stills
      const M = plan.geometry.media
      const wide = W > H
      const backScale = (wide ? 1000 : 760) / back.media.width
      const backBox = { x: wide ? 250 : 50, y: M.y + (wide ? 40 : 30), s: backScale }
      const frontScale = wide ? 0.8 : 0.62
      const frontBox = { x: wide ? 905 : 440, y: M.y + (wide ? 200 : 250), s: frontScale }
      const backWin = makeWindow(media, [{ ...back, at: 0, fade: 0 }], { width: back.media.width, height: back.media.height }, [])
      const frontWin = front ? makeWindow(media, [{ ...front, at: 0, fade: 0 }], { width: front.media.width, height: front.media.height }, []) : null
      const cursor = makeCursor(media, plan.cursor)
      const backCam = { s: backBox.s, tx: backBox.x, ty: backBox.y }
      return (t) => {
        applyCamera(backWin.root, backCam)
        updateStills(backWin, t)
        updateCursor(cursor, backCam, backWin.size, t)
        if (!frontWin) return
        const p = between(t, front.at, 0.5)
        show(frontWin.root, p > 0)
        if (p <= 0) return
        const e = ease.out(p)
        const click = plan.cursor.find((k) => k.click)
        const origin = click ? toScreen(backCam, backWin.size, click.point[0], click.point[1]) : [frontBox.x, frontBox.y]
        const k = 0.55 + 0.45 * e
        const s = frontBox.s * k
        applyCamera(frontWin.root, { s, tx: lerp(origin[0], frontBox.x, e), ty: lerp(origin[1], frontBox.y, e) })
        frontWin.root.style.opacity = String(clamp(p * 1.8))
        updateStills(frontWin, t)
      }
    },

    /** A grid of tiles that come in one after the other, then light up in turn, about one a second, with their captions. */
    mosaic(plan, media) {
      const wide = W > H
      const cols = wide ? 4 : 3
      const margin = wide ? 140 : 60
      const gapX = wide ? 34 : 24
      const gapY = wide ? 30 : 26
      const tileW = (W - 2 * margin - (cols - 1) * gapX) / cols
      const tileH = tileW * 0.625
      const capH = wide ? 44 : 40
      const rows = Math.ceil(plan.tiles.length / cols)
      const M = plan.geometry.media
      const gridH = rows * (tileH + capH) + (rows - 1) * gapY
      const top = M.y + Math.max(0, (M.h - gridH) / 2) - (wide ? 10 : 0)
      const grid = el('div', '', media)
      Object.assign(grid.style, { position: 'absolute', inset: '0', transformOrigin: `50% ${top + gridH / 2}px` })
      const tiles = plan.tiles.map((tile, i) => {
        const row = Math.floor(i / cols)
        const inRow = Math.min(cols, plan.tiles.length - row * cols)
        const col = i - row * cols
        const x = (W - inRow * tileW - (inRow - 1) * gapX) / 2 + col * (tileW + gapX)
        const y = top + row * (tileH + capH + gapY)
        const node = el('div', 'tile', grid)
        place(node, { x, y, w: tileW, h: tileH + capH })
        const frame = el('div', 'frame', node)
        place(frame, { x: 0, y: 0, w: tileW, h: tileH })
        const inner = el('div', '', frame)
        const scale = Math.max(tileW / tile.media.width, tileH / tile.media.height)
        Object.assign(inner.style, { left: '0', top: '0', width: `${tile.media.width}px`, height: `${tile.media.height}px`, transformOrigin: '0 0', transform: `scale(${scale})` })
        mediaLayer(tile.media, inner).node.style.position = 'absolute'
        const caption = el('div', 'caption', node)
        caption.textContent = tile.caption
        caption.style.top = `${tileH + 12}px`
        const ring = el('div', 'ring', node)
        place(ring, { x: -7, y: -7, w: tileW + 14, h: tileH + 14 })
        return { node, caption, ring, i }
      })
      const START = 0.75
      const STEP = (plan.duration - START - 0.25) / plan.tiles.length
      const palette = COLORS.dark
      return (t) => {
        grid.style.transform = `scale(${(1.035 - 0.035 * ease.sine(between(t, 0, plan.duration))).toFixed(5)})`
        const focus = Math.floor((t - START) / STEP)
        const anyFocus = t >= START && focus < tiles.length
        for (const tile of tiles) {
          const enter = ease.outQuint(between(t, 0.1 + tile.i * 0.07, 0.65))
          const lit = anyFocus && focus === tile.i ? ease.out(between(t, START + tile.i * STEP, 0.3)) * (1 - between(t, START + (tile.i + 1) * STEP - 0.12, 0.12)) : 0
          const dim = anyFocus ? 0.42 + 0.58 * lit : 1
          tile.node.style.opacity = String(enter * dim)
          tile.node.style.transform = `translateY(${((1 - enter) * 28).toFixed(2)}px) scale(${(0.96 + 0.04 * enter + 0.035 * lit).toFixed(4)})`
          tile.ring.style.opacity = String(lit)
          tile.caption.style.color = mixColor(palette.muted, palette.text, lit)
        }
      }
    },

    /** The icon of the application comes in: it fades in, grows a little, then lifts to leave room for the name. */
    icon(plan, media, data) {
      const size = W > H ? 300 : 290
      const box = el('div', 'icon', media)
      place(box, { x: (W - size) / 2, y: H / 2 - size / 2 - 70, w: size, h: size })
      const img = el('img', '', box)
      img.setAttribute('src', data.icon.still)
      return (t) => {
        const lift = ease.inOut(between(t, 1.4, 0.9)) * 26
        const s = 0.94 + 0.06 * ease.out(between(t, 0, 1.1))
        box.style.opacity = String(ease.out(between(t, 0, 0.6)))
        box.style.transform = `translateY(${(-lift).toFixed(2)}px) scale(${s.toFixed(4)})`
      }
    },

    /** The icon again, and the last words; the frame fades to white at the very end. */
    closing(plan, media, data, section) {
      const size = W > H ? 270 : 260
      const img = el('img', 'icon-still', media)
      img.setAttribute('src', data.icon.still)
      place(img, { x: (W - size) / 2, y: H / 2 - size - 10, w: size, h: size })
      return (t) => {
        const e = ease.outQuint(between(t, 0.1, 1.0))
        img.style.opacity = String(ease.out(between(t, 0.1, 0.6)))
        img.style.transform = `translateY(${((1 - e) * 24).toFixed(2)}px) scale(${(0.94 + 0.06 * e).toFixed(4)})`
        section.style.opacity = String(1 - ease.inOut(between(t, plan.duration - 0.6, 0.6)))
      }
    }
  }

  // ---------- transitions ----------

  const TILE = 160
  function hash(i) {
    let x = (i + 1) * 2654435761
    x ^= x >>> 13
    x = Math.imul(x, 1274126177)
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296
  }

  function resetStyle(node) {
    Object.assign(node.style, { transform: '', opacity: '', clipPath: '', zIndex: '' })
    node.style.maskImage = node.style.webkitMaskImage = ''
    node.style.maskSize = node.style.webkitMaskSize = ''
    node.style.maskPosition = node.style.webkitMaskPosition = ''
    node.style.maskRepeat = node.style.webkitMaskRepeat = ''
  }

  function applyTransition(kind, p, out, inn) {
    out.style.zIndex = '1'
    inn.style.zIndex = '2'
    const e = ease.inOut(p)
    if (kind === 'cut') {
      show(out, p < 0.5)
      show(inn, p >= 0.5)
    } else if (kind === 'fade') {
      inn.style.opacity = String(e)
    } else if (kind === 'zoom') {
      out.style.transform = `scale(${(1 + 0.04 * e).toFixed(4)})`
      inn.style.transform = `scale(${(0.975 + 0.025 * e).toFixed(4)})`
      inn.style.opacity = String(e)
    } else if (kind === 'push-left') {
      out.style.transform = `translateX(${(-e * W).toFixed(2)}px)`
      inn.style.transform = `translateX(${((1 - e) * W).toFixed(2)}px)`
    } else if (kind === 'push-up') {
      out.style.transform = `translateY(${(-e * H).toFixed(2)}px)`
      inn.style.transform = `translateY(${((1 - e) * H).toFixed(2)}px)`
    } else if (kind === 'wipe') {
      inn.style.clipPath = `inset(0 ${((1 - e) * 100).toFixed(3)}% 0 0)`
      out.style.transform = `translateX(${(-e * 0.12 * W).toFixed(2)}px)`
    } else if (kind === 'curtain') {
      inn.style.transform = `translateY(${((1 - e) * H).toFixed(2)}px)`
      out.style.transform = `translateY(${(-e * 0.2 * H).toFixed(2)}px)`
    } else if (kind === 'blinds') {
      const bands = 10
      const step = 0.045
      const bw = W / bands
      const stops = []
      for (let i = 0; i < bands; i++) {
        const b = ease.inOut(clamp((p - i * step) / (1 - (bands - 1) * step)))
        const x0 = i * bw
        const x1 = x0 + bw * b
        stops.push(`#000 ${x0.toFixed(2)}px ${x1.toFixed(2)}px`, `transparent ${x1.toFixed(2)}px ${(x0 + bw).toFixed(2)}px`)
      }
      inn.style.maskImage = inn.style.webkitMaskImage = `linear-gradient(90deg, ${stops.join(', ')})`
    } else if (kind === 'mosaic') {
      const cols = Math.ceil(W / TILE)
      const rows = Math.ceil(H / TILE)
      const images = []
      const sizes = []
      const positions = []
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const delay = ((c / cols + r / rows) / 2) * 0.55 + hash(r * cols + c) * 0.2
          const m = ease.out(clamp((p - delay) / 0.25))
          if (m <= 0) continue
          const side = TILE * m
          images.push('linear-gradient(#000 0 0)')
          sizes.push(`${(side + 0.5).toFixed(2)}px ${(side + 0.5).toFixed(2)}px`)
          positions.push(`${(c * TILE + (TILE - side) / 2).toFixed(2)}px ${(r * TILE + (TILE - side) / 2).toFixed(2)}px`)
        }
      }
      if (images.length === 0) show(inn, false)
      else {
        inn.style.maskImage = inn.style.webkitMaskImage = images.join(', ')
        inn.style.maskSize = inn.style.webkitMaskSize = sizes.join(', ')
        inn.style.maskPosition = inn.style.webkitMaskPosition = positions.join(', ')
        inn.style.maskRepeat = inn.style.webkitMaskRepeat = 'no-repeat'
      }
    }
  }

  // ---------- the interface of the page ----------

  async function load(data) {
    W = data.format.width
    H = data.format.height
    FPS = data.fps
    labels = data.labels === true
    colors = data.colors
    stage.textContent = ''
    Object.assign(stage.style, { width: `${W}px`, height: `${H}px` })
    document.documentElement.lang = data.lang
    scenes = data.scenes.map((plan) => buildScene(plan, data))
    // Every frame of the clips, decoded once, so that a frame that shows one only has to pick it.
    const sources = new Set([...document.images].map((img) => img.getAttribute('src')))
    for (const plan of data.scenes) for (const still of plan.stills) if (still.media.kind === 'clip') for (const frame of still.media.frames) sources.add(frame)
    const failed = []
    await Promise.all(
      [...sources].map((src) => {
        const img = new Image()
        img.src = src
        return img.decode().catch(() => failed.push(src))
      })
    )
    await Promise.all([...document.images].map((img) => img.decode().catch(() => failed.push(img.getAttribute('src')))))
    return { scenes: scenes.length, images: sources.size, failed: [...new Set(failed)] }
  }

  async function frame(state) {
    pending.length = 0
    const on = new Set(state.layers.map((layer) => layer.scene))
    scenes.forEach((scene, i) => {
      scene.el.classList.toggle('on', on.has(i))
      if (on.has(i)) {
        resetStyle(scene.el)
        show(scene.el, true)
      }
    })
    for (const layer of state.layers) scenes[layer.scene].update(layer.local)
    if (state.transition) applyTransition(state.transition.kind, state.transition.progress, scenes[state.transition.from].el, scenes[state.transition.to].el)
    await Promise.all(pending)
    // An image that cannot be decoded would leave a hole in the film: the render stops and says which one.
    if (broken.length) throw new Error(`image illisible : ${broken.splice(0).join(', ')}`)
    await new Promise((resolve) => requestAnimationFrame(() => resolve()))
  }

  window.film = { load, frame }

  // The preview page (pnpm film:site --page): the plan and the frames come from data.js, with a slider and a play button.
  if (window.FILM_PREVIEW) {
    const { data, frames } = window.FILM_PREVIEW
    load(data).then(() => {
      const bar = el('div', 'scrub', document.body)
      const play = el('button', '', bar)
      play.textContent = 'Lire'
      const range = el('input', '', bar)
      Object.assign(range, { type: 'range', min: '0', max: String(frames.length - 1), value: '0' })
      const out = el('output', '', bar)
      let index = 0
      let playing = false
      let last = 0
      const draw = (i) => {
        index = clamp(i, 0, frames.length - 1)
        range.value = String(index)
        const f = frames[index]
        out.textContent = `${f.time.toFixed(2)} s · image ${f.frame}`
        frame(f)
      }
      range.addEventListener('input', () => draw(Number(range.value)))
      play.addEventListener('click', () => {
        playing = !playing
        play.textContent = playing ? 'Pause' : 'Lire'
        last = performance.now()
      })
      const tick = (now) => {
        if (playing && now - last >= 1000 / FPS) {
          last = now
          draw(index + 1 >= frames.length ? 0 : index + 1)
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      draw(0)
    })
  }
})()
