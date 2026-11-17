import { describe, expect, it, vi } from 'vitest'
import { linksFromArgv } from '@shared/platform'
import { handleSecondLaunch, hasOwnDataFolder, isPrimaryInstance } from './single-instance'

const OWN_FOLDER = ['/Applications/Electron.app/Contents/MacOS/Electron', '.', '--smoke', '--user-data-dir=/tmp/lucium-smoke-1']

describe('isPrimaryInstance', () => {
  it('is the instance that got the lock', () => {
    expect(isPrimaryInstance(false, () => true)).toBe(true)
  })

  it('is not the instance that was refused it: it must not start the browser', () => {
    expect(isPrimaryInstance(false, () => false)).toBe(false)
  })

  it('asks for the lock exactly once outside the engine test', () => {
    const request = vi.fn(() => true)
    isPrimaryInstance(false, request, ['Lucium'])
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not ask for it in the engine test, which runs beside the real application in a data folder of its own', () => {
    const request = vi.fn(() => false)
    expect(isPrimaryInstance(true, request, OWN_FOLDER)).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses an engine test without a data folder of its own: it would run in the real profile without the lock', () => {
    const request = vi.fn(() => true)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const argv of [['electron', '.', '--smoke'], ['electron', '.', '--smoke', '--user-data-dir='], ['electron', '.', '--smoke', '--user-data-dir', '/tmp/x']]) {
        expect(isPrimaryInstance(true, request, argv), argv.join(' ')).toBe(false)
      }
      expect(request).not.toHaveBeenCalled()
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('--user-data-dir='))
    } finally {
      logged.mockRestore()
    }
  })
})

describe('hasOwnDataFolder', () => {
  it('reads the switch as Chromium takes it, with a path', () => {
    expect(hasOwnDataFolder(OWN_FOLDER)).toBe(true)
    expect(hasOwnDataFolder(['electron', '--user-data-dir='])).toBe(false)
    expect(hasOwnDataFolder(['electron', '--user-data-directory=/x'])).toBe(false)
    expect(hasOwnDataFolder([])).toBe(false)
  })
})

// The links a second launch hands over: the web addresses and the commands by address (`lucium://`), as the system gives them
// to the application on macOS (the event `open-url`).
describe('the links of a second launch', () => {
  it('are the web addresses and the commands by address of its command line, and nothing else', () => {
    const argv = ['/opt/Lucium/lucium', '--no-sandbox', 'https://example.org/a', 'lucium://open?url=https%3A%2F%2Fexample.org%2F', 'LUCIUM://new-tab', 'file:///etc/passwd', 'javascript:alert(1)', 'lucium:open', 'luciumx://open', 'xlucium://open']
    expect(linksFromArgv(argv)).toEqual(['https://example.org/a', 'lucium://open?url=https%3A%2F%2Fexample.org%2F', 'LUCIUM://new-tab'])
  })

  // That main() gives the handler of a second launch the handler of the links, the lock, the window of its own and the main window: main-wiring.test.ts, where main() is run.
})

describe('a second launch of the program, in the instance that runs', () => {
  function launch(argv: string[], locked: boolean) {
    const done: string[] = []
    handleSecondLaunch(argv, { openLink: (url) => void done.push(`link ${url}`), isAppLocked: () => locked, newWindow: () => void done.push('new window'), focusMain: () => void done.push('focus') })
    return done
  }

  it('hands every address of its command line to the handler of the links, as it is, then brings the window forward', () => {
    const argv = ['/opt/Lucium/lucium', '--no-sandbox', 'https://example.org/a', 'lucium://open?url=https%3A%2F%2Fexample.org%2F', 'file:///etc/passwd', 'javascript:alert(1)']
    expect(launch(argv, false)).toEqual(['link https://example.org/a', 'link lucium://open?url=https%3A%2F%2Fexample.org%2F', 'focus'])
    // Locked or not: the handler of the links has the lock's own rule for a link (it keeps it until the application is unlocked).
    expect(launch(argv, true)).toEqual(['link https://example.org/a', 'link lucium://open?url=https%3A%2F%2Fexample.org%2F', 'focus'])
  })

  it('opens a window of its own for a launch with no address', () => {
    expect(launch(['/opt/Lucium/lucium'], false)).toEqual(['new window'])
    expect(launch(['/opt/Lucium/lucium', 'file:///etc/passwd'], false)).toEqual(['new window'])
  })

  it('opens no window while the application is locked: the launch only brings the lock screen forward', () => {
    expect(launch(['/opt/Lucium/lucium'], true)).toEqual(['focus'])
    expect(launch(['/opt/Lucium/lucium', '--no-sandbox'], true)).toEqual(['focus'])
  })
})
