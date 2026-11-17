// The guide « Vous venez d’Arc ? » (shared/arc-guide.ts) in the main process: it opens by itself when the sheet that ran an import from Arc is left,
// once; Aide › Vous venez d’Arc ? opens it again; the interface cannot ask for it, and every place its buttons lead to is one the interface may open.

import { describe, expect, it, vi } from 'vitest'
import { ARC_GUIDE_PLACES, ARC_GUIDE_REQUEST, type ArcImported } from '@shared/arc-guide'
import { t } from '@shared/i18n'
import type { OverlayRequest } from '@shared/ipc'
import { defaultSettings, type SidebarState } from '@shared/model'
import { canOpenInPrivate } from '@shared/private-window'
import { createInitialState } from '@shared/sidebar'
import { methodsOf, overlayHost, showedPanel } from './browser-fake.test-support'

// ipc.ts, menu.ts and the shell reach Electron only when a message arrives, a menu is built or a method runs.
vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { validOverlay } = await import('./ipc')
const { buildMenu } = await import('./menu')
const { Browser } = await import('./browser')
const { setImportService } = await import('../importers/service')
const shell = methodsOf(Browser.prototype)

const brought: ArcImported = { spaces: 2, tabs: 30, folders: 4, favorites: 3, splits: 1 }

/** The import service of the application, as far as the window asks it: what the imports from Arc brought, once. */
function serviceBringing(imported: ArcImported | null): { taken: () => number } {
  let pending = imported
  let taken = 0
  setImportService({
    takeArcGuide: () => {
      taken++
      const answer = pending
      pending = null
      return answer
    }
  } as never)
  return { taken: () => taken }
}

/**
 * A window with this panel open, whose settings the dispatched changes edit, and whose `openOverlay` is the real one (it marks the guide as seen).
 * What the window opens is the list of `opened`; `fake.names()` has the calls it made on the rest (`activePage` is the focus going back to the page).
 */
function windowWith(panel: OverlayRequest['panel'], seen = false) {
  let state: SidebarState = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), arcGuideSeen: seen } }
  const opened: OverlayRequest[] = []
  const fake = overlayHost({}, {
    overlayRequest: { panel },
    store: { get: () => state },
    dispatch: (action: { type: string; patch?: Record<string, unknown> }) => {
      if (action.type === 'settings/update') state = { ...state, settings: { ...state.settings, ...action.patch } }
    },
    permissionQueue: [],
    authQueue: [],
    dialogQueue: [],
    reviewQueue: [],
    passphraseQueue: [],
    openArcGuideAfterImport: shell['openArcGuideAfterImport'],
    openOverlay(request: OverlayRequest) {
      opened.push(request)
      shell['openOverlay']!.call(fake.self, request)
    }
  })
  return { fake, opened, close: () => shell['closeOverlay']!.call(fake.self), seen: () => state.settings.arcGuideSeen }
}

describe('leaving the sheet of an import from Arc', () => {
  it('opens the guide with what the import brought, instead of giving the focus back to the page', () => {
    serviceBringing(brought)
    const { fake, opened, close } = windowWith('import')
    close()
    expect(opened).toEqual([{ panel: 'arcguide', imported: brought }])
    expect(showedPanel(fake, 'arcguide')).toBe(true)
    expect(fake.names()).not.toContain('activePage')
  })

  it('does the same when it is the first-launch guide that ran the import', () => {
    serviceBringing(brought)
    const { opened, close } = windowWith('firstlaunch')
    close()
    expect(opened).toEqual([{ panel: 'arcguide', imported: brought }])
  })

  it('opens nothing after an import from another browser or from a file, or when no import was made (the service has nothing from Arc)', () => {
    serviceBringing(null)
    const { fake, opened, close } = windowWith('import')
    close()
    expect(opened).toEqual([])
    expect(fake.names()).toContain('activePage')
  })

  it('opens nothing when another panel is left, and leaves what the service holds for the sheet that ran the import', () => {
    const service = serviceBringing(brought)
    for (const panel of ['history', 'spaces', 'whatsnew', 'commandbar', 'arcguide'] as const) {
      const { fake, opened, close } = windowWith(panel)
      close()
      expect(opened, panel).toEqual([])
      expect(fake.names(), panel).toContain('activePage')
    }
    expect(service.taken()).toBe(0)
  })

  it('opens once: seen, it does not open again, and what the service held is forgotten all the same', () => {
    const service = serviceBringing(brought)
    const { opened, close, seen } = windowWith('import', true)
    expect(seen()).toBe(true)
    close()
    expect(opened).toEqual([])
    expect(service.taken()).toBe(1)
  })

  it('marks the guide as seen when it opens by itself, so that the next import from Arc does not open it again', () => {
    serviceBringing(brought)
    const first = windowWith('import')
    expect(first.seen()).toBe(false)
    first.close()
    expect(first.seen()).toBe(true)
    // The state of that window is the profile's: another sheet closed after another import from Arc finds it seen.
    serviceBringing(brought)
    const again = windowWith('import', first.seen())
    again.close()
    expect(again.opened).toEqual([])
  })

  it('does not take the focus from a prompt that was waiting: the queue goes first, and the guide waits for the sheet to be left again', () => {
    const service = serviceBringing(brought)
    const { fake, opened, close } = windowWith('import')
    ;(fake.self['permissionQueue'] as unknown[]).push({ id: 'p1' })
    close()
    expect(opened.map((request) => request.panel)).toEqual(['permission'])
    expect(service.taken()).toBe(0)
  })
})

describe('opening the guide from the Help menu', () => {
  it('marks it as seen, wherever it comes from', () => {
    const { fake, opened, seen } = windowWith('history')
    expect(seen()).toBe(false)
    shell['openOverlay']!.call(fake.self, ARC_GUIDE_REQUEST)
    expect(showedPanel(fake, 'arcguide')).toBe(true)
    expect(opened).toEqual([])
    expect(seen()).toBe(true)
  })

  it('writes the flag once: a guide that was seen is shown without another write', () => {
    const { fake } = windowWith('history', true)
    const dispatched = vi.fn()
    fake.self['dispatch'] = dispatched
    shell['openOverlay']!.call(fake.self, ARC_GUIDE_REQUEST)
    expect(showedPanel(fake, 'arcguide')).toBe(true)
    expect(dispatched).not.toHaveBeenCalled()
  })

  it('is not opened in a private window, which keeps no profile to remember it in', () => {
    expect(canOpenInPrivate('arcguide')).toBe(false)
    const { fake } = windowWith('history')
    fake.self['isPrivate'] = () => true
    shell['openOverlay']!.call(fake.self, ARC_GUIDE_REQUEST)
    expect(showedPanel(fake, 'arcguide')).toBe(false)
  })

  interface Item {
    label?: string
    role?: string
    click?: () => void
    submenu?: Item[]
  }
  function help(): { item: Item | undefined; opened: OverlayRequest[]; labels: string[] } {
    const opened: OverlayRequest[] = []
    const browser = new Proxy(
      { openOverlay: (request: OverlayRequest) => void opened.push(request), menuFacts: () => ({ canGoBack: false, canGoForward: false, loading: false, finding: false, scrollSynced: false, saverAsked: false }) } as Record<string, unknown>,
      { get: (target, prop: string) => (prop in target ? target[prop] : () => false) }
    )
    const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
    const state = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: defaultSettings() }
    const template = buildMenu(browser as never, { get: () => state } as never, actions as never) as unknown as Item[]
    const submenu = template.find((entry) => entry.role === 'help')?.submenu ?? []
    return { item: submenu.find((entry) => entry.label === t('arc-guide.vous-venez-d-arc')), opened, labels: submenu.map((entry) => entry.label ?? '') }
  }

  it('is an entry of the Aide menu, next to the other guides, that opens the guide with no import', () => {
    const { item, opened, labels } = help()
    expect(item).toBeDefined()
    item!.click!()
    expect(opened).toEqual([ARC_GUIDE_REQUEST])
    const at = labels.indexOf(t('arc-guide.vous-venez-d-arc'))
    expect(labels.slice(at - 3, at)).toEqual([t('menu.nouveautes'), t('menu.premier-lancement'), t('menu.configuration-rapide')])
  })
})

describe('the guide and the interface', () => {
  const store = { get: () => ({ ...createInitialState({ now: 0, newId: () => 'x' }), settings: defaultSettings() }) }

  it('cannot be asked for by the interface: it opens from the main process (the end of an import, the menu), a page must not forge it', () => {
    expect(validOverlay({ panel: 'arcguide' }, store)).toBe(false)
    expect(validOverlay({ panel: 'arcguide', imported: { spaces: 1 } }, store)).toBe(false)
  })

  it('may open every place its buttons lead to', () => {
    for (const [name, request] of Object.entries(ARC_GUIDE_PLACES)) expect(validOverlay(request, store), name).toBe(true)
  })
})
