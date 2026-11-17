import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectiveAccelerator } from '@shared/keybindings'
import type { PlatformId } from '@shared/platform'
import { createInitialState, reduce } from '@shared/sidebar'
import { played, resetPlayedPlatform } from '../platform/platform.test-support'

// The menu bar is built from a template: what Menu.buildFromTemplate receives is what is checked.
const electron = vi.hoisted(() => ({ template: [] as unknown[] }))
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (template: unknown[]) => ((electron.template = template), { items: [] }) },
  webContents: { getFocusedWebContents: () => null },
  app: { getPath: () => '/tmp', getName: () => 'Lucium', getVersion: () => '0.0.0', isPackaged: false },
  shell: {},
  dialog: {},
  BrowserWindow: class {}
}))

// The menu of the system a test names, on any machine (a Windows runner included): the shortcuts differ by system (shared/platform.ts).
vi.mock('../platform', async (original) => (await import('../platform/platform.test-support')).playedPlatform(await original()))

const { buildMenu } = await import('./menu')

afterEach(resetPlayedPlatform)

interface Item {
  label?: string
  accelerator?: string
  visible?: boolean
  click?: () => void
  submenu?: Item[]
}

function developerEntries(keyBindings: Record<string, string> = {}): { items: Item[]; devTools: ReturnType<typeof vi.fn> } {
  const ctx = { now: 1, newId: () => 'id' }
  const state = reduce(createInitialState(ctx), { type: 'settings/update', patch: { keyBindings } }, ctx)
  const devTools = vi.fn()
  const browser = new Proxy({ devTools }, { get: (target, name) => (name in target ? (target as Record<string | symbol, unknown>)[name] : () => undefined) })
  // The menu asks its host a few things while it is built (the windows, the extensions, whether this is the default browser…): lists for the first two, no for the rest.
  const lists = new Set(['windows', 'extensions'])
  const actions = new Proxy({}, { get: (_target, name) => (lists.has(String(name)) ? () => [] : () => false) })
  buildMenu(browser as never, { get: () => state } as never, actions as never)
  const view = (electron.template as Item[]).find((entry) => entry.label === 'Affichage')!
  const developer = view.submenu!.find((entry) => entry.label === 'Développeur')!
  return { items: developer.submenu!, devTools }
}

describe('Affichage › Développeur', () => {
  // The shortcuts are read from where the application reads them (`effectiveAccelerator`, which the platform layer calls), not written again here: they differ
  // by system (Windows adds Shift to the Ctrl+Alt+letter ones, which are AltGr there, and gives none to the picking mode).
  it.each<PlatformId>(['darwin', 'win32', 'linux'])('has the tools, the picking mode and the console on the shortcuts of %s, each asking for what its name says', (system) => {
    played.id = system
    const { items, devTools } = developerEntries()
    const by = (label: string) => items.find((item) => item.label === label && item.visible !== false)!
    by('Outils de développement').click!()
    by('Inspecter les éléments').click!()
    by('Console JavaScript').click!()
    by('Inspecteur réseau').click!()
    expect(devTools.mock.calls.map((call) => call[0])).toEqual(['tools', 'inspect', 'console', 'network'])
    expect([by('Outils de développement').accelerator, by('Inspecter les éléments').accelerator, by('Console JavaScript').accelerator]).toEqual([
      effectiveAccelerator('devTools', undefined, system),
      effectiveAccelerator('inspectElement', undefined, system),
      effectiveAccelerator('jsConsole', undefined, system)
    ])
  })

  it('has F12 as a second, hidden entry for the tools', () => {
    const { items, devTools } = developerEntries()
    const f12 = items.find((item) => item.accelerator === 'F12')!
    expect(f12).toMatchObject({ label: 'Outils de développement', visible: false })
    f12.click!()
    expect(devTools).toHaveBeenCalledWith('tools')
  })

  it('leaves F12 out once the user gave that key to another command', () => {
    expect(developerEntries({ reload: 'F12' }).items.some((item) => item.accelerator === 'F12')).toBe(false)
  })
})
