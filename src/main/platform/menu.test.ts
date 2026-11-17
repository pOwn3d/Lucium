import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { adaptMenuTemplate, MAC_ONLY_ROLES } from './menu'

const separator: MenuItemConstructorOptions = { type: 'separator' }
const disabled = (label: string): MenuItemConstructorOptions => ({ label, enabled: false })

/** The shape of Lucium's menu that matters here: the application menu with its macOS roles, an Edit menu with Substitutions and Speech, and a Window menu. */
function template(): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Lucium',
      submenu: [
        { role: 'about', label: 'À propos' },
        separator,
        { label: 'Réglages…', accelerator: 'CmdOrCtrl+,' },
        { type: 'separator' },
        { role: 'services', label: 'Services' },
        { type: 'separator' },
        { role: 'hide', label: 'Masquer' },
        { role: 'hideOthers', label: 'Masquer les autres' },
        { role: 'unhide', label: 'Tout afficher' },
        separator,
        { role: 'quit', label: 'Quitter' }
      ]
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'copy', label: 'Copier' },
        {
          label: 'Orthographe et grammaire',
          submenu: [disabled('Afficher'), separator, { label: 'Vérifier lors de la saisie', type: 'checkbox' }]
        },
        { label: 'Substitutions', submenu: [{ role: 'showSubstitutions', label: 'Afficher' }, separator, disabled('Guillemets intelligents'), disabled('Tirets intelligents')] },
        { label: 'Parole', submenu: [{ role: 'startSpeaking', label: 'Commencer' }, { role: 'stopSpeaking', label: 'Arrêter' }] }
      ]
    },
    { role: 'windowMenu', label: 'Fenêtre' },
    { label: 'Aide', role: 'help', submenu: [{ label: 'Documentation' }] }
  ]
}

const labels = (items: readonly MenuItemConstructorOptions[]): string[] => items.map((item) => item.label ?? item.role ?? item.type ?? '?')

describe('adaptMenuTemplate', () => {
  it('returns the very template it was given on macOS, so the macOS menu cannot move', () => {
    const original = template()
    const before = JSON.stringify(original)
    expect(adaptMenuTemplate('darwin', original)).toBe(original)
    expect(JSON.stringify(original)).toBe(before)
  })

  for (const platform of ['win32', 'linux'] as const) {
    describe(platform, () => {
      it('takes the roles that only exist on macOS out of the application menu, with the separators they stranded', () => {
        const adapted = adaptMenuTemplate(platform, template())
        const app = adapted[0]!.submenu as MenuItemConstructorOptions[]
        expect(labels(app)).toEqual(['À propos', 'separator', 'Réglages…', 'separator', 'Quitter'])
      })

      it('drops the submenus that the removal left with nothing to do, and keeps those that have something', () => {
        const edit = adaptMenuTemplate(platform, template())[1]!.submenu as MenuItemConstructorOptions[]
        expect(labels(edit)).toEqual(['Copier', 'Orthographe et grammaire'])
      })

      it('leaves the Window and Help menus', () => {
        const adapted = adaptMenuTemplate(platform, template())
        expect(labels(adapted)).toEqual(['Lucium', 'Édition', 'Fenêtre', 'Aide'])
      })

      it('does not change the template it was given', () => {
        const original = template()
        const before = JSON.stringify(original)
        adaptMenuTemplate(platform, original)
        expect(JSON.stringify(original)).toBe(before)
      })

      it('keeps a submenu that is disabled from the start: only the removal of a macOS entry makes one disappear', () => {
        const adapted = adaptMenuTemplate(platform, [{ label: 'Extensions', submenu: [disabled('Aucune extension')] }])
        expect(labels(adapted)).toEqual(['Extensions'])
      })
    })
  }

  it('lists the roles of macOS it takes out, and none that the other systems have', () => {
    for (const shared of ['about', 'quit', 'copy', 'paste', 'cut', 'undo', 'redo', 'selectAll', 'togglefullscreen', 'minimize', 'close', 'windowMenu', 'help', 'pasteAndMatchStyle']) {
      expect(MAC_ONLY_ROLES.has(shared), shared).toBe(false)
    }
    for (const role of ['services', 'hide', 'hideOthers', 'unhide', 'front', 'zoom', 'showSubstitutions', 'startSpeaking', 'stopSpeaking', 'shareMenu']) {
      expect(MAC_ONLY_ROLES.has(role), role).toBe(true)
    }
  })
})
