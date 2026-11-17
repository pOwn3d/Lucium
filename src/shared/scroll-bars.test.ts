// « Toujours afficher les barres de défilement »: which value of the system setting the interface follows, and how it reaches the document.

import { describe, expect, it } from 'vitest'
import { SCROLL_BARS_ALWAYS, SCROLL_BARS_ATTRIBUTE, applyScrollBars, scrollBarsAlwaysShown } from './scroll-bars'

describe('the value of AppleShowScrollBars the interface follows', () => {
  // Guard: only « Always » shows the bars of the lists the interface hides. « Automatic » (the default: the bars come with a mouse, or when scrolling) and
  // « WhenScrolling » are the system's to decide, and a value that is not a word (nothing set, a number) is not a choice either.
  it('is « Always », and nothing else', () => {
    expect(scrollBarsAlwaysShown('Always')).toBe(true)
    for (const other of ['Automatic', 'WhenScrolling', 'always', 'ALWAYS', ' Always', '', null, undefined, 1, true, {}, ['Always']]) expect(scrollBarsAlwaysShown(other), String(other)).toBe(false)
  })
})

describe('the attribute of the document', () => {
  const recorder = () => {
    const attributes = new Map<string, string>()
    return { attributes, setAttribute: (name: string, value: string) => void attributes.set(name, value), removeAttribute: (name: string) => void attributes.delete(name) }
  }

  it('is data-scrollbars="always" while the system always shows the bars, and is taken off otherwise', () => {
    expect(SCROLL_BARS_ATTRIBUTE).toBe('data-scrollbars')
    expect(SCROLL_BARS_ALWAYS).toBe('always')
    const root = recorder()
    applyScrollBars(root, true)
    expect(root.attributes.get('data-scrollbars')).toBe('always')
    applyScrollBars(root, true)
    expect([...root.attributes]).toEqual([['data-scrollbars', 'always']])
    applyScrollBars(root, false)
    expect(root.attributes.size).toBe(0)
    applyScrollBars(root, false)
    expect(root.attributes.size).toBe(0)
  })
})
