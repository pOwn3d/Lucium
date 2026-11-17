import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ENGINE_EXCEPTION_FILE, ENGINE_EXCEPTION_MIN_REASON, drmEngineProblem, expectedEngine, readEngineException } from './drm-engine-guard'

// The guard of the engine of the DRM variant: 0.2.15 was handed out on castLabs 45.0.0-alpha.14+wvcus while
// package.json pinned Electron 45.2.1, and the script only warned. The script signs and talks to castLabs' service, so it is not run here: the
// decision is tested on its own, and the script is read as text for where it asks for it.
const read = (relative: string) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
const PINNED = '45.2.1'
const REASON = 'castLabs has not published 45.2.3+wvcus yet; 45.2.1+wvcus is its newest stable build of the line'
const exceptionFor = (engine: string, pinned: string, reason = REASON) => JSON.stringify({ engine, pinned, reason })
const problem = (engine: string, pinned = PINNED, raw: string | null = null) => drmEngineProblem({ engine, pinned, exception: readEngineException(raw, pinned).exception })

describe('drmEngineProblem', () => {
  it('accepts the stable castLabs build of the pinned Electron', () => {
    expect(problem('45.2.1+wvcus')).toBeNull()
    expect(problem('v45.2.1+wvcus\n')).toBeNull()
  })

  it('refuses a prerelease: the alpha 0.2.15 shipped on, a beta, a nightly', () => {
    expect(problem('45.0.0-alpha.14+wvcus')).toContain('a prerelease (alpha.14)')
    expect(problem('46.0.0-beta.2+wvcus')).toContain('a prerelease (beta.2)')
    expect(problem('46.0.0-nightly.20261026+wvcus')).toContain('a prerelease (nightly.20261026)')
  })

  it('refuses a prerelease even when it is the pinned Electron, and even with an exception written for it', () => {
    expect(problem('45.0.0-alpha.14+wvcus', '45.0.0-alpha.14')).toContain('a prerelease')
    const forced = { engine: '45.0.0-alpha.14', pinned: PINNED, reason: REASON }
    expect(drmEngineProblem({ engine: '45.0.0-alpha.14+wvcus', pinned: PINNED, exception: forced })).toContain('no exception allows one')
  })

  it('refuses an engine without the wvcus marker: the official Electron, or another marker', () => {
    expect(problem('45.2.1')).toContain('without the "+wvcus" marker')
    expect(problem('45.2.1+wvvmp')).toContain('without the "+wvcus" marker')
    expect(problem('45.2.1+notwvcus')).toContain('without the "+wvcus" marker')
  })

  it('refuses a stable castLabs build that is not the pinned Electron, older or newer', () => {
    expect(problem('44.9.3+wvcus')).toContain('package.json pins Electron 45.2.1')
    expect(problem('45.2.3+wvcus')).toContain('package.json pins Electron 45.2.1')
    expect(problem('45.2.10+wvcus')).toContain(ENGINE_EXCEPTION_FILE)
    expect(problem('45.2.1+wvcus', '45.2.3')).toContain('package.json pins Electron 45.2.3')
  })

  it('refuses what is not a version, and a pin that is a range', () => {
    expect(problem('')).toContain('not a version')
    expect(problem('45.2+wvcus')).toContain('not a version')
    expect(problem('45.2.1+wvcus', '^45.2.1')).toContain('not a stable version written in full')
    expect(problem('45.2.1+wvcus', '')).toContain('not a stable version written in full')
  })

  it('accepts another stable engine with a written exception, and then only that one', () => {
    const raw = exceptionFor('45.2.1', '45.2.3')
    expect(problem('45.2.1+wvcus', '45.2.3', raw)).toBeNull()
    expect(problem('45.2.3+wvcus', '45.2.3', raw)).toContain('allows 45.2.1+wvcus only')
    expect(problem('44.9.3+wvcus', '45.2.3', raw)).toContain('allows 45.2.1+wvcus only')
    expect(problem('45.2.1', '45.2.3', raw)).toContain('without the "+wvcus" marker')
  })
})

describe('readEngineException', () => {
  it('has no exception and no problem when the file is absent', () => {
    expect(readEngineException(null, PINNED)).toEqual({ exception: null, problem: null })
  })

  it('reads engine, pinned and reason', () => {
    expect(readEngineException(exceptionFor('45.2.1', '45.2.3'), '45.2.3')).toEqual({ exception: { engine: '45.2.1', pinned: '45.2.3', reason: REASON }, problem: null })
  })

  it('says a problem, never "no exception", for a file that is there but wrong', () => {
    const wrong = (raw: string, pinned = '45.2.3') => {
      const result = readEngineException(raw, pinned)
      expect(result.exception).toBeNull()
      return result.problem
    }
    expect(wrong('{')).toContain('not JSON')
    expect(wrong('[]')).toContain('not an object')
    expect(wrong('null')).toContain('not an object')
    expect(wrong(JSON.stringify({ engine: '45.2.1', pinned: '45.2.3' }))).toContain('three strings')
    expect(wrong(exceptionFor('45.0.0-alpha.14', '45.2.3'))).toContain('never allows a prerelease')
    expect(wrong(exceptionFor('45.2.1+wvcus', '45.2.3'))).toContain('not a stable version written in full')
    expect(wrong(exceptionFor('45.2.1', '45.2.3', 'castLabs is late'))).toContain(`at least ${ENGINE_EXCEPTION_MIN_REASON} characters`)
    expect(wrong(exceptionFor('45.2.1', '45.2.3', ' '.repeat(60)))).toContain('the reason must say why')
    expect(wrong(exceptionFor('45.2.3', '45.2.3'))).toContain('nothing to except')
  })

  it('no longer holds once package.json pins another Electron than the one it was written for', () => {
    const result = readEngineException(exceptionFor('45.2.1', '45.2.3'), '45.3.0')
    expect(result.exception).toBeNull()
    expect(result.problem).toContain('written for Electron 45.2.3, but package.json pins 45.3.0')
  })
})

describe('expectedEngine', () => {
  it('is the pinned Electron, or the engine of the exception', () => {
    expect(expectedEngine(PINNED, null)).toBe('45.2.1')
    expect(expectedEngine('45.2.3', { engine: '45.2.1', pinned: '45.2.3', reason: REASON })).toBe('45.2.1')
  })
})

describe('scripts/package-drm.mjs and the guard', () => {
  const script = read('scripts/package-drm.mjs')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')

  it('stops on the problem of the engine and of the exception file, before anything is built', () => {
    const guard = script.indexOf('if (engineProblem) fail(')
    const exception = script.indexOf('if (engineException.problem) fail(engineException.problem)')
    const firstBuild = script.indexOf("run('")
    expect(guard).toBeGreaterThan(-1)
    expect(exception).toBeGreaterThan(-1)
    expect(firstBuild).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(firstBuild)
    expect(exception).toBeLessThan(guard)
    expect(script).toContain('const engineProblem = drmEngineProblem({ engine: electronVersion, pinned: pinnedElectron, exception: engineException.exception })')
  })

  it('compares the version file of the engine with the Electron of package.json, and reads the exception from its one file', () => {
    expect(script).toContain("const electronVersion = readFileSync(join(ecsDist, 'version'), 'utf8').trim().replace(/^v/, '')")
    expect(script).toContain("const pinnedElectron = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies?.electron ?? '')")
    expect(script).toContain('const engineExceptionPath = join(root, ENGINE_EXCEPTION_FILE)')
    expect(script).toContain("readEngineException(existsSync(engineExceptionPath) ? readFileSync(engineExceptionPath, 'utf8') : null, pinnedElectron)")
  })

  it('names no engine version itself: the default folder follows package.json, and no option lifts the guard', () => {
    expect(script).toContain('join(tools, `ecs-${expectedEngine(pinnedElectron, engineException.exception)}`)')
    expect(script).not.toMatch(/ecs-\d/)
    expect(script).not.toMatch(/allow-prerelease|skip-engine|no-engine-check|LUCIUM_ALLOW/i)
  })
})

describe('the repository', () => {
  it('pins a stable Electron written in full, and carries no engine exception that does not hold', () => {
    const pinned = String(JSON.parse(read('package.json')).devDependencies.electron)
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/)
    const path = fileURLToPath(new URL(`../../${ENGINE_EXCEPTION_FILE}`, import.meta.url))
    expect(readEngineException(existsSync(path) ? readFileSync(path, 'utf8') : null, pinned).problem).toBeNull()
  })
})
