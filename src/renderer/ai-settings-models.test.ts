// The model row of the local summary: the list is the Ollama server's, read only on a click; until it is read,
// or when the server does not answer, the name is typed. Rendered to markup with the real component (no window); what a render cannot show (a click, an
// effect, which runs after the markup is made) is seen by calling the component as a function, with a state that outlives its draws.

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { DEFAULT_OLLAMA_CONFIG, type OllamaConfig } from '@shared/ollama'

// While `active`, each state of the pane outlives the draw (what a handler stores is read by the next draw), and an effect runs at once, during the draw:
// a render to markup never runs one, so an effect that asked the server would go unseen. Otherwise React's own hooks answer.
const hooks = vi.hoisted(() => ({ active: false, slots: [] as unknown[], cursor: 0 }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const useState = <T>(initial: T): [T, (next: T | ((current: T) => T)) => void] => {
    if (!hooks.active) return actual.useState(initial) as [T, (next: T | ((current: T) => T)) => void]
    const at = hooks.cursor++
    if (!(at in hooks.slots)) hooks.slots[at] = initial
    return [hooks.slots[at] as T, (next) => void (hooks.slots[at] = typeof next === 'function' ? (next as (current: T) => T)(hooks.slots[at] as T) : next)]
  }
  const runAtOnce =
    (real: typeof actual.useEffect) =>
    (...args: Parameters<typeof actual.useEffect>): void => {
      if (!hooks.active) return real(...args)
      args[0]()
    }
  return { ...actual, useState, useEffect: runAtOnce(actual.useEffect), useLayoutEffect: runAtOnce(actual.useLayoutEffect), useInsertionEffect: runAtOnce(actual.useInsertionEffect) }
})

const calls = vi.hoisted(() => ({ ollamaModels: [] as string[], ollamaTest: [] as string[], testWorks: true, testRejects: false }))
vi.mock('./api', () => ({
  api: () => ({
    ollamaModels: (url: string) => {
      calls.ollamaModels.push(url)
      return Promise.resolve({ ok: true, models: [] })
    },
    ollamaTest: (url: string) => {
      calls.ollamaTest.push(url)
      if (calls.testRejects) return Promise.reject(new Error('fenêtre fermée'))
      return Promise.resolve(calls.testWorks ? { ok: true, models: [] } : { ok: false, error: 'connexion refusée' })
    }
  })
}))

import { AISettings } from './AISettings'
import { frenchSpaces } from '@shared/french-typography'

afterEach(() => {
  setLanguage('fr')
  calls.ollamaModels.length = 0
  calls.ollamaTest.length = 0
  calls.testWorks = true
  calls.testRejects = false
})

const view = (model: string) =>
  renderToStaticMarkup(createElement(AISettings, { settings: { ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true, model }, aiSummary: true }, update: () => undefined }))

describe('the model row of Ollama', () => {
  it('lets the name be typed until the list is read, and offers to read it', () => {
    const markup = view('llama3.2:3b')
    expect(markup).toMatch(/<input[^>]*type="text"[^>]*value="llama3\.2:3b"/)
    expect(markup).toContain('placeholder="par exemple llama3.2:3b"')
    expect(markup).toContain('Lire les modèles installés')
    // The old fixed list is gone: no model is offered that the server did not give.
    expect(markup).not.toMatch(/<select[^>]*aria-label="Modèle"/)
    expect(markup).not.toContain('orca2')
  })

  it('writes no title of its own: the group it is drawn in (Réglages › Outils web) already carries it', () => {
    expect(view('mistral')).not.toMatch(/<h3/)
  })

  it('asks nothing of the server while the pane is drawn (the search of the Settings draws every pane)', () => {
    view('mistral')
    expect(calls.ollamaModels).toEqual([])
    expect(calls.ollamaTest).toEqual([])
  })

  it('is translated', () => {
    setLanguage('en')
    const markup = view('mistral')
    expect(markup).toContain('Read the installed models')
    expect(markup).toContain('placeholder="for example llama3.2:3b"')
  })
})

describe('the request for the list', () => {
  /** Every element of a tree, depth first. */
  const elementsOf = (node: ReactNode): ReactElement<Record<string, unknown>>[] => {
    if (Array.isArray(node)) return node.flatMap(elementsOf)
    if (!isValidElement(node)) return []
    const element = node as ReactElement<Record<string, unknown>>
    return [element, ...elementsOf(element.props['children'] as ReactNode)]
  }
  const URL = 'http://localhost:11434'
  const update = vi.fn()
  /** One draw of the pane, called as a function, with the state the previous draws and the handlers left. */
  const draw = (patch: Partial<OllamaConfig> = {}) => {
    hooks.cursor = 0
    return elementsOf(AISettings({ settings: { ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: URL, ...patch }, aiSummary: true }, update }))
  }
  const handler = (elements: ReactElement<Record<string, unknown>>[], find: (props: Record<string, unknown>) => boolean, name: string) => {
    const found = elements.find((element) => find(element.props))
    expect(found, name).toBeDefined()
    return found!.props[name] as (...args: unknown[]) => unknown
  }
  const enableSwitch = (elements: ReactElement<Record<string, unknown>>[]) => handler(elements, (props) => props['label'] === t('ollama-settings.enable-label'), 'onChange')
  const readButton = (elements: ReactElement<Record<string, unknown>>[]) => handler(elements, (props) => props['className'] === 'link-button', 'onClick')
  const testButton = (elements: ReactElement<Record<string, unknown>>[]) => handler(elements, (props) => props['children'] === t('ollama-settings.test-button'), 'onClick')
  /** Lets the requests under way settle. */
  const settle = () => new Promise<void>((done) => setImmediate(done))

  beforeEach(() => {
    hooks.active = true
    hooks.slots = []
    update.mockClear()
  })
  afterEach(() => void (hooks.active = false))

  it('is made by no effect: drawing the pane, again and again, asks nothing of the server', async () => {
    draw()
    draw({ enabled: false })
    draw()
    await settle()
    expect(calls.ollamaModels).toEqual([])
  })

  it('is asked when Ollama is turned on, and not when it is turned off', async () => {
    enableSwitch(draw({ enabled: false }))(false)
    await settle()
    expect(calls.ollamaModels).toEqual([])
    enableSwitch(draw({ enabled: false }))(true)
    await settle()
    expect(calls.ollamaModels).toEqual([URL])
    expect(update).toHaveBeenCalledWith({ ollamaConfig: expect.objectContaining({ enabled: true }) })
  })

  it('is asked by the button of the row', async () => {
    readButton(draw())()
    await settle()
    expect(calls.ollamaModels).toEqual([URL])
  })

  it('is asked after a connection test that succeeds, and not after one that fails', async () => {
    calls.testWorks = false
    await testButton(draw())()
    expect(calls.ollamaTest).toEqual([URL])
    expect(calls.ollamaModels).toEqual([])
    calls.testWorks = true
    await testButton(draw())()
    await settle()
    expect(calls.ollamaModels).toEqual([URL])
  })

  it('is not asked when the address or the name of the model is typed', async () => {
    const fields = draw().filter((element) => element.type === 'input' && element.props['type'] === 'text')
    expect(fields).toHaveLength(2)
    for (const field of fields) (field.props['onChange'] as (event: unknown) => void)({ target: { value: 'llama3' } })
    await settle()
    expect(update).toHaveBeenCalledTimes(2)
    expect(calls.ollamaModels).toEqual([])
  })

  it('says, in the language of the interface, why a connection test failed', async () => {
    calls.testWorks = false
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      hooks.slots = []
      await testButton(draw())()
      const status = draw().find((element) => element.props['role'] === 'status' && element.type === 'p')
      expect(status?.props['children'], language).toBe(t('ollama-settings.test-echec', { error: 'connexion refusée' }))
    }
  })
})

describe('a connection test whose request does not come back', () => {
  beforeEach(() => {
    hooks.active = true
    hooks.slots = []
    calls.testRejects = true
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    hooks.active = false
    vi.restoreAllMocks()
  })
  const draw = () => {
    hooks.cursor = 0
    const all = (node: ReactNode): ReactElement<Record<string, unknown>>[] => {
      if (Array.isArray(node)) return node.flatMap(all)
      if (!isValidElement(node)) return []
      const element = node as ReactElement<Record<string, unknown>>
      return [element, ...all(element.props['children'] as ReactNode)]
    }
    return all(AISettings({ settings: { ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true }, aiSummary: true }, update: () => undefined }))
  }
  const button = (elements: ReactElement<Record<string, unknown>>[]) => elements.find((element) => element.type === 'button' && element.props['className'] !== 'link-button')!

  it('gives the button back, says the failure on the row and writes it in the log', async () => {
    const before = button(draw())
    expect(before.props['children']).toBe(t('ollama-settings.test-button'))
    await (before.props['onClick'] as () => Promise<void>)()
    const after = draw()
    expect(button(after).props['disabled']).toBe(false)
    expect(button(after).props['children']).toBe(t('ollama-settings.test-button'))
    const status = after.find((element) => element.props['role'] === 'status' && element.type === 'p')
    expect(status?.props['children']).toBe(t('ollama-settings.test-echec', { error: 'fenêtre fermée' }))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('connection test'), expect.any(Error))
  })
})

describe('what the connection test says', () => {
  afterEach(() => setLanguage('fr'))

  it('is in the language of the interface, with the first five models and how many more', async () => {
    const { connectedText } = await import('./AISettings')
    setLanguage('fr')
    expect(connectedText(['a', 'b'])).toBe(frenchSpaces('Connecté. Modèles : a, b'))
    expect(connectedText(['a', 'b', 'c', 'd', 'e', 'f'])).toBe(frenchSpaces('Connecté. Modèles : a, b, c, d, e (et 1 autre)'))
    expect(connectedText([])).toBe('Connecté. Ce serveur n’a aucun modèle installé.')
    setLanguage('en')
    expect(connectedText(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('Connected. Models: a, b, c, d, e (and 2 more)')
  })
})
