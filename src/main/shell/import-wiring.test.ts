// The service of « Importer depuis un autre navigateur… » main() installs (shell/import-wiring.ts): on a Mac it is given the folders where the applications of the other
// browsers are, so that the sheet names each as its application calls itself; outside the built application the variable LUCIUM_IMPORT_APP_FOLDERS (read through runtime.ts)
// names other folders, or none (the screenshots of the site). The service itself is importers/service.test.ts.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const made = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }))
vi.mock('electron', () => ({ dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } }))
vi.mock('../importers/service', () => ({
  ImportService: class {
    constructor(options: Record<string, unknown>) {
      made.options.push(options)
    }
  },
  setImportService: () => undefined
}))
vi.mock('../lock-service', () => ({ getLockService: () => null }))

const { installImportService } = await import('./import-wiring')

/** The service as main() installs it, on a platform, with the development variables read as runtime.ts reads them. */
function installed(platformId: 'darwin' | 'linux', importAppFolders: string[] | undefined) {
  made.options.length = 0
  installImportService({
    platform: { id: platformId },
    development: { importAppFolders },
    browser: {},
    store: { get: () => ({}) },
    history: {},
    windowManager: {}
  } as never)
  return made.options[0]!
}

describe('the folders of the applications the import service looks into', () => {
  it('are the usual ones on a Mac, and those of LUCIUM_IMPORT_APP_FOLDERS when the run may read it (none: every browser keeps its generic label)', () => {
    expect(installed('darwin', undefined)['applications']).toEqual(['/Applications', join(homedir(), 'Applications')])
    expect(installed('darwin', ['/folder/of/the/screenshots'])['applications']).toEqual(['/folder/of/the/screenshots'])
    expect(installed('darwin', [])['applications']).toEqual([])
  })

  it('are not given on another system, whose browsers are found elsewhere', () => {
    expect(installed('linux', ['/folder'])).not.toHaveProperty('applications')
  })
})
