// Starts the Mac of the check and keeps it until the control server is told to stop. Run by vitest.sync-interop.config.mts (never by `pnpm test`): it prints
// `LUCIUM_INTEROP_READY <port>` once the control server listens, and writes the same port in the file named by LUCIUM_INTEROP_PORT_FILE when there is one.
import { writeFileSync } from 'node:fs'
import { it } from 'vitest'
import { ControlServer } from './mac-peer'

it('the Mac of the interoperability check', async () => {
  const control = new ControlServer()
  const port = await control.serve()
  const file = process.env.LUCIUM_INTEROP_PORT_FILE
  if (file !== undefined && file !== '') writeFileSync(file, `${port}\n`)
  console.log(`LUCIUM_INTEROP_READY ${port} host=${control.peer.host.address} (${control.peer.host.name})`)
  await control.stopped
})
