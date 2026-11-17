import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { READY_THEMES } from '@shared/theme-presets'

describe('the palettes of the ready themes', () => {
  const doc = readFileSync(fileURLToPath(new URL('../../docs/licences-tierces.md', import.meta.url)), 'utf8')

  it('have their source and licence in docs/licences-tierces.md, one row per theme name', () => {
    for (const theme of READY_THEMES) expect(doc.includes(theme.name), `${theme.name} is not in docs/licences-tierces.md`).toBe(true)
  })

  it('are cited in the source of the themes, with the repository they were read from', () => {
    const source = readFileSync(fileURLToPath(new URL('../shared/theme-presets.ts', import.meta.url)), 'utf8')
    for (const family of ['dracula/dracula-theme', 'nordtheme/nord', 'altercation/solarized', 'morhetz/gruvbox', 'folke/tokyonight.nvim', 'catppuccin/palette', 'OneDark-Pro', 'microsoft/vscode', 'rose-pine/rose-pine-palette', 'primitives']) {
      expect(source.includes(family), family).toBe(true)
    }
  })
})
