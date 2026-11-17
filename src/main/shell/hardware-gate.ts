// Ties the web hardware service of the engine (main/engine/web-hardware.ts) to its setting: the engine installs nothing while the setting is off.

import type { Settings } from '@shared/model'
import { openConnectionNotice } from '@shared/web-hardware'
import type { FeatureGates } from './feature-gate'
import { t } from '@shared/i18n'

/** The part of the engine the gate drives. */
export interface WebHardwareEngine {
  /** Switches the service; switching off returns how many tabs held a grant. */
  setWebHardware(enabled: boolean): number
}

export function gateWebHardware(gates: FeatureGates, engine: WebHardwareEngine, settings: () => Settings, toast: (message: string) => void): void {
  gates.gate('web-hardware', {
    start: () => {
      engine.setWebHardware(true)
      return () => {
        const holders = engine.setWebHardware(false)
        // At the application's exit the setting is still on: only a switch the user turned off is announced.
        if (holders > 0 && !settings().webHardware) toast(t('hardware-gate.l-acces-aux-appareils-est-coupe-open-connection', { OPEN_CONNECTION_NOTICE: openConnectionNotice() }))
      }
    }
  })
}
