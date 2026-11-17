import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ABOUT_LICENSE, LICENSES_DOC } from '@shared/about'

const fromRoot = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url))

// The About group names a licence, a version and a document: these tests tie them to the files they come from.
describe('what the About group says about the project', () => {
  it('names the licence the package declares', () => {
    const declared = (JSON.parse(readFileSync(fromRoot('package.json'), 'utf8')) as { license: string }).license
    expect(ABOUT_LICENSE).toBe(declared)
  })

  it('names a licence the LICENSE file carries (GPL, version 3)', () => {
    expect(readFileSync(fromRoot('LICENSE'), 'utf8')).toMatch(/GNU GENERAL PUBLIC LICENSE\s+Version 3/)
  })

  it('opens a licences document that exists in the repository', () => {
    expect(existsSync(fromRoot(LICENSES_DOC))).toBe(true)
  })

  it('opens a licences document the packaged application carries (extraResources of electron-builder.yml)', () => {
    const builder = readFileSync(fromRoot('electron-builder.yml'), 'utf8')
    expect(builder).toMatch(/from: docs\s+to: docs/)
    expect(builder).toContain(`- ${LICENSES_DOC.replace('docs/', '')}`)
  })

  it('ships the LICENSE file with the packaged application', () => {
    expect(readFileSync(fromRoot('electron-builder.yml'), 'utf8')).toMatch(/- from: LICENSE\s+to: LICENSE/)
  })

  it('carries the MIT text of the Web Store installer, whose npm package has none, in the generated notices the application ships', () => {
    const notices = readFileSync(fromRoot('THIRD-PARTY-NOTICES.txt'), 'utf8')
    expect(notices).toMatch(/^MIT: electron-chrome-web-store \d[^\n]*\n\(no licence file in the package: standard MIT text/m)
    expect(notices).toContain('Copyright (c) Samuel Maddock\n\nPermission is hereby granted, free of charge')
    expect(readFileSync(fromRoot('electron-builder.yml'), 'utf8')).toMatch(/- from: THIRD-PARTY-NOTICES\.txt\s+to: THIRD-PARTY-NOTICES\.txt/)
    // The document the About group opens says where those texts are.
    expect(readFileSync(fromRoot(LICENSES_DOC), 'utf8')).toContain('THIRD-PARTY-NOTICES.txt')
  })

  it('ships the notice that names the copyright holder, the one the build declares', () => {
    const builder = readFileSync(fromRoot('electron-builder.yml'), 'utf8')
    expect(builder).toMatch(/- from: NOTICE\s+to: NOTICE/)
    expect(readFileSync(fromRoot('NOTICE'), 'utf8')).toContain('Copyright © 2026 ConsilioWeb and contributors')
    expect(builder).toMatch(/^copyright: Copyright © 2026 ConsilioWeb and contributors\. GPL-3\.0-or-later\.$/m)
    expect(readFileSync(fromRoot('NOTICE'), 'utf8')).toContain('SPDX-License-Identifier: GPL-3.0-or-later')
  })

  // The application ships the permission twice: as its own file, and in NOTICE, which repeats it word for word and names the file.
  it('ships the additional permission for the Widevine module: its file, and whole in the notice', () => {
    expect(readFileSync(fromRoot('electron-builder.yml'), 'utf8')).toMatch(/- from: ADDITIONAL-PERMISSION\.txt\s+to: ADDITIONAL-PERMISSION\.txt/)
    const flat = (text: string) => text.replace(/\s+/g, ' ').trim()
    const granted = readFileSync(fromRoot('ADDITIONAL-PERMISSION.txt'), 'utf8')
      .split(/\n{2,}/)
      .filter((paragraph) => paragraph.startsWith('    '))
      .map(flat)
    expect(granted.length).toBeGreaterThanOrEqual(5)
    expect(granted[0]).toMatch(/^If you modify Lucium, or any covered work, by linking or combining it with$/)
    expect(granted.join(' ')).toMatch(/additional permission to convey the resulting work/)
    const notice = flat(readFileSync(fromRoot('NOTICE'), 'utf8'))
    expect(notice).toContain(granted.join(' '))
    expect(notice).toContain('ADDITIONAL-PERMISSION.txt')
  })
})
