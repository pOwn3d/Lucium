// The block list inside the engine (electron-engine-extensions.ts): a listed extension counts as switched off in every profile whatever the person's settings say,
// is not loaded, and the person is told once. The list is replaced by one entry here; the real one is in shared/extension-blocklist-data.ts.

import { describe, expect, it, vi } from 'vitest'

const BAD = 'a'.repeat(32)
const GOOD = 'b'.repeat(32)

vi.mock('@shared/extension-blocklist-data', () => ({ BLOCKED_EXTENSIONS: [{ id: 'a'.repeat(32), reason: 'malware' }] }))
vi.mock('electron', async () =>
  (await import('./electron-page.test-support')).electronStub({
    app: { getPath: (name: string) => (name === 'home' ? '/Users/me' : `/tmp/lucium-test-${name}`) },
    session: { defaultSession: {} }
  })
)
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

function engine() {
  const notices: string[] = []
  const known = new Map<string, unknown>()
  const self: Record<string, unknown> = {
    disabled: new Map<string, Set<string>>(),
    blockedTold: new Set<string>(),
    known,
    notice: (message: string) => notices.push(message),
    extensionsChanged: vi.fn(),
    placeholder: (profileId: string, id: string) => ({ id, name: 'Evil', version: '1', profileId, source: 'store', enabled: false }),
    readManifest: () => null,
    loadInto: vi.fn(async () => ({}))
  }
  self['isDisabled'] = methods['isDisabled']!
  self['turnedOff'] = methods['turnedOff']!
  return { self, notices, known }
}

describe('a listed extension, in the engine', () => {
  it('is switched off in every profile, with nothing in the settings', () => {
    const { self } = engine()
    expect(methods['isDisabled']!.call(self, 'default', BAD)).toBe(true)
    expect(methods['isDisabled']!.call(self, 'work', BAD)).toBe(true)
    expect(methods['isDisabled']!.call(self, 'default', GOOD)).toBe(false)
  })

  it('tells the person once, with its name, however many profiles and loads', () => {
    const { self, notices } = engine()
    expect(methods['turnedOff']!.call(self, 'default', BAD, 'Evil')).toBe(true)
    expect(methods['turnedOff']!.call(self, 'work', BAD, 'Evil')).toBe(true)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('Evil')
  })

  it('says nothing of one that is merely switched off by the person, and nothing of the others', () => {
    const { self, notices } = engine()
    ;(self['disabled'] as Map<string, Set<string>>).set('default', new Set([GOOD]))
    expect(methods['turnedOff']!.call(self, 'default', GOOD, 'Mine')).toBe(true)
    expect(methods['turnedOff']!.call(self, 'default', 'c'.repeat(32), 'Other')).toBe(false)
    expect(notices).toEqual([])
  })

  it('is not loaded at launch: loadFirst keeps its folder out of the session', async () => {
    const { self, known } = engine()
    await methods['loadFirst']!.call(self, 'default', {}, '/store/default/' + BAD, BAD)
    expect(self['loadInto']).not.toHaveBeenCalled()
    expect(known.has(`default:${BAD}`)).toBe(true)
  })
})
