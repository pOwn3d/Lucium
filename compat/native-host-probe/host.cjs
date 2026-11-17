// A stand-in for a native messaging host, used by the engine smoke test and nothing else. It speaks the browser protocol on stdio
// (a 4-byte native-endian length, then that many bytes of UTF-8 JSON) and never touches the network or any user data.
// Commands: {cmd:'exit'} leaves, {cmd:'oversize'} answers with 2 MB (more than a browser accepts), {cmd:'large'} answers with 900 KB.
'use strict'

const LIMIT = 1024 * 1024
let pending = Buffer.alloc(0)

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  process.stdout.write(Buffer.concat([header, body]))
}

function handle(message) {
  if (message && message.cmd === 'exit') return process.exit(0)
  if (message && message.cmd === 'oversize') return send({ big: 'x'.repeat(2 * LIMIT) })
  if (message && message.cmd === 'large') return send({ big: 'x'.repeat(900 * 1024) })
  send({ echo: message, argv: process.argv.slice(2), pid: process.pid })
}

process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk])
  // A chunk can hold several messages or only part of one.
  while (pending.length >= 4) {
    const length = pending.readUInt32LE(0)
    if (pending.length < 4 + length) return
    const body = pending.subarray(4, 4 + length)
    pending = pending.subarray(4 + length)
    handle(JSON.parse(body.toString('utf8')))
  }
})
process.stdin.on('end', () => process.exit(0))
