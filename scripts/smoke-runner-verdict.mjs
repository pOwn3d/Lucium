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
//
// Exit code: 0 when every suite that failed is in the list, 1 when one is not (or when the chain failed and no suite shows it), 2 when a file is missing or cannot be read.

import { existsSync, readFileSync } from 'node:fs'
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
  args = parseArgs({ options: { report: { type: 'string' }, limits: { type: 'string' }, 'chain-code': { type: 'string' } } }).values
} catch (error) {
  stop(`${error.message}. Options: --report <file>, --limits <file>, --chain-code <n>`)
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

const verdict = judgeRun(report, limits)
const suites = Object.keys(report.suites).length
console.log(`smoke-runner-verdict: ${suites} suite(s) in ${reportFile}, ${Object.keys(limits).length} named in ${limitsFile}`)
if (verdict.tolerated.length > 0) console.log(`\n${verdict.tolerated.length} failed and excused (the limits of the runner):\n${verdict.tolerated.map(({ suite, reason }) => `  ~ ${suite}: ${reason}`).join('\n')}`)
if (verdict.stale.length > 0) console.log(`\n${verdict.stale.length} named in the limits and passed (the limit may be gone):\n${verdict.stale.map((suite) => `  ? ${suite}`).join('\n')}`)
if (verdict.absent.length > 0) console.log(`\n${verdict.absent.length} named in the limits and not in the report (renamed, removed or not run):\n${verdict.absent.map((suite) => `  ? ${suite}`).join('\n')}`)

if (verdict.unexpected.length > 0) {
  console.log(`\n${verdict.unexpected.length} failed and not excused:\n${verdict.unexpected.map((suite) => `  - ${suite}`).join('\n')}`)
  process.exit(1)
}
if (chainCode !== 0 && verdict.tolerated.length === 0) {
  console.log(`\nThe chain ended with code ${chainCode} and no suite of the report failed: it was stopped or it crashed, and that is not excused.`)
  process.exit(1)
}
console.log('\nEvery suite that failed is a limit of the runner; the others passed.')
