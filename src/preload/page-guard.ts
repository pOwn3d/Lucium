// Loaded into the main frame of the web pages of a session while the blocker's scriptlets or the fingerprint protection are on (registered and
// taken away again by the engine, see electron-engine-network.ts), and into the service workers of the web while the fingerprint protection is on.
// Electron loads a preload into the main frame only: the frames inside a page and its other workers are reached by the engine another way
// (src/main/engine/inner-guard.ts). It asks the main process what this document gets, synchronously, because the page must not run a line before it is protected, and
// hands the answer to guard-world.ts, which Electron serializes into the main world. It gives the page no way back to the main process: the
// channel lives in this isolated world.

import { contextBridge, ipcRenderer } from 'electron'
import { cleanGuardPlan, isEmptyPlan, NO_PLAN, PAGE_GUARD, type GuardPlan } from '../shared/page-guard'
import { guardWorld } from './guard-world'

/** A service worker of the web loads this script too, while the fingerprint protection is on (the engine registers it for them). */
const inWorker = (globalThis as { process?: { type?: unknown } }).process?.type === 'service-worker'

/** The address of this document, or of this worker: a worker has no `location` to read in this world, so its main world is asked. */
function address(): string {
  if (!inWorker) return globalThis.location?.href ?? ''
  return String(contextBridge.executeInMainWorld({ func: () => String((globalThis as { location?: { href?: unknown } }).location?.href ?? '') }) ?? '')
}

function ask(): GuardPlan {
  try {
    const href = address()
    // Only the worker of a web site has someone to answer it (the engine listens on the channel of those): an extension's must not wait for an answer.
    if (inWorker && !/^https?:\/\//i.test(href)) return NO_PLAN
    return cleanGuardPlan(ipcRenderer.sendSync(PAGE_GUARD.plan, href))
  } catch (error) {
    // The page runs unprotected rather than not at all; the console says why.
    console.warn('[lucium] the page guard could not ask what this page gets:', error instanceof Error ? error.message : String(error))
    return NO_PLAN
  }
}

const plan = ask()
if (!isEmptyPlan(plan)) {
  try {
    contextBridge.executeInMainWorld({ func: guardWorld, args: [plan] })
  } catch (error) {
    // A document without a main world to patch (a sandboxed frame, a page being replaced) keeps what it has.
    console.warn('[lucium] the page guard could not be installed in this frame:', error instanceof Error ? error.message : String(error))
  }
}
