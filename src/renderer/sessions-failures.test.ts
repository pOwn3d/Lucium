// @vitest-environment happy-dom
// The Sessions panel, mounted in a document: what it says when the main process does not answer a request about the automatic copies (the list,
// a restoration that was confirmed, a copy asked for now).

import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import type { BackupListing } from '@shared/session-backups'
import { createInitialState } from '@shared/sidebar'
import { t } from '@shared/i18n'
import { Sessions } from './Sessions'
import { click, mount, settle, type Mounted } from './dom.test-support'

const LISTING: BackupListing = { enabled: true, entries: [{ id: 'copy-1', createdAt: 1_700_000_000_000, reason: 'manual', tabs: 3, spaces: 1 }] as never, unreadable: 0 }

let mounted: Mounted | null = null
let lucium: Partial<LuciumApi>
let errors: ReturnType<typeof vi.spyOn>

function snapshot(): UiSnapshot {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  const sessions = [
    { id: 'plain', name: 'Veille', createdAt: 1, tabs: [{ url: 'https://example.org/', title: 'Exemple' }] },
    { id: 'aside', name: 'Banque', createdAt: 1, tabs: [], space: { tabs: [] } }
  ]
  return { state: { ...state, sessions }, extensions: [], downloads: [] } as unknown as UiSnapshot
}

async function panel(): Promise<HTMLElement> {
  mounted = mount(createElement(Sessions, {}))
  await settle()
  return mounted.container
}
const note = (container: Element): string | null => container.querySelector('[data-role="backup-note"]')?.textContent ?? null
const action = (container: Element, name: string, row = ''): HTMLButtonElement => container.querySelector<HTMLButtonElement>(`${row} button[data-action="${name}"]`)!

beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  lucium = {
    getSnapshot: async () => snapshot(),
    onSnapshot: () => () => undefined,
    dispatch: vi.fn(async () => undefined) as never,
    closeOverlay: vi.fn() as never,
    sessionBackups: async () => LISTING
  }
  ;(window as unknown as { lucium: Partial<LuciumApi> }).lucium = lucium
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('a request about the automatic copies that fails', () => {
  it('says the list could not be read, and logs why', async () => {
    const failure = new Error('no answer')
    lucium.sessionBackups = () => Promise.reject(failure)
    const container = await panel()
    expect(note(container)).toBe(t('sessions.liste-des-copies-illisible'))
    expect(container.querySelector('[data-role="backup-note"]')!.getAttribute('role')).toBe('status')
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('[sessions]'), failure)
  })

  it('says a confirmed restoration failed and leaves the panel open', async () => {
    const failure = new Error('no answer')
    lucium.restoreBackup = () => Promise.reject(failure)
    const container = await panel()
    await click(action(container, 'restore-backup'))
    expect(note(container)).toBeNull()
    await click(action(container, 'restore-backup'))
    expect(note(container)).toBe(t('sessions.restauration-echouee'))
    expect(lucium.closeOverlay).not.toHaveBeenCalled()
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('[sessions]'), failure)
  })

  it('says the copy asked for could not be made', async () => {
    const failure = new Error('no answer')
    lucium.backUpNow = () => Promise.reject(failure)
    const container = await panel()
    await click(action(container, 'back-up-now'))
    expect(note(container)).toBe(t('sessions.copie-echouee'))
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('[sessions]'), failure)
  })

  it('says what the main process answered when it did answer', async () => {
    lucium.backUpNow = async () => ({ ok: true, message: 'Copie faite.' })
    const container = await panel()
    await click(action(container, 'back-up-now'))
    expect(note(container)).toBe('Copie faite.')
    expect(errors).not.toHaveBeenCalled()
  })
})
