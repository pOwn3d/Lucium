// What moves in the interface of a window while nothing happens. An animation that repeats for ever makes
// the interface and the GPU draw a frame at every refresh for as long as it is on screen, up to 120 times a second. Only what says that
// something is under way may turn for ever (a load, a download of unknown size, a page being translated: they end); the badge of unread messages, the equalizer of a
// tab that plays and the notes of the mini-player play a few times and stand still.

import { describe, expect, it } from 'vitest'
import sidebarCss from './sidebar.css?raw'
import sidebarStatesCss from './sidebar-states.css?raw'
import mediaPlayerCss from './media-player.css?raw'
import toolbarCss from './toolbar.css?raw'

/** The rules that may animate for ever, each while something is under way. */
const UNDER_WAY = new Set(['.sidebar .spinner svg', '.sidebar .dlc-arc.unknown', '.tb-progress::before', '.sidebar .sidebar-reload-all.busy svg', ".tb-translate[data-state='working'] .tb-tint-lang"])

/** The selectors of the rules (the innermost ones, inside a media query too) that animate without end. */
function endless(css: string): string[] {
  const found: string[] = []
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/animation(?:-iteration-count)?\s*:[^;]*\binfinite\b/.test(body!)) found.push(selector!.replace(/\/\*[\s\S]*?\*\//g, '').trim())
  }
  return found
}

describe('the animations of the window at rest', () => {
  it('repeat for ever only while something is under way', () => {
    for (const [name, css] of Object.entries({ 'sidebar.css': sidebarCss, 'sidebar-states.css': sidebarStatesCss, 'media-player.css': mediaPlayerCss, 'toolbar.css': toolbarCss })) {
      expect(endless(css).filter((selector) => !UNDER_WAY.has(selector)), name).toEqual([])
    }
  })

  it('still animate the badge, the equalizer and the notes, a few times', () => {
    expect(sidebarStatesCss).toMatch(/\.sidebar \.tab-message-badge \{ animation: tab-badge-pulse 2s ease-in-out 2; \}/)
    expect(sidebarCss).toMatch(/\.sidebar \.equalizer \.bar \{[^}]*animation: sidebar-equalizer 0\.9s ease-in-out 2\.5;/)
    expect(mediaPlayerCss).toMatch(/\.mp-note \{ animation: mp-note-fly 2\.6s ease-out 3; \}/)
  })

  it('stand still for a person who asks the system for less motion, during « Actualiser tous les onglets »: the button, the rings, the tick and the bar', () => {
    // What the system's « Réduire les animations » asks (Lucium's own switch stops every animation: tokens.css, data-motion="reduce").
    const reduced = [...sidebarCss.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]!).join('\n')
    expect(reduced).toMatch(/\.sidebar \.sidebar-reload-all\.busy svg \{ animation: none; \}/)
    expect(reduced).toMatch(/\.sidebar \.spinner svg \{ animation: none; \}/)
    expect(reduced).toMatch(/\.sidebar \.tab-reload-mark\.reloaded \{ animation: none; \}/)
    expect(reduced).toMatch(/\.sidebar \.toast-progress::before \{ transition: none; \}/)
    // What still says that the run goes on, without moving: the pressed button and its bar, drawn outside any media query.
    expect(sidebarCss).toMatch(/\.sidebar \.sidebar-reload-all\.busy \{ background: var\(--tile-active\);/)
    expect(sidebarCss).toMatch(/\.sidebar \.sidebar-reload-all\.busy::after \{[^}]*var\(--reload-progress, 0\)/)
  })

  it('reads an endless animation wherever it is written', () => {
    expect(endless('@media (x) {\n  .a .b { color: red; animation: spin 1s linear infinite; }\n}\n.c { animation-iteration-count: infinite }\n.d { animation: x 1s 3 }')).toEqual(['.a .b', '.c'])
  })
})
