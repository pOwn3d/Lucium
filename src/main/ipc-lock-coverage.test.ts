// The lock holds for every channel of the main process, whoever registers it. `registerIpc` shuts its channels with its guard (OPEN_WHILE_LOCKED,
// src/shared/lock.ts); the surfaces that listen on a channel of their own (mini windows, application windows, floating video, annotation, share)
// ask `shutByLock` (shell/lock-gate.ts). Nothing made a new channel do either: one that forgot would be answered while the application is locked,
// and only a window left open would show it. This test reads every registration on `ipcMain` in the shipped source (as a tree, with the parser
// Vite ships) and fails on one whose handler reaches neither, directly or through a function of the same file, unless it is a channel of the web
// pages, listed below with the reason the lock does not need to be asked there.
// The tests, the test supports and the engine tests (`smoke*.ts`, which the package does not carry) are not read.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseAst } from 'vite'
import { posix } from './windows.test-support'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MAIN = join(ROOT, 'src/main')

/**
 * The channels the preloads of the web pages speak on (a tab, a popup it opened). Locking the application destroys the pages of its tabs
 * (shell/browser-annotation.ts, `onLockChange`) and every window over them, so nothing is left to send on them; each handler checks its sender
 * on its own (main frame of a page of ours). Written as the first argument of the registration.
 */
const PAGE_CHANNELS: Readonly<Record<string, string>> = {
  'PAGE_DIALOG.alert': 'alert() of the main frame of a tab (preload/dialog-bridge.ts)',
  'PAGE_DIALOG.confirm': 'confirm() of the main frame of a tab (preload/dialog-bridge.ts)',
  'PAGE_DIALOG.prompt': 'prompt() of the main frame of a tab (preload/dialog-bridge.ts)',
  'PERMISSION_STATE.undecided': 'the state of a permission a page reads (preload/permission-state.ts)',
  SHIM_CALL_CHANNEL: 'the calls of the extension APIs Lucium provides, from a page or a worker of an extension (preload/extension-shims.ts)',
  'Channel.extTabCaptureId': 'the identifier of a capture of the sound of a tab, asked by a page of an extension (preload/extension-shims.ts); with the application locked no tab is left to capture, and the engine reads again that the tab is not locked',
  'Channel.extTabCaptureListen': 'a page of an extension listens to the tab it took an identifier for (preload/extension-shims.ts), and is answered with the format of the sound; with the application locked no tab is left to capture, and the engine reads again that the tab is not locked',
  'Channel.extTabCaptureEnd': 'a page of an extension says its stream is over (preload/extension-shims.ts)',
  'Channel.extTabCaptureList': 'the tabs an extension captures, asked by a page of the extension (preload/extension-shims.ts)',
  'Channel.lentTabAttached': 'the page of a tab says it took the runtime of the script an extension injected into it (preload/lent-tab.ts); only the main frame of the tab that was asked is heard, and a lock destroys the pages of the tabs',
  'Channel.lentTabCall': 'the one call of the script an extension injected into a tab the user lent it, over the bridge of the main frame of the tab (preload/lent-tab.ts); the extension is the one whose world it is and the tab must still be lent to it (engine/lent-tabs.ts), and a lock destroys the pages of the tabs',
  'Channel.capturePcm': 'the one call of the helper page of a capture: a chunk of the sound of the tab (preload/capture-helper.ts); only the main frame of a helper page the engine made is taken, and a lock ends every capture, so there is nothing to hold back',
  'PAGE_GUARD.plan': 'the plan of the page guard, asked before the first script of a page (preload/page-guard.ts)',
  'PASSWORD_BRIDGE.submitted': 'a form with a password submitted in the main frame of a tab (preload/password-bridge.ts)',
  'MEDIA_BRIDGE.hello': 'the volume of a tab, asked by its media bridge (preload/media-bridge.ts)',
  'MEDIA_BRIDGE.actions': 'the track actions a page registers (preload/media-bridge.ts)'
}

/** The functions that consult the lock: the guard of `registerIpc` (handed to the modules it registers as `guard`) and the gate of the surfaces. */
const LOCK_CALLS = new Set(['guard', 'shutByLock'])
const REGISTRATIONS = new Set(['on', 'handle', 'once', 'handleOnce'])

interface Node {
  type: string
  start: number
  end: number
  [key: string]: unknown
}
const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as Node).type === 'string'

function children(node: Node): Node[] {
  const found: Node[] = []
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue
    if (Array.isArray(value)) for (const item of value) if (isNode(item)) found.push(item)
    if (isNode(value)) found.push(value)
  }
  return found
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node)
  for (const child of children(node)) walk(child, visit)
}

/** The name of `x` and of `this.x`, else undefined. */
function nameOf(node: unknown): string | undefined {
  if (!isNode(node)) return undefined
  if (node.type === 'Identifier') return node['name'] as string
  if (node.type === 'MemberExpression' && isNode(node['object']) && node['object'].type === 'ThisExpression' && isNode(node['property']) && node['property'].type === 'Identifier') return node['property']['name'] as string
  return undefined
}

/** The functions of a file by name (declarations, methods, class fields and constants holding a function), with their bodies. */
function functionsOf(tree: Node): Map<string, Node> {
  const found = new Map<string, Node>()
  const isFunction = (value: unknown): value is Node => isNode(value) && ['ArrowFunctionExpression', 'FunctionExpression'].includes(value.type)
  walk(tree, (node) => {
    if (node.type === 'FunctionDeclaration' && isNode(node['id'])) found.set(node['id']['name'] as string, node)
    if ((node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') && isNode(node['key']) && node['key'].type === 'Identifier' && (node.type === 'MethodDefinition' || isFunction(node['value']))) found.set(node['key']['name'] as string, node)
    if (node.type === 'VariableDeclarator' && isNode(node['id']) && node['id'].type === 'Identifier' && isFunction(node['init'])) found.set(node['id']['name'] as string, node)
  })
  return found
}

/** Whether `node` calls one of LOCK_CALLS, or calls or hands on a function of the file that does (followed a few levels deep). */
function reachesLock(node: Node, functions: Map<string, Node>, seen: Set<string> = new Set()): boolean {
  let reaches = false
  walk(node, (inner) => {
    if (reaches) return
    const called = inner.type === 'CallExpression' ? nameOf(inner['callee']) : undefined
    if (called !== undefined && LOCK_CALLS.has(called)) {
      reaches = true
      return
    }
    // A call of a function of the file (`allowed(e)`, `this.fromCommand(event)`), or a function of the file handed on (`this.onAction`).
    const named = called ?? (inner.type === 'MemberExpression' || inner.type === 'Identifier' ? nameOf(inner) : undefined)
    if (named === undefined || seen.has(named) || seen.size > 6) return
    const body = functions.get(named)
    if (!body) return
    seen.add(named)
    if (reachesLock(body, functions, seen)) reaches = true
  })
  return reaches
}

interface Registration {
  path: string
  channel: string
  lockAware: boolean
}

/** Every `ipcMain.on/handle/once/handleOnce(channel, handler)` of a shipped file of the main process, `(x ?? ipcMain).on(…)` included. */
function registrations(path: string, text: string): Registration[] {
  const tree = parseAst(text, { lang: 'ts' }) as unknown as Node
  const functions = functionsOf(tree)
  const found: Registration[] = []
  walk(tree, (node) => {
    if (node.type !== 'CallExpression' || !isNode(node['callee']) || node['callee'].type !== 'MemberExpression') return
    const callee = node['callee']
    const method = isNode(callee['property']) ? (callee['property']['name'] as string | undefined) : undefined
    if (method === undefined || !REGISTRATIONS.has(method)) return
    let target = callee['object']
    while (isNode(target) && ['LogicalExpression', 'ParenthesizedExpression'].includes(target.type)) target = target.type === 'LogicalExpression' ? target['right'] : target['expression']
    if (!isNode(target) || target.type !== 'Identifier' || target['name'] !== 'ipcMain') return
    const [channel, handler] = node['arguments'] as Node[]
    if (!channel || !handler) return
    found.push({ path, channel: text.slice(channel.start, channel.end), lockAware: reachesLock(handler, functions) })
  })
  return found
}

function shippedMainSources(): Array<{ path: string; text: string }> {
  const found: Array<{ path: string; text: string }> = []
  const visit = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !entry.name.includes('test-support') && !/^smoke/.test(entry.name)) found.push({ path: posix(relative(ROOT, full)), text: readFileSync(full, 'utf8') })
    }
  }
  visit(MAIN)
  return found
}

describe('the lock and the channels of the main process', () => {
  const all = shippedMainSources().flatMap(({ path, text }) => registrations(path, text))

  it('finds the registrations it judges (a reader that found none would pass everything)', () => {
    expect(all.length).toBeGreaterThan(100)
    expect(all.some((r) => r.path === 'src/main/shell/window-share.ts' && r.lockAware)).toBe(true)
  })

  it('asks the lock in every handler, or the channel is one of the web pages, listed with its reason', () => {
    const unguarded = all.filter((r) => !r.lockAware && !Object.hasOwn(PAGE_CHANNELS, r.channel)).map((r) => `${r.path}: ${r.channel}`)
    expect(unguarded).toEqual([])
  })

  it('lists only channels that are registered, and never asks the lock on a channel of the pages (a page has no lock screen to answer)', () => {
    const pageChannels = all.filter((r) => Object.hasOwn(PAGE_CHANNELS, r.channel))
    expect([...new Set(pageChannels.map((r) => r.channel))].sort()).toEqual(Object.keys(PAGE_CHANNELS).sort())
  })

  it('reads a handler that forgot the lock as one, and one that asks it through a function of its file as aware', () => {
    const judged = registrations(
      'example.ts',
      `class A {
        private fromSurface(event) { return event.sender.id === 1 && !shutByLock('the bar') }
        private readonly onAction = (event) => { if (this.fromSurface(event)) this.act() }
        constructor() {
          ipcMain.handle(CHANNEL.one, (event) => (this.fromSurface(event) ? 1 : 0))
          ipcMain.on(CHANNEL.two, this.onAction)
          ;(deps.ipc ?? ipcMain).on(CHANNEL.three, (event) => this.act(event))
          ipcMain.handle(CHANNEL.four, (e) => (guard(e.sender, CHANNEL.four) ? 4 : null))
        }
      }`
    )
    expect(judged.map((r) => [r.channel, r.lockAware])).toEqual([
      ['CHANNEL.one', true],
      ['CHANNEL.two', true],
      ['CHANNEL.three', false],
      ['CHANNEL.four', true]
    ])
  })

  it('takes `guard` for the guard of registerIpc: that one consults the lock', () => {
    const ipc = readFileSync(join(MAIN, 'shell/ipc.ts'), 'utf8')
    const guard = /const guard = \(sender: WebContents, channel: string\): boolean => \{[\s\S]*?\n {2}\}/.exec(ipc)?.[0] ?? ''
    expect(guard).toContain('isAppLocked()')
    expect(guard).toContain('OPEN_WHILE_LOCKED.has(channel)')
  })
})
