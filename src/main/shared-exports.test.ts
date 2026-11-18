// An export of src/shared that only its test reads proves nothing about the product: a guard can be tested, documented as "refused before it
// reaches the engine", and called by no code path. This test lists those exports and compares the list with the one written here. A new one
// fails it (use the function in the product, or do not export it); one that got a user, or went away, fails it too until its line is removed,
// so the list only gets shorter. Here and not in src/shared because it reads files (the shared tests also build for the renderer).

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { exportsWithoutProductUser, isTestFile, withoutComments } from './export-users.test-support'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The exports of src/shared no product code read on 11 November 2026, as `file name`. What is left falls in three kinds:
 *  - measures a test needs to check a rule (design-tokens, a11y-audit, the thresholds and the sizes that tests compare with the styles);
 *  - helpers whose only reader is a test: to call from the product or to remove, one by one;
 *  - constants that document a bound written again inside a function sent to pages as text.
 */
const KNOWN: readonly string[] = [
  'a11y-audit.ts auditAxTree',
  'a11y-audit.ts MIN_TARGET_PX',
  'a11y-audit.ts requiredContrast',
  'annotate-bar.ts barMetricVars',
  'auto-pip.ts AUTO_PIP_MIN_BOX',
  'auto-pip.ts AUTO_PIP_MIN_CALL_TILE',
  'auto-pip.ts AUTO_PIP_MIN_PLAYED_SECONDS',
  'autoscroll.ts AUTOSCROLL_DEAD_ZONE',
  'autoscroll.ts AUTOSCROLL_MAX_SPEED',
  'calc.ts CALC_CONSTANTS',
  'calc.ts CALC_FUNCTIONS',
  'debugger-policy.ts DENIED_DOMAINS',
  'design-tokens.ts pairRatio',
  'design-tokens.ts TOKEN_PAIRS',
  'design-tokens.ts tokenValues',
  'download-status.ts noStatus',
  'favicon.ts pickIcon',
  'features.ts changedFeatures',
  'features.ts defaultFeaturesPatch',
  'features.ts groupedFeatures',
  'folders.ts folderChildren',
  'french-typography.ts plainSpaces',
  'gestures.ts gesturePath',
  'i18n.ts diffCatalogues',
  'i18n.ts isConsistent',
  'login-form.ts LOGIN_FIELDS_MAX',
  'note-markdown.ts noteSource',
  'note-markdown.ts pasteEdit',
  'page-annotate.ts PAGE_EPHEMERAL_TOOLS',
  'page-tools.ts toolMessageText',
  'perf-core.ts parsePagesBase',
  'perf-features.ts featuresWithoutCostClass',
  'perf-features.ts perfFeaturePatch',
  'platform.ts PLATFORM_IDS',
  'platform.ts usesCtrlAlt',
  'plus-menu.ts plusMenuHeight',
  'privacy.ts NO_PRIVACY',
  'proxy.ts describeProxy',
  'read-aloud.ts SPEECH_CHUNK_MAX',
  'readable-engine.ts CONTRAST_LARGE',
  'readable-engine.ts CONTRAST_TEXT',
  'readable-engine.ts CONTRAST_UI',
  'readable-engine.ts ReadableStart',
  'redirect-resources.ts redirectResourceNames',
  'scriptlets.ts REGEX_INPUT_MAX',
  'scriptlets.ts scriptletNames',
  'sessions.ts tabsLabel',
  'settings-catalog.ts FEATURE_ONLY_SWITCHES',
  'settings-catalog.ts FLOW_ANCHORS',
  'settings-catalog.ts HOME_MIRROR_KEYS',
  'settings-guide.ts RECOMMENDED_AWAY_FROM_DEFAULTS',
  'site-data.ts siteScore',
  'space-image.ts squareCrop',
  // The merge of the synchronisation (card 446): the session of the Mac (card 444) and of the iPhone (card 445) call them; remove these lines when they do.
  'sync-merge.ts mergeSnapshots',
  'sync-merge.ts otherSide',
  'tab-state.ts tabStateLegend',
  'tab-tree.ts TREE_INDENT',
  'tab-tree.ts treeDepth',
  'theme-presets.ts readyThemeOf',
  'theme.ts nextOverlay',
  'translate-local.ts batchIndices',
  'translate-local.ts isTranslatable',
  'translate-local.ts splitPadding',
  'ui-scale.ts stageMetrics',
  'ui-scale.ts unscaled'
]

function productFiles(): Record<string, string> {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'src', 'scripts', 'tests'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((path) => /\.(ts|tsx|mts|mjs)$/.test(path) && !path.includes('/vendor/') && existsSync(join(ROOT, path)))
  return Object.fromEntries(paths.map((path) => [path, readFileSync(join(ROOT, path), 'utf8')]))
}

describe('the exports of src/shared that no product code reads', () => {
  // Every source file of the tree is read and its names counted: a few seconds, more on a busy machine.
  it('are the known ones, no more and no fewer', { timeout: 60_000 }, () => {
    const found = exportsWithoutProductUser(productFiles(), 'src/shared/').map((entry) => `${entry.file.slice('src/shared/'.length)} ${entry.name}`)
    const known = new Set(KNOWN)
    const now = new Set(found)
    // A function only its test calls: call it from the product, or keep it out of the exports (and of the test).
    expect(found.filter((entry) => !known.has(entry))).toEqual([])
    // It has a user now, or it is gone: remove its line from KNOWN.
    expect(KNOWN.filter((entry) => !now.has(entry))).toEqual([])
  })
})

describe('the search for exports without a product user', () => {
  const files = {
    'src/shared/guard.ts': [
      'export function canErase(host: string): boolean {',
      '  return host !== ""',
      '}',
      'export const used = (): number => 1',
      'export const ownOnly = (): number => used() + inner()',
      'export function inner(): number { return 2 }',
      'export type Lonely = { a: 1 }',
      'const hidden = 3'
    ].join('\n'),
    'src/shared/guard.test.ts': "import { canErase } from './guard'\ncanErase('a')",
    'src/main/smoke-guard.ts': "import { canErase } from '@shared/guard'\ncanErase('b')",
    'tests/e2e/guard.spec.ts': "import { canErase } from '../../src/shared/guard'",
    'src/main/ipc.ts': "import { used, ownOnly } from '@shared/guard'\n// canErase(host) would refuse here\n/* Lonely */\nused(); ownOnly()",
    'src/main/other.ts': 'export const elsewhere = 1'
  }

  it('finds the export only tests read and the one nobody reads, and nothing else', () => {
    expect(exportsWithoutProductUser(files, 'src/shared/')).toEqual([
      { file: 'src/shared/guard.ts', name: 'canErase', readBy: 'tests' },
      { file: 'src/shared/guard.ts', name: 'Lonely', readBy: 'nobody' }
    ])
  })

  it('counts a call from the product, and no longer a name in a comment', () => {
    const called = { ...files, 'src/main/ipc.ts': `${files['src/main/ipc.ts']}\nif (!canErase('x')) throw new Error('refused')` }
    expect(exportsWithoutProductUser(called, 'src/shared/').map((entry) => entry.name)).toEqual(['Lonely'])
  })

  it('looks only at the folder it is given', () => {
    expect(exportsWithoutProductUser(files, 'src/main/').map((entry) => entry.name)).toEqual(['elsewhere'])
  })

  it('knows a test file from a product file', () => {
    for (const path of ['src/a.test.ts', 'src/renderer/B.test.tsx', 'src/main/x.test-support.ts', 'src/main/smoke.ts', 'src/main/smoke-kit.ts', 'tests/e2e/helpers.ts']) expect(isTestFile(path), path).toBe(true)
    for (const path of ['src/main/index.ts', 'src/shared/latest.ts', 'scripts/perf.mjs', 'src/main/smoke/x.ts']) expect(isTestFile(path), path).toBe(false)
  })

  it('removes comments, but neither an address, a regular expression nor a pattern that looks like the start of one', () => {
    expect(withoutComments('a // b\n/* c */d\n// e\nf("https://x.fr/") // g\nconst r = /^a:\\/\\/b/\nconst all = { path: \'/*\' } /** h */ + 1')).toBe('a \nd\n\nf("https://x.fr/") \nconst r = /^a:\\/\\/b/\nconst all = { path: \'/*\' }  + 1')
  })
})
