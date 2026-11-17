import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FEATURES } from '@shared/features'
import { budgetGaps, budgetIncoherences, MEASURE_IDS, parseBudget, SCENARIO_IDS, SCENARIOS } from '@shared/perf-core'
import { COST_CLASS_PERF, featuresWithoutCostClass, PERF_SKIPPED } from '@shared/perf-features'

// The files of `pnpm perf` that must agree with the code: the budget, the document, the script of package.json and the module the script loads.

const here = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url))
const read = (relative: string) => readFileSync(here(relative), 'utf8')

describe('the registry and the measures', () => {
  // The test that fails when a function is added to the registry without a class of cost the measures know how to treat.
  it('every function of the registry has a cost class that pnpm perf describes', () => {
    expect(featuresWithoutCostClass(FEATURES), 'Ajoutez la classe de coût à COST_CLASS_PERF (src/shared/perf-features.ts) ou corrigez `cost` dans src/shared/features.ts.').toEqual([])
  })
})

describe('perf-budget.json', () => {
  const raw: unknown = JSON.parse(read('perf-budget.json'))

  it('is a valid budget: known scenarios, measures the scenarios make, numbers in range', () => {
    expect(parseBudget(raw).errors).toEqual([])
  })

  it('gives a limit to every scenario and every measure the scenarios require', () => {
    const { budget } = parseBudget(raw)
    expect(budgetGaps(budget!)).toEqual([])
    expect(Object.keys(budget!.scenarios).sort()).toEqual([...SCENARIO_IDS].sort())
  })

  it('fails for a scenario the measures do not know', () => {
    const mutated = { ...(raw as object), scenarios: { ...(raw as { scenarios: object }).scenarios, 'tabs-500': { rssTotalMb: { baseline: 1 } } } }
    expect(parseBudget(mutated).errors.join()).toContain('scénario inconnu : tabs-500')
  })

  it('names the machine the figures were taken on', () => {
    const { budget } = parseBudget(raw)
    expect(budget!.reference.cpu.length).toBeGreaterThan(2)
    expect(budget!.reference.memoryGb).toBeGreaterThan(0)
  })
})

describe('docs/performance.md', () => {
  const doc = read('docs/performance.md')
  const has = (id: string) => doc.includes(`\`${id}\``)

  it('describes every scenario, every measure and every class of cost, by its id between backticks', () => {
    expect(SCENARIO_IDS.filter((id) => !has(id))).toEqual([])
    expect(MEASURE_IDS.filter((id) => !has(id))).toEqual([])
    expect(Object.keys(COST_CLASS_PERF).filter((id) => !has(id))).toEqual([])
  })

  // The document must not go on saying that the budget is to be calibrated again once it was, nor keep silent while it is not.
  it('says that the thresholds are to be calibrated again exactly while the budget holds baselines that cannot both be right', () => {
    const { budget } = parseBudget(JSON.parse(read('perf-budget.json')))
    expect(doc.includes('## Seuils à recalibrer'), 'Après une recalibration, retirez la section « Seuils à recalibrer » de docs/performance.md (ou remettez-la si les références sont de nouveau incohérentes).').toBe(budgetIncoherences(budget!).length > 0)
  })

  it('names the features that “toutes allumées” leaves aside', () => {
    expect(Object.keys(PERF_SKIPPED).filter((id) => !has(id))).toEqual([])
  })

  it('shows the commands and the options', () => {
    for (const text of ['pnpm perf', 'perf-budget.json', '--write-budget', '--compare', '--only', '--max-regression', '--repeat']) expect(doc, text).toContain(text)
  })

  it('gives the duration of the measure of the processor', () => {
    expect(doc).toContain('30 s')
    expect(SCENARIOS.length).toBeGreaterThan(0)
  })
})

describe('the script', () => {
  it('is the `perf` script of package.json, which Node loads without the warning about the module type of the sources it imports', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
    expect(scripts['perf']).toContain('scripts/perf.mjs')
    expect(scripts['perf']).toContain('--disable-warning=MODULE_TYPELESS_PACKAGE_JSON')
    expect(existsSync(here('scripts/perf.mjs'))).toBe(true)
  })

  it('loads the module of src/shared as plain Node does (type stripping): nothing imported at run time, nothing that cannot be erased', () => {
    const script = `import * as core from ${JSON.stringify(here('src/shared/perf-core.ts'))}; process.stdout.write(JSON.stringify([core.parseCpuTime('1:02.50'), core.SCENARIO_IDS.length]))`
    const out = execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(JSON.parse(out)).toEqual([62.5, SCENARIOS.length])
  })

  it('keeps its reports out of the repository', () => {
    expect(read('.gitignore').split('\n')).toContain('.perf/')
  })
})
