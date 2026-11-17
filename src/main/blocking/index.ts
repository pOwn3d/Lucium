// The application's one blocker, shared by every window (the lists are the user's, not a window's).

import { join } from 'node:path'
import { app, net } from 'electron'
import type { FetchLike } from './list-updater'
import { BlockingService } from './service'

let shared: BlockingService | null = null

/**
 * The tests must never reach the Internet: every download of a list fails, at once and with its reason. The engine test (`--smoke`) then points the
 * service at a local server (`useForTests`); the end-to-end tests (`LUCIUM_E2E=1`, tests/e2e/launch.ts) give the blocker lists of their own as text,
 * which are never downloaded.
 */
function offline(test: 'engine' | 'end-to-end'): FetchLike {
  const reason = test === 'engine' ? 'Pas de réseau pendant le test du moteur.' : 'No network during the end-to-end tests (LUCIUM_E2E=1).'
  return () => Promise.reject(new Error(reason))
}

/**
 * How the blocker downloads its lists in this process: over Electron's network stack, or not at all under a test. Read from the command line and the
 * environment of the launch, never from a setting: an application the user launched downloads its lists.
 */
export function listFetch(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, online: FetchLike): FetchLike {
  if (argv.includes('--smoke')) return offline('engine')
  if (env['LUCIUM_E2E'] === '1') return offline('end-to-end')
  return online
}

export function blockingService(): BlockingService {
  shared ??= new BlockingService({
    dir: join(app.getPath('userData'), 'filters'),
    fetch: listFetch(process.argv, process.env, (url, init) => net.fetch(url, init)),
    backend: async () => (await import('./ghostery-engine')).loadGhosteryBackend()
  })
  return shared
}
