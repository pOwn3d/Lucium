#!/usr/bin/env node
// Sets the report of an engine run against the reference of the engine, and says what the run lost.
//
//   pnpm compat:compare                         the report of the last `pnpm test:engine` (out-engine/report.json) against the reference of the
//                                               highest version in compat/ (compat/baseline-electron-<version>.json)
//   pnpm compat:compare --report <file>         another report
//   pnpm compat:compare --baseline <file>       another reference
//   pnpm compat:compare --explained <file>      the checks of the reference that were removed or renamed on purpose, each with its reason
//                                               ({ "<name of the check>": "<reason>" }): one the run no longer makes is listed with its reason
//                                               instead of being lost. A check that fails or is skipped is never explained away.
//   pnpm compat:compare --limits <file>         the suites a GitHub runner cannot pass (compat/runner-limits.json, src/shared/runner-limits.ts) are left out of
//                                               the reference and of the run before they are compared: only the Smoke (macOS) workflow passes it, the Mac never does.
//                                               Not with --write: a reference is written from a run that judged every suite
//   pnpm compat:baseline                        writes compat/baseline-electron-<version of the run>.json from the report: the new reference,
//                                               to commit once the differences have been read and accepted. It holds what the run made and
//                                               nothing else: a check of the reference before that the run did not make is not kept.
//   pnpm compat:baseline --explained <file>     the same, only when the run lost nothing against the current reference but the checks the file
//                                               explains: otherwise nothing is written, and the losses are listed
//
// Exit code: 0 when the run lost nothing (with --write: the reference is written), 1 when it did (each loss is a line; with --write, nothing is
// written), 2 when a file is missing or cannot be read.
// After an Electron upgrade the reference is the one of the version before: what the upgrade took away is what the comparison lists.
// The rules of the comparison are in src/shared/compat-report.ts, with their tests.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { baselineName, compareReports, latestBaseline, readExplanations, readReport } from '../src/shared/compat-report.ts'
import { readRunnerLimits, withoutLimitedSuites } from '../src/shared/runner-limits.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** @type {(message: string) => never} */
const stop = (message) => {
  console.error(`compat-compare: ${message}`)
  process.exit(2)
}

let args
try {
  args = parseArgs({
    options: { report: { type: 'string' }, baseline: { type: 'string' }, compat: { type: 'string' }, explained: { type: 'string' }, limits: { type: 'string' }, write: { type: 'boolean', default: false } }
  }).values
} catch (error) {
  stop(`${error.message}. Options: --report <file>, --baseline <file>, --compat <folder>, --explained <file>, --limits <file>, --write`)
}

const compatDir = resolve(args.compat ?? join(root, 'compat'))
const reportFile = resolve(args.report ?? join(root, 'out-engine', 'report.json'))

const readJson = (file, what, read) => {
  if (!existsSync(file)) stop(`${what} not found: ${file}${what === 'the report' ? ' (pnpm test:engine writes it, on a Mac that is not in use)' : ''}`)
  try {
    return read(JSON.parse(readFileSync(file, 'utf8')), file)
  } catch (error) {
    stop(`${what} cannot be read: ${error.message}`)
  }
}
const load = (file, what) => readJson(file, what, readReport)

if (args.limits !== undefined && args.write) stop('--limits cannot go with --write: a reference is written from a run that judged every suite')
const limitsFile = args.limits === undefined ? null : resolve(args.limits)
const limits = limitsFile === null ? {} : readJson(limitsFile, 'the limits', readRunnerLimits)
const run = withoutLimitedSuites(load(reportFile, 'the report'), limits)
const explanationsFile = args.explained === undefined ? null : resolve(args.explained)
const explanations = explanationsFile === null ? null : readJson(explanationsFile, 'the explanations', readExplanations)
const describe = (report) => `Electron ${report.engine.version} (Chromium ${report.engine.chromium}), ${Object.keys(report.suites).length} suite(s), ${Object.values(report.suites).reduce((total, suite) => total + suite.checks.length, 0)} checks`

/** Sets the run against the reference, prints what changed, and answers the number of losses. */
const compare = () => {
  const baselineFile = args.baseline ? resolve(args.baseline) : (() => {
    const latest = existsSync(compatDir) ? latestBaseline(readdirSync(compatDir)) : null
    if (latest === null) stop(`no reference in ${compatDir} (baseline-electron-<version>.json): pnpm compat:baseline writes one from the report`)
    return join(compatDir, latest)
  })()
  const reference = withoutLimitedSuites(load(baselineFile, 'the reference'), limits)

  console.log(`compat-compare`)
  console.log(`  reference: ${baselineFile}\n             ${describe(reference)}`)
  console.log(`  run:       ${reportFile}\n             ${describe(run)}`)
  if (explanationsFile !== null) console.log(`  explained: ${explanationsFile}, ${Object.keys(explanations).length} check(s)`)
  if (limitsFile !== null) console.log(`  left out:  ${Object.keys(limits).join(', ') || 'no suite'} (the limits of the runner, ${limitsFile}): they are not compared`)
  if (reference.engine.version !== run.engine.version) {
    console.log(`  The reference is of another version of Electron: the comparison says what changed between the two. Once the differences are accepted, pnpm compat:baseline writes the reference of ${run.engine.version}.`)
  }

  const { regressions, news, explained, unusedExplanations } = compareReports(reference, run, explanations ?? {})
  if (news.length > 0) console.log(`\n${news.length} new or better (not in the reference):\n${news.map((line) => `  + ${line}`).join('\n')}`)
  if (explained.length > 0) console.log(`\n${explained.length} no longer made, and explained:\n${explained.map((line) => `  ~ ${line}`).join('\n')}`)
  if (unusedExplanations.length > 0) {
    console.log(`\n${unusedExplanations.length} explanation(s) match nothing the run lost (the check is still made, or the name is not the one of the reference):\n${unusedExplanations.map((name) => `  ? ${name}`).join('\n')}`)
  }
  if (regressions.length > 0) console.log(`\n${regressions.length} lost (the reference had it, the run does not):\n${regressions.map((line) => `  - ${line}`).join('\n')}`)
  else if (explained.length > 0) console.log(`\nNothing lost but the ${explained.length} check(s) explained: everything else the reference proved, the run proves.`)
  else console.log('\nNothing lost: everything the reference proved, the run proves.')
  return regressions.length
}

if (args.write) {
  // With explanations, a reference is only written when every check it leaves out of the one before has its reason.
  if (explanations !== null && compare() > 0) {
    console.log(`\nReference not written: the run lost checks that ${explanationsFile} does not explain.`)
    process.exit(1)
  }
  const target = join(compatDir, baselineName(run.engine.version))
  mkdirSync(compatDir, { recursive: true })
  writeFileSync(target, `${JSON.stringify(run, null, 2)}\n`)
  console.log(`compat-compare: reference written: ${target}`)
  console.log(`  ${describe(run)}`)
  const failed = Object.entries(run.suites).flatMap(([suite, { checks }]) => checks.filter((check) => !check.ok).map((check) => `${suite}: ${check.name}`))
  if (failed.length > 0) console.log(`  ${failed.length} check(s) failed in this run and are recorded as known failures:\n${failed.map((line) => `    ${line}`).join('\n')}`)
  process.exit(0)
}

process.exit(compare() > 0 ? 1 : 0)
