import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WEBKIT_RULE_LIMIT } from '../ios-filter-lists/abp-to-webkit'
import { EMBEDDED_LIST_IDS, REGISTRY_FILE, registryProblems, type Registry } from '../ios-filter-lists/embedded-lists'
import { embeddedListFileNames, filterListsProblems, guardProblems, type Folder } from './lists-check'
import { wholeListsFolder } from './test-support'

const folderOf = (files: Record<string, string>): Folder => ({ read: (name) => files[name] ?? null })
const options = { expectedIds: EMBEDDED_LIST_IDS, ruleLimit: WEBKIT_RULE_LIMIT, registryProblems }
const problemsOf = (files: Record<string, string>): string[] => filterListsProblems(folderOf(files), options)
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const registryOf = (files: Record<string, string>): Registry => JSON.parse(files[REGISTRY_FILE]!) as Registry
const withRegistry = (files: Record<string, string>, change: (registry: Registry) => void): Record<string, string> => {
  const registry = registryOf(files)
  change(registry)
  return { ...files, [REGISTRY_FILE]: JSON.stringify(registry) }
}

describe('filterListsProblems: what an archive may carry', () => {
  it('accepts the folder `node scripts/ios-filter-lists.mjs` writes', () => {
    expect(problemsOf(wholeListsFolder())).toEqual([])
  })

  it('refuses a checkout where the lists were never prepared (no folder, no registry)', () => {
    expect(problemsOf({})).toEqual([`${REGISTRY_FILE} is missing: this folder holds no filter list`])
  })

  it('refuses a registry that is not JSON, and one with no lists in it', () => {
    expect(problemsOf({ [REGISTRY_FILE]: '<html>captive portal</html>' })[0]).toMatch(/is not JSON/)
    expect(problemsOf({ [REGISTRY_FILE]: '{"schema":1}' })).toEqual([`${REGISTRY_FILE} has no list of lists`])
    expect(problemsOf({ [REGISTRY_FILE]: 'null' })).toEqual([`${REGISTRY_FILE} has no list of lists`])
  })

  it('says so when the registry has a shape the Mac’s own check cannot walk, instead of passing it', () => {
    const problems = problemsOf({ [REGISTRY_FILE]: '{"schema":1,"lists":[{"id":"easylist"}]}' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/cannot be read as a registry/)
  })

  it('refuses an incomplete registry with the Mac’s own reasons (here: a list with no licence address)', () => {
    const files = withRegistry(wholeListsFolder(), (registry) => {
      registry.lists[0]!.licenseUrl = 'ftp://example.org'
    })
    expect(problemsOf(files).join('\n')).toMatch(/licenseUrl is not an https address/)
  })

  it('refuses a folder written with --only: every list the application embeds must be there', () => {
    const problems = problemsOf(wholeListsFolder(['easylist', 'easyprivacy']))
    expect(problems).toHaveLength(EMBEDDED_LIST_IDS.length - 2)
    expect(problems).toContain('the list ublock-cookies is not in the registry (a run with --only?)')
  })

  it('refuses a file the registry names and the folder does not have', () => {
    const files = wholeListsFolder()
    delete files['easylist.network.json']
    expect(problemsOf(files)).toEqual(['easylist.network.json is named by the registry and is not in the folder'])
  })

  it('refuses a file that is not the one the registry describes (cut, or from another run)', () => {
    const files = wholeListsFolder()
    files['easylist.network.json'] = files['easylist.network.json']!.slice(0, 20)
    expect(problemsOf(files)[0]).toMatch(/easylist\.network\.json is not the file the registry describes/)
  })

  it('refuses a file that is not JSON, or not a list of rules, even when its hash is the registry’s', () => {
    const files = wholeListsFolder()
    const broken = withRegistry({ ...files, 'easylist.network.json': 'not json' }, (registry) => {
      registry.lists[0]!.files[0]!.sha256 = sha('not json')
    })
    expect(problemsOf(broken).join('\n')).toMatch(/easylist\.network\.json is not JSON/)
    const object = withRegistry({ ...files, 'easylist.network.json': '{"a":1}' }, (registry) => {
      registry.lists[0]!.files[0]!.sha256 = sha('{"a":1}')
    })
    expect(problemsOf(object)).toEqual(['easylist.network.json is not a list of rules'])
  })

  it('refuses a file whose number of rules is not the registry’s', () => {
    const files = withRegistry(wholeListsFolder(), (registry) => {
      registry.lists[0]!.files[0]!.rules += 1
    })
    expect(problemsOf(files)[0]).toMatch(/easylist\.network\.json holds \d+ rules and the registry says \d+/)
  })

  it('reads a table of scriptlet calls as a table, not as rules', () => {
    const table = '{"schema":1,"domains":{}}'
    const add = (content: string): Record<string, string> =>
      withRegistry({ ...wholeListsFolder(), 'easylist.scriptlets.json': content }, (registry) => {
        registry.lists[0]!.files.push({ name: 'easylist.scriptlets.json', kind: 'scriptlets', rules: 1, sha256: sha(content) })
      })
    expect(problemsOf(add(table))).toEqual([])
    expect(problemsOf(add('{"schema":2}'))).toEqual(['easylist.scriptlets.json is not a table of scriptlet calls'])
  })
})

describe('embeddedListFileNames', () => {
  it('names the registry and every file it lists: what the archive must hold', () => {
    const files = wholeListsFolder()
    expect([...embeddedListFileNames(folderOf(files))].sort()).toEqual(Object.keys(files).sort())
  })

  it('throws for a folder with no registry, rather than asking nothing of the archive', () => {
    expect(() => embeddedListFileNames(folderOf({}))).toThrow(/nothing to compare the archive with/)
  })
})

describe('guardProblems: the page guard is committed, and the archive needs it', () => {
  const guard = { 'guard-runtime.js': '(function (plan) {})', 'guard-rules.json': '{"schema":1}' }
  it('accepts the two files', () => expect(guardProblems(folderOf(guard))).toEqual([]))
  it('refuses a missing file, an empty one, and rules that are not JSON', () => {
    expect(guardProblems(folderOf({ 'guard-rules.json': guard['guard-rules.json'] }))).toEqual(['guard-runtime.js is missing: run node scripts/ios-guard.mjs'])
    expect(guardProblems(folderOf({ ...guard, 'guard-runtime.js': '  \n' }))).toEqual(['guard-runtime.js is empty: run node scripts/ios-guard.mjs'])
    expect(guardProblems(folderOf({ ...guard, 'guard-rules.json': '{' }))[0]).toMatch(/guard-rules\.json is not JSON/)
  })
})
