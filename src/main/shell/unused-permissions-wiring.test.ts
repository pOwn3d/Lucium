import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// What only a real window can run, read from the source: who writes the visits, and who runs the daily pass.
const read = (name: string): string => readFileSync(join(__dirname, name), 'utf8')

describe('« Oublier les autorisations des sites non visités »: the wiring', () => {
  it('writes a visit only for a page of the history (never a private tab or a container’s) and only while the setting is on', () => {
    const pages = read('browser-pages.ts')
    expect(pages).toContain("if (log !== null && this.store.get().settings.forgetUnusedPermissionsDays > 0) this.noteSiteVisit(tab.url)")
    // The page is told the visit once it loaded, in the block that also keeps the history: `log` is null for a private tab and for a container's.
    const block = pages.slice(pages.indexOf('const log = this.historyOf(tab)'), pages.indexOf('if (this.visible.has(id)) void this.refreshPageColor(id)'))
    expect(block).toContain('this.noteSiteVisit(tab.url)')
    expect(pages).toContain("this.store.dispatch({ type: 'permission/visit', origin, day: dayOf(Date.now()) })")
  })

  it('runs the daily pass in the main window only, and tells what it took in a notice', () => {
    const browser = read('browser.ts')
    expect(browser).toMatch(/if \(!this\.isPrivate\(\) && !this\.isSecondary\(\)\) \{\n\s+gateUnusedPermissions\(this\.gates, \{/)
    expect(browser).toContain("dispatch: (action) => this.dispatch(action)")
    expect(browser).toContain('this.showToast(forgottenNotice(forgotten, this.store.get().settings.forgetUnusedPermissionsDays)')
  })
})
