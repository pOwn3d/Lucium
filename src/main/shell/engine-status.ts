// What only the main process knows of the engine: the versions of the runtime, the platform, Widevine, the memory of the processes and the error
// log. Read when Settings › Général asks (and for nobody else); the pure part is here so that it is tested without Electron.

import type { EngineHost } from '@shared/engine-status'
import type { Components } from '../engine/widevine'

export interface HostSources {
  versions: Readonly<Record<string, string | undefined>>
  arch: string
  osRelease: string
  /** The `components` module of the castLabs build of Electron, or null on the Electron of the project. */
  components: Components | null
  /** `app.getAppMetrics()`: the working set of each process, in kilobytes. */
  metrics: readonly { memory: { workingSetSize: number } }[]
  log: readonly string[]
}

/** The version of the Widevine module the castLabs build installed, or null when there is none (or the module cannot say). */
export function widevineVersion(components: Components | null): string | null {
  if (!components) return null
  try {
    return Object.values(components.status()).find((component) => /widevine/i.test(component?.title ?? ''))?.version ?? null
  } catch (error) {
    // The module is there but would not answer: the pane then says "absent", and the log says why.
    console.warn('[status] the components module could not say whether Widevine is installed:', error)
    return null
  }
}

export function collectEngineHost(sources: HostSources): EngineHost {
  const { versions } = sources
  return {
    electron: versions['electron'] ?? '',
    node: versions['node'] ?? '',
    v8: versions['v8'] ?? '',
    arch: sources.arch,
    osRelease: sources.osRelease,
    variant: sources.components ? 'ecs' : 'standard',
    widevine: widevineVersion(sources.components),
    processes: sources.metrics.length,
    memoryMb: Math.round(sources.metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0) / 1024),
    log: [...sources.log]
  }
}
