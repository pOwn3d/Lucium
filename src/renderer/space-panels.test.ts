// The panels of the spaces (new space, customise, manage, theme, icon), rendered to markup with the real components and a state of four spaces (no window, as templates.test.ts does):
// what a person would find on screen. What each panel promises is measured here: the foot says why "Créer l'espace" is off, the emoji are all there in their
// categories, every button has a name, a space waiting for its deletion is not listed, and the theme list has no page and no empty place.

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setKeyPlatform, setLanguage } from '@shared/i18n'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { ALL_EMOJIS, emojiCategories } from '@shared/space-emoji'
import { snapshotOf } from '@shared/space-customize'
import { LETTER_COLORS, type SpaceIconChoice } from '@shared/space-icon'
import { READY_THEMES } from '@shared/theme-presets'
import { NAMED_COLORS } from '@shared/theme-colors'

const holder = vi.hoisted(() => ({ snapshot: null as unknown }))
vi.mock('./api', () => ({ api: () => ({}), useSnapshot: () => holder.snapshot }))

import { IconPicker } from './IconPicker'
import { SpacesPanel } from './ManagePanels'
import { SpaceCreate } from './SpaceCreate'
import { SpaceCustomize, sectionToggle, type Section } from './SpaceCustomize'
import { SpaceMark } from './SpaceMark'
import { ThemeEditor } from './ThemeEditor'
import { frenchSpaces } from '@shared/french-typography'

let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** Travail (on screen, 3 tabs), Perso (put aside), Études (2 tabs), Client ACME (letters, 4 tabs). */
function fixture() {
  let state = createInitialState(ctx)
  const work = state.spaces[0]!.id
  state = run(state, { type: 'space/update', id: work, patch: { name: 'Travail', emoji: '💼' } }, { type: 'space/create', name: 'Perso', emoji: '🏡', hue: 100 }, { type: 'space/create', name: 'Études', emoji: '📚', hue: 150 }, { type: 'space/create', name: 'Client ACME', emoji: '🚀', hue: 200, letterIcon: { letter: 'ac', color: LETTER_COLORS[7]!, round: true } })
  const [, perso, study, acme] = state.spaces.map((s) => s.id) as [string, string, string, string]
  state = run(state, { type: 'space/select', id: work })
  for (const [id, count] of [[work, 3], [study, 2], [acme, 4]] as const) for (let i = 0; i < count; i++) state = run(state, { type: 'tab/open', url: `https://${id}-${i}.example/`, spaceId: id, background: true })
  state = run(state, { type: 'space/aside', id: perso })
  return { state, work, perso, study, acme }
}

const render = (state: SidebarState, node: ReturnType<typeof createElement>): string => {
  holder.snapshot = { state }
  return renderToStaticMarkup(node)
}

/** Every button of a markup has a name: its text, or an aria-label. */
function unnamedButtons(markup: string): string[] {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attrs, inner]) => !/aria-label="[^"]+"/.test(attrs!) && inner!.replace(/<[^>]*>/g, '').trim() === '')
    .map(([whole]) => whole.slice(0, 90))
}

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), localStorage: { getItem: () => JSON.stringify(['🏡', '🚀']), setItem: () => undefined } })
})
afterEach(() => {
  vi.unstubAllGlobals()
  setLanguage('fr')
})

describe('"Nouvel espace"', () => {
  const sheet = (state = fixture().state) => render(state, createElement(SpaceCreate))

  it('is one dialog named "Nouvel espace", with a preview, a name, an icon row, ten named colours and the profile', () => {
    const markup = sheet()
    expect(markup).toMatch(/role="dialog"[^>]*aria-modal="true"/)
    expect(markup).toContain('>Nouvel espace</h2>')
    expect(markup).toContain('spacecreate-preview')
    expect(markup).toContain('placeholder="Clients, Veille, Vacances…"')
    for (const color of NAMED_COLORS) expect(markup).toContain(`aria-label="${color.name()}"`)
    expect(markup).toContain('Un profil sépare les cookies et les sessions')
    expect(markup).toContain('Tous les émojis…')
    // The old grid of 24 emoji and its 18 anonymous colours are gone.
    expect(markup).not.toContain('emoji-grid')
    expect(markup).not.toContain('Couleur #')
    expect(unnamedButtons(markup)).toEqual([])
  })

  it('has "Créer l’espace" off with no name, and says why in the foot', () => {
    const markup = sheet()
    expect(markup).toMatch(/<button type="submit" class="tk-btn primary"[^>]*disabled=""[^>]*>Créer l’espace<\/button>/)
    expect(markup).toContain('Donnez un nom pour créer')
    expect(markup).not.toContain('⌘↩</kbd> créer')
  })

  it('proposes eight icons, the first of them the one the space starts with', () => {
    const markup = sheet()
    const row = /class="sc-emoji"[^>]*>([\s\S]*?)<\/div>/.exec(markup)![1]!
    expect([...row.matchAll(/<button/g)]).toHaveLength(8)
    expect(row).toMatch(/aria-pressed="true">[^<]+<\/button>/)
  })

  it('opens with the colour automatic, none of the ten ringed', () => {
    const markup = sheet()
    expect(markup).toContain('Automatique')
    expect(markup).not.toMatch(/spacecreate-swatch[^>]*aria-pressed="true"/)
  })

  it('reads in English when the interface does', () => {
    setLanguage('en')
    const markup = sheet()
    expect(markup).toContain('Give it a name to create it')
    expect(markup).toContain('>Create Space</button>')
    expect(markup).toContain('aria-label="Blue"')
  })
})

describe('"Personnaliser l’espace"', () => {
  const f = fixture()
  const panel = (id: string, focus?: 'name' | 'icon' | 'profile' | 'color') => render(f.state, createElement(SpaceCustomize, { spaceId: id, focus }))

  it('follows a section the browser opens, although React runs the update once the event has lost its target', () => {
    const event: { currentTarget: { open: boolean } | null } = { currentTarget: { open: true } }
    let update: ((was: Record<Section, boolean>) => Record<Section, boolean>) | null = null
    sectionToggle((u) => { update = u }, 'icon')(event as { currentTarget: { open: boolean } })
    // React clears `currentTarget` as soon as the handler returns; the update is applied later, while it renders.
    event.currentTarget = null
    expect(update!({ color: true, icon: false, profile: false })).toEqual({ color: true, icon: true, profile: false })
  })

  it('keeps the very same state when the browser says what the panel already shows (no needless draw)', () => {
    let update: ((was: Record<Section, boolean>) => Record<Section, boolean>) | null = null
    sectionToggle((u) => { update = u }, 'color')({ currentTarget: { open: true } })
    const was = { color: true, icon: false, profile: false }
    expect(update!(was)).toBe(was)
  })

  it('is one panel for the icon, the name, the colour and the profile, with the media control next to the colour settings', () => {
    const markup = panel(f.work)
    expect(markup).toContain('>Personnaliser l’espace</h2>')
    expect(markup).toContain('value="Travail"')
    for (const title of ['Couleur et apparence', 'Icône', 'Profil']) expect(markup).toContain(`${title}<span class="sc-status">`)
    expect(markup).toContain('Arrière-plan média')
    expect(markup).toContain('Couleurs avancées et thèmes prêts…')
    expect((markup.match(/<details/g) ?? []).length).toBe(3)
    expect(markup).toContain('>Mettre de côté</button>')
    expect(markup).toContain('Supprimer…</button>')
    expect(unnamedButtons(markup)).toEqual([])
  })

  it('says where the space stands before a section is opened', () => {
    const markup = panel(f.acme)
    expect(markup).toMatch(/Icône<span class="sc-status">Lettre<\/span>/)
    expect(markup).toMatch(/Profil<span class="sc-status">Profil par défaut · 4 onglets<\/span>/)
    expect(markup).toMatch(/Couleur et apparence<span class="sc-status">Personnalisée · automatique<\/span>/)
    expect(panel(f.study)).toMatch(/Profil<span class="sc-status">Profil par défaut · 2 onglets<\/span>/)
  })

  it('does not offer "Rétablir" before anything has changed, and has one "Terminé", the one primary button', () => {
    const markup = panel(f.work)
    expect(markup).not.toContain('Rétablir')
    expect((markup.match(/class="tk-btn primary"/g) ?? []).length).toBe(1)
    expect(markup).toContain('>Terminé</button>')
  })

  it('offers "Rétablir" once something has changed since the panel opened, and "Terminé" stays the one primary button', () => {
    const opened = snapshotOf(f.state.spaces.find((s) => s.id === f.work)!)
    const later = run(f.state, { type: 'space/update', id: f.work, patch: { name: 'Pro', theme: { appearance: 'dark' } } })
    const markup = render(later, createElement(SpaceCustomize, { spaceId: f.work, openedAs: opened }))
    expect(markup).toContain('>Rétablir</button>')
    expect((markup.match(/class="tk-btn primary"/g) ?? []).length).toBe(1)
    // …and says so again in English.
    setLanguage('en')
    expect(render(later, createElement(SpaceCustomize, { spaceId: f.work, openedAs: opened }))).toContain('>Revert</button>')
  })

  it('has the one section it is asked for open: the colours by default, the icons, or the profile', () => {
    expect(panel(f.work, 'name')).toMatch(/<details class="sc-sec" open="">\s*<summary>[^]*?Couleur et apparence/)
    expect(panel(f.work, 'icon')).toMatch(/<details class="sc-sec">\s*<summary>[^]*?Couleur et apparence[^]*?<details class="sc-sec" open="">\s*<summary>[^]*?Icône/)
    expect(panel(f.work, 'profile')).toMatch(/<details class="sc-sec" open="">\s*<summary>[^]*?Profil/)
  })

  it('shows the archive refusal as the reason of its button: a space that cannot be put aside says why', () => {
    const only = createInitialState(ctx)
    const markup = render(only, createElement(SpaceCustomize, { spaceId: only.spaces[0]!.id }))
    expect(markup).toMatch(/<button type="button" class="tk-btn quiet" disabled="" title="Il faut garder au moins un espace[^"]*">Mettre de côté<\/button>/)
    expect(markup).toMatch(/class="tk-btn quiet danger" disabled="" title="Le dernier espace ne peut pas être supprimé\.">Supprimer…/)
  })
})

describe('"Gérer les espaces"', () => {
  const f = fixture()
  const panel = (state = f.state) => render(state, createElement(SpacesPanel))

  it('is a list panel: the spaces in the order of the sidebar, then the archived ones under their own title', () => {
    const markup = panel()
    expect(markup).toContain('>Gérer les espaces<span class="lp-count">3 espaces · 9 onglets · 1 mis de côté</span>')
    const names = [...markup.matchAll(/<span class="lp-title">([^<]+)<\/span>/g)].map((m) => m[1])
    expect(names).toEqual(['Travail', 'Études', 'Client ACME', 'Perso'])
    expect(markup).toContain('<h3>Mis de côté</h3>')
    expect(markup).toContain('Rouvrir')
    expect(markup.indexOf('<h3>Mis de côté</h3>')).toBeGreaterThan(markup.indexOf('Client ACME'))
  })

  it('marks the space on screen, and gives each row a grip, its profile and its tabs', () => {
    const markup = panel()
    expect(markup).toContain('<span class="sm-chip current">Actuel</span>')
    expect((markup.match(/class="sm-grip"/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(markup).toContain('2 onglets')
    expect(markup).toContain('4 onglets')
    expect(markup).toContain('0 onglet')
  })

  it('draws a space that wears letters by its letters', () => {
    expect(panel()).toMatch(/space-letter manage round"[^>]*aria-hidden="true">AC</)
  })

  // With windows of their own: the snapshot tells the tabs of every window, which deleting or putting a space aside closes too.
  it('counts the tabs of every window that the snapshot gives, not only the window\'s own', () => {
    holder.snapshot = { state: f.state, spaceTabs: { [f.work]: 5, [f.study]: 2, [f.acme]: 6 } }
    const markup = renderToStaticMarkup(createElement(SpacesPanel))
    expect(markup).toContain('<span class="lp-count">3 espaces · 13 onglets · 1 mis de côté</span>')
    expect(markup).toContain('5 onglets')
    expect(markup).toContain('6 onglets')
  })

  it('names every button of every row after the space, in French and in English', () => {
    const markup = panel()
    expect(unnamedButtons(markup)).toEqual([])
    for (const label of [frenchSpaces('Monter « Études »'), frenchSpaces('Descendre « Études »'), frenchSpaces('Personnaliser « Études »'), frenchSpaces('Mettre « Études » de côté'), frenchSpaces('Supprimer « Études »'), frenchSpaces('Supprimer « Perso »')]) expect(markup, label).toContain(`aria-label="${label}"`)
    setLanguage('en')
    expect(panel()).toContain('aria-label="Move “Études” up"')
  })

  it('cannot move the first space up or the last down, and cannot delete or archive the only space', () => {
    const markup = panel()
    expect(markup).toMatch(/aria-label="Monter «\u00a0Travail\u00a0»"[^>]*disabled=""|disabled=""[^>]*aria-label="Monter «\u00a0Travail\u00a0»"/)
    expect(markup).toMatch(/aria-label="Descendre «\u00a0Client ACME\u00a0»"[^>]*disabled=""|disabled=""[^>]*aria-label="Descendre «\u00a0Client ACME\u00a0»"/)
    const only = createInitialState(ctx)
    const alone = panel(only)
    expect(alone).toMatch(/aria-label="Supprimer «\u00a0[^»]+\u00a0»"[^>]*disabled=""|disabled=""[^>]*aria-label="Supprimer «\u00a0[^»]+\u00a0»"/)
    expect(alone).toContain('Le dernier espace ne peut pas être supprimé.')
    expect(alone).not.toContain('<h3>Mis de côté</h3>')
  })

  it('says how to reorder: drag a row, or ⌥↑ ⌥↓', () => {
    expect(panel()).toContain('Glissez une ligne, ou ⌥↑ ⌥↓, pour changer l’ordre de la barre latérale.')
    expect(panel()).toContain('draggable="true"')
  })
})

describe('the theme panel', () => {
  const f = fixture()
  const panel = (from?: 'space') => render(f.state, createElement(ThemeEditor, { spaceId: f.work, from }))

  it('lists every ready theme once, by dark and light, with no page, no arrow and no empty place', () => {
    const markup = panel()
    expect(markup).toContain('<h3 class="tp-group">Sombres</h3>')
    expect(markup).toContain('<h3 class="tp-group">Clairs</h3>')
    for (const theme of READY_THEMES) expect(markup, theme.name).toContain(`<span>${theme.name}</span>`)
    expect((markup.match(/class="tp-theme"/g) ?? []).length).toBeGreaterThanOrEqual(READY_THEMES.length)
    expect(markup).not.toMatch(/preset-arrow|ready-arrow|‹|›/)
    expect(markup).not.toContain('class="ready-theme')
    expect(markup).not.toContain('class="preset"')
  })

  it('draws the sidebar that takes the theme under the pointer, beside the list', () => {
    const markup = panel()
    expect(markup).toContain('class="sb-thumb tp-thumb"')
    expect(markup).toContain('aria-label="Aperçu de la barre latérale"')
    expect(markup).toContain(frenchSpaces('Survolez ou parcourez : l’aperçu prend le thème avant le clic.'))
  })

  it('lets the theme panel replace the theme with an image or a video background', () => {
    const markup = panel()
    expect(markup).toContain('Arrière-plan média')
  })

  it('keeps the advanced controls: the pad, the harmony, the codes', () => {
    const markup = panel()
    expect(markup).toContain('Contrôles de couleur avancés')
    for (const text of ['Pavé de couleurs', 'Harmonie', 'Code couleur', 'Code du thème', 'Translucidité', 'Couleurs vives', 'Direction du dégradé']) expect(markup, text).toContain(text)
  })

  it('offers the colour to start from by name, the hue, the strength and the texture', () => {
    const markup = panel()
    for (const color of NAMED_COLORS) expect(markup).toContain(`aria-label="${color.name()}"`)
    for (const text of ['Teinte', 'Intensité', 'Texture', 'Couleur de départ']) expect(markup, text).toContain(text)
    for (const label of ['Aucune', 'Grain', 'Fine', 'Grossière']) expect(markup, label).toContain(`>${label}</option>`)
  })

  it('has one primary button, "Terminé", and says what Escape does', () => {
    const markup = panel()
    expect((markup.match(/class="tk-btn primary"/g) ?? []).length).toBe(1)
    expect(markup).toContain(frenchSpaces('Échap annule les changements, « Terminé » les garde.'))
    expect(markup).toContain('>Réinitialiser</button>')
    expect(unnamedButtons(markup)).toEqual([])
  })

  it('offers the way back to "Personnaliser l’espace" only when that panel opened it', () => {
    expect(panel()).not.toContain('Retour à Personnaliser l’espace')
    expect(panel('space')).toContain('aria-label="Retour à Personnaliser l’espace"')
  })

  it('lists the themes of the other spaces under "Mes thèmes"', () => {
    expect(panel()).toContain('<h3 class="tp-group">Mes thèmes</h3>')
    expect(panel()).toContain('<span>Études</span>')
  })
})

describe('the icon picker', () => {
  const choice: SpaceIconChoice = { kind: 'emoji', emoji: '🚀', letter: 'CA', color: LETTER_COLORS[0]!, round: false }
  const picker = (over: Partial<SpaceIconChoice> = {}, picture = {}) => renderToStaticMarkup(createElement(IconPicker, { choice: { ...choice, ...over }, onChange: () => undefined, picture: { onPick: () => undefined, onClear: () => undefined, ...picture } }))

  it('holds the whole catalogue, in its nine categories, with the recent ones first', () => {
    const markup = picker()
    expect((markup.match(/<section>/g) ?? []).length).toBe(9)
    for (const category of emojiCategories()) expect(markup, category.label).toContain(`>${category.label}</h3>`)
    const grids = [...markup.matchAll(/class="ip-grid"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => (m[1]!.match(/<button/g) ?? []).length)
    expect(grids.reduce((a, b) => a + b, 0)).toBe(ALL_EMOJIS.length)
    expect(ALL_EMOJIS.length).toBeGreaterThanOrEqual(600)
    expect(markup).toContain('Récents')
    expect(markup.indexOf('Récents')).toBeLessThan(markup.indexOf('class="ip-scroll"'))
  })

  it('has the type as a segment of three, the search, and a way in with the keyboard: one cell of the grid is reachable by Tab', () => {
    const markup = picker()
    for (const label of ['Émoji', 'Lettre', 'Image']) expect(markup).toContain(`>${label}</button>`)
    expect(markup).toContain('type="search"')
    expect((markup.match(/class="ip-grid"[\s\S]*?<\/div>/g) ?? []).join('').match(/tabindex="0"/g)).toHaveLength(1)
    // The keys of the types are the ones of the system the window runs on, told to the texts with the snapshot: none is drawn before.
    expect(markup).not.toContain('ip-keys')
    setKeyPlatform('darwin')
    try {
      expect(picker()).toContain('⌘1')
      setKeyPlatform('linux')
      expect(picker()).toContain('Ctrl+1')
      expect(picker()).not.toContain('⌘')
    } finally {
      setKeyPlatform(undefined)
    }
  })

  it('shows the emoji of the space as chosen', () => {
    expect(picker()).toMatch(/aria-pressed="true"[^>]*>🚀<\/button>/)
  })

  it('shows the letters, the shape and the eight colours when the space wears letters', () => {
    const markup = picker({ kind: 'letter', letter: 'AC', round: true, color: LETTER_COLORS[2]! })
    expect(markup).toContain('value="AC"')
    expect((markup.match(/aria-label="(Bleu|Corail|Orange|Vert|Lavande|Turquoise|Rose|Nuit)"/g) ?? []).length).toBe(8)
    expect(markup).toContain(`style="background:${LETTER_COLORS[2]}"`)
    expect(markup).toMatch(/aria-pressed="true">Rond<\/button>/)
    expect(markup).toContain('space-letter ip-big round')
  })

  it('offers the picture without any setting, and says why it cannot when the space does not exist yet', () => {
    const open = picker({ kind: 'image' }, {})
    expect(open).toContain('Choisir une image…')
    expect(open).not.toContain('aria-disabled')
    const reason = 'Une image se choisit une fois l’espace créé.'
    expect(picker({}, { reason })).toContain('aria-disabled="true"')
  })

  it('shows the picture of a space that has one, with the way to change or remove it', () => {
    const markup = picker({ kind: 'image' }, { name: '0123456789abcdef01234567.png' })
    expect(markup).toContain('Choisir une autre image…')
    expect(markup).toContain('Retirer l’image')
  })

  it('starts with no recent emoji, and says so in the log, when the storage of the window cannot be read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
      const markup = picker()
      expect(markup).not.toContain('Récents')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('[icon picker]')
    } finally {
      warn.mockRestore()
    }
  })

  it('names every button, and every colour', () => {
    expect(unnamedButtons(picker())).toEqual([])
    expect(unnamedButtons(picker({ kind: 'letter' }))).toEqual([])
  })
})

describe('what stands for a space', () => {
  const mark = (space: Parameters<typeof SpaceMark>[0]['space']) => renderToStaticMarkup(createElement(SpaceMark, { space, className: 'header' }))

  it('is the emoji, the coloured letters, or the picture, as the space chose', () => {
    expect(mark({ emoji: '🚀' })).toBe('🚀')
    expect(mark({ emoji: '🚀', iconKind: 'letter', iconLetter: 'AC', iconColor: '#1a7f48', iconRound: true })).toBe('<span class="space-letter header round" style="background:#1a7f48" aria-hidden="true">AC</span>')
    expect(mark({ emoji: '🚀', iconKind: 'letter', iconLetter: 'AC' })).toContain(`background:${LETTER_COLORS[0]}`)
  })

  it('shows the emoji for a kind it has nothing to draw for, instead of an empty box', () => {
    expect(mark({ emoji: '🚀', iconKind: 'letter' })).toBe('🚀')
    expect(mark({ emoji: '🚀', iconKind: 'image' })).toBe('🚀')
  })

  it('puts nothing hostile into the style: a colour that is not #rrggbb is not drawn', () => {
    const drawn = mark({ emoji: '🚀', iconKind: 'letter', iconLetter: 'AC', iconColor: 'red;background:url(https://evil.example/x)' })
    expect(drawn).not.toContain('evil')
    expect(drawn).toContain(`background:${LETTER_COLORS[0]}`)
  })
})
