// Which castLabs build of Electron `node scripts/package-drm.mjs` accepts to build the DRM variant on (docs/drm.md, « Le garde-fou du moteur »).
// Not part of the application (nothing in it imports this file); the script reads it with Node's own TypeScript, like drm-fuse-trial.ts.
//
// Why: 0.2.15 was handed out on castLabs 45.0.0-alpha.14+wvcus while package.json pinned Electron 45.2.1, and nothing stopped the build (a
// warning when the version did not contain "45."). The engine that is shipped must be the one the unit tests, the engine contract and the CI run on:
//   - never a prerelease (alpha, beta, nightly), whatever is written anywhere;
//   - never a build without the "+wvcus" marker (no Widevine: not the DRM variant);
//   - the version pinned in package.json, unless ENGINE_EXCEPTION_FILE, the only place for it, names another stable one and says why.
// It imports nothing: Node reads it as it is, without resolving a TypeScript import.

/** "45.2.1", "45.0.0-alpha.14+wvcus": the numbers, the prerelease ("alpha.14", "nightly.20261026"; none for a stable) and the build metadata ("wvcus"). */
const VERSION = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

/** The one file an exception is written in, relative to the root of the repository. Absent: no exception. */
export const ENGINE_EXCEPTION_FILE = 'build/drm-engine-exception.json'

/** A reason shorter than this says nothing ("castLabs", "todo"). */
export const ENGINE_EXCEPTION_MIN_REASON = 30

/** What ENGINE_EXCEPTION_FILE holds: the DRM variant is built on `engine` while package.json pins `pinned`, because of `reason`. */
export interface EngineException {
  /** The castLabs version to build on, without the marker: "45.2.1". */
  engine: string
  /** The Electron package.json pins when the exception is written. Once the pin moves, the exception no longer holds: it is written again or removed. */
  pinned: string
  reason: string
}

/** A stable version written in full ("45.2.1"): no range, no prerelease, no marker. */
const isStable = (version: string): boolean => /^\d+\.\d+\.\d+$/.test(version)

/**
 * The exception of ENGINE_EXCEPTION_FILE (`raw` is its text, null when the file is absent), or why it cannot be used. A file that is there but
 * wrong is a problem, never "no exception": the build must not go on as if nobody had written it.
 */
export function readEngineException(raw: string | null, pinned: string): { exception: EngineException | null; problem: string | null } {
  if (raw === null) return { exception: null, problem: null }
  const bad = (why: string) => ({ exception: null, problem: `${ENGINE_EXCEPTION_FILE}: ${why}` })
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return bad('not JSON')
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return bad('not an object { engine, pinned, reason }')
  const { engine, pinned: writtenFor, reason } = data as Record<string, unknown>
  if (typeof engine !== 'string' || typeof writtenFor !== 'string' || typeof reason !== 'string') return bad('engine, pinned and reason must be three strings')
  if (!isStable(engine)) return bad(`engine "${engine}" is not a stable version written in full (45.2.1): an exception never allows a prerelease`)
  if (reason.trim().length < ENGINE_EXCEPTION_MIN_REASON) return bad(`the reason must say why, in at least ${ENGINE_EXCEPTION_MIN_REASON} characters`)
  if (writtenFor !== pinned) return bad(`written for Electron ${writtenFor}, but package.json pins ${pinned}: write it again for this version or remove the file`)
  if (engine === pinned) return bad(`engine ${engine} is the pinned Electron: nothing to except, remove the file`)
  return { exception: { engine, pinned: writtenFor, reason: reason.trim() }, problem: null }
}

/** The castLabs version the build must be on: the pinned Electron, or the engine of the exception. */
export const expectedEngine = (pinned: string, exception: EngineException | null): string => exception?.engine ?? pinned

/**
 * Why the DRM variant cannot be built on this engine, or null when it can.
 * `engine` is the text of the `version` file of the unzipped castLabs build ("45.2.1+wvcus"), `pinned` the `devDependencies.electron` of package.json.
 */
export function drmEngineProblem(input: { engine: string; pinned: string; exception: EngineException | null }): string | null {
  const engine = input.engine.trim().replace(/^v/, '')
  const parsed = VERSION.exec(engine)
  if (!parsed) return `the castLabs build says its version is "${engine}", which is not a version`
  const [, numbers, prerelease, marker] = parsed
  if (prerelease !== undefined) return `the castLabs build is ${engine}, a prerelease (${prerelease}): the DRM variant is built on a stable engine only, and no exception allows one`
  if (marker !== 'wvcus') return `the engine is ${engine}, without the "+wvcus" marker: not a castLabs build with Widevine, the protected videos would not play`
  if (!isStable(input.pinned)) return `package.json pins Electron "${input.pinned}", which is not a stable version written in full: the engine cannot be compared with it`
  const wanted = expectedEngine(input.pinned, input.exception)
  if (numbers !== wanted) {
    return input.exception
      ? `the castLabs build is ${engine}, but ${ENGINE_EXCEPTION_FILE} allows ${wanted}+wvcus only (package.json pins ${input.pinned})`
      : `the castLabs build is ${engine}, but package.json pins Electron ${input.pinned}: build on ${input.pinned}+wvcus, or write a justified exception in ${ENGINE_EXCEPTION_FILE} (docs/drm.md)`
  }
  return null
}
