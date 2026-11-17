// @vitest-environment happy-dom
// « Fonctions en option » › Scripts utilisateur, mounted in a document: removing a script takes two clicks on its link. Nothing keeps a copy of a script,
// and one that was pasted exists nowhere else: a single click, next to « Voir le code », must remove nothing.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import { defaultSettings } from '@shared/model'
import type { UserScriptReply, UserScriptRequest, UserScriptView } from '@shared/userscript'
import { t } from '@shared/i18n'
import { UserScriptsSettings } from './UserScriptsSettings'
import { click, mount, settle, type Mounted } from './dom.test-support'

const script = (id: string, name: string): UserScriptView => ({ id, name, matches: ['https://example.org/*'], excludes: [], runAt: 'document-end', enabled: true, allowPrivate: false, importedAt: 1, bytes: 10, warnings: [] }) as unknown as UserScriptView

let scripts: UserScriptView[] = []
let userScripts: ReturnType<typeof vi.fn<(request: UserScriptRequest) => Promise<UserScriptReply>>>
let mounted: Mounted | null = null

async function panel(): Promise<HTMLElement> {
  const snapshot = { state: { settings: { ...defaultSettings(), userScripts: true } } } as unknown as UiSnapshot
  mounted = mount(createElement(UserScriptsSettings, { snapshot }))
  // The list arrives after the first draw.
  await settle()
  return mounted.container
}

const removeLinks = (container: Element): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>('button[data-action="remove"]')]
const removals = (): UserScriptRequest[] => userScripts.mock.calls.map(([request]) => request).filter((request) => request.kind === 'remove')

beforeEach(() => {
  scripts = [script('a', 'Premier'), script('b', 'Second')]
  userScripts = vi.fn(async (request: UserScriptRequest) => {
    if (request.kind === 'remove') scripts = scripts.filter((one) => one.id !== request.id)
    return { ok: true, scripts }
  })
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = { userScripts }
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('removing a user script', () => {
  it('removes nothing at the first click: the link asks to confirm and says the code cannot be recovered', async () => {
    const container = await panel()
    const [first, second] = removeLinks(container)
    expect(first!.textContent).toBe(t('settings.retirer'))
    await click(first!)
    expect(removals()).toEqual([])
    expect(removeLinks(container)[0]!.textContent).toBe(t('user-scripts-settings.confirmer-le-retrait'))
    // Only the script that was clicked awaits its confirmation.
    expect(second!.textContent).toBe(t('settings.retirer'))
    const said = container.querySelectorAll('[data-role="remove-confirm"]')
    expect(said).toHaveLength(1)
    expect(said[0]!.getAttribute('role')).toBe('status')
    expect(said[0]!.textContent).toBe(t('user-scripts-settings.le-code-sera-efface'))
  })

  it('removes the script at the second click on the same link, and that script only', async () => {
    const container = await panel()
    await click(removeLinks(container)[0]!)
    await click(removeLinks(container)[0]!)
    expect(removals()).toEqual([{ kind: 'remove', id: 'a' }])
    expect(removeLinks(container)).toHaveLength(1)
    expect(container.querySelector('[data-role="remove-confirm"]')).toBeNull()
  })

  it('gives the confirmation up when the focus leaves the link, and when another script is clicked', async () => {
    const container = await panel()
    await click(removeLinks(container)[0]!)
    // React listens for `focusout` to call `onBlur`.
    act(() => void removeLinks(container)[0]!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(removeLinks(container)[0]!.textContent).toBe(t('settings.retirer'))
    await click(removeLinks(container)[0]!)
    await click(removeLinks(container)[1]!)
    expect(removals()).toEqual([])
    expect(removeLinks(container).map((link) => link.textContent)).toEqual([t('settings.retirer'), t('user-scripts-settings.confirmer-le-retrait')])
  })
})
