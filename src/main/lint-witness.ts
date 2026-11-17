// Read by the linter only: nothing imports this file, and it is in no bundle.
//
// The promises rule needs the types of the project. With a path alias or a package it cannot resolve, a call is typed `any` and the rule says
// nothing, here and in every other file. Each call below drops a promise on purpose, under a comment that switches the rule off for its line.
// The linter refuses a comment that switches nothing off: `pnpm lint` fails the day one of these calls is no longer seen as a promise.
import { app } from 'electron'
import { runLimited } from '@shared/reload-all'

export function droppedPromises(): void {
  // oxlint-disable-next-line typescript/no-floating-promises -- witness: a type that comes from a package
  app.whenReady()
  // oxlint-disable-next-line typescript/no-floating-promises -- witness: a function behind the `@shared` alias
  runLimited([], 1, 0, () => null)
}
