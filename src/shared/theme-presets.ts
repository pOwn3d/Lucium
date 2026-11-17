// Ready-made themes: the colours of well-known editor palettes, as space themes (the "Thèmes" row of the theme editor).
//
// A space theme is a base colour that the renderer shades into the window background (theme.ts, `backgroundColors`). A ready theme is
// built the other way round: `background` is the colour the palette itself uses for its editor and `base` is the base colour that
// renders as exactly that colour (dark appearance: the base shaded to 38 %; light: tinted towards white), with the intensity at its
// maximum, no colour boost and no texture. The sidebar, the toolbar and the page frame then show the palette's own background.
// Where the shading leaves a choice of a few neighbouring base colours that all render the same background, the one whose hue is
// the closest to the palette's `accent` was taken: the hue drives the tint of the sidebar's text and of the buttons, so a grey palette
// (Gruvbox) keeps warm text instead of a stray tint. `theme-presets.test.ts` renders every theme and compares it to `background`.
//
// Only hex values are taken from the palettes (colours are facts, not code). Sources, all read on 2026-10-24, and the licences of the
// projects that publish them, are listed in docs/licences-tierces.md:
//  - Dracula: https://github.com/dracula/dracula-theme (README "Color Palette": Dracula and Alucard), MIT
//  - Nord: https://github.com/nordtheme/nord (src/nord.scss: nord0, nord8), MIT
//  - Solarized: https://github.com/altercation/solarized (README: base03, base3, blue), MIT
//  - Gruvbox: https://github.com/morhetz/gruvbox (colors/gruvbox.vim: dark0, light0, bright_yellow, neutral_yellow), MIT/X11
//  - Tokyo Night: https://github.com/folke/tokyonight.nvim (lua/tokyonight/colors/night.lua and storm.lua), Apache-2.0
//  - Catppuccin: https://github.com/catppuccin/palette (palette.json 1.8.0: base and mauve of each flavour), MIT
//  - One Dark: https://github.com/Binaryify/OneDark-Pro (themes/OneDark-Pro.json: editor.background; accent from Atom's one-dark-syntax), MIT
//  - Monokai: https://github.com/microsoft/vscode (extensions/theme-monokai: editor.background; the pink is the one that file mixes), MIT
//  - Rosé Pine: https://github.com/rose-pine/rose-pine-palette (palette.json: main, moon, dawn), MIT
//  - GitHub: @primer/primitives 11.10.0 (dist/css/functional/themes/dark.css and light.css: bgColor-default, fgColor-accent), MIT

import { t } from './i18n'
import { cleanTheme, type ResolvedAppearance, type SpaceTheme } from './theme'
import { encodeThemeCode } from './theme-code'

export interface ReadyTheme {
  /** Stable, whatever the language: what a space's theme list refers to (`ready:<id>`). */
  id: string
  /** The name shown under the pointer and read by screen readers, in the language of the interface (read when it is shown). */
  readonly name: string
  /** The colour of the window with this theme: the background of the palette. */
  background: string
  /** The palette's signature colour, shown beside the background in the preview and used to pick the hue of `base`. */
  accent: string
  theme: SpaceTheme
}

/**
 * The name of a theme: the palette's own name (a proper name, the same in every language), or that name with the word of its variant, which
 * the catalogue gives (« Solarized sombre », "Solarized Dark").
 */
type ThemeName = string | (() => string)
const dark = (palette: string): ThemeName => () => t('theme-presets.palette-sombre', { palette })
const light = (palette: string): ThemeName => () => t('theme-presets.palette-clair', { palette })

function ready(id: string, name: ThemeName, base: string, background: string, accent: string, appearance: ResolvedAppearance): ReadyTheme {
  const theme = cleanTheme({
    baseColors: [base],
    harmony: 'custom',
    angle: 155,
    intensity: 1,
    overlay: 'grain',
    noise: 0,
    translucency: appearance,
    vibrant: false,
    appearance
  })
  return {
    id,
    get name() {
      return typeof name === 'string' ? name : name()
    },
    background,
    accent,
    theme
  }
}

/** In the order of the row: a palette and its variants side by side. */
export const READY_THEMES: readonly ReadyTheme[] = [
  ready('dracula', 'Dracula', '#6a6e8f', '#282a36', '#bd93f9', 'dark'),
  ready('dracula-alucard', 'Dracula Alucard', '#fff4cb', '#fffbeb', '#644ac9', 'light'),
  ready('nord', 'Nord', '#788aa8', '#2e3440', '#88c0d0', 'dark'),
  ready('solarized-dark', dark('Solarized'), '#01708f', '#002b36', '#268bd2', 'dark'),
  ready('solarized-light', light('Solarized'), '#f9e8b4', '#fdf6e3', '#268bd2', 'light'),
  ready('gruvbox-dark', dark('Gruvbox'), '#6a6968', '#282828', '#fabd2f', 'dark'),
  ready('gruvbox-light', light('Gruvbox'), '#f5d96c', '#fbf1c7', '#d79921', 'light'),
  ready('tokyo-night', 'Tokyo Night', '#444863', '#1a1b26', '#7aa2f7', 'dark'),
  ready('tokyo-night-storm', 'Tokyo Night Storm', '#5e6a9a', '#24283b', '#7aa2f7', 'dark'),
  ready('catppuccin-mocha', 'Catppuccin Mocha', '#504e78', '#1e1e2e', '#cba6f7', 'dark'),
  ready('catppuccin-macchiato', 'Catppuccin Macchiato', '#606699', '#24273a', '#c6a0f6', 'dark'),
  ready('catppuccin-frappe', 'Catppuccin Frappé', '#7f88b9', '#303446', '#ca9ee6', 'dark'),
  ready('catppuccin-latte', 'Catppuccin Latte', '#d6d9e5', '#eff1f5', '#8839ef', 'light'),
  ready('one-dark', 'One Dark', '#687588', '#282c34', '#61afef', 'dark'),
  ready('monokai', 'Monokai', '#676859', '#272822', '#f92672', 'dark'),
  ready('rose-pine', 'Rosé Pine', '#433c5e', '#191724', '#c4a7e7', 'dark'),
  ready('rose-pine-moon', 'Rosé Pine Moon', '#5d568d', '#232136', '#c4a7e7', 'dark'),
  ready('rose-pine-dawn', 'Rosé Pine Dawn', '#f3e1d0', '#faf4ed', '#907aa9', 'light'),
  ready('github-dark', dark('GitHub'), '#232e3c', '#0d1117', '#4493f8', 'dark'),
  ready('github-light', light('GitHub'), '#fefeff', '#ffffff', '#0969da', 'light')
]

/** The ready theme a theme is exactly (compared through the code, so the rounding of the code applies), or null for any other theme. */
export function readyThemeOf(theme: SpaceTheme): ReadyTheme | null {
  const code = encodeThemeCode(theme)
  return READY_THEMES.find((t) => encodeThemeCode(t.theme) === code) ?? null
}

/** The pastille of a ready theme: its background with the accent in one corner. Only values of the table above reach the style. */
export function readyThemePreview(theme: ReadyTheme): string {
  return `linear-gradient(135deg, ${theme.background} 0 58%, ${theme.accent} 58% 100%)`
}
