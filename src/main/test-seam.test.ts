// The replacements a test makes (test-seam.ts): allowed in a test run only. The second half replaces the rule itself with a refusal and calls
// every replacement of the application: each one must ask it before it replaces anything.

import { describe, expect, it, vi } from 'vitest'

const refusing = vi.hoisted(() => ({ on: false }))
vi.mock('./test-seam', async (original) => {
  const actual = await original<typeof import('./test-seam')>()
  return {
    ...actual,
    assertTestRun: (seam: string) => {
      if (refusing.on) throw new Error(`${seam} is for the tests only`)
      actual.assertTestRun(seam)
    }
  }
})
vi.mock('electron', async () => (await import('./engine/electron-page.test-support')).electronStub())

const { mayReplaceForTests, assertTestRun } = await import('./test-seam')

describe('a replacement of a piece of the application', () => {
  it('is allowed in the unit tests and in the engine test run from the sources, and refused anywhere else', () => {
    expect(mayReplaceForTests(['electron', '.'], { VITEST: 'true' }, true)).toBe(true)
    expect(mayReplaceForTests(['electron', '.', '--smoke'], {}, false)).toBe(true)
    // The built application: `--smoke` is refused there, and so is every replacement.
    expect(mayReplaceForTests(['Lucium', '--smoke'], {}, true)).toBe(false)
    expect(mayReplaceForTests(['electron', '.'], {}, false)).toBe(false)
    expect(mayReplaceForTests(['electron', '.'], { VITEST: '1' }, false)).toBe(false)
    // This run is one.
    expect(() => assertTestRun('anything')).not.toThrow()
  })

  it('asks the rule before it replaces anything: every one of them throws when the rule refuses', async () => {
    const seams: Array<[string, () => unknown]> = [
      ['setLeaveAsker', async () => (await import('./engine/unload-guard')).setLeaveAsker(() => true)],
      ['setMarkdownUi', async () => (await import('./shell/markdown-export')).setMarkdownUi({} as never)],
      ['setNoticeSink', async () => (await import('./shell/system-notice')).setNoticeSink(() => true)],
      ['setDownloadUi', async () => (await import('./shell/download-ui')).setDownloadUi({})],
      ['setImageChooserForTest', async () => (await import('./shell/space-images-electron')).setImageChooserForTest(async () => null)],
      ['useTestNetwork', async () => (await import('./engine/web-store')).WebStore.prototype.useTestNetwork.call({}, null)]
    ]
    refusing.on = true
    try {
      for (const [name, replace] of seams) await expect(replace(), name).rejects.toThrow(`${name} is for the tests only`)
    } finally {
      refusing.on = false
    }
  })
})
