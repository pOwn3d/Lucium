import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ATTESTED_CHECKS,
  ENGINE_RUN_FILE,
  ENGINE_RUN_STEPS,
  MIN_REASON,
  attestationNameOf,
  attestationProblems,
  attestationTemplate,
  buildRecordNameOf,
  buildRecordOf,
  buildRecordProblems,
  changelogHeadingProblem,
  engineRunProblems,
  journalLine,
  readBuildRecord,
  readEngineRun,
  readJournal,
  readWithdrawals,
  withdrawalLine,
  stableGate,
  withdrawnOn,
  type BuildRecord,
  type EngineRunRecord,
  type JournalEntry,
  type WithdrawalEntry
} from './release-gate'

// The conditions of a publication, as pure functions of the files a release leaves. How the publication reads them, in which order and what it
// does with a refusal is in publish-update.test.ts.
const VERSION = '0.3.0'
const ZIP = `Lucium-${VERSION}-arm64.zip`
const HASH = 'a'.repeat(64)
const OTHER_HASH = 'b'.repeat(64)
const COMMIT = '1234567890abcdef1234567890abcdef12345678'
const OTHER_COMMIT = 'fedcba0987654321fedcba0987654321fedcba09'
const ARCHIVE = { name: ZIP, sha256: HASH, size: 140_000_000 }
const RECORD: BuildRecord = { version: VERSION, commit: COMMIT, clean: true, builtAt: '2026-11-20T08:00:00.000Z', archive: ARCHIVE }
const RUN: EngineRunRecord = { commit: COMMIT, clean: true, startedAt: '2026-11-20T06:00:00.000Z', endedAt: '2026-11-20T07:10:00.000Z', steps: { engine: 1, compare: 0, webstore: 0, extwindows: 0 }, reportSha256: 'd'.repeat(64) }
const ENTRY: JournalEntry = {
  at: '2026-11-20T10:00:00.000Z',
  version: VERSION,
  channel: 'test',
  outcome: 'published',
  holds: 'everything',
  commit: COMMIT,
  archive: ARCHIVE,
  dmg: null,
  tag: null,
  engineRun: { endedAt: RUN.endedAt, reportSha256: RUN.reportSha256 }
}

describe('the build record', () => {
  const git = { commit: COMMIT, modified: false }
  const made = (start: typeof git, end: typeof git) => buildRecordOf({ version: VERSION, archive: ARCHIVE, start, end, now: new Date('2026-11-20T08:00:00Z') })

  it('is named after the archive it sits beside', () => {
    expect(buildRecordNameOf(VERSION)).toBe('Lucium-0.3.0-arm64.build.json')
  })

  it('keeps the commit the build started from, the archive with its sum and size, and the date', () => {
    expect(made(git, git)).toEqual(RECORD)
  })

  it('is clean only when no tracked file was modified, before and after, and the commit did not move under the build', () => {
    expect(made(git, git).clean).toBe(true)
    expect(made({ ...git, modified: true }, git).clean).toBe(false)
    expect(made(git, { ...git, modified: true }).clean).toBe(false)
    expect(made(git, { ...git, commit: OTHER_COMMIT }).clean).toBe(false)
    // The commit that is kept is the one the build started from.
    expect(made(git, { ...git, commit: OTHER_COMMIT }).commit).toBe(COMMIT)
  })

  it('is read back as it was written', () => {
    expect(readBuildRecord(JSON.stringify(RECORD))).toEqual({ record: RECORD })
  })

  it('is refused, with the reason, when the file is not a record', () => {
    const problemOf = (change: Record<string, unknown>): string => {
      const read = readBuildRecord(JSON.stringify({ ...RECORD, ...change }))
      return 'problem' in read ? read.problem : ''
    }
    expect(readBuildRecord('not json')).toEqual({ problem: 'it is not a JSON object' })
    expect(readBuildRecord('[]')).toEqual({ problem: 'it is not a JSON object' })
    expect(problemOf({ version: '0.3' })).toBe('it has no version')
    expect(problemOf({ commit: 'main' })).toBe('it has no commit (40 hexadecimal digits)')
    expect(problemOf({ commit: COMMIT.slice(0, 12) })).toBe('it has no commit (40 hexadecimal digits)')
    expect(problemOf({ clean: 'yes' })).toBe('it does not say whether the working tree was clean')
    expect(problemOf({ builtAt: 'today' })).toBe('it has no date')
    expect(problemOf({ archive: { name: ZIP, sha256: 'abc', size: 1 } })).toBe('it does not name the archive with its SHA-256 and size')
    expect(problemOf({ archive: { name: ZIP, sha256: HASH, size: 0 } })).toBe('it does not name the archive with its SHA-256 and size')
  })

  it('is the record of the archive at hand, or each difference is named', () => {
    const want = { version: VERSION, archive: ARCHIVE }
    expect(buildRecordProblems(RECORD, want)).toEqual([])
    expect(buildRecordProblems({ ...RECORD, version: '0.2.15' }, want)).toEqual(['it is the record of 0.2.15, not of 0.3.0'])
    expect(buildRecordProblems({ ...RECORD, archive: { ...ARCHIVE, name: 'Lucium-0.2.15-arm64.zip' } }, want)).toEqual(['it names Lucium-0.2.15-arm64.zip, the archive is Lucium-0.3.0-arm64.zip'])
    expect(buildRecordProblems({ ...RECORD, archive: { ...ARCHIVE, sha256: OTHER_HASH } }, want)[0]).toMatch(/the archive was made again without its record/)
    expect(buildRecordProblems({ ...RECORD, archive: { ...ARCHIVE, size: 1 } }, want)[0]).toMatch(/the archive was made again without its record/)
    expect(buildRecordProblems({ ...RECORD, clean: false }, want)).toEqual([expect.stringMatching(/the working tree was modified when 1234567890ab was built .*the build of no commit\. Commit, then build again/)])
  })
})

describe('the record of the engine run', () => {
  it('has the four steps of the release run, and judges the chain by its comparison with the reference, not by its own exit code', () => {
    expect(ENGINE_RUN_STEPS.map((step) => `${step.name}: pnpm ${step.script}${step.decides ? '' : ' (recorded)'}`)).toEqual([
      'engine: pnpm test:engine (recorded)',
      'compare: pnpm compat:compare',
      'webstore: pnpm test:engine:webstore',
      'extwindows: pnpm test:engine:extwindows'
    ])
    expect(ENGINE_RUN_FILE).toBe('out-engine/release-run.json')
  })

  it('runs scripts that exist in package.json', () => {
    const scripts = (JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { scripts: Record<string, string> }).scripts
    for (const step of ENGINE_RUN_STEPS) expect(scripts[step.script], step.script).toBeTypeOf('string')
  })

  it('is read back as it was written, and refused when it is not one', () => {
    expect(readEngineRun(JSON.stringify(RUN))).toEqual({ record: RUN })
    const problemOf = (change: Record<string, unknown>): string => {
      const read = readEngineRun(JSON.stringify({ ...RUN, ...change }))
      return 'problem' in read ? read.problem : ''
    }
    expect(readEngineRun('{')).toEqual({ problem: 'it is not a JSON object' })
    expect(problemOf({ commit: 'HEAD' })).toBe('it has no commit (40 hexadecimal digits)')
    expect(problemOf({ clean: null })).toBe('it does not say whether the working tree was clean')
    expect(problemOf({ endedAt: 'later' })).toBe('it has no dates')
    expect(problemOf({ steps: [0, 0] })).toBe('it has no steps')
    expect(problemOf({ steps: { engine: 'ok' } })).toBe('the step "engine" has no exit code')
    expect(problemOf({ reportSha256: 'abc' })).toBe('the SHA-256 of the report is not one')
  })

  it('shows that the suites passed on a commit when the three steps that decide ended with 0 on it', () => {
    expect(engineRunProblems(RUN, COMMIT)).toEqual([])
    // The chain itself may end with 1: the reference holds the checks that are known to fail.
    expect(engineRunProblems({ ...RUN, steps: { ...RUN.steps, engine: 0 } }, COMMIT)).toEqual([])
  })

  it('does not, and says why, for another commit, a modified tree, a missing report, a step that failed, was killed or did not run', () => {
    expect(engineRunProblems(RUN, OTHER_COMMIT)).toEqual(['the suites ran on 1234567890ab, the archive was built from fedcba098765'])
    expect(engineRunProblems({ ...RUN, clean: false }, COMMIT)).toEqual([expect.stringMatching(/the working tree was modified while the suites ran/)])
    expect(engineRunProblems({ ...RUN, reportSha256: null }, COMMIT)).toEqual([expect.stringMatching(/the chain wrote no report/)])
    for (const step of ENGINE_RUN_STEPS.filter((entry) => entry.decides)) {
      expect(engineRunProblems({ ...RUN, steps: { ...RUN.steps, [step.name]: 2 } }, COMMIT), step.name).toEqual([`pnpm ${step.script} ended with code 2`])
      expect(engineRunProblems({ ...RUN, steps: { ...RUN.steps, [step.name]: null } }, COMMIT), step.name).toEqual([`pnpm ${step.script} ended with no exit code`])
    }
    for (const step of ENGINE_RUN_STEPS) {
      const { [step.name]: _left, ...steps } = RUN.steps
      expect(engineRunProblems({ ...RUN, steps }, COMMIT), step.name).toEqual([`the step "${step.name}" (pnpm ${step.script}) is not in the record`])
    }
    // A name that every object has is not a step that ran.
    expect(engineRunProblems({ ...RUN, steps: JSON.parse('{"engine":1,"compare":0,"webstore":0}') as Record<string, number> }, COMMIT)).toEqual(['the step "extwindows" (pnpm test:engine:extwindows) is not in the record'])
  })
})

describe('the heading of a version in a changelog', () => {
  const log = (heading: string): string => `# Changelog\n\n${heading}\n\n### Fixed\n\n- **A thing**: fixed.\n\n## [0.2.15] - 2026-11-10\n`

  it('carries the date of the release', () => {
    expect(changelogHeadingProblem(log('## [0.3.0] - 2026-11-20'), VERSION, 'CHANGELOG.md')).toBeNull()
    expect(changelogHeadingProblem(log('## [0.3.0] - 2026-11-20\r'), VERSION, 'CHANGELOG.md')).toBeNull()
  })

  it('is refused while it says Unreleased, and the message says what to write', () => {
    expect(changelogHeadingProblem(log('## [0.3.0] - Unreleased'), VERSION, 'CHANGELOG.fr.md')).toBe(
      'CHANGELOG.fr.md: the heading of 0.3.0 is "## [0.3.0] - Unreleased", not "## [0.3.0] - YYYY-MM-DD": write the date of the release in it (step 3 of the release)'
    )
    expect(changelogHeadingProblem(log('## [0.3.0]'), VERSION, 'CHANGELOG.md')).toMatch(/not "## \[0\.3\.0\] - YYYY-MM-DD"/)
    expect(changelogHeadingProblem(log('## [0.3.0] - 20 November 2026'), VERSION, 'CHANGELOG.md')).toMatch(/not "## \[0\.3\.0\] - YYYY-MM-DD"/)
  })

  it('is refused with a date that does not exist, or when the version has no section (another version’s date is not its own)', () => {
    expect(changelogHeadingProblem(log('## [0.3.0] - 2026-02-30'), VERSION, 'CHANGELOG.md')).toBe('CHANGELOG.md: "## [0.3.0] - 2026-02-30" does not carry a date that exists')
    expect(changelogHeadingProblem(log('## [0.3.0] - 2026-13-01'), VERSION, 'CHANGELOG.md')).toMatch(/does not carry a date that exists/)
    expect(changelogHeadingProblem(log('## [Unreleased]'), VERSION, 'CHANGELOG.md')).toBe('CHANGELOG.md has no section "## [0.3.0]"')
    expect(changelogHeadingProblem(log('## [0.3.0] - Unreleased'), '0.2.15', 'CHANGELOG.md')).toBeNull()
  })
})

describe('the journal', () => {
  it('keeps one entry per line, as JSON, and reads them back', () => {
    const second: JournalEntry = { ...ENTRY, at: '2026-11-21T12:00:00.000Z', channel: 'stable', stable: { testPublishedAt: ENTRY.at, minTestHours: 24, attestedBy: 'M', attestedAt: '2026-11-21T09:00:00.000Z', securityFix: null } }
    const text = journalLine(ENTRY) + journalLine(second)
    expect(text.split('\n')).toHaveLength(3)
    expect(readJournal(text)).toEqual({ entries: [ENTRY, second], problems: [] })
  })

  it('is empty when the file is, and skips blank lines', () => {
    expect(readJournal('')).toEqual({ entries: [], problems: [] })
    expect(readJournal(`\n${journalLine(ENTRY)}\n\n`)).toEqual({ entries: [ENTRY], problems: [] })
  })

  it('says which versions were withdrawn from a channel and not published there again: what the feed of that channel lists', () => {
    const withdrawal: WithdrawalEntry = { at: '2026-11-22T08:00:00.000Z', type: 'withdrawal', version: ENTRY.version, channel: ENTRY.channel, outcome: 'withdrawn', offers: 'nothing', to: null }
    const on = (entries: JournalEntry[], withdrawals: WithdrawalEntry[], channel = ENTRY.channel): string[] => withdrawnOn({ entries, withdrawals, channel })
    expect(on([ENTRY], [])).toEqual([])
    // The publication came before the withdrawal: the version is withdrawn.
    expect(on([ENTRY], [withdrawal])).toEqual([ENTRY.version])
    // A withdrawal that stopped half way was meant all the same; one of another channel says nothing of this one.
    expect(on([ENTRY], [{ ...withdrawal, outcome: 'partial' }])).toEqual([ENTRY.version])
    expect(on([ENTRY], [{ ...withdrawal, channel: 'stable' }])).toEqual([])
    expect(on([ENTRY], [withdrawal], 'stable')).toEqual([])
    // Published again on that channel since: no longer withdrawn. A publication that stopped half way, or on another channel, puts nothing back.
    const again = { ...ENTRY, at: '2026-11-23T08:00:00.000Z' }
    expect(on([ENTRY, again], [withdrawal])).toEqual([])
    expect(on([ENTRY, { ...again, outcome: 'partial' }], [withdrawal])).toEqual([ENTRY.version])
    expect(on([ENTRY, { ...again, channel: 'stable' }], [withdrawal])).toEqual([ENTRY.version])
    // Withdrawn a second time after that: withdrawn. Each version once, and never a version that is not three numbers.
    expect(on([ENTRY, again], [withdrawal, { ...withdrawal, at: '2026-11-24T08:00:00.000Z' }])).toEqual([ENTRY.version])
    expect(on([], [withdrawal, { ...withdrawal, version: '0.3.9' }, { ...withdrawal, version: '0.3.9; rm -rf /' }])).toEqual([ENTRY.version, '0.3.9'])
  })

  it('holds the line of a withdrawal without taking it for a publication, or for a line that cannot be read', () => {
    const withdrawal: WithdrawalEntry = { at: '2026-11-22T08:00:00.000Z', type: 'withdrawal', version: ENTRY.version, channel: 'test', outcome: 'withdrawn', offers: 'earlier version', to: '0.2.15' }
    const text = journalLine(ENTRY) + withdrawalLine(withdrawal)
    expect(text.split('\n')).toHaveLength(3)
    expect(readJournal(text)).toEqual({ entries: [ENTRY], problems: [] })
    expect(readWithdrawals(text)).toEqual([withdrawal])
    // A withdrawal that cannot be read is a line that cannot be read, like any other: it has no archive to be taken for an entry by.
    const bad = [{ ...withdrawal, at: 'yesterday' }, { ...withdrawal, outcome: 'published' }, { ...withdrawal, version: 3 }, { ...withdrawal, channel: null }]
    const read = readJournal([journalLine(ENTRY).trim(), ...bad.map((line) => JSON.stringify(line))].join('\n'))
    expect(read).toEqual({ entries: [ENTRY], problems: bad.map((_line, index) => `line ${index + 2} is not an entry`) })
    expect(readWithdrawals(bad.map((line) => JSON.stringify(line)).join('\n'))).toEqual([])
  })

  it('names each line that is not an entry, by its number, and keeps the others', () => {
    const bad = ['not json', '[]', JSON.stringify({ ...ENTRY, at: 'yesterday' }), JSON.stringify({ ...ENTRY, outcome: 'done' }), JSON.stringify({ ...ENTRY, archive: { name: ZIP } }), JSON.stringify({ ...ENTRY, channel: 3 })]
    const read = readJournal([journalLine(ENTRY).trim(), ...bad].join('\n'))
    expect(read.entries).toEqual([ENTRY])
    expect(read.problems).toEqual(bad.map((_line, index) => `line ${index + 2} is not an entry`))
  })
})

describe('the attestation', () => {
  const NOW = new Date('2026-11-22T12:00:00Z')
  const want = { version: VERSION, sha256: HASH, testPublishedAt: new Date(ENTRY.at), now: NOW }
  const good = { version: VERSION, archiveSha256: HASH, attestedBy: 'The maintainer', attestedAt: '2026-11-21T18:30:00Z', checks: { netflixPlays: true, touchIdUnlocksTheVault: true, updateFromPreviousVersion: true }, updatedFrom: '0.2.15' }
  const problemsOf = (change: Record<string, unknown>, checks: Record<string, unknown> = {}): string[] => attestationProblems(JSON.stringify({ ...good, ...change, checks: { ...good.checks, ...checks } }), want).problems

  it('is named after the archive, and attests three things: Netflix, Touch ID, the update from the previous version', () => {
    expect(attestationNameOf(VERSION)).toBe('Lucium-0.3.0-arm64.attestation.json')
    expect(ATTESTED_CHECKS).toEqual(['netflixPlays', 'touchIdUnlocksTheVault', 'updateFromPreviousVersion'])
  })

  it('lets a version in when it is complete, and gives what the journal keeps of it', () => {
    expect(attestationProblems(JSON.stringify(good), want)).toEqual({ problems: [], attestation: { attestedBy: 'The maintainer', attestedAt: '2026-11-21T18:30:00.000Z' } })
  })

  it('starts as a file where nothing is attested: the template is refused on every check until it is filled in', () => {
    const template = attestationTemplate(VERSION, HASH)
    expect(JSON.parse(template)).toMatchObject({ version: VERSION, archiveSha256: HASH, attestedBy: '' })
    const { problems, attestation } = attestationProblems(template, want)
    expect(attestation).toBeNull()
    for (const name of ATTESTED_CHECKS) expect(problems).toContain(`checks.${name} is not true`)
    expect(problems).toContain('attestedBy must name who made the checks')
    expect(problems).toContain('attestedAt must be the date of the checks, with its time ("2026-11-12T09:30:00Z")')
  })

  it('wants each check to be true, nothing less: false, a word, 1 or a missing key are refused', () => {
    for (const name of ATTESTED_CHECKS) {
      for (const value of [false, 'true', 1, null]) expect(problemsOf({}, { [name]: value }), `${name}: ${String(value)}`).toEqual([`checks.${name} is not true`])
      const { [name]: _left, ...others } = good.checks
      expect(attestationProblems(JSON.stringify({ ...good, checks: others }), want).problems, name).toContain(`checks.${name} is not true`)
    }
    expect(attestationProblems(JSON.stringify({ ...good, checks: 'all good' }), want).problems).toEqual(ATTESTED_CHECKS.map((name) => `checks.${name} is not true`))
  })

  it('is the attestation of this version and of this very archive', () => {
    expect(problemsOf({ version: '0.2.15' })).toEqual(['it is the attestation of "0.2.15", not of 0.3.0'])
    expect(problemsOf({ archiveSha256: OTHER_HASH })).toEqual([expect.stringMatching(/it attests the archive "b{64}", the one being published has SHA-256 a{64}: what was tried is not what goes to stable/)])
  })

  it('names the earlier version the update was installed from', () => {
    expect(problemsOf({ updatedFrom: undefined })).toEqual(['updatedFrom must name the version the update was installed from ("X.Y.Z")'])
    expect(problemsOf({ updatedFrom: 'the previous one' })).toEqual(['updatedFrom must name the version the update was installed from ("X.Y.Z")'])
    expect(problemsOf({ updatedFrom: '0.3.0' })).toEqual(['updatedFrom is 0.3.0, which is not an earlier version than 0.3.0'])
    expect(problemsOf({ updatedFrom: '0.10.0' })).toEqual(['updatedFrom is 0.10.0, which is not an earlier version than 0.3.0'])
    expect(problemsOf({ updatedFrom: '0.2.99' })).toEqual([])
  })

  it('accepts a written reason in place of the update, for a version no earlier one can update to, and only there', () => {
    const reason = { notApplicable: 'First version under the new identifier: no earlier version updates to it' }
    expect(problemsOf({ updatedFrom: undefined }, { updateFromPreviousVersion: reason })).toEqual([])
    expect(problemsOf({}, { updateFromPreviousVersion: { notApplicable: 'n/a' } })).toEqual([`checks.updateFromPreviousVersion.notApplicable must say why, in at least ${MIN_REASON} characters`])
    expect(problemsOf({}, { updateFromPreviousVersion: { notApplicable: true } })).toEqual(['checks.updateFromPreviousVersion is not true'])
    expect(problemsOf({}, { netflixPlays: reason })).toEqual(['checks.netflixPlays is not true'])
    expect(problemsOf({}, { touchIdUnlocksTheVault: reason })).toEqual(['checks.touchIdUnlocksTheVault is not true'])
  })

  it('is signed with a name, and dated after the version reached the test channel and not in the future', () => {
    expect(problemsOf({ attestedBy: '  ' })).toEqual(['attestedBy must name who made the checks'])
    expect(problemsOf({ attestedBy: 7 })).toEqual(['attestedBy must name who made the checks'])
    expect(problemsOf({ attestedAt: '2026-11-21' })).toEqual([expect.stringMatching(/attestedAt must be the date of the checks, with its time/)])
    expect(problemsOf({ attestedAt: '2026-11-20T09:59:59Z' })).toEqual([expect.stringMatching(/attestedAt \(2026-11-20T09:59:59\.000Z\) is before the version reached the test channel \(2026-11-20T10:00:00\.000Z\)/)])
    expect(problemsOf({ attestedAt: '2026-11-22T13:00:00Z' })).toEqual(['attestedAt (2026-11-22T13:00:00.000Z) is in the future'])
    expect(problemsOf({ attestedAt: '2026-11-22T14:00:00+02:00' })).toEqual([])
  })

  it('is refused when it is not a JSON object', () => {
    expect(attestationProblems('Netflix: ok', want)).toEqual({ problems: ['it is not a JSON object'], attestation: null })
  })
})

describe('the lock of the stable channel', () => {
  const at = (iso: string) => new Date(iso)
  const gateOf = (change: Partial<Parameters<typeof stableGate>[0]> = {}) => stableGate({ entries: [ENTRY], withdrawals: [], version: VERSION, sha256: HASH, now: at('2026-11-21T10:00:00Z'), minTestHours: 24, securityFix: null, ...change })

  it('opens when this very archive was published on the test channel long enough ago', () => {
    expect(gateOf()).toEqual({ problems: [], testPublishedAt: ENTRY.at, waived: [] })
  })

  it('stays closed one minute before, and says from when it opens', () => {
    const gate = gateOf({ now: at('2026-11-21T09:59:00Z') })
    expect(gate.problems).toEqual([expect.stringMatching(/^0\.3\.0 has been on the test channel for 23 h 59 \(since 2026-11-20T10:00:00\.000Z\), less than the 24 h it must stay there: it may go to stable from 2026-11-21T10:00:00\.000Z\. A security fix that cannot wait: --security-fix "<reason>"/)])
    expect(gate.testPublishedAt).toBe(ENTRY.at)
  })

  it('opens before the wait is over only with the reason of a security fix, and says what was waived', () => {
    const gate = gateOf({ now: at('2026-11-20T11:30:00Z'), securityFix: 'A page can read the files of the profile' })
    expect(gate).toEqual({ problems: [], testPublishedAt: ENTRY.at, waived: ['0.3.0 has been on the test channel for 1 h 30 (since 2026-11-20T10:00:00.000Z), less than the 24 h it must stay there'] })
  })

  it('stays closed, security fix or not, for a version the test channel never got', () => {
    for (const securityFix of [null, 'A page can read the files of the profile']) {
      for (const entries of [[], [{ ...ENTRY, version: '0.2.15' }], [{ ...ENTRY, channel: 'stable' }], [{ ...ENTRY, outcome: 'partial' as const }]]) {
        expect(gateOf({ entries, securityFix })).toEqual({ problems: [expect.stringMatching(/the journal has no publication of 0\.3\.0 on the test channel/)], testPublishedAt: null, waived: [] })
      }
    }
  })

  it('stays closed for another archive than the one the test channel got', () => {
    expect(gateOf({ sha256: OTHER_HASH }).problems).toEqual([expect.stringMatching(/the test channel got another archive of 0\.3\.0 \(SHA-256 a{64}\), not this one \(b{64}\)/)])
  })

  it('counts from the first complete publication of the archive, whatever the order of the lines', () => {
    const later = { ...ENTRY, at: '2026-11-21T09:00:00.000Z' }
    expect(gateOf({ entries: [later, ENTRY] }).testPublishedAt).toBe(ENTRY.at)
    expect(gateOf({ entries: [later] }).problems).toHaveLength(1)
    // A publication that stopped half way, earlier, does not start the wait.
    expect(gateOf({ entries: [{ ...ENTRY, at: '2026-11-19T10:00:00.000Z', outcome: 'partial' }, later] }).problems).toHaveLength(1)
  })

  describe('for a version withdrawn from the test channel', () => {
    const withdrawal: WithdrawalEntry = { at: '2026-11-20T18:00:00.000Z', type: 'withdrawal', version: VERSION, channel: 'test', outcome: 'withdrawn', offers: 'earlier version', to: '0.2.15' }
    const now = at('2026-11-25T10:00:00Z')
    const refusal = /^0\.3\.0 was withdrawn from the test channel on 2026-11-20T18:00:00\.000Z, and the journal has no publication of this archive there since: a withdrawn version does not go to stable/

    it('stays closed, however long ago it was published there, security fix or not', () => {
      for (const securityFix of [null, 'A page can read the files of the profile']) {
        expect(gateOf({ withdrawals: [withdrawal], now, securityFix })).toEqual({ problems: [expect.stringMatching(refusal)], testPublishedAt: null, waived: [] })
      }
      // A withdrawal that stopped half way was meant all the same.
      expect(gateOf({ withdrawals: [{ ...withdrawal, outcome: 'partial' }], now }).problems).toEqual([expect.stringMatching(refusal)])
    })

    it('opens again only for a publication of the same archive made after the withdrawal, and counts the wait from that one', () => {
      const again = { ...ENTRY, at: '2026-11-22T10:00:00.000Z' }
      expect(gateOf({ entries: [ENTRY, again], withdrawals: [withdrawal], now })).toEqual({ problems: [], testPublishedAt: again.at, waived: [] })
      // The wait already counted before the withdrawal is lost.
      expect(gateOf({ entries: [ENTRY, again], withdrawals: [withdrawal], now: at('2026-11-23T09:59:00Z') }).problems).toEqual([expect.stringMatching(/less than the 24 h it must stay there: it may go to stable from 2026-11-23T10:00:00\.000Z/)])
      // Withdrawn a second time: closed again.
      const second = { ...withdrawal, at: '2026-11-23T08:00:00.000Z' }
      expect(gateOf({ entries: [ENTRY, again], withdrawals: [second, withdrawal], now }).problems).toEqual([expect.stringMatching(/was withdrawn from the test channel on 2026-11-23T08:00:00\.000Z/)])
      // Another archive published after the withdrawal, or a publication that stopped half way, or one at the very instant of the withdrawal, does not open it.
      for (const other of [{ ...again, archive: { ...ARCHIVE, sha256: OTHER_HASH } }, { ...again, outcome: 'partial' as const }, { ...again, at: withdrawal.at }]) {
        expect(gateOf({ entries: [ENTRY, other], withdrawals: [withdrawal], now }).problems).toEqual([expect.stringMatching(refusal)])
      }
    })

    it('is not closed by the withdrawal of another version, or from another channel', () => {
      for (const other of [{ ...withdrawal, version: '0.2.15' }, { ...withdrawal, channel: 'stable' }]) {
        expect(gateOf({ withdrawals: [other], now })).toEqual({ problems: [], testPublishedAt: ENTRY.at, waived: [] })
      }
    })
  })
})

describe('the changelogs of the repository', () => {
  const read = (name: string): string => readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), 'utf8')
  const headingsOf = (text: string): Array<{ version: string; rest: string }> =>
    [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\](.*)$/gm)].map((found) => ({ version: found[1] ?? '', rest: (found[2] ?? '').trim() }))
  const english = headingsOf(read('CHANGELOG.md'))
  const french = headingsOf(read('CHANGELOG.fr.md'))

  it('have the same versions, in the same order, with the same headings', () => {
    expect(english.length).toBeGreaterThan(10)
    expect(french).toEqual(english)
  })

  it('carry the date of every version but the one being prepared: a published version never stays « Unreleased »', () => {
    for (const name of ['CHANGELOG.md', 'CHANGELOG.fr.md']) {
      const text = read(name)
      for (const { version } of english.slice(1)) expect(changelogHeadingProblem(text, version, name), `${name}, ${version}`).toBeNull()
    }
    // The topmost section is the version of package.json: « Unreleased » while it is prepared, its date once it is released.
    const version = (JSON.parse(read('package.json')) as { version: string }).version
    expect(english[0]?.version).toBe(version)
    expect(english[0]?.rest).toMatch(/^- (Unreleased|\d{4}-\d{2}-\d{2})$/)
  })

  it('say each kind of change once per section: a merge leaves no second « Fixed » or « Corrections » under the same version', () => {
    for (const name of ['CHANGELOG.md', 'CHANGELOG.fr.md']) {
      for (const section of read(name).split(/^## /m).slice(1)) {
        const headings = [...section.matchAll(/^### (.+)$/gm)].map((found) => found[1]!.trim())
        expect(headings.filter((heading, at) => headings.indexOf(heading) !== at), `${name}, ## ${section.split('\n')[0]}`).toEqual([])
      }
    }
  })

  it('go back in time from the top: no version is dated before the one under it', () => {
    const dates = english.slice(1).map((heading) => heading.rest.replace(/^- /, ''))
    expect(dates).toEqual([...dates].sort().reverse())
  })
})
