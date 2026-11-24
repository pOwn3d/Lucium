// Starts the new AppImage from a helper that is detached from this one (the why is in shared/appimage-relaunch.ts). No Electron here, so that a test can give the
// `spawn` it wants and no process is ever started by a test.

import { spawn, type ChildProcess } from 'node:child_process'
import { appImageRelaunch } from '@shared/appimage-relaunch'

/**
 * Starts the helper that will start `file` once this process has ended: detached (its own session, so it outlives this process and is not in its group), no
 * input or output, never a shell line (the file is an argument). Resolves once the system has started the helper, rejects when it could not be (the caller
 * then puts the old AppImage back and Lucium stays open).
 */
export function relaunchAppImageDetached(file: string, pid: number = process.pid, env: Readonly<Record<string, string | undefined>> = process.env, start: typeof spawn = spawn): Promise<void> {
  const { command, args, env: cleaned, cwd } = appImageRelaunch(file, pid, env)
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = start(command, args, { detached: true, stdio: 'ignore', env: cleaned, cwd, shell: false })
    } catch (error) {
      return reject(error instanceof Error ? error : new Error(String(error)))
    }
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
