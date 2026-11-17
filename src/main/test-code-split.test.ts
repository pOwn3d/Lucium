// Contract: the engine tests live in src/main/smoke*.ts and must stay out of the application, which only a build shows. main() loads them with
// import() when --smoke is passed, so the bundler puts each in a smoke*.js chunk of its own, and electron-builder.yml leaves those chunks out of
// the package. A static import from any file of the application would pull them into its chunk.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(join(__dirname, '../..', path), 'utf8')
const isSmoke = (file: string): boolean => /(^|\/)smoke[^/]*\.ts$/.test(file)

describe('the engine tests in the package', () => {
  it('are not imported statically by any file of the application', () => {
    const files = (readdirSync(__dirname, { recursive: true, encoding: 'utf8' }) as string[]).filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.test.ts') && !file.includes('test-support') && !isSmoke(file))
    const importers = files.filter((file) => /^\s*(?:import|export)\b[^\n]*from '(?:\.\.?\/)+smoke[^']*'/m.test(readFileSync(join(__dirname, file), 'utf8')))
    expect(importers).toEqual([])
  })

  // That main() loads them where they run, by import(), and only in the engine test: main-wiring.test.ts, where main() is run.
  it('have their chunks left out of the package', () => {
    expect(read('electron-builder.yml')).toMatch(/^\s*-\s*'!out\/main\/smoke\*\.js'\s*$/m)
  })
})
