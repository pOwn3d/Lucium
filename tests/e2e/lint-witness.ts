// Read by the linter only: no test imports this file. The reason is in src/main/lint-witness.ts.
//
// An end-to-end test that forgets an `await` goes on before the page has answered. The call below drops a promise on purpose, under a comment
// that switches the rule off for its line; the linter refuses a comment that switches nothing off.
import type { Page } from '@playwright/test'

export function droppedPromises(page: Page): void {
  // oxlint-disable-next-line typescript/no-floating-promises -- witness: an action of Playwright
  page.click('body')
}
