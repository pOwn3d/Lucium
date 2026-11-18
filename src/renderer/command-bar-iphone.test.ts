// @vitest-environment happy-dom
// The command bar mounted with a list of the tabs an iPhone announced: it asks the main process for the list once, shows the lines that answer what is typed under « Sur l'iPhone »,
// and a click or Enter names the line to the main process (it never sends an address). Nothing is asked in a private window; a list that cannot be read leaves the bar as it was.

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t, tp } from '@shared/i18n'
import type { LuciumApi, UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import type { SyncResumeReply, SyncResumeRequest } from '@shared/sync-resume'
import { CommandBar } from './CommandBar'
import { mount, settle, type, type Mounted } from './dom.test-support'

const VIEW: SyncResumeReply = {
  ok: true,
  view: { availability: 'list', announcedAt: Date.now() - 120_000, lines: [{ id: 'phone:t1', title: 'Quiche lorraine', host: 'cuisine.example', lastActiveAt: 5 }] }
}

let mounted: Mounted | null = null
let syncResume: ReturnType<typeof vi.fn<(request: SyncResumeRequest) => Promise<SyncResumeReply>>>
let warn: ReturnType<typeof vi.spyOn>

function snapshot(isPrivate = false): UiSnapshot {
  return { state: createInitialState({ now: 1, newId: () => 'id' }), runtime: { tabs: {} }, extensions: [], downloads: [], windows: [], platform: 'darwin', ...(isPrivate ? { private: true } : {}) } as unknown as UiSnapshot
}

async function bar(shown: UiSnapshot = snapshot()): Promise<HTMLElement> {
  const own: Partial<LuciumApi> = { getSnapshot: async () => shown, searchHistory: (async () => []) as never, suggest: async () => [], syncResume }
  ;(window as unknown as { lucium: unknown }).lucium = new Proxy(own, { get: (target, name: string) => (target as Record<string, unknown>)[name] ?? (name.startsWith('on') ? () => () => undefined : () => Promise.resolve(undefined)) })
  mounted = mount(createElement(CommandBar, { mode: 'current', initial: '' }))
  await settle()
  return mounted.container
}

const field = (container: Element): HTMLInputElement => container.querySelector<HTMLInputElement>('input[role="combobox"]')!
const labels = (container: Element): string[] => [...container.querySelectorAll('li[role="option"] .label')].map((e) => e.textContent ?? '')

beforeEach(() => {
  setLanguage('fr')
  syncResume = vi.fn(async () => VIEW)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.restoreAllMocks()
})

describe('« Sur l\'iPhone » in the mounted command bar', () => {
  it('asks for the list once, and shows the line that answers what is typed under its own title', async () => {
    const container = await bar()
    expect(syncResume).toHaveBeenCalledTimes(1)
    expect(syncResume).toHaveBeenCalledWith({ kind: 'list' })
    type(field(container), 'quiche')
    await settle()
    expect(labels(container)).toContain('Quiche lorraine')
    expect(container.textContent).toContain(t('cmd.groupe-sur-iphone'))
    expect(container.textContent).toContain(tp('cmd.iphone-detail-minutes', 2, { host: 'cuisine.example' }))
  })

  it('names the line to the main process when it is chosen, and sends no address', async () => {
    const container = await bar()
    type(field(container), 'quiche')
    await settle()
    const line = [...container.querySelectorAll<HTMLElement>('li[role="option"]')].find((li) => li.textContent?.includes('Quiche lorraine'))
    expect(line).toBeDefined()
    await act(async () => void line!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })))
    expect(syncResume).toHaveBeenLastCalledWith({ kind: 'open', id: 'phone:t1' })
  })

  it('shows no line when the main process gives no list (no iPhone, category off)', async () => {
    syncResume.mockResolvedValue({ ok: true, view: { availability: 'disabled-here', lines: [], announcedAt: null } })
    const container = await bar()
    type(field(container), 'quiche')
    await settle()
    expect(labels(container)).not.toContain('Quiche lorraine')
    expect(container.textContent).not.toContain(t('cmd.groupe-sur-iphone'))
  })

  it('asks for nothing in a private window', async () => {
    const container = await bar(snapshot(true))
    type(field(container), 'quiche')
    await settle()
    expect(syncResume).not.toHaveBeenCalled()
    expect(labels(container)).not.toContain('Quiche lorraine')
  })

  it('keeps the bar as it was when the list cannot be read, and says so in the log (the name of the error only)', async () => {
    syncResume.mockRejectedValue(new TypeError('secret title in the message'))
    const container = await bar()
    type(field(container), 'quiche')
    await settle()
    expect(labels(container)).not.toContain('Quiche lorraine')
    expect(warn).toHaveBeenCalledWith('[command bar] the tabs of the iPhone could not be asked for:', 'TypeError')
  })
})
