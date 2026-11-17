// The files of `pnpm captures:site` that must agree: the script of package.json, the script it runs, and the folder of the images, which git never keeps.

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url))
const read = (path: string) => readFileSync(here(path), 'utf8')

describe('pnpm captures:site', () => {
  it('runs scripts/site-captures.mjs, which Node loads without the warning about the module type of the sources it imports', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
    expect(scripts['captures:site']).toBe('node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/site-captures.mjs')
    expect(existsSync(here('scripts/site-captures.mjs'))).toBe(true)
  })

  it('writes its images in a folder git ignores', () => {
    expect(read('.gitignore').split('\n')).toContain('/out-captures/')
    expect(read('scripts/site-captures.mjs')).toContain("values.out ?? 'out-captures'")
  })
})
