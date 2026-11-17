import { describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import type { HardwareGrantRow, HardwareReply } from '@shared/web-hardware'
import type { Browser } from './browser'
import type { ScopedIpc } from './ipc-scope'
import { registerHardwareIpc } from './hardware-ipc'

type Handler = (event: { sender: object }, ...args: unknown[]) => unknown

const ROW: HardwareGrantRow = { id: 'hw-1', origin: 'https://exemple.org', site: 'exemple.org', kind: 'hid', kindName: 'HID', device: 'Manette (046d:c52b)' }

function setup(options: { private?: boolean; trusted?: boolean; holders?: number } = {}) {
  const handlers = new Map<string, Handler>()
  const ipc: ScopedIpc = {
    on: (channel, listener) => void handlers.set(channel, listener as Handler),
    handle: (channel, listener) => void handlers.set(channel, listener as Handler)
  }
  let rows = [ROW]
  const revoked: Array<string | undefined> = []
  const browser = {
    isPrivate: () => options.private === true,
    webHardwareGrants: () => rows,
    revokeWebHardware: (id?: string) => {
      revoked.push(id)
      rows = id === undefined ? [] : rows.filter((row) => row.id !== id)
      return options.holders ?? 0
    }
  } as unknown as Browser
  const guard = vi.fn(() => options.trusted !== false)
  registerHardwareIpc(ipc, guard, browser)
  const call = (raw: unknown) => handlers.get(Channel.webHardware)!({ sender: {} }, raw) as HardwareReply
  return { call, revoked, guard }
}

describe('the web hardware IPC', () => {
  it('lists the grants for a normal window', () => {
    expect(setup().call({ kind: 'list' })).toEqual({ ok: true, message: '', grants: [ROW] })
  })

  it('takes one grant back, then says it is not there any more', () => {
    const t = setup()
    expect(t.call({ kind: 'revoke', id: 'hw-1' })).toEqual({ ok: true, message: 'Accès retiré.', grants: [] })
    expect(t.revoked).toEqual(['hw-1'])
    expect(t.call({ kind: 'revoke', id: 'hw-1' })).toMatchObject({ ok: false, message: 'Cette autorisation n’existe plus.' })
    expect(t.revoked).toEqual(['hw-1'])
  })

  it('takes every grant back', () => {
    const t = setup()
    expect(t.call({ kind: 'revoke-all' })).toEqual({ ok: true, message: 'Tous les accès sont retirés.', grants: [] })
    expect(t.revoked).toEqual([undefined])
  })

  it('warns that a connection already open stays open until the tab reloads', () => {
    expect(setup({ holders: 1 }).call({ kind: 'revoke', id: 'hw-1' }).message).toContain('reste active jusqu’au rechargement')
    expect(setup({ holders: 2 }).call({ kind: 'revoke-all' }).message).toContain('reste active jusqu’au rechargement')
  })

  it('refuses everything in a private window, which lists none and must not show the normal windows’', () => {
    const t = setup({ private: true })
    for (const request of [{ kind: 'list' }, { kind: 'revoke', id: 'hw-1' }, { kind: 'revoke-all' }]) {
      expect(t.call(request)).toEqual({ ok: false, message: 'Les appareils ne sont pas disponibles dans une fenêtre privée.', grants: [] })
    }
    expect(t.revoked).toEqual([])
  })

  it('refuses a sender that is not one of the application’s own pages', () => {
    const t = setup({ trusted: false })
    expect(t.call({ kind: 'revoke-all' })).toEqual({ ok: false, message: 'Demande refusée.', grants: [] })
    expect(t.revoked).toEqual([])
  })

  it('refuses a request that is not exactly one of the three, and acts on none', () => {
    const t = setup()
    for (const bad of [null, 'list', { kind: 'list', extra: 1 }, { kind: 'revoke' }, { kind: 'revoke', id: '*' }, { kind: 'revoke', id: 'hw-1', all: true }, { kind: 'forget' }]) {
      expect(t.call(bad), JSON.stringify(bad)).toEqual({ ok: false, message: 'Demande invalide.', grants: [] })
    }
    expect(t.revoked).toEqual([])
  })
})
