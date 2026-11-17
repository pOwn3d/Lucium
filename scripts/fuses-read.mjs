// Prints the fuses of an application as they are in its binary: `pnpm fuses:read <path of the .app>`.
//
//   pnpm fuses:read /Applications/Lucium.app
//   pnpm fuses:read dist-drm/mac-arm64/Lucium.app
//
// It reads the file and writes nothing. The reader is the one the publication and `pnpm verify:app` use (src/main/publish-update.ts): nothing is
// downloaded, where `npx @electron/fuses read` fetches and runs the latest version of a package, outside pnpm-lock.yaml, on the Mac that signs.
// Exit code: 0 the fuses were printed, 1 the binary has no fuse wire or cannot be read, 2 the arguments are wrong.
import { resolve } from 'node:path'

process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.error(`${warning.name}: ${warning.message}`)
})
const { fuseFileOf, fuseWireLines, readFuseWire } = await import('../src/main/publish-update.ts')

const paths = process.argv.slice(2)
if (paths.length !== 1 || paths[0]?.startsWith('-')) {
  console.error('Usage: pnpm fuses:read <path of the .app>')
  process.exit(2)
}
const app = resolve(/** @type {string} */ (paths[0]))
try {
  const wire = await readFuseWire(fuseFileOf(app))
  if (!wire) {
    console.error(`Error: no Electron fuse wire in ${fuseFileOf(app)}`)
    process.exit(1)
  }
  console.log(`${app}\n${fuseWireLines(wire).join('\n')}`)
} catch (error) {
  console.error(`Error: the fuses of ${app} cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
