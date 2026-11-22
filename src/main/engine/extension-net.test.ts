// The request rules and the request listeners of the extensions of a profile (extension-net.ts), driven the way the hooks of a session drive
// them: an extension is loaded, registers rules and listeners, and requests are judged and reported. The same in a real Electron: `smokeProbesExt`.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLanguage } from '@shared/i18n'
import { BLOCKING_WAIT_MS, PENDING_ASKS_MAX, SLOW_PAUSE_MS, SLOW_STRIKES } from '@shared/web-request-blocking'
import { authChallenge, eventDetails, ExtensionNet, insideFolder, NET_LIMITS, ruleGivenUpNote, type ExtensionNetHost, type HookRequest, type WebRequestEvent } from './extension-net'

interface Sent {
  extensionId: string
  event: WebRequestEvent
  details: Record<string, unknown>
  wake: boolean
  contexts?: readonly string[]
  ask?: string
}

function world(files: Record<string, unknown> = {}) {
  const saved = new Map<string, string>()
  const warnings: string[] = []
  const sent: Sent[] = []
  let changes = 0
  const givenUp: Array<{ extensionId: string; ruleId: number; why: string; addressLength: number; limit: number }> = []
  const host: ExtensionNetHost = {
    readRuleset: async (path) => {
      if (!(path in files)) throw new Error(`no such file: ${path}`)
      return files[path]
    },
    saved: (id) => saved.get(id),
    save: (id, value) => void (value === undefined ? saved.delete(id) : saved.set(id, value)),
    siteOf: (address) => (URL.canParse(address) ? new URL(address).hostname.split('.').slice(-2).join('.') : null),
    changed: () => void changes++,
    send: (extensionId, event, details, wake, contexts, ask) => void sent.push({ extensionId, event, details, wake, contexts, ...(ask !== undefined ? { ask } : {}) }),
    warn: (message) => void warnings.push(message),
    ruleGivenUp: (extensionId, ruleId, why, addressLength, limit) => void givenUp.push({ extensionId, ruleId, why, addressLength, limit })
  }
  return { net: new ExtensionNet(host), host, saved, warnings, sent, givenUp, changes: () => changes }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const manifest = (more: Record<string, unknown> = {}) => ({ manifest_version: 3, permissions: ['declarativeNetRequest', 'webRequest'], host_permissions: ['<all_urls>'], ...more })

const request = (url: string, more: Partial<HookRequest> = {}): HookRequest => ({ id: 1, url, method: 'GET', type: 'script', initiator: 'https://page.example', tabId: 4, documents: [{ url: 'https://page.example/', top: true }], frameId: 0, parentFrameId: -1, timeStamp: 1, ...more })

const block = (id: number, urlFilter: string, more: Record<string, unknown> = {}) => ({ id, action: { type: 'block' }, condition: { urlFilter }, ...more })

describe('the static rulesets of an extension', () => {
  const declared = { declarative_net_request: { rule_resources: [{ id: 'main', enabled: true, path: 'rules/main.json' }, { id: 'extra', enabled: false, path: 'rules/extra.json' }] } }
  const files = { '/ext/a/rules/main.json': [block(1, '/static-main/')], '/ext/a/rules/extra.json': [block(1, '/static-extra/'), block(2, '/static-extra-two/')] }

  it('the ones the manifest enables are read from its folder and applied; the others are not', async () => {
    const { net } = world(files)
    net.add('a', '/ext/a', manifest(declared))
    expect(net.enabledRulesets('a')).toEqual(['main'])
    await settle()
    expect(net.beforeRequest(request('https://x.example/static-main/a.js'))).toEqual({ action: 'block' })
    expect(net.beforeRequest(request('https://x.example/static-extra/a.js'))).toEqual({ action: 'none' })
    expect(net.needs().rules).toBe(true)
  })

  it('a ruleset the extension enables is applied, and stays enabled the next time the extension is loaded', async () => {
    const first = world(files)
    first.net.add('a', '/ext/a', manifest(declared))
    first.net.updateEnabledRulesets('a', { enableRulesetIds: ['extra'], disableRulesetIds: ['main'] })
    await settle()
    expect(first.net.beforeRequest(request('https://x.example/static-extra/a.js'))).toEqual({ action: 'block' })
    expect(first.net.beforeRequest(request('https://x.example/static-main/a.js'))).toEqual({ action: 'none' })
    expect(first.net.availableStaticRuleCount('a')).toBe(NET_LIMITS.staticRules - 2)
    // Loaded again (the browser restarted): what it chose holds, not what its manifest says.
    first.net.remove('a')
    first.net.add('a', '/ext/a', manifest(declared))
    expect(first.net.enabledRulesets('a')).toEqual(['extra'])
  })

  it('refuses a ruleset the manifest does not declare, in the words of the platform', () => {
    const { net } = world(files)
    net.add('a', '/ext/a', manifest(declared))
    expect(() => net.updateEnabledRulesets('a', { enableRulesetIds: ['ghost'] })).toThrow('Invalid ruleset id: ghost.')
    expect(() => net.updateStaticRules('a', { rulesetId: 'ghost', disableRuleIds: [1] })).toThrow('Invalid ruleset id: ghost.')
    expect(net.enabledRulesets('a')).toEqual(['main'])
  })

  it('a rule the extension switches off in a ruleset is no longer applied, and is listed', async () => {
    const { net } = world(files)
    net.add('a', '/ext/a', manifest(declared))
    net.updateEnabledRulesets('a', { enableRulesetIds: ['extra'] })
    await settle()
    net.updateStaticRules('a', { rulesetId: 'extra', disableRuleIds: [1] })
    await settle()
    expect(net.disabledRuleIds('a', { rulesetId: 'extra' })).toEqual([1])
    expect(net.beforeRequest(request('https://x.example/static-extra/a.js'))).toEqual({ action: 'none' })
    expect(net.beforeRequest(request('https://x.example/static-extra-two/a.js'))).toEqual({ action: 'block' })
  })

  it('holds no more switched-off rules than the platform allows, all rulesets of the extension together', () => {
    const { net } = world(files)
    net.add('a', '/ext/a', manifest(declared))
    net.updateStaticRules('a', { rulesetId: 'main', disableRuleIds: Array.from({ length: NET_LIMITS.disabledRules - 1 }, (_unused, index) => index + 1) })
    net.updateStaticRules('a', { rulesetId: 'extra', disableRuleIds: [1] })
    expect(() => net.updateStaticRules('a', { rulesetId: 'extra', disableRuleIds: [2] })).toThrow('exceeds the disabled rule count limit')
    expect(net.disabledRuleIds('a', { rulesetId: 'extra' })).toEqual([1])
  })

  it('a ruleset whose file is outside the folder of the extension is left out, with a word in the journal', () => {
    const { net, warnings } = world()
    net.add('a', '/ext/a', manifest({ declarative_net_request: { rule_resources: [{ id: 'out', enabled: true, path: '../b/rules.json' }] } }))
    expect(net.enabledRulesets('a')).toEqual([])
    expect(warnings.join('\n')).toContain('outside its folder')
  })

  it('a ruleset that cannot be read applies nothing, with a word in the journal', async () => {
    const { net, warnings } = world()
    net.add('a', '/ext/a', manifest(declared))
    await settle()
    expect(net.needs().rules).toBe(false)
    expect(warnings.join('\n')).toContain('the ruleset "main" of a cannot be read')
  })

  it('what was kept of its choices and cannot be read gives the word back to its manifest, with a word in the journal', () => {
    const { net, saved, warnings } = world(files)
    saved.set('a', '{"enabled": "everything"}')
    net.add('a', '/ext/a', manifest(declared))
    expect(net.enabledRulesets('a')).toEqual(['main'])
    expect(warnings.join('\n')).toContain('cannot be read')
  })

  it('an uninstalled extension leaves nothing of its choices behind', () => {
    const { net, saved } = world(files)
    net.add('a', '/ext/a', manifest(declared))
    net.updateEnabledRulesets('a', { enableRulesetIds: ['extra'] })
    expect(saved.has('a')).toBe(true)
    net.forget('a')
    expect(saved.has('a')).toBe(false)
    expect(net.has('a')).toBe(false)
  })

  it('an extension without the permission of the rules has no ruleset read', () => {
    const { net } = world(files)
    net.add('a', '/ext/a', { ...manifest(declared), permissions: ['storage'] })
    expect(net.enabledRulesets('a')).toEqual([])
  })
})

describe('the dynamic and session rules of an extension', () => {
  it('are applied once the extension hands over its copy, and replaced by the next copy', () => {
    const { net, changes } = world()
    net.add('a', '/ext/a', manifest())
    expect(net.needs().rules).toBe(false)
    net.mirror('a', { session: [block(1, '/session/')], dynamic: [block(2, '/dynamic/')] })
    expect(changes()).toBe(1)
    expect(net.beforeRequest(request('https://x.example/session/a'))).toEqual({ action: 'block' })
    expect(net.beforeRequest(request('https://x.example/dynamic/a'))).toEqual({ action: 'block' })
    net.mirror('a', { session: [], dynamic: [] })
    expect(net.beforeRequest(request('https://x.example/session/a'))).toEqual({ action: 'none' })
    expect(changes()).toBe(2)
  })

  it('a dynamic rule that names tabs is left out: only a session rule may', () => {
    const { net } = world()
    net.add('a', '/ext/a', manifest())
    net.mirror('a', { session: [block(1, '/s/', { condition: { urlFilter: '/s/', tabIds: [4] } })], dynamic: [block(2, '/d/', { condition: { urlFilter: '/d/', tabIds: [4] } })] })
    expect(net.beforeRequest(request('https://x.example/s/a'))).toEqual({ action: 'block' })
    expect(net.beforeRequest(request('https://x.example/d/a'))).toEqual({ action: 'none' })
  })

  it('holds no more session rules than the platform allows', () => {
    const { net } = world()
    net.add('a', '/ext/a', manifest())
    net.mirror('a', { session: Array.from({ length: NET_LIMITS.sessionRules + 1 }, (_unused, index) => block(index + 1, `/rule-${index + 1}/`)), dynamic: [] })
    expect(net.beforeRequest(request(`https://x.example/rule-${NET_LIMITS.sessionRules}/`))).toEqual({ action: 'block' })
    expect(net.beforeRequest(request(`https://x.example/rule-${NET_LIMITS.sessionRules + 1}/`))).toEqual({ action: 'none' })
  })

  it('says in the journal that rules with a condition on the headers of the answer are left out', () => {
    const { net, warnings } = world()
    net.add('a', '/ext/a', manifest())
    net.mirror('a', { session: [{ id: 1, action: { type: 'block' }, condition: { responseHeaders: [{ header: 'x' }] } }], dynamic: [] })
    expect(warnings.join('\n')).toContain('1 rule(s) of a use a condition on the headers of the answer')
  })

  it('says in the journal which rules are left out for a regular expression that could take forever, and applies the others', async () => {
    const slow = (id: number) => ({ id, action: { type: 'block' }, condition: { regexFilter: '^https://x\\.example/(a+)+$' } })
    const declared = { declarative_net_request: { rule_resources: [{ id: 'main', enabled: true, path: 'rules/main.json' }] } }
    const { net, warnings } = world({ '/ext/a/rules/main.json': [slow(31), block(32, '/static/')] })
    net.add('a', '/ext/a', manifest(declared))
    await settle()
    // The static ruleset: said when it is read.
    expect(warnings).toEqual(['1 rule(s) of a are left out: their regular expression could take forever on some addresses (a repetition inside a repetition, a look-around, a back-reference, or too many repetitions one after the other); rule ids: 31'])
    net.mirror('a', { session: [slow(7), block(8, '/kept/'), ...Array.from({ length: 9 }, (_unused, index) => slow(100 + index))], dynamic: [slow(9)] })
    expect(warnings.slice(1)).toEqual([
      '10 rule(s) of a are left out: their regular expression could take forever on some addresses (a repetition inside a repetition, a look-around, a back-reference, or too many repetitions one after the other); rule ids: 7, 100, 101, 102, 103, 104, 105, 106…',
      '1 rule(s) of a are left out: their regular expression could take forever on some addresses (a repetition inside a repetition, a look-around, a back-reference, or too many repetitions one after the other); rule ids: 9'
    ])
    // The address made for the expression is answered at once: the rule is not there to run.
    const started = performance.now()
    expect(net.beforeRequest(request(`https://x.example/${'a'.repeat(28)}!`))).toEqual({ action: 'none' })
    expect(performance.now() - started).toBeLessThan(250)
    expect(net.beforeRequest(request('https://x.example/kept/a.js'))).toEqual({ action: 'block' })
    expect(net.beforeRequest(request('https://x.example/static/a.js'))).toEqual({ action: 'block' })
  })

  it('refuses the copy of an extension that is not loaded in the profile', () => {
    const { net } = world()
    expect(() => net.mirror('ghost', { session: [], dynamic: [] })).toThrow('not loaded')
  })
})

describe('a request and the rules of several extensions', () => {
  it('a block of one extension wins over the redirect of another', () => {
    const { net } = world()
    net.add('a', '/ext/a', manifest())
    net.add('b', '/ext/b', manifest())
    net.mirror('a', { session: [{ id: 1, action: { type: 'redirect', redirect: { url: 'https://elsewhere.example/' } }, condition: { urlFilter: '/both/' } }], dynamic: [] })
    expect(net.beforeRequest(request('https://x.example/both/'))).toEqual({ action: 'redirect', url: 'https://elsewhere.example/' })
    net.mirror('b', { session: [block(1, '/both/')], dynamic: [] })
    expect(net.beforeRequest(request('https://x.example/both/'))).toEqual({ action: 'block' })
  })

  it('the rules of an extension never touch a request of another extension, and do touch its own', () => {
    const { net } = world()
    net.add('a', '/ext/a', manifest())
    net.mirror('a', { session: [block(1, '/api/')], dynamic: [] })
    expect(net.beforeRequest(request('https://x.example/api/', { initiator: 'chrome-extension://b', documents: [] }))).toEqual({ action: 'none' })
    expect(net.beforeRequest(request('https://x.example/api/', { initiator: 'chrome-extension://a', documents: [] }))).toEqual({ action: 'block' })
  })

  it('only the web is judged: not a local file, not a page of the browser', () => {
    const { net } = world()
    net.add('a', '/ext/a', manifest())
    net.mirror('a', { session: [{ id: 1, action: { type: 'block' }, condition: { resourceTypes: ['script', 'main_frame'] } }], dynamic: [] })
    expect(net.beforeRequest(request('https://x.example/a.js'))).toEqual({ action: 'block' })
    expect(net.beforeRequest(request('wss://x.example/socket', { type: 'script' }))).toEqual({ action: 'block' })
    expect(net.beforeRequest(request('file:///Users/me/a.js'))).toEqual({ action: 'none' })
    expect(net.beforeRequest(request('chrome-extension://a/a.js'))).toEqual({ action: 'none' })
  })

  it('an allowAllRequests rule on a document the request sits in lets it through a block rule', () => {
    const { net } = world()
    net.add('a', '/ext/a', manifest())
    net.mirror('a', { session: [block(1, '/asset'), { id: 2, priority: 2, action: { type: 'allowAllRequests' }, condition: { urlFilter: '/trusted-frame', resourceTypes: ['sub_frame'] } }], dynamic: [] })
    const inFrame = [{ url: 'https://x.example/trusted-frame', top: false }, { url: 'https://page.example/', top: true }]
    expect(net.beforeRequest(request('https://x.example/asset', { documents: inFrame }))).toEqual({ action: 'none' })
    expect(net.beforeRequest(request('https://x.example/asset'))).toEqual({ action: 'block' })
    // The rule is about frames: the same address as the top document of the tab is not covered.
    expect(net.beforeRequest(request('https://x.example/asset', { documents: [{ url: 'https://x.example/trusted-frame', top: true }] }))).toEqual({ action: 'block' })
  })

  it('header rules rewrite the headers of the request and of the answer, and the session is told which hooks they need', () => {
    const { net } = world()
    net.add('a', '/ext/a', manifest())
    net.mirror('a', { session: [{ id: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-probe', operation: 'set', value: '1' }], responseHeaders: [{ header: 'x-answer', operation: 'set', value: '2' }] }, condition: { urlFilter: '/headers' } }], dynamic: [] })
    expect(net.needs()).toMatchObject({ rules: true, requestHeaders: true, responseHeaders: true })
    expect(net.headers(request('https://x.example/headers'), { Accept: '*/*' }, 'request')).toEqual({ Accept: '*/*', 'x-probe': '1' })
    expect(net.headers(request('https://x.example/headers'), { 'Content-Type': ['text/plain'] }, 'response')).toEqual({ 'Content-Type': ['text/plain'], 'x-answer': ['2'] })
    const untouched = { Accept: '*/*' }
    expect(net.headers(request('https://x.example/other'), untouched, 'request')).toBe(untouched)
  })

  it('an extension that leaves the profile takes its rules with it', () => {
    const { net } = world()
    net.add('a', '/ext/a', manifest())
    net.mirror('a', { session: [block(1, '/session/')], dynamic: [] })
    net.remove('a')
    expect(net.beforeRequest(request('https://x.example/session/a'))).toEqual({ action: 'none' })
    expect(net.needs().rules).toBe(false)
  })
})

describe('the listeners of chrome.webRequest', () => {
  const listening = (hosts: string[] = ['<all_urls>']) => {
    const made = world()
    made.net.add('a', '/ext/a', manifest({ host_permissions: hosts }))
    return made
  }

  it('an extension hears the requests its filter covers, and the session is told which events are listened to', () => {
    const { net, sent, changes } = listening()
    net.listen('a', 'worker:1', 'onCompleted', { urls: ['https://x.example/*'], types: ['script'] }, [], true)
    expect([...net.needs().events]).toEqual(['onCompleted'])
    expect(changes()).toBe(1)
    net.heard('onCompleted', request('https://x.example/a.js'), { statusCode: 200 })
    net.heard('onCompleted', request('https://other.example/a.js'))
    net.heard('onCompleted', request('https://x.example/a.png', { type: 'image' }))
    net.heard('onBeforeRequest', request('https://x.example/a.js'))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ extensionId: 'a', event: 'onCompleted', wake: false, details: { requestId: '1', url: 'https://x.example/a.js', type: 'script', tabId: 4, statusCode: 200, initiator: 'https://page.example' } })
  })

  it('hands over the body of an upload to a listener of onBeforeRequest that asked for requestBody, and to no other', () => {
    const { net, sent } = listening(['https://x.example/*'])
    net.listen('a', 'worker:1', 'onBeforeRequest', { urls: ['<all_urls>'] }, ['requestBody'], true)
    net.listen('a', 'worker:2', 'onBeforeRequest', { urls: ['<all_urls>'] }, [], true)
    const posted = request('https://x.example/a', { method: 'POST', initiator: 'https://x.example', upload: [{ bytes: new TextEncoder().encode('hi') }] })
    net.heard('onBeforeRequest', posted)
    expect(sent).toHaveLength(1)
    const body = sent[0]!.details['requestBody'] as { raw: Array<{ bytes: ArrayBuffer }> }
    expect(new TextDecoder().decode(body.raw[0]!.bytes)).toBe('hi')
    // The same details go to the contexts of the extension: the shims of each strip what its listeners did not ask for (src/preload/extension-shims.ts).
    net.heard('onCompleted', posted)
    expect(sent.slice(1).every((each) => each.details['requestBody'] === undefined)).toBe(true)
  })

  it('tells nothing of a body to an extension none of whose listeners asked for it', () => {
    const { net, sent } = listening(['https://x.example/*'])
    net.listen('a', 'worker:1', 'onBeforeRequest', { urls: ['<all_urls>'] }, [], true)
    net.heard('onBeforeRequest', request('https://x.example/a', { method: 'POST', initiator: 'https://x.example', upload: [{ bytes: new TextEncoder().encode('hi') }] }))
    expect(sent[0]!.details).not.toHaveProperty('requestBody')
  })

  it('never hears a request to a site it has no host access to, nor one made by a page it has no access to, nor one of another extension', () => {
    const { net, sent } = listening(['https://x.example/*'])
    net.listen('a', 'worker:1', 'onBeforeRequest', { urls: ['<all_urls>'] }, [], true)
    net.heard('onBeforeRequest', request('https://secret.example/a.js'))
    net.heard('onBeforeRequest', request('https://secret.example/a.js', { initiator: 'https://x.example' }))
    net.heard('onBeforeRequest', request('https://x.example/a.js'))
    net.heard('onBeforeRequest', request('https://x.example/a.js', { initiator: 'chrome-extension://b' }))
    expect(sent).toHaveLength(0)
    net.heard('onBeforeRequest', request('https://x.example/a.js', { initiator: 'https://x.example' }))
    net.heard('onBeforeRequest', request('https://x.example/', { type: 'main_frame', initiator: 'https://page.example' }))
    expect(sent.map((each) => each.details['url'])).toEqual(['https://x.example/a.js', 'https://x.example/'])
  })

  it('hands the headers only when a listener asked for them', () => {
    const { net, sent } = listening()
    net.listen('a', 'worker:1', 'onBeforeSendHeaders', { urls: ['<all_urls>'] }, [], true)
    net.heard('onBeforeSendHeaders', request('https://x.example/a.js'), { requestHeaders: { Cookie: 'a=1' } })
    expect(sent[0]?.details).not.toHaveProperty('requestHeaders')
    net.listen('a', 'worker:1', 'onBeforeSendHeaders', { urls: ['<all_urls>'] }, ['requestHeaders'], false)
    net.heard('onBeforeSendHeaders', request('https://x.example/a.js'), { requestHeaders: { Cookie: 'a=1' } })
    expect(sent[1]?.details['requestHeaders']).toEqual([{ name: 'Cookie', value: 'a=1' }])
  })

  it('a worker that stopped is started again by a request its listeners covered, and its new listeners replace the old ones', () => {
    const { net, sent } = listening()
    net.listen('a', 'worker:1', 'onCompleted', { urls: ['https://x.example/*'] }, [], true)
    net.contextGone('worker:1')
    expect([...net.needs().events]).toEqual(['onCompleted'])
    net.heard('onCompleted', request('https://other.example/a.js'))
    expect(sent).toHaveLength(0)
    net.heard('onCompleted', request('https://x.example/a.js'))
    expect(sent).toMatchObject([{ extensionId: 'a', event: 'onCompleted', wake: true }])
    // The worker runs again and registers a listener on another event: the listeners of its past life are gone.
    net.listen('a', 'worker:2', 'onErrorOccurred', { urls: ['<all_urls>'] }, [], true)
    expect([...net.needs().events]).toEqual(['onErrorOccurred'])
  })

  it('a blocking listener of a Manifest V3 extension is taken and told only, and the journal says once for the extension that what it answers is not applied', () => {
    const { net, sent, warnings } = listening()
    net.listen('a', 'worker:1', 'onCompleted', { urls: ['<all_urls>'] }, ['responseHeaders'], true)
    expect(warnings).toEqual([])
    net.listen('a', 'worker:1', 'onBeforeRequest', { urls: ['<all_urls>'] }, ['blocking'], false)
    net.listen('a', 'worker:1', 'onHeadersReceived', { urls: ['<all_urls>'] }, ['asyncBlocking', 'responseHeaders'], false)
    // The worker starts again and registers them anew: the journal is not told a second time.
    net.listen('a', 'worker:2', 'onBeforeRequest', { urls: ['<all_urls>'] }, ['blocking'], true)
    expect(warnings).toEqual(['a put a blocking listener on chrome.webRequest.onBeforeRequest: it is told about the requests, and what it answers is not applied (only a Manifest V2 extension that holds webRequestBlocking may answer)'])
    // It hears the request all the same, and the request does not wait for it.
    expect(net.blockBeforeRequest(request('https://x.example/a.js'))).toBeNull()
    expect(sent).toMatchObject([{ extensionId: 'a', event: 'onBeforeRequest', wake: false }])
    expect(sent[0]).not.toHaveProperty('ask')
  })

  it('a page of an extension that ends takes its listeners with it', () => {
    const { net, sent } = listening()
    net.listen('a', 'frame:9', 'onCompleted', { urls: ['<all_urls>'] }, [], true)
    net.contextGone('frame:9')
    net.heard('onCompleted', request('https://x.example/a.js'))
    expect(sent).toHaveLength(0)
    expect(net.needs().events.size).toBe(0)
  })

  it('refuses an event that does not exist, a filter without addresses, and more listeners than a context may hold', () => {
    const { net } = listening()
    expect(() => net.listen('a', 'worker:1', 'onEverything', { urls: ['<all_urls>'] }, [], true)).toThrow('no event')
    expect(() => net.listen('a', 'worker:1', 'onCompleted', {}, [], true)).toThrow("needs 'urls'")
    for (let index = 0; index < NET_LIMITS.listenersPerContext; index++) net.listen('a', 'worker:1', 'onCompleted', { urls: ['<all_urls>'] }, [], false)
    expect(() => net.listen('a', 'worker:1', 'onCompleted', { urls: ['<all_urls>'] }, [], false)).toThrow('Too many')
  })
})

describe('the blocking listeners of a Manifest V2 extension', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const classic = (hosts: string[] = ['<all_urls>']) => ({ manifest_version: 2, permissions: ['webRequest', 'webRequestBlocking', ...hosts] })

  /** A profile with a Manifest V2 extension `a` whose background page listens with a blocking listener. */
  const blocking = (event: WebRequestEvent = 'onBeforeRequest', urls = ['<all_urls>'], hosts?: string[]) => {
    const made = world()
    made.net.add('a', '/ext/a', classic(hosts))
    made.net.listen('a', 'frame:5', event, { urls }, ['blocking'], true)
    return made
  }

  it('a request no blocking listener covers is told only, and nothing waits for it', () => {
    const { net, sent, warnings } = blocking('onBeforeRequest', ['https://ads.example/*'])
    net.listen('a', 'frame:5', 'onBeforeRequest', { urls: ['<all_urls>'] }, [], false)
    expect(net.blockBeforeRequest(request('https://x.example/a.js'))).toBeNull()
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toHaveProperty('ask')
    // A Manifest V2 extension that may block is not warned about it.
    expect(warnings).toEqual([])
  })

  it('the context whose blocking listener covers the request is asked, and its cancel is applied once it answered', async () => {
    const { net, sent } = blocking()
    const asked = net.blockBeforeRequest(request('https://x.example/a.js'))
    expect(asked).not.toBeNull()
    expect(sent).toMatchObject([{ extensionId: 'a', event: 'onBeforeRequest', contexts: ['frame:5'] }])
    const token = sent[0]?.ask
    expect(typeof token).toBe('string')
    net.answer('a', 'frame:5', token, [{ cancel: true }])
    expect(await asked).toMatchObject({ cancel: true })
  })

  it('a redirect of the listener is applied; one to a local file is not, and the journal says why once', async () => {
    const { net, sent, warnings } = blocking()
    const first = net.blockBeforeRequest(request('https://x.example/a.js'))!
    net.answer('a', 'frame:5', sent[0]?.ask, [{ redirectUrl: 'https://cdn.example/b.js' }])
    expect(await first).toMatchObject({ cancel: false, redirectUrl: 'https://cdn.example/b.js' })
    for (const at of [1, 2]) {
      const refused = net.blockBeforeRequest(request('https://x.example/a.js'))!
      net.answer('a', 'frame:5', sent[at]?.ask, [{ redirectUrl: 'file:///etc/passwd' }])
      expect(await refused).toMatchObject({ cancel: false, redirectUrl: null })
    }
    expect(warnings.filter((line) => line.includes('is not applied'))).toEqual(['an answer of a to chrome.webRequest.onBeforeRequest is not applied: it redirects to an address a listener may not send a request to (only the web, and the files of the extension from onBeforeRequest)'])
  })

  it('a listener that does not answer in time: the request goes on without it, the journal says so, and after a few times it is not waited for', async () => {
    vi.useFakeTimers()
    const { net, sent, warnings } = blocking()
    for (let strike = 1; strike <= SLOW_STRIKES; strike++) {
      const asked = net.blockBeforeRequest(request('https://x.example/a.js'))
      expect(asked).not.toBeNull()
      await vi.advanceTimersByTimeAsync(BLOCKING_WAIT_MS - 1)
      let settled = false
      void asked!.then(() => void (settled = true))
      await Promise.resolve()
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await asked).toEqual({ cancel: false, redirectUrl: null, ignored: [] })
    }
    expect(warnings).toEqual([
      ...Array.from({ length: SLOW_STRIKES - 1 }, () => `a did not answer chrome.webRequest.onBeforeRequest within ${BLOCKING_WAIT_MS} ms: the request went on without its answer`),
      `a did not answer chrome.webRequest.onBeforeRequest within ${BLOCKING_WAIT_MS} ms ${SLOW_STRIKES} times in a row: its blocking listeners are told without being waited for during ${SLOW_PAUSE_MS / 1000} s`
    ])
    // Paused: told, not asked.
    const told = sent.length
    expect(net.blockBeforeRequest(request('https://x.example/a.js'))).toBeNull()
    expect(sent[told]).not.toHaveProperty('ask')
    // An answer that comes after the time changes nothing.
    net.answer('a', 'frame:5', sent[0]?.ask, [{ cancel: true }])
    await vi.advanceTimersByTimeAsync(SLOW_PAUSE_MS)
    expect(net.blockBeforeRequest(request('https://x.example/a.js'))).not.toBeNull()
  })

  it('only the context asked, of the extension asked, is heard: another context, another extension, another token change nothing', async () => {
    vi.useFakeTimers()
    const { net, sent } = blocking()
    net.add('b', '/ext/b', classic())
    const asked = net.blockBeforeRequest(request('https://x.example/a.js'))!
    const token = sent[0]?.ask
    net.answer('a', 'frame:6', token, [{ cancel: true }])
    net.answer('b', 'frame:5', token, [{ cancel: true }])
    net.answer('a', 'frame:5', 'another', [{ cancel: true }])
    net.answer('a', 'frame:5', 7, [{ cancel: true }])
    net.answer('a', 'frame:5', token, [{}])
    expect(await asked).toMatchObject({ cancel: false })
  })

  /** Whether a promise has settled, the clock standing still. */
  const settledNow = async (promise: Promise<unknown>): Promise<boolean> => {
    let settled = false
    void promise.then(() => void (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    return settled
  }

  it('a page of the extension that ends while it is asked: the request goes on at once, not at the end of its time', async () => {
    vi.useFakeTimers()
    const { net } = blocking()
    const asked = net.blockBeforeRequest(request('https://x.example/a.js'))!
    expect(await settledNow(asked)).toBe(false)
    net.contextGone('frame:5')
    expect(await settledNow(asked)).toBe(true)
    expect(await asked).toMatchObject({ cancel: false, redirectUrl: null })
  })

  it('an extension that leaves the profile while it is asked: the request goes on at once, not at the end of its time', async () => {
    vi.useFakeTimers()
    const { net } = blocking()
    const asked = net.blockBeforeRequest(request('https://x.example/a.js'))!
    net.remove('a')
    expect(await settledNow(asked)).toBe(true)
    expect(await asked).toMatchObject({ cancel: false, redirectUrl: null })
  })

  it('never asked about a request to a site it cannot reach, nor about one of a page it cannot read', () => {
    const { net, sent } = blocking('onBeforeRequest', ['<all_urls>'], ['https://x.example/*'])
    expect(net.blockBeforeRequest(request('https://secret.example/a.js', { initiator: 'https://x.example' }))).toBeNull()
    expect(net.blockBeforeRequest(request('https://x.example/a.js', { initiator: 'https://secret.example' }))).toBeNull()
    expect(sent).toEqual([])
  })

  it('the answers of several extensions: the one loaded last speaks first, and its redirect wins', async () => {
    const { net, sent } = blocking()
    net.add('b', '/ext/b', classic())
    net.listen('b', 'frame:9', 'onBeforeRequest', { urls: ['<all_urls>'] }, ['blocking'], true)
    const asked = net.blockBeforeRequest(request('https://x.example/a.js'))!
    expect(sent.map((each) => each.ask)).toEqual([sent[0]?.ask, sent[0]?.ask])
    net.answer('b', 'frame:9', sent[0]?.ask, [{ redirectUrl: 'https://from-b.example/' }])
    net.answer('a', 'frame:5', sent[0]?.ask, [{ redirectUrl: 'https://from-a.example/' }])
    expect(await asked).toEqual({ cancel: false, redirectUrl: 'https://from-b.example/', ignored: [{ extensionId: 'a', why: 'redirect-conflict' }] })
  })

  it('an answer that is not of the documented shape is not applied, and the journal says so once', async () => {
    const { net, sent, warnings } = blocking()
    for (const at of [0, 1]) {
      const asked = net.blockBeforeRequest(request('https://x.example/a.js'))!
      net.answer('a', 'frame:5', sent[at]?.ask, [{ cancel: 'yes' }])
      expect(await asked).toMatchObject({ cancel: false })
    }
    expect(warnings).toEqual(['an answer of a to chrome.webRequest.onBeforeRequest is not applied: it is not of the shape the platform documents'])
  })

  it('the headers a listener changes, on top of what the declarative rules made of them', async () => {
    const { net, sent } = blocking('onBeforeSendHeaders')
    const told = { Accept: '*/*', Cookie: 'a=1' }
    const asked = net.blockRequestHeaders(request('https://x.example/a.js'), told, { ...told, 'X-Rule': '1' })!
    expect(sent[0]?.details).not.toHaveProperty('requestHeaders')
    net.answer('a', 'frame:5', sent[0]?.ask, [{ requestHeaders: [{ name: 'Accept', value: 'text/plain' }, { name: 'X-Added', value: 'yes' }] }])
    expect((await asked).headers).toEqual({ 'X-Rule': '1', Accept: 'text/plain', 'X-Added': 'yes' })
  })

  it('a server that asks for a login: what the listeners of onAuthRequired answer', async () => {
    const { net, sent } = blocking('onAuthRequired')
    const extras = { statusCode: 401, responseHeaders: { 'WWW-Authenticate': ['Basic realm="r"'] } }
    const asked = net.blockAuth(request('https://x.example/private', { type: 'main_frame' }), extras)!
    expect(sent[0]?.details).toMatchObject({ scheme: 'basic', realm: 'r', isProxy: false })
    net.answer('a', 'frame:5', sent[0]?.ask, [{ authCredentials: { username: 'u', password: 'p' } }])
    expect(await asked).toEqual({ credentials: { username: 'u', password: 'p' } })
  })

  it('an event that takes no answer is never asked, and the journal says so once', () => {
    const made = world()
    made.net.add('a', '/ext/a', classic())
    made.net.listen('a', 'frame:5', 'onCompleted', { urls: ['<all_urls>'] }, ['blocking'], true)
    made.net.heard('onCompleted', request('https://x.example/a.js'))
    expect(made.sent[0]).not.toHaveProperty('ask')
    expect(made.warnings).toEqual(['a put a blocking listener on chrome.webRequest.onCompleted, an event that takes no answer: it is told about the requests'])
  })

  it('past the bound of the requests waiting at once, a request is told without being waited for, and the journal says so once', () => {
    vi.useFakeTimers()
    const { net, sent, warnings } = blocking()
    for (let at = 0; at < PENDING_ASKS_MAX; at++) expect(net.blockBeforeRequest(request(`https://x.example/${at}.js`))).not.toBeNull()
    expect(net.blockBeforeRequest(request('https://x.example/over.js'))).toBeNull()
    expect(net.blockBeforeRequest(request('https://x.example/over-again.js'))).toBeNull()
    expect(sent.at(-1)).not.toHaveProperty('ask')
    expect(warnings).toEqual([`${PENDING_ASKS_MAX} requests are already waiting for blocking listeners in this profile: the next ones are told to the extensions without waiting for their answers`])
  })
})

describe('the details of an event', () => {
  it('a login asked by a server is told from any other answer, and described as the platform describes it', () => {
    expect(authChallenge(401, { 'WWW-Authenticate': ['Basic realm="vault"'] }, 'https://x.example:8443/a')).toEqual({ isProxy: false, scheme: 'basic', realm: 'vault', challenger: { host: 'x.example', port: 8443 } })
    expect(authChallenge(407, { 'proxy-authenticate': 'Digest realm="p"' }, 'http://x.example/a')).toMatchObject({ isProxy: true, scheme: 'digest', challenger: { port: 80 } })
    expect(authChallenge(401, { 'WWW-Authenticate': ['Bearer realm="api"'] }, 'https://x.example/a')).toBeNull()
    expect(authChallenge(401, {}, 'https://x.example/a')).toBeNull()
    expect(authChallenge(200, { 'WWW-Authenticate': ['Basic realm="vault"'] }, 'https://x.example/a')).toBeNull()
    const details = eventDetails('onAuthRequired', request('https://x.example/a'), { statusCode: 401, responseHeaders: { 'www-authenticate': 'Basic realm="r"' } }, false, false)
    expect(details).toMatchObject({ isProxy: false, scheme: 'basic', realm: 'r', statusCode: 401 })
    expect(details).not.toHaveProperty('responseHeaders')
  })

  it('names a file inside the folder of an extension, and nothing outside it', () => {
    expect(insideFolder('/ext/a', 'rules/main.json')).toBe('/ext/a/rules/main.json')
    expect(insideFolder('/ext/a/', './rules//main.json')).toBe('/ext/a/rules/main.json')
    expect(insideFolder('/ext/a', '../b/rules.json')).toBeNull()
    expect(insideFolder('/ext/a', 'rules/../../b.json')).toBeNull()
    expect(insideFolder('/ext/a', '')).toBeNull()
  })
})

// A rule its budget keeps from a request (a filter out of steps, an address too long for an expression) stopped covering it without a word
// where the person looks: the journal of the extension now gets a line, once per rule.
describe('a rule of an extension that its budget keeps from a request', () => {
  const slowFilter = `x*${'a'.repeat(200)}b`
  const slowAddress = `https://x.example/x${'a'.repeat(20_000)}`

  it('is told to the host with the extension it belongs to, the first time only, and the request goes on without it', () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { net, givenUp } = world()
    net.add('a', '/ext/a', manifest())
    net.mirror('a', { session: [block(12, slowFilter), { id: 13, action: { type: 'block' }, condition: { regexFilter: 'x.*x.*y' } }], dynamic: [] })
    expect(net.beforeRequest(request(slowAddress))).toEqual({ action: 'none' })
    expect(net.beforeRequest(request(slowAddress))).toEqual({ action: 'none' })
    expect(givenUp.map((line) => [line.extensionId, line.ruleId, line.why])).toEqual([
      ['a', 12, 'steps'],
      ['a', 13, 'length']
    ])
    expect(givenUp[0]?.addressLength).toBe(slowAddress.length)
    // The longest address the expression of rule 13 is run on: what the line of the journal names.
    expect(givenUp[1]?.limit).toBeGreaterThan(64)
    expect(givenUp[1]?.limit).toBeLessThan(slowAddress.length)
    quiet.mockRestore()
  })

  it('still lets the request go on when the journal cannot be written, and says why', () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { net, host, warnings } = world()
    host.ruleGivenUp = () => {
      throw new Error('the journal is closed')
    }
    net.add('a', '/ext/a', manifest())
    net.mirror('a', { session: [block(12, slowFilter), block(14, '/ads/')], dynamic: [] })
    expect(net.beforeRequest(request(slowAddress))).toEqual({ action: 'none' })
    expect(net.beforeRequest(request('https://x.example/ads/a.js'))).toEqual({ action: 'block' })
    expect(warnings.filter((line) => line.includes('rule 12') && line.includes('the journal is closed'))).toHaveLength(1)
    quiet.mockRestore()
  })

  it('reads as one sentence per rule, which names neither the address nor its length', () => {
    setLanguage('en')
    expect(ruleGivenUpNote(12, 'steps', 4096)).toBe('Network rule 12 of this extension was not applied to a request: comparing its filter with the address took more steps than Lucium gives a rule. The request went through without this rule.')
    expect(ruleGivenUpNote(13, 'length', 228)).toContain('an address of 228 characters at most')
    setLanguage('fr')
    expect(ruleGivenUpNote(13, 'length', 228)).toContain('La règle réseau 13')
  })
})

describe('getMatchedRules: the rules that decided a request', () => {
  const declared = { declarative_net_request: { rule_resources: [{ id: 'main', enabled: true, path: 'rules/main.json' }] } }
  const files = { '/ext/a/rules/main.json': [block(1, '/static-main/')] }

  it('lists the rule that blocked a request with its ruleset, the tab and the time, and none that did not decide', async () => {
    const { net } = world(files)
    net.add('a', '/ext/a', manifest(declared))
    await settle()
    net.beforeRequest(request('https://x.example/static-main/a.js', { timeStamp: 500 }))
    net.beforeRequest(request('https://x.example/nothing.js', { timeStamp: 600 }))
    expect(net.matchedRules('a', undefined)).toEqual({ rulesMatchedInfo: [{ rule: { ruleId: 1, rulesetId: 'main' }, tabId: 4, timeStamp: 500 }] })
  })

  it('names the dynamic and the session rules as the platform does', async () => {
    const { net } = world()
    net.add('a', '/ext/a', manifest())
    net.mirror('a', { dynamic: [block(7, '/dyn/')], session: [block(8, '/ses/')] })
    net.beforeRequest(request('https://x.example/dyn/a.js'))
    net.beforeRequest(request('https://x.example/ses/a.js'))
    const ids = (net.matchedRules('a', {}) as { rulesMatchedInfo: Array<{ rule: { ruleId: number; rulesetId: string } }> }).rulesMatchedInfo.map((info) => `${info.rule.rulesetId}:${info.rule.ruleId}`)
    expect(ids.sort()).toEqual(['_dynamic:7', '_session:8'])
  })

  it('filters by tab and by minimal time', async () => {
    const { net } = world(files)
    net.add('a', '/ext/a', manifest(declared))
    await settle()
    net.beforeRequest(request('https://x.example/static-main/1.js', { tabId: 4, timeStamp: 100 }))
    net.beforeRequest(request('https://x.example/static-main/2.js', { tabId: 5, timeStamp: 200 }))
    const times = (filter: unknown) => (net.matchedRules('a', filter) as { rulesMatchedInfo: Array<{ timeStamp: number }> }).rulesMatchedInfo.map((info) => info.timeStamp)
    expect(times({ tabId: 5 })).toEqual([200])
    expect(times({ minTimeStamp: 150 })).toEqual([200])
    expect(times({})).toEqual([100, 200])
  })

  it('keeps the most recent ones only, and forgets an extension that is unloaded', async () => {
    const { net } = world(files)
    net.add('a', '/ext/a', manifest(declared))
    await settle()
    for (let i = 0; i < NET_LIMITS.matchedRulesKept + 5; i++) net.beforeRequest(request('https://x.example/static-main/a.js', { timeStamp: i }))
    const kept = (net.matchedRules('a', {}) as { rulesMatchedInfo: Array<{ timeStamp: number }> }).rulesMatchedInfo
    expect(kept).toHaveLength(NET_LIMITS.matchedRulesKept)
    expect(kept[0]!.timeStamp).toBe(5)
    net.remove('a')
    net.add('a', '/ext/a', manifest(declared))
    expect(net.matchedRules('a', {})).toEqual({ rulesMatchedInfo: [] })
  })

  it('refuses a filter that is not one', () => {
    const { net } = world()
    net.add('a', '/ext/a', manifest())
    expect(() => net.matchedRules('a', { tabId: 'x' })).toThrow('Invalid value')
  })
})
