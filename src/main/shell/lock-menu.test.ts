import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ Menu: { buildFromTemplate: (template: unknown) => template } }))

import { lockedMenuTemplate } from './lock-menu'

interface Entry {
  label?: string
  role?: string
  type?: string
  click?: unknown
  submenu?: Entry[]
}

const flat = (items: Entry[]): Entry[] => items.flatMap((item) => [item, ...(item.submenu ? flat(item.submenu) : [])])

describe('the menu bar of a locked application', () => {
  const template = lockedMenuTemplate() as Entry[]

  it('holds only the system’s own entries (roles): nothing of ours that could show or change what is hidden', () => {
    for (const item of flat(template)) {
      if (item.type === 'separator' || item.submenu) continue
      expect(item.role, `${item.label} is not a role of the system`).toBeDefined()
      expect(item.click, `${item.label} has an action of ours`).toBeUndefined()
    }
  })

  it('keeps quitting, hiding, editing (the phrase is typed and pasted) and the Window menu (⌘M, ⌘W)', () => {
    const roles = flat(template).map((item) => item.role)
    for (const role of ['quit', 'hide', 'paste', 'selectAll', 'windowMenu']) expect(roles).toContain(role)
  })

  it('offers no tab, no history, no space, no settings and no new window', () => {
    const labels = flat(template).map((item) => item.label ?? '')
    for (const fragment of ['onglet', 'fenêtre privée', 'Nouvelle', 'Historique', 'Réglages', 'Espace']) {
      expect(labels.filter((label) => label.includes(fragment)), fragment).toEqual([])
    }
  })
})
