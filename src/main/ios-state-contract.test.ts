// The iOS application (ios/) reads and rewrites the Mac's state file. ios/Contracts/state-reference.json is a state written by the Mac's own
// store, and LuciumKit (BrowserStateContractTests) reads it, writes it back and compares. This test is the Mac's half: it makes the file from the
// Mac's code, so a change of the format shows up as a change of this file in the same pull request. The Swift half then says whether the iPhone
// still reads it: a field the Mac adds goes through the Swift model's `rest` and passes, a field the Swift model reads and the Mac breaks fails.
//
// The file is a vitest file snapshot: written when it is missing, refused when it differs (always in CI), and rewritten by
// `pnpm exec vitest run src/main/ios-state-contract.test.ts -u` once the change of the format is meant.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STATE_VERSION } from '@shared/model'
import { createInitialState, type Action, type Ctx } from '@shared/sidebar'
import { StateStore, WRITER_FIELD, loadState } from './store'
import { tempDir } from './temp-dir'

const REFERENCE = join(__dirname, '../../ios/Contracts/state-reference.json')

/** Ids and clock that never change, so that the file only moves when the format does. */
function steadyCtx(): Ctx {
  let n = 0
  return { now: 1_790_000_000_000, newId: () => `id-${++n}` }
}

/**
 * A state as a person who uses the browser leaves it: two spaces (one with a letter icon), pinned and loose tabs, a tab with
 * every optional field the Mac writes, a tab in a folder, a page to read later. It is written by `StateStore`, the code that writes `state.json`.
 */
function referenceText(): string {
  const dir = tempDir('lucium-ios-contract-')
  const path = join(dir, 'state.json')
  const ctx = steadyCtx()
  const store = new StateStore(createInitialState(ctx), path, undefined, { asyncWrites: false, appVersion: '1.0.0' })
  const first = store.get().spaces[0]!.id
  const run = (...actions: Action[]): void => actions.forEach((action) => store.dispatch(action, ctx))
  const lastTab = (): string => store.get().tabs.at(-1)!.id

  run({ type: 'space/create', name: 'Travail', emoji: '💼', hue: 220, profileId: 'work', letterIcon: { letter: 'TR', color: '#3366cc', round: true } })
  const second = store.get().spaces[1]!.id

  run({ type: 'tab/open', url: 'https://carnet.example/notes', spaceId: first })
  const notes = lastTab()
  run(
    { type: 'tab/update', id: notes, patch: { title: 'Carnet', faviconUrl: 'https://carnet.example/favicon.ico' } },
    { type: 'tab/pin', id: notes },
    { type: 'tab/rename', id: notes, title: 'Mes notes' },
    { type: 'tab/icon', id: notes, icon: '📓' },
    { type: 'tab/keep-awake', id: notes, keep: true },
    { type: 'tab/auto-reload', id: notes, seconds: 60 }
  )
  run({ type: 'folder/create', name: 'Lectures', spaceId: first })
  const folder = store.get().folders[0]!.id
  run({ type: 'tab/open', url: 'https://recettes.example/', spaceId: first, background: true })
  run({ type: 'tab/update', id: lastTab(), patch: { title: 'Recettes' } })
  run({ type: 'tab/move', id: lastTab(), toIndex: 0, pinned: true, folderId: folder })
  // Saving a page for later takes its tab away: the list keeps the page, not the tab.
  run({ type: 'tab/open', url: 'https://article.example/long', spaceId: first, background: true })
  run({ type: 'tab/update', id: lastTab(), patch: { title: 'Un long article' } })
  run({ type: 'readlater/add', tabId: lastTab() })
  run({ type: 'tab/open', url: 'https://projet.example/tableau', spaceId: second })
  run({ type: 'tab/update', id: lastTab(), patch: { title: 'Tableau de projet' } })

  expect(store.flush()).toBe(true)
  const text = readFileSync(path, 'utf8')
  // Pretty-printed with a final newline: the diff of a change of the format reads line by line.
  return `${JSON.stringify(JSON.parse(text), null, 2)}\n`
}

describe('iOS contract: the state file', () => {
  it('state-reference.json is the state the Mac writes (rewrite with -u when the format changes on purpose)', async () => {
    await expect(referenceText()).toMatchFileSnapshot(REFERENCE)
  })

  it('holds what the iPhone must read: the format version, the writer field, two spaces, tabs of both, a pinned one, a field the iPhone keeps in `rest`', () => {
    // Read from what the Mac writes now: the test above holds the file equal to it, and this one does not depend on the order of the writes of `-u`.
    const reference = JSON.parse(referenceText()) as Record<string, any>
    expect(reference.version).toBe(STATE_VERSION)
    expect(typeof reference[WRITER_FIELD]).toBe('string')
    expect(reference.spaces).toHaveLength(2)
    expect(new Set(reference.tabs.map((tab: { spaceId: string }) => tab.spaceId))).toEqual(new Set(reference.spaces.map((space: { id: string }) => space.id)))
    expect(reference.tabs.some((tab: { pinned: boolean }) => tab.pinned)).toBe(true)
    expect(reference.tabs.some((tab: { pinned: boolean }) => !tab.pinned)).toBe(true)
    // What the iPhone does not read yet (the contract is that it keeps it): the theme, the settings, the optional field of a tab.
    expect(reference.spaces[0].theme).toBeTypeOf('object')
    expect(reference.settings).toBeTypeOf('object')
    expect(reference.tabs.find((tab: { autoReload?: unknown }) => tab.autoReload)?.autoReload).toEqual({ seconds: 60 })
    expect(reference.folders).toHaveLength(1)
    expect(reference.readLater).toHaveLength(1)
    expect(reference.tabs.some((tab: { folderId?: string }) => tab.folderId === reference.folders[0].id)).toBe(true)
  })

  it('is a state the Mac reads and writes back unchanged: the reference is not a hand-made file the Mac itself would change', () => {
    const dir = tempDir('lucium-ios-contract-')
    const path = join(dir, 'state.json')
    const text = referenceText()
    writeFileSync(path, text)
    const store = new StateStore(loadState(path), path, undefined, { asyncWrites: false, appVersion: '1.0.0' })
    expect(store.flush()).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(text))
  })
})
