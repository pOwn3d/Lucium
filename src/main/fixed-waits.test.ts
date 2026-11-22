// An engine check that waits a fixed time and then concludes is slow on a fast machine and wrong on a slow one: a positive check fails when
// the effect comes later, and a negative one ("nothing happened") passes for the same reason. The suites have `waitFor` (smoke-kit.ts,
// `pollUntil`) for a condition, and a refusal is proved by a witness: something accepted after it, whose effect is waited for.
// The fixed waits that exist are counted here, suite by suite. A new one fails this test; one that was replaced fails it too until its
// number is lowered, so the numbers only go down. The end-to-end tests have none left, and none may come back.

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MAIN = fileURLToPath(new URL('.', import.meta.url))
const E2E = fileURLToPath(new URL('../../tests/e2e/', import.meta.url))

/** In each suite: the checks that conclude right after a fixed wait, and all its fixed waits. As counted on 11 November 2026, lowered on 12 November. */
const KNOWN: Readonly<Record<string, readonly [concluding: number, all: number]>> = {
  'smoke-a11y.ts': [0, 23],
  'smoke-about.ts': [0, 5],
  'smoke-autoreload.ts': [2, 11],
  'smoke-blocker.ts': [1, 3],
  'smoke-boostfonts.ts': [2, 3],
  'smoke-capture.ts': [1, 15],
  'smoke-cleardata2.ts': [1, 11],
  'smoke-commandbar.ts': [0, 4],
  'smoke-containers.ts': [0, 1],
  'smoke-dialogs.ts': [0, 11],
  'smoke-downloadresume.ts': [2, 5],
  'smoke-downloads2.ts': [5, 19],
  'smoke-extensions.ts': [1, 9],
  'smoke-extensions2.ts': [0, 6],
  'smoke-extwindows.ts': [1, 4],
  'smoke-favicons.ts': [0, 1],
  'smoke-features.ts': [2, 5],
  'smoke-guard.ts': [0, 8],
  'smoke-history.ts': [0, 3],
  'smoke-import.ts': [0, 2],
  'smoke-import2.ts': [0, 2],
  'smoke-iso-media.ts': [5, 38],
  'smoke-iso-menus.ts': [0, 9],
  'smoke-iso-panels.ts': [1, 52],
  'smoke-iso-plus.ts': [1, 22],
  'smoke-iso-settings.ts': [0, 11],
  'smoke-iso-sidebar.ts': [0, 43],
  'smoke-iso-toolbar.ts': [2, 39],
  'smoke-keyext.ts': [1, 18],
  'smoke-kit.ts': [0, 2],
  'smoke-library.ts': [2, 5],
  'smoke-littlearc.ts': [0, 8],
  'smoke-markdown.ts': [0, 9],
  'smoke-market.ts': [0, 11],
  'smoke-navigation.ts': [2, 60],
  'smoke-pages.ts': [1, 12],
  'smoke-passwords.ts': [0, 4],
  'smoke-perf.ts': [0, 3],
  'smoke-popups.ts': [1, 16],
  'smoke-privacy2.ts': [0, 10],
  'smoke-privacy3.ts': [0, 2],
  'smoke-probes-ext.ts': [0, 3],
  'smoke-probes-web.ts': [0, 6],
  'smoke-readlater.ts': [0, 7],
  'smoke-reloadall.ts': [0, 3],
  'smoke-runtime.ts': [2, 8],
  'smoke-search2.ts': [0, 9],
  'smoke-sec1.ts': [1, 11],
  'smoke-sec2.ts': [0, 5],
  'smoke-security2.ts': [0, 10],
  'smoke-sessions.ts': [0, 10],
  'smoke-sessionsplus.ts': [0, 10],
  'smoke-settings.ts': [0, 7],
  'smoke-share.ts': [2, 7],
  'smoke-sidebar.ts': [1, 21],
  'smoke-sitedata.ts': [0, 7],
  'smoke-sleep.ts': [0, 10],
  'smoke-spaces2.ts': [2, 56],
  'smoke-tabsui.ts': [0, 15],
  'smoke-themes.ts': [0, 12],
  'smoke-translate.ts': [0, 2],
  'smoke-usage.ts': [3, 24],
  'smoke-webhardware.ts': [0, 3],
  'smoke-webstore.ts': [2, 11],
  'smoke-webtools.ts': [2, 30],
  'smoke-windows.ts': [1, 5],
  // The pacing of the input it sends (a pointer that comes over the tile before it presses, the keys of a name): no check concludes on a wait.
  'smoke-work-views.ts': [0, 4],
  'smoke.ts': [0, 35]
}

/** The lines of a source that count: no blank line, no line of comment. */
const lines = (source: string): string[] => source.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))

/** How many fixed waits a suite has, and how many of them are followed at once by the check they were for. */
function fixedWaits(source: string): [concluding: number, all: number] {
  const code = lines(source)
  let concluding = 0
  let all = 0
  code.forEach((line, index) => {
    const waits = (line.match(/\bawait sleep\(/g) ?? []).length
    all += waits
    // The wait and its check on one line, or the check on the next one.
    if (waits > 0 && (/\bawait sleep\([^)]*\)\s*;?\s*$/.test(line) ? /^check\(/.test(code[index + 1] ?? '') : /\bawait sleep\([^)]*\)[\s;]*check\(/.test(line))) concluding++
  })
  return [concluding, all]
}

describe('the fixed waits of the engine suites', () => {
  it('are the known ones, suite by suite: none is added, and one that is replaced lowers its number', () => {
    const found: Record<string, [number, number]> = {}
    for (const name of readdirSync(MAIN).filter((file) => /^smoke.*\.ts$/.test(file) && !file.endsWith('.test.ts')).sort()) {
      const counts = fixedWaits(readFileSync(`${MAIN}${name}`, 'utf8'))
      if (counts[1] > 0) found[name] = counts
    }
    expect(found).toEqual(KNOWN)
  })

  it('counts a wait followed by its check, on the next line or on the same one, and passes comments', () => {
    expect(fixedWaits("await sleep(300)\ncheck('nothing happened', count() === before)")).toEqual([1, 1])
    expect(fixedWaits("  await sleep(300)\n\n  // Nothing may have happened.\n  check('nothing happened', true)")).toEqual([1, 1])
    expect(fixedWaits("await sleep(300); check('nothing happened', true)")).toEqual([1, 1])
    expect(fixedWaits("await sleep(300)\nconst now = count()\ncheck('nothing happened', now === before)")).toEqual([0, 1])
    expect(fixedWaits("check('it came', await waitFor(() => count() === 2))\n// await sleep(300)\nfor (;;) { await sleep(50); await sleep(50) }")).toEqual([0, 2])
  })
})

describe('the end-to-end tests', () => {
  it('have no fixed wait of Playwright: an effect is waited for, a refusal has a witness', () => {
    const waiting = readdirSync(E2E).filter((file) => file.endsWith('.ts') && lines(readFileSync(`${E2E}${file}`, 'utf8')).some((line) => /\bwaitForTimeout\(/.test(line)))
    expect(waiting).toEqual([])
  })
})
