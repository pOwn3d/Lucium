// The memory pressure of the system, read when the sleep sweep runs (it has no timer of its own): macOS tells it in
// `kern.memorystatus_vm_pressure_level`; elsewhere, or when that cannot be read, the share of free memory stands for it (shared/sleep.ts).

import { execFile } from 'node:child_process'
import { freemem, totalmem } from 'node:os'
import { pressureOfFreeMemory, pressureOfLevel, type MemoryPressure } from '@shared/sleep'

/** One reading serves every sweep that comes within this time: the sweeps of three windows do not start three programs a minute. */
export const PRESSURE_READING_TTL_MS = 30_000
const SYSCTL_TIMEOUT_MS = 2000

export interface PressureSources {
  platform: NodeJS.Platform
  /** Resolves what `sysctl -n kern.memorystatus_vm_pressure_level` printed; rejects when it could not run. */
  sysctl: () => Promise<string>
  freeMemory: () => number
  totalMemory: () => number
  now: () => number
}

const sysctl = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: SYSCTL_TIMEOUT_MS }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
  })

const SYSTEM: PressureSources = { platform: process.platform, sysctl, freeMemory: freemem, totalMemory: totalmem, now: Date.now }

/** A reader of the pressure that keeps its last reading for `PRESSURE_READING_TTL_MS`. */
export function pressureReader(sources: PressureSources = SYSTEM): () => Promise<MemoryPressure> {
  let last: { at: number; reading: Promise<MemoryPressure> } | null = null
  const fromFreeMemory = (): MemoryPressure => pressureOfFreeMemory(sources.freeMemory(), sources.totalMemory())
  const read = async (): Promise<MemoryPressure> => {
    if (sources.platform !== 'darwin') return fromFreeMemory()
    const printed = await sources.sysctl().catch((error: unknown) => {
      console.warn('[sleep] cannot read the memory pressure of the system, the free memory stands for it:', (error as Error).message)
      return ''
    })
    return pressureOfLevel(printed) ?? fromFreeMemory()
  }
  return () => {
    const now = sources.now()
    if (last && now - last.at < PRESSURE_READING_TTL_MS) return last.reading
    last = { at: now, reading: read() }
    return last.reading
  }
}

/** The reader the sweeps of every window share. */
export const memoryPressure = pressureReader()
