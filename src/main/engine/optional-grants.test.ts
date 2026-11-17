// chrome.permissions as a profile answers it: the question to the person, what is kept, and what the four calls say. The host is made up; the rules are the real ones.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shimAllowed } from '@shared/chrome-compat'
import type { ExtensionReview } from '@shared/extension-review'
import { setLanguage } from '@shared/i18n'
import type { PermissionSet } from '@shared/optional-permissions'
import { OptionalGrants, PERMISSION_ERRORS, type OptionalGrantsHost } from './optional-grants'

beforeEach(() => setLanguage('fr'))

const EXT = 'a'.repeat(32)
const MANIFEST = {
  manifest_version: 3,
  name: 'Sonde',
  version: '1.0',
  permissions: ['storage'],
  host_permissions: ['https://own.example/*'],
  optional_permissions: ['history', 'cookies'],
  optional_host_permissions: ['https://*.shop.example/*']
}

function setup(options: { gesture?: boolean; answer?: boolean | Promise<boolean>; manifest?: unknown } = {}) {
  const kept = new Map<string, string>()
  const manifests = new Map<string, unknown>([[`default:${EXT}`, options.manifest ?? MANIFEST], [`work:${EXT}`, options.manifest ?? MANIFEST]])
  const asked: Array<{ profileId: string; review: ExtensionReview; sender: unknown }> = []
  const events: Array<[string, string, PermissionSet]> = []
  const notes: string[] = []
  const changed: string[] = []
  const warned: string[] = []
  let gesture = options.gesture !== false
  const host: OptionalGrantsHost = {
    manifestOf: (profileId, extensionId) => manifests.get(`${profileId}:${extensionId}`),
    nameOf: () => 'Sonde API',
    read: (profileId, extensionId) => kept.get(`${profileId}:${extensionId}`),
    write: (profileId, extensionId, value) => void (value === undefined ? kept.delete(`${profileId}:${extensionId}`) : kept.set(`${profileId}:${extensionId}`, value)),
    hadGesture: () => gesture,
    ask: vi.fn(async (profileId, _extensionId, review, sender) => {
      asked.push({ profileId, review, sender })
      return options.answer ?? true
    }),
    changed: (profileId, extensionId) => void changed.push(`${profileId}:${extensionId}`),
    emit: (profileId, _extensionId, event, set) => void events.push([profileId, event, set]),
    note: (_profileId, _extensionId, message) => void notes.push(message),
    warn: (message) => void warned.push(message)
  }
  return { grants: new OptionalGrants(host), host, kept, manifests, asked, events, notes, changed, warned, setGesture: (on: boolean) => void (gesture = on) }
}

describe('a request for a facultative permission', () => {
  it('asks the person with the sheet, keeps a yes for the profile, and tells the extension what was added', async () => {
    const t = setup()
    const sender = { id: 7 }
    expect(await t.grants.request('default', EXT, { permissions: ['history'], origins: ['https://pay.shop.example/*'] }, sender)).toBe(true)
    expect(t.asked).toHaveLength(1)
    expect(t.asked[0]!.sender).toBe(sender)
    expect(t.asked[0]!.review.name).toBe('Sonde API')
    expect(t.asked[0]!.review.permissions.map((p) => [p.id, p.level])).toEqual([['history', 'broad']])
    expect(t.asked[0]!.review.sites.patterns).toEqual(['https://pay.shop.example/*'])
    expect(t.grants.granted('default', EXT)).toEqual({ permissions: ['history'], origins: ['https://pay.shop.example/*'] })
    expect(t.changed).toEqual([`default:${EXT}`])
    expect(t.events).toEqual([['default', 'onAdded', { permissions: ['history'], origins: ['https://pay.shop.example/*'] }]])
    // Kept for this profile only: the copy of the extension in another profile holds nothing more.
    expect(t.grants.granted('work', EXT)).toEqual({ permissions: [], origins: [] })
    expect(t.grants.contains('work', EXT, { permissions: ['history'] })).toBe(false)
  })

  it('grants nothing on a no, and says nothing to the extension but the answer', async () => {
    const t = setup({ answer: false })
    expect(await t.grants.request('default', EXT, { permissions: ['history'] }, null)).toBe(false)
    expect(t.grants.granted('default', EXT)).toEqual({ permissions: [], origins: [] })
    expect(t.kept.size).toBe(0)
    expect(t.events).toEqual([])
    expect(t.changed).toEqual([])
  })

  it('is refused without a question when no click or key came just before, with a line for the person', async () => {
    const t = setup({ gesture: false })
    await expect(t.grants.request('default', EXT, { permissions: ['history'] }, null)).rejects.toThrow(PERMISSION_ERRORS.noGesture)
    expect(t.host.ask).not.toHaveBeenCalled()
    expect(t.kept.size).toBe(0)
    expect(t.notes).toEqual([expect.stringContaining('history')])
    expect(t.notes[0]).toContain('sans que vous ayez cliqué')
  })

  it('is refused whole, without a question, when it names anything the manifest does not list as facultative', async () => {
    const t = setup()
    await expect(t.grants.request('default', EXT, { permissions: ['history', 'debugger'] }, null)).rejects.toThrow(PERMISSION_ERRORS.notOptional)
    await expect(t.grants.request('default', EXT, { origins: ['https://bank.example/*'] }, null)).rejects.toThrow(PERMISSION_ERRORS.notOptional)
    await expect(t.grants.request('default', EXT, { origins: ['*://*/*'] }, null)).rejects.toThrow(PERMISSION_ERRORS.notOptional)
    expect(t.host.ask).not.toHaveBeenCalled()
    expect(t.kept.size).toBe(0)
    expect(t.notes[0]).toContain('debugger')
  })

  it('refuses a request that cannot be read', async () => {
    const t = setup()
    await expect(t.grants.request('default', EXT, { permissions: 'history' }, null)).rejects.toThrow(PERMISSION_ERRORS.invalid)
    await expect(t.grants.request('default', EXT, undefined, null)).rejects.toThrow(PERMISSION_ERRORS.invalid)
    expect(t.host.ask).not.toHaveBeenCalled()
  })

  it('answers yes at once, with no question and no click needed, for what is already held', async () => {
    const t = setup()
    await t.grants.request('default', EXT, { permissions: ['history'] }, null)
    t.setGesture(false)
    expect(await t.grants.request('default', EXT, { permissions: ['history', 'storage'], origins: ['https://own.example/*'] }, null)).toBe(true)
    expect(t.host.ask).toHaveBeenCalledTimes(1)
  })

  it('shows only what is still missing when part of the request is held', async () => {
    const t = setup()
    await t.grants.request('default', EXT, { permissions: ['history'] }, null)
    await t.grants.request('default', EXT, { permissions: ['history', 'cookies'] }, null)
    expect(t.asked[1]!.review.permissions.map((p) => p.id)).toEqual(['cookies'])
    expect(t.events[1]).toEqual(['default', 'onAdded', { permissions: ['cookies'], origins: [] }])
    expect(t.grants.granted('default', EXT).permissions).toEqual(['history', 'cookies'])
  })

  it('puts one question at a time in front of the person for an extension', async () => {
    let answer: (agreed: boolean) => void = () => undefined
    const t = setup({ answer: new Promise<boolean>((resolve) => void (answer = resolve)) })
    const first = t.grants.request('default', EXT, { permissions: ['history'] }, null)
    await expect(t.grants.request('default', EXT, { permissions: ['cookies'] }, null)).rejects.toThrow(PERMISSION_ERRORS.pending)
    answer(true)
    expect(await first).toBe(true)
    expect(t.host.ask).toHaveBeenCalledTimes(1)
  })

  it('keeps nothing when the extension lost the permission from its manifest, or left, while the sheet was open', async () => {
    let answer: (agreed: boolean) => void = () => undefined
    const t = setup({ answer: new Promise<boolean>((resolve) => void (answer = resolve)) })
    const waiting = t.grants.request('default', EXT, { permissions: ['history'] }, null)
    t.manifests.set(`default:${EXT}`, { ...MANIFEST, optional_permissions: ['cookies'] })
    answer(true)
    expect(await waiting).toBe(false)
    expect(t.kept.size).toBe(0)
    expect(t.events).toEqual([])
  })

  it('lets the next question be asked after a sheet that failed', async () => {
    const t = setup()
    vi.mocked(t.host.ask).mockRejectedValueOnce(new Error('no window'))
    await expect(t.grants.request('default', EXT, { permissions: ['history'] }, null)).rejects.toThrow('no window')
    expect(await t.grants.request('default', EXT, { permissions: ['history'] }, null)).toBe(true)
  })
})

describe('what an extension is told it holds', () => {
  it('is what its manifest gives and what was granted, and nothing else', async () => {
    const t = setup()
    expect(t.grants.getAll('default', EXT)).toEqual({ permissions: ['storage'], origins: ['https://own.example/*'] })
    expect(t.grants.contains('default', EXT, { permissions: ['storage'], origins: ['https://own.example/page'] })).toBe(true)
    expect(t.grants.contains('default', EXT, { permissions: ['history'] })).toBe(false)
    await t.grants.request('default', EXT, { permissions: ['history'], origins: ['https://*.shop.example/*'] }, null)
    expect(t.grants.getAll('default', EXT)).toEqual({ permissions: ['storage', 'history'], origins: ['https://own.example/*', 'https://*.shop.example/*'] })
    expect(t.grants.contains('default', EXT, { permissions: ['history'], origins: ['https://pay.shop.example/*'] })).toBe(true)
    expect(t.grants.contains('default', EXT, { permissions: ['history', 'cookies'] })).toBe(false)
    expect(() => t.grants.contains('default', EXT, 'history')).toThrow(PERMISSION_ERRORS.invalid)
  })

  it('enters the manifest the access rules read', async () => {
    const t = setup()
    expect(t.grants.effective('default', EXT, MANIFEST)).toBe(MANIFEST)
    await t.grants.request('default', EXT, { permissions: ['history'] }, null)
    expect(shimAllowed(t.grants.effective('default', EXT, MANIFEST), 'history', 'search')).toBe(true)
    expect(shimAllowed(t.grants.effective('work', EXT, MANIFEST), 'history', 'search')).toBe(false)
  })

  it('holds nothing for a kept text that cannot be read, says once for which extension, and drops it', () => {
    const t = setup()
    t.kept.set(`default:${EXT}`, '{"permissions":"everything"}')
    expect(t.grants.granted('default', EXT)).toEqual({ permissions: [], origins: [] })
    expect(t.grants.contains('default', EXT, { permissions: ['history'] })).toBe(false)
    expect(t.warned).toEqual([expect.stringContaining(`what was granted to ${EXT} in profile default cannot be read`)])
    expect(t.kept.size).toBe(0)
  })
})

describe('a permission given back', () => {
  it('by the extension: it is no longer held, and the extension is told what was removed', async () => {
    const t = setup()
    await t.grants.request('default', EXT, { permissions: ['history', 'cookies'], origins: ['https://pay.shop.example/*'] }, null)
    expect(t.grants.remove('default', EXT, { permissions: ['history'], origins: ['https://*.shop.example/*'] })).toBe(true)
    expect(t.grants.granted('default', EXT)).toEqual({ permissions: ['cookies'], origins: [] })
    expect(t.grants.contains('default', EXT, { permissions: ['history'] })).toBe(false)
    expect(t.events.at(-1)).toEqual(['default', 'onRemoved', { permissions: ['history'], origins: ['https://pay.shop.example/*'] }])
    expect(t.changed).toHaveLength(2)
  })

  it('never by the extension for what its manifest gives by itself', async () => {
    const t = setup()
    expect(() => t.grants.remove('default', EXT, { permissions: ['storage'] })).toThrow(PERMISSION_ERRORS.required)
    expect(t.events).toEqual([])
  })

  it('by the person, from the Extensions page: one permission or one site, and the extension is told', async () => {
    const t = setup()
    await t.grants.request('default', EXT, { permissions: ['history'], origins: ['https://pay.shop.example/*'] }, null)
    expect(t.grants.revoke('default', EXT, 'https://pay.shop.example/*')).toBe(true)
    expect(t.grants.granted('default', EXT)).toEqual({ permissions: ['history'], origins: [] })
    expect(t.events.at(-1)).toEqual(['default', 'onRemoved', { permissions: [], origins: ['https://pay.shop.example/*'] }])
    expect(t.grants.revoke('default', EXT, 'history')).toBe(true)
    // Nothing is left: nothing is kept on disk for it.
    expect(t.kept.size).toBe(0)
    expect(t.grants.revoke('default', EXT, 'history')).toBe(false)
    expect(t.grants.revoke('default', EXT, 'storage')).toBe(false)
  })

  it('is forgotten with the extension: installed again, it asks again', async () => {
    const t = setup()
    await t.grants.request('default', EXT, { permissions: ['history'] }, null)
    t.grants.forget('default', EXT)
    expect(t.kept.size).toBe(0)
    expect(t.grants.contains('default', EXT, { permissions: ['history'] })).toBe(false)
  })

  it('lists for the page what is granted, with the sentences of the sheet', async () => {
    const t = setup()
    await t.grants.request('default', EXT, { permissions: ['cookies'], origins: ['https://pay.shop.example/*'] }, null)
    expect(t.grants.facts('default', EXT)).toEqual({ permissions: [{ id: 'cookies', label: 'Lire et modifier vos cookies sur les sites autorisés', level: 'sensitive' }], origins: ['https://pay.shop.example/*'] })
  })
})
