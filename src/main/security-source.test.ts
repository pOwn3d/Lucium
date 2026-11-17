// Two properties of the source that no other test holds, read in the files themselves:
//  - no web contents is made with a weakened `webPreferences`: the sandbox, the context isolation and the web security stay on, Node, `<webview>`
//    and insecure content stay off. Electron's defaults give the same, but a line that turned one of them around anywhere would pass every other
//    test; this one fails on it, whatever the object it is written in. The source is read as a tree (the parser Vite ships), not line by line: one
//    of these preferences may only ever be written as its safe literal, so `sandbox: !1`, `sandbox: flag`, a value on the next line,
//    `prefs.sandbox = false` and an object spread into `webPreferences` all fail. What a tree cannot see is
//    a name made at run time (`prefs[key] = false`, `Object.assign(prefs, weak)` with `weak` built elsewhere): the rule is a net, not a proof.
//  - the code compiles text into code in two places only, each from the constant of its own file (a function the pages run too, kept as text):
//    no `eval`, no `Function` built from anything else. A new one has to be added here, with its reason.
// The tests (`*.test.ts`, the test supports) and the engine tests (`smoke*.ts`, which the packaged app does not carry) are not read: they build
// hostile inputs on purpose.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseAst } from 'vite'
import { pageDialogPreferences } from '@shared/page-dialog'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SOURCE = join(ROOT, 'src')

/** The shipped source files of `src`, as paths from the root of the repository, with their text. */
function shippedSources(): Array<{ path: string; text: string }> {
  const found: Array<{ path: string; text: string }> = []
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.includes('test-support') && !/^smoke/.test(entry.name)) {
        found.push({ path: relative(ROOT, full), text: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(SOURCE)
  return found
}

/** The web preferences that decide what a page can reach, each with the only value it may be written with: the three that stay on, the five that stay off. */
const SAFE_PREFERENCE: Readonly<Record<string, boolean>> = {
  sandbox: true,
  contextIsolation: true,
  webSecurity: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webviewTag: false,
  allowRunningInsecureContent: false
}

/** The calls whose result may be spread into `webPreferences`: each is checked below to carry none of the preferences above. */
const SPREAD_INTO_PREFERENCES: Readonly<Record<string, () => object>> = { pageDialogPreferences }

interface Node {
  type: string
  start: number
  end: number
  [key: string]: unknown
}
const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as Node).type === 'string'

/** The tree of a source text, parsed once: the rules below each walk the same files. */
const trees = new Map<string, Node>()
function treeOf(path: string, text: string): Node {
  const key = `${path}\n${text}`
  let tree = trees.get(key)
  if (!tree) trees.set(key, (tree = parseAst(text, { lang: path.endsWith('.tsx') ? 'tsx' : 'ts' }) as unknown as Node))
  return tree
}

/** The name a key or a member is written with (`sandbox`, `'sandbox'`, `["sandbox"]`), or undefined when it is worked out at run time. */
function writtenName(key: unknown, computed: unknown): string | undefined {
  if (!isNode(key)) return undefined
  if (key.type === 'Identifier' && computed !== true) return key['name'] as string
  if (key.type === 'Literal' && typeof key['value'] === 'string') return key['value']
  if (key.type === 'TemplateLiteral' && (key['expressions'] as unknown[]).length === 0) return ((key['quasis'] as Array<{ value: { cooked: string } }>)[0]?.value.cooked)
  return undefined
}

/** Whether `value` is the literal `safe` and nothing else (`x as boolean` and `(x)` are looked through; `!1`, a name, a condition are not literals). */
function isLiteral(value: unknown, safe: boolean): boolean {
  let node = value
  while (isNode(node) && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node.type)) node = node['expression']
  return isNode(node) && node.type === 'Literal' && node['value'] === safe
}

/**
 * The places of a source file where a web preference is written otherwise than as its safe literal, as `path: text of the place`. Three shapes:
 * a property of an object (`{ sandbox: … }`, shorthand included), an assignment to a member (`prefs.sandbox = …`), and an object spread into the
 * value of a `webPreferences` (property or variable) that is not a call listed in SPREAD_INTO_PREFERENCES. Types and destructuring write nothing.
 */
function weakenedPreferences(path: string, text: string): string[] {
  const found: string[] = []
  const report = (node: Node): void => void found.push(`${path}: ${text.slice(node.start, node.end).replace(/\s+/g, ' ').slice(0, 160)}`)
  const checkSpreads = (object: unknown): void => {
    if (!isNode(object) || object.type !== 'ObjectExpression') return
    for (const property of object['properties'] as Node[]) {
      if (property.type !== 'SpreadElement') continue
      const spread = property['argument']
      const callee = isNode(spread) && spread.type === 'CallExpression' && isNode(spread['callee']) && spread['callee'].type === 'Identifier' ? (spread['callee']['name'] as string) : undefined
      if (callee === undefined || !Object.hasOwn(SPREAD_INTO_PREFERENCES, callee) || (spread as Node)['arguments'] === undefined || ((spread as Node)['arguments'] as unknown[]).length > 0) report(property)
    }
  }
  const walk = (node: Node): void => {
    // A type says nothing of a value (`sandbox: boolean` in an interface is not a preference being set).
    if (node.type.startsWith('TS') && !['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression'].includes(node.type)) return
    if (node.type === 'ObjectExpression') {
      for (const property of node['properties'] as Node[]) {
        if (property.type !== 'Property') continue
        const name = writtenName(property['key'], property['computed'])
        if (name !== undefined && Object.hasOwn(SAFE_PREFERENCE, name) && !isLiteral(property['value'], SAFE_PREFERENCE[name]!)) report(property)
        if (name === 'webPreferences') checkSpreads(property['value'])
      }
    }
    if (node.type === 'VariableDeclarator' && isNode(node['id']) && node['id'].type === 'Identifier' && /webPreferences/i.test(node['id']['name'] as string)) checkSpreads(node['init'])
    if (node.type === 'AssignmentExpression' && isNode(node['left']) && node['left'].type === 'MemberExpression') {
      const name = writtenName(node['left']['property'], node['left']['computed'])
      if (name !== undefined && Object.hasOwn(SAFE_PREFERENCE, name) && !(node['operator'] === '=' && isLiteral(node['right'], SAFE_PREFERENCE[name]!))) report(node)
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type') continue
      if (Array.isArray(value)) for (const each of value) if (isNode(each)) walk(each)
      if (isNode(value)) walk(value)
    }
  }
  walk(treeOf(path, text))
  return found
}

/** The five locks every web contents of the application writes out, whatever Electron's defaults are or become. */
const WRITTEN_LOCKS = ['sandbox', 'contextIsolation', 'nodeIntegration', 'nodeIntegrationInSubFrames', 'webviewTag'] as const

/**
 * The `webPreferences` of a source file that do not write the five locks, as `path: text of the place`. The defaults of Electron give the same
 * values, and a reader of the source (or a later Electron) should not have to know them: each object given as `webPreferences`, and each object
 * that writes one lock, writes them all. A `webPreferences` that is a name (the shorthand, a parameter) is the object that name was given.
 */
function unwrittenLocks(path: string, text: string): string[] {
  const found: string[] = []
  const check = (object: Node, mustLock: boolean): void => {
    const names = (object['properties'] as Node[]).filter((property) => property.type === 'Property').map((property) => writtenName(property['key'], property['computed']))
    const written = WRITTEN_LOCKS.filter((lock) => names.includes(lock))
    if ((mustLock || written.length > 0) && written.length < WRITTEN_LOCKS.length) found.push(`${path}: ${text.slice(object.start, object.end).replace(/\s+/g, ' ').slice(0, 160)}`)
  }
  const walk = (node: Node): void => {
    if (node.type.startsWith('TS') && !['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression'].includes(node.type)) return
    if (node.type === 'ObjectExpression') {
      check(node, false)
      for (const property of node['properties'] as Node[]) {
        if (property.type === 'Property' && writtenName(property['key'], property['computed']) === 'webPreferences' && isNode(property['value']) && property['value'].type === 'ObjectExpression') check(property['value'], true)
      }
    }
    if (node.type === 'VariableDeclarator' && isNode(node['id']) && node['id'].type === 'Identifier' && /webPreferences/i.test(node['id']['name'] as string) && isNode(node['init']) && node['init'].type === 'ObjectExpression') check(node['init'], true)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type') continue
      if (Array.isArray(value)) for (const each of value) if (isNode(each)) walk(each)
      if (isNode(value)) walk(value)
    }
  }
  walk(treeOf(path, text))
  return [...new Set(found)]
}

/** Text turned into code: `eval(…)`, `new Function`, `Function(…)`. */
const CODE_FROM_TEXT = /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/

/** The places that may compile text, each the whole line, and why. */
const COMPILES_TEXT: Readonly<Record<string, string>> = {
  'src/shared/find-replace.ts: export const replaceInText = new Function(`return (${REPLACE_IN_TEXT_SOURCE})`)() as (':
    'the replacement runs inside the page as text; the main process and the tests run the very same constant of the file',
  'src/shared/text-format.ts: export const transformCase = new Function(`return (${TRANSFORM_CASE_SOURCE})`)() as (text: string, kind: CaseTransform) => string':
    'the change of case runs inside the page as text; the main process and the tests run the very same constant of the file'
}

/** The lines of a file that match, as `path: line`, comment lines left out (a comment may name what it does not do). */
function linesMatching(files: Array<{ path: string; text: string }>, pattern: RegExp): string[] {
  return files.flatMap(({ path, text }) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*') && pattern.test(line))
      .map((line) => `${path}: ${line}`)
  )
}

describe('the shipped source', () => {
  const files = shippedSources()

  it('is read: the main process, the shared code, the preloads and the interface', () => {
    for (const path of ['src/main/engine/electron-engine.ts', 'src/main/index.ts', 'src/shared/find-replace.ts', 'src/preload/page-guard.ts']) {
      expect(files.map((file) => file.path), path).toContain(path)
    }
    // The places that set the preferences explicitly are there to be read (the views of the tabs, the windows of the interface).
    expect(linesMatching(files, /\bsandbox\s*:\s*true\b/).length).toBeGreaterThan(10)
  })

  // Every shipped file is parsed into its tree: more than a second of processor, which a machine with every core taken stretches past the 5 s default.
  it('never weakens the web preferences of a web contents', { timeout: 30_000 }, () => {
    expect(files.flatMap(({ path, text }) => weakenedPreferences(path, text))).toEqual([])
  })

  it('writes the five locks in every `webPreferences`: the sandbox, the isolation, no Node in the page or its frames, no <webview>', () => {
    expect(files.flatMap(({ path, text }) => unwrittenLocks(path, text))).toEqual([])
    // The rule, on lines written for it.
    const all = 'sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false'
    expect(unwrittenLocks('src/x.ts', `new BrowserWindow({ webPreferences: { preload, ${all} } }); const webPreferences = { ${all} }; new WebContentsView({ webPreferences })`)).toEqual([])
    expect(unwrittenLocks('src/x.ts', 'new BrowserWindow({ webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } })')).toHaveLength(1)
    expect(unwrittenLocks('src/x.ts', 'new BrowserWindow({ webPreferences: { preload } })')).toHaveLength(1)
    expect(unwrittenLocks('src/x.ts', 'const webPreferences = { preload, sandbox: true }')).toHaveLength(1)
    expect(unwrittenLocks('src/x.ts', 'const prefs = { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false }')).toHaveLength(1)
    expect(unwrittenLocks('src/x.ts', 'interface P { sandbox: boolean } const other = { preload }')).toEqual([])
  })

  it('spreads into `webPreferences` only objects that carry none of these preferences', () => {
    for (const [name, make] of Object.entries(SPREAD_INTO_PREFERENCES)) expect(Object.keys(make()).filter((key) => Object.hasOwn(SAFE_PREFERENCE, key)), name).toEqual([])
  })

  // The rule itself, on lines written for it: every way of writing a preference that is not its safe literal is found, and the safe ones are not.
  it.each([
    ['the unsafe literal', 'new BrowserWindow({ webPreferences: { sandbox: false } })'],
    ['a quoted key', `const prefs = { 'contextIsolation': false }`],
    ['a computed literal key', 'const prefs = { ["webSecurity"]: false }'],
    ['a value that is not a literal', 'const prefs = { sandbox: !1 }'],
    ['a name', 'const prefs = { sandbox: flag }'],
    ['a condition', 'const prefs = { sandbox: dev ? false : true }'],
    ['a shorthand', 'const sandbox = false; const prefs = { sandbox }'],
    ['the value on the next line', 'const prefs = {\n  nodeIntegration:\n    true\n}'],
    ['a preference switched on that must stay off', 'const prefs = { webviewTag: true, allowRunningInsecureContent: true }'],
    ['Node in the frames or the workers', 'const prefs = { nodeIntegrationInSubFrames: true, nodeIntegrationInWorker: true }'],
    ['an assignment to a member', 'prefs.sandbox = false'],
    ['an assignment by a quoted name', `prefs['contextIsolation'] = off`],
    ['an assignment through a longer path', 'options.webPreferences.nodeIntegration = true'],
    ['a compound assignment', 'prefs.webSecurity &&= check()'],
    ['an object spread into webPreferences', 'new BrowserWindow({ webPreferences: { sandbox: true, ...weak } })'],
    ['a call that is not listed spread into webPreferences', 'new WebContentsView({ webPreferences: { ...pagePreferences() } })'],
    ['a listed call given arguments', 'new WebContentsView({ webPreferences: { ...pageDialogPreferences(weak) } })'],
    ['a spread into a variable of preferences', 'const webPreferences = { preload, ...fromEnvironment }']
  ])('finds %s', (_name, source) => {
    expect(weakenedPreferences('probe.ts', source).length).toBeGreaterThan(0)
  })

  it('finds each of two weakened preferences on one line, and says where', () => {
    expect(weakenedPreferences('src/x.ts', 'const prefs = { sandbox: false, contextIsolation: true, nodeIntegration: true }')).toEqual(['src/x.ts: sandbox: false', 'src/x.ts: nodeIntegration: true'])
  })

  it.each([
    ['the safe literals', 'new BrowserWindow({ webPreferences: { preload, sandbox: true, contextIsolation: true, webSecurity: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false } })'],
    ['a safe literal behind a cast', 'const prefs = { sandbox: true as boolean, nodeIntegration: (false) }'],
    ['a safe assignment', 'prefs.sandbox = true; prefs.nodeIntegration = false'],
    ['the listed spread', 'new WebContentsView({ webPreferences: { session, sandbox: true, ...pageDialogPreferences(), autoplayPolicy: policy } })'],
    ['a spread outside webPreferences', 'new BrowserWindow({ ...options, webPreferences })'],
    ['a type', 'interface Prefs { sandbox: boolean; nodeIntegration?: boolean }\ntype T = { sandbox: false }'],
    ['a destructuring', 'const { sandbox, nodeIntegration = true } = prefs'],
    ['a comment and a string', "// sandbox: false\nconst note = 'sandbox: false'"],
    ['a word of another vocabulary', "const directives = ['sandbox']; if (name === 'sandbox') use(name)"]
  ])('leaves %s alone', (_name, source) => {
    expect(weakenedPreferences('probe.ts', source)).toEqual([])
  })

  it('compiles text into code only in the places listed, each from the constant of its own file', () => {
    expect(linesMatching(files, CODE_FROM_TEXT).sort()).toEqual(Object.keys(COMPILES_TEXT).sort())
  })
})
