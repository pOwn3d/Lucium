// The command bar, the site panel and the downloads popover are drawn on a fill that is computed dark from the page behind them (cardSurface, popoverSurface).
// Their text takes its colours from the tokens, which follow the appearance of the system: without `color-scheme: dark` on these elements, a Mac in the light
// appearance gets dark text on the dark fill (in the command bar: results unreadable).

import { describe, expect, it } from 'vitest'
import commandBar from './command-bar.css?raw'
import popovers from './popovers.css?raw'
import sitePanel from './site-panel.css?raw'

describe('the cards drawn on a dark fill use the dark colours', () => {
  it.each([
    ['command-bar.css', commandBar, /body\.overlay \.palette:not\(\.cb-little\)\s*\{\s*color-scheme:\s*dark;/],
    ['site-panel.css', sitePanel, /body\.overlay \.scc\s*\{[^}]*color-scheme:\s*dark;/],
    ['popovers.css', popovers, /\.dlpop\s*\{\s*color-scheme:\s*dark;/]
  ])('%s', (_file, source, rule) => {
    expect(source).toMatch(rule)
  })

  it('leaves the Mini-fenêtre to the appearance of the system: its fill is not computed from a page', () => {
    expect(commandBar).not.toMatch(/\.cb-little\s*\{[^}]*color-scheme:\s*dark/)
  })
})
