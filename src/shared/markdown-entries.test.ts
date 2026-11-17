// Where the Markdown export can be started from, besides the menu: the command bar and the shortcuts list. What it does is in
// markdown-export.test.ts (the conversion), engine/resource-fetch.test.ts (the images) and shell/markdown-export.test.ts (the outcomes).
import { describe, expect, it } from 'vitest'
import { actionToDispatch, rankCandidates } from './command-bar'
import { COMMANDS, effectiveAccelerator } from './keybindings'
import { DROPPED_TAGS, MD_PAGE_CONFIG, MD_LIMITS, parsePick, parseReply, MAX_REPLY_CHARS } from './markdown-export'
import { createInitialState, reduce, type Ctx } from './sidebar'

function stateOn(url: string) {
  let n = 0
  const ctx: Ctx = { now: 1000, newId: () => `id${++n}` }
  return reduce(createInitialState(ctx), { type: 'tab/open', url }, ctx)
}

describe('the command bar', () => {
  const asked = (query: string, url: string) => rankCandidates(query, stateOn(url)).filter((c) => c.kind === 'action' && c.action === 'export-markdown')

  it('offers the export when it is asked for, with a web page on screen', () => {
    for (const query of ['markdown', 'exporter', 'export page', 'Exporter la page en Markdown']) {
      expect(asked(query, 'https://example.com/a'), query).toMatchObject([{ label: 'Exporter la page en Markdown', detail: 'Action' }])
    }
  })

  it('does not offer it for a page that is not a web page, nor on an empty bar', () => {
    expect(asked('markdown', 'about:blank')).toEqual([])
    expect(asked('markdown', 'file:///tmp/a.html')).toEqual([])
    expect(asked('', 'https://example.com/a')).toEqual([])
  })

  it('changes no state: the main process starts the export', () => {
    expect(actionToDispatch('export-markdown', stateOn('https://example.com/'))).toBeNull()
  })
})

describe('the shortcuts', () => {
  it('lists the export, with no shortcut of its own until the user gives it one', () => {
    const command = COMMANDS.find((c) => c.id === 'exportMarkdown')
    expect(command).toMatchObject({ label: 'Exporter la page en Markdown…', group: 'Fichier', accelerator: '' })
    expect(effectiveAccelerator('exportMarkdown', undefined)).toBeUndefined()
    expect(effectiveAccelerator('exportMarkdown', { exportMarkdown: 'CmdOrCtrl+Alt+M' })).toBe('CmdOrCtrl+Alt+M')
  })
})

describe('what the page script is told', () => {
  it('gives the page the same lists and limits the snapshot is checked against', () => {
    expect(MD_PAGE_CONFIG.dropped).toEqual([...DROPPED_TAGS])
    expect(MD_PAGE_CONFIG.limits).toMatchObject({ nodes: MD_LIMITS.nodes, depth: MD_LIMITS.depth, textChars: MD_LIMITS.textChars, url: MD_LIMITS.url })
    // Nothing the converter drops can be asked for, and no tag is both fixed by the converter and left to the page's display.
    expect(MD_PAGE_CONFIG.dropped).toContain('script')
    expect(MD_PAGE_CONFIG.structural.filter((tag) => MD_PAGE_CONFIG.blockDefault.includes(tag))).toEqual([])
    expect(MD_PAGE_CONFIG.unsupported.every((tag) => MD_PAGE_CONFIG.dropped.includes(tag))).toBe(true)
  })
})

describe('parseReply and parsePick', () => {
  const snapshot = { nodes: ['x'], warnings: [], truncated: false }

  it('reads the answer of the picker', () => {
    expect(parsePick(JSON.stringify({ action: 'copy', scope: 'blocks', snapshot }))).toEqual({ action: 'copy', scope: 'blocks', snapshot })
    expect(parsePick(JSON.stringify({ action: 'save', scope: 'selection', snapshot }))).toMatchObject({ action: 'save', scope: 'selection' })
  })

  it('reads the error the page reports, without control characters or more than a sentence', () => {
    expect(parsePick(JSON.stringify({ error: 'boom\u0000\u202e' + 'x'.repeat(1000) }))).toEqual({ error: `boom${'x'.repeat(296)}` })
  })

  it('refuses anything else: not a string, not JSON, not an object, an unknown action or scope, no snapshot', () => {
    for (const reply of [null, undefined, 42, {}, '', 'nope', '[]', '"x"', 'null', JSON.stringify({ action: 'delete', scope: 'blocks', snapshot }), JSON.stringify({ action: 'copy', scope: 'page', snapshot }), JSON.stringify({ action: 'copy', scope: 'blocks' }), JSON.stringify({ action: 'copy', scope: 'blocks', snapshot: 'x' }), JSON.stringify({ action: 'copy', scope: 'blocks', snapshot: [] })]) {
      expect(parsePick(reply), String(reply)).toBeNull()
    }
  })

  it('refuses an answer too long to be a snapshot within the limits, unread', () => {
    const long = `{"action":"copy","scope":"blocks","snapshot":{"nodes":["${'x'.repeat(MAX_REPLY_CHARS)}"]}}`
    expect(parsePick(long)).toBeNull()
    expect(parseReply(long)).toBeNull()
    expect(parseReply('{"nodes":[]}')).toEqual({ nodes: [] })
  })
})
