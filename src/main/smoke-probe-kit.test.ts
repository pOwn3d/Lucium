import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { manifestListsTooLong } from '@shared/chrome-compat'
import { DebuggerGuard } from '@shared/debugger-policy'
import { checkManifestText, manifestTooLongMessage } from '@shared/extension-page'
import { filterToken, matchFilter, readNetRule, type NetRule as ReadRule } from '@shared/net-rules'
import { fixSenderTabs } from '../preload/sender-tab'
import { loadChecked } from './engine/extension-load'
import { localPageRead, REFUSED_READ } from './engine/local-file-guard'
import { StrictTransportHosts } from './engine/strict-transport'
import { StrictTransportStore } from './engine/strict-transport-store'
import type { SmokeContext } from './smoke'
import { beginLedger, recorderOf, runReportOf, runSuite, type CheckRecord } from './smoke-kit'
import {
  blockObservation,
  BOUND_PROBE,
  BOUND_SITES,
  boundProbe,
  DNR_ACTIONS,
  DROP_WATCH,
  DROP_WITNESS,
  dropVerdict,
  hostHeaderOf,
  LISTENED_EVENT,
  LISTENED_PATH,
  LISTENER_OWNER,
  LISTENER_SPY,
  listenedCookieOf,
  LONGEST_PAUSE_MS,
  modelHitsVerdict,
  ownerKept,
  pauseVerdict,
  plainAddress,
  sharedWorkerScript,
  sharedWorkerVerdict,
  SLOW_ADDRESS_PATH,
  SLOW_FILTER_RULE,
  strictHostsFile,
  DYNAMIC_RULES,
  eventObservation,
  fetchScript,
  frameScript,
  headerObservation,
  injected,
  NET_PROBE,
  NET_PROBE_FOLDER,
  NP,
  NP_PATHS,
  overBlockObservation,
  PUT_OFF,
  readVerdict,
  redirectObservation,
  refusedInjection,
  requestScript,
  RULE_KEYS,
  ruleCheck,
  ruleStates,
  SESSION_RULES,
  settled,
  TAB_PROBE,
  TAB_PROBE_FOLDER,
  OPTIONAL_PROBE,
  OPTIONAL_PROBE_FOLDER,
  OPTIONAL_PROBE_ORIGIN,
  OPTIONAL_PROBE_PERMISSION,
  upgradeObservation,
  WEB_REQUEST_EVENTS,
  withControl,
  xhrScript,
  ACCEPT_CH,
  ASKED_HINTS,
  brandRelation,
  brandsOfHeader,
  CLIENT_HINTS_TAG,
  clientHintsLine,
  clientHintsReadScript,
  DEFAULT_HINTS,
  flatHeaders,
  HIGH_ENTROPY_HINTS,
  HINT_PHASES,
  HINT_WHATS,
  hintPath,
  hintRequestOf,
  hintsOf,
  judgeHints,
  summarizeHints,
  type Observation,
  type PageRead,
  type RuleKey,
  type SeenRequest
} from './smoke-probe-kit'

const root = join(__dirname, '../..')
const compat = (folder: string, file: string): string => readFileSync(join(root, 'compat', folder, file), 'utf8')
const manifestOf = (folder: string): Record<string, any> => JSON.parse(compat(folder, 'manifest.json')) as Record<string, any>

// The suite loads Electron for what it does once its probes are in; a stand-in is enough to see what it does when they are not.
vi.mock('electron', async () => (await import('./engine/electron-page.test-support')).electronStub({ app: { getAppPath: () => '/repo' } }))

describe('what a page read (the checks of a local page)', () => {
  it('a page that shows the text read it: the check is red, with the text and how often the server was asked', () => {
    expect(readVerdict('read:CROSS-ORIGIN-SECRET', 'CROSS-ORIGIN-SECRET', 1)).toEqual({ kept: false, detail: 'the page read the text: "read:CROSS-ORIGIN-SECRET" (the request reached the server 1 time(s))' })
    expect(readVerdict('read:<body>LOCAL-FILE-SECRET</body>', 'LOCAL-FILE-SECRET').kept).toBe(false)
  })

  it('a refusal, an answer without its text and a text that is not the secret all keep it, and the detail says which', () => {
    expect(readVerdict('refused:TypeError: Failed to fetch', 'CROSS-ORIGIN-SECRET', 1)).toEqual({ kept: true, detail: 'the page got "refused:TypeError: Failed to fetch" (the request reached the server 1 time(s))' })
    expect(readVerdict('opaque', 'S')).toEqual({ kept: true, detail: 'the page got "opaque"' })
    expect(readVerdict('read:', 'S').kept).toBe(true)
  })

  it('an answer that none of the scripts gives is no proof that the secret was kept', () => {
    expect(readVerdict(undefined, 'S')).toEqual({ kept: false, detail: 'not an answer of the script: undefined' })
    expect(readVerdict('the script of the page: failed: Script failed to execute', 'S').kept).toBe(false)
    expect(readVerdict(42, 'S').kept).toBe(false)
  })

  it('the three scripts name the address they read, as a string of the script and not as code', () => {
    const address = `http://127.0.0.1:1/x'); alert(1); ('`
    for (const script of [fetchScript(address), fetchScript(address, { mode: 'same-origin', credentials: 'include' }), xhrScript(address), frameScript(address), requestScript(address)]) {
      expect(script).toContain(JSON.stringify(address))
      expect(() => new Function(`return ${script}`)).not.toThrow()
    }
  })
})

describe('the rules the probe is handed', () => {
  it('have a rule for every action type of declarativeNetRequest, and no other type', () => {
    expect([...DNR_ACTIONS].sort()).toEqual(['allow', 'allowAllRequests', 'block', 'modifyHeaders', 'redirect', 'upgradeScheme'])
    expect([...new Set(SESSION_RULES.map((rule) => rule.action.type))].sort()).toEqual([...DNR_ACTIONS].sort())
  })

  it('touch only the paths of the server of the checks, each with an id of its own', () => {
    const rules = [...SESSION_RULES, ...DYNAMIC_RULES]
    for (const rule of rules) expect(rule.condition.urlFilter.startsWith(`${NP}/`), JSON.stringify(rule)).toBe(true)
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length)
    for (const path of Object.values(NP_PATHS)) expect(path.startsWith(`${NP}/`), path).toBe(true)
    // No rule covers the control request, and no filter is the start of another path (a block rule would then stop a request that is not its own).
    const filters = rules.map((rule) => rule.condition.urlFilter)
    expect(filters.some((filter) => NP_PATHS.control.includes(filter))).toBe(false)
    for (const path of Object.values(NP_PATHS)) expect(filters.filter((filter) => path.includes(filter) && filter !== path), path).toEqual([])
  })

  it('put the rule that lets a request through above the block rule it is set against, on the same path or on the frame that asks', () => {
    const of = (type: string, filter: string) => SESSION_RULES.find((rule) => rule.action.type === type && rule.condition.urlFilter === filter)
    expect(of('allow', NP_PATHS.allow)!.priority).toBeGreaterThan(of('block', NP_PATHS.allow)!.priority)
    expect(of('allowAllRequests', NP_PATHS.frame)!.priority).toBeGreaterThan(of('block', NP_PATHS.frameAsset)!.priority)
    expect(of('allowAllRequests', NP_PATHS.frame)!.condition.resourceTypes).toEqual(['sub_frame'])
  })

  it('name a key for each action as a session rule, for a block rule of the two other kinds and for every webRequest event', () => {
    for (const action of DNR_ACTIONS) expect(RULE_KEYS.some((key) => key.startsWith(`dnr.session.${action}`)), action).toBe(true)
    expect(RULE_KEYS).toContain('dnr.dynamic.block')
    expect(RULE_KEYS).toContain('dnr.static.block')
    expect(WEB_REQUEST_EVENTS).toHaveLength(9)
    for (const event of WEB_REQUEST_EVENTS) expect(RULE_KEYS).toContain(`webRequest.${event}`)
    expect(new Set(RULE_KEYS).size).toBe(RULE_KEYS.length)
  })
})

describe('what was seen of a rule', () => {
  const failed = { body: null, error: 'TypeError: Failed to fetch' }
  const answered = { body: 'arrived' }

  it('block: applied when the server saw nothing and the page got an error, not applied as soon as the request arrived', () => {
    expect(blockObservation(0, failed)).toEqual({ state: 'applied', saw: 'the server saw the request 0 time(s), the page got the error "TypeError: Failed to fetch"' })
    expect(blockObservation(1, answered)).toEqual({ state: 'not-applied', saw: 'the server saw the request 1 time(s), the page got "arrived"' })
    expect(blockObservation(1, failed).state).toBe('not-applied')
    expect(blockObservation(0, answered).state).toBe('unmeasured')
  })

  it('allow and allowAllRequests: told only when the block rule alone is applied', () => {
    const applied = blockObservation(0, failed)
    const dead = blockObservation(1, answered)
    expect(overBlockObservation(applied, 1).state).toBe('applied')
    expect(overBlockObservation(applied, 0).state).toBe('not-applied')
    // The request arrives either way when nothing blocks: that is no proof that the allow rule did anything.
    expect(overBlockObservation(dead, 1).state).toBe('no-ground')
    expect(overBlockObservation(dead, 1).saw).toContain('the block rule alone: not-applied')
    expect(overBlockObservation(blockObservation(0, answered), 1).state).toBe('unmeasured')
  })

  it('redirect: the page got the text of the path of the rule, or of the path it asked for', () => {
    const texts = { from: 'from', to: 'to' }
    expect(redirectObservation({ body: 'to' }, texts).state).toBe('applied')
    expect(redirectObservation({ body: 'from' }, texts)).toEqual({ state: 'not-applied', saw: 'the page got "from"' })
    expect(redirectObservation(failed, texts).state).toBe('unmeasured')
    expect(redirectObservation({ body: 'arrived' }, texts).state).toBe('unmeasured')
  })

  it('upgradeScheme: the request never arrived as http', () => {
    expect(upgradeObservation(0, failed).state).toBe('applied')
    expect(upgradeObservation(1, answered).state).toBe('not-applied')
    expect(upgradeObservation(0, answered).state).toBe('unmeasured')
  })

  it('modifyHeaders: the header has the value of the rule, where it is read', () => {
    expect(headerObservation('1', true, 'the server received')).toEqual({ state: 'applied', saw: 'the server received the header as "1"' })
    expect(headerObservation(null, true, 'the page read')).toEqual({ state: 'not-applied', saw: 'the page read the header as absent' })
    expect(headerObservation(undefined, true, 'the server received').state).toBe('not-applied')
    expect(headerObservation('2', true, 'the server received').state).toBe('not-applied')
    expect(headerObservation('1', false, 'the server received').state).toBe('unmeasured')
  })

  it('a webRequest event: heard for the request made for it, and for no other', () => {
    const heard = [
      { event: 'onCompleted', url: `http://127.0.0.1:9${NP_PATHS.heardPlain}` },
      { event: 'onBeforeRequest', url: `http://127.0.0.1:9${NP_PATHS.control}` },
      { event: 'onAuthRequired', failed: 'not supported' }
    ]
    expect(eventObservation('onCompleted', heard, NP_PATHS.heardPlain, true)).toEqual({ state: 'applied', saw: `the listener heard onCompleted 1 time(s) for ${NP_PATHS.heardPlain}` })
    expect(eventObservation('onBeforeRequest', heard, NP_PATHS.heardPlain, true).state).toBe('not-applied')
    expect(eventObservation('onBeforeRedirect', heard, NP_PATHS.heardRedirect, true).state).toBe('not-applied')
    // A listener the engine refused to add is an answer, whatever the request.
    expect(eventObservation('onAuthRequired', heard, NP_PATHS.heardAuth, false)).toEqual({ state: 'not-applied', saw: 'the listener could not be added: not supported' })
    expect(eventObservation('onErrorOccurred', heard, NP_PATHS.heardError, false).state).toBe('unmeasured')
  })

  it('counts for nothing when the control request did not arrive', () => {
    const seen = blockObservation(0, failed)
    expect(withControl(true, seen)).toBe(seen)
    expect(withControl(false, seen)).toEqual({ state: 'unmeasured', saw: `the control request did not arrive, so this proves nothing: ${seen.saw}` })
  })
})

describe('the check an observation becomes', () => {
  const applied: Observation = { state: 'applied', saw: 'the server saw the request 0 time(s)' }
  const dead: Observation = { state: 'not-applied', saw: 'the server saw the request 1 time(s)' }

  it('no key is put off: every rule and every event is applied, and one that is not fails the run', () => {
    expect([...PUT_OFF]).toEqual([])
    for (const key of RULE_KEYS) expect(ruleCheck(key, 'x', dead).ok, key).toBe(false)
  })

  it('a rule that is applied is a passed check, with what was seen', () => {
    expect(ruleCheck('dnr.session.block', 'a block rule stops the request', applied)).toEqual({ name: 'dnr.session.block: a block rule stops the request', ok: true, detail: 'applied: the server saw the request 0 time(s)' })
  })

  it('a rule that is put off and not applied is a check that was not made: counted as skipped, with the reason and what was seen, and the suite stays green', async () => {
    const putOff = new Set<string>(['dnr.session.block', 'dnr.session.allow'])
    const verdict = ruleCheck('dnr.session.block', 'a block rule stops the request', dead, putOff)
    expect(verdict.ok).toBe(true)
    expect(verdict.detail).toMatch(/^skipped: this request rule or webRequest event of extensions is known not to be applied in this version, and its correction is put off\. Seen: not-applied: the server saw the request 1 time\(s\)$/)
    expect(ruleCheck('dnr.session.allow', 'x', { state: 'no-ground', saw: 'y' }, putOff).detail).toMatch(/^skipped: .*Seen: no-ground: y$/)
    const lines: string[] = []
    const outcome = await runSuite(
      'probes-ext',
      async () => {
        const check = recorderOf([], (line) => lines.push(line))
        check('the control request reaches the server', true)
        check(verdict.name, verdict.ok, verdict.detail)
        return 0
      },
      1000,
      (line) => lines.push(line)
    )
    expect(outcome.code).toBe(0)
    expect(outcome.tally).toEqual({ checks: 2, failed: 0, skipped: 1 })
    expect(lines.find((line) => line.includes('dnr.session.block'))).toMatch(/^\[smoke\] skip dnr\.session\.block: a block rule stops the request -- skipped: /)
    // The report keeps it as skipped: a reference where it passed would name it as lost.
    expect((runReportOf({ name: 'electron', version: '45.2.1', chromium: '156' }, [outcome])['suites'] as Record<string, { checks: unknown[] }>)['probes-ext']!.checks[1]).toEqual({ name: verdict.name, ok: true, skipped: true })
  })

  it('a key that is no longer put off is a check like any other: red when the rule is not applied', () => {
    const corrected = new Set<string>(RULE_KEYS.filter((key) => key !== 'dnr.session.block'))
    expect(ruleCheck('dnr.session.block', 'a block rule stops the request', dead, corrected)).toEqual({ name: 'dnr.session.block: a block rule stops the request', ok: false, detail: 'not-applied: the server saw the request 1 time(s)' })
    expect(ruleCheck('dnr.session.allow', 'x', { state: 'no-ground', saw: 'y' }, new Set()).ok).toBe(false)
    // The other keys are still skipped.
    expect(ruleCheck('dnr.session.redirect', 'x', dead, corrected).ok).toBe(true)
  })

  it('a measurement that failed is red whatever is put off: nothing was learnt', () => {
    expect(ruleCheck('webRequest.onCompleted', 'the listener hears the end', { state: 'unmeasured', saw: 'the worker did not answer' }, new Set(RULE_KEYS))).toEqual({ name: 'webRequest.onCompleted: the listener hears the end', ok: false, detail: 'unmeasured: the worker did not answer' })
  })

  it('the states go to the report by key', () => {
    const seen = new Map<RuleKey, Observation>([['dnr.session.block', applied], ['webRequest.onCompleted', dead]])
    expect(ruleStates(seen)).toEqual({ 'dnr.session.block': 'applied', 'webRequest.onCompleted': 'not-applied' })
  })
})

describe('activeTab: what the probe answered', () => {
  it('the script ran when the worker hands back the title of the page, and only then', () => {
    expect(injected({ ok: true, value: 'at /at-a' }, 'at /at-a')).toBe(true)
    expect(injected({ ok: true, value: null }, 'at /at-a')).toBe(false)
    expect(injected({ ok: true, value: 'another page' }, 'at /at-a')).toBe(false)
    expect(injected({ ok: false, error: 'Cannot access contents of the page.' }, 'at /at-a')).toBe(false)
    expect(injected(undefined, 'at /at-a')).toBe(false)
  })

  it('a refusal is an error of the API: a worker that says nothing refused nothing, and a script that ran was not refused', () => {
    expect(refusedInjection({ ok: false, error: 'Cannot access contents of the page. Extension manifest must request permission to access the respective host.' })).toBe(true)
    expect(refusedInjection({ ok: false, error: 'no answer from the worker: no answer after 15000 ms' })).toBe(false)
    expect(refusedInjection({ ok: true, value: 'at /at-a' })).toBe(false)
    expect(refusedInjection({ ok: false })).toBe(false)
    expect(refusedInjection(undefined)).toBe(false)
  })
})

describe('waiting for an answer', () => {
  it('hands over the answer when it comes', async () => {
    expect(await settled(Promise.resolve('granted'), (why) => why, 1000)).toBe('granted')
  })

  it('a promise that fails ends as the reason, never as an exception', async () => {
    expect(await settled(Promise.reject(new Error('Script failed to execute')), (why) => `the script of the page: ${why}`, 1000)).toBe('the script of the page: failed: Script failed to execute')
  })

  it('a promise that says nothing ends after the time given, with the time in the reason', async () => {
    expect(await settled(new Promise<string>(() => {}), (why) => why, 20)).toBe('no answer after 20 ms')
  })
})

describe('the probes of compat/ that the extension suite loads', () => {
  it('net-rules-probe: the two request APIs, every site, a static ruleset, and a page of 127.0.0.1 to drive it', () => {
    const manifest = manifestOf(NET_PROBE_FOLDER)
    expect(manifest['name']).toBe(NET_PROBE)
    expect(manifest['manifest_version']).toBe(3)
    expect(manifest['permissions']).toEqual(expect.arrayContaining(['declarativeNetRequest', 'webRequest']))
    // redirect and modifyHeaders need the host of the request; block does not.
    expect(manifest['host_permissions']).toEqual(['<all_urls>'])
    expect(manifest['declarative_net_request']).toEqual({ rule_resources: [{ id: 'static', enabled: true, path: 'rules.json' }] })
    expect(manifest['externally_connectable']).toEqual({ matches: ['http://127.0.0.1/*'] })
    expect(manifest['content_scripts']).toBeUndefined()
  })

  it('net-rules-probe: its static ruleset is one block rule on the path the suite asks for', () => {
    expect(JSON.parse(compat(NET_PROBE_FOLDER, 'rules.json'))).toEqual([{ id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: NP_PATHS.staticBlock } }])
  })

  it('net-rules-probe: its worker listens to every webRequest event the suite has a check for, on the paths of the checks only', () => {
    const worker = compat(NET_PROBE_FOLDER, 'background.js')
    const listed = /const EVENTS = (\[[^\]]+\])/.exec(worker)?.[1] ?? '[]'
    expect(JSON.parse(listed.replace(/'/g, '"'))).toEqual([...WEB_REQUEST_EVENTS])
    expect(worker).toContain(`includes('${NP}/')`)
    for (const type of ['ping', 'heard', 'install']) expect(worker).toContain(`message?.type === '${type}'`)
  })

  it('optional-permission-probe: nothing held by the manifest, one permission and one site listed as optional, and a worker that reports what it holds and what it can do', () => {
    const manifest = manifestOf(OPTIONAL_PROBE_FOLDER)
    expect(manifest['name']).toBe(OPTIONAL_PROBE)
    // Anything held from the start would make the checks pass without a grant.
    expect(manifest['permissions']).toEqual([])
    for (const key of ['host_permissions', 'content_scripts']) expect(manifest[key], key).toBeUndefined()
    expect(manifest['optional_permissions']).toEqual([OPTIONAL_PROBE_PERMISSION])
    expect(manifest['optional_host_permissions']).toEqual([OPTIONAL_PROBE_ORIGIN])
    expect(manifest['externally_connectable']).toEqual({ matches: ['http://127.0.0.1/*'] })
    const worker = compat(OPTIONAL_PROBE_FOLDER, 'background.js')
    for (const call of ['chrome.permissions.onAdded.addListener', 'chrome.permissions.onRemoved.addListener', 'chrome.permissions.request(message.what)', 'chrome.permissions.remove(message.what)', 'chrome.permissions.getAll()', 'chrome.bookmarks.getTree()', 'chrome.tabs.get(tabId)']) expect(worker, call).toContain(call)
    for (const type of ['ping', 'state', 'request', 'remove']) expect(worker).toContain(`message?.type === '${type}'`)
  })

  it('active-tab-scripting-probe: activeTab, scripting and storage, no host permission of any kind, and an icon without a popup', () => {
    const manifest = manifestOf(TAB_PROBE_FOLDER)
    expect(manifest['name']).toBe(TAB_PROBE)
    // The storage is what a script injected on demand reads and writes in the extension; it gives no access to a page.
    expect(manifest['permissions']).toEqual(['activeTab', 'scripting', 'storage'])
    // Any of these would give the access the click is meant to give, and the checks would pass without activeTab.
    for (const key of ['host_permissions', 'optional_host_permissions', 'content_scripts']) expect(manifest[key], key).toBeUndefined()
    // With a popup, a click opens the popup and action.onClicked is never sent.
    expect(manifest['action']).toEqual({ default_title: 'Active tab scripting probe' })
    expect(manifest['externally_connectable']).toEqual({ matches: ['http://127.0.0.1/*'] })
    const worker = compat(TAB_PROBE_FOLDER, 'background.js')
    expect(worker).toContain('chrome.action.onClicked.addListener')
    expect(worker).toContain('chrome.scripting.executeScript({ target: { tabId }, func: () => document.title })')
    // What the script injected in the isolated world is asked: the runtime, the storage, a message in each direction.
    expect(worker).toContain("world: 'ISOLATED'")
    for (const type of ['inject-runtime', 'tell', 'heard', 'stored']) expect(worker).toContain(`message?.type === '${type}'`)
    for (const call of ['chrome.runtime.sendMessage', 'chrome.storage.local.set', 'chrome.runtime.onMessage.addListener', 'chrome.tabs.sendMessage']) expect(worker, call).toContain(call)
  })
})

describe('the extension suite when a probe does not load', () => {
  const state = { activeSpaceId: 'home', spaces: [{ id: 'home', profileId: 'default' }], tabs: [], settings: {} }
  const contextWith = (loadExtension: (profileId: string, path: string) => Promise<unknown>): SmokeContext => ({ engine: { loadExtension }, store: { get: () => state }, browser: {} }) as unknown as SmokeContext

  it('each probe the engine refuses is a failed check that gives the folder and the reason, and the suite fails', async () => {
    const { smokeProbesExt, runProbesExtSmoke } = await import('./smoke-probes-ext')
    const asked: string[] = []
    const refuse = (profileId: string, path: string): Promise<never> => {
      asked.push(`${profileId} ${path}`)
      return Promise.reject(new Error('Manifest is not valid'))
    }
    beginLedger()
    const checks: CheckRecord[] = []
    await smokeProbesExt(contextWith(refuse), recorderOf(checks, () => {}))
    expect(asked).toEqual([`default ${join('/repo', 'compat', NET_PROBE_FOLDER)}`, `default ${join('/repo', 'compat', TAB_PROBE_FOLDER)}`, `default ${join('/repo', 'compat', OPTIONAL_PROBE_FOLDER)}`])
    expect(checks).toEqual([
      { name: `the probe extension "${NET_PROBE}" is loaded`, ok: false, detail: `${join('/repo', 'compat', NET_PROBE_FOLDER)}: Manifest is not valid` },
      { name: `the probe extension "${TAB_PROBE}" is loaded`, ok: false, detail: `${join('/repo', 'compat', TAB_PROBE_FOLDER)}: Manifest is not valid` },
      { name: `the probe extension "${OPTIONAL_PROBE}" is loaded`, ok: false, detail: `${join('/repo', 'compat', OPTIONAL_PROBE_FOLDER)}: Manifest is not valid` }
    ])
    const outcome = await runSuite('probes-ext', () => runProbesExtSmoke(contextWith(refuse)), 5000, () => {})
    expect(outcome.code).toBe(1)
    expect(outcome.tally).toEqual({ checks: 3, failed: 3, skipped: 0 })
  })

  it('a folder that loads another extension than the probe is a failed check too, and what it loaded is taken out of the profile again', async () => {
    const { smokeProbesExt } = await import('./smoke-probes-ext')
    beginLedger()
    const checks: CheckRecord[] = []
    const forgotten: string[] = []
    const wrong = (_profileId: string, path: string): Promise<unknown> => (path.endsWith(NET_PROBE_FOLDER) ? Promise.resolve({ id: 'a'.repeat(32), name: 'Another Extension' }) : Promise.reject(new Error('gone')))
    const context = { engine: { loadExtension: wrong, forgetExtensionFolder: (path: string) => forgotten.push(path) }, store: { get: () => state }, browser: {} } as unknown as SmokeContext
    await smokeProbesExt(context, recorderOf(checks, () => {}))
    expect(checks).toEqual([
      { name: `the probe extension "${NET_PROBE}" is loaded`, ok: false, detail: `${join('/repo', 'compat', NET_PROBE_FOLDER)} gave "Another Extension" (${'a'.repeat(32)})` },
      { name: `the probe extension "${TAB_PROBE}" is loaded`, ok: false, detail: `${join('/repo', 'compat', TAB_PROBE_FOLDER)}: gone` },
      { name: `the probe extension "${OPTIONAL_PROBE}" is loaded`, ok: false, detail: `${join('/repo', 'compat', OPTIONAL_PROBE_FOLDER)}: gone` }
    ])
    expect(forgotten).toEqual([join('/repo', 'compat', NET_PROBE_FOLDER)])
  })
})

// The checks written for corrections no engine had seen: each verdict, and what it says when the correction is gone (the observation the engine
// then gives), so that a check that would stay green without its correction is caught here.
describe('the checks of corrections no engine had seen', () => {
  describe('chrome.debugger: a drag that carries a file', () => {
    const page = 'https://a.example/'
    const drag = (data: unknown) => new DebuggerGuard('e'.repeat(32)).command('Input.dispatchDragEvent', { type: 'drop', x: 40, y: 40, data }, page)

    it('the drags the suite sends are those the policy judges: the one with a file refused, the drag of text let through', () => {
      expect(drag({ items: [], files: ['/tmp/lucium-drag-secret.txt'], dragOperationsMask: 1 })).toBe('Not allowed')
      expect(drag({ items: [{ mimeType: 'text/plain', data: DROP_WITNESS }], dragOperationsMask: 1 })).toBeNull()
      const key = new DebuggerGuard('e'.repeat(32)).command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 4, commands: ['paste'] }, page)
      expect(key).toBe('Not allowed')
    })

    it('is red when the page got a file (what it gets once the drag goes through), and when no drop came at all', () => {
      const witness = { files: [], text: DROP_WITNESS }
      expect(dropVerdict([witness])).toMatchObject({ ok: true })
      expect(dropVerdict([{ files: ['lucium-drag-secret.txt'], text: '' }, witness])).toMatchObject({ ok: false, detail: expect.stringContaining('with files') })
      expect(dropVerdict([])).toMatchObject({ ok: false, detail: expect.stringContaining('not measured') })
      expect(dropVerdict('the page did not answer')).toMatchObject({ ok: false })
    })

    it('the page watches every drop with its files and its text', () => {
      expect(DROP_WATCH).toContain("addEventListener('drop'")
      expect(DROP_WATCH).toContain('e.dataTransfer.files')
      expect(DROP_WATCH).toContain("getData('text/plain')")
    })
  })

  describe('the listeners of a worker', () => {
    /** Runs the worker of a written probe with stand-ins for what Chrome and the library give it, and answers what it registered. */
    const start = (code: string, electron?: unknown) => {
      const external: Array<(message: unknown, sender: unknown, reply: (answer: unknown) => void) => unknown> = []
      const changed: Array<(change: { cookie?: { name?: string }; removed?: boolean }) => void> = []
      runInNewContext(code, { chrome: { runtime: { onMessageExternal: { addListener: (fn: (typeof external)[number]) => external.push(fn) } }, cookies: { onChanged: { addListener: (fn: (typeof changed)[number]) => changed.push(fn) } } }, electron, Math })
      const ask = (message: unknown): unknown => {
        let answer: unknown
        external[0]?.(message, {}, (said) => (answer = said))
        return answer
      }
      return { ask, changed }
    }

    it('the owner holds `cookies` and the host of the server, and keeps the pages whose cookie it heard of; the spy holds nothing', () => {
      expect(LISTENER_OWNER.manifest['permissions']).toEqual(['cookies'])
      expect(LISTENER_OWNER.manifest['host_permissions']).toEqual(['http://127.0.0.1/*'])
      expect(LISTENER_SPY.manifest['permissions']).toBeUndefined()
      expect(LISTENER_OWNER.worker).toContain(`chrome.${LISTENED_EVENT}.addListener`)
      const owner = start(LISTENER_OWNER.worker)
      owner.changed[0]?.({ cookie: { name: 'lw-1' }, removed: false })
      owner.changed[0]?.({ cookie: { name: 'lw-1' }, removed: true })
      owner.changed[0]?.({ cookie: { name: 'other' }, removed: false })
      const heard = owner.ask({ type: 'heard' }) as { boot: string; heard: string[] }
      expect(heard.heard).toEqual([`${LISTENED_PATH}1`])
      expect((owner.ask({ type: 'ping' }) as { boot: string }).boot).toBe(heard.boot)
    })

    it('a page under the listened path sets the cookie the owner hears of, and no other page sets one', () => {
      expect(listenedCookieOf(`${LISTENED_PATH}2`)).toBe('lw-2=1; Path=/')
      for (const path of ['/probe-page', `${LISTENED_PATH}`, `${LISTENED_PATH}2/x`, `${LISTENED_PATH}two`]) expect(listenedCookieOf(path)).toBeNull()
    })

    it('listens to an event that no script of Lucium listens to in every worker: the spy\'s message would otherwise never leave its worker', () => {
      // The library sends the message of a listener once per event name and context (dist/chrome-extension-api.preload.js, addExtensionListener):
      // an event the preload of Lucium already listens to in the spy's worker would leave nothing for the main process to refuse.
      const heard: string[] = []
      const namespace = (name: string) => new Proxy({ query: async () => [] } as Record<string, unknown>, {
        get: (target, key) => (typeof key === 'string' && key.startsWith('on') ? { addListener: () => void heard.push(`${name}.${key}`) } : target[key as string])
      })
      const chrome = Object.freeze({ runtime: { id: 's'.repeat(32), onMessage: namespace('runtime').onMessage, onMessageExternal: namespace('runtime').onMessageExternal, onConnect: namespace('runtime').onConnect, onConnectExternal: namespace('runtime').onConnectExternal }, tabs: namespace('tabs'), cookies: namespace('cookies'), windows: namespace('windows') })
      const global = globalThis as { chrome?: unknown; __luciumSenderFixed?: boolean }
      global.chrome = chrome
      try {
        fixSenderTabs()
      } finally {
        delete global.chrome
        delete global.__luciumSenderFixed
      }
      expect(heard).toContain('tabs.onUpdated')
      expect(heard).not.toContain(LISTENED_EVENT)
    })

    it('the spy names the owner through the library, as the suite asks, and says so when the library is not there', () => {
      const sent: unknown[][] = []
      const electron = { addExtensionListener: (...args: unknown[]) => sent.push(['add', ...args]), removeExtensionListener: (...args: unknown[]) => sent.push(['remove', ...args]) }
      const spy = start(LISTENER_SPY.worker, electron)
      expect(spy.ask({ type: 'add', extensionId: 'o'.repeat(32), event: LISTENED_EVENT })).toEqual({ ok: true })
      expect(spy.ask({ type: 'remove', extensionId: 'o'.repeat(32), event: LISTENED_EVENT })).toEqual({ ok: true })
      expect(sent.map((call) => call.slice(0, 3))).toEqual([
        ['add', 'o'.repeat(32), LISTENED_EVENT],
        ['remove', 'o'.repeat(32), LISTENED_EVENT]
      ])
      // The same function both times: the library takes away the listener it was given.
      expect(sent[0]?.[3]).toBe(sent[1]?.[3])
      expect(start(LISTENER_SPY.worker).ask({ type: 'add', extensionId: 'o'.repeat(32), event: LISTENED_EVENT })).toEqual({ ok: false, error: 'the worker has no electron.addExtensionListener (electron is undefined)' })
    })

    it('is red when the owner no longer hears its own event (what the library does for the spy without the correction), and unmeasured when its worker started again', () => {
      const control = { boot: 'b1', heard: [`${LISTENED_PATH}1`] }
      expect(ownerKept(control, { boot: 'b1', heard: [`${LISTENED_PATH}1`, `${LISTENED_PATH}2`] }, `${LISTENED_PATH}2`)).toMatchObject({ ok: true })
      expect(ownerKept(control, { boot: 'b1', heard: [`${LISTENED_PATH}1`] }, `${LISTENED_PATH}2`)).toMatchObject({ ok: false, detail: expect.stringContaining('no longer hears') })
      expect(ownerKept(control, { boot: 'b2', heard: [`${LISTENED_PATH}2`] }, `${LISTENED_PATH}2`)).toMatchObject({ ok: false, detail: expect.stringContaining('started again') })
      expect(ownerKept(control, { error: 'no answer after 15000 ms' }, `${LISTENED_PATH}2`)).toMatchObject({ ok: false, detail: expect.stringContaining('did not answer') })
    })
  })

  describe('a request rule with several `*` on a long address', () => {
    const address = `http://127.0.0.1:65535${SLOW_ADDRESS_PATH}`

    it('the rule is read, filed under no word (so every request is judged by it), and does not cover the address, which the matcher of today settles in a few steps', () => {
      const rule = readNetRule(SLOW_FILTER_RULE) as ReadRule
      expect(typeof rule).toBe('object')
      expect(filterToken(rule.filter!)).toBeNull()
      const match = matchFilter(rule.filter!, address)
      expect(match).toMatchObject({ matched: false, exhausted: false })
      expect(match.steps).toBeLessThan(3 * address.length)
    })

    it('is red on a pause of the main process (the former matcher stood 4.7 s on this address), on a request that did not arrive, and on one that arrived twice', () => {
      const arrived = { body: 'arrived' }
      expect(pauseVerdict(25, 1, arrived)).toMatchObject({ ok: true })
      expect(pauseVerdict(4700, 1, arrived)).toMatchObject({ ok: false, detail: expect.stringContaining('4700 ms') })
      expect(pauseVerdict(LONGEST_PAUSE_MS, 1, arrived).ok).toBe(false)
      expect(pauseVerdict(25, 0, { body: null, error: 'no answer after 4 s' }).ok).toBe(false)
      expect(pauseVerdict(25, 2, arrived).ok).toBe(false)
    })
  })

  describe('a folder past the bound of a manifest', () => {
    it('the folder over the bound is the one every reader refuses, and the one at the bound is not', () => {
      expect(BOUND_SITES).toEqual({ over: 513, at: 512 })
      const over = boundProbe(BOUND_SITES.over).manifest
      const at = boundProbe(BOUND_SITES.at).manifest
      expect(over['name']).toBe(BOUND_PROBE)
      expect(manifestListsTooLong(over)).toBe(true)
      expect(manifestListsTooLong(at)).toBe(false)
      expect(checkManifestText(JSON.stringify(over))).toEqual({ ok: false, message: manifestTooLongMessage() })
      expect(checkManifestText(JSON.stringify(at))).toMatchObject({ ok: true })
    })

    it('the load of the engine refuses the first with the sentence the suite expects, before the engine is handed it, and hands it the second', async () => {
      const handed: string[] = []
      const how = (manifest: unknown) => ({ readManifest: () => manifest, load: async (folder: string) => void handed.push(folder) })
      await expect(loadChecked('/over', how(boundProbe(BOUND_SITES.over).manifest))).rejects.toThrow(manifestTooLongMessage())
      await loadChecked('/at', how(boundProbe(BOUND_SITES.at).manifest))
      expect(handed).toEqual(['/at'])
    })
  })

  describe('a shared worker of a local page', () => {
    const secret = 'CROSS-ORIGIN-SECRET'

    it('the guard stops a request that names neither frame nor page only when its origin is the one of a file: the engine check measures that origin', () => {
      const request = { url: 'http://127.0.0.1:1/shared-secret', resourceType: 'xhr', frameOrigin: null, topUrl: null, requestHeaders: {} }
      expect(localPageRead({ ...request, initiatorOrigin: 'file://' })).toBe(REFUSED_READ)
      // Any other origin is not judged: such a request leaves, and the check is red on the server that saw it.
      expect(localPageRead({ ...request, initiatorOrigin: 'null' })).toBeNull()
    })

    it('is red when the request reached the server or the worker read the secret, and unmeasured when no shared worker ran', () => {
      const refused = { origin: 'file://', read: 'refused:TypeError: Failed to fetch' }
      expect(sharedWorkerVerdict(refused, secret, 0)).toMatchObject({ ran: true, origin: 'file://', kept: { ok: true } })
      expect(sharedWorkerVerdict(refused, secret, 1).kept.ok).toBe(false)
      expect(sharedWorkerVerdict({ origin: 'file://', read: `read:${secret}` }, secret, 0).kept.ok).toBe(false)
      expect(sharedWorkerVerdict({ origin: 'null', read: `read:${secret}` }, secret, 1)).toMatchObject({ ran: true, origin: 'null', kept: { ok: false } })
      expect(sharedWorkerVerdict({ error: 'no shared worker: SecurityError' }, secret, 0)).toMatchObject({ ran: false, kept: { ok: false, detail: expect.stringContaining('not measured') } })
    })

    it('the page script names the address as a string and answers the origin of the worker', () => {
      const script = sharedWorkerScript('http://127.0.0.1:1/x"y')
      expect(script).toContain(`JSON.stringify(${JSON.stringify('http://127.0.0.1:1/x"y')})`)
      expect(script).toContain('self.origin')
      expect(script).toContain('new SharedWorker(URL.createObjectURL(')
    })
  })

  describe('the strict-transport hosts from one launch to the next', () => {
    it('reads the file the store writes: the host by its SHA-256, never by its name, and held again by a record that starts empty', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lucium-strict-kit-'))
      try {
        const session = { getStoragePath: () => dir }
        const hosts = new StrictTransportHosts()
        const store = new StrictTransportStore(hosts, 60_000)
        store.attach(session)
        hosts.note(session, 'https://strict.example/', 'max-age=600; includeSubDomains')
        store.flush(session)
        const text = readFileSync(join(dir, 'Strict Transport Hosts.json'), 'utf8')
        expect(strictHostsFile(text, 'strict.example')).toMatchObject({ held: true, inClear: false })
        expect(strictHostsFile(text, 'other.example').held).toBe(false)
        // The launch after: a record with nothing in it reads the file back.
        const next = new StrictTransportHosts()
        new StrictTransportStore(next, 60_000).attach(session)
        expect(next.isStrict(session, 'sub.strict.example')).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('is red with no file (what the run gave before the correction), and says why for a file that is not JSON', () => {
      expect(strictHostsFile(null, 'strict.example')).toEqual({ held: false, inClear: false, detail: 'there is no file' })
      const broken = strictHostsFile('{"version":1,"hosts":[', 'strict.example')
      expect(broken.held).toBe(false)
      expect(broken.detail).toMatch(/^the file is not JSON \(.+\): \{"version":1/)
      expect(strictHostsFile(JSON.stringify({ version: 1, hosts: [{ host: 'strict.example', until: 1, includeSubDomains: true }] }), 'strict.example')).toMatchObject({ held: false, inClear: true })
    })
  })

  describe('Ollama of the local network named by a .local name', () => {
    const hit = (local: string, host: string, path = '/api/tags', method = 'GET') => ({ method, path, host, local })

    it('passes a request that came to a private address of this Mac and names it as its Host', () => {
      expect(modelHitsVerdict([hit('::ffff:192.168.1.20', '192.168.1.20:4000')], 'GET', '/api/tags', 4000)).toMatchObject({ ok: true })
      expect(modelHitsVerdict([hit('fd12:3456::1', '[fd12:3456::1]:4000')], 'GET', '/api/tags', 4000)).toMatchObject({ ok: true })
    })

    it('is red when the name went to the network as it is (no resolution by the main process), when the loopback got it, and when nothing came', () => {
      expect(modelHitsVerdict([hit('::ffff:192.168.1.20', 'my-mac.local:4000')], 'GET', '/api/tags', 4000).ok).toBe(false)
      expect(modelHitsVerdict([hit('::ffff:127.0.0.1', '127.0.0.1:4000')], 'GET', '/api/tags', 4000).ok).toBe(false)
      expect(modelHitsVerdict([hit('::ffff:192.168.1.20', '192.168.1.20:4000', '/api/tags')], 'POST', '/api/generate', 4000)).toMatchObject({ ok: false, detail: expect.stringContaining('never got') })
    })

    it('writes an address as the resolver and URL do', () => {
      expect(plainAddress('::ffff:10.0.0.2')).toBe('10.0.0.2')
      expect(plainAddress('FD00::1')).toBe('fd00::1')
      expect(hostHeaderOf('10.0.0.2', 80)).toBe('10.0.0.2:80')
      expect(hostHeaderOf('fd00::1', 80)).toBe('[fd00::1]:80')
    })
  })
})

describe('the Client Hints measurement', () => {
  // What a Chromium sends to a page it trusts, as the headers of a Node request arrive (lower case, in the order they came).
  const CHROMIUM_BRANDS = '"Chromium";v="156", "Not)A;Brand";v="8"'
  const AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
  const plan = (headersOf: (phase: string, what: string) => Record<string, string>): SeenRequest[] =>
    HINT_PHASES.flatMap((phase) => HINT_WHATS.map((what) => ({ n: 0, phase, what, method: 'GET', host: 'localhost:1', headers: { host: 'localhost:1', 'user-agent': AGENT, ...headersOf(phase, what) } })))
      .map((request, index) => ({ ...request, n: index + 1 }))
  const READ: PageRead = { secure: true, userAgent: AGENT, legacyPlatform: 'MacIntel', present: 'object', brands: [{ brand: 'Chromium', version: '156' }, { brand: 'Not)A;Brand', version: '8' }], mobile: false, platform: 'macOS' }

  it('names each request of the plan by its path, and refuses every other path (the icon of the site, a stray request)', () => {
    for (const phase of HINT_PHASES) for (const what of HINT_WHATS) expect(hintRequestOf(hintPath(phase, what))).toEqual({ phase, what })
    expect(hintPath('ask', 'cross-img')).toBe('/ask/cross.gif')
    for (const path of ['/favicon.ico', '/', '/ask', '/ask/', '/other/page', '/ask/page/more', '/ask/unknown.gif']) expect(hintRequestOf(path), path).toBeNull()
  })

  it('asks for the four hints beyond the default ones, and only those, in the answer the page of the ask phase gets', () => {
    expect(ACCEPT_CH.split(', ')).toHaveLength(4)
    expect(ASKED_HINTS).toEqual(['sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version', 'sec-ch-ua-arch', 'sec-ch-ua-model'])
    expect(DEFAULT_HINTS.filter((name) => ASKED_HINTS.includes(name))).toEqual([])
    expect(HIGH_ENTROPY_HINTS).toContain('fullVersionList')
  })

  it('keeps the headers of a request as one string each, in the order they arrived, and a header that came twice joined', () => {
    const flat = flatHeaders({ host: 'a', 'x-twice': ['1', '2'], 'user-agent': undefined, accept: '*/*' })
    expect(flat).toEqual({ host: 'a', 'x-twice': '1, 2', accept: '*/*' })
    expect(Object.keys(flat)).toEqual(['host', 'x-twice', 'accept'])
  })

  it('takes the Client Hints of a request: the sec-ch-* headers, not sec-fetch-*, not sec-gpc', () => {
    expect(hintsOf({ host: 'a', 'sec-ch-ua': CHROMIUM_BRANDS, 'sec-ch-ua-mobile': '?0', 'sec-fetch-site': 'none', 'sec-gpc': '1' })).toEqual({ 'sec-ch-ua': CHROMIUM_BRANDS, 'sec-ch-ua-mobile': '?0' })
    expect(hintsOf({ host: 'a' })).toEqual({})
  })

  it('reads the brands of a Sec-CH-UA header by their quotes: a brand may hold a ; or a ), and a header may be absent or hold none', () => {
    expect(brandsOfHeader(CHROMIUM_BRANDS)).toEqual([{ brand: 'Chromium', version: '156' }, { brand: 'Not)A;Brand', version: '8' }])
    expect(brandsOfHeader('"Google Chrome";v="156", "Chromium";v="156"')?.map((entry) => entry.brand)).toEqual(['Google Chrome', 'Chromium'])
    expect(brandsOfHeader(undefined)).toBeNull()
    expect(brandsOfHeader('?0')).toEqual([])
  })

  it('says how the brands of the header and those of the page stand: the same list in any order, two lists, one of them only, or none', () => {
    const chromium = [{ brand: 'Chromium', version: '156' }]
    expect(brandRelation(chromium, [...chromium])).toBe('same')
    expect(brandRelation(brandsOfHeader(CHROMIUM_BRANDS), [{ brand: 'Not)A;Brand', version: '8' }, { brand: 'Chromium', version: '156' }])).toBe('same')
    expect(brandRelation(chromium, [{ brand: 'Chromium', version: '155' }])).toBe('different')
    expect(brandRelation(chromium, [{ brand: 'Google Chrome', version: '156' }, ...chromium])).toBe('different')
    expect(brandRelation(chromium, null)).toBe('header-only')
    expect(brandRelation(null, chromium)).toBe('page-only')
    expect(brandRelation(null, null)).toBe('neither')
    expect(brandRelation([], [])).toBe('neither')
  })

  it('a Chromium that sends nothing: every request of the plan seen, no hint sent, the user agent the page reads, and no verdict in the summary', () => {
    const summary = summarizeHints(plan(() => ({})), READ)
    expect(summary).toMatchObject({ seen: 12, missing: [], anyHintSent: false, askedToOtherSite: [], userAgentHeaders: [AGENT], userAgentOfPage: AGENT, userAgentAgrees: true, userAgentMajor: '156' })
    expect(summary.hintsSent['baseline/page']).toEqual([])
    expect(summary.brands).toEqual({ header: null, page: READ.brands, relation: 'page-only' })
    expect(summary.platform).toEqual({ header: null, page: 'macOS', legacy: 'MacIntel' })
    expect(summary.mobile).toEqual({ header: null, page: false })
    expect(summary.globalPrivacyControl).toBeNull()
  })

  it('a Chromium that sends the three default hints, and the four asked for once a page answered Accept-CH: where each one arrived', () => {
    const asked = Object.fromEntries(ASKED_HINTS.map((name) => [name, '"x"']))
    const summary = summarizeHints(
      plan((phase, what) => ({
        'sec-ch-ua': CHROMIUM_BRANDS,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        ...(phase !== 'baseline' && phase !== 'ask' && what !== 'cross-img' ? asked : {}),
        ...(phase === 'baseline' && what === 'page' ? { 'sec-gpc': '1' } : {})
      })),
      READ
    )
    expect(summary.anyHintSent).toBe(true)
    expect(summary.hintsSent['baseline/img']).toEqual(['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'])
    expect(summary.hintsSent['after/page']).toEqual(['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', ...ASKED_HINTS])
    expect(summary.askedArrived['ask/page']).toEqual([])
    expect(summary.askedArrived['after/script']).toEqual([...ASKED_HINTS])
    expect(Object.keys(summary.askedArrived)).not.toContain('baseline/page')
    expect(summary.askedToOtherSite).toEqual([])
    expect(summary.brands.relation).toBe('same')
    expect(summary.platform.header).toBe('"macOS"')
    expect(summary.mobile.header).toBe('?0')
    expect(summary.globalPrivacyControl).toBe('1')
  })

  it('flags a hint a site asked for that went to the other site, and a request of the plan the server never saw', () => {
    const leaked = plan((phase, what): Record<string, string> => (phase === 'after' && what === 'cross-img' ? { 'sec-ch-ua-arch': '"arm"', 'sec-ch-ua-model': '""' } : {}))
    expect(summarizeHints(leaked, READ).askedToOtherSite).toEqual(['after/cross-img: sec-ch-ua-arch, sec-ch-ua-model'])
    const short = summarizeHints(plan(() => ({})).filter((request) => !(request.phase === 'ask' && request.what === 'script')), READ)
    expect(short).toMatchObject({ seen: 11, missing: ['ask/script'] })
    expect(short.hintsSent).not.toHaveProperty('ask/script')
    expect(summarizeHints([], null)).toMatchObject({ seen: 0, anyHintSent: false, userAgentAgrees: null, userAgentOfPage: null, userAgentMajor: null, brands: { header: null, page: null, relation: 'neither' } })
  })

  it('a request whose User-Agent is not the one the page reads is a disagreement, and a page that read nothing is no answer', () => {
    const odd = plan((phase, what): Record<string, string> => (phase === 'ask' && what === 'img' ? { 'user-agent': 'Electron/45 Lucium/1.1.0' } : {}))
    expect(summarizeHints(odd, READ)).toMatchObject({ userAgentAgrees: false, userAgentHeaders: [AGENT, 'Electron/45 Lucium/1.1.0'] })
    expect(summarizeHints(plan(() => ({})), { error: 'the script of the page: no answer after 12000 ms' }).userAgentAgrees).toBeNull()
  })

  it('the script of the page reads the three low-entropy values and the high-entropy ones, each in a try of its own, and is code', () => {
    const script = clientHintsReadScript()
    expect(() => new Function(`return ${script}`)).not.toThrow()
    for (const wanted of ['navigator.userAgent', 'navigator.userAgentData', 'data.brands', 'data.mobile', 'data.platform', 'getHighEntropyValues', JSON.stringify(HIGH_ENTROPY_HINTS)]) expect(script, wanted).toContain(wanted)
    expect(script.match(/\btry\b/g)).toHaveLength(3)
  })

  describe('the verdict of the decision of 13 November', () => {
    // What Chromium 156 put on the image, the script and the image of the other site, and what the page read, measured that day.
    const MEASURED = { 'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"' }
    const PAGE: PageRead = { ...READ, brands: [{ brand: 'Not:A-Brand', version: '8' }, { brand: 'Chromium', version: '156' }] }
    const everywhere = plan(() => ({ ...MEASURED }))
    const asMeasured = plan((_phase, what): Record<string, string> => (what === 'page' ? {} : { ...MEASURED }))

    it('passes a window whose twelve requests carry the measured hints, the navigations included, in agreement with the page', () => {
      expect(judgeHints(everywhere, PAGE)).toEqual({ navigationsMissing: [], reference: MEASURED, differing: [], brandsAgree: true, platformAgrees: true, mobileAgrees: true, detailedSent: [], productBrands: [] })
    })

    it('fails the window measured before the decision: no hint on the three navigations', () => {
      const verdict = judgeHints(asMeasured, PAGE)
      expect(verdict.navigationsMissing).toEqual(['baseline/page: sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform', 'ask/page: sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform', 'after/page: sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform'])
      expect(verdict.differing).toEqual(['baseline/page', 'ask/page', 'after/page'])
      expect(verdict.brandsAgree).toBe(false)
    })

    it('fails navigations whose values are not those of the other requests, or whose brands the page reads otherwise', () => {
      const reordered = plan((_phase, what): Record<string, string> => (what === 'page' ? { ...MEASURED, 'sec-ch-ua': '"Chromium";v="156", "Not:A-Brand";v="8"' } : { ...MEASURED }))
      const verdict = judgeHints(reordered, PAGE)
      expect(verdict.navigationsMissing).toEqual([])
      expect(verdict.differing).toEqual(['baseline/page', 'ask/page', 'after/page'])
      // The same brands in another order are not what the page reads.
      expect(verdict.brandsAgree).toBe(false)
      const linux = plan((_phase, what): Record<string, string> => (what === 'page' ? { ...MEASURED, 'sec-ch-ua-platform': '"Linux"', 'sec-ch-ua-mobile': '?1' } : { ...MEASURED }))
      expect(judgeHints(linux, PAGE)).toMatchObject({ platformAgrees: false, mobileAgrees: false })
      // No reference to hold the others to when the image of the first page carried no hint.
      expect(judgeHints(plan((phase, what): Record<string, string> => (phase === 'baseline' && what === 'img' ? {} : { ...MEASURED })), PAGE)).toMatchObject({ reference: null, differing: expect.arrayContaining(['baseline/page', 'after/script']) })
    })

    it('fails a detailed hint that left, and a brand that names a product, in a header or in the page', () => {
      const detailed = plan((phase, what): Record<string, string> => ({ ...MEASURED, ...(phase === 'after' && what === 'page' ? { 'sec-ch-ua-arch': '"arm"' } : {}) }))
      expect(judgeHints(detailed, PAGE).detailedSent).toEqual(['after/page: sec-ch-ua-arch'])
      const branded = plan((_phase, what): Record<string, string> => ({ ...MEASURED, ...(what === 'page' ? { 'sec-ch-ua': '"Lucium";v="1", "Chromium";v="156"' } : {}) }))
      expect(judgeHints(branded, PAGE).productBrands).toEqual(['Lucium'])
      expect(judgeHints(everywhere, { ...PAGE, brands: [...PAGE.brands!, { brand: 'Google Chrome', version: '156' }] }).productBrands).toEqual(['Google Chrome'])
    })

    it('says nothing agrees when the page read nothing', () => {
      expect(judgeHints(everywhere, null)).toMatchObject({ brandsAgree: false, platformAgrees: false, mobileAgrees: false, navigationsMissing: [], differing: [] })
      expect(judgeHints([], null)).toMatchObject({ reference: null, navigationsMissing: [], differing: [] })
    })
  })

  it('writes everything as one line that starts with the tag, whatever the text holds', () => {
    const line = clientHintsLine({ measured: { note: 'a line\nbreak and a "quote"' }, failed: 0 })
    expect(line.startsWith(`${CLIENT_HINTS_TAG} {`)).toBe(true)
    expect(line).not.toMatch(/[\r\n]/)
    expect(JSON.parse(line.slice(CLIENT_HINTS_TAG.length + 1))).toEqual({ measured: { note: 'a line\nbreak and a "quote"' }, failed: 0 })
    expect(CLIENT_HINTS_TAG).toBe('LUCIUM_SMOKE_CLIENT_HINTS')
  })
})
