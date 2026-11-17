// The row of a folder of the sidebar, rendered to markup: a folder marked « Ne jamais réveiller automatiquement » carries a moon, with its words, so that
// it can be told from the others at a glance.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Folder } from '@shared/model'
import { setLanguage } from '@shared/i18n'
import { FolderBlock, SidebarUiContext, type SidebarUi } from './SidebarRows'
import { frenchSpaces } from '@shared/french-typography'

beforeEach(() => {
  ;(globalThis as { window?: unknown }).window = { lucium: { dispatch: vi.fn() } }
  setLanguage('fr')
})

const ui: SidebarUi = {
  selected: new Set(),
  dragging: new Set(),
  mark: null,
  developerHosts: [],
  containers: [],
  badges: false,
  clickRow: () => undefined,
  menuRow: () => undefined,
  dragStartRow: () => undefined,
  dragStartFolder: () => undefined,
  dragEnd: () => undefined,
  clearSelection: () => undefined,
  hoverStart: () => undefined,
  hoverEnd: () => undefined
}

const markup = (folder: Folder): string => renderToStaticMarkup(createElement(SidebarUiContext.Provider, { value: ui }, createElement(FolderBlock, { folder, first: true, children: null })))
const base: Folder = { id: 'f1', spaceId: 's1', name: 'Anciens sites', collapsed: true }

describe('the row of a folder', () => {
  it('carries a moon with its words when the folder is never woken by itself', () => {
    const html = markup({ ...base, noWake: true })
    expect(html).toContain('class="folder-asleep"')
    expect(html).toContain(frenchSpaces('title="Dossier endormi : ses onglets ne sont jamais réveillés automatiquement"'))
    expect(html).toContain('role="img"')
  })

  it('carries none for an ordinary folder', () => {
    expect(markup(base)).not.toContain('folder-asleep')
  })
})

describe('the icon of a folder row', () => {
  it('is the folder drawing, closed or open, when the folder has no emoji', () => {
    expect(markup(base)).toContain('class="folder-glyph"')
    expect(markup({ ...base, collapsed: false })).toContain('class="folder-glyph open"')
    expect(markup(base)).not.toContain('folder-emoji')
  })

  it('is the emoji of the folder in place of the drawing, whether the folder is open or closed', () => {
    for (const collapsed of [true, false]) {
      const html = markup({ ...base, collapsed, icon: '📚' })
      expect(html, String(collapsed)).toContain('<span class="folder-emoji" aria-hidden="true">📚</span>')
      expect(html, String(collapsed)).not.toContain('folder-glyph')
    }
  })

  it('leaves the name of the row to the folder, and its state to aria-expanded: the emoji is decoration', () => {
    const html = markup({ ...base, collapsed: false, icon: '📚' })
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('<span class="folder-name">Anciens sites</span>')
    expect(markup({ ...base, collapsed: true, icon: '📚' })).toContain('aria-expanded="false"')
  })

  it('carries the moon of a sleeping folder as well as its emoji', () => {
    const html = markup({ ...base, noWake: true, icon: '🌙' })
    expect(html).toContain('folder-emoji')
    expect(html).toContain('class="folder-asleep"')
  })
})
