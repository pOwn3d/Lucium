// Contract: React (react, react-dom and their scheduler) is put by the bundler inside the bundles of the interface, and the main process never
// loads it, so electron-builder.yml leaves its packages out of app.asar (8 MB). They stay in the `dependencies` of package.json, where the notices
// of the licences are read from (scripts/notices). If the main process imported React, the bundler would leave it external and the packaged
// application would fail to start: only a build would show it.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../..')
const LEFT_OUT = ['react', 'react-dom', 'scheduler']

/** The files the main process is built from: its own and the shared logic, without the tests and their helpers. */
function mainProcessFiles(): string[] {
  return ['src/main', 'src/shared'].flatMap((dir) =>
    (readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' }) as string[])
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.includes('test-support'))
      .map((file) => join(dir, file))
  )
}

/** The packages a source names in a static import, an export from, or an import(). */
function packagesNamed(source: string): string[] {
  const names: string[] = []
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)'([^'./][^']*)'/g)) {
    const [, specifier = ''] = match
    names.push(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : (specifier.split('/')[0] ?? specifier))
  }
  return names
}

describe('the packages of React in the package', () => {
  it('are never loaded by the main process', () => {
    const loading = mainProcessFiles().filter((file) => packagesNamed(readFileSync(join(ROOT, file), 'utf8')).some((name) => LEFT_OUT.includes(name)))
    expect(loading).toEqual([])
  })

  it('reads the packages an import names, with or without a path inside them', () => {
    expect(packagesNamed("import { a } from 'react'\nimport b from 'react-dom/client'\nconst c = await import('scheduler')\nimport d from './local'")).toEqual(['react', 'react-dom', 'scheduler'])
    expect(packagesNamed("export { e } from '@shared/x'\nimport f from '@scope/pkg/deep'")).toEqual(['@shared/x', '@scope/pkg'])
  })

  it('are left out of app.asar', () => {
    expect(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')).toMatch(/^\s*-\s*'!node_modules\/\{react,react-dom,scheduler\}\/\*\*'\s*$/m)
  })

  it('stay in the dependencies, where the notice of their licence is read from', () => {
    const { dependencies } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(Object.keys(dependencies)).toEqual(expect.arrayContaining(['react', 'react-dom']))
  })
})
