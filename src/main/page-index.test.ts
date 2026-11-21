import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PageIndexBook, eraseIndexWhenSwitchedOff, pageIndexFileName } from './page-index'

const body = (s: string): string => `${s} ${'lorem ipsum dolor sit amet '.repeat(3)}`
const dir = (): string => mkdtempSync(join(tmpdir(), 'lucium-page-index-'))

describe('pageIndexFileName', () => {
  it('follows the names of the histories', () => {
    expect(pageIndexFileName('default')).toBe('page-index.json')
    expect(pageIndexFileName('travail')).toBe('page-index-travail.json')
    expect(pageIndexFileName('Travail')).toBe('page-index-~travail.json')
  })
})

describe('PageIndexBook', () => {
  it('keeps a page, finds it by its text, and gives it back after a restart', () => {
    const d = dir()
    const book = new PageIndexBook(d)
    book.of('default').add({ url: 'https://a.org/', title: 'A', text: body('la tarte Tatin'), at: 1 })
    expect(book.of('default').search('tatin').map((m) => m.url)).toEqual(['https://a.org/'])
    expect(book.flush()).toBe(true)
    expect(new PageIndexBook(d).of('default').search('tatin')).toHaveLength(1)
  })
  it('keeps the profiles apart', () => {
    const book = new PageIndexBook(dir())
    book.of('default').add({ url: 'https://a.org/', title: 'A', text: body('secret'), at: 1 })
    expect(book.of('travail').search('secret')).toEqual([])
  })
  it('forgets a page, and a whole profile with its file', () => {
    const d = dir()
    const book = new PageIndexBook(d)
    book.of('default').add({ url: 'https://a.org/', title: 'A', text: body('alpha'), at: 1 })
    book.of('default').add({ url: 'https://b.org/', title: 'B', text: body('beta'), at: 2 })
    expect(book.of('default').remove('https://a.org/')).toBe(true)
    expect(book.of('default').remove('https://a.org/')).toBe(false)
    book.flush()
    expect(existsSync(join(d, 'page-index.json'))).toBe(true)
    expect(book.erase('default')).toBe(true)
    expect(existsSync(join(d, 'page-index.json'))).toBe(false)
    expect(book.of('default').search('beta')).toEqual([])
  })
  it('eraseAll removes the files of every profile, those never opened in this run included', () => {
    const d = dir()
    const first = new PageIndexBook(d)
    first.of('default').add({ url: 'https://a.org/', title: 'A', text: body('alpha'), at: 1 })
    first.of('travail').add({ url: 'https://b.org/', title: 'B', text: body('beta'), at: 2 })
    first.flush()
    writeFileSync(join(d, 'history.json'), '[]')
    const second = new PageIndexBook(d)
    expect(second.eraseAll()).toBe(true)
    expect(existsSync(join(d, 'page-index.json'))).toBe(false)
    expect(existsSync(join(d, 'page-index-travail.json'))).toBe(false)
    expect(readFileSync(join(d, 'history.json'), 'utf8')).toBe('[]')
  })
  it('sets aside a file it cannot read and starts again from none', () => {
    const d = dir()
    writeFileSync(join(d, 'page-index.json'), '{not json')
    const book = new PageIndexBook(d)
    expect(book.of('default').search('x')).toEqual([])
    expect(existsSync(join(d, 'page-index.json'))).toBe(false)
  })
})

describe('eraseIndexWhenSwitchedOff', () => {
  function store(on: boolean) {
    let state = { settings: { pageContentIndex: on } }
    const listeners = new Set<(s: typeof state) => void>()
    return {
      get: () => state,
      subscribe: (l: (s: typeof state) => void) => (listeners.add(l), () => listeners.delete(l)),
      set(next: boolean) {
        state = { settings: { pageContentIndex: next } }
        for (const l of listeners) l(state)
      }
    }
  }
  it('erases when the setting goes off, not when it goes on, nor at the start, nor for a change of another setting', () => {
    const eraseAll = vi.fn(() => true)
    const s = store(false)
    eraseIndexWhenSwitchedOff(s, { eraseAll })
    expect(eraseAll).not.toHaveBeenCalled()
    s.set(false)
    s.set(true)
    expect(eraseAll).not.toHaveBeenCalled()
    s.set(true)
    expect(eraseAll).not.toHaveBeenCalled()
    s.set(false)
    expect(eraseAll).toHaveBeenCalledTimes(1)
    s.set(false)
    expect(eraseAll).toHaveBeenCalledTimes(1)
  })
})
