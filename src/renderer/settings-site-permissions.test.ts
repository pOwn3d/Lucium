// The answers kept for the sites, in the settings (the category Protection, drawn with the real components, no window): the list of the sites, and the menu of
// the answer for every site (shared/permissions.ts `sitesWithAnswers`, `decisionOfChoice`).
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { ALL_SITES, decisionOfChoice, permissionName } from '@shared/permissions'
import { createInitialState } from '@shared/sidebar'

describe('the answers kept for the sites, in the settings', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** Every element a tree draws, the function components called and what they return walked too. */
  function expanded(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(expanded)
    if (!isValidElement(node)) return []
    const element = node as ReactElement<Record<string, unknown>>
    const type = element.type as unknown
    // A memo component is its function under `type`.
    const component = typeof type === 'object' && type !== null && (type as { $$typeof?: symbol }).$$typeof === Symbol.for('react.memo') ? (type as { type: unknown }).type : type
    if (typeof component === 'function' && !(component as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
      return [element, ...expanded((component as (props: unknown) => ReactNode)(element.props))]
    }
    return [element, ...expanded(element.props['children'] as ReactNode)]
  }

  /** The category with these answers kept: its markup, its elements (with their handlers), and what it dispatched. */
  async function protection(sitePermissions: Record<string, Record<string, 'allow' | 'deny'>>) {
    const dispatched: unknown[] = []
    vi.stubGlobal('window', { lucium: { dispatch: (action: unknown) => (dispatched.push(action), Promise.resolve()) }, matchMedia: () => ({ matches: false }) })
    setLanguage('fr')
    const { CategoryContent } = await import('./SettingsCategories')
    const { FoldPassContext } = await import('./settings-context')
    const initial = createInitialState({ now: 1, newId: () => 'id' })
    const snapshot = { state: { ...initial, sitePermissions }, extensions: [], downloads: [] } as unknown as UiSnapshot
    const node = createElement(CategoryContent, { pane: 'protection', snapshot, update: () => undefined, goTo: () => undefined })
    let elements: ReactElement<Record<string, unknown>>[] = []
    const Probe = (): null => {
      elements = expanded(node)
      return null
    }
    const wrap = (child: ReactElement) => createElement(FoldPassContext.Provider, { value: 'all' as const }, child)
    renderToStaticMarkup(wrap(createElement(Probe)))
    return { markup: renderToStaticMarkup(wrap(node)), elements, dispatched }
  }

  it('lists the sites that have an answer of their own, and not the answer for every site', async () => {
    const { markup } = await protection({ [ALL_SITES]: { notifications: 'deny' }, 'https://a.example': { geolocation: 'allow' } })
    expect(markup).toContain(t('settings.permission-entry', { origin: 'a.example', permission: permissionName('geolocation'), decision: t('settings.autorise') }))
    expect(markup).not.toContain(t('settings.permission-entry', { origin: ALL_SITES.replace(/^https?:\/\//, ''), permission: permissionName('notifications'), decision: t('settings.refuse') }))
  })

  it('has its own menu for the notifications of every site, which writes the answer for every site, and "Demander" forgets it', async () => {
    const { elements, dispatched } = await protection({ [ALL_SITES]: { notifications: 'deny' } })
    const menu = elements.find((element) => element.type === 'select' && element.props['aria-label'] === t('settings.notifications-des-sites'))
    expect(menu?.props['value']).toBe('deny')
    for (const value of ['allow', 'deny', 'ask']) (menu!.props['onChange'] as (e: { target: { value: string } }) => void)({ target: { value } })
    expect(dispatched).toEqual(['allow', 'deny', 'ask'].map((value) => ({ type: 'permission/set', origin: ALL_SITES, permission: 'notifications', decision: decisionOfChoice(value) })))
    expect(dispatched.map((action) => (action as { decision: unknown }).decision)).toEqual(['allow', 'deny', null])
  })
})
