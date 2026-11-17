// Every surface of the interface (a window of its own) loads the design tokens, and loads them first (one visual system).
// The surfaces are the entries of the renderer in electron.vite.config.ts: a new one that forgets tokens.css fails here.
// Contract: the pages and the build config are static files with nothing to run or import (the config cannot be typed with the renderer's own settings), so
// they are read as data and checked by what they say (the entries built, the stylesheets linked, in order), not by the wording of a line.

import { describe, expect, it } from 'vitest'
import viteConfig from '../../electron.vite.config.ts?raw'

const pages = import.meta.glob('./*.html', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const entries = [...viteConfig.matchAll(/resolve\(__dirname, 'src\/renderer\/([\w-]+\.html)'\)/g)].map((match) => match[1]!)

describe('the surfaces of the interface', () => {
  // The windows of the annotated share and of the page annotation (docs/design/annotation-partage-fenetre.md) are listed too: they are built, and on by default
  // (LUCIUM_ANNOTATE=0 turns them off, from the sources or in a smoke run only).
  it('are the eight pages of the renderer and the three windows of the annotated-share prototype: the sidebar window, the overlay, the Mini-fenêtre, the bar of the floating video window, Réglages, the task manager, the About window, Extensions, the share view and command, and the command of the page annotation', () => {
    expect([...entries].sort()).toEqual(['about.html', 'extensions.html', 'floating-video.html', 'index.html', 'littlearc.html', 'overlay.html', 'page-annotate-command.html', 'settings.html', 'taskmanager.html', 'window-share-command.html', 'window-share-view.html'])
  })

  it('are all built: no page of the folder is left out of the build, and none is missing', () => {
    expect(Object.keys(pages).map((path) => path.slice(2)).sort()).toEqual([...entries].sort())
  })

  it.each(entries)('%s loads tokens.css, before any other stylesheet and before its script', (entry) => {
    const html = pages[`./${entry}`]!
    const links = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((match) => match[1])
    expect(links[0]).toBe('./tokens.css')
    expect(links.filter((href) => href === './tokens.css')).toHaveLength(1)
    expect(html.indexOf('./tokens.css')).toBeLessThan(html.indexOf('<script'))
  })

  it('keep a policy that lets the stylesheet in: styles come from the app itself', () => {
    for (const entry of entries) expect(pages[`./${entry}`]!, entry).toMatch(/style-src 'self'/)
  })
})
