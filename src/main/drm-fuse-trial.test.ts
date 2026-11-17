import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CASTLABS_FUSES,
  CASTLABS_FUSES_OPTION,
  CASTLABS_SET,
  FUSE_DISABLED,
  FUSE_ENABLED,
  TRIAL_FUSES,
  TRIAL_NAMES,
  castlabsReleaseFuses,
  fuseOptionsProblem,
  fuseTrial,
  trialWireProblem,
  type WantedFuse
} from './drm-fuse-trial'

// The trial copies of scripts/package-drm.mjs --fuse-trial: one fuse closed, or castLabs' set, beside the installed application, with a name, an
// identifier and a data folder of their own; and the installed variant with castLabs' set (--castlabs-fuses). The script is
// not run here (it talks to castLabs' service and signs with the maintainer's identity).
const ROOT = '/repo'
const builderConfig = readFileSync(fileURLToPath(new URL('../../electron-builder.yml', import.meta.url)), 'utf8')
/** The value the normal application gives a fuse (electron-builder.yml, electronFuses): what "closed" means. */
const normalValue = (fuse: string): boolean => {
  const found = new RegExp(`^ {2}${fuse}: (true|false)$`, 'm').exec(builderConfig)?.[1]
  if (!found) throw new Error(`electron-builder.yml does not set ${fuse}`)
  return found === 'true'
}
/** The wire of castLabs' 45.0.0-alpha.14+wvcus as @electron/fuses read it (nine positions, the last one unnamed by @electron/fuses 1.8.0). */
const castLabsWire = { version: '1', 0: 0x31, 1: 0x30, 2: 0x31, 3: 0x31, 4: 0x30, 5: 0x30, 6: 0x30, 7: 0x31, 8: 0x31 }
/** The positions of the fuses in the wire (FuseV1Options of @electron/fuses 1.8.0). */
const POSITIONS: Record<string, number> = {
  runAsNode: 0,
  enableCookieEncryption: 1,
  enableNodeOptionsEnvironmentVariable: 2,
  enableNodeCliInspectArguments: 3,
  enableEmbeddedAsarIntegrityValidation: 4,
  onlyLoadAppFromAsar: 5
}
const wantedOf = (changed: Record<string, boolean>): WantedFuse[] => Object.entries(changed).map(([fuse, enabled]) => ({ fuse, position: POSITIONS[fuse], enabled }))
/**
 * castLabs' set as castlabs/electron-releases#152 gives it, written out here rather than imported: RunAsNode, EnableNodeOptionsEnvironmentVariable and
 * EnableNodeCliInspectArguments off, OnlyLoadAppFromAsar, EnableEmbeddedAsarIntegrityValidation and EnableCookieEncryption on;
 * LoadBrowserProcessSpecificV8Snapshot and GrantFileProtocolExtraPrivileges at their defaults, so not written. GrantFileProtocolExtraPrivileges must
 * stay on: castLabs' FAQ asks for it on, and the interface is read from file:// inside app.asar through it; what it grants the local pages of the tabs is
 * taken back by src/main/engine/local-file-guard.ts.
 */
const CASTLABS_TICKET_SET = {
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  onlyLoadAppFromAsar: true,
  enableEmbeddedAsarIntegrityValidation: true,
  enableCookieEncryption: true
}

describe('fuseTrial', () => {
  it('closes exactly one fuse, to the value of the normal application, and keeps castLabs\' value for the others', () => {
    expect(TRIAL_FUSES).toHaveLength(5)
    for (const fuse of TRIAL_FUSES) {
      const trial = fuseTrial(ROOT, fuse)!
      expect(trial.changed, fuse).toEqual({ [fuse]: normalValue(fuse) })
      expect(trial.fuses, fuse).toEqual({ ...CASTLABS_FUSES, [fuse]: normalValue(fuse) })
    }
  })

  it('sets castLabs\' set exactly: the five closed as in the normal application, cookie encryption on, nothing else', () => {
    const trial = fuseTrial(ROOT, CASTLABS_SET)!
    expect(trial.changed).toEqual(CASTLABS_TICKET_SET)
    expect(trial.fuses).toEqual(CASTLABS_TICKET_SET)
    for (const fuse of TRIAL_FUSES) expect(trial.changed[fuse], fuse).toBe(normalValue(fuse))
  })

  it('writes each copy in a folder of its own, apart from dist-drm/, and never in /Applications', () => {
    const outputs = TRIAL_NAMES.map((name) => fuseTrial(ROOT, name)!.output)
    expect(outputs).toEqual(TRIAL_NAMES.map((name) => join(ROOT, 'dist-drm-trial', name)))
    expect(outputs).toContain(join(ROOT, 'dist-drm-trial', 'castlabs-set'))
    for (const output of outputs) {
      expect(output.startsWith(join(ROOT, 'dist-drm') + sep)).toBe(false)
      expect(output).not.toContain('/Applications')
    }
  })

  it('gives each copy a name, an identifier and a data folder that are neither the installed application\'s nor another copy\'s', () => {
    const trials = TRIAL_NAMES.map((name) => fuseTrial(ROOT, name)!)
    expect(trials).toHaveLength(6)
    for (const key of ['productName', 'appId', 'dataName'] as const) expect(new Set(trials.map((trial) => trial[key].toLowerCase())).size, key).toBe(6)
    for (const trial of trials) {
      expect(['lucium', 'lucium drm']).not.toContain(trial.productName.toLowerCase())
      expect(['app.lucium.browser', 'app.lucium.browser.drm']).not.toContain(trial.appId)
      // The data folder of the installed application is ~/Library/Application Support/Lucium (the productName of package.json; macOS ignores the case).
      expect(trial.dataName.toLowerCase()).not.toBe('lucium')
    }
    expect(fuseTrial(ROOT, 'runAsNode')).toMatchObject({ productName: 'Lucium essai runAsNode', appId: 'app.lucium.browser.drm.trial.runasnode', dataName: 'lucium-essai-runasnode' })
    expect(fuseTrial(ROOT, CASTLABS_SET)).toMatchObject({ productName: 'Lucium essai castlabs-set', appId: 'app.lucium.browser.drm.trial.castlabs-set', dataName: 'lucium-essai-castlabs-set' })
  })

  it('refuses what is not one of the five fuses nor castLabs\' set, a property every object has included', () => {
    for (const name of ['', 'grantFileProtocolExtraPrivileges', 'wasmTrapHandlers', 'enableCookieEncryption', 'RunAsNode', 'castlabs', 'CASTLABS-SET', '../../Applications', 'toString', '__proto__']) {
      expect(fuseTrial(ROOT, name), name).toBeNull()
    }
  })
})

describe('the installed DRM variant (--castlabs-fuses)', () => {
  it('writes castLabs\' set exactly, the one EVS signed for the trial copy, and nothing else', () => {
    const release = castlabsReleaseFuses()
    expect(release.changed).toEqual(CASTLABS_TICKET_SET)
    expect(release.fuses).toEqual(CASTLABS_TICKET_SET)
    // The very set of the trial copy that EVS signed and Netflix played in, not a set of its own.
    expect(release.fuses).toEqual(fuseTrial(ROOT, CASTLABS_SET)!.fuses)
  })

  it('has no name, identifier nor data folder of its own: the real application, its profile', () => {
    expect(Object.keys(castlabsReleaseFuses()).sort()).toEqual(['changed', 'fuses', 'name'])
  })

  it('is accepted by the check of the wire with castLabs\' set applied, and only it', () => {
    const release = castlabsReleaseFuses()
    const wanted = wantedOf(release.changed)
    const setWire = { ...castLabsWire, 0: FUSE_DISABLED, 1: FUSE_ENABLED, 2: FUSE_DISABLED, 3: FUSE_DISABLED, 4: FUSE_ENABLED, 5: FUSE_ENABLED }
    expect(trialWireProblem(castLabsWire, setWire, wanted, release.name)).toBeNull()
    expect(trialWireProblem(castLabsWire, { ...setWire, 1: FUSE_DISABLED }, wanted, release.name)).toMatch(/enableCookieEncryption is not set to true/)
    expect(trialWireProblem(castLabsWire, castLabsWire, wanted, release.name)).toMatch(/runAsNode is not set to false/)
    expect(trialWireProblem(castLabsWire, { ...setWire, 6: FUSE_ENABLED }, wanted, release.name)).toMatch(/besides castlabs-fuses: positions 6 /)
  })
})

describe('fuseOptionsProblem', () => {
  it('refuses --castlabs-fuses with --no-fuses or --fuse-trial: one build, one set of fuses', () => {
    expect(CASTLABS_FUSES_OPTION).toBe('--castlabs-fuses')
    expect(fuseOptionsProblem(['--castlabs-fuses', '--no-fuses'])).toMatch(/--castlabs-fuses and --no-fuses/)
    expect(fuseOptionsProblem(['--no-fuses', '--as-lucium', '--castlabs-fuses'])).toMatch(/--no-fuses/)
    expect(fuseOptionsProblem(['--castlabs-fuses', '--fuse-trial', 'castlabs-set'])).toMatch(/--fuse-trial/)
    expect(fuseOptionsProblem(['--fuse-trial=runAsNode', '--castlabs-fuses'])).toMatch(/--fuse-trial/)
  })

  it('accepts the flags of scripts/build-drm-release.sh, of its --original-fuses, and of the trials', () => {
    expect(fuseOptionsProblem(['--castlabs-fuses', '--as-lucium', '--vmp', '--apple'])).toBeNull()
    expect(fuseOptionsProblem(['--no-fuses', '--as-lucium', '--vmp'])).toBeNull()
    expect(fuseOptionsProblem(['--no-fuses'])).toBeNull()
    expect(fuseOptionsProblem(['--vmp', '--apple', '--fuse-trial', 'castlabs-set'])).toBeNull()
    expect(fuseOptionsProblem([])).toBeNull()
  })

  // Signed by the team under the identifier of the application, a build with castLabs' fuses open is installed by Squirrel from any feed that names
  // it. scripts/build-drm-release.sh refuses it, and package-drm.mjs is also run alone.
  it('refuses the Developer ID (--apple) on castLabs\' fuses left open: with --no-fuses, and under the name of the application without --castlabs-fuses', () => {
    expect(fuseOptionsProblem(['--no-fuses', '--as-lucium', '--vmp', '--apple'])).toMatch(/never signed with a Developer ID/)
    expect(fuseOptionsProblem(['--no-fuses', '--vmp', '--apple'])).toMatch(/never signed with a Developer ID/)
    expect(fuseOptionsProblem(['--no-fuses', '--vmp', '--apple', '--fuse-trial', 'castlabs-set'])).toMatch(/never signed with a Developer ID/)
    expect(fuseOptionsProblem(['--as-lucium', '--vmp', '--apple'])).toMatch(/--as-lucium with --apple.*takes --castlabs-fuses/)
  })
})

describe('the normal application (electron-builder.yml)', () => {
  it('sets castLabs\' set too, cookie encryption included: it opens the profile of the DRM variant, and the cookie fuse is one way', () => {
    const block = /^electronFuses:\n((?: {2}.*\n)+)/m.exec(builderConfig)?.[1] ?? ''
    const written = Object.fromEntries([...block.matchAll(/^ {2}(\w+): (true|false)$/gm)].map(([, fuse, value]) => [fuse, value === 'true']))
    const { resetAdHocDarwinSignature, ...fuses } = written
    expect(resetAdHocDarwinSignature).toBe(true)
    expect(fuses).toEqual(CASTLABS_TICKET_SET)
    expect(normalValue('enableCookieEncryption')).toBe(true)
  })
})

describe('trialWireProblem', () => {
  const runAsNode = wantedOf(fuseTrial(ROOT, 'runAsNode')!.changed)
  const asar = wantedOf(fuseTrial(ROOT, 'onlyLoadAppFromAsar')!.changed)
  const set = wantedOf(fuseTrial(ROOT, CASTLABS_SET)!.changed)
  /** castLabs' wire with the set applied: positions 0 to 5 flipped, 6 to 8 untouched. */
  const setWire = { ...castLabsWire, 0: FUSE_DISABLED, 1: FUSE_ENABLED, 2: FUSE_DISABLED, 3: FUSE_DISABLED, 4: FUSE_ENABLED, 5: FUSE_ENABLED }

  it('accepts the wire of castLabs with the tried fuse alone closed', () => {
    expect(trialWireProblem(castLabsWire, { ...castLabsWire, 0: FUSE_DISABLED }, runAsNode, 'runAsNode')).toBeNull()
    expect(trialWireProblem(castLabsWire, { ...castLabsWire, 5: FUSE_ENABLED }, asar, 'onlyLoadAppFromAsar')).toBeNull()
  })

  it('accepts the wire of castLabs with its set, and only it', () => {
    expect(trialWireProblem(castLabsWire, setWire, set, CASTLABS_SET)).toBeNull()
    // One fuse of the set left as castLabs ships it: cookie encryption off, or the integrity check off.
    expect(trialWireProblem(castLabsWire, { ...setWire, 1: FUSE_DISABLED }, set, CASTLABS_SET)).toMatch(/enableCookieEncryption is not set to true/)
    expect(trialWireProblem(castLabsWire, { ...setWire, 4: FUSE_DISABLED }, set, CASTLABS_SET)).toMatch(/enableEmbeddedAsarIntegrityValidation is not set to true/)
    // A fuse outside the set changed with it.
    expect(trialWireProblem(castLabsWire, { ...setWire, 6: FUSE_ENABLED }, set, CASTLABS_SET)).toMatch(/besides castlabs-set: positions 6 /)
    expect(trialWireProblem(castLabsWire, { ...setWire, 8: FUSE_DISABLED }, set, CASTLABS_SET)).toMatch(/positions 8 /)
  })

  it('refuses another fuse changed with it, the one @electron/fuses has no name for included', () => {
    expect(trialWireProblem(castLabsWire, { ...castLabsWire, 0: FUSE_DISABLED, 1: FUSE_ENABLED }, runAsNode, 'runAsNode')).toMatch(/besides runAsNode: positions 1 /)
    expect(trialWireProblem(castLabsWire, { ...castLabsWire, 0: FUSE_DISABLED, 8: FUSE_DISABLED }, runAsNode, 'runAsNode')).toMatch(/positions 8 /)
    // A position the built binary has and castLabs' has not (a longer wire) is a change too.
    expect(trialWireProblem(castLabsWire, { ...castLabsWire, 0: FUSE_DISABLED, 9: FUSE_ENABLED }, runAsNode, 'runAsNode')).toMatch(/positions 9 /)
  })

  it('refuses a wire where the tried fuse did not close', () => {
    expect(trialWireProblem(castLabsWire, castLabsWire, runAsNode, 'runAsNode')).toMatch(/runAsNode is not set to false/)
    expect(trialWireProblem(castLabsWire, { ...castLabsWire, 5: FUSE_DISABLED }, asar, 'onlyLoadAppFromAsar')).toMatch(/onlyLoadAppFromAsar is not set to true/)
  })

  it('refuses a fuse @electron/fuses has no position for', () => {
    expect(trialWireProblem(castLabsWire, castLabsWire, [{ fuse: 'enableCookieEncryption', position: undefined, enabled: true }], CASTLABS_SET)).toMatch(/no position for enableCookieEncryption/)
  })

  it('refuses a wire of another version', () => {
    expect(trialWireProblem(castLabsWire, { ...castLabsWire, version: '2', 0: FUSE_DISABLED }, runAsNode, 'runAsNode')).toMatch(/version 2/)
  })
})
