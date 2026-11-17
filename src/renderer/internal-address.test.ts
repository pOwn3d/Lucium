// What the interface puts in the command bar and on the clipboard for the address of a tab goes through `displayAddress`: the Extensions page is `chrome://extensions` there, and its own
// address (`lucium-ui://extensions/`) never reaches a person. A contract read from the sources, as the other contracts of the interface are (the places are views of React that a
// static render cannot click): a new place that writes the address of a tab straight from `tab.url` fails here.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (file: string): string => readFileSync(join(__dirname, file), 'utf8')

describe('the address of a tab, as the interface hands it out', () => {
  it('opens the command bar on the address a person sees, from the toolbar and from the sidebar', () => {
    for (const file of ['Toolbar.tsx', 'Sidebar.tsx']) {
      const source = read(file)
      const opens = source.match(/panel: 'commandbar', mode: 'current', initial: [^}]*/g) ?? []
      expect(opens.length, file).toBeGreaterThan(0)
      for (const open of opens) expect(open, `${file}: ${open}`).toMatch(/displayAddress\(/)
      expect(source, file).not.toMatch(/initial: (current\?\.url|tab\.url)/)
    }
  })

  it('copies the address of the card of a tab as the person sees it', () => {
    const source = read('Sidebar.tsx')
    expect(source).toMatch(/clipboard\.writeText\(displayAddress\(tab\.url\)\)/)
    expect(source).not.toMatch(/clipboard\.writeText\(tab\.url\)/)
  })

  it('reads every address of the page through the one function: no copy of its rule in the interface', () => {
    for (const file of ['Toolbar.tsx', 'Sidebar.tsx', 'SidebarRows.tsx']) expect(read(file), file).not.toMatch(/lucium-ui|chrome:\/\/extensions/)
  })
})
