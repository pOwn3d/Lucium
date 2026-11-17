// The fuses of the DRM variant written over castLabs' build by `node scripts/package-drm.mjs`: its trial copies (`--fuse-trial <fuse | castlabs-set>`,
// docs/drm.md, « Essais des fusibles ») and the installed variant (`--castlabs-fuses`, « Fusibles : l'ensemble castLabs »). Not part of the
// application (nothing in it imports this file); the script reads it with Node's own TypeScript, like mac-sign-order.ts.
//
// Why: castLabs' signing service (EVS) refuses a binary whose fuses changed outside what it accepts. A copy asks it for one fuse, or for the one set
// castLabs says EVS signs (castlabs/electron-releases#152). With 45.0.0-alpha.14 it refused all five fuses, each closed alone, and signed that set;
// Netflix plays in it, and the installed variant moved to it. A copy is built beside the installed application, never in /Applications, under a
// name, an identifier and a data folder of its own: it neither replaces the installed application nor reads or writes its profile.
import { join } from 'node:path'

/** The fuses of castLabs' build as it ships (45.0.0-alpha.14+wvcus, read with @electron/fuses): Electron's own defaults. */
export const CASTLABS_FUSES = {
  runAsNode: true,
  enableNodeOptionsEnvironmentVariable: true,
  enableNodeCliInspectArguments: true,
  onlyLoadAppFromAsar: false,
  enableEmbeddedAsarIntegrityValidation: false
} as const

export type TrialFuse = keyof typeof CASTLABS_FUSES
export const TRIAL_FUSES = Object.keys(CASTLABS_FUSES) as TrialFuse[]

/** The trial of the set below, beside the trials of one fuse. */
export const CASTLABS_SET = 'castlabs-set'

/**
 * The one set of fuses EVS signs besides castLabs' defaults, according to castLabs (castlabs/electron-releases#152, 9 and 10 July 2025): the five
 * closed and the cookies encrypted. Every other fuse stays at its default. The installed DRM variant has it, and so does the
 * normal application (electron-builder.yml): both open one profile, and a build without cookie encryption cannot read the cookies the other encrypted.
 */
export const CASTLABS_SIGNED_SET = {
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  onlyLoadAppFromAsar: true,
  enableEmbeddedAsarIntegrityValidation: true,
  enableCookieEncryption: true
} as const

/** A fuse a trial or the installed variant may set, in the spelling of electron-builder's electronFuses. */
export type SetFuse = keyof typeof CASTLABS_SIGNED_SET
export type TrialName = TrialFuse | typeof CASTLABS_SET
export const TRIAL_NAMES: TrialName[] = [...TRIAL_FUSES, CASTLABS_SET]

/** The states of a fuse in the wire of the binary: the ASCII digits '1' and '0' (@electron/fuses, FuseState). */
export const FUSE_ENABLED = 0x31
export const FUSE_DISABLED = 0x30

/** The fuses package-drm.mjs writes over castLabs' build, then reads back from the binary before EVS sees it. */
export interface FuseSet {
  /** What the messages of the script call it. */
  name: string
  /** The fuses that differ from castLabs' build, each with the value the build gives it. */
  changed: Partial<Record<SetFuse, boolean>>
  /** Every fuse the build sets: castLabs' values, except the changed ones. */
  fuses: Partial<Record<SetFuse, boolean>>
}

/** The option of package-drm.mjs that builds the DRM variant with CASTLABS_SIGNED_SET (scripts/build-drm-release.sh passes it by default). */
export const CASTLABS_FUSES_OPTION = '--castlabs-fuses'

/**
 * The fuses of the DRM variant built with CASTLABS_FUSES_OPTION, under its real name, identifier and data folder: CASTLABS_SIGNED_SET, exactly. EVS
 * signed it and Netflix played in the trial copy of it; every other fuse stays at castLabs' value.
 */
export const castlabsReleaseFuses = (): FuseSet => ({ name: 'castlabs-fuses', changed: { ...CASTLABS_SIGNED_SET }, fuses: { ...CASTLABS_FUSES, ...CASTLABS_SIGNED_SET } })

/**
 * What is wrong with the fuse options given to package-drm.mjs, or null. One build has one set of fuses: CASTLABS_FUSES_OPTION writes castLabs' set,
 * --no-fuses keeps castLabs' build as it is, and --fuse-trial builds a copy with its own; so the first goes with neither of the others.
 * And the Developer ID (--apple) never signs castLabs' fuses left open, neither with --no-fuses nor, under the name of the application
 * (--as-lucium), for want of `--castlabs-fuses`.
 */
export function fuseOptionsProblem(argv: readonly string[]): string | null {
  // castLabs' fuses open (RunAsNode, NODE_OPTIONS and the inspector on) and the signature of the team do not go together: Squirrel installs, from
  // any feed that names it, whatever the team signed under the identifier of the application. scripts/build-drm-release.sh refuses it too; this
  // script is also run alone.
  if (argv.includes('--apple')) {
    if (argv.includes('--no-fuses')) return `--no-fuses keeps castLabs' fuses open: such a build is never signed with a Developer ID (--apple). It is the way back on this Mac, signed ad hoc`
    if (argv.includes('--as-lucium') && !argv.includes(CASTLABS_FUSES_OPTION)) {
      return `--as-lucium with --apple builds the application that is handed out: it takes ${CASTLABS_FUSES_OPTION}, or castLabs' fuses would stay open under the signature of the team`
    }
  }
  if (!argv.includes(CASTLABS_FUSES_OPTION)) return null
  if (argv.includes('--no-fuses')) return `${CASTLABS_FUSES_OPTION} and --no-fuses are two sets of fuses: give one (--no-fuses keeps castLabs' fuses open)`
  if (argv.some((arg) => arg === '--fuse-trial' || arg.startsWith('--fuse-trial='))) {
    return `${CASTLABS_FUSES_OPTION} builds the installed variant, --fuse-trial a copy beside it with fuses of its own: not both`
  }
  return null
}

export interface FuseTrial extends FuseSet {
  /** What --fuse-trial was given: one of TRIAL_NAMES. */
  name: TrialName
  /** The fuses that differ from castLabs' build, each with the value the trial gives it: one for a fuse, the six of CASTLABS_SIGNED_SET for the set. */
  changed: Partial<Record<SetFuse, boolean>>
  productName: string
  appId: string
  /** The `name` and the `productName` of the package.json inside the app: Electron names the data folder after the productName (~/Library/Application Support/<dataName>). */
  dataName: string
  /** Where electron-builder writes the copy: dist-drm-trial/<name>/ in the repository (ignored by git), apart from dist-drm/. */
  output: string
}

/** A fuse in the spelling of @electron/fuses (FuseV1Options), to find its place in the wire read back from the binary. */
export const wireName = (fuse: string): string => `${fuse.charAt(0).toUpperCase()}${fuse.slice(1)}`

/** The trial of one fuse (closed to the value of electron-builder.yml), or of CASTLABS_SET; null when the name is neither. */
export function fuseTrial(root: string, name: string): FuseTrial | null {
  let changed: Partial<Record<SetFuse, boolean>>
  if (name === CASTLABS_SET) changed = { ...CASTLABS_SIGNED_SET }
  else if (Object.hasOwn(CASTLABS_FUSES, name)) changed = { [name]: !CASTLABS_FUSES[name as TrialFuse] }
  else return null
  const slug = name.toLowerCase()
  return {
    name: name as TrialName,
    changed,
    productName: `Lucium essai ${name}`,
    appId: `app.lucium.browser.drm.trial.${slug}`,
    dataName: `lucium-essai-${slug}`,
    output: join(root, 'dist-drm-trial', name),
    fuses: { ...CASTLABS_FUSES, ...changed }
  }
}

/** A fuse wire as @electron/fuses' getCurrentFuseWire gives it: `version`, then one state per position ('0', '1', 'r' as their codes). */
export type FuseWire = Record<string, unknown>

/** A fuse a trial or the installed variant changes, at its position in the wire (FuseV1Options; undefined when @electron/fuses has no name for it). */
export interface WantedFuse {
  fuse: string
  position: number | undefined
  enabled: boolean
}

/**
 * What is wrong with the wire of a build (a trial copy, or the installed variant with castLabs' set) against the one of castLabs' build, or null when
 * the positions of `wanted` alone changed, each to its value. Every position is compared, those @electron/fuses has no name for included: EVS refuses
 * any change outside what it signs.
 */
export function trialWireProblem(castLabs: FuseWire, built: FuseWire, wanted: WantedFuse[], name: string): string | null {
  if (castLabs.version !== built.version) return `fuse wire version ${String(built.version)}, castLabs' build has ${String(castLabs.version)}`
  const unknown = wanted.filter((fuse) => typeof fuse.position !== 'number')
  if (unknown.length > 0) return `@electron/fuses has no position for ${unknown.map((fuse) => fuse.fuse).join(', ')}`
  const positions = [...new Set([...Object.keys(castLabs), ...Object.keys(built)])].filter((key) => key !== 'version')
  const changed = positions.filter((key) => castLabs[key] !== built[key])
  const others = changed.filter((key) => !wanted.some((fuse) => String(fuse.position) === key))
  if (others.length > 0) return `fuses changed besides ${name}: positions ${others.join(', ')} of the wire`
  for (const { fuse, position, enabled } of wanted) {
    const state = enabled ? FUSE_ENABLED : FUSE_DISABLED
    if (built[String(position)] !== state) return `${fuse} is not set to ${enabled} in the binary (state ${String(built[String(position)])}, expected ${state})`
  }
  return null
}
