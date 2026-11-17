// The Tweak editor drawn to markup with the real component: the header with Style / Code, the strip of the Tweaks of the site
// that has to stay, the foot with the switch and the export; and the stylesheet that carries the size the shell lays the Eraser layer out with (ZAP_PANEL).

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { frenchSpaces } from '@shared/french-typography'
import { ZAP_PANEL } from '@shared/boost'
import { NEUTRAL_TINT, type Boost } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import css from './boosts-editor.css?raw'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => ({}), useSnapshot: () => holder.snapshot }))

import { BoostEditor, CodeView } from './BoostEditor'

const boost = (id: string, name: string, enabled = true): Boost => ({ id, name, host: 'exemple.fr', enabled, css: '', js: '', zoom: 1, zap: [], tint: NEUTRAL_TINT })

function render(options: { boosts?: Boost[]; sharing?: boolean; id?: string } = {}): string {
  const state = createInitialState({ now: 1, newId: () => 'x' })
  holder.snapshot = { state: { ...state, boosts: options.boosts ?? [], settings: { ...state.settings, boostSharing: options.sharing ?? true } } }
  return renderToStaticMarkup(createElement(BoostEditor, { host: 'www.exemple.fr', ...(options.id ? { id: options.id } : {}) }))
}

beforeEach(() => setLanguage('fr'))

describe('the Tweak editor', () => {
  it('opens on Style with a Code tab, the name of the Tweak, and the switch of the Tweak on its site', () => {
    const html = render()
    expect(html).toMatch(/role="tab" aria-selected="true" tabindex="0" class="on">Style</)
    expect(html).toMatch(/role="tab" aria-selected="false" tabindex="-1" class="" title="[^"]*">Code</)
    expect(html).toContain('Ma Retouche')
    expect(html).toMatch(/role="switch"[^>]*aria-label="Retouche active sur exemple.fr"/)
    expect(html).toContain('checked=""')
  })

  it('keeps the strip of the Tweaks of the site: one chip for each, the open one marked, and one to start another', () => {
    const html = render({ boosts: [boost('a', 'Lecture sombre'), boost('b', 'Zoom')], id: 'b' })
    expect(html).toContain('aria-label="Retouches de ce site"')
    expect(html).toMatch(/aria-current="true"[^>]*disabled=""[^>]*>Zoom</)
    expect(html).toContain('Lecture sombre')
    expect(html).toContain('+ Nouvelle Retouche')
  })

  it('offers the export in its foot only when sharing is on, and not before there is something to send', () => {
    expect(render({ sharing: false })).not.toContain('Exporter…')
    expect(render({ sharing: true })).toMatch(/<button class="bx-export" disabled="">Exporter…<\/button>/)
    expect(render({ sharing: true, boosts: [boost('a', 'Lecture sombre')], id: 'a' })).toMatch(/<button class="bx-export">Exporter…<\/button>/)
  })

  it('shows a Tweak that is off with its switch off', () => {
    const html = render({ boosts: [boost('a', 'Lecture sombre', false)], id: 'a' })
    expect(html).not.toContain('checked=""')
  })

  it('says under the code how to leave the field, where Tab indents: the field points at that line', () => {
    const noop = (): void => undefined
    const draft = { name: 'Ma Retouche', enabled: true, css: '', js: '', zoom: 1, zap: [], tint: NEUTRAL_TINT }
    for (const view of ['css', 'js'] as const) {
      const html = renderToStaticMarkup(createElement(CodeView, { view, draft, savedJs: '', previewNote: null, onView: noop, onEdit: noop, onSaveScript: noop, onPreview: noop, onZap: noop, onDevTools: noop }))
      const described = /<textarea[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1]
      expect(described, view).toBeTruthy()
      expect(html).toContain(`<p id="${described}" class="bx-keys">${frenchSpaces('Tab ajoute deux espaces ; ⇧Tab sort du champ, Échap revient à Style.')}</p>`)
    }
  })

  it('gives the cross that deletes a Tweak of the site a target of 24 px that does not overlap the chip it sits beside', () => {
    const rule = /\n\.bx-site-x \{([^}]*)\}/.exec(css)?.[1] ?? ''
    const length = (name: string): number => Number(new RegExp(`(?:^|;)\\s*${name}:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(rule)?.[1] ?? NaN)
    expect(length('width')).toBeGreaterThanOrEqual(24)
    expect(length('height')).toBeGreaterThanOrEqual(24)
    expect(rule).not.toMatch(/margin[^;]*-\d/)
  })

  it('has a stylesheet with the width and the height the shell gives the zap layer', () => {
    expect(css).toContain(`width: ${ZAP_PANEL.width}px; height: ${ZAP_PANEL.height}px;`)
    expect(css).toContain(`max-height: ${ZAP_PANEL.height}px; max-width: none;`)
  })
})
