// @vitest-environment happy-dom
// The name of a small window (window-title.ts): written once the drawing is kept, in the language the snapshot set.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type Mounted } from './dom.test-support'
import { useWindowTitle } from './window-title'

function Probe({ title }: { title: string | null }) {
  useWindowTitle(title)
  return createElement('output', null, title ?? 'waiting')
}

let mounted: Mounted | null = null

beforeEach(() => {
  document.title = 'Lucium'
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('the name of a window', () => {
  it('keeps the name of the page while the language is not known, then takes the one it is given, and follows it', () => {
    mounted = mount(createElement(Probe, { title: null }))
    expect(document.title).toBe('Lucium')
    mounted.rerender(createElement(Probe, { title: 'Réglages' }))
    expect(document.title).toBe('Réglages')
    mounted.rerender(createElement(Probe, { title: 'Settings' }))
    expect(document.title).toBe('Settings')
    mounted.rerender(createElement(Probe, { title: null }))
    expect(document.title).toBe('Settings')
  })

  it('writes nothing while the window is only being drawn: a drawing that is not kept names no window', () => {
    expect(renderToStaticMarkup(createElement(Probe, { title: 'Gestionnaire de tâches' }))).toBe('<output>Gestionnaire de tâches</output>')
    expect(document.title).toBe('Lucium')
  })
})
