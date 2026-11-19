// @vitest-environment happy-dom
// The page « Synchronisation » of the Settings (SyncSettings.tsx) in the window mounted in a document: the row on the page of the files, the subpage, what each control
// asks of the main process, the sheet that adds an iPhone, the question of the pairing, the countdowns that move, and what leaving the page does (it closes the window).

import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage, t } from '@shared/i18n'
import type { UiSnapshot } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import type { SyncReply, SyncRequest, SyncStatus } from '@shared/sync-ipc'
import { button, click, installBridge, mount, settle, type Mounted } from './dom.test-support'
import { SettingsView } from './SettingsWindow'
import { countdown } from './SyncSettings'

let mounted: Mounted | null = null

const OFF: SyncStatus = { available: true, enabled: false, categories: { structure: true, settings: false, archive: false, openTabs: false }, listening: false, pairing: null, confirm: null, devices: [], identityReplaced: false, justPaired: null, lastExchange: null, problem: null }
const ON: SyncStatus = { ...OFF, enabled: true }

const snapshot = (): UiSnapshot => ({ state: createInitialState({ now: 1, newId: () => 'id' }), extensions: [], downloads: [], runtime: { tabs: {} }, platform: 'darwin' }) as unknown as UiSnapshot

/** A bridge whose `sync` answers `status()` and keeps what it was asked. */
function bridge(status: () => SyncStatus, reply: (request: SyncRequest) => SyncReply | null = () => null) {
  const requests: SyncRequest[] = []
  const sync = vi.fn(async (request: SyncRequest): Promise<SyncReply> => {
    requests.push(request)
    return reply(request) ?? { ok: true, status: status() }
  })
  installBridge({ sync })
  return { requests, sync, kinds: () => requests.map((r) => r.kind) }
}

/** The text of a page with the spaces of French typography (no-break, narrow) as plain spaces. */
const textOf = (page: Element): string => (page.textContent ?? '').replace(/[\u00a0\u202f]/g, ' ')

async function openPage(hash: string): Promise<HTMLElement> {
  location.hash = hash
  // The window hears the change of address after a task; with the timers faked the task is run by hand.
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
  else await new Promise((resolve) => setTimeout(resolve, 0))
  mounted = mount(createElement(SettingsView, { snapshot: snapshot(), initialQuery: '' }))
  await settle()
  return mounted.container
}

beforeEach(() => void setLanguage('fr'))
afterEach(() => {
  mounted?.unmount()
  mounted = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('countdown', () => {
  it('writes minutes and seconds, rounding up, and never below zero', () => {
    expect(countdown(600_000)).toBe('10:00')
    expect(countdown(520_000)).toBe('8:40')
    expect(countdown(59_001)).toBe('1:00')
    expect(countdown(1)).toBe('0:01')
    expect(countdown(0)).toBe('0:00')
    expect(countdown(-5000)).toBe('0:00')
  })
})

describe('the row on the page of the files', () => {
  it('says the state of the synchronisation, asked once, and asks nothing else', async () => {
    const b = bridge(() => OFF)
    const page = await openPage('#files')
    const entry = page.querySelector('main [data-subpage-entry="sync"]')
    expect(entry?.querySelector('.pref-label')?.textContent).toBe('Synchronisation')
    expect(entry?.querySelector('.subpage-state')?.textContent).toBe('Désactivée')
    expect(b.kinds()).toEqual(['status'])
    expect(b.kinds()).not.toContain('open-window')
  })

  it('does not poll, and does not close anything: the row only reads the state once', async () => {
    vi.useFakeTimers()
    const b = bridge(() => OFF)
    await openPage('#files')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(b.kinds()).toEqual(['status'])
  })

  it('counts the devices and says when this Mac is listening for them', async () => {
    bridge(() => ({ ...ON, devices: [{ id: 'a', name: 'iPhone', platform: 'ios', pairedAt: 1, lastSessionAt: null }], listening: true }))
    const page = await openPage('#files')
    expect(page.querySelector('main [data-subpage-entry="sync"] .subpage-state')?.textContent).toBe('1 appareil · à l’écoute')
  })

  it('says it is off by default, in English too', async () => {
    setLanguage('en')
    bridge(() => OFF)
    const page = await openPage('#files')
    expect(page.querySelector('main [data-subpage-entry="sync"] .subpage-state')?.textContent).toBe('Off')
  })
})

describe('the subpage', () => {
  it('opens at its address, with its way back and its line, and shows the switch OFF and nothing else', async () => {
    bridge(() => OFF)
    const page = await openPage('#files/sync')
    expect(page.querySelector('main #pane-heading')?.textContent).toBe('Synchronisation')
    expect(page.querySelector('main .subpage-head .settings-blurb')?.textContent).toBe(t('settings.sub-sync-intro'))
    const switchRow = [...page.querySelectorAll('main input[type="checkbox"]')]
    expect(switchRow).toHaveLength(1)
    expect((switchRow[0] as HTMLInputElement).checked).toBe(false)
    // Off: no listening line, no category, no device, no way to add one.
    expect(page.textContent).not.toContain(t('sync.listening-title'))
    expect(page.textContent).not.toContain(t('sync.add-button'))
  })

  it('turns the synchronisation on when the switch is clicked, and asks nothing else of it', async () => {
    let current = OFF
    const b = bridge(() => current, (request) => (request.kind === 'enable' ? { ok: true, status: (current = ON) } : null))
    const page = await openPage('#files/sync')
    await click(page.querySelector('main input[type="checkbox"]')!)
    expect(b.requests).toContainEqual({ kind: 'enable', on: true })
    expect(b.kinds().filter((kind) => kind !== 'status')).toEqual(['enable'])
    expect(page.textContent).toContain(t('sync.listening-title'))
  })

  it('cannot be turned on when the system cannot seal a key, and says why', async () => {
    bridge(() => ({ ...OFF, available: false }))
    const page = await openPage('#files/sync')
    expect(page.textContent).toContain(t('sync.unavailable'))
    expect((page.querySelector('main input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true)
  })

  it('says the identity was replaced', async () => {
    bridge(() => ({ ...ON, identityReplaced: true }))
    const page = await openPage('#files/sync')
    expect(page.textContent).toContain(t('sync.identity-replaced'))
  })

  it('shows the four categories, the first ticked only, and sends the one that is clicked', async () => {
    const b = bridge(() => ON)
    const page = await openPage('#files/sync')
    const boxes = [...page.querySelectorAll<HTMLInputElement>('main input[type="checkbox"]')].slice(1)
    expect(boxes.map((box) => box.checked)).toEqual([true, false, false, false])
    expect(page.textContent).toContain(t('sync.category-opentabs-hint'))
    expect(page.textContent).toContain(t('sync.categories-never'))
    await click(boxes[3]!)
    expect(b.requests).toContainEqual({ kind: 'category', category: 'openTabs', on: true })
  })

  it('says the Mac waits for the iPhone on the local network while it listens, and has no button to open, prolong or close anything', async () => {
    const b = bridge(() => ({ ...ON, listening: true, devices: [{ id: 'iphone-1', name: 'iPhone de Camille', platform: 'ios', pairedAt: 1_790_000_000_000, lastSessionAt: null }] }))
    const page = await openPage('#files/sync')
    expect(textOf(page)).toContain(t('sync.listening-on'))
    expect(page.textContent).toContain(t('sync.listening-hint'))
    for (const key of ['sync.listening-off', 'sync.listening-failed'] as const) expect(page.textContent).not.toContain(t(key))
    expect(b.kinds().every((kind) => kind === 'status')).toBe(true)
  })

  it('says no port is open when no iPhone is paired, and that the Mac should be listening when one is paired and it is not', async () => {
    bridge(() => ({ ...ON, listening: false }))
    expect((await openPage('#files/sync')).textContent).toContain(t('sync.listening-off'))
    // One page at a time: a page left mounted would go on asking, under the next test's bridge.
    mounted?.unmount()
    mounted = null
    bridge(() => ({ ...ON, listening: false, devices: [{ id: 'iphone-1', name: 'iPhone de Camille', platform: 'ios', pairedAt: 1_790_000_000_000, lastSessionAt: null }] }))
    expect((await openPage('#files/sync')).textContent).toContain(t('sync.listening-failed'))
  })

  it('says in one sentence that no cookie, session, password or automatic sign-in to a website is ever synchronized', async () => {
    bridge(() => ON)
    const page = await openPage('#files/sync')
    const sentence = t('sync.categories-never')
    expect(page.textContent).toContain(sentence)
    for (const word of ['mots de passe', 'cookies', 'sessions', 'connexions automatiques']) expect(sentence).toContain(word)
  })

  it('lists the devices with their dates, forgets one when asked, and adds an iPhone', async () => {
    const b = bridge(() => ({ ...ON, devices: [{ id: 'iphone-1', name: 'iPhone de Camille', platform: 'ios', pairedAt: 1_790_000_000_000, lastSessionAt: null }] }))
    const page = await openPage('#files/sync')
    expect(page.textContent).toContain('iPhone de Camille')
    expect(page.textContent).toContain(t('sync.device-never'))
    await click(page.querySelector('button[aria-label="Oublier iPhone de Camille"]')!)
    expect(b.requests).toContainEqual({ kind: 'forget', id: 'iphone-1' })
    await click(button(page, t('sync.add-button')))
    expect(b.requests).toContainEqual({ kind: 'pair-start' })
  })

  it('says there is no device when there is none', async () => {
    bridge(() => ON)
    const page = await openPage('#files/sync')
    expect(page.textContent).toContain(t('sync.devices-none'))
  })

  it('shows the sheet that adds an iPhone: the QR drawn, the address, the code, the countdown; it closes by its button', async () => {
    const b = bridge(() => ({ ...ON, listening: true, pairing: { qr: 'lucium-sync:1/' + 'A'.repeat(43) + '/' + 'B'.repeat(22) + '/49213/192.168.1.20', code: 'ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z', address: 'mac.local:49213', remainingMs: 95_000 } }))
    const page = await openPage('#files/sync')
    const drawing = page.querySelector('svg.sync-qr')
    expect(drawing?.getAttribute('aria-label')).toBe(t('sync.add-qr-label'))
    expect(drawing?.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(100)
    expect(page.textContent).toContain('mac.local:49213')
    expect(page.textContent).toContain('ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z')
    expect(textOf(page)).toContain('Ce code expire dans 1:35.')
    await click(button(page, t('sync.add-close')))
    expect(b.requests).toContainEqual({ kind: 'pair-close' })
  })

  it('asks the person, by name, with the code to compare and where the request comes from, and sends Autoriser or Refuser', async () => {
    const b = bridge(() => ({ ...ON, confirm: { name: 'iPhone de Camille', code: 'ABC234', address: '192.168.1.40', waiting: false, remainingMs: 42_000 } }))
    const page = await openPage('#files/sync')
    const box = page.querySelector('[role="alertdialog"]')
    expect((box?.textContent ?? '').replace(/[\u00a0\u202f]/g, ' ')).toContain('Un iPhone nommé « iPhone de Camille » demande à s’appairer')
    expect(box?.textContent).toContain('0:42')
    expect(box?.querySelector('.sync-code')?.textContent).toBe('ABC234')
    expect(box?.textContent).toContain('192.168.1.40')
    await click(button(page, 'Autoriser'))
    await click(button(page, 'Refuser'))
    expect(b.requests).toContainEqual({ kind: 'answer', allow: true })
    expect(b.requests).toContainEqual({ kind: 'answer', allow: false })
  })

  it('keeps the code on screen while the iPhone is asked, and offers only « Annuler » then', async () => {
    const b = bridge(() => ({ ...ON, confirm: { name: 'iPhone de Camille', code: 'ABC234', address: '', waiting: true, remainingMs: 30_000 } }))
    const page = await openPage('#files/sync')
    const box = page.querySelector('[role="alertdialog"]')
    expect(box?.querySelector('.sync-code')?.textContent).toBe('ABC234')
    expect(box?.textContent).toContain(t('sync.confirm-waiting-title'))
    expect(box?.textContent).not.toContain('Demande venue de l’adresse')
    expect([...page.querySelectorAll('button')].some((one) => one.textContent === 'Autoriser')).toBe(false)
    await click(button(page, t('sync.confirm-cancel')))
    expect(b.requests).toContainEqual({ kind: 'answer', allow: false })
  })

  it('shows the sentence of a refusal, and keeps the state it came with', async () => {
    bridge(() => ON, (request) => (request.kind === 'pair-start' ? { ok: false, message: t('sync.error.port'), status: ON } : null))
    const page = await openPage('#files/sync')
    await click(button(page, t('sync.add-button')))
    expect(page.querySelector('[role="alert"]')?.textContent).toBe(t('sync.error.port'))
    expect(page.textContent).toContain(t('sync.add-button'))
  })

  it('says the iPhone that has just been paired', async () => {
    bridge(() => ({ ...ON, justPaired: 'iPhone de Camille' }))
    const page = await openPage('#files/sync')
    expect(textOf(page)).toContain('iPhone de Camille est maintenant appairé.')
  })

  it('says so, and logs it, when the main process does not answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    installBridge({ sync: vi.fn(async () => Promise.reject(new Error('the channel is gone'))) })
    const page = await openPage('#files/sync')
    expect(page.querySelector('[role="alert"]')?.textContent).toBe(t('sync.error.internal'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[sync]'), expect.anything())
  })
})

describe('the page and time', () => {
  it('reads the state again every second while it is on screen, and the countdown of the pairing moves', async () => {
    vi.useFakeTimers()
    let remaining = 95_000
    const sheet = (): SyncStatus => ({ ...ON, listening: true, pairing: { qr: 'lucium-sync:1/' + 'A'.repeat(43) + '/' + 'B'.repeat(22) + '/49213/192.168.1.20', code: 'ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z', address: 'mac.local:49213', remainingMs: remaining } })
    const b = bridge(sheet)
    const page = await openPage('#files/sync')
    expect(textOf(page)).toContain('Ce code expire dans 1:35.')
    const before = b.kinds().filter((kind) => kind === 'status').length
    remaining = 94_000
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(b.kinds().filter((kind) => kind === 'status').length).toBe(before + 1)
    expect(textOf(page)).toContain('Ce code expire dans 1:34.')
  })

  it('tells the main process the page was left, by its way back (the sheet of a pairing goes with it)', async () => {
    const b = bridge(() => ON)
    const page = await openPage('#files/sync')
    expect(b.kinds()).not.toContain('leave')
    await act(async () => {
      page.querySelector<HTMLButtonElement>('main .subpage-back')!.click()
    })
    // The page hears the change of address after a task, and lands after a frame.
    await settle(() => new Promise((resolve) => setTimeout(resolve, 0)))
    await settle(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
    expect(b.kinds()).toContain('leave')
    expect(location.hash).toBe('#files')
  })

  it('stops asking once the page is left', async () => {
    vi.useFakeTimers()
    const b = bridge(() => ON)
    await openPage('#files/sync')
    mounted!.unmount()
    mounted = null
    const asked = b.kinds().filter((kind) => kind === 'status').length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(b.kinds().filter((kind) => kind === 'status').length).toBe(asked)
  })

  it('logs it when the main process cannot be told that the page was left', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    installBridge({ sync: vi.fn(async (request: SyncRequest) => (request.kind === 'leave' ? Promise.reject(new Error('the channel is gone')) : { ok: true, status: ON })) })
    await openPage('#files/sync')
    mounted!.unmount()
    mounted = null
    await settle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaving the page could not be told'), expect.anything())
  })

  it('tells the main process the page was left when the whole Settings page is unmounted', async () => {
    const b = bridge(() => ON)
    await openPage('#files/sync')
    mounted!.unmount()
    mounted = null
    expect(b.kinds()).toContain('leave')
  })
})
