// The real box that asks before a file that can run is saved, over a stand-in of the system dialog: « Annuler » is the default and the one Escape presses,
// and only « Enregistrer » lets the file be saved. The engine tests put their own box in place, so nothing else shows this one.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const showMessageBox = vi.fn()
vi.mock('electron', () => ({ dialog: { showMessageBox }, shell: {}, BrowserWindow: class {} }))
const { downloadUi } = await import('./download-ui')

const request = { filename: 'setup.pkg', host: 'files.example.net' } as Parameters<ReturnType<typeof downloadUi>['confirmExecutable']>[1]

beforeEach(() => showMessageBox.mockReset())

describe('the box before a file that can run is saved', () => {
  it('saves only when the second button is clicked, and « Annuler » is the default and the one Escape presses', async () => {
    showMessageBox.mockResolvedValue({ response: 1 })
    expect(await downloadUi().confirmExecutable(null, request)).toBe(true)
    const options = showMessageBox.mock.calls[0]![0] as { buttons: string[]; defaultId: number; cancelId: number; detail: string }
    expect([options.defaultId, options.cancelId]).toEqual([0, 0])
    expect(options.buttons).toHaveLength(2)
    expect(options.detail).toContain('setup.pkg')
    expect(options.detail).toContain('files.example.net')
    showMessageBox.mockResolvedValue({ response: 0 })
    expect(await downloadUi().confirmExecutable(null, request)).toBe(false)
  })
})
