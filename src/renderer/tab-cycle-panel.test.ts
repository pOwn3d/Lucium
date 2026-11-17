// The panel of ⌃Tab, drawn to markup with the real component: what a person reads on it, and that the stylesheet carries the sizes the shell lays the layer out with
// (CYCLE_PANEL): if the two drift apart the cards are cut off or float in an empty panel.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { CYCLE_PANEL, type CycleCard } from '@shared/tab-cycle'
import css from './tab-cycle.css?raw'

vi.mock('./api', () => ({ api: () => ({ onCycleIndex: () => () => undefined }) }))

import { TabCycle } from './TabCycle'

const member = (id: string, title: string, host: string) => ({ id, title, host, thumb: null })
const cards: CycleCard[] = [
  { id: 'a', members: [member('a', 'Tableau de bord', 'tableau.exemple.fr')] },
  { id: 'b', members: [member('b', 'Documentation du projet', 'docs.exemple.fr'), member('c', 'Notes de réunion', 'docs.exemple.fr')], orientation: 'horizontal' },
  { id: 'd', members: [member('d', 'Galerie photo', 'galerie.exemple.fr')] }
]

describe('the panel of ⌃Tab', () => {
  it('says what it is, how many tabs, where the selection is, how to leave, and the site under each title', () => {
    setLanguage('fr')
    const html = renderToStaticMarkup(createElement(TabCycle, { cards, index: 1 }))
    expect(html).toContain('3 onglets')
    expect(html).toContain('2 / 3')
    expect(html).toContain('Échap pour annuler')
    expect(html).toContain('tableau.exemple.fr')
    expect(html).toContain('galerie.exemple.fr')
    // A split view is one card with its two titles and the words "Vue scindée" where a single tab has its site.
    expect(html).toContain('Vue scindée')
    expect(html).toContain('Notes de réunion')
    expect(html.match(/role="option"/g)).toHaveLength(3)
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
  })

  it('has a stylesheet that adds up to the size the shell gives the layer', () => {
    const { head, foot, padding, gap, card, height } = CYCLE_PANEL
    expect(css).toContain(`grid-template-rows: ${head}px minmax(0, 1fr) ${foot}px`)
    expect(css).toContain(`.tc-card { flex: none; width: ${card.width}px; height: ${card.height}px;`)
    expect(css).toContain(`gap: ${gap}px; padding: ${padding}px; overflow-x: auto`)
    expect(head + card.height + padding * 2 + foot).toBe(height)
  })
})
