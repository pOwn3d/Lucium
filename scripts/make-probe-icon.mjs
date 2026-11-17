// Writes compat/surface-probe/icon.png: the icon of the probe extension the engine checks load, drawn by scripts/probe-icon/probe-icon.ts (greys
// only, 128 px, the size its manifest declares). Node alone: no browser and no window.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/make-probe-icon.mjs            writes the file
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/make-probe-icon.mjs --check    fails when the file is not the picture the drawing gives
//   pnpm icons:probe
//
// `--check` reads the picture, it does not compare bytes: the zlib of another machine may write other bytes for the same pixels. A run that writes the
// file on such a machine changes nothing of the picture: keep the committed file.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROBE_ICON_SIZE, probeIconFault, probeIconPng } from './probe-icon/probe-icon.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'compat/surface-probe/icon.png')
const wanted = probeIconPng(PROBE_ICON_SIZE)

if (process.argv.includes('--check')) {
  const fault = existsSync(target) ? probeIconFault(readFileSync(target), PROBE_ICON_SIZE) : 'the file is not there'
  if (fault === null) {
    console.log(`make-probe-icon: ${target} is the drawing of scripts/probe-icon/probe-icon.ts`)
  } else {
    console.error(`make-probe-icon: ${target} is not what scripts/probe-icon/probe-icon.ts draws (${fault}): run this script without --check and keep the file it writes`)
    process.exit(1)
  }
} else {
  writeFileSync(target, wanted)
  console.log(`make-probe-icon: ${target} written (${PROBE_ICON_SIZE} x ${PROBE_ICON_SIZE} px, ${wanted.length} bytes)`)
}
