// The last step of scripts/ios-store-shots.sh: makes each picture of a device what App Store Connect takes (no alpha channel, rewritten in place) and refuses
// one that does not have the size of the device.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/ios-store-shots/finish.mjs <WIDTHxHEIGHT> [--island] <picture.png>...
//
// `--island` is for the pictures of an iPhone with a Dynamic Island: the simulator draws the island in some pictures and not in others, so the pictures must
// all show it or all not (exit 3 otherwise, and the script takes the set again).
import { readFileSync, writeFileSync } from 'node:fs'
const { pictureProblems, pngFacts, showsIsland, withoutAlpha } = await import('./png.ts')

const [size, ...rest] = process.argv.slice(2)
const island = rest.includes('--island')
const files = rest.filter((argument) => argument !== '--island')
if (!size || !/^\d+x\d+$/.test(size) || files.length === 0) {
  console.error('usage: finish.mjs <WIDTHxHEIGHT> [--island] <picture.png>...')
  process.exit(2)
}
let failed = false
/** @type {Map<string, boolean>} */
const islands = new Map()
for (const file of files) {
  try {
    const flat = withoutAlpha(readFileSync(file))
    const problems = pictureProblems(flat, size)
    if (problems.length > 0) throw new Error(problems.join(', '))
    writeFileSync(file, flat)
    if (island) islands.set(file, showsIsland(flat))
    const { width, height } = pngFacts(flat)
    console.log(`${file}: ${width}x${height}, no alpha`)
  } catch (error) {
    console.error(`${file}: ${error.message}`)
    failed = true
  }
}
if (failed) process.exit(1)
if (island && new Set(islands.values()).size > 1) {
  console.error(`the pictures do not agree on the Dynamic Island: shown in ${[...islands].filter(([, shown]) => shown).map(([file]) => file).join(', ')}`)
  process.exit(3)
}
process.exit(0)
