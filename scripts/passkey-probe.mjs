// Serves the passkey probe on this machine alone, to open in an installed Lucium: what the engine does with WebAuthn in that build
// (docs/cles-d-acces.md says what to do with the page and what its report answers).
//
//   node scripts/passkey-probe.mjs            serves http://localhost:8765/ until Ctrl-C
//   node scripts/passkey-probe.mjs --port=N   another port
//
// The page and what the server answers are in src/main/passkey-probe.ts, with their tests in src/main/passkey-probe.test.ts; this file
// only listens. It opens no window and no browser: the address is printed, to paste in the build to measure.
import { createServer } from 'node:http'

// See scripts/electron-watch.mjs: the module is TypeScript that Node runs as is, and only the warning about its module type is silenced.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.error(`${warning.name}: ${warning.message}`)
})
const { probeResponse } = await import('../src/main/passkey-probe.ts')

const asked = process.argv.slice(2).find((arg) => arg.startsWith('--port='))
const port = asked ? Number(asked.slice('--port='.length)) : 8765
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('--port : un entier de 1024 à 65535')
  process.exit(2)
}

const server = createServer((request, response) => {
  const answer = probeResponse(request.method, request.url, request.headers.host, port)
  response.writeHead(answer.status, answer.headers).end(answer.body)
})
server.on('error', (error) => {
  console.error(`La sonde ne peut pas écouter sur le port ${port} : ${error.message}`)
  process.exit(1)
})
// The loopback interface only: nothing of the network reaches the page.
server.listen(port, 'localhost', () => {
  console.log(`Sonde des clés d'accès : ouvrez http://localhost:${port}/ dans la version de Lucium à mesurer. Ctrl-C pour arrêter.`)
})
