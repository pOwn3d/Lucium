// « Toujours afficher les barres de défilement » (Réglages Système › Apparence): the lists of the interface that hide their bar draw it while the system
// is told to always show them. macOS keeps the choice as `AppleShowScrollBars` in NSUserDefaults: "Automatic" (the bars appear with the pointer device or
// when scrolling), "WhenScrolling", or "Always". Only "Always" is followed: for the others the system itself decides, and the interface keeps its lists clean.

import type { AttributeHost } from './accessibility'

/** The attribute of the root the stylesheets read (`:root[data-scrollbars='always']`), and its value while the system always shows the bars. */
export const SCROLL_BARS_ATTRIBUTE = 'data-scrollbars'
export const SCROLL_BARS_ALWAYS = 'always'

/** Whether the value of `AppleShowScrollBars` says "always". Anything else (another word, no value at all, a value of another type) is not. */
export function scrollBarsAlwaysShown(value: unknown): boolean {
  return value === 'Always'
}

/** Puts the attribute on the root while the system always shows the bars, and takes it off otherwise. Idempotent: a snapshot calls it each time. */
export function applyScrollBars(root: AttributeHost, always: boolean): void {
  if (always) root.setAttribute(SCROLL_BARS_ATTRIBUTE, SCROLL_BARS_ALWAYS)
  else root.removeAttribute(SCROLL_BARS_ATTRIBUTE)
}
