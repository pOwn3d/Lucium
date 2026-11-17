// The contrast of three surfaces a person sees all day, measured on what the stylesheets declare: the site control center and the downloads popover
// (two dark cards whose fill is computed from the page behind them), and the main button of the first-launch guide; then what is written on the
// background of a space whatever its colour (the sidebar, the empty page, the layout bar of a split view, the mini window), and the address of a
// private window. WCAG 2.2 AA: 4.5:1 for text, 3:1 for glyphs (1.4.3 and 1.4.11). The colours are read from the rules themselves and worked out with the tokens, so a rule that goes back to a
// paler token, to a lighter fill or to a colour written in place fails here. The toolbar tinted by the page is measured in shared/theme.test.ts.

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import commandBarCss from './command-bar.css?raw'
import firstLaunchCss from './first-launch.css?raw'
import littleCss from './little.css?raw'
import notesCss from './notes.css?raw'
import paletteCss from './palette.css?raw'
import popoversCss from './popovers.css?raw'
import settingsCss from './settings.css?raw'
import shortcutHelpCss from './shortcut-help.css?raw'
import sidebarCss from './sidebar.css?raw'
import sitePanelCss from './site-panel.css?raw'
import splitBarCss from './split-bar.css?raw'
import stylesCss from './styles.css?raw'
import themeEditorCss from './theme-editor.css?raw'
import tokensCss from './tokens.css?raw'
import toolbarCss from './toolbar.css?raw'
import { popoverSurface } from '@shared/command-bar'
import { AA_CONTROL, AA_TEXT, compositeOver, contrastRatio, parseColor, relativeLuminance, type Rgba } from '@shared/contrast'
import { colorOf, tokenValues, type Preference, type Scheme } from '@shared/design-tokens'
import { privateTheme } from '@shared/private-window'
import { presetTheme } from '@shared/space-creation'
import { backgroundColors, cleanTheme, colorAtPadPoint, defaultTheme, hexToHsl, themeHue, themeVars, type SpaceTheme } from '@shared/theme'
import { NAMED_COLORS } from '@shared/theme-colors'

// Every test of this file that sweeps works the tokens out at hundreds of hues, in two appearances and three settings of contrast: up to a second of
// processor each, which a machine with every core taken stretches past the 5 s a test has by default.
vi.setConfig({ testTimeout: 30_000 })

/** What a function of one text gave, kept by that text: the sweeps below ask the same sheets the same thing at hundreds of hues. */
function once<T>(work: (css: string) => T): (css: string) => T {
  const known = new Map<string, T>()
  return (css) => {
    if (!known.has(css)) known.set(css, work(css))
    return known.get(css)!
  }
}

/** What a stylesheet declares, by selector then by property: the last rule wins, as in the cascade of one file. */
const declarationsOf = once((css: string): Map<string, Map<string, string>> => {
  const bySelector = new Map<string, Map<string, string>>()
  for (const [, selectors, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations: Array<[string, string]> = []
    for (const declaration of body!.split(';')) {
      const colon = declaration.indexOf(':')
      if (colon > 0) declarations.push([declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()])
    }
    // The commas that separate the selectors of a rule, not the ones inside `:is(.a, .b)`.
    for (const one of selectors!.split(/,(?![^()]*\))/)) {
      const selector = one.trim()
      const known = bySelector.get(selector) ?? new Map<string, string>()
      for (const [property, value] of declarations) known.set(property, value)
      bySelector.set(selector, known)
    }
  }
  return bySelector
})

/** What a stylesheet declares for a property under exactly this selector; null when it declares none. */
function declaredOrNone(css: string, selector: string, property: string): string | null {
  return declarationsOf(css).get(selector)?.get(property) ?? null
}

/** The same for a declaration that must be there: a rule that was renamed or lost fails the test instead of being skipped. */
function declared(css: string, selector: string, property: string): string {
  const found = declaredOrNone(css, selector, property)
  if (found === null) throw new Error(`no ${property} under ${selector}`)
  return found
}

/** The tokens of a context, worked out once for a sheet of tokens: a sweep and the sweeps that prove it measure the same contexts against several sheets. */
const workedTokens = new Map<string, Map<string, Map<string, string>>>()
function tokensAt(tokens: string, scheme: Scheme, hue: number, contrast: Preference): Map<string, string> {
  const ofSheet = workedTokens.get(tokens) ?? new Map<string, Map<string, string>>()
  workedTokens.set(tokens, ofSheet)
  const key = `${scheme} ${hue} ${contrast}`
  const known = ofSheet.get(key)
  if (known) return known
  const worked = tokenValues(tokens, { scheme, hue, contrast })
  ofSheet.set(key, worked)
  return worked
}

const CONTRASTS: readonly Preference[] = [false, true, 'forced']
const label = (contrast: Preference): string => (contrast ? ` +contrast ${contrast}` : '')

// ---------- the two cards over a page ----------

/** The pages behind a card: white (a page that declares no colour, the lightest card), light greys, brand colours, a dark page. */
const PAGES = ['#ffffff', '#f0f0f0', '#c0c0c0', '#808080', '#ffe600', '#1da1f2', '#ff0000', '#25d366', '#212225', '#000000']
/** Every hue a space can have changes the accent: the ten named colours, and the wheel every 5 degrees. */
const HUES = [...new Set([...NAMED_COLORS.map((color) => Math.round(hexToHsl(color.hex).h)), ...Array.from({ length: 72 }, (_, i) => i * 5)])]

interface CardPart {
  name: string
  /** The stylesheet and the selector whose `color` is measured. */
  css: string
  selector: string
  /** An opacity declared by another rule, laid on the colour. */
  opacity?: { selector: string }
  min: number
  /** What the part sits on: the card, or a tile of the tokens laid over the card (a row under the pointer, a disc). */
  grounds: ReadonlyArray<'card' | '--tile' | '--tile-active'>
}

const scc = (selector: string): string => `body.overlay ${selector}`
const CARD_PARTS: readonly CardPart[] = [
  { name: 'state of a setting', css: sitePanelCss, selector: scc('.scc-setting-text span'), min: AA_TEXT, grounds: ['card'] },
  { name: 'name of a setting', css: sitePanelCss, selector: scc('.scc-setting-text strong'), min: AA_TEXT, grounds: ['card'] },
  { name: 'summary of a section', css: sitePanelCss, selector: scc('.scc-section-sum'), min: AA_TEXT, grounds: ['card', '--tile'] },
  { name: 'title of a section', css: sitePanelCss, selector: scc('.scc-section-head'), min: AA_TEXT, grounds: ['card', '--tile'] },
  { name: 'chevron of a section', css: sitePanelCss, selector: scc('.scc-section-chevron'), min: AA_CONTROL, grounds: ['card', '--tile'] },
  { name: 'buttons of a Tweak at rest', css: sitePanelCss, selector: scc('.scc-boost-action'), min: AA_CONTROL, grounds: ['card'] },
  { name: 'button of a Tweak under the pointer', css: sitePanelCss, selector: scc('.scc-boost-action:hover'), min: AA_CONTROL, grounds: ['--tile'] },
  { name: 'bin of a Tweak under the pointer or the focus', css: sitePanelCss, selector: scc('.scc-boost-action.scc-delete:hover'), min: AA_CONTROL, grounds: ['card', '--tile'] },
  { name: 'glyph of a setting that is off', css: sitePanelCss, selector: scc('.scc-badge'), min: AA_CONTROL, grounds: ['--tile-active'] },
  { name: 'link that forgets a permission', css: sitePanelCss, selector: scc('.scc-perm-forget'), min: AA_TEXT, grounds: ['card'] },
  { name: 'choice of a permission', css: sitePanelCss, selector: scc('.scc-perm-choice'), min: AA_TEXT, grounds: ['--tile'] },
  { name: 'connection', css: sitePanelCss, selector: scc('.scc-secure'), min: AA_TEXT, grounds: ['--tile'] },
  { name: 'status of a download', css: popoversCss, selector: '.dlpop .dlpop-status', min: AA_TEXT, grounds: ['card', '--tile'] },
  { name: 'no download', css: popoversCss, selector: '.dlpop .dlpop-empty', min: AA_TEXT, grounds: ['card'] },
  { name: 'name of a cancelled download', css: popoversCss, selector: '.dlpop .dlpop-row.cancelled .dlpop-name', min: AA_TEXT, grounds: ['card', '--tile'] },
  { name: 'icon of a download', css: popoversCss, selector: '.dlpop .dlpop-icon', min: AA_CONTROL, grounds: ['card', '--tile'] },
  { name: 'button of a download', css: popoversCss, selector: '.dlpop .dlpop-button', min: AA_CONTROL, grounds: ['card', '--tile'] }
]

/** The parts of the two cards under their minimum, for a stylesheet of tokens and a fill of the card. */
function cardFailures(parts: readonly CardPart[], fillOf: (page: string) => string, tokens = tokensCss): string[] {
  const lines: string[] = []
  // Both cards say `color-scheme: dark` (dark-glass-scheme.test.ts): their tokens are the dark ones whatever the appearance of the system.
  const scheme: Scheme = 'dark'
  for (const contrast of CONTRASTS) {
    for (const hue of HUES) {
      const values = tokensAt(tokens, scheme, hue, contrast)
      // The hue only moves the accent: the other pages are measured at one hue.
      for (const page of hue === 250 ? PAGES : ['#ffffff']) {
        const card = parseColor(fillOf(page))!
        for (const part of parts) {
          const ink = colorOf(values, declared(part.css, part.selector, 'color'), scheme)
          const opacity = part.opacity ? Number(declared(part.css, part.opacity.selector, 'opacity')) : 1
          for (const ground of part.grounds) {
            const under = ground === 'card' ? card : compositeOver(colorOf(values, `var(${ground})`, scheme), card)
            const ratio = contrastRatio({ ...ink, a: ink.a * opacity }, under)
            if (ratio < part.min) lines.push(`${part.name} on ${ground} over a ${page} page, hue ${hue}${label(contrast)}: ${ratio.toFixed(2)}:1, needs ${part.min}`)
          }
        }
      }
    }
  }
  return lines
}

describe('the site control center and the downloads popover, over any page', () => {
  const fill = (page: string): string => popoverSurface(page).fill

  it('read their text at 4.5:1 and their glyphs at 3:1, on the card and on a row under the pointer, at every hue, with "Increase contrast" on or off', () => {
    expect(cardFailures(CARD_PARTS, fill).slice(0, 8)).toEqual([])
  })

  it('read the main text at 4.5:1 on the buttons of the top row', () => {
    const text = colorOf(tokenValues(tokensCss, { scheme: 'dark', hue: 250 }), declared(sitePanelCss, scc('.scc-tile'), 'color'), 'dark')
    for (const page of PAGES) expect(contrastRatio(text, popoverSurface(page).tile), page).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('measure what they say: the lighter card, the help grey for a status and the fainter buttons each fail', () => {
    // The card as it was: black at 64 % over the page, #5c5c5c over a white one (secondary text at 3.5:1).
    const lighter = cardFailures(CARD_PARTS, () => '#5c5c5c').join('\n')
    expect(lighter).toContain('state of a setting on card over a #ffffff page')
    expect(lighter).toContain('link that forgets a permission on card')
    // The status of a download in the grey of the help text, as it was.
    const status = popoversCss.replace(/(\.dlpop \.dlpop-status \{[^}]*color:\s*)var\(--text-2\)/, '$1var(--text-3)')
    expect(status).not.toBe(popoversCss)
    const paler = cardFailures(CARD_PARTS.map((part) => (part.css === popoversCss ? { ...part, css: status } : part)), fill)
    expect(paler.length).toBeGreaterThan(0)
    for (const line of paler) expect(line).toMatch(/^status of a download/)
    // The buttons of a Tweak in the ink of a border.
    const faint = sitePanelCss.replace(/(\.scc-boost-action \{[^}]*color:\s*)var\(--text-2\)/, '$1var(--line-strong)')
    expect(faint).not.toBe(sitePanelCss)
    const fainter = cardFailures(CARD_PARTS.map((part) => (part.css === sitePanelCss ? { ...part, css: faint } : part)), fill)
    expect(fainter.length).toBeGreaterThan(0)
    for (const line of fainter) expect(line).toMatch(/^buttons of a Tweak at rest/)
  })
})

// ---------- the main button of the first-launch guide ----------

/** The ratios of the button under 4.5:1, at rest and under the pointer, for a stylesheet. */
function buttonFailures(css: string, hues: readonly number[]): string[] {
  const rest = '.first-launch-nav .btn.primary'
  const hover = '.first-launch-nav .btn.primary:hover:not(:disabled)'
  const lines: string[] = []
  for (const scheme of ['light', 'dark'] as const) {
    for (const contrast of CONTRASTS) {
      for (const hue of hues) {
        const values = tokensAt(tokensCss, scheme, hue, contrast)
        const sheet = colorOf(values, 'var(--surface)', scheme)
        const ink = colorOf(values, declared(css, rest, 'color'), scheme)
        const measure = (state: string, background: Rgba, opacity: number): void => {
          // An opacity fades the whole button into the sheet behind it: the ink and its ground both.
          const ground = compositeOver({ ...background, a: background.a * opacity }, sheet)
          const ratio = contrastRatio({ ...ink, a: ink.a * opacity }, ground)
          if (ratio < AA_TEXT) lines.push(`${state}, ${scheme} hue ${hue}${label(contrast)}: ${ratio.toFixed(2)}:1`)
        }
        measure('at rest', colorOf(values, declared(css, rest, 'background'), scheme), 1)
        // Under the pointer the button keeps what the hover rule does not set again, and is drawn plain unless that rule fades it.
        const background = declaredOrNone(css, hover, 'background') ?? declared(css, rest, 'background')
        const opacity = Number(declaredOrNone(css, hover, 'opacity') ?? 1)
        measure('under the pointer', colorOf(values, background, scheme), opacity)
      }
    }
  }
  return lines
}

describe('the main button of the first-launch guide', () => {
  /** Every half degree of the wheel, the ten named colours, the four colours the guide offers and the corners of the colour pad. */
  const chips = ['persimmon', 'bluegreen', 'deepviolet', 'sunburst'].map((name) => declared(firstLaunchCss, `.color-chip[data-color="${name}"]`, 'background'))
  const pad = [0, 0.25, 0.5, 0.75, 1].flatMap((x) => [0, 1].map((y) => colorAtPadPoint(x, y, 1)))
  const picked = [...NAMED_COLORS.map((color) => color.hex), ...chips, ...pad].map((hex) => Math.round(hexToHsl(hex).h))
  const hues = [...new Set([...picked, ...Array.from({ length: 720 }, (_, i) => i / 2)])]

  it('offers four colours and knows the ten named ones', () => {
    expect(chips).toHaveLength(4)
    expect(NAMED_COLORS).toHaveLength(10)
  })

  it('reads at 4.5:1 in the light and in the dark appearance, at every colour of a space, at rest and under the pointer', () => {
    expect(buttonFailures(firstLaunchCss, hues).slice(0, 8)).toEqual([])
  })

  it('measures what it says: white written in place fails in the dark appearance, and a button faded under the pointer fails too', () => {
    const white = firstLaunchCss.replace(/(\.first-launch-nav \.btn\.primary \{[^}]*color:\s*)var\(--on-accent\)/, '$1white')
    expect(white).not.toBe(firstLaunchCss)
    const lines = buttonFailures(white, hues)
    expect(lines.length).toBeGreaterThan(0)
    // The accent of the light appearance is dark enough for white at every hue: only the dark appearance fails.
    for (const line of lines) expect(line).toContain('dark hue')
    expect(lines.filter((line) => line.startsWith('at rest')).length).toBeGreaterThanOrEqual(hues.length)

    const faded = firstLaunchCss.replace(/(\.first-launch-nav \.btn\.primary:hover:not\(:disabled\) \{)[^}]*\}/, '$1 opacity: 0.9; }')
    expect(faded).not.toBe(firstLaunchCss)
    const hovered = buttonFailures(faded, hues)
    expect(hovered.length).toBeGreaterThan(0)
    for (const line of hovered) expect(line).toMatch(/^under the pointer/)
  })
})

// ---------- what is written on the background of a space ----------

/** The declarations of a stylesheet that are `!important`, alone, in their rules: they answer over what the window sets on the shell itself. */
const importantOnly = once((css: string): string =>
  css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{([^{}]*)\}/g, (_whole, body: string) => `{${body.split(';').filter((one) => one.includes('!important')).map((one) => one.replace('!important', '')).join(';')}}`))
const unflagged = once((css: string): string => css.replace(/\s*!important/g, ''))
/** A stylesheet without its `@media` blocks: what it declares when no preference of the system is on. */
const outsideMedia = once((css: string): string => {
  let out = ''
  let from = 0
  for (;;) {
    const start = css.indexOf('@media', from)
    if (start < 0) return out + css.slice(from)
    let depth = 0
    let end = css.indexOf('{', start)
    do depth += css[end] === '{' ? 1 : css[end] === '}' ? -1 : 0
    while (++end < css.length && depth > 0)
    out += css.slice(from, start)
    from = end
  }
})

/**
 * The custom properties of a window that draws a space, as the cascade leaves them on its shell: the tokens and the fixed palette, what the
 * sheets declare for `.shell` and `.la`, then what the window sets itself from the theme (shared/theme.ts), then what a sheet declares `!important`.
 */
function shellValues(theme: SpaceTheme, scheme: Scheme, contrast: Preference, sheets: readonly string[], inline: Record<string, string> = themeVars(theme, scheme)): Map<string, string> {
  const inlined = `.shell { ${Object.entries(inline).filter(([name]) => name !== '--bg-gradient' && name !== '--grain-image').map(([name, value]) => `${name}: ${value}`).join('; ')} }`
  // Each sheet is whole, and read once: only the few lines the window sets change from one theme to the next.
  return tokenValues([tokensCss, paletteCss, ...sheets.map(unflagged), inlined, ...sheets.map(importantOnly)], { scheme, hue: themeHue(theme), contrast })
}

interface SpacePart {
  name: string
  /** The CSS expression of the ink, read from the sheet. */
  ink: (scheme: Scheme) => string
  min: number
  /** What lies between the ink and the background of the space: nothing, or a wash read from the sheet. */
  wash?: (scheme: Scheme) => string
}

const color = (css: string, selector: string): string => declared(css, selector, 'color')
interface SpaceSheets {
  sidebar: string
  styles: string
  splitBar: string
  little: string
}

const spaceParts = (s: SpaceSheets): readonly SpacePart[] => [
  { name: 'title of a sleeping tab', ink: () => color(s.sidebar, '.sidebar .tab.asleep:not(.active):not(.selected) .tab-title'), min: AA_TEXT },
  { name: '« Aujourd’hui »', ink: () => color(s.sidebar, '.sidebar .today-head'), min: AA_TEXT },
  { name: 'title of a group of Today (« Onglets privés »)', ink: () => color(s.sidebar, '.sidebar .today-group'), min: AA_TEXT },
  { name: '« Nouvel onglet »', ink: () => color(s.sidebar, '.sidebar .new-tab'), min: AA_TEXT },
  { name: 'name of a favourite on its tile', ink: () => color(s.sidebar, '.sidebar .favorites.named .favorite-name'), min: AA_TEXT, wash: () => declared(s.sidebar, '.sidebar .favorite', 'background') },
  { name: 'note of a private window', ink: () => color(s.sidebar, '.sidebar .private-note'), min: AA_TEXT, wash: () => declared(s.sidebar, '.sidebar .private-note', 'background') },
  { name: 'text of the empty page', ink: () => color(s.styles, '.empty'), min: AA_TEXT },
  { name: 'layout bar of a split view', ink: () => color(s.splitBar, '.split-bar'), min: AA_TEXT, wash: (scheme) => (scheme === 'light' ? declared(s.splitBar, '.shell.light .split-bar', 'background') : declared(s.splitBar, '.split-bar', 'background')) },
  { name: 'button of the layout bar', ink: () => color(s.splitBar, '.sb-btn'), min: AA_TEXT, wash: (scheme) => (scheme === 'light' ? declared(s.splitBar, '.shell.light .split-bar', 'background') : declared(s.splitBar, '.split-bar', 'background')) },
  // The mini window is measured as it is with no preference of the system on (its variant for « Increase contrast » only makes the inks stronger).
  { name: 'address of the mini window', ink: () => declared(outsideMedia(s.little), '.la.themed', '--la-host'), min: AA_TEXT, wash: (scheme) => declared(s.little, scheme === 'light' ? '.la.light' : '.la', '--la-field') },
  { name: 'glyphs of the mini window', ink: () => declared(outsideMedia(s.little), '.la.themed', '--la-glyph'), min: AA_CONTROL, wash: (scheme) => declared(s.little, scheme === 'light' ? '.la.light' : '.la', '--la-field') },
  { name: 'title of the mini window', ink: () => declared(outsideMedia(s.little), '.la.themed', '--la-fg'), min: AA_TEXT, wash: (scheme) => declared(s.little, scheme === 'light' ? '.la.light' : '.la', '--la-field') }
]

/** The colours a person gives a space: the ten named ones as the sheet « Nouvel espace » makes them, each alone, the ends of the pad, and the default. */
const SPACE_THEMES: ReadonlyArray<{ id: string; theme: SpaceTheme }> = [
  { id: 'default', theme: defaultTheme() },
  ...NAMED_COLORS.map((named) => ({ id: named.id, theme: presetTheme(named.hex) })),
  ...[...NAMED_COLORS.map((named) => named.hex), '#000000', '#ffffff', ...[0, 60, 120, 180, 240, 300].flatMap((hue) => [colorAtPadPoint(hue / 360, 0, 1), colorAtPadPoint(hue / 360, 1, 1)])].map((hex) => ({ id: `${hex} alone`, theme: cleanTheme({ ...defaultTheme(), baseColors: [hex], harmony: 'custom' }) }))
]

/** The parts under their minimum, for the sheets given and what the window sets on the shell. */
function spaceFailures(sheets: SpaceSheets, inlineOf?: (theme: SpaceTheme, scheme: Scheme) => Record<string, string>): string[] {
  const lines: string[] = []
  const parts = spaceParts(sheets)
  for (const { id, theme } of SPACE_THEMES) {
    for (const scheme of ['light', 'dark'] as const) {
      for (const contrast of CONTRASTS) {
        const values = shellValues(theme, scheme, contrast, [sheets.sidebar, sheets.little], inlineOf?.(theme, scheme))
        for (const ground of backgroundColors(theme, scheme)) {
          const bare = parseColor(ground)!
          for (const part of parts) {
            const under = part.wash ? compositeOver(colorOf(values, part.wash(scheme), scheme), bare) : bare
            const ratio = contrastRatio(colorOf(values, part.ink(scheme), scheme), under)
            if (ratio < part.min) lines.push(`${part.name} on ${ground} (${id}, ${scheme}${label(contrast)}): ${ratio.toFixed(2)}:1, needs ${part.min}`)
          }
        }
      }
    }
  }
  return lines
}

describe('what is written on the background of a space, whatever colour the space was given', () => {
  const sheets: SpaceSheets = { sidebar: sidebarCss, styles: stylesCss, splitBar: splitBarCss, little: littleCss }

  it('reads at 4.5:1 (3:1 for a glyph): the secondary text of the sidebar, bare and on a tile, the empty page, the layout bar of a split view and the header of the mini window', () => {
    expect(SPACE_THEMES.length).toBeGreaterThan(30)
    expect(spaceFailures(sheets).slice(0, 8)).toEqual([])
  })

  it('measures what it says: with the inks of the tokens alone, « Sable » and « Jaune » fail in the dark appearance, bare and on a tile', () => {
    // What the window gave before it measured its theme: no ink of its own for the space, and the --muted of the old themeVars.
    const before = (theme: SpaceTheme, scheme: Scheme): Record<string, string> => {
      const { '--text-on-space': _text, '--text-on-space-2': _secondary, '--text-on-tile-2': _tile, '--glyph-on-space': _glyph, ...rest } = themeVars(theme, scheme)
      return { ...rest, '--muted': scheme === 'dark' ? 'rgb(241 241 245 / 0.6)' : 'rgb(28 28 34 / 0.62)' }
    }
    const lines = spaceFailures(sheets, before).join('\n')
    expect(lines).toMatch(/title of a sleeping tab on #[0-9a-f]{6} \(sand, dark\)/)
    expect(lines).toMatch(/title of a sleeping tab on #[0-9a-f]{6} \(yellow, dark\)/)
    expect(lines).toMatch(/name of a favourite on its tile on #[0-9a-f]{6} \(yellow, dark\)/)
    expect(lines).toMatch(/text of the empty page on #[0-9a-f]{6} \(night, light\)/)
    expect(lines).toMatch(/address of the mini window on #[0-9a-f]{6} \(sand, dark\)/)
  })

  it('measures what it says: a sheet that goes back to the grey of a help text, to the bare ink on a tile or to the fixed greys of the mini window fails', () => {
    const swap = (css: string, from: string, to: string): string => {
      const changed = css.replace(from, to)
      expect(changed, from).not.toBe(css)
      return changed
    }
    const group = spaceFailures({ ...sheets, sidebar: swap(sidebarCss, 'letter-spacing: 0.02em; color: var(--sb-dim); }', 'letter-spacing: 0.02em; color: var(--text-3); }') })
    expect(group.length).toBeGreaterThan(0)
    for (const line of group) expect(line).toMatch(/^title of a group of Today/)

    const favourite = spaceFailures({ ...sheets, sidebar: swap(sidebarCss, '--sb-dim-tile: var(--text-on-tile-2);', '--sb-dim-tile: var(--text-on-space-2);') })
    expect(favourite.length).toBeGreaterThan(0)
    for (const line of favourite) expect(line).toMatch(/^(name of a favourite on its tile|note of a private window)/)

    const bar = spaceFailures({ ...sheets, splitBar: swap(splitBarCss, 'border: 1px solid var(--fixed-ffffff-14); color: var(--text-on-tile-2);', 'border: 1px solid var(--fixed-ffffff-14); color: var(--muted);') })
    expect(bar.length).toBeGreaterThan(0)
    for (const line of bar) expect(line).toMatch(/^layout bar of a split view/)

    const mini = spaceFailures({ ...sheets, little: swap(littleCss, '--la-host: var(--text-on-tile-2); }', '--la-host: var(--fixed-9a98a4); }') })
    expect(mini.length).toBeGreaterThan(0)
    for (const line of mini) expect(line).toMatch(/^address of the mini window/)
  })

  it('follows the text a person chose for a picture or a video behind the tabs: the ink on a tile is that text too, not the one measured on the colours of the theme', () => {
    // The sidebar sets its inks on itself for such a background (Sidebar.tsx), and the sheet does for a tone it works out.
    const source = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8')
    for (const name of ['--text-on-space-2', '--text-on-tile-2', '--sb-dim', '--sb-dim-tile', '--sb-dim-hover']) expect(source, name).toContain(`'${name}': ink[1]`)
    for (const tone of ['light', 'dark']) {
      const other = tone === 'light' ? 'dark' : 'light'
      expect(sidebarCss, tone).toContain(`.sidebar:has(.sidebar-background.text-${tone}, .space-background.text-${tone}) { --text-on-space: var(--tone-on-${other}); --text-on-space-2: var(--tone-on-${other}-2); --text-on-tile-2: var(--tone-on-${other}-2); }`)
    }
  })

  it('marks the mini window that draws the gradient of a space, in the window itself', () => {
    expect(readFileSync(new URL('./littlearc.tsx', import.meta.url), 'utf8')).toContain("<div className={['la', appearance === 'light' && 'light', full && 'themed'].filter(Boolean).join(' ')} style={vars as CSSProperties}>")
  })

  it('gives the mini window the inks of the space only when it draws the gradient of one', () => {
    expect(littleCss).toMatch(/\.la \{[^}]*--la-host: var\(--fixed-9a98a4\)/)
    expect(declared(outsideMedia(littleCss), '.la.themed', '--la-host')).toBe('var(--text-on-tile-2)')
    // With « Increase contrast » the address and the glyphs are the text of the space itself.
    expect(declared(littleCss, '.la.themed', '--la-host')).toBe('var(--text-on-space)')
  })
})

// ---------- the address of a private window ----------

describe('the toolbar of a private window, on its own blue', () => {
  /** The inks of the bar under their minimum, for a toolbar sheet: on the blue and on its darker stripe. */
  function barFailures(css: string): string[] {
    const lines: string[] = []
    const scheme: Scheme = 'dark'
    for (const contrast of CONTRASTS) {
      const base = shellValues(privateTheme(), scheme, contrast, [css])
      // What `html.private .shell` declares over the bar of every window.
      const ink = (name: string): Rgba => colorOf(base, declaredOrNone(css, 'html.private .shell', name) ?? `var(${name})`, scheme)
      const bar = colorOf(base, declared(css, 'html.private .shell', '--toolbar-bg'), scheme)
      const stripe = compositeOver(parseColor(/rgb\([^)]*\)/.exec(declared(css, 'html.private .shell', '--toolbar-texture'))![0])!, bar)
      for (const [ground, under] of [['the blue', bar], ['its stripe', stripe]] as const) {
        for (const [name, min] of [['--tb-text', AA_TEXT], ['--tb-rest', AA_TEXT], ['--tb-icon', AA_CONTROL]] as const) {
          const ratio = contrastRatio(ink(name), under)
          if (ratio < min) lines.push(`${name} on ${ground}${label(contrast)}: ${ratio.toFixed(2)}:1, needs ${min}`)
        }
      }
    }
    return lines
  }

  it('is always dark: the theme of a private window does not follow the system', () => {
    expect(privateTheme().appearance).toBe('dark')
  })

  it('reads the host and the rest of the address at 4.5:1 and the glyphs at 3:1', () => {
    expect(barFailures(toolbarCss)).toEqual([])
  })

  it('measures what it says: with the opacities of the grey bar, the host and the rest of the address fail', () => {
    const grey = toolbarCss.replace(/\n\s*--tb-text: color-mix\(in srgb, var\(--text-on-space\) 90%, transparent\);\n\s*--tb-rest: color-mix\(in srgb, var\(--text-on-space\) 82%, transparent\);/, '')
    expect(grey).not.toBe(toolbarCss)
    const lines = barFailures(grey)
    expect(lines.some((line) => line.startsWith('--tb-text on the blue'))).toBe(true)
    expect(lines.some((line) => line.startsWith('--tb-rest on the blue'))).toBe(true)
    expect(lines.some((line) => line.startsWith('--tb-icon'))).toBe(false)
  })
})

// ---------- small texts on a tint of the accent, on a tile, on a sunken field ----------

// The grey of a help text (--text-3) is measured on the plain surfaces. Written on a tint of the accent (the chosen row of the command bar, a
// callout of the Settings, the chosen theme) or on a tile (a key that is off, a row under the pointer), it goes under 4.5:1 at
// most hues or in the dark appearance: those texts take the secondary text.
interface RaisedPart {
  name: string
  css: string
  selector: string
  /** What the text is written on, as a CSS expression: opaque, or a wash laid over each of the surfaces below. */
  ground: string
}

const bar = (selector: string): string => `body:is(.overlay, .little) .palette:not(.cb-little) ${selector}`
const RAISED_PARTS: readonly RaisedPart[] = [
  { name: 'place of the chosen result of the command bar', css: commandBarCss, selector: bar('.results li.selected .where'), ground: 'var(--accent-soft)' },
  { name: 'detail of the chosen result of the command bar', css: commandBarCss, selector: bar('.results li.selected .detail'), ground: 'var(--accent-soft)' },
  { name: 'hint of a callout of the Settings', css: settingsCss, selector: '.pref-callout .pref-hint', ground: 'var(--accent-soft)' },
  { name: 'small word of the chosen theme', css: themeEditorCss, selector: ".theme-pop .tp-theme[aria-pressed='true'] small", ground: 'var(--accent-soft)' },
  { name: 'small word of a theme under the pointer', css: themeEditorCss, selector: '.theme-pop .tp-theme:hover small', ground: 'var(--tile)' },
  { name: 'key of a shortcut that is off', css: settingsCss, selector: '.shortcut-key.off', ground: 'var(--tile-hover)' },
  { name: 'line of « Plus de réglages » under the pointer', css: settingsCss, selector: '.more-settings-what', ground: 'var(--tile)' },
  { name: 'small line of a shortcut under the pointer', css: shortcutHelpCss, selector: '.sk-row:hover .sk-label small', ground: 'var(--tile)' },
  { name: 'language of a block of code in a note', css: notesCss, selector: '.nm-codeblock[data-lang]::before', ground: 'var(--surface-3)' }
]

/** The parts under 4.5:1, at every hue (every 5 degrees and the named colours), in both appearances, with « Increase contrast » on or off. */
function raisedFailures(parts: readonly RaisedPart[]): string[] {
  const lines: string[] = []
  for (const scheme of ['light', 'dark'] as const) {
    for (const contrast of CONTRASTS) {
      for (const hue of HUES) {
        const values = tokensAt(tokensCss, scheme, hue, contrast)
        for (const part of parts) {
          const ink = colorOf(values, declared(part.css, part.selector, 'color'), scheme)
          for (const surface of ['--surface', '--surface-2']) {
            const under = compositeOver(colorOf(values, part.ground, scheme), colorOf(values, `var(${surface})`, scheme))
            const ratio = contrastRatio(ink, under)
            if (ratio < AA_TEXT) lines.push(`${part.name} over ${surface}, ${scheme} hue ${hue}${label(contrast)}: ${ratio.toFixed(2)}:1`)
          }
        }
      }
    }
  }
  return lines
}

describe('the small texts written on a tint of the accent, on a tile or in a sunken field', () => {
  it('read at 4.5:1 at every hue, in both appearances', () => {
    expect(raisedFailures(RAISED_PARTS).slice(0, 8)).toEqual([])
  })

  it('measure what they say: each of them fails in the grey of a help text', () => {
    for (const part of RAISED_PARTS) {
      // The same rule with the help grey for colour: found by its selector, whatever else the rule declares.
      const escaped = part.selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const grey = part.css.replace(new RegExp(`((?:^|[},])\\s*${escaped}\\s*(?:,[^{]*)?\\{[^}]*?color:\\s*)var\\(--text-2\\)`, 'm'), '$1var(--text-3)')
      expect(grey, part.name).not.toBe(part.css)
      const lines = raisedFailures([{ ...part, css: grey }])
      expect(lines.length, part.name).toBeGreaterThan(0)
    }
  })
})

// ---------- the sidebar of the Settings ----------

// The page shown in the sidebar is written in the accent as text on a tint of the accent, and the count of « Réglages modifiés » on the accent: both
// read at 4.5:1 at every hue, in both appearances, with « Increase contrast » on or off.
describe('the sidebar of the Settings', () => {
  const PAIRS = [
    { name: 'page shown', selector: ".settings-cat[aria-current='page']", ground: ".settings-cat[aria-current='page']" },
    { name: '« Réglages modifiés » shown', selector: ".settings-changed-link[aria-current='page']", ground: ".settings-changed-link[aria-current='page']" },
    { name: 'count of the changed settings', selector: '.settings-changed-count', ground: '.settings-changed-count' }
  ] as const

  it('reads at 4.5:1 at every hue, in both appearances', () => {
    const lines: string[] = []
    for (const scheme of ['light', 'dark'] as const) {
      for (const contrast of CONTRASTS) {
        for (const hue of HUES) {
          const values = tokensAt(tokensCss, scheme, hue, contrast)
          for (const pair of PAIRS) {
            const ink = colorOf(values, declared(settingsCss, pair.selector, 'color'), scheme)
            for (const surface of ['--surface', '--surface-2']) {
              const under = compositeOver(colorOf(values, declared(settingsCss, pair.ground, 'background'), scheme), colorOf(values, `var(${surface})`, scheme))
              const ratio = contrastRatio(ink, under)
              if (ratio < AA_TEXT) lines.push(`${pair.name} over ${surface}, ${scheme} hue ${hue}${label(contrast)}: ${ratio.toFixed(2)}:1`)
            }
          }
        }
      }
    }
    expect(lines.slice(0, 8)).toEqual([])
  })
})

// ---------- the bar of the page annotation ----------

// The bar reads the roles of tokens.css, like the rest of the interface: it is light in light and dark in dark. Its texts (the letter of a shortcut
// under a tool, 9.5 px; the note of the state, 10 px; the names of the actions) and its marks (the dots of the grip, the Position button) are measured
// on every ground they can have (the bar, a button under the pointer, the chosen tool, the strip of the handle, the hint), in both appearances and
// with "Increase contrast" on or off. The bar sets no hue: the accent is the one of the tokens.
describe('the texts of the annotation bar', () => {
  const page = readFileSync(new URL('./page-annotate-command.html', import.meta.url), 'utf8')
  const sheet = /<style>([\s\S]*?)<\/style>/.exec(page)![1]!
  const SCHEMES: readonly Scheme[] = ['light', 'dark']
  const HOVER = '.page-annotate-bar button:hover:not(:disabled)'
  const CHOSEN = ".page-annotate-tool[aria-pressed='true']"

  /** The texts and the marks of the bar under their minimum, each on the grounds it can sit on, for a sheet of the bar and a sheet of tokens. */
  function barFailures(css: string, tokens = tokensCss): string[] {
    const lines: string[] = []
    for (const scheme of SCHEMES) {
      for (const contrast of CONTRASTS) {
        const values = tokensAt(tokens, scheme, 250, contrast)
        const of = (selector: string, property: string): Rgba => colorOf(values, declared(css, selector, property), scheme)
        const bar = of('.page-annotate-bar', 'background')
        // A ground of the bar is laid over the bar: the tile under the pointer is translucent.
        const on = (selector: string): Rgba => compositeOver(of(selector, 'background'), bar)
        const theBar: [string, Rgba] = ['the bar', bar]
        const pointed: [string, Rgba] = ['a button under the pointer', on(HOVER)]
        const chosen: Array<[string, Rgba]> = [['the chosen tool', on(CHOSEN)], ['the chosen tool under the pointer', on(`${CHOSEN}:hover:not(:disabled)`)]]
        const parts: Array<[name: string, selector: string, min: number, grounds: Array<[string, Rgba]>]> = [
          // The letter of a shortcut is inside a tool button: every ground. The note of the state and the name of a style are written on the bar itself.
          ['letter of a shortcut', '.page-annotate-letter', AA_TEXT, [theBar, pointed, ...chosen]],
          ['note of the state', '.page-annotate-bar p', AA_TEXT, [theBar]],
          ['name of a style', '.page-annotate-style-name', AA_TEXT, [theBar]],
          ['text of the bar', '.page-annotate-bar', AA_TEXT, [theBar, pointed]],
          ['action that erases', '.page-annotate-danger', AA_TEXT, [theBar, pointed]],
          ['glyph of the chosen tool', CHOSEN, AA_CONTROL, chosen],
          ['name of the chosen mode', ".page-annotate-key[aria-pressed='true']", AA_TEXT, [['the chosen mode', on(".page-annotate-key[aria-pressed='true']")]]],
          ['dots of the grip', '.page-annotate-grip', AA_CONTROL, [['their strip', on('.page-annotate-grip')]]],
          ['dots of the grip under the pointer', '.page-annotate-bar .page-annotate-grip:hover', AA_CONTROL, [['their strip', on('.page-annotate-bar .page-annotate-grip:hover')]]],
          ['dots of the grip while it is dragged', '.page-annotate-dragging .page-annotate-grip', AA_CONTROL, [['their strip', on('.page-annotate-dragging .page-annotate-grip')]]],
          ['glyph of the Position button', '.page-annotate-position', AA_CONTROL, [['its strip', on('.page-annotate-position')]]],
          ['glyph of the Position button under the pointer', '.page-annotate-bar .page-annotate-position:hover', AA_CONTROL, [['its strip', on('.page-annotate-bar .page-annotate-position:hover')]]],
          ['text of the hint', '.page-annotate-bubble', AA_TEXT, [['the hint', on('.page-annotate-bubble')]]],
          ['« OK » of the hint', '.page-annotate-hint-ok', AA_TEXT, [['its button', on('.page-annotate-hint-ok')], ['its button under the pointer', on('.page-annotate-bar .page-annotate-hint-ok:hover:not(:disabled)')]]]
        ]
        for (const [name, selector, min, grounds] of parts) {
          for (const [ground, colour] of grounds) {
            const ratio = contrastRatio(of(selector, 'color'), colour)
            if (ratio < min) lines.push(`${name} on ${ground}, ${scheme}${label(contrast)}: ${ratio.toFixed(2)}:1`)
          }
        }
      }
    }
    return lines
  }

  /** The colours written in the rules of the bar, comments left out: there must be none. */
  const written = (css: string): string[] => css.replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-f]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/gi) ?? []

  it('writes no colour of its own: its page loads the tokens and the fixed palette, and every colour is one of theirs', () => {
    expect(page).toContain('<link rel="stylesheet" href="./tokens.css" />')
    expect(page).toContain('<link rel="stylesheet" href="./palette.css" />')
    expect(written(sheet)).toEqual([])
    const known = new Set([...`${tokensCss}\n${paletteCss}\n${sheet}`.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]!))
    const used = [...new Set([...sheet.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]!))]
    expect(used.filter((name) => !known.has(name))).toEqual([])
    // The fixed colours are the picture of a laser's look, and nothing else of the bar.
    const fixed = [...sheet.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*var\(--fixed-[^{}]*)\}/g)].map((rule) => rule[1]!.trim())
    expect(fixed).toEqual(['.page-annotate-dot-net', '.page-annotate-dot-discret', '.page-annotate-dot-lumiere'])
  })

  it('measures what it says: a colour written in a rule is found', () => {
    expect(written(sheet.replace('background: var(--surface);', 'background: #ffffff;'))).toEqual(['#ffffff'])
    expect(written(sheet.replace('box-shadow: var(--shadow);', 'box-shadow: 0 1px 3px rgba(20, 24, 40, 0.08);'))).toEqual(['rgba(20, 24, 40, 0.08)'])
  })

  it('is light in light and dark in dark: the ground and the text of the bar follow the appearance', () => {
    const light = tokensAt(tokensCss, 'light', 250, false)
    const dark = tokensAt(tokensCss, 'dark', 250, false)
    const ground = declared(sheet, '.page-annotate-bar', 'background')
    const text = declared(sheet, '.page-annotate-bar', 'color')
    // The page round the bar is the same ground: the window of the bar is opaque, and its corners would show another colour.
    expect(declared(sheet, 'body', 'background')).toBe(ground)
    expect(relativeLuminance(colorOf(light, ground, 'light'))).toBeGreaterThan(0.8)
    expect(relativeLuminance(colorOf(dark, ground, 'dark'))).toBeLessThan(0.05)
    expect(relativeLuminance(colorOf(light, text, 'light'))).toBeLessThan(0.05)
    expect(relativeLuminance(colorOf(dark, text, 'dark'))).toBeGreaterThan(0.8)
  })

  it('read at 4.5:1, and the marks at 3:1, on every ground of the bar, in light and in dark, with "Increase contrast" on or off', () => {
    expect(barFailures(sheet)).toEqual([])
  })

  it('measure what they say: the white panel the bar was fails in dark, and a paler role for the small texts fails on the chosen tool', () => {
    // The bar as it was: a white ground under texts that now follow the appearance.
    const white = barFailures(sheet.replace(/(\.page-annotate-bar \{[^}]*background: )var\(--surface\)/, '$1white'))
    expect(white).not.toEqual([])
    expect(white.every((line) => line.includes(', dark'))).toBe(true)
    expect(white).toContain('text of the bar on the bar, dark: 1.12:1')
    // The letter of a shortcut in the role of the help texts.
    const letter = sheet.replace(/(\.page-annotate-letter \{[^}]*color: )var\(--text-2\)/, '$1var(--text-3)')
    expect(letter).not.toBe(sheet)
    expect(barFailures(letter).filter((line) => line.startsWith('letter of a shortcut')).length).toBeGreaterThan(0)
    expect(barFailures(letter).every((line) => line.startsWith('letter of a shortcut'))).toBe(true)
  })
})
