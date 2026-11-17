// What a GitHub runner cannot do for the engine checks, and the verdict of a run there. The checks of the suites were written and run on the Mac of the maintainer
// (a Retina screen, the animations on) and the runner of the Smoke (macOS) workflow is a virtual machine with one screen of 1024 x 768 points at scale 1, which leaves a
// window about 675 points tall. A suite whose checks cannot hold there is named in compat/runner-limits.json with the reason: the workflow does not run it (LUCIUM_SMOKE_SKIP), and only that workflow reads the file:
// `pnpm test:engine` and `pnpm compat:compare` on the Mac read nothing from it, and judge every suite. No Electron, no Node here: the script
// (scripts/smoke-runner-verdict.mjs, scripts/compat-compare.mjs) and the unit tests both load this file.

import type { CompatReport, ReportSuite } from './compat-report'

/**
 * The suites that cannot pass on a GitHub runner, by name of the table of suites (src/main/smoke-suites.ts), each with why; `main:<part>` names a part of the
 * principal suite. The Smoke (macOS) workflow does not run them (LUCIUM_SMOKE_SKIP, which smoke-kit.ts reads): what they fail would also leave open, for the
 * suites after them, what those suites are sensitive to.
 */
export type RunnerLimits = Record<string, string>

/** Whether a name of the list is a part of the principal suite, not a suite. */
export const isPart = (name: string): boolean => name.startsWith('main:')

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reads compat/runner-limits.json: `{ "<suite>": "<reason>" }`. A suite without a reason is refused: it would let a failure pass unread. */
export function readRunnerLimits(raw: unknown, where: string): RunnerLimits {
  if (!isRecord(raw)) throw new Error(`${where}: not a list of limits (an object { "<suite>": "<reason>" } is expected)`)
  const limits: RunnerLimits = {}
  for (const [suite, reason] of Object.entries(raw)) {
    if (typeof reason !== 'string' || reason.trim() === '') throw new Error(`${where}: the suite "${suite}" has no reason`)
    limits[suite] = reason.trim()
  }
  return limits
}

/** Whether a suite of a report failed: its own code, or a check that did not pass (a check that was skipped did not fail). */
export const suiteFailed = (suite: ReportSuite): boolean => suite.code !== 0 || suite.checks.some((check) => !check.ok && check.skipped !== true)

export interface RunVerdict {
  /** The suites that failed and are not in the limits: any one of them fails the run. */
  unexpected: string[]
  /** The suites that failed and are in the limits, with the reason. */
  tolerated: Array<{ suite: string; reason: string }>
  /** The suites of the limits that ran and passed (the workflow leaves them out, so someone ran them): the limit may be gone, to look at. They do not fail the run. */
  stale: string[]
  /** The suites of the limits that the report does not have: left out on request, as the workflow does, or renamed or removed. */
  notRun: string[]
}

/** Sorts the suites of a report into the ones that fail the run and the ones the limits excuse. */
export function judgeRun(report: CompatReport, limits: Readonly<RunnerLimits>): RunVerdict {
  const verdict: RunVerdict = { unexpected: [], tolerated: [], stale: [], notRun: [] }
  for (const [name, suite] of Object.entries(report.suites)) {
    const reason = Object.hasOwn(limits, name) ? limits[name] : undefined
    if (suiteFailed(suite)) {
      if (reason === undefined) verdict.unexpected.push(name)
      else verdict.tolerated.push({ suite: name, reason })
    } else if (reason !== undefined) verdict.stale.push(name)
  }
  verdict.notRun = Object.keys(limits).filter((name) => !isPart(name) && !Object.hasOwn(report.suites, name))
  return verdict
}

/** The same report without the suites of the limits: what the comparison with the reference of the Mac can still say of a run on a runner. */
export function withoutLimitedSuites(report: CompatReport, limits: Readonly<RunnerLimits>): CompatReport {
  return { ...report, suites: Object.fromEntries(Object.entries(report.suites).filter(([name]) => !Object.hasOwn(limits, name))) }
}
