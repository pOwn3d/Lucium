import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Two workflows checked as text, because what they must never do happens silently once they run on GitHub: the second pass of the secret scan
// must report without failing and without publishing a secret, and the macOS smoke run must stay manual, on tags, and cheap.
const here = (relative: string) => fileURLToPath(new URL(`../../${relative}`, import.meta.url))
const read = (relative: string) => readFileSync(here(relative), 'utf8')

/** The lines that are not comments, so that a comment saying "no --fail" cannot pass for code. */
const code = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')

/** The text of a job, from its name to the next job (or the end). */
const job = (workflow: string, name: string): string => {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  expect(start, name).toBeGreaterThanOrEqual(0)
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/)
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next)
}

describe('every workflow', () => {
  const workflows = readdirSync(here('.github/workflows')).filter((file) => file.endsWith('.yml'))
  // The local actions hold steps too: they are read like the workflows.
  const actions = readdirSync(here('.github/actions')).map((name) => `.github/actions/${name}/action.yml`)

  it('pins each action it uses by commit, with the version in a comment, in the workflows and in the local actions', () => {
    expect(workflows).toContain('smoke-macos.yml')
    expect(actions).toContain('.github/actions/setup/action.yml')
    for (const file of [...workflows.map((name) => `.github/workflows/${name}`), ...actions]) {
      const uses = read(file).split('\n').filter((line) => /^\s*(- )?uses:\s/.test(line))
      for (const line of uses) {
        // A local action is called by its folder, which holds an action.yml; anything else is pinned by commit.
        const local = /^\s*(- )?uses: \.\/(\.github\/actions\/[a-z][a-z-]*)$/.exec(line)?.[2]
        if (local) expect(actions, `${file}: ${line}`).toContain(`${local}/action.yml`)
        else expect(line, file).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/)
      }
    }
  })
})

describe('.github/workflows/secret-scanning.yml', () => {
  const workflow = code(read('.github/workflows/secret-scanning.yml'))
  const first = job(workflow, 'secrets')
  const second = job(workflow, 'unverified')

  it('keeps the first pass: verified findings only, and the build fails on them', () => {
    expect(first).toMatch(/uses: trufflesecurity\/trufflehog@[0-9a-f]{40}/)
    expect(first).toMatch(/extra_args: --only-verified\n/)
    expect(first).toMatch(/Secrets detected[\s\S]*exit 1/)
  })

  it('adds a second pass without --only-verified, which has no --fail and does not use the action that forces it', () => {
    expect(second.length).toBeGreaterThan(300)
    expect(second).not.toMatch(/only-verified|--results=verified/)
    expect(second).not.toMatch(/--fail\b/)
    expect(second).not.toMatch(/uses: trufflesecurity\/trufflehog/)
    expect(second).toMatch(/docker run --rm -v "\$PWD:\/tmp" -w \/tmp "\$IMAGE" "\$\{args\[@\]\}"/)
    expect(second).toMatch(/args=\(git file:\/\/\/tmp\/ --branch "\$\(git rev-parse HEAD\)" --no-update --json\)/)
  })

  it('runs one scanner in the two passes: the release the action is pinned to, by the digest of its image', () => {
    const image = /IMAGE: ghcr\.io\/trufflesecurity\/trufflehog:(\d+\.\d+\.\d+)@(sha256:[0-9a-f]{64})\n/.exec(second)
    expect(image).not.toBeNull()
    // The action of the first pass: pinned to the commit of that release, and told to run that image (alone, it would run `latest`).
    expect(first).toMatch(new RegExp(`uses: trufflesecurity/trufflehog@[0-9a-f]{40} # v${image?.[1]?.replaceAll('.', '\\.')}\\n`))
    expect(first).toContain(`\n          version: ${image?.[1]}@${image?.[2]}\n`)
    expect(workflow).not.toMatch(/trufflehog:latest/)
  })

  it('scans the same range as the first pass: the one a step works out, the same step in the two jobs', () => {
    const range = (text: string): string | undefined => /\n {6}- name: Range to scan\n {8}id: range\n[\s\S]*?\n(?= {6}- name: )/.exec(text)?.[0]
    expect(range(first)?.length).toBeGreaterThan(400)
    expect(range(second)).toBe(range(first))
    expect(first).toMatch(/\n {10}base: \$\{\{ steps\.range\.outputs\.base \}\}\n {10}head: HEAD\n/)
    expect(second).toMatch(/\n {10}BASE: \$\{\{ steps\.range\.outputs\.base \}\}\n/)
    expect(second).toMatch(/if \[ -n "\$BASE" \]; then args\+=\(--since-commit "\$BASE"\); fi/)
    // The event's "before" is never handed to the scanner as it comes: after a forced push it names a commit that is not there.
    expect(workflow.match(/github\.event\.before/g)).toHaveLength(2)
    expect(workflow).toMatch(/if \[ -n "\$base" \] && ! git cat-file -e "\$base\^\{commit\}" 2>\/dev\/null; then\n[^\n]*\n\s+base=''\n/)
  })

  it('reads the whole history again every week and on demand, and bounds the two jobs in time', () => {
    expect(workflow).toMatch(/^ {2}schedule:\n {4}- cron: '\d+ \d+ \* \* \d'\n {2}workflow_dispatch:$/m)
    for (const text of [first, second]) {
      expect(text).toMatch(/\n {4}timeout-minutes: 15\n/)
      expect(text).toMatch(/\n {10}fetch-depth: 0\n/)
    }
  })

  it('removes the secrets from the findings before they are uploaded, and uploads nothing else', () => {
    // The raw results are written outside the folder of the artifact, then stripped of Raw and RawV2 (they hold the secret itself).
    expect(second).toMatch(/> "\$RUNNER_TEMP\/trufflehog-raw\.json"/)
    expect(second).toMatch(/jq -c 'del\(\.Raw, \.RawV2\)' "\$RUNNER_TEMP\/trufflehog-raw\.json" > findings\/trufflehog-unverified\.json/)
    expect(second).not.toMatch(/findings\/[^\n]*raw/)
    expect(second).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}name: trufflehog-unverified\n {10}path: findings\/\n/)
  })

  it('does not fail the build on what it finds, and says how many there are', () => {
    expect(second).toMatch(/::warning title=TruffleHog, unverified findings::\$COUNT finding\(s\)/)
    // The only failure of this job is a base that is no commit id, in the step that works out the range: nothing after it fails on a finding.
    expect(second.slice(second.indexOf('- name: TruffleHog, all findings'))).not.toMatch(/exit 1/)
    expect(second.match(/exit 1/g)).toHaveLength(1)
  })

  it('has a read-only token and no secret', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m)
    expect(workflow).not.toMatch(/secrets\.|contents: write|pull_request_target/)
  })
})

describe('.github/workflows/smoke-macos.yml', () => {
  const workflow = code(read('.github/workflows/smoke-macos.yml'))
  const ci = code(read('.github/workflows/ci.yml'))

  it('starts by hand, on a tag or once a week, never on a push to a branch or a pull request (macOS minutes cost ten times the Linux ones)', () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n {2}push:\n {4}tags: \['v\*'\]\n {2}schedule:\n {4}- cron: '0 6 \* \* 1'\n/m)
    expect(workflow).not.toMatch(/^ {2}(pull_request|pull_request_target):/m)
    expect(workflow).not.toMatch(/branches:/)
    expect(workflow.match(/cron:/g)).toHaveLength(1)
  })

  it('runs the engine checks that open windows on a macOS runner, and refuses a machine that is not Apple silicon', () => {
    expect(workflow).toMatch(/runs-on: macos-latest/)
    expect(workflow).toMatch(/\[ "\$\(uname -m\)" = "arm64" \]/)
    expect(workflow).toMatch(/pnpm test:engine 2>&1 \| tee out-engine\/engine\.log\n/)
  })

  it('keeps the log of the chain without hiding its exit code behind the pipe, and writes the code down for the verdict', () => {
    expect(workflow).toMatch(
      /- name: Engine checks\n {8}id: chain\n {8}if: \$\{\{ !cancelled\(\) \}\}\n {8}shell: bash\n {8}run: \|\n {10}mkdir -p out-engine\n(?: {10}.*\n)*? {10}set \+e\n {10}pnpm test:engine 2>&1 \| tee out-engine\/engine\.log\n {10}echo "code=\$\{PIPESTATUS\[0\]\}" >> "\$GITHUB_OUTPUT"\n/
    )
    expect(workflow).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}name: engine-run\n {10}path: out-engine\/\n/)
  })

  // The suites of compat/runner-limits.json cannot pass on a runner (a virtual machine with a screen of 1024 x 768 points): the workflow does not run them (LUCIUM_SMOKE_SKIP), they are judged
  // on the Mac, which reads no list. Any other suite that fails stops this run, and so does a chain that ended badly with no suite to show for it. The comparison with
  // the reference of a Retina Mac is printed and does not decide on a runner.
  it('leaves the suites of the limits of the runner out of the chain, lets the verdict decide, and only prints the comparison', () => {
    expect(workflow).toContain("          LUCIUM_SMOKE_SKIP=\"$(node -p \"Object.keys(require('./compat/runner-limits.json')).join(',')\")\"\n          export LUCIUM_SMOKE_SKIP\n          set +e\n")
    expect(workflow).toContain(
      '      - name: Verdict of the chain\n        if: ${{ !cancelled() }}\n        env:\n          CHAIN_CODE: ${{ steps.chain.outputs.code }}\n        run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/smoke-runner-verdict.mjs --chain-code "$CHAIN_CODE" --again out-engine\n'
    )
    // Each failed suite that the list does not name is run again alone, with the same list left out, and its report is where the verdict reads it (again-<suite>.json).
    expect(workflow).toContain(
      '      - name: Failed suites, once more alone\n        if: ${{ !cancelled() }}\n        shell: bash\n        run: |\n          LUCIUM_SMOKE_SKIP="$(node -p \"Object.keys(require(\'./compat/runner-limits.json\')).join(\',\')\")"\n          export LUCIUM_SMOKE_SKIP\n          set +e\n          for suite in $(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/smoke-runner-verdict.mjs --print-unexpected); do\n            echo "##### $suite, once more alone"\n            LUCIUM_SMOKE_ONLY="$suite" LUCIUM_SMOKE_REPORT="$PWD/out-engine/again-$suite.json" pnpm test:engine 2>&1 | tee "out-engine/again-$suite.log"\n          done\n'
    )
    // The verdict reads the code of the chain and the second runs, between the chain and the comparison.
    expect(workflow.indexOf('id: chain')).toBeLessThan(workflow.indexOf('name: Failed suites, once more alone'))
    expect(workflow.indexOf('name: Failed suites, once more alone')).toBeLessThan(workflow.indexOf('name: Verdict of the chain'))
    expect(workflow.indexOf('name: Verdict of the chain')).toBeLessThan(workflow.indexOf('pnpm compat:compare'))
    expect(workflow).toContain('pnpm compat:compare --limits compat/runner-limits.json --informational\n')
    // The Mac runs the same chain and the same comparison with no list, no skip and no leniency.
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
    for (const name of ['compat:compare', 'compat:baseline', 'test:engine', 'test:engine:release', 'test:engine:all']) expect(scripts[name] ?? '', name).not.toMatch(/limits|informational|SMOKE_SKIP/)
    expect(read('scripts/engine-release-run.mjs')).not.toMatch(/limits|informational|SMOKE_SKIP/)
  })

  it('puts the animations back on before the chain: the image of the runner has Reduce motion and Reduce transparency on, a Mac in use does not', () => {
    const step = /- name: Animations on, as on a Mac in use\n {8}run: \|\n(?<body>(?: {10}.*\n)+)/.exec(workflow)?.groups?.['body'] ?? ''
    expect(step).toBe(
      [
        'pnpm exec electron scripts/runner-facts.cjs',
        'defaults write com.apple.universalaccess reduceMotion -bool false',
        'defaults write com.apple.universalaccess reduceTransparency -bool false',
        'killall cfprefsd || true',
        'pnpm exec electron scripts/runner-facts.cjs'
      ]
        .map((line) => `          ${line}\n`)
        .join('')
    )
    expect(workflow.indexOf('name: Animations on')).toBeLessThan(workflow.indexOf('id: chain'))
  })

  it('is the only workflow that runs the chain: ci.yml has no timer and starts nothing that opens a window', () => {
    expect(ci).not.toMatch(/test:engine|test:e2e|playwright|--smoke|schedule:|cron:/)
    const others = readdirSync(here('.github/workflows')).filter((file) => file.endsWith('.yml') && file !== 'smoke-macos.yml')
    for (const file of others) expect(code(read(`.github/workflows/${file}`)), file).not.toMatch(/pnpm test:engine/)
  })

  it('uses the standard Electron: no DRM build, no signature, no notarization, no secret', () => {
    expect(workflow).not.toMatch(/build-drm|package-drm|notarytool|codesign|security import|secrets\.|pull_request_target|contents: write/)
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m)
  })

  it('has the setup of ci.yml, the same in each of its jobs: the local action, which holds the one pinned pnpm/setup', () => {
    const calls = (text: string): number => text.match(/^ {6}- uses: \.\/\.github\/actions\/setup\n/gm)?.length ?? 0
    expect(calls(workflow)).toBe(1)
    expect(calls(ci)).toBe(ci.match(/^ {4}runs-on: /gm)?.length ?? 0)
    // No job writes its own copy of the setup: it is read in the action, once.
    expect(workflow).not.toMatch(/uses: pnpm\/setup/)
    expect(ci).not.toMatch(/uses: pnpm\/setup/)
    const action = code(read('.github/actions/setup/action.yml'))
    expect(action.match(/uses: pnpm\/setup@[0-9a-f]{40}.*\n {6}with:\n {8}version: [\d.]+\n {8}cache: \$\{\{ inputs\.cache \}\}\n {8}save-cache: .+\n {8}require-lockfile: true\n/g)).toHaveLength(1)
  })
})
