// Engine checks of the page summary by an Ollama of the local network named by a `.local` name, with the resolver of macOS and Electron's own
// network stack, and nothing outside this Mac: the name is the Bonjour name of this Mac itself (`scutil --get LocalHostName`), which macOS answers
// from its own records, and the model is a stand-in server of the suite, listening on this Mac. What is checked is what main/shell/ollama-fetch.ts
// promises and only its unit tests had seen: the main process resolves the name at each request, the request goes to the private address the name
// led to (the Host header names that address, never the name), and a redirect of the model is not followed to another address.
// What cannot be checked here: a name that leads to no private address (only a resolver of the network, or another computer, could give one),
// and a model on another computer, with or without a proxy.
// macOS may first ask whether Electron may reach the devices of the local network (Réglages Système › Confidentialité et sécurité › Réseau local):
// until it is allowed, the connection fails and the checks say so in their detail. That is why the suite is not in the chain (smoke-suites.ts).
// `LUCIUM_SMOKE_ONLY=ollama` runs this file alone.

import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces } from 'node:os'
import { DEFAULT_OLLAMA_CONFIG, isPrivateNetworkAddress, summarizeWithOllama, testOllamaConnection, type SummaryResponse } from '@shared/ollama'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, skippedBecause, type CheckFn, type CheckRecord } from './smoke-kit'
import { modelHitsVerdict, plainAddress, settled, type ModelHit } from './smoke-probe-kit'
import { ollamaFetch } from './shell/ollama-fetch'

/** What the stand-in model lists, what it answers to a summary, and the text of the page it is asked to summarize. */
const MODEL = 'lucium-probe:latest'
const SUMMARY = 'Résumé de la sonde Lucium.'
const PAGE_TEXT = 'Le texte d’une page que la sonde de Lucium fait résumer.'

/** The Bonjour name of this Mac, in lower case, or why there is none. */
function localHostName(): { name: string } | { why: string } {
  try {
    const name = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 5000 }).trim().toLowerCase()
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? { name } : { why: `the Bonjour name of this Mac is not one a .local address can carry: "${name}"` }
  } catch (error) {
    return { why: `this Mac has no Bonjour name (scutil --get LocalHostName: ${String((error as Error)?.message ?? error).split('\n')[0]})` }
  }
}

export async function smokeOllama(_ctx: SmokeContext, check: CheckFn): Promise<void> {
  const own = localHostName()
  const privateHere = Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .map((address) => plainAddress(address.address))
    .filter((address) => isPrivateNetworkAddress(address))
  if ('why' in own || privateHere.length === 0) {
    // Nothing to resolve the name to: the checks are not made, and the summary of the run says this suite verified nothing.
    check('ollama .local: the name of this Mac leads the request of a summary to a private address of this Mac', true, skippedBecause('why' in own ? own.why : 'this Mac has no private address on any of its network interfaces (no network, or a public address only)'))
    return
  }

  const hits: ModelHit[] = []
  const bodies: string[] = []
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    hits.push({ method: req.method ?? '', path, host: req.headers.host ?? '', local: req.socket.localAddress ?? '' })
    const json = (value: unknown): void => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(value))
    }
    if (path === '/api/tags') return json({ models: [{ name: MODEL, size: 1 }] })
    if (path === '/api/generate') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf8'))
        json({ response: SUMMARY, eval_count: 7 })
      })
      return
    }
    // A model that sends the request elsewhere: to the loopback of this Mac, an address the name did not lead to.
    if (path === '/redirect') {
      res.statusCode = 302
      res.setHeader('location', `http://127.0.0.1:${(server.address() as AddressInfo).port}/landed`)
      return void res.end()
    }
    res.statusCode = 404
    res.end('not found')
  })
  // Every address of this Mac, so that the request is seen wherever it goes: the private one the name must lead to, or the loopback.
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://${own.name}.local:${port}`
  const said = (error: unknown): string => String((error as Error)?.message ?? error)

  try {
    const connection = await settled(testOllamaConnection(base, ollamaFetch), (why) => ({ ok: false as const, error: `no answer: ${why}` }), 15_000)
    check(
      `ollama .local: the connection test reaches the model by the name of this Mac (${own.name}.local) and reads its list`,
      connection.ok && connection.models.includes('lucium-probe'),
      `${JSON.stringify(connection)}; private addresses of this Mac: ${privateHere.join(', ')}`
    )
    const tags = modelHitsVerdict(hits, 'GET', '/api/tags', port)
    check('ollama .local: ...the request went to a private address of this Mac that the name led to, and names that address, not the name, as its Host', tags.ok, tags.detail)

    const summary = await settled<SummaryResponse | null | string>(
      summarizeWithOllama({ ...DEFAULT_OLLAMA_CONFIG, enabled: true, url: base, model: MODEL }, { content: PAGE_TEXT, url: 'https://lucium.test/page' }, ollamaFetch),
      (why) => `no answer: ${why}`,
      20_000
    )
    const generate = modelHitsVerdict(hits, 'POST', '/api/generate', port)
    check(
      'ollama .local: a summary goes the same way, with the text of the page, and its answer comes back',
      typeof summary === 'object' && summary?.summary === SUMMARY && generate.ok && bodies.some((body) => body.includes(PAGE_TEXT)),
      `summary ${JSON.stringify(summary)}; ${generate.detail}`
    )

    // The redirect, then a request after it (the witness that the model was still listening, and would have seen the request it was sent to).
    const redirected = await settled(
      ollamaFetch(`${base}/redirect`).then(
        (answer) => `followed: HTTP ${answer.status}`,
        (error: unknown) => `refused: ${said(error)}`
      ),
      (why) => `no answer: ${why}`,
      15_000
    )
    const witness = await settled(
      ollamaFetch(`${base}/api/tags`).then(
        (answer) => answer.status,
        (error: unknown) => said(error)
      ),
      (why) => `no answer: ${why}`,
      15_000
    )
    const landed = hits.filter((hit) => hit.path === '/landed')
    check(
      'ollama .local: a redirect the model answers is not followed, to the loopback of this Mac or anywhere else',
      redirected.startsWith('refused') && landed.length === 0 && witness === 200,
      `the redirect: ${redirected}; the request after it: ${String(witness)}; requests that followed the redirect: ${JSON.stringify(landed)}`
    )
  } finally {
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=ollama`: only these checks, with their own report. */
export async function runOllamaSmoke(ctx: SmokeContext): Promise<number> {
  const checks: CheckRecord[] = []
  try {
    await smokeOllama(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeOllama ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_OLLAMA ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
