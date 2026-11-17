// What a script injected after a click (activeTab, no host permission) is given of its extension, in the isolated world of the tab. Chromium gives `chrome.runtime`, `chrome.storage`
// and the messages only to the worlds it makes itself (the content scripts of the manifest, and `chrome.scripting` with a host permission). Lucium runs the script of a lent tab
// itself (active-tab-script.ts), so it makes the same few things for it: the main frame of the tab carries a small bridge to the main process (preload/lent-tab.ts), exposed in the world
// of that extension only, and the extension's own worker answers what the script asks of it. Pure rules here; the wiring is in engine/lent-tabs.ts.
//
// What it is: `chrome.runtime.id`, `getURL`, `getManifest`, `sendMessage` and `onMessage`; `chrome.storage.local` and `.sync` with `onChanged`; a message each way, between the script
// and the worker of the extension. What it is not: ports (`runtime.connect`), messages to another extension, `chrome.storage.session`, the other `chrome.*` APIs, a frame that is not
// the top one. The page itself is given none of it: the bridge exists in the world of the extension, which the page cannot reach.

/** The first of the isolated worlds given to the scripts of extensions: away from the worlds the application uses (4 200 0xx). */
export const SCRIPT_WORLDS_FROM = 4_300_000

/** How many worlds the preload of a tab will make a bridge in: more extensions than a person ever loads, and no world below the first (0 is the page, 999 is the preload's own). */
export const SCRIPT_WORLDS_COUNT = 4096

/** The three channels between the preload of a tab and the main process (shared/ipc-channels.ts has them as `Channel.lentTabAttach`, `lentTabAttached` and `lentTabCall`): written here, so that the preload does not carry the list of every channel. */
export const LENT_CHANNEL = { attach: 'lucium:lent-tab-attach', attached: 'lucium:lent-tab-attached', call: 'lucium:lent-tab-call' } as const

/** The name of the bridge in the world of the extension, and of the object the main process calls to hand the script a message. */
export const LENT_BRIDGE_KEY = '__luciumLentBridge'
export const LENT_RUNTIME_KEY = '__luciumLentRuntime'

/** The most text one answer, or one message of the extension for a script, may hold (the JSON of it). The extension platform allows 64 MiB for a message; the main process hands over 16. */
export const LENT_PAYLOAD_MAX = 16 * 1024 * 1024

/**
 * The most text one call of a script may hold (the JSON of its message, or of what it stores), in characters. It is read before the call is parsed, and the cost of parsing is what it bounds: a text of 15 million
 * characters that is only brackets takes the main process 800 ms and eight to ten times as much memory as it has characters (the budget below counts characters, so it cannot see that). A message of a script of a
 * page is far smaller than this; a value of 4 million characters is the most a script of a tab may store in one call.
 */
export const LENT_CALL_MAX = 4 * 1024 * 1024

/** What a script is told when the text it handed over, or the answer it was given, is longer than is taken. */
export const TOO_LONG = 'The text handed over is too long.'

/** The calls the bridge of a tab offers. */
export const LENT_OPS = ['send', 'storage'] as const
export const isLentOp = (op: unknown): op is (typeof LENT_OPS)[number] => LENT_OPS.some((name) => name === op)

/**
 * The most text one extension may have on its way to the main process at once, in characters: the preload of the tab counts it for each world and answers a call that would pass it with a closed port without
 * sending it (the text would be received before it could be refused), and the main process counts it again for each extension, the asks that wait included (engine/lent-asks.ts).
 */
export const LENT_BUDGET_CHARACTERS = 16 * 1024 * 1024

/** What the extension platform answers a sender with no receiver, and one whose receivers did not answer: the same words, so that an extension that looks for them finds them. */
export const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.'
export const PORT_CLOSED = 'The message port closed before a response was received.'
/** What a script of a tab that is no longer lent to its extension is told, as a context that was cut off is. */
export const CONTEXT_INVALIDATED = 'Extension context invalidated.'

/** Whether a world is one the preload of a tab may make a bridge in. */
export const isLentWorld = (world: unknown): world is number => Number.isInteger(world) && (world as number) >= SCRIPT_WORLDS_FROM && (world as number) < SCRIPT_WORLDS_FROM + SCRIPT_WORLDS_COUNT

export const LENT_AREAS = ['local', 'sync'] as const
export type LentArea = (typeof LENT_AREAS)[number]
export const LENT_STORAGE_METHODS = ['get', 'set', 'remove', 'clear', 'getBytesInUse'] as const
export type LentStorageMethod = (typeof LENT_STORAGE_METHODS)[number]

/** What the script of a tab asks of the main process: a message for the worker of its extension, or a call of its storage. */
export type LentCall = { op: 'send'; message: unknown } | { op: 'storage'; area: LentArea; method: LentStorageMethod; args: unknown[] }

/**
 * How many characters of JSON the value would take, counted without writing it: strings by their length, the other values by what they usually take, and over `limit` (or nested too deep) as soon as that is
 * known, which is the answer `Infinity`. It walks what a worker sent, which can be anything the structured clone carries (a string of 150 MiB, an array of twenty million items, a typed array, a cycle), and
 * is the way to refuse it before it is written out and copied.
 */
export function sizeAtMost(value: unknown, limit: number): number {
  const state = { size: 0, depth: 0 }
  return visit(value, state, limit) ? state.size : Infinity
}

function visit(item: unknown, state: { size: number; depth: number }, limit: number): boolean {
  switch (typeof item) {
    case 'string':
      state.size += item.length + 2
      return state.size <= limit
    case 'number':
      state.size += 8
      return state.size <= limit
    case 'boolean':
      state.size += 5
      return state.size <= limit
    case 'object': {
      if (item === null) {
        state.size += 4
        return state.size <= limit
      }
      if (state.depth >= 64) return false
      state.depth++
      let within = true
      if (Array.isArray(item)) {
        state.size += 2
        for (let i = 0; i < item.length && within; i++) {
          // A hole, undefined, a function or a symbol is written as `null` in an array.
          const left = item[i] === undefined || typeof item[i] === 'function' || typeof item[i] === 'symbol'
          state.size += left ? 5 : 1
          within = visit(item[i], state, limit)
        }
      } else if (ArrayBuffer.isView(item)) {
        // A typed array is written as an object with a key for each item.
        state.size += ((item as unknown as { length?: number }).length ?? item.byteLength) * 8
      } else {
        state.size += 2
        for (const key of Object.keys(item)) {
          state.size += key.length + 4
          within = state.size <= limit && visit((item as Record<string, unknown>)[key], state, limit)
          if (!within) break
        }
      }
      state.depth--
      return within && state.size <= limit
    }
    default:
      // undefined, a function or a symbol is left out of the JSON; a bigint stops the writing, and is said then.
      return true
  }
}

/** What the worker answers (and what the main process hands back to the script): the value, or the words of an error. */
export type LentAnswer = { ok: true; value?: unknown } | { ok: false; error: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reads a call of the bridge: an operation and its JSON. Throws, in words a person can read in the journal, for anything the bridge does not offer. */
export function readLentCall(op: unknown, payload: unknown): LentCall {
  if (typeof payload !== 'string') throw new Error('The call carries no text.')
  // Before anything is parsed: the cost of parsing is what the cap is for.
  if (payload.length > LENT_CALL_MAX) throw new Error(TOO_LONG)
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new Error('The call is not JSON.')
  }
  if (!isRecord(parsed)) throw new Error('The call carries no object.')
  if (op === 'send') {
    if (!('message' in parsed)) throw new Error('The call carries no message.')
    return { op: 'send', message: parsed['message'] }
  }
  if (op === 'storage') {
    const area = LENT_AREAS.find((name) => name === parsed['area'])
    const method = LENT_STORAGE_METHODS.find((name) => name === parsed['method'])
    const args = parsed['args']
    if (area === undefined || method === undefined) throw new Error('This storage call is not offered to a script of a tab.')
    if (!Array.isArray(args) || args.length > 1) throw new Error('A storage call takes one argument at most.')
    return { op: 'storage', area, method, args }
  }
  throw new Error('This call is not offered to a script of a tab.')
}

/** What the main process hands back to the script: the answer as JSON (an answer is never thrown: the words of an error are the script's to read). */
export function answerText(answer: LentAnswer): string {
  return JSON.stringify(answer)
}

/** Reads what the worker answered, which is its own and not to be trusted for its shape. */
export function readLentAnswer(raw: unknown): LentAnswer {
  if (!isRecord(raw)) return { ok: false, error: 'The extension gave no answer.' }
  if (raw['ok'] === true) return 'value' in raw ? { ok: true, value: raw['value'] } : { ok: true }
  return { ok: false, error: typeof raw['error'] === 'string' ? raw['error'] : 'The extension gave no answer.' }
}

/** The origin of an address, or the address itself when it has none (an opaque origin writes "null"). */
export function originOfUrl(url: string): string {
  if (!URL.canParse(url)) return url
  const { origin } = new URL(url)
  return origin === 'null' ? url : origin
}

/** What a listener of the worker is told of a script of a tab that wrote to it: the extension, the page and the top frame; the tab itself is added by the worker (the real one). */
export function senderOfScript(extensionId: string, url: string): { id: string; url: string; origin: string; frameId: 0; documentLifecycle: 'active' } {
  return { id: extensionId, url, origin: originOfUrl(url), frameId: 0, documentLifecycle: 'active' }
}

/** What a script of a tab is told of the context that wrote to it (its own extension): the extension, and the address of the worker or the page that sent. */
export function senderOfExtension(extensionId: string, url: unknown): { id: string; url: string; origin: string } {
  const own = `chrome-extension://${extensionId}`
  return { id: extensionId, url: typeof url === 'string' && url.startsWith(`${own}/`) && url.length <= 2048 ? url : `${own}/`, origin: own }
}
