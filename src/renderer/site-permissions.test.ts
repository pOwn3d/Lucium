// The permissions of the site on show: what the rows say, and what a choice or "Oublier" asks of the state. The component is called as a function, and the
// elements it returns are read (no window): the handlers are the ones the panel hands to the real select and button.

import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { ALL_SITES, sitePermissionRows } from '@shared/permissions'
import { SitePermissionRows } from './SitePermissions'
import { frenchSpaces } from '@shared/french-typography'

const site = 'https://meet.example'
const answers = { [ALL_SITES]: { notifications: 'allow' as const }, [site]: { geolocation: 'deny' as const, media: 'allow' as const } }
const rows = () => sitePermissionRows(answers, site, true)

/** Every element of a tree, depth first. */
function elementsOf(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elementsOf)
  if (!isValidElement(node)) return []
  const element = node as ReactElement<Record<string, unknown>>
  return [element, ...elementsOf(element.props['children'] as ReactNode)]
}

beforeEach(() => setLanguage('fr'))
afterEach(() => setLanguage('fr'))

describe('the permissions of a site in the site panel', () => {
  const markup = () => renderToStaticMarkup(createElement(SitePermissionRows, { rows: rows(), onDecide: () => undefined }))

  it('names each permission, says what it was answered, and offers Demander, Autoriser and Bloquer on the answer it has', () => {
    const html = markup()
    expect(html.match(/<select/g)).toHaveLength(3)
    expect(html).toContain('Caméra et micro')
    expect(html).toContain('Autorisé')
    expect(html).toContain('Refusé')
    expect(html.match(/<option value="ask"[^>]*>Demander<\/option>/g)).toHaveLength(2)
    expect(html).toMatch(/<select[^>]*aria-label="Réponse pour ce site\u00a0: Caméra et micro"[^>]*><option value="ask">Demander<\/option><option value="allow" selected="">Autoriser<\/option><option value="deny">Bloquer<\/option>/)
  })

  it('names the answer for every site as what stands for the notifications, with no "Oublier" for an answer the site does not hold', () => {
    const html = markup()
    expect(html).toContain(frenchSpaces('Comme partout : Autorisé'))
    expect(html).toContain('<option value="ask" selected="">Comme partout</option>')
    // The camera and the position hold an answer of their own and can be forgotten; the notifications do not.
    expect(html.match(/scc-perm-forget/g)).toHaveLength(2)
    expect(html).toContain(frenchSpaces('aria-label="Oublier l’autorisation « Caméra et micro »"'))
    expect(html).not.toContain('Oublier l’autorisation « notifications »')
  })

  it('says it in English when the language is English, and asks to be asked when nothing was answered', () => {
    setLanguage('en')
    const html = renderToStaticMarkup(createElement(SitePermissionRows, { rows: sitePermissionRows({}, site, true), onDecide: () => undefined }))
    expect(html).toContain('Camera and microphone')
    expect(html).toContain('>Ask<')
    expect(html).toContain('>Allow<')
    expect(html).toContain('>Block<')
    expect(html).not.toContain('Demander')
  })

  it('asks for the answer that was chosen, and for none when the person forgets or goes back to asking', () => {
    const onDecide = vi.fn()
    const tree = elementsOf(SitePermissionRows({ rows: rows(), onDecide }))
    const position = tree.find((e) => e.type === 'select' && e.props['aria-label'] === frenchSpaces('Réponse pour ce site : Position'))!
    ;(position.props['onChange'] as (e: { target: { value: string } }) => void)({ target: { value: 'allow' } })
    expect(onDecide).toHaveBeenLastCalledWith('geolocation', 'allow')
    ;(position.props['onChange'] as (e: { target: { value: string } }) => void)({ target: { value: 'ask' } })
    expect(onDecide).toHaveBeenLastCalledWith('geolocation', null)
    const forget = tree.find((e) => e.props['className'] === 'scc-perm-forget' && e.props['aria-label'] === frenchSpaces('Oublier l’autorisation « Position »'))!
    ;(forget.props['onClick'] as () => void)()
    expect(onDecide).toHaveBeenLastCalledWith('geolocation', null)
    // "Bloquer" is a refusal kept, not a forgetting.
    ;(position.props['onChange'] as (e: { target: { value: string } }) => void)({ target: { value: 'deny' } })
    expect(onDecide).toHaveBeenLastCalledWith('geolocation', 'deny')
  })
})
