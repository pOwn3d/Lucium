// How a request of the page summary leaves the application (shared/ollama.ts decides where it may go). Ollama on this Mac is asked through
// Electron's net.fetch, as it always was. Ollama on a computer of the local network is asked through a session of its own that uses no proxy:
// with a proxy in the settings or in the system, a request to a private address would be handed to that proxy, and the text of the page
// would then reach a host that is not the one the user named. A computer named by a `.local` name is resolved here first: the request goes
// to the private address the name led to, and to nothing when it led to none.

import { lookup } from 'node:dns/promises'
import { net, session, type Session } from 'electron'
import { t } from '@shared/i18n'
import { isLocalOllamaAddress, isPrivateNetworkAddress, ollamaNameOf, OllamaNameRefused, type Fetcher } from '@shared/ollama'

/** The session of the requests to a model of the local network: in memory, nothing kept, and never a proxy. */
export const NETWORK_MODEL_PARTITION = 'lucium-network-model'

/** How long a name may take to resolve: a `.local` name that no computer answers to is otherwise waited for as long as the system likes. */
export const RESOLVE_TIMEOUT_MS = 5000

let direct: Promise<Session> | null = null

/** The session without a proxy, once it is told to use none. A refusal is not kept: the next request tries again, and this one fails. */
function directSession(): Promise<Session> {
  direct ??= (async () => {
    const ses = session.fromPartition(NETWORK_MODEL_PARTITION)
    await ses.setProxy({ mode: 'direct' })
    return ses
  })().catch((error: unknown) => {
    direct = null
    console.error('[ai] the session of the local network model cannot be set to use no proxy, so nothing is sent:', error)
    throw error
  })
  return direct
}

/**
 * The address a request to a `.local` name is sent to: the same one, with the name replaced by a private IP address the name resolves to
 * now. The connection is made to the address that was checked, so a second answer of the resolver cannot change where the text goes.
 * A name with no private address among its answers (a public one, this Mac, a link-local one alone) is refused, and nothing is sent.
 */
async function verifiedAddress(url: string, name: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the name ${name} did not resolve within ${RESOLVE_TIMEOUT_MS} ms`)), RESOLVE_TIMEOUT_MS)
  })
  const answers = await Promise.race([lookup(name, { all: true }), late]).finally(() => clearTimeout(timer))
  const chosen = answers.find((answer) => isPrivateNetworkAddress(answer.address.toLowerCase()))
  if (!chosen) {
    console.error(`[ai] the name ${name} of the local network model does not lead to a private address (${answers.map((answer) => answer.address).join(', ') || 'no address'}), so nothing is sent`)
    throw new OllamaNameRefused(t('summary.nom-sans-adresse-privee', { host: name }))
  }
  const target = new URL(url)
  target.hostname = chosen.family === 6 ? `[${chosen.address}]` : chosen.address
  return target.href
}

/**
 * The fetch of the page summary. Without `credentials: 'omit'`, a fetch of Electron would send the cookies and the HTTP credentials of its
 * session along. An address of another computer waits for the session without a proxy; nothing is sent when that session cannot be made.
 * A `.local` name is resolved and checked first, and no redirect is followed to another computer: the server cannot name another target.
 */
export const ollamaFetch: Fetcher = async (url, init) => {
  if (isLocalOllamaAddress(url)) return net.fetch(url, { ...init, credentials: 'omit' })
  const name = ollamaNameOf(url)
  const target = name === null ? url : await verifiedAddress(url, name)
  return (await directSession()).fetch(target, { ...init, credentials: 'omit', redirect: 'error' })
}
