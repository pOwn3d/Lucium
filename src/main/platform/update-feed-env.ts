// The addresses of the update feeds are built into a build by electron-vite from MAIN_VITE_UPDATE_FEED (stable) and MAIN_VITE_UPDATE_FEED_TEST (test),
// which Vite also reads from the .env files of the project. scripts/build-drm-release.sh gives them from --update-feed and --test-feed only and
// refuses a .env file that sets either (the packaging jobs of windows.yml and linux.yml give them in the environment of their Build step, a place no file
// of the project can reach); every other build (`pnpm package`, the release and CI workflows) goes through electron.vite.config.ts, which
// refuses the same files with this: a forgotten .env.local must not build an address into a build nobody meant to carry one. Not part of
// the application: the configuration imports it, and it imports nothing but Node's modules.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The files Vite reads for a production build, in its order (https://vite.dev/guide/env-and-mode: `.env`, `.env.local`, `.env.[mode]`, `.env.[mode].local`). */
export const PRODUCTION_ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'] as const

/**
 * A line that sets a variable whose name starts with MAIN_VITE_UPDATE_FEED (the stable address, and MAIN_VITE_UPDATE_FEED_TEST, the test one), `export`
 * or not: the same test as build-drm-release.sh. No word boundary after the name: `_` is a word character, so `\b` would let the test one through.
 */
const SETS_FEED = /^[ \t]*(?:export[ \t]+)?MAIN_VITE_UPDATE_FEED/m

/** The files of `root` that set MAIN_VITE_UPDATE_FEED or MAIN_VITE_UPDATE_FEED_TEST; a file that does not exist sets nothing. */
export function envFilesSettingFeed(root: string, read: (path: string) => string | null = readIfThere): string[] {
  return PRODUCTION_ENV_FILES.filter((name) => SETS_FEED.test(read(join(root, name)) ?? ''))
}

function readIfThere(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    // A file that is there but cannot be read could set the address: the build stops rather than guess.
    throw error
  }
}
