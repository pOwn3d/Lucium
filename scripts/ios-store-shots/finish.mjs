// The last step of scripts/ios-store-shots.sh: makes each picture of a device what App Store Connect takes (no alpha channel, rewritten in place) and refuses
// one that does not have the size of the device.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/ios-store-shots/finish.mjs <WIDTHxHEIGHT> <picture.png>...
import { readFileSync, writeFileSync } from 'node:fs'
const { pictureProblems, pngFacts, withoutAlpha } = await import('./png.ts')

const [size, ...files] = process.argv.slice(2)
if (!size || !/^\d+x\d+$/.test(size) || files.length === 0) {
  console.error('usage: finish.mjs <WIDTHxHEIGHT> <picture.png>...')
  process.exit(2)
}
let failed = false
for (const file of files) {
  try {
    const flat = withoutAlpha(readFileSync(file))
    const problems = pictureProblems(flat, size)
    if (problems.length > 0) throw new Error(problems.join(', '))
    writeFileSync(file, flat)
    const { width, height } = pngFacts(flat)
    console.log(`${file}: ${width}x${height}, no alpha`)
  } catch (error) {
    console.error(`${file}: ${error.message}`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
