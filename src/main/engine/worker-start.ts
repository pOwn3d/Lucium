// Starting the service worker of an extension for an event the library sends it (electron-chrome-extensions, `sendEvent`, which calls this through
// its patch: patches/electron-chrome-extensions@4.10.0.patch). Left to itself, the library asked Electron for a start at every event: a burst (the
// `tabs.onUpdated` of each load, during "Actualiser tous les onglets") asked again while the first start was under way, Electron refused the others
// ("Failed to start service worker."), those events were lost for the extension and the log filled with bare lines.

/** The part of `session.serviceWorkers` the start needs (Electron's ServiceWorkers; `W` is its ServiceWorkerMain). */
export interface ServiceWorkersSide<W> {
  startWorkerForScope(scope: string): Promise<W>
  /** The running workers, by version id. */
  getAllRunning(): Record<number, { scope: string }>
  getWorkerFromVersionID(versionId: number): W | undefined
}

/** What the library calls (the router's `startWorker`): resolves the running worker of `scope`, for the event `eventName` of `extensionId`. */
export type WorkerStart<W> = (scope: string, extensionId: string, eventName: string) => Promise<W>

export interface WorkerStarterOptions {
  /** The name of an extension, for the line of a failed start. */
  nameOf?: (extensionId: string) => string | undefined
  warn?: (message: string) => void
  /** How long a start refused is waited for (another start under way), and how often the running workers are looked at meanwhile. */
  limitMs?: number
  pollMs?: number
  now?: () => number
  wait?: (ms: number) => Promise<void>
}

/** The wait of `deliverToWorker` and `wakeExtension` (electron-engine-bridge.ts) for the same refusal. */
export const WORKER_START_LIMIT_MS = 10_000
export const WORKER_START_POLL_MS = 50

/**
 * The start the library is handed. A worker already running is given at once. Otherwise one start per worker at a time: the events that come
 * while it is under way wait for that start and get the same worker, none asks for another. When Electron refuses (a start already under way
 * elsewhere: an alarm, `deliverToWorker`, a click on the icon), the worker is waited for until it runs, `limitMs` at most. A start that fails
 * writes one line, which names the extension and the events lost, and rejects: the library then writes nothing of its own.
 */
export function workerStarter<W>(workers: ServiceWorkersSide<W>, options: WorkerStarterOptions = {}): WorkerStart<W> {
  const limitMs = options.limitMs ?? WORKER_START_LIMIT_MS
  const pollMs = options.pollMs ?? WORKER_START_POLL_MS
  const now = options.now ?? Date.now
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const warn = options.warn ?? ((message: string) => console.warn(message))
  /** The start under way for each scope, with the events that wait for it. */
  const pending = new Map<string, { promise: Promise<W>; events: Set<string> }>()

  const running = (scope: string): W | undefined => {
    for (const [versionId, info] of Object.entries(workers.getAllRunning())) {
      if (info.scope !== scope) continue
      const worker = workers.getWorkerFromVersionID(Number(versionId))
      if (worker !== undefined) return worker
    }
    return undefined
  }

  const start = async (scope: string, extensionId: string, events: ReadonlySet<string>): Promise<W> => {
    let refusal: unknown
    try {
      return await workers.startWorkerForScope(scope)
    } catch (error) {
      refusal = error
    }
    const deadline = now() + limitMs
    for (;;) {
      const worker = running(scope)
      if (worker !== undefined) return worker
      if (now() >= deadline) break
      await wait(pollMs)
    }
    const name = options.nameOf?.(extensionId)
    const who = name ? `${name} (${extensionId})` : extensionId
    const reason = refusal instanceof Error ? refusal.message : String(refusal)
    warn(`[extensions] the worker of ${who} did not start within ${limitMs / 1000} s (${reason}): lost ${[...events].join(', ')}`)
    throw new Error(`The worker of ${extensionId} did not start`, { cause: refusal })
  }

  return (scope, extensionId, eventName) => {
    const under = pending.get(scope)
    if (under) {
      under.events.add(eventName)
      return under.promise
    }
    const worker = running(scope)
    if (worker !== undefined) return Promise.resolve(worker)
    const events = new Set([eventName])
    const promise: Promise<W> = start(scope, extensionId, events).finally(() => {
      if (pending.get(scope)?.promise === promise) pending.delete(scope)
    })
    pending.set(scope, { promise, events })
    return promise
  }
}
