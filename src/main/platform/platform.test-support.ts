// The platform layer of a test, on the system the test names instead of the machine of the run: the real `createPlatform`, so a menu or a window
// is checked as macOS makes it on a Linux runner too, and as Linux makes it on a Mac. A test file puts it in place with
//   vi.mock('../platform', async (original) => (await import('../platform/platform.test-support')).playedPlatform(await original()))
// and sets `played.id` for the cases of another system (`resetPlayedPlatform` puts macOS back).

import type { PlatformId } from '@shared/platform'

type PlatformModule = typeof import('./index')

/** The system the tests of the file play. */
export const played: { id: PlatformId } = { id: 'darwin' }

/** macOS again, the system the application is published for. */
export function resetPlayedPlatform(): void {
  played.id = 'darwin'
}

/** The platform module with `currentPlatform` answering for `played.id`. */
export function playedPlatform(actual: PlatformModule): PlatformModule {
  const made = new Map<PlatformId, ReturnType<PlatformModule['createPlatform']>>()
  return {
    ...actual,
    currentPlatform: () => {
      let platform = made.get(played.id)
      if (!platform) made.set(played.id, (platform = actual.createPlatform(played.id)))
      return platform
    }
  }
}
