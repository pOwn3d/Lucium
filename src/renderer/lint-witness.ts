// Read by the linter only: nothing imports this file, and it is in no bundle. The reason is in src/main/lint-witness.ts.
//
// Each line below breaks a rule on purpose, under a comment that switches the rule off for that line. The linter refuses a comment that
// switches nothing off: `pnpm lint` fails the day the hooks rules no longer reach this folder, or a call is no longer seen as a promise.
import { useEffect, useState } from 'react'
import { runLimited } from '@shared/reload-all'

export function droppedPromises(): void {
  // oxlint-disable-next-line typescript/no-floating-promises -- witness: the bridge, a global declared in api.ts
  window.lucium.getSnapshot()
  // oxlint-disable-next-line typescript/no-floating-promises -- witness: a function behind the `@shared` alias
  runLimited([], 1, 0, () => null)
}

export function useBrokenHooks(on: boolean): void {
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- witness: a hook in a branch
  if (on) useState(0)
  useEffect(() => {
    if (on) document.title = ''
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- witness: `on` is read and not listed
  }, [])
}
