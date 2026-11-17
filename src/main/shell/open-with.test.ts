import { describe, expect, it } from 'vitest'
import { openWithApplication, type OpenWithDeps } from './open-with'

const APP = '/Applications/Preview.app'
const FILE = '/Users/me/Downloads/doc.pdf'

function deps(over: Partial<OpenWithDeps> = {}): OpenWithDeps & { calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = []
  return {
    calls,
    inspect: () => ({ file: true, folder: false, link: false, mode: 0o644 }),
    isFolder: () => true,
    exists: () => true,
    run: async (command, args) => void calls.push([command, args]),
    ...over
  }
}

describe('openWithApplication', () => {
  it('runs open -a with the application and the file, without a shell', async () => {
    const d = deps()
    expect(await openWithApplication(APP, FILE, 'application/pdf', d)).toEqual({ ok: true })
    expect(d.calls).toEqual([['/usr/bin/open', ['-a', APP, FILE]]])
  })

  it('refuses an application that is not a bundle path', async () => {
    for (const app of ['/bin/sh', 'Preview.app', '/Applications/../bin/x.app', '', null, 3]) {
      const d = deps()
      expect((await openWithApplication(app, FILE, undefined, d)).ok, String(app)).toBe(false)
      expect(d.calls).toEqual([])
    }
  })

  it('refuses a bundle that is not on the disk or has no Info.plist', async () => {
    const missing = deps({ isFolder: () => false })
    expect(await openWithApplication(APP, FILE, undefined, missing)).toEqual({ ok: false, reason: `${APP} is not an application` })
    const noPlist = deps({ exists: () => false })
    expect((await openWithApplication(APP, FILE, undefined, noPlist)).ok).toBe(false)
    expect(missing.calls.length + noPlist.calls.length).toBe(0)
  })

  it('never hands over a file whose type can run, by its name or by what the server said', async () => {
    for (const [file, mime] of [['/d/run.sh', undefined], ['/d/Setup.PKG', undefined], ['/d/photo.jpg', 'application/x-sh'], ['/d/noextension', undefined], ['/d/x.command', 'text/plain']] as const) {
      const d = deps()
      const outcome = await openWithApplication(APP, file, mime, d)
      expect(outcome.ok, file).toBe(false)
      expect(d.calls, file).toEqual([])
    }
  })

  it('refuses a file that is a link, a folder, missing, or has an execute bit', async () => {
    const cases: Array<ReturnType<OpenWithDeps['inspect']>> = [{ file: true, folder: false, link: true, mode: 0o644 }, { file: false, folder: true, link: false, mode: 0o755 }, null, { file: true, folder: false, link: false, mode: 0o755 }]
    for (const found of cases) {
      const d = deps({ inspect: () => found })
      expect((await openWithApplication(APP, FILE, undefined, d)).ok, JSON.stringify(found)).toBe(false)
      expect(d.calls).toEqual([])
    }
  })

  it('refuses a path that is not absolute or holds a control character', async () => {
    for (const file of ['doc.pdf', '../doc.pdf', '/a\nb.pdf', 5]) expect((await openWithApplication(APP, file, undefined, deps())).ok, String(file)).toBe(false)
  })

  it('reports the failure of the command instead of throwing', async () => {
    const d = deps({ run: async () => Promise.reject(new Error('open: exited with 1')) })
    expect(await openWithApplication(APP, FILE, undefined, d)).toEqual({ ok: false, reason: 'open: exited with 1' })
  })
})
