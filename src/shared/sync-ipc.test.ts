// The check of what the Settings page « Synchronisation » may ask (docs/synchronisation.md §13.1, AGENTS.md §6: the main process revalidates every IPC message).
import { describe, expect, it } from 'vitest'
import { DEFAULT_SYNC_CATEGORIES, parseSyncRequest, SYNC_CATEGORIES } from './sync-ipc'

describe('parseSyncRequest: what is accepted', () => {
  it.each([
    [{ kind: 'status' }],
    [{ kind: 'open-window' }],
    [{ kind: 'prolong' }],
    [{ kind: 'close-window' }],
    [{ kind: 'pair-start' }],
    [{ kind: 'pair-close' }],
    [{ kind: 'leave' }],
    [{ kind: 'enable', on: true }],
    [{ kind: 'enable', on: false }],
    [{ kind: 'category', category: 'openTabs', on: true }],
    [{ kind: 'answer', allow: true }],
    [{ kind: 'answer', allow: false }],
    [{ kind: 'forget', id: 'iphone-0000000001' }]
  ])('%j', (request) => {
    expect(parseSyncRequest(request)).toEqual(request)
  })

  it('accepts every category, and only them', () => {
    for (const category of SYNC_CATEGORIES) expect(parseSyncRequest({ kind: 'category', category, on: false })).toEqual({ kind: 'category', category, on: false })
    for (const category of ['', 'Structure', 'history', 'passwords', 'locks', '__proto__', 1, null, undefined, ['structure']]) expect(parseSyncRequest({ kind: 'category', category, on: true }), String(category)).toBeNull()
  })
})

describe('parseSyncRequest: what is refused', () => {
  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a text', 'status'],
    ['a number', 1],
    ['a list', [{ kind: 'status' }]],
    ['no kind', {}],
    ['a kind that does not exist', { kind: 'export-key' }],
    ['a kind with a different case', { kind: 'Status' }],
    ['a kind that is not a text', { kind: 3 }],
    ['an inherited kind', Object.create({ kind: 'status' }) as unknown],
    ['a field more on a request with no field', { kind: 'status', extra: 1 }],
    ['a field more on enable', { kind: 'enable', on: true, password: 'x' }],
    ['enable with a text for on', { kind: 'enable', on: 'true' }],
    ['enable with no value', { kind: 'enable' }],
    ['enable with a number', { kind: 'enable', on: 1 }],
    ['category with no on', { kind: 'category', category: 'structure' }],
    ['category with a text for on', { kind: 'category', category: 'structure', on: 'yes' }],
    ['answer with no value', { kind: 'answer' }],
    ['answer with a text', { kind: 'answer', allow: 'allow' }],
    ['forget with no identifier', { kind: 'forget' }],
    ['forget with an identifier with a space', { kind: 'forget', id: 'a b' }],
    ['forget with an identifier of 65 characters', { kind: 'forget', id: 'a'.repeat(65) }],
    ['forget with an empty identifier', { kind: 'forget', id: '' }],
    ['forget with a path', { kind: 'forget', id: '../../etc/passwd' }],
    ['forget with a number', { kind: 'forget', id: 5 }]
  ])('%s', (_name, request) => {
    expect(parseSyncRequest(request)).toBeNull()
  })

  it('refuses an array that carries a kind of its own: a plain object is all there is', () => {
    expect(parseSyncRequest(Object.assign([], { kind: 'status' }))).toBeNull()
    expect(parseSyncRequest(Object.assign([], { kind: 'enable', on: true }))).toBeNull()
  })

  it('never lets a field of the page choose a path, a port, an address, a key or a secret: the requests carry none', () => {
    for (const field of ['path', 'port', 'host', 'address', 'key', 'secret', 'fingerprint', 'file']) expect(parseSyncRequest({ kind: 'status', [field]: 'x' }), field).toBeNull()
  })
})

describe('the defaults of the categories [Q2]', () => {
  it('tick the structure alone', () => {
    expect(DEFAULT_SYNC_CATEGORIES).toEqual({ structure: true, settings: false, archive: false, openTabs: false })
    expect(Object.keys(DEFAULT_SYNC_CATEGORIES)).toEqual([...SYNC_CATEGORIES])
  })
})
