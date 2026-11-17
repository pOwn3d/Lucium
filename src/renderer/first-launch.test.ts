// The first-launch guide records what the user chose in it and runs the import chosen (before, its last button only
// closed the sheet). The rules are in first-launch.ts; the sheet is drawn by calling it as a function, with a state that outlives its draws and an
// interface (api) that records what it is asked.

import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { createInitialState } from '@shared/sidebar'
import type { ImportReport, ImportRequest, ImportSourceInfo } from '@shared/import-sources'
import type { SidebarState } from '@shared/model'
import { GUIDED_SETUP_REQUEST } from '@shared/settings-guide'
import { FIRST_LAUNCH_COLORS, NO_CHOICES, firstLaunchActions, firstLaunchFollowUp, firstLaunchRequest, runFirstLaunchImport } from './first-launch'

const hooks = vi.hoisted(() => ({ active: false, slots: [] as unknown[], cursor: 0 }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const useState = <T>(initial: T): [T, (next: T | ((current: T) => T)) => void] => {
    if (!hooks.active) return actual.useState(initial) as [T, (next: T | ((current: T) => T)) => void]
    const at = hooks.cursor++
    if (!(at in hooks.slots)) hooks.slots[at] = initial
    return [hooks.slots[at] as T, (next) => void (hooks.slots[at] = typeof next === 'function' ? (next as (current: T) => T)(hooks.slots[at] as T) : next)]
  }
  const ran = new Set<unknown>()
  const useEffect = (...args: Parameters<typeof actual.useEffect>): void => {
    if (!hooks.active) return actual.useEffect(...args)
    // An effect with no dependency runs once per sheet (the list of the browsers), as React runs it once on mount.
    if (ran.has(hooks.slots)) return
    ran.add(hooks.slots)
    args[0]()
  }
  return { ...actual, useState, useEffect }
})

const CHROME: ImportSourceInfo = { id: 'chrome', name: 'Google Chrome', blurb: '', categories: ['bookmarks', 'history'], profiles: [{ id: 'Default', name: 'Personne 1' }, { id: 'Profile 1', name: 'Travail' }], found: true }
const HTML: ImportSourceInfo = { id: 'html', name: 'Fichier de signets (HTML)', blurb: '', categories: ['bookmarks'], profiles: [], found: true }
const PREVIEW: ImportReport = { ok: true, message: 'Prêt à importer 3 signets.', bookmarks: 3, folders: 0, history: 0, skipped: 0, token: 'aaaaaaaa-bbbb' }
const DONE: ImportReport = { ok: true, message: '3 signets importés.', bookmarks: 3, folders: 0, history: 0, skipped: 0, undoToken: 'cccccccc-dddd' }

const ctx = { now: 1_000, newId: ((n) => () => `id${++n}`)(0) }
const calls = vi.hoisted(() => ({ dispatched: [] as unknown[], previews: [] as unknown[], confirms: [] as string[], closed: 0, opened: [] as unknown[], preview: null as unknown }))
const world = vi.hoisted(() => ({ state: null as unknown }))
vi.mock('./api', () => ({
  api: () => ({
    importSources: () => Promise.resolve([CHROME, HTML]),
    firstLaunchPreview: (request: ImportRequest) => {
      calls.previews.push(request)
      return Promise.resolve(calls.preview)
    },
    firstLaunchConfirm: (token: string) => {
      calls.confirms.push(token)
      return Promise.resolve(DONE)
    },
    dispatch: (action: unknown) => {
      calls.dispatched.push(action)
      return Promise.resolve()
    },
    closeOverlay: () => void calls.closed++,
    openOverlay: (request: unknown) => void calls.opened.push(request)
  }),
  useSnapshot: () => ({ state: world.state })
}))

import { FirstLaunchSheet } from './FirstLaunchSheet'

const state = (): SidebarState => createInitialState(ctx)

describe('what the choices of the guide record', () => {
  it('records nothing for a choice left as it was', () => {
    expect(firstLaunchActions(NO_CHOICES, state())).toEqual([])
  })

  it('records the appearance and the blocker in the settings (the blocker writes its alias too)', () => {
    expect(firstLaunchActions({ ...NO_CHOICES, appearance: 'dark', blocker: false }, state())).toEqual([{ type: 'settings/update', patch: { interfaceAppearance: 'dark', blockAds: false, blockTrackers: false } }])
  })

  it('gives the colour chosen to the space on screen, every colour of its gradient', () => {
    const s = state()
    const space = s.spaces.find((sp) => sp.id === s.activeSpaceId)!
    const [action] = firstLaunchActions({ ...NO_CHOICES, color: 'bluegreen' }, s)
    const hex = FIRST_LAUNCH_COLORS.find((color) => color.id === 'bluegreen')!.hex
    expect(action).toEqual({ type: 'space/update', id: space.id, patch: { theme: { baseColors: space.theme.baseColors.map(() => hex) } } })
  })
})

describe('the import the guide asks for', () => {
  it('is none without a browser, or with nothing of it ticked', () => {
    expect(firstLaunchRequest(NO_CHOICES)).toBeNull()
    expect(firstLaunchRequest({ ...NO_CHOICES, source: 'chrome', categories: [] })).toBeNull()
  })

  it('names the browser, its profile and what to bring', () => {
    expect(firstLaunchRequest({ ...NO_CHOICES, source: 'chrome', profile: 'Default', categories: ['bookmarks'] })).toEqual({ source: 'chrome', profile: 'Default', categories: ['bookmarks'] })
    expect(firstLaunchRequest({ ...NO_CHOICES, source: 'arc', categories: ['sidebar', 'history'] })).toEqual({ source: 'arc', categories: ['sidebar', 'history'] })
  })

  it('is read, then carried out with the key of its preview', async () => {
    const api = { firstLaunchPreview: vi.fn(async () => PREVIEW), firstLaunchConfirm: vi.fn(async () => DONE) }
    expect(await runFirstLaunchImport(api, { source: 'chrome', categories: ['bookmarks'] })).toBe(DONE)
    expect(api.firstLaunchConfirm).toHaveBeenCalledWith(PREVIEW.token)
  })

  it('is not carried out when its preview has nothing to import or is refused: the answer is the preview', async () => {
    const refused: ImportReport = { ok: false, message: 'Accès refusé.', bookmarks: 0, folders: 0, history: 0, skipped: 0, needsDiskAccess: true }
    const api = { firstLaunchPreview: vi.fn(async () => refused), firstLaunchConfirm: vi.fn(async () => DONE) }
    expect(await runFirstLaunchImport(api, { source: 'safari', categories: ['bookmarks'] })).toBe(refused)
    expect(api.firstLaunchConfirm).not.toHaveBeenCalled()
  })
})

describe('the sheet', () => {
  const elementsOf = (node: ReactNode): ReactElement<Record<string, unknown>>[] => {
    if (Array.isArray(node)) return node.flatMap(elementsOf)
    if (!isValidElement(node)) return []
    const element = node as ReactElement<Record<string, unknown>>
    return [element, ...elementsOf(element.props['children'] as ReactNode)]
  }
  const draw = () => {
    hooks.cursor = 0
    return elementsOf(FirstLaunchSheet())
  }
  const settle = () => new Promise<void>((done) => setImmediate(done))
  const textOf = (element: ReactElement<Record<string, unknown>>): string => renderToStaticMarkup(element).replace(/<[^>]+>/g, '')
  const button = (label: string) => {
    const found = draw().find((element) => element.type === 'button' && textOf(element) === label)
    expect(found, label).toBeDefined()
    return found!.props['onClick'] as () => unknown
  }
  /** The box of the complete configuration, on the last step. */
  const quickSetupBox = () => {
    const label = draw().find((element) => element.type === 'label' && textOf(element) === t('first-launch.ensuite-configuration-rapide'))
    expect(label).toBeDefined()
    return elementsOf(label!.props['children'] as ReactNode).find((element) => element.type === 'input')!
  }
  const radioOf = (name: string) => {
    const label = draw().find((element) => element.type === 'label' && textOf(element).startsWith(name))
    expect(label, name).toBeDefined()
    const radio = elementsOf(label!.props['children'] as ReactNode).find((element) => element.type === 'input')!
    return radio.props['onChange'] as () => void
  }

  beforeEach(() => {
    setLanguage('fr')
    hooks.active = true
    hooks.slots = []
    world.state = state()
    calls.dispatched.length = 0
    calls.previews.length = 0
    calls.confirms.length = 0
    calls.closed = 0
    calls.opened.length = 0
    calls.preview = PREVIEW
  })
  afterEach(() => {
    hooks.active = false
    setLanguage('fr')
  })

  it('lists the browsers found, not the sources that are only a file to choose, and offers to bring nothing', async () => {
    draw()
    await settle()
    const markup = renderToStaticMarkup(createElement('div', null, ...draw()))
    expect(markup).toContain('Google Chrome')
    expect(markup).not.toContain('Fichier de signets (HTML)')
    expect(markup).toContain(t('first-launch.commencer-vide'))
  })

  // « Suivant » replaced what the sheet showed without a word: the focus stayed on the button, and a screen reader said nothing of the new step.
  it('puts the focus on the title of a step reached with « Suivant » or « Retour », and leaves it alone when the sheet opens', async () => {
    draw()
    await settle()
    const heading = () => draw().find((element) => element.type === 'h4')!
    const focused = (element: ReactElement<Record<string, unknown>>): number => {
      const node = { focus: vi.fn() }
      ;(element.props['ref'] as ((node: unknown) => void) | undefined)?.(node)
      return node.focus.mock.calls.length
    }
    expect(textOf(heading())).toBe(t('first-launch.etape-1-titre'))
    expect(heading().props['tabIndex']).toBe(-1)
    expect(focused(heading())).toBe(0)
    button(t('first-launch.suivant'))()
    expect(textOf(heading())).toBe(t('first-launch.etape-2-titre'))
    expect(focused(heading())).toBe(1)
    button(t('import-sheet.retour'))()
    expect(textOf(heading())).toBe(t('first-launch.etape-1-titre'))
    expect(focused(heading())).toBe(1)
    // The element that goes away hands null: nothing to focus, and no error.
    expect(() => (heading().props['ref'] as (node: unknown) => void)(null)).not.toThrow()
  })

  // Guard: the last button records the choices and runs the import chosen. Without it (the sheet before), it only closed: nothing was imported.
  it('imports the browser chosen with the import service, and records the appearance chosen', async () => {
    draw()
    await settle()
    radioOf('Google Chrome')()
    button(t('first-launch.suivant'))()
    const select = draw().find((element) => element.type === 'select')!
    ;(select.props['onChange'] as (event: unknown) => void)({ target: { value: 'dark' } })
    button(t('first-launch.suivant'))()
    await button(t('first-launch.importer-et-commencer'))()
    await settle()
    expect(calls.dispatched).toContainEqual({ type: 'settings/update', patch: { interfaceAppearance: 'dark' } })
    expect(calls.previews).toEqual([{ source: 'chrome', profile: 'Default', categories: ['bookmarks', 'history'] }])
    expect(calls.confirms).toEqual([PREVIEW.token])
    // The answer of the import is shown, and the sheet stays open until « Terminé ».
    expect(renderToStaticMarkup(createElement('div', null, ...draw()))).toContain(DONE.message)
    expect(calls.closed).toBe(0)
  })

  it('without a browser chosen, records the choices and closes, importing nothing', async () => {
    draw()
    await settle()
    button(t('first-launch.suivant'))()
    button(t('first-launch.suivant'))()
    const blocker = draw().find((element) => element.type === 'input' && element.props['type'] === 'checkbox')!
    ;(blocker.props['onChange'] as (event: unknown) => void)({ target: { checked: false } })
    await button(t('first-launch.c-est-pret'))()
    expect(calls.dispatched).toEqual([{ type: 'settings/update', patch: { blockAds: false, blockTrackers: false } }])
    expect(calls.previews).toEqual([])
    expect(calls.closed).toBe(1)
  })

  it('« Plus tard » records nothing', async () => {
    draw()
    await settle()
    radioOf('Google Chrome')()
    button(t('first-launch.plus-tard'))()
    expect(calls.dispatched).toEqual([])
    expect(calls.previews).toEqual([])
    expect(calls.closed).toBe(1)
  })

  it('names its colours, in the language of the interface (VoiceOver read the identifiers)', async () => {
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      hooks.slots = []
      draw()
      await settle()
      button(t('first-launch.suivant'))()
      const chips = draw().filter((element) => element.type === 'button' && String(element.props['className']).includes('color-chip'))
      expect(chips.map((chip) => chip.props['aria-label'])).toEqual([t('first-launch.couleur-actuelle'), t('first-launch.couleur-rouge'), t('first-launch.couleur-bleu-vert'), t('first-launch.couleur-violet'), t('first-launch.couleur-jaune')])
      for (const chip of chips) expect(chip.props['type'], language).toBe('button')
    }
  })

  // The complete configuration of the Settings is offered, never forced: its box starts unticked, and only the end of the guide opens it.
  it('opens the complete configuration once the guide is done, only when its box is ticked', async () => {
    expect(firstLaunchFollowUp(NO_CHOICES)).toBeNull()
    expect(firstLaunchFollowUp({ ...NO_CHOICES, quickSetup: true })).toEqual(GUIDED_SETUP_REQUEST)
    draw()
    await settle()
    button(t('first-launch.suivant'))()
    button(t('first-launch.suivant'))()
    expect(quickSetupBox().props['checked']).toBe(false)
    await button(t('first-launch.c-est-pret'))()
    expect(calls.closed).toBe(1)
    expect(calls.opened).toEqual([])
    // Ticked, then « C'est prêt »: the sheet closes and the Settings open on the questions.
    hooks.slots = []
    draw()
    await settle()
    button(t('first-launch.suivant'))()
    button(t('first-launch.suivant'))()
    ;(quickSetupBox().props['onChange'] as (event: unknown) => void)({ target: { checked: true } })
    await button(t('first-launch.c-est-pret'))()
    expect(calls.closed).toBe(2)
    expect(calls.opened).toEqual([GUIDED_SETUP_REQUEST])
  })

  it('« Plus tard » opens nothing, the box ticked or not', async () => {
    draw()
    await settle()
    button(t('first-launch.suivant'))()
    button(t('first-launch.suivant'))()
    ;(quickSetupBox().props['onChange'] as (event: unknown) => void)({ target: { checked: true } })
    button(t('first-launch.plus-tard'))()
    expect(calls.opened).toEqual([])
    expect(calls.dispatched).toEqual([])
  })

  it('shows no French in English', async () => {
    setLanguage('en')
    draw()
    await settle()
    const markup = renderToStaticMarkup(createElement('div', null, ...draw()))
    expect(markup).toContain('Bring nothing over')
    expect(markup).not.toMatch(/Suivant|Retour|Couleur|profil|espace/)
  })
})
