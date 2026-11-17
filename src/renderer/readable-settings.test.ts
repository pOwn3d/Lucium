// The readable mode in the settings (the category Apparence, drawn with the real components, no window): the menu of the default for every site, and the
// list of the sites that have a mode of their own — each one editable and removable, and a site added with the mode of its menu.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import type { Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { frenchSpaces } from '@shared/french-typography'

type El = ReactElement<Record<string, unknown>>

describe('the readable mode in the settings', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** Every element a tree draws, the function components called and what they return walked too. */
  function expanded(node: ReactNode): El[] {
    if (Array.isArray(node)) return node.flatMap(expanded)
    if (!isValidElement(node)) return []
    const element = node as El
    const type = element.type as unknown
    const component = typeof type === 'object' && type !== null && (type as { $$typeof?: symbol }).$$typeof === Symbol.for('react.memo') ? (type as { type: unknown }).type : type
    if (typeof component === 'function' && !(component as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
      return [element, ...expanded((component as (props: unknown) => ReactNode)(element.props))]
    }
    return [element, ...expanded(element.props['children'] as ReactNode)]
  }

  /** The category Apparence with these settings: its elements (with their handlers), what it wrote to the settings, and what it dispatched. */
  async function appearance(settings: Partial<Settings>) {
    const dispatched: unknown[] = []
    const updates: Array<Partial<Settings>> = []
    vi.stubGlobal('window', { lucium: { dispatch: (action: unknown) => (dispatched.push(action), Promise.resolve()) }, matchMedia: () => ({ matches: false }) })
    setLanguage('fr')
    const { CategoryContent } = await import('./SettingsCategories')
    const { FoldPassContext } = await import('./settings-context')
    const initial = createInitialState({ now: 1, newId: () => 'id' })
    const snapshot = { state: { ...initial, settings: { ...initial.settings, ...settings } }, extensions: [], downloads: [] } as unknown as UiSnapshot
    const node = createElement(CategoryContent, { pane: 'appearance', snapshot, update: (patch: Partial<Settings>) => void updates.push(patch), goTo: () => undefined })
    let elements: El[] = []
    const Probe = (): null => {
      elements = expanded(node)
      return null
    }
    const wrap = (child: ReactElement) => createElement(FoldPassContext.Provider, { value: 'all' as const }, child)
    renderToStaticMarkup(wrap(createElement(Probe)))
    return { markup: renderToStaticMarkup(wrap(node)), elements, dispatched, updates }
  }

  const choose = (select: El | undefined, value: string): void => (select!.props['onChange'] as (e: { target: { value: string } }) => void)({ target: { value } })
  const labelled = (elements: El[], type: string, label: string): El | undefined => elements.find((element) => element.type === type && element.props['aria-label'] === label)
  const optionsOf = (select: El | undefined): string[] => (expanded(select!.props['children'] as ReactNode).filter((element) => element.type === 'option').map((option) => String(option.props['value'])))

  it('has a menu for the default of every site — Original, Sombre, Clair, Automatique — at the value it holds, and Original on a new profile', async () => {
    const { elements } = await appearance({})
    const menu = labelled(elements, 'select', 'Contraste de la page pour tous les sites')
    expect(menu?.props['value']).toBe('original')
    expect(optionsOf(menu)).toEqual(['original', 'dark', 'light', 'auto'])
    expect(labelled((await appearance({ readableMode: 'auto' })).elements, 'select', 'Contraste de la page pour tous les sites')?.props['value']).toBe('auto')
  })

  it('writes the default through the settings, and names what each choice does under the menu', async () => {
    const { elements, updates, markup } = await appearance({ readableMode: 'light' })
    const menu = labelled(elements, 'select', 'Contraste de la page pour tous les sites')
    for (const value of ['original', 'dark', 'light', 'auto']) choose(menu, value)
    expect(updates).toEqual(['original', 'dark', 'light', 'auto'].map((readableMode) => ({ readableMode })))
    expect(markup).toContain('Les pages sombres sont éclaircies')
  })

  const buttonSwitch = (elements: El[]): El | undefined => elements.find((element) => element.props['settingKey'] === 'readableToolbarButton')

  it('has a switch for the toolbar button, in Apparence, on by default, named in the language of the interface', async () => {
    const { elements, markup } = await appearance({})
    const row = buttonSwitch(elements)
    expect(row?.props['checked']).toBe(true)
    expect(row?.props['label']).toBe(frenchSpaces('Bouton « Contraste de la page » dans la barre d’outils'))
    // One line under the switch; where the button sits is said behind « En savoir plus ».
    expect(String(row?.props['hint'])).toBe(frenchSpaces('Un clic sur ce bouton passe la page en mode sombre, clair ou original.'))
    expect(String(row?.props['more'])).toContain('à côté de «\u00a0Infos et réglages du site\u00a0»')
    expect(markup).toContain(frenchSpaces('Bouton « Contraste de la page » dans la barre d’outils'))
    expect(buttonSwitch((await appearance({ readableToolbarButton: false })).elements)?.props['checked']).toBe(false)
  })

  it('writes the switch of the toolbar button through the settings, off and on again', async () => {
    const { elements, updates } = await appearance({})
    const change = buttonSwitch(elements)!.props['onChange'] as (value: boolean) => void
    change(false)
    change(true)
    expect(updates).toEqual([{ readableToolbarButton: false }, { readableToolbarButton: true }])
  })

  it('shows the list of sites even while the default is Original, empty with a sentence that says where to set one', async () => {
    const { markup } = await appearance({})
    expect(markup).toContain('Sites avec un contraste de la page à part')
    expect(markup).toContain('Aucun site n’a de mode à part')
  })

  it('lists each site with its mode, and no "forced dark" switch or exception list is left', async () => {
    const { markup } = await appearance({ siteReadableMode: { 'banque.example': 'original', 'nuit.example': 'dark', 'jour.example': 'light' } })
    for (const host of ['banque.example', 'nuit.example', 'jour.example']) expect(markup).toContain(`<code>${host}</code>`)
    expect(markup).not.toContain('Aucun site n’a de mode à part')
    expect(markup).not.toContain('Forcer le mode sombre')
    expect(markup).not.toContain('Sites sans mode sombre forcé')
  })

  it('changes the mode of a site with its menu, by the action of the site', async () => {
    const { elements, dispatched } = await appearance({ siteReadableMode: { 'nuit.example': 'dark' } })
    const menu = labelled(elements, 'select', 'Contraste de la page sur nuit.example')
    expect(menu?.props['value']).toBe('dark')
    expect(optionsOf(menu)).toEqual(['original', 'dark', 'light'])
    for (const value of ['original', 'light', 'dark']) choose(menu, value)
    expect(dispatched).toEqual(['original', 'light', 'dark'].map((mode) => ({ type: 'readable/site', site: 'nuit.example', mode })))
  })

  it('removes a site with "Retirer", which gives it back to the default (mode null)', async () => {
    const { elements, dispatched } = await appearance({ siteReadableMode: { 'nuit.example': 'dark', 'jour.example': 'light' } })
    const remove = elements.find((element) => element.type === 'button' && element.props['aria-label'] === 'Retirer jour.example')
    expect(remove).toBeDefined()
    ;(remove!.props['onClick'] as () => void)()
    expect(dispatched).toEqual([{ type: 'readable/site', site: 'jour.example', mode: null }])
  })

  it('adds a site with the opposite of the default — Sombre where sites are left as they are, Original where they are not — and reads what is typed as a host', async () => {
    const { elements, dispatched } = await appearance({ siteReadableMode: { 'nuit.example': 'dark' } })
    const form = elements.find((element) => typeof element.props['onAdd'] === 'function')
    expect(form?.props['known']).toEqual(['nuit.example'])
    expect(form?.props['label']).toBe('Site à régler')
    ;(form!.props['onAdd'] as (host: string) => void)('exemple.org')
    expect(dispatched).toEqual([{ type: 'readable/site', site: 'exemple.org', mode: 'dark' }])
    for (const [readableMode, mode] of [['dark', 'original'], ['light', 'original'], ['auto', 'original']] as const) {
      const other = await appearance({ readableMode })
      ;(other.elements.find((element) => typeof element.props['onAdd'] === 'function')!.props['onAdd'] as (host: string) => void)('exemple.org')
      expect(other.dispatched, readableMode).toEqual([{ type: 'readable/site', site: 'exemple.org', mode }])
    }
    // What is typed is read as a host: an address works, and what is no host is refused by the form.
    const normalize = form!.props['normalize'] as (site: string) => string | null
    expect(normalize('https://www.Exemple.org/page')).toBe('exemple.org')
    expect(normalize('pas un hôte !')).toBeNull()
    expect(form?.props['max']).toBe(500)
  })
})
