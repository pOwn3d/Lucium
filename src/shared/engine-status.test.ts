import { afterEach, describe, expect, it } from 'vitest'
import { buildReport, summarizeLists, type StatusInput } from './engine-status'
import { setLanguage } from './i18n'
import { frenchSpaces } from './french-typography'

const input = (over: Partial<StatusInput> = {}): StatusInput => ({
  now: Date.UTC(2026, 9, 28, 14, 4),
  appVersion: '0.1.0',
  engine: { version: '45.0.0', chromium: '156.0.8078.48' },
  platform: 'darwin',
  host: { electron: '45.0.0', node: '24.1.0', v8: '14.6', arch: 'arm64', osRelease: '27.2.0', variant: 'standard', widevine: null, processes: 11, memoryMb: 988 },
  lists: { installed: 3, rules: 142364, updatedAt: Date.UTC(2026, 9, 25) },
  extensions: [{ profileId: 'default' }, { profileId: 'default' }, { profileId: 'work' }],
  boosts: 4,
  tabs: 7,
  modified: ['sendGpc', 'blockAds'],
  ...over
})

afterEach(() => setLanguage('fr'))

describe('the report of the state of the engine', () => {
  it('holds the versions, the platform, the lists, the counts and the names of the settings that changed', () => {
    setLanguage('fr')
    const report = buildReport(input())
    expect(report).toContain('Lucium 0.1.0 · Electron 45.0.0 · Chromium 156.0.8078.48 · variante Standard')
    expect(report).toContain('macOS 27.2.0 · arm64')
    expect(report).toContain(frenchSpaces('Widevine : Absent'))
    expect(report).toMatch(/Bloqueur\u00a0: 3 listes · 142\D364 règles · vérifiées le/)
    expect(report).toContain(frenchSpaces('Extensions : 3 (profils : 2) · Retouches : 4 · onglets : 7'))
    expect(report).toMatch(/Mémoire\u00a0: 988\u00a0Mo · 11 processus/)
    expect(report).toContain(frenchSpaces('Réglages hors défaut (noms seulement) : blockAds, sendGpc'))
  })

  it('says it with a DRM build, with no list, and with every setting at its default', () => {
    const report = buildReport(input({ host: { ...input().host, variant: 'ecs', widevine: '4.10.2891.0' }, lists: summarizeLists([{ installed: false, rules: null, updatedAt: null }]), modified: [] }))
    expect(report).toContain('variante DRM (castLabs)')
    expect(report).toContain(frenchSpaces('Widevine : Installé (4.10.2891.0)'))
    expect(report).toContain(frenchSpaces('Bloqueur : Aucune liste installée'))
    expect(report).toContain(frenchSpaces('Réglages : tous par défaut'))
  })

  it('is in English when the language is', () => {
    setLanguage('en')
    const report = buildReport(input())
    expect(report).toContain('Lucium status')
    expect(report).toContain('Settings not at their default (names only): blockAds, sendGpc')
    expect(report).not.toContain('Réglages')
  })

  it('holds nothing the person did or has: not the journal (which names sites), not the name of an extension or a profile, not a path', () => {
    const report = buildReport(
      input({
        host: { ...input().host, log: ['2026-10-28T09:14:03Z [favicons] https://agenda.exemple.org/icon.png: 404', '[main] /Users/jdupont/Library/Application Support/Lucium/state.json'] },
        extensions: [{ profileId: 'Compte bancaire', id: 'aaaa', name: 'Mes impôts' } as unknown as { profileId: string }]
      })
    )
    for (const private_ of ['agenda.exemple.org', 'https://', '/Users/', 'jdupont', 'state.json', 'Compte bancaire', 'Mes impôts', 'aaaa']) expect(report, private_).not.toContain(private_)
    expect(report).toContain(frenchSpaces('Journal : 2 lignes (non incluses)'))
  })
})

describe('the lists of the blocker in three numbers', () => {
  it('counts the lists that are installed, their rules, and the latest update', () => {
    expect(summarizeLists([{ installed: true, rules: 100, updatedAt: 5 }, { installed: true, rules: 20, updatedAt: 9 }, { installed: false, rules: 999, updatedAt: 99 }])).toEqual({ installed: 2, rules: 120, updatedAt: 9 })
    expect(summarizeLists(undefined)).toEqual({ installed: 0, rules: 0, updatedAt: null })
  })
})
