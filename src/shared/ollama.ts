import { LENGTH_CHARS, summaryPrompt, type SummaryLength } from './summary-prompt'
// The page summary by Ollama, on this Mac or on a computer of the local network: every request goes to a loopback address, to a private IP
// address or to a `.local` name (`isOllamaAddress`), and to nothing else. Never to a public host. A name is whatever a resolver answers: the
// main process resolves it at each request, refuses an answer that is not a private address, and connects to the address it checked
// (main/shell/ollama-fetch.ts).
// Ollama API: https://github.com/ollama/ollama/blob/main/docs/api.md

/** The way a request leaves the application: the main process passes Electron's net.fetch, which uses the proxy and the DNS of the session. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export interface OllamaConfig {
  enabled: boolean
  url: string
  model: string
  /** The most tokens a summary may take (`num_predict`): a ceiling under the one of each length (LENGTH_TOKENS). */
  maxTokens: number
  temperature: number
}

/** The bounds of the numbers of the configuration: what the settings offer, and what a request sends (a NaN or an Infinity would be `null` in JSON). */
export const OLLAMA_TOKENS_MIN = 100
export const OLLAMA_TOKENS_MAX = 2048
export const OLLAMA_TEMPERATURE_MAX = 2
const OLLAMA_URL_MAX = 500
const OLLAMA_MODEL_MAX = 100

export const DEFAULT_OLLAMA_CONFIG: OllamaConfig = {
  enabled: false,
  url: 'http://localhost:11434',
  model: 'mistral',
  // The ceiling does not cut a detailed summary (2 000 tokens) unless the user lowers it.
  maxTokens: OLLAMA_TOKENS_MAX,
  temperature: 0.7
}

const bounded = (value: unknown, min: number, max: number, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback)

/** The token ceiling a request sends: a whole number within the bounds, the default for anything else. */
export const ollamaTokens = (value: unknown): number => Math.round(bounded(value, OLLAMA_TOKENS_MIN, OLLAMA_TOKENS_MAX, DEFAULT_OLLAMA_CONFIG.maxTokens))

/** The temperature a request sends: within 0..2, the default for anything else. */
export const ollamaTemperature = (value: unknown): number => bounded(value, 0, OLLAMA_TEMPERATURE_MAX, DEFAULT_OLLAMA_CONFIG.temperature)

/**
 * The configuration of a saved file, field by field: a field of the wrong kind or out of its bounds gets its default (or its bound). An address
 * that is neither one of this Mac nor one of the local network (a public host, a name of the internet, a damaged file) gets the default address and
 * switches Ollama off: the summary then waits for the user to turn it on again. Fields it does not know are left out.
 */
export function cleanOllamaConfig(raw: unknown): OllamaConfig {
  const saved = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const local = typeof saved['url'] === 'string' && saved['url'].length <= OLLAMA_URL_MAX && isOllamaAddress(saved['url'])
  const refused = saved['url'] !== undefined && !local
  const model = typeof saved['model'] === 'string' && saved['model'].trim() !== '' && saved['model'].length <= OLLAMA_MODEL_MAX ? saved['model'] : DEFAULT_OLLAMA_CONFIG.model
  return {
    enabled: typeof saved['enabled'] === 'boolean' && !refused ? saved['enabled'] : DEFAULT_OLLAMA_CONFIG.enabled,
    url: local ? (saved['url'] as string) : DEFAULT_OLLAMA_CONFIG.url,
    model,
    maxTokens: ollamaTokens(saved['maxTokens']),
    temperature: ollamaTemperature(saved['temperature'])
  }
}

/**
 * The one way a request of this file leaves: to `path` of an address of this Mac or of the local network, and nowhere else. Any other address
 * throws before any request, and a redirect is an error, not followed: a program answering on the port cannot send the page text elsewhere.
 */
async function askOllama(fetcher: Fetcher, url: string, path: string, init: RequestInit): Promise<Response> {
  if (!isOllamaAddress(url)) throw new Error('the address of Ollama is neither one of this Mac nor one of the local network')
  return fetcher(`${url.replace(/\/$/, '')}${path}`, { ...init, redirect: 'error' })
}

/** What a summary gives the model: the text of the page and its address, the origin and path only (`addressForSummary`), never its title, query or fragment. */
export interface SummaryRequest {
  content: string
  url: string
  length?: SummaryLength
}

export interface SummaryResponse {
  summary: string
  model: string
  tokens: number
  duration: number
}

/** Test connection to Ollama and list available models */
export async function testOllamaConnection(url: string, fetcher: Fetcher = fetch): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  try {
    // The same way out as the summary (Electron's net.fetch), when the caller passes it.
    const response = await askOllama(fetcher, url, '/api/tags', { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    const data = (await response.json()) as { models?: Array<{ name: string }> }
    const models = data.models?.map((m) => m.name.split(':')[0]).filter((name): name is string => !!name) || []
    return { ok: true, models: [...new Set(models)] }
  } catch (error) {
    return { ok: false, error: `${(error as Error).message}` }
  }
}

/**
 * The model a summary runs with: the wanted one when Ollama has it installed, else the smallest installed (its full name, tag included).
 * `unreachable` when the server does not answer, `none` when it has no model at all, `refused` when its name does not lead to a private address.
 */
export async function resolveOllamaModel(url: string, wanted: string, fetcher: Fetcher = fetch): Promise<{ ok: true; model: string } | { ok: false; reason: 'unreachable' | 'none' | 'refused' }> {
  try {
    const response = await askOllama(fetcher, url, '/api/tags', { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return { ok: false, reason: 'unreachable' }
    const data = (await response.json()) as { models?: Array<{ name: string; size?: number }> }
    const models = data.models ?? []
    if (models.length === 0) return { ok: false, reason: 'none' }
    const chosen = models.find((m) => sameOllamaModel(m.name, wanted))
    if (chosen) return { ok: true, model: chosen.name }
    const smallest = [...models].sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity))[0]
    return { ok: true, model: smallest!.name }
  } catch (error) {
    // A name that leads to a public address is not a server that is down: the caller says so, in its own words.
    return { ok: false, reason: error instanceof OllamaNameRefused ? 'refused' : 'unreachable' }
  }
}

/**
 * A summary of the page text by the Ollama of the configuration. The request carries the instruction, the text (cut at the length's limit) and the
 * address given (the caller gives the origin and path only, `addressForSummary`): nothing else of the page. An address that is neither one of
 * this Mac nor a private one of the local network gets no request.
 */
export async function summarizeWithOllama(config: OllamaConfig, request: SummaryRequest, fetcher: Fetcher = fetch): Promise<SummaryResponse | null> {
  if (!config.enabled || !config.model || !isOllamaAddress(config.url)) return null

  try {
    const prompt = summaryPrompt(request.content.slice(0, LENGTH_CHARS[request.length ?? 'normal']), request.url, request.length ?? 'normal')

    const startTime = performance.now()
    const response = await askOllama(fetcher, config.url, '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        prompt,
        stream: false,
        options: {
          temperature: ollamaTemperature(config.temperature),
          num_predict: ollamaTokens(config.maxTokens),
          top_k: 40,
          top_p: 0.9,
        },
      }),
      signal: AbortSignal.timeout(30000),
    })

    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const data = (await response.json()) as { response?: string; eval_count?: number }
    const duration = performance.now() - startTime

    return {
      summary: data.response?.trim() || '',
      model: config.model,
      tokens: data.eval_count || 0,
      duration: Math.round(duration),
    }
  } catch (error) {
    console.error('[ai] the summary by Ollama failed:', error)
    return null
  }
}

/** The host of a web address a model may be named by (http or https, no user name or password in it, no spaces), or null. */
function ollamaHostOf(value: string): string | null {
  if (value.length > 2048 || /\s/.test(value)) return null
  try {
    const parsed = new URL(value)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '') return null
    return parsed.hostname.replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

/** Whether an address is one of this Mac: localhost, 127.0.0.1 or [::1], and nothing that only looks like them. The page text then stays here. */
export function isLocalOllamaAddress(value: string): boolean {
  const host = ollamaHostOf(value)
  return host !== null && isLoopbackHost(host)
}

/**
 * Whether an address is one the model may be asked at: a web address of this Mac, or of a computer of the local network named by its private IP
 * address (`isPrivateNetworkAddress`) or by a `.local` name (`ollamaNameOf`). A file, a scheme of the application, a public address and every
 * other host name are refused. A `.local` name is accepted here for what it is written as; what it leads to is checked at each request.
 */
export function isOllamaAddress(value: string): boolean {
  const host = ollamaHostOf(value)
  return host !== null && (isLoopbackHost(host) || isPrivateNetworkAddress(host) || LOCAL_NAME.test(host))
}

/** A name of the local network, as `URL` writes it: labels of letters, digits and hyphens that end in `.local`, with no dot after it. */
const LOCAL_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/

/**
 * The `.local` name an accepted address names its computer by, or null (an address of this Mac, an IP address, a refused address). Such an
 * address is sent to only once the name is resolved and the answer is a private address.
 */
export function ollamaNameOf(value: string): string | null {
  const host = ollamaHostOf(value)
  return host !== null && host.length <= 253 && LOCAL_NAME.test(host) ? host : null
}

/** A `.local` name that does not lead to a private address at the time of a request: nothing was sent. The message is the sentence for the user. */
export class OllamaNameRefused extends Error {
  override name = 'OllamaNameRefused'
}

/** Whether a host name of an address is this Mac: localhost, 127.0.0.1 or [::1], and nothing that only looks like them. */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/**
 * Whether an IP address is a private one, written as `URL` writes a host or as a resolver answers (an IPv4 address in four decimal numbers,
 * an IPv6 one in lower case): 10/8, 172.16/12, 192.168/16, the shared range 100.64/10 (the addresses a private mesh network such as Tailscale
 * gives its computers), or an IPv6 unique local address (fc00::/7). Not a link-local address (an IPv6 one needs a zone an address cannot
 * carry), not an IPv4 address written inside an IPv6 one, and no name.
 */
export function isPrivateNetworkAddress(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b, c, d] = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    if (a > 255 || b > 255 || c > 255 || d > 255) return false
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  return /^f[cd][0-9a-f]{2}:/.test(host) && !host.includes('.') && !host.includes('%')
}

/** Whether two names are the same Ollama model: Ollama reads a name without a tag as its `:latest` (`mistral` is `mistral:latest`). */
export function sameOllamaModel(a: string, b: string): boolean {
  const full = (name: string) => (name.includes(':') ? name : `${name}:latest`)
  return a === b || full(a.trim()) === full(b.trim())
}

/** The models a server listed, or why the list could not be read (the settings then fall back to typing the name). */
export type OllamaModelList = { ok: true; models: string[] } | { ok: false; error: string }

/** Most names kept from one answer, and the longest name: an answer is a list a person installed, not a document. */
const MODELS_MAX = 500
const MODEL_NAME_MAX = 200

/**
 * The models installed on the Ollama server at `url`, read from its /api/tags (the settings offer the server's list, no longer a
 * fixed one). Full names, tag included (`llama3.2:3b`), as the summary asks for them; sorted, without duplicates. The fetcher is required: in the
 * application it is Electron's net.fetch, by the main process, and only on a click of the settings (zero-cost-inventory.test.ts).
 */
export async function listOllamaModels(url: string, fetcher: Fetcher): Promise<OllamaModelList> {
  try {
    const response = await askOllama(fetcher, url, '/api/tags', { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    const data = (await response.json()) as { models?: unknown } | null
    if (!data || !Array.isArray(data.models)) return { ok: false, error: 'unexpected answer' }
    const names = data.models
      .slice(0, MODELS_MAX)
      .map((m: unknown) => (m !== null && typeof m === 'object' && typeof (m as { name?: unknown }).name === 'string' ? (m as { name: string }).name.trim() : ''))
      .filter((name) => name.length > 0 && name.length <= MODEL_NAME_MAX)
    return { ok: true, models: [...new Set(names)].sort((a, b) => a.localeCompare(b)) }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/** What the settings know of the server's list, and for which address it was asked (the field may have changed since). */
export type OllamaModelsRead = { url: string; status: 'loading' } | { url: string; status: 'ok'; models: string[] } | { url: string; status: 'failed'; error: string }

/** Reads the list for `url` through `ask` (in the settings, the request to the main process). A request that fails is a failed read, said on
 *  the screen and in the log, never thrown: the row then offers to type the name. */
export async function readOllamaModels(url: string, ask: (url: string) => Promise<OllamaModelList>): Promise<OllamaModelsRead> {
  try {
    const result = await ask(url)
    return result.ok ? { url, status: 'ok', models: result.models } : { url, status: 'failed', error: result.error }
  } catch (error) {
    console.warn('[ai] the models of Ollama could not be asked for:', error)
    return { url, status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

/** The field of the model row: the server's list once it is read for the address in the settings and holds a model, else typing the name
 *  (nothing read yet, reading, no answer, an empty server, or a list read for another address). */
export function ollamaModelField(read: OllamaModelsRead | null, url: string): 'list' | 'text' {
  return read !== null && read.url === url && read.status === 'ok' && read.models.length > 0 ? 'list' : 'text'
}

/** The models offered in the settings once the server's list is read: the installed ones, and the current choice when it is not among them
 *  (shown, so that opening the list never changes the setting by itself). `mistral` and `mistral:latest` are one entry. */
export function ollamaModelOptions(installed: readonly string[], current: string): string[] {
  const kept = current.trim().length > 0 && !installed.some((name) => sameOllamaModel(name, current)) ? [current] : []
  return [...new Set([...installed, ...kept])]
}

/** The settings that say whether a summary can be made. */
export interface SummarySettings {
  aiSummary: boolean
  ollamaConfig: Pick<OllamaConfig, 'enabled' | 'url'>
}

/**
 * Where the text of a page goes when a summary is asked, with the settings as they are:
 * `off` the summary is switched off; `none` the model is not ready (Ollama off, or an address that is refused); `local` Ollama on this Mac;
 * `network` Ollama on the computer of the local network at `host`: the page text then leaves this Mac, in clear when `clear` (http).
 * There is no other place.
 */
export type SummaryDestination = { kind: 'off' } | { kind: 'none' } | { kind: 'local' } | { kind: 'network'; host: string; clear: boolean }

export function summaryDestination(settings: SummarySettings): SummaryDestination {
  if (!settings.aiSummary) return { kind: 'off' }
  const config = settings.ollamaConfig
  if (!config.enabled || !isOllamaAddress(config.url)) return { kind: 'none' }
  if (isLocalOllamaAddress(config.url)) return { kind: 'local' }
  const address = new URL(config.url)
  return { kind: 'network', host: address.host, clear: address.protocol === 'http:' }
}

/**
 * The summary can be asked for (the entries « Résumer… » of the menus exist only then): Ollama is on, at an address of this Mac or of the local
 * network. `privatePage`: the page is of a private window, a guest window or a private tab. Its text never leaves the Mac: only Ollama on this
 * Mac summarizes it, never another computer.
 */
export function summaryAvailable(settings: SummarySettings, privatePage = false): boolean {
  const kind = summaryDestination(settings).kind
  return kind === 'local' || (kind === 'network' && !privatePage)
}

/**
 * The entries « Résumer… » of the File menu are greyed out: the window has them (it is not a private one), and the tab on screen is a private
 * tab whose text would leave the Mac. The menu is one for all the tabs of its window, so the entries stay where they are and say no.
 */
export function summaryGreyed(settings: SummarySettings, privateTab: boolean): boolean {
  return privateTab && summaryAvailable(settings) && !summaryAvailable(settings, true)
}
