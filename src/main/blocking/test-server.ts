// A local HTTP server for the blocking tests: the lists come from here, never from the Internet.

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Reply {
  status?: number
  body?: string
  headers?: Record<string, string>
  /** Never answer: the request hangs until the client gives up. */
  hang?: boolean
}

export interface TestServer {
  /** `http://127.0.0.1:<port>` */
  origin: string
  /** Routes by path; replace one between two requests to change what the "list" says. */
  routes: Map<string, (request: IncomingMessage) => Reply>
  /** Every request received, oldest first. */
  requests: Array<{ path: string; headers: IncomingMessage['headers'] }>
  close(): Promise<void>
}

export async function startTestServer(): Promise<TestServer> {
  const routes: TestServer['routes'] = new Map()
  const requests: TestServer['requests'] = []
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname
    requests.push({ path, headers: request.headers })
    const reply = routes.get(path)?.(request) ?? { status: 404, body: 'not found' }
    if (reply.hang) return
    response.writeHead(reply.status ?? 200, { 'content-type': 'text/plain; charset=utf-8', ...reply.headers })
    response.end(reply.body ?? '')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    routes,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
  }
}

/** A filter list of `count` rules that block `<prefix><i>.example` hosts when third party, under a header. */
export function listText(title: string, extra: string[] = [], count = 3, prefix = 'ads'): string {
  const rules = Array.from({ length: count }, (_, i) => `||${prefix}${i}.example^$third-party`)
  return ['[Adblock Plus 2.0]', `! Title: ${title}`, ...rules, ...extra, ''].join('\n')
}
