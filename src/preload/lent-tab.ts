// Loaded into the main frame of the tabs of a profile (registered by the engine, see engine/electron-engine-preloads.ts; Electron loads a session preload into the main frame only). It
// does nothing until the main process says so: a script that an extension injects into a tab the user lent it (activeTab) is given the few things of `chrome` it needs
// (shared/lent-tab-runtime.ts), in the isolated world of that extension, and this is the one place that makes them. The page is given nothing: the bridge is exposed in a world of
// the extension (never the page's own, never this preload's), which the scripts of the page cannot reach, and the channels live in this isolated world. The main process
// checks every call again: who sends (the main frame of a tab), whose world it is, whether the tab is still lent, and that the call carries the token this document was given with the
// bridge (engine/lent-tabs.ts). The token stays here, in this preload's world: it is not handed to the world of the script.

import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { answerText, isLentOp, isLentWorld, LENT_BRIDGE_KEY, LENT_BUDGET_CHARACTERS, LENT_CALL_MAX, LENT_CHANNEL, LENT_RUNTIME_KEY, NO_RECEIVER, PORT_CLOSED, TOO_LONG } from '../shared/lent-tab-runtime'
import { installLentRuntime, type LentRuntimeInit } from './lent-tab-runtime'

/** The worlds of this document that already have their bridge: a world takes it once, and a new document starts the list again. */
const bridged = new Set<number>()
/** What the calls of each world carry for the main process: given with the runtime, read when a call is made, and never put in the world of the script. */
const tokens = new Map<number, string>()
/** The characters each world has sent to the main process and not had the answer to: what would pass the budget is not sent (see `callBridge`). */
const inFlight = new Map<number, number>()

/**
 * The one call of the bridge of a world. Nothing is sent that the main process would only receive to refuse it (it would hold it, and read it, before it could): an operation the bridge does not offer, what
 * is not a text, a text longer than a call may be, and what would pass the budget of what this world may have on its way, which is answered as the main process answers an ask it cannot keep (a closed port).
 */
function callBridge(world: number, op: unknown, payload: unknown): Promise<string> {
  if (!isLentOp(op)) return Promise.reject(new Error('This call is not offered to a script of a tab.'))
  if (typeof payload !== 'string') return Promise.reject(new Error('The call carries no text.'))
  if (payload.length > LENT_CALL_MAX) return Promise.reject(new Error(TOO_LONG))
  const used = inFlight.get(world) ?? 0
  if (used + payload.length > LENT_BUDGET_CHARACTERS) return Promise.resolve(answerText({ ok: false, error: PORT_CLOSED }))
  inFlight.set(world, used + payload.length)
  const release = (): void => void inFlight.set(world, (inFlight.get(world) ?? 0) - payload.length)
  return ipcRenderer.invoke(LENT_CHANNEL.call, world, tokens.get(world), op, payload).then(
    (answer: string) => (release(), answer),
    (error: unknown) => {
      release()
      throw error
    }
  )
}

const isExtensionId = (value: unknown): value is string => typeof value === 'string' && /^[a-p]{32}$/.test(value)

/** What the main process says of the extension: its id, its manifest and the permissions it holds; and the token of the calls of its world (kept apart: the world is not given it). */
function readInit(raw: unknown): { init: Pick<LentRuntimeInit, 'extensionId' | 'manifest' | 'permissions'>; token: string } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { extensionId, manifest, permissions, token } = raw as { extensionId?: unknown; manifest?: unknown; permissions?: unknown; token?: unknown }
  if (!isExtensionId(extensionId) || !Array.isArray(permissions) || typeof token !== 'string' || token.length < 16 || token.length > 128) return null
  return { init: { extensionId, manifest, permissions: permissions.filter((name): name is string => typeof name === 'string').slice(0, 256) }, token }
}

ipcRenderer.on(LENT_CHANNEL.attach, (_event, nonce: unknown, world: unknown, raw: unknown) => {
  if (typeof nonce !== 'string') return
  const tell = (ok: boolean, reason?: string): void => ipcRenderer.send(LENT_CHANNEL.attached, nonce, ok, reason)
  const read = readInit(raw)
  if (!isLentWorld(world) || read === null) return tell(false, 'the main process asked for a world or an extension this preload does not take')
  try {
    // The token of this document for this world: the same each time the runtime is asked for again, new for the next document.
    tokens.set(world, read.token)
    if (!bridged.has(world)) {
      // One call, and a text for what it carries and what it answers: nothing of this world's objects crosses, and the main process reads the call again.
      contextBridge.exposeInIsolatedWorld(world, LENT_BRIDGE_KEY, { call: (op: unknown, payload: unknown): Promise<string> => callBridge(world, op, payload) })
      bridged.add(world)
    }
    const given: LentRuntimeInit = { ...read.init, bridgeKey: LENT_BRIDGE_KEY, runtimeKey: LENT_RUNTIME_KEY, noReceiver: NO_RECEIVER, portClosed: PORT_CLOSED }
    webFrame.executeJavaScriptInIsolatedWorld(world, [{ code: `(${installLentRuntime})(${JSON.stringify(given)})` }]).then(
      () => tell(true),
      (error: unknown) => tell(false, error instanceof Error ? error.message : String(error))
    )
  } catch (error) {
    tell(false, error instanceof Error ? error.message : String(error))
  }
})
