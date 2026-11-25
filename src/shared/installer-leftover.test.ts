import { posix, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { sweepInstallerLeftover } from './installer-leftover'

// Both path modules are driven on every system: Windows is in the CI, and the rule must not depend on where the test runs.
const SYSTEMS = [
  { name: 'windows', path: win32, temp: 'C:\\Users\\a\\AppData\\Local\\Temp' },
  { name: 'posix', path: posix, temp: '/tmp/user' }
]

describe.each(SYSTEMS)('the installer left after an update ($name paths)', ({ path, temp }) => {
  const own = path.join(temp, 'lucium-update')

  it('is removed when the folder is the download folder of Lucium', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    await expect(sweepInstallerLeftover({ temp, folder: own, join: path.join, remove })).resolves.toBe('removed')
    expect(remove).toHaveBeenCalledExactlyOnceWith(own)
  })

  it.each([
    ['the temporary folder itself', temp],
    ['a folder of another name', path.join(temp, 'other')],
    ['a folder one level up', path.join(temp, 'lucium-update', '..')],
    ['a folder inside it', path.join(own, 'sub')],
    ['an empty path', '']
  ])('is not removed when the folder is %s', async (_label, folder) => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const log = vi.fn()
    await expect(sweepInstallerLeftover({ temp, folder, join: path.join, remove, log })).resolves.toBe('refused')
    expect(remove).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledOnce()
  })

  it('says so in the log when the removal fails, and does not throw', async () => {
    const log = vi.fn()
    const remove = vi.fn().mockRejectedValue(new Error('EBUSY'))
    await expect(sweepInstallerLeftover({ temp, folder: own, join: path.join, remove, log })).resolves.toBe('failed')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('EBUSY'))
  })
})
