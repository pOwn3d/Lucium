import { describe, expect, it } from 'vitest'
import { NO_PAGE_TOOLS, TOOL_NAMES, parseToolMessage, toolMessageText } from './page-tools'
import { pageToolsFor } from './page-tools-for'
import { defaultSettings } from './model'
import { SCROLL_MAX_PX, SCROLL_MEMORY_MAX, SCROLL_MEMORY_SCRIPTS, SCROLL_MIN_PX, parseScrollFile, scrollFileText, scrollKeptFor, scrollMemoryApplyScript, scrollRemembered, scrollToRestore, type ScrollMemory } from './scroll-memory'

const NONCE = 'n0nce'
const empty: ScrollMemory = new Map()

describe('the scroll memory', () => {
  it('keeps where a tab was and gives it back at the same address only', () => {
    const memory = scrollRemembered(empty, 't', 'https://a.example/p', 900, 1)
    expect(scrollToRestore(memory, 't', 'https://a.example/p')).toBe(900)
    expect(scrollToRestore(memory, 't', 'https://a.example/q')).toBeUndefined()
    expect(scrollToRestore(memory, 'other', 'https://a.example/p')).toBeUndefined()
  })

  it('forgets the tab that came back near the top', () => {
    const memory = scrollRemembered(scrollRemembered(empty, 't', 'https://a.example/', 900, 1), 't', 'https://a.example/', SCROLL_MIN_PX - 1, 2)
    expect(memory.has('t')).toBe(false)
  })

  it('drops the oldest positions past the limit', () => {
    let memory: ScrollMemory = empty
    for (let i = 0; i < SCROLL_MEMORY_MAX + 5; i++) memory = scrollRemembered(memory, `t${i}`, 'https://a.example/', 500, i)
    expect(memory.size).toBe(SCROLL_MEMORY_MAX)
    expect(memory.has('t0')).toBe(false)
    expect(memory.has(`t${SCROLL_MEMORY_MAX + 4}`)).toBe(true)
  })

  it('forgets the tabs that are gone', () => {
    const memory = scrollRemembered(scrollRemembered(empty, 'a', 'https://a.example/', 500, 1), 'b', 'https://b.example/', 500, 2)
    expect([...scrollKeptFor(memory, new Set(['b'])).keys()]).toEqual(['b'])
    expect(scrollKeptFor(memory, new Set(['a', 'b']))).toBe(memory)
  })

  it('round-trips through the file text, and leaves out what is not a valid entry', () => {
    const memory = scrollRemembered(empty, 't', 'https://a.example/', 900, 7)
    expect(parseScrollFile(scrollFileText(memory))).toEqual(memory)
    const text = JSON.stringify({ version: 1, tabs: { ok: { url: 'https://a.example/', y: 500, at: 1 }, a: { url: 3, y: 500, at: 1 }, b: { url: 'https://a.example/', y: -4, at: 1 }, c: { url: 'https://a.example/', y: 1.5, at: 1 }, d: { url: 'https://a.example/', y: SCROLL_MAX_PX + 1, at: 1 }, e: null, f: { url: 'https://a.example/', y: 5, at: 1 } } })
    expect([...parseScrollFile(text).keys()]).toEqual(['ok'])
    expect(parseScrollFile('{"tabs":[1]}').size).toBe(0)
    expect(() => parseScrollFile('{ no')).toThrow()
  })
})

describe('the tool of the page', () => {
  it('is carried only while the setting is on, for a web page that is not private', () => {
    const on = { ...defaultSettings(), rememberScroll: true }
    expect(pageToolsFor(on, 'https://a.example/', false).scrollMemory).toBe(true)
    expect(pageToolsFor(on, 'https://a.example/', false, false).scrollMemory).toBe(false)
    expect(pageToolsFor(on, 'file:///x.html', false).scrollMemory).toBe(false)
    expect(pageToolsFor(defaultSettings(), 'https://a.example/', false)).toBe(NO_PAGE_TOOLS)
    expect(TOOL_NAMES).toContain('scrollMemory')
  })

  it('reports a position as a whole number of pixels, and nothing else is believed', () => {
    expect(parseToolMessage(toolMessageText(NONCE, { tool: 'scrollpos', y: 1234 }), NONCE)).toEqual({ tool: 'scrollpos', y: 1234 })
    const prefix = toolMessageText(NONCE, { tool: 'scrollpos', y: 0 }).replace(/\{.*$/, '')
    for (const body of ['{"tool":"scrollpos","y":-1}', '{"tool":"scrollpos","y":1.5}', '{"tool":"scrollpos","y":"9"}', '{"tool":"scrollpos"}', `{"tool":"scrollpos","y":${SCROLL_MAX_PX + 1}}`]) expect(parseToolMessage(prefix + body, NONCE), body).toBe('invalid')
  })

  it('has an install script that listens and cleans up after itself, and a command that only moves a page that carries it', () => {
    const install = SCROLL_MEMORY_SCRIPTS.install(NONCE)
    expect(install).toContain("tool: 'scrollpos'")
    expect(install).toContain("addEventListener('scroll'")
    expect(install).toContain("removeEventListener('scroll'")
    expect(scrollMemoryApplyScript(900)).toContain('tools.scrollMemory.apply(900)')
    expect(scrollMemoryApplyScript(Number.NaN)).toContain('apply(0)')
  })
})
