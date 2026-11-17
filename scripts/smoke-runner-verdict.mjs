#!/usr/bin/env node
// The verdict of the Smoke (macOS) workflow on the engine chain, which runs on a GitHub runner and cannot pass every suite there (the screen is 1024 x 768 at
// scale 1: src/shared/runner-limits.ts). The suites that cannot are named, each with its reason, in compat/runner-limits.json. This says which suites of the
// report failed outside that list, and fails the run for those and only those. Nothing on the Mac reads the list.
//
//   node scripts/smoke-runner-verdict.mjs                     the report of the chain (out-engine/report.json), the limits of compat/runner-limits.json
//   node scripts/smoke-runner-verdict.mjs --report <file>     another report
//   node scripts/smoke-runner-verdict.mjs --limits <file>     another list
//   node scripts/smoke-runner-verdict.mjs --chain-code <n>    the exit code of `pnpm test:engine`: a chain that failed (or was stopped) with no suite
//                                                             of the report failed has crashed, and that is not excused
//   node scripts/smoke-runner-verdict.mjs --print-unexpected  only the names of the suites that failed and are not in the list, one per line (exit 0): the
//                                                             workflow runs each of them again alone
//   node scripts/smoke-runner-verdict.mjs --again <folder>    the reports of those suites run again alone (<folder>/again-<suite>.json): one that passes
//                                                             alone is flaky, said and not counted; one that fails alone, or has no report, is not excused
//
// The suites of the list are not run by the workflow (LUCIUM_SMOKE_SKIP): they are listed here as not run, with their reason.
// Exit code: 0 when every suite that failed is in the list, 1 when one is not (or when the chain failed and no suite shows it), 2 when a file is missing or cannot be read.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readReport } from '../src/shared/compat-report.ts'
import { judgeRun, readRunnerLimits } from '../src/shared/runner-limits.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** @type {(message: string) => never} */
const stop = (message) => {
  console.error(`smoke-runner-verdict: ${message}`)
  process.exit(2)
}

let args
try {
  args = parseArgs({ options: { report: { type: 'string' }, limits: { type: 'string' }, 'chain-code': { type: 'string' }, 'print-unexpected': { type: 'boolean', default: false }, again: { type: 'string' } } }).values
} catch (error) {
  stop(`${error.message}. Options: --report <file>, --limits <file>, --chain-code <n>, --print-unexpected, --again <folder>`)
}

const readJson = (file, what, read) => {
  if (!existsSync(file)) stop(`${what} not found: ${file}`)
  try {
    return read(JSON.parse(readFileSync(file, 'utf8')), file)
  } catch (error) {
    stop(`${what} cannot be read: ${error.message}`)
  }
}

const reportFile = resolve(args.report ?? join(root, 'out-engine', 'report.json'))
const limitsFile = resolve(args.limits ?? join(root, 'compat', 'runner-limits.json'))
const report = readJson(reportFile, 'the report', readReport)
const limits = readJson(limitsFile, 'the limits', readRunnerLimits)
// An empty code is the workflow saying the chain left none (the step died before it wrote it): refused, not read as 0.
if (args['chain-code'] !== undefined && !/^\d+$/.test(args['chain-code'])) stop(`--chain-code is not a number: "${args['chain-code']}"`)
const chainCode = args['chain-code'] === undefined ? 0 : Number(args['chain-code'])

// The reports of the suites run again alone, by suite: the file of a suite that does not read is not one that passed.
const again = {}
if (args.again !== undefined) {
  const folder = resolve(args.again)
  if (!existsSync(folder)) stop(`the folder of the suites run again not found: ${folder}`)
  for (const file of readdirSync(folder)) {
    const match = /^again-(.+)\.json$/.exec(file)
    if (match === null) continue
    try {
      again[match[1]] = readReport(JSON.parse(readFileSync(join(folder, file), 'utf8')), file)
    } catch (error) {
      console.log(`smoke-runner-verdict: ${file} cannot be read (${error.message}): the suite is not counted as having passed alone`)
    }
  }
}

const verdict = judgeRun(report, limits, again)
if (args['print-unexpected']) {
  // The ones the first reading leaves: those that failed and are not in the list, whether or not a report of a second run is there.
  for (const suite of judgeRun(report, limits).unexpected) console.log(suite)
  process.exit(0)
}
const suites = Object.keys(report.suites).length
console.log(`smoke-runner-verdict: ${suites} suite(s) in ${reportFile}, ${Object.keys(limits).length} named in ${limitsFile}`)
if (verdict.tolerated.length > 0) console.log(`\n${verdict.tolerated.length} failed and excused (the limits of the runner):\n${verdict.tolerated.map(({ suite, reason }) => `  ~ ${suite}: ${reason}`).join('\n')}`)
if (verdict.flaky.length > 0) console.log(`\n${verdict.flaky.length} failed in the chain and passed when run again alone (flaky on the runner, not counted):\n${verdict.flaky.map((suite) => `  ! ${suite}`).join('\n')}`)
if (verdict.notRun.length > 0) console.log(`\n${verdict.notRun.length} named in the limits and not run (left out on request, as the workflow does):\n${verdict.notRun.map((suite) => `  - ${suite}: ${limits[suite]}`).join('\n')}`)
if (verdict.stale.length > 0) console.log(`\n${verdict.stale.length} named in the limits and passed (the limit may be gone):\n${verdict.stale.map((suite) => `  ? ${suite}`).join('\n')}`)

if (verdict.unexpected.length > 0) {
  console.log(`\n${verdict.unexpected.length} failed and not excused:\n${verdict.unexpected.map((suite) => `  - ${suite}`).join('\n')}`)
  process.exit(1)
}
if (chainCode !== 0 && verdict.tolerated.length === 0 && verdict.flaky.length === 0) {
  console.log(`\nThe chain ended with code ${chainCode} and no suite of the report failed: it was stopped or it crashed, and that is not excused.`)
  process.exit(1)
}
console.log('\nEvery suite that failed is a limit of the runner; the others passed.')
