// The helper that starts the new AppImage: really run through /bin/sh on a stand-in file (no AppImage, no Electron, no window), and the spawn options through a stand-in
// of `spawn`.
import { spawn as realSpawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { RELAUNCH_SCRIPT } from '@shared/appimage-relaunch'
import { relaunchAppImageDetached } from './appimage-relaunch'

const folder = mkdtempSync(join(tmpdir(), 'lucium-relaunch-'))

/** A stand-in of the new AppImage: writes what it was started with, at the moment it is started. */
function standIn(name: string): { file: string; marker: string } {
  const file = join(folder, name)
  const marker = join(folder, `${name}.started`)
  writeFileSync(file, `#!/bin/sh\nprintf '%s|%s|%s' "$$" "\${APPIMAGE-unset}" "\${LD_LIBRARY_PATH-unset}" > '${marker}'\n`)
  chmodSync(file, 0o755)
  return { file, marker }
}

/** The script, as the helper runs it, with no grace; the pid is the one of a process that ends when told to. */
function runHelper(file: string, pid: number, env: Record<string, string>, waitSeconds = 5): ReturnType<typeof realSpawn> {
  return realSpawn('/bin/sh', ['-c', RELAUNCH_SCRIPT, 'lucium-relaunch', String(pid), file, String(waitSeconds), '0'], { env, stdio: 'ignore' })
}

// The helper is a POSIX shell script (/bin/sh, kill -0, sleep) for Linux, the only system that has an AppImage: Windows has no /bin/sh, so the run is skipped there.
describe.skipIf(process.platform === 'win32')('the script of the helper', () => {
  it('does not start the new file while the old process lives, and starts it once that process has ended', async () => {
    const { file, marker } = standIn('waits')
    const old = realSpawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' })
    const helper = runHelper(file, old.pid!, { PATH: process.env.PATH ?? '/usr/bin:/bin' })
    const done = new Promise<void>((resolve) => helper.once('exit', () => resolve()))
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(existsSync(marker)).toBe(false)
    old.kill('SIGKILL')
    await done
    expect(existsSync(marker)).toBe(true)
  })

  it('gives up waiting after the bound it is given, and starts the new file although the old process still lives', async () => {
    const { file, marker } = standIn('bounded')
    const old = realSpawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' })
    try {
      const helper = runHelper(file, old.pid!, { PATH: process.env.PATH ?? '/usr/bin:/bin' }, 1)
      const done = new Promise<void>((resolve) => helper.once('exit', () => resolve()))
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(existsSync(marker)).toBe(false)
      await done
      expect(existsSync(marker)).toBe(true)
      expect(() => process.kill(old.pid!, 0)).not.toThrow()
    } finally {
      old.kill('SIGKILL')
    }
  })

  it('starts the new file with the environment it is given, and with no variable of the old AppImage when they are not given', async () => {
    const { file, marker } = standIn('env')
    const gone = realSpawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' })
    await new Promise((resolve) => gone.once('exit', resolve))
    const helper = runHelper(file, gone.pid!, { PATH: process.env.PATH ?? '/usr/bin:/bin' })
    await new Promise((resolve) => helper.once('exit', resolve))
    const [, appimage, libs] = readFileSync(marker, 'utf8').split('|')
    expect(appimage).toBe('unset')
    expect(libs).toBe('unset')
  })
})

describe('relaunchAppImageDetached', () => {
  it('starts the helper detached, with no input or output, in the folder of the file, with the cleaned environment, and lets go of it', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const start = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    await relaunchAppImageDetached('/home/ana/Apps/Lucium.AppImage', 77, { HOME: '/home/ana', APPIMAGE: '/old', APPDIR: '/tmp/.mount_x' }, start as never)
    expect(start).toHaveBeenCalledExactlyOnceWith('/bin/sh', expect.arrayContaining(['-c', RELAUNCH_SCRIPT, '77', '/home/ana/Apps/Lucium.AppImage']), {
      detached: true,
      stdio: 'ignore',
      env: { HOME: '/home/ana' },
      cwd: '/home/ana/Apps',
      shell: false
    })
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('rejects when the helper could not be started (an error event or a throw), so that the AppImage that ran can be put back', async () => {
    const failing = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const withEvent = vi.fn(() => {
      queueMicrotask(() => failing.emit('error', new Error('spawn /bin/sh ENOENT')))
      return failing
    })
    await expect(relaunchAppImageDetached('/a/L.AppImage', 1, {}, withEvent as never)).rejects.toThrow('ENOENT')
    await expect(
      relaunchAppImageDetached('/a/L.AppImage', 1, {}, (() => {
        throw new Error('EAGAIN')
      }) as never)
    ).rejects.toThrow('EAGAIN')
    expect(failing.unref).not.toHaveBeenCalled()
  })
})
