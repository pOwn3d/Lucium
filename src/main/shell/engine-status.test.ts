import { describe, expect, it, vi } from 'vitest'
import type { Components } from '../engine/widevine'
import { collectEngineHost, widevineVersion, type HostSources } from './engine-status'

const sources = (over: Partial<HostSources> = {}): HostSources => ({
  versions: { electron: '45.0.0', node: '24.1.0', v8: '14.6' },
  arch: 'arm64',
  osRelease: '27.2.0',
  components: null,
  metrics: [{ memory: { workingSetSize: 500_000 } }, { memory: { workingSetSize: 512_000 } }],
  log: ['one', 'two'],
  ...over
})
const components = (status: Components['status']): Components => ({ whenReady: async () => undefined, status })

describe('what the main process says of the engine', () => {
  it('names the runtime, the machine, the memory of all the processes and the log', () => {
    expect(collectEngineHost(sources())).toEqual({ electron: '45.0.0', node: '24.1.0', v8: '14.6', arch: 'arm64', osRelease: '27.2.0', variant: 'standard', widevine: null, processes: 2, memoryMb: 988, log: ['one', 'two'] })
  })

  it('is the DRM variant, with the version of Widevine, only on the castLabs build', () => {
    const host = collectEngineHost(sources({ components: components(() => ({ a: { title: 'Other', version: '1' }, w: { title: 'Widevine Content Decryption Module', version: '4.10.2891.0' } })) }))
    expect(host.variant).toBe('ecs')
    expect(host.widevine).toBe('4.10.2891.0')
    expect(collectEngineHost(sources({ components: components(() => ({})) })).widevine).toBeNull()
  })

  it('says Widevine is absent, and writes why, when the module would not answer', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(widevineVersion(components(() => { throw new Error('not ready') }))).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[status]'), expect.any(Error))
    warn.mockRestore()
  })
})
