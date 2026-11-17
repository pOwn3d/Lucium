import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRESSURE_READING_TTL_MS, pressureReader, type PressureSources } from './sleep-pressure'

const sources = (patch: Partial<PressureSources> = {}): PressureSources & { calls: () => number } => {
  let calls = 0
  const base: PressureSources = {
    platform: 'darwin',
    sysctl: () => {
      calls++
      return Promise.resolve('1\n')
    },
    freeMemory: () => 50,
    totalMemory: () => 100,
    now: () => 0,
    ...patch
  }
  return { ...base, calls: () => calls }
}

afterEach(() => vi.restoreAllMocks())

describe('the memory pressure the sleep sweep reads', () => {
  it('is what macOS says', async () => {
    expect(await pressureReader(sources({ sysctl: () => Promise.resolve('4\n') }))()).toBe('critical')
    expect(await pressureReader(sources({ sysctl: () => Promise.resolve('2') }))()).toBe('warning')
  })

  it('keeps a reading for 30 s, so that the sweeps of several windows start one program', async () => {
    let now = 0
    const system = sources({ now: () => now })
    const read = pressureReader(system)
    await read()
    now = PRESSURE_READING_TTL_MS - 1
    await read()
    expect(system.calls()).toBe(1)
    now = PRESSURE_READING_TTL_MS
    await read()
    expect(system.calls()).toBe(2)
  })

  it('falls back on the free memory when sysctl fails or prints what it should not, and says so when it fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failing = sources({ sysctl: () => Promise.reject(new Error('no sysctl')), freeMemory: () => 4, totalMemory: () => 100 })
    expect(await pressureReader(failing)()).toBe('critical')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('memory pressure'), 'no sysctl')
    expect(await pressureReader(sources({ sysctl: () => Promise.resolve('banana'), freeMemory: () => 8, totalMemory: () => 100 }))()).toBe('warning')
  })

  it('starts no program elsewhere than macOS', async () => {
    const system = sources({ platform: 'linux', freeMemory: () => 9, totalMemory: () => 100 })
    expect(await pressureReader(system)()).toBe('warning')
    expect(system.calls()).toBe(0)
  })
})
