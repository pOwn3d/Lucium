// The `fetch` the Web Store installer sends its requests with: Electron's network stack (Chromium's), in the session of the application, and
// not the `fetch` of Node. Node's goes straight to the network: it knows neither the proxy the user set (Réglages › Vie privée et sécurité › DNS chiffré et proxy), which the
// application's session follows, nor the encrypted DNS, which is Chromium's resolver. The guard around the installer (web-store-network.ts)
// decides which addresses may be reached and judges every redirect itself, so this one gives a redirect back as an answer instead of following it.
// Nothing here knows Electron: the request is made by a function passed in (`net.request` in web-store.ts), which is how it is tested.

import type { EventEmitter } from 'node:events'

/** What is asked of the network stack for one request. No cookie goes out or comes in, no Referer is sent, nothing is cached. */
export interface TransportOptions {
  url: string
  method: string
  headers: Record<string, string>
  redirect: 'manual'
  credentials: 'omit'
  referrerPolicy: 'no-referrer'
  cache: 'no-store'
}

/** The part of Electron's `ClientRequest` this uses. */
export interface TransportRequest extends EventEmitter {
  end(chunk?: string | Buffer): void
  abort(): void
}

/** The part of the answer (`IncomingMessage` of Electron's `net`) this reads. */
interface TransportAnswer extends EventEmitter {
  statusCode: number
  statusMessage: string
  headers: Record<string, string | string[]>
}

/** Answers that carry no body (a Response cannot be built with one). */
const NO_BODY = new Set([101, 204, 205, 304])

const asBytes = (body: BodyInit | null | undefined): string | Buffer | undefined => {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  throw new TypeError('the Web Store installer sends text or bytes only')
}

export function createSessionTransport(makeRequest: (options: TransportOptions) => TransportRequest): typeof fetch {
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? undefined
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
      let payload: string | Buffer | undefined
      let request: TransportRequest
      try {
        payload = asBytes(init?.body)
        request = makeRequest({
          url: input instanceof Request ? input.url : String(input),
          method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store'
        })
      } catch (error) {
        return reject(error)
      }
      let answered = false
      let finished = false
      let body: ReadableStreamDefaultController<Uint8Array> | null = null
      const finish = (): void => {
        finished = true
        signal?.removeEventListener('abort', onAbort)
      }
      /** An error before the answer rejects the call; after it, it ends the body that is being read. */
      const fail = (reason: unknown): void => {
        if (finished && answered) {
          // The answer is complete (or its reader gave up, which aborts the transfer): the end of the connection has nobody left to tell.
          console.debug('[webstore] an error came after the answer was complete:', reason instanceof Error ? reason.message : String(reason))
          return
        }
        finish()
        if (!answered) {
          answered = true
          reject(reason)
          return
        }
        body?.error(reason)
      }
      const onAbort = (): void => {
        request.abort()
        fail(signal?.reason ?? new Error('aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      request.on('redirect', (status: number, _method: string, location: string) => {
        if (answered) return
        answered = true
        finish()
        // Nothing follows on its own in manual mode: the guard judges the destination.
        resolve(new Response(null, { status, headers: { location } }))
        request.abort()
      })
      request.on('response', (res: TransportAnswer) => {
        if (answered) return
        answered = true
        const headers = new Headers()
        for (const [name, value] of Object.entries(res.headers)) {
          try {
            headers.set(name, Array.isArray(value) ? value.join(', ') : value)
          } catch (error) {
            // A header Chromium accepted and the Fetch standard does not (a stray control character): it is not one the installer reads.
            console.debug(`[webstore] skipped the header ${name.slice(0, 40)}:`, error instanceof Error ? error.message : String(error))
          }
        }
        if (NO_BODY.has(res.statusCode)) {
          finish()
          resolve(new Response(null, { status: res.statusCode, statusText: res.statusMessage, headers }))
          request.abort()
          return
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller
            res.on('data', (chunk: Buffer) => {
              if (!finished) controller.enqueue(new Uint8Array(chunk))
            })
            res.on('end', () => {
              if (finished) return
              finish()
              controller.close()
            })
            res.on('error', fail)
            res.on('aborted', () => fail(new Error('the answer was cut')))
          },
          cancel() {
            // The guard stops reading an answer that is larger than its limit: the transfer stops with it.
            finish()
            request.abort()
          }
        })
        resolve(new Response(stream, { status: res.statusCode, statusText: res.statusMessage, headers }))
      })
      request.on('error', fail)
      request.end(payload)
    })
}
