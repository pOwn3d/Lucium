import { describe, expect, it, vi } from 'vitest'
import { SETTINGS_PANES, SETTINGS_SUBPAGES } from '@shared/ipc'
import { defaultSettings } from '@shared/model'
import { NEW_NOTE_REQUEST, NOTES_LIST_REQUEST } from '@shared/notes'
import { createInitialState } from '@shared/sidebar'

// ipc.ts reaches Electron only when a message arrives; the check under test is a pure function.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))

const { validOverlay } = await import('./ipc')

const store = { get: () => ({ ...createInitialState({ now: 0, newId: () => 'x' }), settings: defaultSettings() }) }

describe('the Settings window the interface may open', () => {
  it('opens a pane, and a place inside it that the Settings window knows', () => {
    expect(validOverlay({ panel: 'settings' }, store)).toBe(true)
    expect(validOverlay({ panel: 'settings', pane: 'protection' }, store)).toBe(true)
    expect(validOverlay({ panel: 'settings', pane: 'protection', anchor: 'permissions' }, store)).toBe(true)
    expect(validOverlay({ panel: 'settings', pane: 'files', anchor: 'downloads' }, store)).toBe(true)
  })

  it('opens a subpage by its name, as an address of the window names it after the page (#protection/filterlists)', () => {
    for (const anchor of SETTINGS_SUBPAGES) expect(validOverlay({ panel: 'settings', pane: 'protection', anchor }, store), anchor).toBe(true)
    expect(validOverlay({ panel: 'settings', pane: 'protection', anchor: 'filterlist' }, store)).toBe(false)
  })

  it('opens each of the 11 pages of the window, and the category « Général » of the previous layout (the window leads it to its page)', () => {
    expect(validOverlay({ panel: 'settings', pane: 'general', anchor: 'guide' }, store)).toBe(true)
    for (const pane of SETTINGS_PANES) expect(validOverlay({ panel: 'settings', pane }, store), pane).toBe(true)
  })

  it('no longer knows the older panes: the interface names a page (the old addresses are led by resolveSettingsTarget, not by the IPC)', () => {
    for (const pane of ['advanced', 'privacy', 'links', 'shortcuts']) expect(validOverlay({ panel: 'settings', pane }, store), pane).toBe(false)
  })

  it('refuses a pane or a place it does not know, whatever else the request says', () => {
    for (const request of [{ panel: 'settings', pane: 'nowhere' }, { panel: 'settings', anchor: 'nowhere' }, { panel: 'settings', pane: 'protection', anchor: 'x"); alert(1); ("' }, { panel: 'settings', anchor: 42 }]) {
      expect(validOverlay(request, store), JSON.stringify(request)).toBe(false)
    }
  })
})

describe('the Extensions page the interface may open', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop'

  it('opens the list, the page of one extension, or the shortcuts', () => {
    expect(validOverlay({ panel: 'extensions' }, store)).toBe(true)
    expect(validOverlay({ panel: 'extensions', target: { view: 'list' } }, store)).toBe(true)
    expect(validOverlay({ panel: 'extensions', target: { view: 'detail', extensionId: id, profileId: 'default' } }, store)).toBe(true)
    expect(validOverlay({ panel: 'extensions', target: { view: 'shortcuts' } }, store)).toBe(true)
  })

  it('refuses a target that is not one: nothing but an extension id and a profile id ends up in the address of the window', () => {
    for (const target of [{ view: 'other' }, { view: 'detail', extensionId: 'x"); alert(1); ("' }, { view: 'detail', extensionId: id, profileId: '../../x' }, 'list', 42, { view: 'list', extra: 1 }]) {
      expect(validOverlay({ panel: 'extensions', target }, store), JSON.stringify(target)).toBe(false)
    }
  })
})

describe('the panels the interface may open', () => {
  it('opens the region selection', () => {
    expect(validOverlay({ panel: 'capture' }, store)).toBe(true)
  })

  // The sheet holds a capture of the page: only the capture flow of the main process opens it, for a picture it holds.
  it('never opens the annotation sheet, whatever the request says', () => {
    for (const request of [{ panel: 'annotate' }, { panel: 'annotate', id: '0f8fad5b-d9cb-469f-a165-70867728950e', width: 800, height: 600 }]) {
      expect(validOverlay(request, store), JSON.stringify(request)).toBe(false)
    }
  })
})

describe('the menu of a space the interface may open', () => {
  const state = createInitialState({ now: 0, newId: () => 'x' })
  const spaceId = state.spaces[0]!.id
  const anchor = { x: 8, y: 120, width: 300, height: 36 }

  it('opens for a space that exists, hung from a header button that is a rectangle of the window', () => {
    expect(validOverlay({ panel: 'spacemenu', spaceId, anchor }, store)).toBe(true)
  })

  it('refuses a space that does not exist, a missing or mad anchor, and a space that is not a text', () => {
    for (const request of [
      { panel: 'spacemenu', spaceId: 'nobody', anchor },
      { panel: 'spacemenu', spaceId },
      { panel: 'spacemenu', spaceId, anchor: { x: 'a', y: 1, width: 1, height: 1 } },
      { panel: 'spacemenu', spaceId, anchor: { x: 1e9, y: 1, width: 1, height: 1 } },
      { panel: 'spacemenu', spaceId: 42, anchor },
      { panel: 'spacemenu', anchor }
    ]) {
      expect(validOverlay(request, store), JSON.stringify(request)).toBe(false)
    }
  })

  it('is not one of the panels a private window may open: it keeps a single space and nothing to manage', async () => {
    const { canOpenInPrivate } = await import('@shared/private-window')
    expect(canOpenInPrivate('spacemenu')).toBe(false)
  })
})

describe('"Ranger les onglets…" the interface may open', () => {
  const spaceId = store.get().spaces[0]!.id

  it('opens for a space that exists', () => {
    expect(validOverlay({ panel: 'tidy', spaceId }, store)).toBe(true)
  })

  it('refuses a space that does not exist, a missing space, and a space that is not a text', () => {
    for (const request of [{ panel: 'tidy', spaceId: 'nobody' }, { panel: 'tidy' }, { panel: 'tidy', spaceId: 42 }, { panel: 'tidy', spaceId: null }]) {
      expect(validOverlay(request, store), JSON.stringify(request)).toBe(false)
    }
  })
})

describe('the panels of a space the interface may open', () => {
  const space = store.get().spaces[0]!.id

  it('opens "Personnaliser l’espace" on the name, the icon, the profile or the colours', () => {
    expect(validOverlay({ panel: 'space', spaceId: space }, store)).toBe(true)
    for (const focus of ['name', 'icon', 'profile', 'color']) expect(validOverlay({ panel: 'space', spaceId: space, focus }, store), focus).toBe(true)
  })

  it('refuses a place the panel does not have, and a space that does not exist', () => {
    for (const request of [{ panel: 'space', spaceId: space, focus: 'theme' }, { panel: 'space', spaceId: space, focus: 42 }, { panel: 'space', spaceId: 'gone' }, { panel: 'space' }]) {
      expect(validOverlay(request, store), JSON.stringify(request)).toBe(false)
    }
  })

  it('opens the theme panel, alone or from "Personnaliser l’espace" (it then offers the way back), and nothing else', () => {
    expect(validOverlay({ panel: 'theme', spaceId: space }, store)).toBe(true)
    expect(validOverlay({ panel: 'theme', spaceId: space, from: 'space' }, store)).toBe(true)
    for (const from of ['settings', 'x"); alert(1); ("', 7, null]) expect(validOverlay({ panel: 'theme', spaceId: space, from }, store), String(from)).toBe(false)
    expect(validOverlay({ panel: 'theme', spaceId: 'gone', from: 'space' }, store)).toBe(false)
  })
})

describe('the small editors hung from the element that opened them', () => {
  const state = { ...store.get(), tabs: [{ id: 't1' }], favorites: [{ id: 'f1' }], settings: { ...defaultSettings(), nameWindows: true } }
  const withEditors = { get: () => state } as unknown as Parameters<typeof validOverlay>[1]
  const requests = (anchor?: unknown): unknown[] => [
    { panel: 'tab', tabId: 't1', anchor },
    { panel: 'favorite', favoriteId: 'f1', anchor },
    { panel: 'autoreload', tabId: 't1', anchor },
    { panel: 'windowname', anchor }
  ]

  it('opens each of them with the rectangle of the element, or without one (then the sheet is centred)', () => {
    for (const request of requests({ x: 12, y: 300, width: 220, height: 32 })) expect(validOverlay(request, withEditors), JSON.stringify(request)).toBe(true)
    for (const request of requests(undefined)) expect(validOverlay(request, withEditors), JSON.stringify(request)).toBe(true)
  })

  it('refuses an anchor that is not a rectangle of the window: it places a panel on screen', () => {
    for (const anchor of [{ x: 1, y: 2 }, { x: Number.NaN, y: 0, width: 1, height: 1 }, 'row', null, { x: 1e9, y: 0, width: 1, height: 1 }]) {
      for (const request of requests(anchor)) expect(validOverlay(request, withEditors), JSON.stringify(request)).toBe(false)
    }
  })
})

describe('the notes panel the interface may open', () => {
  const withNotes = (notes: boolean) => ({ get: () => ({ ...store.get(), settings: { ...defaultSettings(), notes } }) }) as unknown as Parameters<typeof validOverlay>[1]

  it('opens it on the list or on a new note, while the function is on', () => {
    expect(validOverlay({ panel: 'notes' }, withNotes(true))).toBe(true)
    expect(validOverlay({ panel: 'notes', compose: true }, withNotes(true))).toBe(true)
    expect(validOverlay({ panel: 'notes', compose: true }, withNotes(false))).toBe(false)
    // What the toolbar's button sends from the window (the menu's own request) is let through while the notes are on, and only then.
    expect(validOverlay(NEW_NOTE_REQUEST, withNotes(true))).toBe(true)
    expect(validOverlay(NEW_NOTE_REQUEST, withNotes(false))).toBe(false)
    // And what the toolbar's « Toutes les notes » sends (File › Notes' own request): the same channel, the same refusal while the notes are off.
    expect(validOverlay(NOTES_LIST_REQUEST, withNotes(true))).toBe(true)
    expect(validOverlay(NOTES_LIST_REQUEST, withNotes(false))).toBe(false)
    expect(NOTES_LIST_REQUEST).toEqual({ panel: 'notes', scope: 'all' })
  })

  it('opens the list on « Toutes » when asked to (`scope: \'all\'`), while the function is on, and only then', () => {
    expect(validOverlay({ panel: 'notes', scope: 'all' }, withNotes(true))).toBe(true)
    expect(validOverlay({ panel: 'notes', scope: 'all' }, withNotes(false))).toBe(false)
    expect(validOverlay({ panel: 'notes', compose: true, scope: 'all' }, withNotes(true))).toBe(true)
  })

  it('refuses a scope that is not `all`: the other choices of the list depend on the page on screen, which the panel reads itself', () => {
    for (const scope of ['page', 'space', 'ALL', ' all', '', true, false, 1, null, {}, ['all']]) expect(validOverlay({ panel: 'notes', scope }, withNotes(true)), JSON.stringify(scope)).toBe(false)
  })

  it('refuses a new note asked in any other way than `true`', () => {
    for (const compose of [false, 'true', 1, null, {}]) expect(validOverlay({ panel: 'notes', compose }, withNotes(true)), String(compose)).toBe(false)
  })
})

describe('the popover of the translate button', () => {
  const anchor = { x: 900, y: 8, width: 32, height: 24 }
  const withTranslation = (translateLocal: boolean) => ({ get: () => ({ ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), translateLocal } }) })

  it('opens hung from the button, only while the translation is on', () => {
    expect(validOverlay({ panel: 'translatepop', anchor }, withTranslation(true))).toBe(true)
    expect(validOverlay({ panel: 'translatepop', anchor }, withTranslation(false))).toBe(false)
  })

  it('needs the place of the button', () => {
    for (const request of [{ panel: 'translatepop' }, { panel: 'translatepop', anchor: { x: 'a', y: 0, width: 1, height: 1 } }, { panel: 'translatepop', anchor: null }]) {
      expect(validOverlay(request, withTranslation(true)), JSON.stringify(request)).toBe(false)
    }
  })
})
