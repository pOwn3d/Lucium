// Writes the build record of a release beside its archive: the commit the archive was built from, and its SHA-256. scripts/build-drm-release.sh
// calls it, and scripts/publish-update.mjs refuses an archive without it (src/main/release-gate.ts): what is published is tied to its sources.
//
//   node scripts/build-record.mjs start                                 prints "<commit> <0|1>": the commit of the working tree, and whether a
//                                                                       tracked file is modified, or an untracked one lies in a folder the
//                                                                       build reads (src, resources, native, build). Asked before the build.
//   node scripts/build-record.mjs write <archive> <commit> <0|1>       writes Lucium-<version>-arm64.build.json beside the archive, from what
//                                                                       `start` printed and what Git says now. Asked once the archive is written.
//
// A working tree that was modified, or a commit that moved during the build, is written down as such: the record is still written, and the
// publication refuses the archive.
// Exit code: 0 done, 1 Git or the archive cannot be read (said), 2 the arguments are wrong.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.error(`${warning.name}: ${warning.message}`)
})
const { gitState, readStateWord, realRecordDeps, stateWord, writeBuildRecord } = await import('../src/main/release-records.ts')
const gate = await import('../src/main/release-gate.ts')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const usage = () => console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
const [mode, archive, commit, modified, ...rest] = process.argv.slice(2)
const deps = realRecordDeps(root, (line) => console.log(line), gate)

if (mode === 'start' && archive === undefined) {
  const now = gitState(deps)
  if ('problem' in now) {
    console.error(`build-record: ${now.problem}`)
    process.exit(1)
  }
  console.log(stateWord(now.state))
} else if (mode === 'write' && archive !== undefined && rest.length === 0) {
  const start = readStateWord(commit, modified)
  if (!start) {
    console.error('build-record: write takes the archive, then the commit and the 0 or 1 that `start` printed')
    usage()
    process.exit(2)
  }
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
  const result = writeBuildRecord({ version, archive: resolve(process.cwd(), archive), start }, deps)
  if (!result.ok) {
    console.error(`build-record: ${result.problem}`)
    process.exit(1)
  }
} else {
  usage()
  process.exit(2)
}
