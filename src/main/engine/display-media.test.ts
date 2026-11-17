import { describe, expect, it } from 'vitest'
import type { ShareChoice, ShareSource, ShareStreams } from '@shared/display-media'
import { nothingToShareNotice, screenAccessNotice, shareFailedNotice } from '@shared/display-media'
import { createDisplayMediaHandler, type DisplayMediaDeps, type DisplayMediaRequest } from './display-media'

const REQUEST: DisplayMediaRequest = { frame: { url: 'https://meet.example/room?secret=1' }, userGesture: true, videoRequested: true, audioRequested: false }
const SOURCES: ShareSource[] = [
  { id: 'screen:1:0', name: 'Entire Screen' },
  { id: 'window:5:0', name: 'Notes' }
]

/** A system that lists `SOURCES`, shows a menu whose pick is `pick`, and records everything it was asked. */
function setup(patch: Partial<DisplayMediaDeps> = {}, pick: (choices: ShareChoice[]) => string | null = () => 'window:5:0') {
  const seen = { warnings: [] as string[], blocked: [] as string[], settings: [] as boolean[], listed: 0, offered: [] as ShareChoice[][], answers: [] as Array<ShareStreams | null> }
  const deps: DisplayMediaDeps = {
    platform: 'darwin',
    screenAccess: () => 'granted',
    listSources: async () => {
      seen.listed++
      return SOURCES
    },
    choose: async (_request, choices) => {
      seen.offered.push(choices)
      return pick(choices)
    },
    blocked: (_request, notice, openSettings) => {
      seen.blocked.push(notice)
      seen.settings.push(openSettings === true)
    },
    warn: (message) => void seen.warnings.push(message),
    ...patch
  }
  const handler = createDisplayMediaHandler(deps)
  const run = (request: DisplayMediaRequest = REQUEST, callback?: (streams: ShareStreams | null) => void) =>
    new Promise<ShareStreams | null>((resolve) => {
      handler(request, (streams) => {
        seen.answers.push(streams)
        resolve(streams)
        callback?.(streams)
      })
    })
  return { seen, run }
}

describe('the answer to getDisplayMedia', () => {
  it('gives the page the source the user picked, and nothing else', async () => {
    const { seen, run } = setup()
    expect(await run()).toEqual({ video: { id: 'window:5:0', name: 'Notes' } })
    expect(seen.offered[0]!.map((c) => c.label)).toEqual(['Écran entier', 'Notes'])
  })

  it('refuses a page that is not a web page, before the system is asked anything', async () => {
    const { seen, run } = setup()
    for (const url of ['file:///a.html', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html', '']) {
      expect(await run({ ...REQUEST, frame: url === '' ? null : { url } }), url).toBeNull()
    }
    expect(seen.listed).toBe(0)
    expect(seen.offered).toHaveLength(0)
    expect(seen.warnings.some((w) => w.includes('not-a-web-page'))).toBe(true)
  })

  it('refuses a request with no user gesture, and a request that wants no picture, without listing the windows', async () => {
    const { seen, run } = setup()
    expect(await run({ ...REQUEST, userGesture: false })).toBeNull()
    expect(await run({ ...REQUEST, videoRequested: false })).toBeNull()
    expect(seen.listed).toBe(0)
    expect(seen.warnings.map((w) => /\((.*)\)/.exec(w)?.[1])).toEqual(['no-user-gesture', 'no-video'])
  })

  it('writes the origin of the page in the log, never its path or query', async () => {
    const { seen, run } = setup()
    await run({ ...REQUEST, userGesture: false })
    expect(seen.warnings[0]).toContain('https://meet.example')
    expect(seen.warnings[0]).not.toContain('secret')
  })

  it('refuses at once, and tells the user where to change it, when the screen is restricted', async () => {
    const { seen, run } = setup({ screenAccess: () => 'restricted' })
    expect(await run()).toBeNull()
    expect(seen.blocked).toEqual([screenAccessNotice()])
    expect(seen.listed).toBe(0)
    expect(seen.warnings.some((w) => w.includes('restricted'))).toBe(true)
  })

  it('lists first when macOS says "denied" (it says so before ever asking): the listing makes the system ask', async () => {
    const { seen, run } = setup({ screenAccess: () => 'denied' })
    expect(await run()).toBeNull()
    expect(seen.listed).toBe(1)
    expect(seen.offered).toEqual([])
    expect(seen.blocked).toEqual([screenAccessNotice()])
    expect(seen.settings).toEqual([true])
    expect(seen.warnings.some((w) => w.includes('denied'))).toBe(true)
  })

  it('goes on when the permission is granted during that first listing', async () => {
    let asked = false
    const { seen, run } = setup({
      screenAccess: () => (asked ? 'granted' : 'denied'),
      listSources: async () => {
        asked = true
        seen.listed++
        return SOURCES
      }
    })
    expect(await run()).not.toBeNull()
    expect(seen.blocked).toEqual([])
  })

  it('goes on when the user has not been asked yet: asking is what the first listing does', async () => {
    for (const access of ['not-determined', 'unknown', 'granted'] as const) {
      const { seen, run } = setup({ screenAccess: () => access })
      expect(await run(), access).not.toBeNull()
      expect(seen.blocked).toEqual([])
    }
  })

  it('refuses when the user closes the menu without picking', async () => {
    const { run } = setup({}, () => null)
    expect(await run()).toBeNull()
  })

  it('refuses a pick that is not one of the choices offered', async () => {
    const { run } = setup({}, () => 'window:999:0')
    expect(await run()).toBeNull()
  })

  it('refuses, and says why, when there is nothing to share', async () => {
    const { seen, run } = setup({ listSources: async () => [] })
    expect(await run()).toBeNull()
    expect(seen.offered).toHaveLength(0)
    expect(seen.warnings.some((w) => w.includes('nothing to share'))).toBe(true)
    // The user is told in the window of the page, not only the log.
    expect(seen.blocked).toEqual([nothingToShareNotice()])
  })

  it('refuses, and logs the cause with the origin, when the system cannot list its sources', async () => {
    const logged: Array<[string, unknown]> = []
    const blocked: string[] = []
    const { run } = setup({
      listSources: () => Promise.reject(new Error('screen capture failed')),
      warn: (message, detail) => void logged.push([message, detail]),
      blocked: (_request, notice) => void blocked.push(notice)
    })
    expect(await run()).toBeNull()
    expect(logged).toHaveLength(1)
    expect(logged[0]![0]).toContain('https://meet.example')
    expect((logged[0]![1] as Error).message).toBe('screen capture failed')
    expect(blocked).toEqual([shareFailedNotice()])
  })

  it('refuses, and logs the cause, when the menu itself fails', async () => {
    const logged: unknown[] = []
    const { run } = setup({ choose: () => Promise.reject(new Error('no window to show a menu on')), warn: (_message, detail) => void logged.push(detail) })
    expect(await run()).toBeNull()
    expect((logged[0] as Error).message).toBe('no window to show a menu on')
  })

  it('offers the sound of the system only for a whole display, to a page that asked for it, on Windows', async () => {
    const asked = { ...REQUEST, audioRequested: true }
    const windows = setup({ platform: 'win32' }, () => 'screen:1:0')
    expect(await windows.run(asked)).toEqual({ video: { id: 'screen:1:0', name: 'Écran entier' }, audio: 'loopback' })
    const mac = setup({ platform: 'darwin' }, () => 'screen:1:0')
    expect((await mac.run(asked))?.audio).toBeUndefined()
  })

  it('logs it, with the origin, when Electron refuses the answer (the frame is gone)', async () => {
    const calls: Array<ShareStreams | null> = []
    const { seen, run } = setup()
    const answered = await run(REQUEST, (streams) => {
      calls.push(streams)
      throw new Error('frame destroyed')
    })
    expect(answered).not.toBeNull()
    expect(calls).toHaveLength(1)
    expect(seen.warnings.some((w) => w.includes('could not be delivered') && w.includes('https://meet.example'))).toBe(true)
  })
})
