// ElectronPage.find: which search takes a request of the find bar. Chromium's own search takes a plain text with the case option; the expression, the
// whole words and the accents go to Lucium's engine (regex-find.ts), with the text read as it is typed for an expression and taken literally otherwise.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FindOptions } from '@shared/ipc'
import { makePage } from './electron-page.test-support'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const finderCalls: Array<[string, Record<string, unknown>]> = []
let stops = 0
vi.mock('./regex-find', async (original) => ({
  ...(await original<typeof import('./regex-find')>()),
  RegexFinder: class {
    active = false
    find(pattern: string, options: Record<string, unknown>): void {
      this.active = true
      finderCalls.push([pattern, options])
    }
    stop(): void {
      stops++
      this.active = false
    }
  }
}))

afterEach(() => {
  finderCalls.length = 0
  stops = 0
})

describe('ElectronPage.find', () => {
  it('leaves a plain search to Chromium, with its case option, and starts none of ours', async () => {
    const { page, wc } = await makePage()
    page.find('école', { matchCase: true, forward: false, next: true })
    expect(wc.findInPage).toHaveBeenCalledWith('école', { forward: false, findNext: true, matchCase: true })
    expect(finderCalls).toEqual([])
  })

  it.each<[string, FindOptions, string, string]>([
    ['an expression', { regex: true }, 'a.+b', 'a.+b'],
    ['whole words', { wholeWord: true }, 'a.+b', 'a\\.\\+b'],
    ['accents', { accents: true }, 'a(b)', 'a\\(b\\)']
  ])('gives %s to our engine, and Chromium none of it', async (_name, options, text, pattern) => {
    const { page, wc } = await makePage()
    page.find(text, { ...options, matchCase: true, next: true })
    expect(finderCalls).toEqual([[pattern, expect.objectContaining({ matchCase: true, next: true, wholeWord: options.wholeWord, literal: options.regex !== true })]])
    expect(wc.findInPage).not.toHaveBeenCalled()
  })

  it('ends our engine\'s search when the next request is a plain one', async () => {
    const { page, wc } = await makePage()
    page.find('abc', { wholeWord: true })
    page.find('abc', {})
    expect(wc.findInPage).toHaveBeenCalledTimes(1)
    expect(stops).toBe(1)
  })
})
