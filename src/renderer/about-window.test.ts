// The About window drawn to markup with the real component: what it promises, with the four links of the About group and the notes that say nothing is sent.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ABOUT_ROWS } from '@shared/about'
import { setLanguage } from '@shared/i18n'

vi.mock('./api', () => ({ api: () => ({ aboutVersion: () => new Promise(() => undefined), aboutEngine: () => new Promise(() => undefined) }) }))

import { AboutWindow } from './AboutWindow'
import { frenchSpaces } from '@shared/french-typography'

describe('the About window', () => {
  it('names the application, offers to copy the version and to look for updates, says it follows the setting, and carries the four links of the About group', () => {
    setLanguage('fr')
    const html = renderToStaticMarkup(createElement(AboutWindow))
    expect(html).toContain('<h1>Lucium</h1>')
    // The logo (the default version, Clair), not a glyph drawn in the page.
    expect(html).toMatch(/<img src="[^"]*app-icons\/clair\.png" alt="" width="80" height="80"/)
    expect(html).not.toContain('<svg')
    expect(html).toContain('aria-label="Copier la version et le moteur"')
    expect(html).toContain('Rechercher les mises à jour')
    // The button looks on demand, whatever the switch of the background look says.
    expect(html).toContain(frenchSpaces('Ce bouton vérifie tout de suite, que « Rechercher les mises à jour automatiquement » soit activé ou non.'))
    expect(html).toContain('Rien n’est envoyé à ConsilioWeb')
    expect(html).toContain('© 2026 les contributeurs de Lucium — un projet de ConsilioWeb')
    for (const row of ABOUT_ROWS) expect(html).toContain(`aria-label="${row.label} (${row.detail})"`)
    // Nothing to copy before the main process has answered.
    expect(html).toMatch(/<button type="button" class="about-btn quiet" disabled=""/)
  })
})
