import { describe, expect, it } from 'vitest'
import { warnsBeforeSaving, type WarnInput } from './download-warning'

const base: WarnInput = { enabled: true, resumed: false, temporary: false, filename: 'setup.pkg' }

describe('the warning before saving a file that can run', () => {
  it('is given for a program, a script, a disk image and a server that says the file is one', () => {
    for (const filename of ['setup.pkg', 'run.sh', 'tool.dmg', 'app.exe', 'macro.docm']) expect(warnsBeforeSaving({ ...base, filename }), filename).toBe(true)
    expect(warnsBeforeSaving({ ...base, filename: 'download.bin2', mimeType: 'application/x-sh' })).toBe(true)
  })

  it('is not given for an ordinary file', () => {
    for (const filename of ['photo.png', 'notes.txt', 'report.pdf', 'archive.zip']) expect(warnsBeforeSaving({ ...base, filename }), filename).toBe(false)
  })

  it('is not given when the setting is off', () => {
    expect(warnsBeforeSaving({ ...base, enabled: false })).toBe(false)
  })

  it('is never given on a resumption', () => {
    expect(warnsBeforeSaving({ ...base, resumed: true })).toBe(false)
  })

  it('is never given for a file that waits in the temporary folder', () => {
    expect(warnsBeforeSaving({ ...base, temporary: true })).toBe(false)
  })
})
