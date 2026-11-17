// The CI workflows pin the third-party action that reads the secrets, and the checkout action, by commit.
// A floating tag such as @main or @v4 can change under the job, which has write access to the security events.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WORKFLOWS = join(__dirname, '../../.github/workflows')
const uses = (): string[] =>
  readdirSync(WORKFLOWS)
    .filter((file) => file.endsWith('.yml'))
    .flatMap((file) => readFileSync(join(WORKFLOWS, file), 'utf8').split('\n').filter((line) => /uses:\s/.test(line)))

describe('the CI actions', () => {
  it('pins trufflehog by commit, not by a floating branch', () => {
    const scanner = uses().find((line) => line.includes('trufflesecurity/trufflehog'))
    expect(scanner).toBeDefined()
    expect(scanner).toMatch(/trufflehog@[0-9a-f]{40}/)
  })

  it('pins actions/checkout by commit, everywhere', () => {
    const checkouts = uses().filter((line) => line.includes('actions/checkout@'))
    expect(checkouts.length).toBeGreaterThan(0)
    for (const line of checkouts) expect(line).toMatch(/actions\/checkout@[0-9a-f]{40}/)
  })
})
