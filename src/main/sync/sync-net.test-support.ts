// What the tests of the connections need: a pair of connected sockets, test identities, and a TLS client the way an iPhone would be one.
import { createServer, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { type KeyObject } from 'node:crypto'
import { certificatePem, makeDeviceCertificate, privateKeyOf } from './certificate'
import { ALPN } from './limits'

export interface TestIdentity {
  deviceId: string
  certificate: Buffer
  privateKey: KeyObject
  fingerprint: Buffer
}

export function testIdentity(deviceId: string): TestIdentity {
  const made = makeDeviceCertificate()
  return { deviceId, certificate: made.certificate, privateKey: privateKeyOf(made.privateKey), fingerprint: made.fingerprint }
}

/** Two connected sockets over the loopback: what one writes the other reads. */
export async function socketPair(): Promise<{ server: Socket; client: Socket; close: () => void }> {
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const port = (listener.address() as { port: number }).port
  const accepted = new Promise<Socket>((resolve) => listener.once('connection', resolve))
  const client = new (await import('node:net')).Socket()
  await new Promise<void>((resolve) => client.connect(port, '127.0.0.1', resolve))
  const server = await accepted
  return {
    server,
    client,
    close: () => {
      server.destroy()
      client.destroy()
      listener.close()
    }
  }
}

export interface ClientOptions {
  /** Without a certificate (a client that presents none). */
  anonymous?: boolean
  alpn?: string[]
  /** Caps the version (a client that only speaks TLS 1.2). */
  maxVersion?: 'TLSv1.2' | 'TLSv1.3'
}

/** A TLS client the way an iPhone would be: its own certificate, no chain judged, the Mac's certificate returned for the caller to pin. */
export function connectTls(port: number, identity: TestIdentity, options: ClientOptions = {}): Promise<{ socket: TLSSocket; serverFingerprint: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: '127.0.0.1',
      port,
      ...(options.anonymous === true ? {} : { key: identity.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: certificatePem(identity.certificate) }),
      rejectUnauthorized: false,
      ALPNProtocols: options.alpn ?? [ALPN],
      minVersion: 'TLSv1.2',
      maxVersion: options.maxVersion ?? 'TLSv1.3'
    })
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerX509Certificate()
      if (certificate === undefined) return reject(new Error('the server presented no certificate'))
      resolve({ socket, serverFingerprint: Buffer.from(certificate.fingerprint256.replaceAll(':', ''), 'hex') })
    })
    socket.once('error', reject)
  })
}

/** What a socket does next: closes, or errors (whichever comes first). */
export const closedOrFailed = (socket: Socket): Promise<'closed' | 'error'> => new Promise((resolve) => void (socket.once('close', () => resolve('closed')), socket.once('error', () => resolve('error'))))

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
