// The small commands `scripts/ios-archive.sh` calls for what is better said in JavaScript than in shell (docs/ios.md, section 10.3). Each one reads,
// prints and exits: none of them signs, sends or writes a file.
//
//   node scripts/ios-archive/cli.mjs check-sources                           the filter lists and the page guard are whole: exit 1 with the reasons if not
//   node scripts/ios-archive/cli.mjs build-number                            the build number for a send made now
//   node scripts/ios-archive/cli.mjs export-options --team T --destination upload|export [--allow-external]
//                                                                            the ExportOptions.plist on the standard output
//   node scripts/ios-archive/cli.mjs check-archive ARCHIVE --build N --bundle-id ID
//                                                                            the archive is that build and carries the lists and the guard
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Node reads the TypeScript of the modules by itself; its notice that the package has no "type" is not news.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (/** @type {NodeJS.ErrnoException} */ (warning).code !== 'MODULE_TYPELESS_PACKAGE_JSON' && warning.name !== 'ExperimentalWarning') console.error(`${warning.name}: ${warning.message}`)
})
const { filterListsProblems, guardProblems, embeddedListFileNames, GUARD_FILES } = await import('./lists-check.ts')
const { buildNumber } = await import('./build-number.ts')
const { exportOptionsPlist } = await import('./export-options.ts')
const { archiveProblems } = await import('./archive-check.ts')
const { registryProblems, EMBEDDED_LIST_IDS } = await import('../ios-filter-lists/embedded-lists.ts')
const { WEBKIT_RULE_LIMIT } = await import('../ios-filter-lists/abp-to-webkit.ts')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const [command, ...args] = process.argv.slice(2)
const valueOf = (flag) => {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}
/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`ios-archive: ${message}`)
  process.exit(1)
}

/** A folder read file by file: a file that is not there is null, any other failure to read stops the command with its reason. */
const folderAt = (dir) => ({
  read: (name) => {
    try {
      return readFileSync(join(dir, name), 'utf8')
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null
      throw error
    }
  }
})

switch (command) {
  case 'check-sources': {
    const listsDir = join(root, 'ios/Lucium/FilterLists')
    const guardDir = join(root, 'ios/Lucium/Guard')
    const problems = [
      ...filterListsProblems(folderAt(listsDir), { expectedIds: EMBEDDED_LIST_IDS, ruleLimit: WEBKIT_RULE_LIMIT, registryProblems }).map((problem) => `filter lists (${listsDir}): ${problem}`),
      ...guardProblems(folderAt(guardDir)).map((problem) => `page guard (${guardDir}): ${problem}`)
    ]
    if (problems.length > 0) {
      console.error(`ios-archive: REFUSED. The application would not carry what it needs:\n- ${problems.join('\n- ')}`)
      process.exit(1)
    }
    const raw = folderAt(listsDir).read('filter-lists-registry.json')
    if (raw === null) fail('the registry of the filter lists disappeared while it was being read')
    const registry = JSON.parse(raw)
    const rules = registry.lists.flatMap((list) => list.files).filter((file) => file.kind !== 'scriptlets').reduce((sum, file) => sum + file.rules, 0)
    const fetched = registry.lists.map((list) => list.fetchedAt).sort()
    console.log(`filter lists: ${registry.lists.length} lists, ${rules} rules, copies of ${fetched[0]} to ${fetched.at(-1)}; page guard: ${GUARD_FILES.length} files`)
    break
  }
  case 'build-number': {
    try {
      console.log(buildNumber(new Date()))
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
    break
  }
  case 'export-options': {
    try {
      process.stdout.write(exportOptionsPlist({ teamId: valueOf('--team') ?? '', destination: /** @type {'upload' | 'export'} */ (valueOf('--destination')), internalOnly: !args.includes('--allow-external') }))
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
    break
  }
  case 'check-archive': {
    const archive = args[0]
    const build = valueOf('--build')
    const bundleId = valueOf('--bundle-id')
    if (!archive || !build || !bundleId) fail('check-archive needs an archive, --build and --bundle-id')
    // The archive's Info.plist, in whatever format Xcode wrote it, as XML text.
    const plist = spawnSync('plutil', ['-convert', 'xml1', '-o', '-', join(archive, 'Info.plist')], { encoding: 'utf8' })
    if (plist.error || plist.status !== 0) fail(`the Info.plist of the archive cannot be read (${plist.error?.message ?? plist.stderr.trim()})`)
    const applications = join(archive, 'Products/Applications')
    const apps = readdirSync(applications).filter((name) => name.endsWith('.app'))
    if (apps.length !== 1) fail(`${applications} holds ${apps.length} applications, one is expected`)
    /** @type {string[]} */
    let listFiles = []
    try {
      listFiles = embeddedListFileNames(folderAt(join(root, 'ios/Lucium/FilterLists')))
    } catch (error) {
      fail(`the filter lists the archive should carry cannot be read: ${error instanceof Error ? error.message : String(error)}`)
    }
    const problems = archiveProblems({
      plistXml: plist.stdout,
      appFiles: readdirSync(join(applications, apps[0])),
      requiredFiles: [...listFiles, ...GUARD_FILES],
      expect: { bundleId, build }
    })
    if (problems.length > 0) {
      console.error(`ios-archive: REFUSED. The archive is not what was asked for:\n- ${problems.join('\n- ')}`)
      process.exit(1)
    }
    console.log(`archive: ${bundleId}, build ${build}, with the filter lists and the page guard`)
    break
  }
  default:
    fail(`unknown command "${String(command)}" (check-sources, build-number, export-options, check-archive)`)
}
