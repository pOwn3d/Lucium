import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FEATURES } from '@shared/features'

// A switch is only worth its place in the pane if some code reads the setting behind it, not an option the code never consults. The
// registry, the model, the cleaning of a loaded state, the catalogues and the panes of the Settings window that only show and write the
// setting do not count: what counts is the code that does what the setting says, or the gate (`gates.gate('id', …)`) that starts the feature.
const SRC = fileURLToPath(new URL('..', import.meta.url))
const NOT_A_CONSUMER = /^(shared\/(features|perf-features|model|state-clean|i18n-fr|i18n-en|ipc-policy)\.ts|renderer\/(\w*Settings\w*|settings-parts)\.tsx)$/

function sources(dir: string): Array<{ file: string; code: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    const file = relative(SRC, path)
    if (!/\.tsx?$/.test(file) || /\.test\.ts$/.test(file) || /\.d\.ts$/.test(file) || /(^|\/)smoke[^/]*\.ts$/.test(file) || NOT_A_CONSUMER.test(file)) return []
    return [{ file, code: readFileSync(path, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n') }]
  })
}

describe('the code behind each switch of the registry', () => {
  const files = sources(SRC)

  it('has a reader for every feature: the setting is read by code that is not a settings pane, or the feature has a gate', () => {
    const unread = FEATURES.filter((feature) => {
      const key = new RegExp(`\\b${feature.key}\\b`)
      const gate = new RegExp(`\\.gate\\('${feature.id}'`)
      return !files.some(({ code }) => key.test(code) || gate.test(code))
    }).map((feature) => `${feature.id} (${feature.key})`)
    expect(unread, `Interrupteur dont aucun code ne lit le réglage : ${unread.join(', ')}. Une fonction sans lecteur ne fait rien : branchez-la, ou retirez l'entrée de FEATURES.`).toEqual([])
  })

  it('finds a reader through the gate alone for the features whose setting is read by the portal, not by name', () => {
    const portal = FEATURES.filter((feature) => !files.some(({ code }) => new RegExp(`\\b${feature.key}\\b`).test(code))).map((feature) => feature.id)
    // Each of them has its gate (the test above), and the gate follows the setting through the registry (featureRuns): nothing is read by name.
    for (const id of portal) expect(files.some(({ code }) => new RegExp(`\\.gate\\('${id}'`).test(code)), id).toBe(true)
  })
})
