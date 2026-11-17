import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SHOTS } from './shots'

// scripts/site-captures.mjs is run by Node alone (`pnpm captures:site`), which strips the types of scripts/site-captures/*.ts but resolves nothing
// that is not spelled out: a runtime import of a module of src/ without its extension (and src/shared modules import each other without one)
// stops the script before it reads its command line, so not even `--list` works. Vitest resolves those imports, so the unit tests of the modules
// pass while the command does not. This runs the real command in its one mode that starts nothing.

const script = fileURLToPath(new URL('../site-captures.mjs', import.meta.url))

describe('scripts/site-captures.mjs run by Node alone', () => {
  it('loads every module it needs and lists the shots it would take, without starting anything', () => {
    const run = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, '--list'], { encoding: 'utf8', timeout: 60_000 })
    // The exit code and the error stream come first: a module that cannot be loaded says so there, and the list below would then be empty.
    expect(run.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/)
    expect(run.status).toBe(0)
    for (const shot of SHOTS) expect(run.stdout, `the listing names the shot ${shot.id}`).toContain(shot.id)
  })
})
