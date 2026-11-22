import { describe, expect, it } from 'vitest'
import { launchWindowsFromArgv } from './launch-flags'

describe('the windows a command line asks for', () => {
  it('reads --new-window and --private-window, in the order written, each once', () => {
    expect(launchWindowsFromArgv(['lucium', '--private-window', '--new-window', '--private-window'])).toEqual(['private', 'new'])
    expect(launchWindowsFromArgv(['lucium', '--new-window'])).toEqual(['new'])
  })

  it('reads nothing else: no value, no abbreviation, no address', () => {
    expect(launchWindowsFromArgv(['lucium', '--new-window=1', '--new', '-new-window', '--private-windows', 'new-window', 'https://example.org/--new-window', '--no-sandbox'])).toEqual([])
    expect(launchWindowsFromArgv([])).toEqual([])
  })

  it('stops at a bare --, as Chromium does', () => {
    expect(launchWindowsFromArgv(['lucium', '--', '--new-window'])).toEqual([])
    expect(launchWindowsFromArgv(['lucium', '--private-window', '--', '--new-window'])).toEqual(['private'])
  })

  it('ignores the case on Windows only, where Chromium does', () => {
    expect(launchWindowsFromArgv(['lucium', '--New-Window'], true)).toEqual(['new'])
    expect(launchWindowsFromArgv(['lucium', '--New-Window'], false)).toEqual([])
  })
})
