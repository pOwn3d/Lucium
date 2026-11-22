// The minimum font size is a web preference fixed when a page is made: the engine must hand every page it creates the size the shell gave it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (file: string): string => readFileSync(join(__dirname, file), 'utf8')

describe('the minimum font size in the engine', () => {
  it('is given to the web preferences of every page the engine creates', () => {
    expect(read('electron-engine.ts')).toMatch(/new WebContentsView\(\{[^]*?webPreferences: \{[^}]*minimumFontSize: this\.minimumFontSize/)
  })

  it('is stored as the setting keeps it: cleaned, so that a size the setting would refuse never reaches Chromium', () => {
    expect(read('electron-engine-network.ts')).toMatch(/setMinimumFontSize\(size: number\): void \{\s*this\.minimumFontSize = cleanMinimumFontSize\(size\)/)
  })

  it('follows the setting at launch and at each change of settings, in the main window', () => {
    expect(read('../shell/browser.ts')).toContain('this.configureMinimumFontSize()')
    expect(read('../shell/browser-actions.ts')).toContain('this.configureMinimumFontSize()')
    expect(read('../shell/browser-network.ts')).toMatch(/this\.engine\.setMinimumFontSize\(this\.store\.get\(\)\.settings\.minimumFontSize\)/)
  })
})
