// The section of the page summary says what happens to a page with the settings as they are, names its fields, says that the page leaves the
// Mac as soon as the address is the one of another computer, refuses a public host, and offers no online provider. The real component, rendered to markup or called as a function.

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import { DEFAULT_OLLAMA_CONFIG, type OllamaConfig } from '@shared/ollama'

vi.mock('./api', () => ({ api: () => ({}) }))
// The pane is also called as a function (outside a render): its states answer their first value.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useState: <T>(initial: T): [T, () => void] => [initial, () => undefined] }
})

import { AISettings, addressNote, summaryDataText } from './AISettings'

afterEach(() => setLanguage('fr'))

type Props = Parameters<typeof AISettings>[0]['settings']
const props = (patch: Partial<Props> & { ollama?: Partial<OllamaConfig> } = {}): Props => {
  const { ollama, ...rest } = patch
  return { aiSummary: true, ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, ...ollama }, ...rest }
}
const markup = (settings: Props) => renderToStaticMarkup(createElement(AISettings, { settings, update: () => undefined }))
/** A public host: refused. */
const REMOTE = 'https://ollama.exemple.fr'
/** A computer of the local network, by its private address: accepted, and said. */
const NETWORK = 'http://10.0.0.5:11434'

describe('the sentence at the head of the section', () => {
  it('says that nothing leaves the Mac with Ollama on this Mac', () => {
    expect(summaryDataText(props({ ollama: { enabled: true } }))).toBe(t('ollama-settings.donnees-local'))
    expect(markup(props({ ollama: { enabled: true } }))).toContain(t('ollama-settings.donnees-local'))
  })

  it('says that no page is read while the summary is off, or Ollama is, or its address is not one of this Mac', () => {
    expect(summaryDataText(props({ aiSummary: false }))).toBe(t('ollama-settings.donnees-off'))
    expect(summaryDataText(props())).toBe(t('ollama-settings.donnees-aucun'))
    expect(summaryDataText(props({ ollama: { enabled: true, url: REMOTE } }))).toBe(t('ollama-settings.donnees-aucun'))
  })

  it('is translated', () => {
    setLanguage('en')
    expect(summaryDataText(props({ ollama: { enabled: true } }))).toContain('nothing leaves the machine')
  })

  // Guard: with another computer in the address, the sentence no longer says that nothing leaves the machine.
  it('names the computer of the local network and says that the page leaves this computer', () => {
    const said = summaryDataText(props({ ollama: { enabled: true, url: NETWORK } }))
    expect(said).toBe(t('ollama-settings.donnees-reseau', { host: '10.0.0.5:11434' }))
    expect(said).toMatch(/10\.0\.0\.5:11434.*quittent cet ordinateur/)
    expect(markup(props({ ollama: { enabled: true, url: NETWORK } }))).not.toContain(t('ollama-settings.donnees-local'))
  })
})

describe('the address of a computer of the local network', () => {
  // Guard: the sentence is there as soon as the address is typed, whether or not anything answers at it.
  it('is said to take the page text out of this computer, in clear over http, in both languages', () => {
    const html = markup(props({ ollama: { enabled: true, url: NETWORK } }))
    expect(html).toContain('le texte de la page et son adresse quittent cet ordinateur, en clair sur le réseau local')
    expect(html).not.toContain(t('ollama-settings.adresse-refusee'))
    setLanguage('en')
    expect(markup(props({ ollama: { enabled: true, url: NETWORK } }))).toContain('the page text and its address leave this computer, unencrypted on the local network')
  })

  it('is not said to be in clear over https, and nothing is said for an address of this Mac', () => {
    expect(addressNote('https://10.0.0.5')).toBe(t('ollama-settings.reseau-chiffre'))
    expect(addressNote(NETWORK)).toBe(t('ollama-settings.reseau-en-clair'))
    expect(addressNote(REMOTE)).toBe(t('ollama-settings.adresse-refusee'))
    for (const url of ['http://localhost:11434', 'http://127.0.0.1:11434', 'http://[::1]:11434']) expect(addressNote(url), url).toBeNull()
  })
})

describe('the fields of Ollama', () => {
  // Guard: the address, the length and the temperature were announced « champ de texte » with no name.
  it('each have a name', () => {
    const html = markup(props({ ollama: { enabled: true } }))
    for (const key of ['ollama-settings.url-label', 'ollama-settings.max-tokens-label', 'ollama-settings.temperature-label', 'ollama-settings.model-label'] as const) {
      expect(html, key).toMatch(new RegExp(`<input[^>]*aria-label="${t(key)}"`))
    }
    expect(html.match(/<input(?![^>]*aria-label=)[^>]*>/g) ?? []).toEqual([])
  })

  // « Essayer automatiquement localhost:11434 » did nothing; it is gone.
  it('have no switch of automatic detection', () => {
    expect(markup(props({ ollama: { enabled: true } }))).not.toMatch(/localhost:11434 si la connexion|Détection automatique/)
  })
})

// The summary is made by a model on this Mac or on the local network, or not at all: the section offers no online provider and no key.
describe('the section', () => {
  it('is called a summary by a local model, in both languages, never an assistant', () => {
    for (const language of ['fr', 'en'] as const) {
      setLanguage(language)
      const html = markup(props({ ollama: { enabled: true } }))
      // The title is the one of the group the section is drawn in (WebToolsSettings.tsx): the section writes none of its own.
      expect(t('ollama-settings.title'), language).toBe(language === 'fr' ? 'Résumé de page par un modèle local' : 'Page summary by a local model')
      expect(html, language).not.toMatch(/assistant/i)
    }
  })

  it('offers no online provider and asks for no key', () => {
    for (const settings of [props(), props({ ollama: { enabled: true } }), props({ ollama: { enabled: true, url: REMOTE } }), props({ ollama: { enabled: true, url: NETWORK } })]) {
      const html = markup(settings)
      // « mistral » alone is the name of a model Ollama runs, not the provider.
      expect(html).not.toMatch(/OpenAI|OpenRouter|Anthropic|Claude|cloud|fournisseur|clé API/i)
      expect(html).not.toMatch(/type="password"|<select/)
    }
  })
})

describe('the address of a public host', () => {
  const elementsOf = (node: ReactNode): ReactElement<Record<string, unknown>>[] => {
    if (Array.isArray(node)) return node.flatMap(elementsOf)
    if (!isValidElement(node)) return []
    const element = node as ReactElement<Record<string, unknown>>
    return [element, ...elementsOf(element.props['children'] as ReactNode)]
  }
  const button = (elements: ReturnType<typeof elementsOf>, key: Parameters<typeof t>[0]) => elements.find((element) => element.type === 'button' && element.props['children'] === t(key))!

  // Guard: the refusal is said next to the address, and nothing offers to send a page there.
  it('is said to be refused, with no way to confirm it', () => {
    const elements = elementsOf(AISettings({ settings: props({ ollama: { enabled: true, url: REMOTE } }), update: () => undefined }))
    const html = renderToStaticMarkup(createElement('div', null, ...elements))
    expect(html).toContain(t('ollama-settings.adresse-refusee'))
    expect(elements.filter((element) => element.type === 'button').map((element) => element.props['children'])).toEqual([t('ollama-settings.models-read'), t('ollama-settings.test-button')])
  })

  it('is not asked anything: the test and the list of the models are disabled', () => {
    const elements = elementsOf(AISettings({ settings: props({ ollama: { enabled: true, url: REMOTE } }), update: () => undefined }))
    expect(button(elements, 'ollama-settings.test-button').props['disabled']).toBe(true)
    expect(button(elements, 'ollama-settings.models-read').props['disabled']).toBe(true)
  })

  it('is not what an address of this Mac gets: no refusal, and both buttons work', () => {
    const elements = elementsOf(AISettings({ settings: props({ ollama: { enabled: true } }), update: () => undefined }))
    expect(renderToStaticMarkup(createElement('div', null, ...elements))).not.toContain(t('ollama-settings.adresse-refusee'))
    expect(button(elements, 'ollama-settings.test-button').props['disabled']).toBe(false)
    expect(button(elements, 'ollama-settings.models-read').props['disabled']).toBe(false)
  })

  it('writes the address typed and nothing else: no confirmation goes with it', () => {
    const update = vi.fn()
    const elements = elementsOf(AISettings({ settings: props({ ollama: { enabled: true } }), update }))
    const address = elements.find((element) => element.type === 'input' && element.props['aria-label'] === t('ollama-settings.url-label'))!
    ;(address.props['onChange'] as (event: unknown) => void)({ target: { value: REMOTE } })
    expect(update).toHaveBeenLastCalledWith({ ollamaConfig: { ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: REMOTE } })
  })
})
