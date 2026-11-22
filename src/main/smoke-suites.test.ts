import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chooseSuite } from './smoke-kit'
import { CHAIN, SUITES } from './smoke-suites'

// The table of the engine suites is the only list of them. What it must never let happen again: a suite file that no command starts
// (smoke-extwindows.ts and its 34 checks were reachable by a name that no script, no workflow and no document gave).

const source = (file: string): string => readFileSync(join(__dirname, file), 'utf8')
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> }

/** The files of the suites: every smoke*.ts but the tools of the run and the tests. */
const suiteFiles = readdirSync(__dirname).filter((file) => /^smoke.*\.ts$/.test(file) && !file.endsWith('.test.ts') && !['smoke-kit.ts', 'smoke-probe-kit.ts', 'smoke-engine-facts-kit.ts', 'smoke-run.ts', 'smoke-suites.ts'].includes(file))

describe('the table of the engine suites', () => {
  it('gives each suite one name', () => {
    const names = SUITES.map((suite) => suite.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it('loads every suite file, or the principal suite does as one of its parts: no suite is left that nothing starts', () => {
    const table = source('smoke-suites.ts')
    const principal = source('smoke.ts')
    const orphans = suiteFiles.filter((file) => {
      const module = file.replace(/\.ts$/, '')
      return !table.includes(`import('./${module}')`) && !new RegExp(`^import \\{[^}]*\\} from '\\./${module}'$`, 'm').test(principal)
    })
    expect(suiteFiles.length).toBeGreaterThan(60)
    expect(orphans).toEqual([])
  })

  it('says of each suite that is not in the chain why it is not', () => {
    for (const suite of SUITES.filter((entry) => !entry.chain)) expect(suite.order, suite.name).toMatch(/\S/)
  })

  it('starts the chain with the principal suite and keeps the window counts first: the suites that open private windows come after `windows`', () => {
    const order = CHAIN.map((suite) => suite.name)
    expect(order.slice(0, 2)).toEqual(['main', 'windows'])
    for (const later of ['blocker', 'sitedata', 'market', 'iso-panels', 'sec1-late']) expect(order.indexOf(later), later).toBeGreaterThan(order.indexOf('windows'))
    expect(order.at(-1)).toBe('sec1-late')
  })

  it('runs the two suites of open questions in the chain, each from its own file, before the About group and the last security checks', () => {
    const order = CHAIN.map((suite) => suite.name)
    const table = source('smoke-suites.ts')
    for (const [name, module, runner] of [['probes-web', 'smoke-probes-web', 'runProbesWebSmoke'], ['probes-ext', 'smoke-probes-ext', 'runProbesExtSmoke']] as const) {
      const entry = SUITES.find((suite) => suite.name === name)
      expect(entry?.chain, name).toBe(true)
      expect(entry?.driver, name).toBeUndefined()
      expect(entry?.what, name).toMatch(/\S/)
      expect(table, name).toContain(`run: async (context) => (await import('./${module}')).${runner}(context)`)
      expect(order.indexOf(name), name).toBeGreaterThan(order.indexOf('windows'))
      expect(order.indexOf(name), name).toBeLessThan(order.indexOf('about'))
    }
    // The extension suite loads its probes itself: the chain does not hand them to every other suite through LUCIUM_EXTENSIONS.
    for (const folder of ['net-rules-probe', 'active-tab-scripting-probe', 'optional-permission-probe']) expect(packageJson.scripts['test:engine'], folder).not.toContain(`compat/${folder}`)
  })

  it('keeps the Client Hints check out of the chain (its fix of the first navigation has not run yet), loads it from its own file, and lets LUCIUM_SMOKE_ONLY name it', () => {
    const entry = SUITES.find((suite) => suite.name === 'client-hints')
    expect(entry?.chain).toBe(false)
    expect(entry?.driver).toBeUndefined()
    expect(entry?.what).toMatch(/LUCIUM_SMOKE_CLIENT_HINTS/)
    expect(entry?.order).toMatch(/LUCIUM_SMOKE_ONLY=client-hints/)
    expect(source('smoke-suites.ts')).toContain(`run: async (context) => (await import('./smoke-client-hints')).runClientHintsSmoke(context)`)
    expect(CHAIN.map((suite) => suite.name)).not.toContain('client-hints')
    expect(chooseSuite('client-hints', SUITES.map((suite) => suite.name))).toEqual({ kind: 'only', name: 'client-hints' })
  })

  it('gives no time limit and no count to the drivers, which wait to be stopped or only measure, and keeps them out of the chain', () => {
    const drivers = SUITES.filter((suite) => suite.driver)
    expect(drivers.map((suite) => suite.name).sort()).toEqual(['favicons-measure', 'perf', 'webstore-live'])
    for (const driver of drivers) expect(driver.chain, driver.name).toBe(false)
  })

  it('refuses the name of a part of the principal suite and a misspelt name, which used to start the whole chain', () => {
    const names = SUITES.map((suite) => suite.name)
    for (const wrong of ['sidebar', 'settings', 'pages', 'sleep', 'iso-menus', 'commandbar', 'extwindow', 'smoke']) expect(chooseSuite(wrong, names).kind, wrong).toBe('unknown')
    for (const right of ['main', 'parts', 'extwindows', 'webstore', 'sec1', 'sec1-late', 'perf']) expect(chooseSuite(right, names)).toEqual({ kind: 'only', name: right })
  })
})

describe('the commands of the engine suites (package.json)', () => {
  const scripts = packageJson.scripts

  it('has a command for each suite that must run in an application of its own, and one that runs the three', () => {
    expect(scripts['test:engine:webstore']).toContain('LUCIUM_SMOKE_ONLY=webstore electron . --smoke')
    expect(scripts['test:engine:extwindows']).toContain('LUCIUM_SMOKE_ONLY=extwindows electron . --smoke')
    expect(scripts['test:engine:all']).toBe('pnpm test:engine; chain=$?; pnpm test:engine:webstore; store=$?; pnpm test:engine:extwindows; windows=$?; exit $((chain || store || windows))')
    // Each name a command passes is one of the table.
    const names = SUITES.map((suite) => suite.name)
    for (const script of Object.values(scripts)) for (const [, name] of script.matchAll(/LUCIUM_SMOKE_ONLY=([\w-]+)/g)) expect(names).toContain(name)
  })

  it('removes the throw-away profile of a run and keeps the exit code of the run', () => {
    for (const name of ['test:engine', 'test:engine:webstore', 'test:engine:extwindows']) {
      const script = scripts[name] ?? ''
      expect(script, name).toMatch(/profile="\$\(mktemp -d\)"; .*electron \. --smoke --user-data-dir="\$profile"; code=\$\?; rm -rf "\$profile"; exit \$code; \}$/)
      expect(script, name).not.toContain('--user-data-dir="$(mktemp -d)"')
    }
  })

  it('loads the probes of compat/ in the chain and keeps its report for the comparison with the reference', () => {
    const chain = scripts['test:engine'] ?? ''
    for (const probe of ['api-probe', 'sidepanel-probe', 'surface-probe', 'shim-guard-probe', 'no-permission-probe', 'sec-driver-probe', 'active-tab-probe', 'data-api-probe', 'data-api-denied-probe', 'keyext-probe']) {
      expect(chain).toContain(`$PWD/compat/${probe}`)
    }
    expect(chain).toContain('LUCIUM_SMOKE_REPORT="${LUCIUM_SMOKE_REPORT:-$PWD/out-engine/report.json}"')
    expect(scripts['compat:compare']).toContain('scripts/compat-compare.mjs')
    expect(scripts['compat:baseline']).toMatch(/scripts\/compat-compare\.mjs --write$/)
  })
})
