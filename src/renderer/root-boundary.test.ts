// The root of every surface of the interface: a render that throws leaves a plain screen with « Recharger l'interface » instead of an
// empty window, and the errors of the page reach the log of the main process (État de Lucium) as `[ui]` lines of its console, which main relays.

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import { UI_ERROR_LINE_MAX, uiErrorLine } from '@shared/ui-errors'
import { FailedInterface, RootBoundary, UI_ERRORS_LOGGED_MAX, installUiErrorLog } from './root'
import { relayUiErrors } from '../main/shell/ui-error-relay'

afterEach(() => vi.restoreAllMocks())

describe('the boundary at the root of a surface', () => {
  it('turns a render that throws into the screen that says so', () => {
    expect(RootBoundary.getDerivedStateFromError()).toEqual({ failed: true })
    const reload = vi.fn()
    const boundary = new RootBoundary({ children: createElement('main', null, 'the sidebar'), reload })
    expect(renderToStaticMarkup(boundary.render() as ReactElement)).toContain('the sidebar')
    boundary.state = { failed: true }
    const shown = boundary.render() as ReactElement<{ reload: () => void }>
    const markup = renderToStaticMarkup(shown)
    expect(markup).toContain(t('ui.quelque-chose-s-est-mal-passe'))
    expect(markup).toContain('role="alert"')
    expect(markup).toContain(t('ui.recharger-l-interface'))
    shown.props.reload()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads the page of the interface by default (its tabs and pages are the main process’)', () => {
    const boundary = new RootBoundary({ children: null })
    boundary.state = { failed: true }
    const shown = boundary.render() as ReactElement<{ reload: () => void }>
    expect(shown.type).toBe(FailedInterface)
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    shown.props.reload()
    expect(reload).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('writes what failed as a `[ui]` line, with the stack and the components', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    new RootBoundary({ children: null }).componentDidCatch(new Error('a row with no title'), { componentStack: '\n    at Row\n    at Sidebar' })
    expect(log).toHaveBeenCalledTimes(1)
    const [line, detail, components] = log.mock.calls[0]!
    expect(String(line)).toMatch(/^\[ui\] /)
    expect(String(detail)).toContain('a row with no title')
    expect(String(components)).toContain('at Sidebar')
  })
})

describe('the errors nothing caught in the page', () => {
  it('are written as `[ui]` lines: an error and a rejection, and the count stops at the bound', () => {
    const target = new EventTarget()
    const log = vi.fn()
    const seen = installUiErrorLog(target, log)
    const error = Object.assign(new Event('error'), { error: new Error('a click handler failed') })
    target.dispatchEvent(error)
    target.dispatchEvent(Object.assign(new Event('error'), { message: 'Script error.', filename: 'index.js', lineno: 12 }))
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'no answer' }))
    expect(log.mock.calls.map((call) => String(call[0]))).toEqual(['[ui] an error was not caught:', '[ui] an error was not caught:', '[ui] a promise was rejected and nothing handled it:'])
    expect(String(log.mock.calls[0]![1])).toContain('a click handler failed')
    expect(log.mock.calls[1]![1]).toBe('Script error. (index.js:12)')
    expect(log.mock.calls[2]![1]).toBe('no answer')
    for (let i = 0; i < UI_ERRORS_LOGGED_MAX + 10; i++) target.dispatchEvent(new Event('error'))
    expect(log).toHaveBeenCalledTimes(UI_ERRORS_LOGGED_MAX + 1)
    expect(String(log.mock.calls.at(-1)![0])).toContain('are not written')
    expect(seen()).toBe(UI_ERRORS_LOGGED_MAX + 13)
  })
})

describe('the relay of the main process', () => {
  it('keeps the `[ui]` errors of an interface page, bounded, and nothing else of its console', () => {
    expect(uiErrorLine({ level: 'error', message: '[ui] the interface failed to draw: x' }, 'index')).toBe('[ui:index] the interface failed to draw: x')
    expect(uiErrorLine({ level: 'warning', message: '[ui] not an error' }, 'index')).toBeNull()
    expect(uiErrorLine({ level: 'error', message: 'a page of the user logged this' }, 'index')).toBeNull()
    expect(uiErrorLine({ level: 'error', message: 42 }, 'index')).toBeNull()
    expect(uiErrorLine({ level: 'error', message: `[ui] ${'x'.repeat(UI_ERROR_LINE_MAX * 2)}` }, 'overlay')!.length).toBeLessThan(UI_ERROR_LINE_MAX + 20)
  })

  it('listens once to the console of a surface', () => {
    const contents = new EventEmitter()
    const log = vi.fn()
    relayUiErrors(contents as never, 'settings', log)
    relayUiErrors(contents as never, 'settings', log)
    contents.emit('console-message', { level: 'error', message: '[ui] an error was not caught: boom' })
    contents.emit('console-message', { level: 'info', message: 'loaded' })
    expect(log.mock.calls).toEqual([['[ui:settings] an error was not caught: boom']])
  })
})

// Contract: the entries run only in the window of a surface; each must mount through the boundary, and main must relay each surface it loads.
describe('the surfaces (Contract: read from the source)', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('mount every entry of the interface inside the boundary', () => {
    for (const entry of ['main', 'overlay', 'littlearc', 'floating-video', 'settings', 'taskmanager', 'about', 'extensions']) {
      const source = read(`./${entry}.tsx`)
      expect(source, entry).toContain('mountRoot(')
      expect(source, entry).not.toContain('createRoot(')
    }
  })

  // That main relays the errors of each surface it loads is run, not read: main/shell/surface-load.test.ts.
})
