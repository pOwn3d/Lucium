// The developer menu offers the extensions window next to the developer-mode switch.
// The menu bar is built from a template: what Menu.buildFromTemplate receives is what is checked, as in menu-devtools.test.ts.
import { describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { developerModeLabel } from '@shared/developer-mode'
import { t } from '@shared/i18n'

const electron = vi.hoisted(() => ({ template: [] as unknown[] }))
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (template: unknown[]) => ((electron.template = template), { items: [] }) },
  webContents: { getFocusedWebContents: () => null },
  app: { getPath: () => '/tmp', getName: () => 'Lucium', getVersion: () => '0.0.0', isPackaged: false },
  shell: {},
  dialog: {},
  BrowserWindow: class {}
}))

const { buildMenu } = await import('./menu')

interface Item {
  label?: string
  click?: () => void
  submenu?: Item[]
}

function developerMenu() {
  const state = createInitialState({ now: 1, newId: () => 'id' })
  const openOverlay = vi.fn()
  const browser = new Proxy({ openOverlay, isDeveloperPage: () => false }, { get: (target, name) => (name in target ? (target as Record<string | symbol, unknown>)[name] : () => undefined) })
  // The menu asks its host a few things while it is built (the windows, the extensions, whether this is the default browser…): lists for the first two, no for the rest.
  const lists = new Set(['windows', 'extensions'])
  const actions = new Proxy({}, { get: (_target, name) => (lists.has(String(name)) ? () => [] : () => false) })
  buildMenu(browser as never, { get: () => state } as never, actions as never)
  const view = (electron.template as Item[]).find((entry) => entry.label === 'Affichage')!
  const developer = view.submenu!.find((entry) => entry.label === 'Développeur')!
  return { items: developer.submenu!, openOverlay }
}

describe('the developer menu', () => {
  it('offers the extension tools next to the developer-mode switch', () => {
    const { items } = developerMenu()
    const labels = items.map((item) => item.label)
    const toggle = labels.indexOf(developerModeLabel(false))
    expect(toggle).toBeGreaterThan(-1)
    expect(labels.indexOf(t('menu.outils-d-extension'))).toBe(toggle + 1)
  })

  it('opens the extensions window from that entry', () => {
    const { items, openOverlay } = developerMenu()
    items.find((item) => item.label === t('menu.outils-d-extension'))!.click!()
    expect(openOverlay).toHaveBeenCalledExactlyOnceWith({ panel: 'extensions' })
  })
})
