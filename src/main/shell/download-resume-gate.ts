// The gate of "Reprendre les téléchargements après un redémarrage": the engine reads its file of records only while the setting is on, and
// removes it when the setting goes off. The same stop also runs when the window closes with the setting still on, and then the records and
// the partial files stay for the next launch: the gate looks at the setting to tell the two apart.

import { isFeatureOn } from '@shared/features'
import type { DownloadInfo } from '@shared/model'
import type { DownloadResumeOptions } from '../engine/types'
import type { FeatureGates, Gate, GateStore } from './feature-gate'

export interface ResumeEngine {
  startDownloadResume(options: DownloadResumeOptions): DownloadInfo[]
  stopDownloadResume(purge: boolean): void
}

/** A notice made while the application starts waits for the window to be shown (the lock does the same). */
const STARTUP_NOTICE_DELAY_MS = 2000

export function gateDownloadResume(
  gates: FeatureGates,
  deps: { engine: ResumeEngine; store: GateStore; options: DownloadResumeOptions; adopt(rows: readonly DownloadInfo[]): void; drop(): void }
): Gate {
  return gates.gate('download-resume', {
    start: () => {
      let starting = true
      const notify = (message: string): void => {
        if (starting) setTimeout(() => deps.options.notify(message), STARTUP_NOTICE_DELAY_MS)
        else deps.options.notify(message)
      }
      try {
        deps.adopt(deps.engine.startDownloadResume({ ...deps.options, notify }))
      } finally {
        starting = false
      }
      return () => {
        const switchedOff = !isFeatureOn(deps.store.get().settings, 'download-resume')
        deps.engine.stopDownloadResume(switchedOff)
        deps.drop()
      }
    }
  })
}
