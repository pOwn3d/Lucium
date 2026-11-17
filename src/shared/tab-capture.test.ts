import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOUND_TTL_MS, CAPTURES_MAX, CLAIM_TTL_MS, NoticeThrottle, PENDING_MAX, TAB_CAPTURE_ERRORS, TabCaptureRegistry, declaresTabCapture, permissionsKey, isClaimId, openDetailsLabel, readCaptureOptions, refusedNotice, startedNotice, stopLabel, targetRefusal, type CaptureTarget } from './tab-capture'
import { frenchSpaces } from './french-typography'
import { setLanguage } from './i18n'

const EXT = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const FRAME = { processId: 11, routingId: 3 }
const FRAME_2 = { processId: 11, routingId: 4 }

/** A registry with a clock the test moves, and identifiers that count. */
function registry() {
  let now = 1_000
  let next = 0
  const reg = new TabCaptureRegistry(
    () => now,
    () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`
  )
  return { reg, wait: (ms: number) => (now += ms) }
}

const issue = (reg: TabCaptureRegistry, tab = 7, extensionId = EXT) => {
  const made = reg.issue({ extensionId, profileId: 'default', targetTab: tab, issuer: 'worker:1' })
  if (!made.ok) throw new Error(made.error)
  return made.id
}
const caller = { extensionId: EXT, profileId: 'default', frame: FRAME, contentsId: 40 }
/** The capture begins for a claim a page took: its helper page (the web contents `helper`) asks for the stream, and gets it. */
const begin = (reg: TabCaptureRegistry, id: string, wasMuted = false, helper = 90) => {
  expect(reg.attachHelper(id, helper)).toBe(true)
  return reg.start(id, wasMuted)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the identifier of a tab capture', () => {
  it('is a UUID: the shape of what Lucium makes, and nothing else', () => {
    expect(isClaimId(crypto.randomUUID())).toBe(true)
    for (const wrong of ['', 'abc', 42, null, undefined, { a: 1 }, '00000000-0000-4000-8000-00000000000', '../../x', `${crypto.randomUUID()}x`, crypto.randomUUID().toUpperCase()]) expect(isClaimId(wrong)).toBe(false)
  })
})

describe('what a manifest lets an extension do, as a key', () => {
  const base = { manifest_version: 3, version: '1', permissions: ['tabCapture', 'activeTab'], host_permissions: ['https://a.example/*'] }

  it('is the same for the same permissions and sites, whatever their order, the version, the name and the rest of the manifest', () => {
    const key = permissionsKey(base)
    expect(key).not.toBeNull()
    expect(permissionsKey({ ...base, permissions: ['activeTab', 'tabCapture'], version: '2', name: 'Other', background: { service_worker: 'x.js' } })).toBe(key)
  })

  it('changes when an extension asks for one more permission, one more site, or an optional one; or one less', () => {
    const key = permissionsKey(base)
    expect(permissionsKey({ ...base, permissions: [...base.permissions, 'tabs'] })).not.toBe(key)
    expect(permissionsKey({ ...base, host_permissions: [...base.host_permissions, '<all_urls>'] })).not.toBe(key)
    expect(permissionsKey({ ...base, optional_permissions: ['downloads'] })).not.toBe(key)
    expect(permissionsKey({ ...base, optional_host_permissions: ['https://*/*'] })).not.toBe(key)
    expect(permissionsKey({ ...base, permissions: ['activeTab'] })).not.toBe(key)
  })

  it('keeps the four lists apart: a permission moved from required to optional is another key', () => {
    expect(permissionsKey({ ...base, permissions: ['activeTab'], optional_permissions: ['tabCapture'] })).not.toBe(permissionsKey(base))
  })

  it('reads only text in a list, and has none for what is not a manifest', () => {
    expect(permissionsKey({ ...base, permissions: ['tabCapture', 5, null, {}] })).toBe(permissionsKey({ ...base, permissions: ['tabCapture'] }))
    expect(permissionsKey({ ...base, permissions: 'tabCapture' })).toBe(permissionsKey({ ...base, permissions: [] }))
    for (const wrong of [null, undefined, 'x', 5, []]) expect(permissionsKey(wrong), String(wrong)).toBeNull()
  })
})

describe('the claims: issuing', () => {
  it('hands out an identifier tied to the extension, the profile and the tab', () => {
    const { reg } = registry()
    const id = issue(reg)
    expect(reg.get(id)).toMatchObject({ extensionId: EXT, profileId: 'default', targetTab: 7, issuer: 'worker:1', state: 'issued' })
  })

  it('makes a different identifier each time', () => {
    const { reg } = registry()
    expect(issue(reg, 1)).not.toBe(issue(reg, 2))
  })

  it('makes random identifiers of the shape the page checks, with the real clock and generator', () => {
    const reg = new TabCaptureRegistry()
    const ids = Array.from({ length: 5 }, (_, i) => issue(reg, i))
    expect(new Set(ids).size).toBe(5)
    for (const id of ids) expect(isClaimId(id)).toBe(true)
    // The claim lives by the real clock too: it can be claimed now.
    expect(reg.bind(ids[0]!, caller).ok).toBe(true)
  })

  it('expires by the real clock when none is given', () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    const reg = new TabCaptureRegistry()
    const id = issue(reg)
    vi.advanceTimersByTime(CLAIM_TTL_MS + 1)
    expect(reg.bind(id, caller)).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses a second capture of a tab that is captured, and a third capture of the application', () => {
    const { reg } = registry()
    const first = issue(reg, 1)
    reg.bind(first, caller)
    expect(begin(reg, first).ok).toBe(true)
    expect(reg.issue({ extensionId: OTHER, profileId: 'default', targetTab: 1, issuer: 'x' })).toEqual({ ok: false, error: TAB_CAPTURE_ERRORS.busy })
    const second = issue(reg, 2)
    reg.bind(second, { ...caller, frame: FRAME_2, contentsId: 41 })
    expect(begin(reg, second, false, 91).ok).toBe(true)
    expect(reg.actives()).toHaveLength(CAPTURES_MAX)
    expect(reg.issue({ extensionId: EXT, profileId: 'default', targetTab: 3, issuer: 'x' })).toEqual({ ok: false, error: TAB_CAPTURE_ERRORS.tooMany })
  })

  it('lets a tab be captured again once its capture ended', () => {
    const { reg } = registry()
    const id = issue(reg, 1)
    reg.bind(id, caller)
    begin(reg, id)
    reg.end(id)
    expect(reg.issue({ extensionId: EXT, profileId: 'default', targetTab: 1, issuer: 'x' }).ok).toBe(true)
  })

  it('keeps at most a few identifiers nobody used, by extension: the oldest go', () => {
    const { reg } = registry()
    const ids = Array.from({ length: PENDING_MAX + 3 }, (_, i) => issue(reg, 100 + i))
    expect(ids.filter((id) => reg.get(id) !== undefined)).toEqual(ids.slice(3))
    // Another extension's identifiers are not touched by the first one's flood.
    const other = issue(reg, 500, OTHER)
    for (let i = 0; i < PENDING_MAX + 2; i++) issue(reg, 200 + i)
    expect(reg.get(other)).toBeDefined()
  })

  it('never takes an identifier a page took (a capture about to begin) for one that nobody used: a flood of new identifiers leaves it where it is', () => {
    const { reg } = registry()
    const taken = issue(reg, 1)
    expect(reg.bind(taken, caller).ok).toBe(true)
    expect(reg.attachHelper(taken, 90)).toBe(true)
    for (let i = 0; i < PENDING_MAX * 3; i++) issue(reg, 100 + i)
    expect(reg.get(taken)).toMatchObject({ state: 'bound', helperId: 90 })
    expect(reg.byHelper(90)).toBeDefined()
  })

  it('counts the identifiers nobody used by profile too: the flood of one profile does not take another\'s', () => {
    const { reg } = registry()
    const work = reg.issue({ extensionId: EXT, profileId: 'work', targetTab: 900, issuer: 'worker:2' })
    if (!work.ok) throw new Error(work.error)
    for (let i = 0; i < PENDING_MAX + 2; i++) issue(reg, 200 + i)
    expect(reg.get(work.id)).toBeDefined()
  })

  it('has the limits the documents give: an identifier lives 30 s, a page has 20 s to begin, two captures at once, eight identifiers unused', () => {
    expect([CLAIM_TTL_MS, BOUND_TTL_MS, CAPTURES_MAX, PENDING_MAX]).toEqual([30_000, 20_000, 2, 8])
  })
})

describe('the claims: claiming, by the page', () => {
  it('ties the claim to the page that claims it', () => {
    const { reg } = registry()
    const id = issue(reg)
    const bound = reg.bind(id, caller)
    expect(bound).toMatchObject({ ok: true, claim: { state: 'bound', frame: FRAME, contentsId: 40 } })
  })

  it('refuses an identifier nobody made', () => {
    const { reg } = registry()
    expect(reg.bind('00000000-0000-4000-8000-0000000000ff', caller)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('refuses an identifier that expired, and forgets it', () => {
    const { reg, wait } = registry()
    const id = issue(reg)
    wait(CLAIM_TTL_MS)
    expect(reg.bind(id, caller)).toEqual({ ok: false, reason: 'expired' })
    expect(reg.get(id)).toBeUndefined()
  })

  it('gives a page that took an identifier its own time for the capture to begin, not what was left of the identifier\'s', () => {
    const { reg, wait } = registry()
    const id = issue(reg)
    wait(CLAIM_TTL_MS - 1)
    reg.bind(id, caller)
    expect(reg.attachHelper(id, 90)).toBe(true)
    wait(BOUND_TTL_MS - 1)
    expect(reg.start(id, false).ok).toBe(true)
    // And no longer: a page that took one and never went on does not hold it for ever.
    const slow = issue(reg, 8)
    reg.bind(slow, { ...caller, frame: FRAME_2, contentsId: 41 })
    wait(BOUND_TTL_MS)
    expect(reg.start(slow, false)).toEqual({ ok: false, reason: 'no-claim' })
    expect(reg.get(slow)).toBeUndefined()
  })

  it('accepts an identifier up to the last moment of its life', () => {
    const { reg, wait } = registry()
    const id = issue(reg)
    wait(CLAIM_TTL_MS - 1)
    expect(reg.bind(id, caller).ok).toBe(true)
  })

  it('lets a page that holds a capture that runs take another identifier: only one that has not begun is held at a time', () => {
    const { reg } = registry()
    const running = issue(reg, 1)
    reg.bind(running, caller)
    begin(reg, running)
    const next = issue(reg, 2)
    expect(reg.bind(next, caller).ok).toBe(true)
  })

  it('refuses an identifier made for another extension, and leaves it to its owner', () => {
    const { reg } = registry()
    const id = issue(reg)
    expect(reg.bind(id, { ...caller, extensionId: OTHER })).toEqual({ ok: false, reason: 'foreign' })
    expect(reg.bind(id, caller).ok).toBe(true)
  })

  it('refuses an identifier made for another profile of the same extension', () => {
    const { reg } = registry()
    const id = issue(reg)
    expect(reg.bind(id, { ...caller, profileId: 'work' })).toEqual({ ok: false, reason: 'foreign' })
  })

  it('serves an identifier once: claimed, it cannot be claimed again, by the same page or another', () => {
    const { reg } = registry()
    const id = issue(reg)
    expect(reg.bind(id, caller).ok).toBe(true)
    expect(reg.bind(id, caller)).toEqual({ ok: false, reason: 'used' })
    expect(reg.bind(id, { ...caller, frame: FRAME_2, contentsId: 41 })).toEqual({ ok: false, reason: 'used' })
  })

  it('serves a used identifier once more to no one, once its capture runs', () => {
    const { reg } = registry()
    const id = issue(reg)
    reg.bind(id, caller)
    begin(reg, id)
    expect(reg.bind(id, { ...caller, frame: FRAME_2, contentsId: 41 })).toEqual({ ok: false, reason: 'used' })
  })

  it('gives a page one claim at a time', () => {
    const { reg } = registry()
    reg.bind(issue(reg, 1), caller)
    expect(reg.bind(issue(reg, 2), caller)).toEqual({ ok: false, reason: 'frame-busy' })
    expect(reg.bind(issue(reg, 3), { ...caller, frame: FRAME_2, contentsId: 41 }).ok).toBe(true)
  })
})

describe('the claims: what a page that took one holds', () => {
  /** The page number `n` of the extension: a frame of its own. */
  const page = (n: number) => ({ ...caller, frame: { processId: 100 + n, routingId: n }, contentsId: 200 + n })

  it('counts the claims pages took, with the captures that run, against the most captures at the same time: the identifier is kept for later', () => {
    const { reg } = registry()
    const ids = [1, 2, 3, 4, 5, 6].map((tab) => issue(reg, tab))
    expect(reg.bind(ids[0]!, page(1)).ok).toBe(true)
    begin(reg, ids[0]!)
    expect(reg.bind(ids[1]!, page(2)).ok).toBe(true)
    for (const [n, id] of ids.slice(2).entries()) expect(reg.bind(id, page(3 + n)), `claim ${n + 3}`).toEqual({ ok: false, reason: 'too-many' })
    // What was refused is still there: a capture that ends makes room for it.
    reg.end(ids[1]!)
    expect(reg.bind(ids[2]!, page(3)).ok).toBe(true)
  })

  it('counts the claims pages took against the same tab: one tab, one helper page', () => {
    const { reg } = registry()
    const first = issue(reg, 7)
    const second = issue(reg, 7)
    expect(reg.bind(first, page(1)).ok).toBe(true)
    expect(reg.bind(second, page(2))).toEqual({ ok: false, reason: 'busy' })
    reg.end(first)
    expect(reg.bind(second, page(2)).ok).toBe(true)
  })

  it('stops counting a claim whose page did not begin in time: its window is gone with it', () => {
    const { reg, wait } = registry()
    const ids = [1, 2, 3].map((tab) => issue(reg, tab))
    expect(reg.bind(ids[0]!, page(1)).ok).toBe(true)
    expect(reg.bind(ids[1]!, page(2)).ok).toBe(true)
    expect(reg.bind(ids[2]!, page(3))).toEqual({ ok: false, reason: 'too-many' })
    wait(BOUND_TTL_MS + 1)
    expect(reg.bind(ids[2]!, page(3)).ok).toBe(true)
  })
})

describe('the claims: the helper page of a claim', () => {
  it('ties a claim a page took to the one page that asks for its stream, once', () => {
    const { reg } = registry()
    const id = issue(reg, 9)
    reg.bind(id, caller)
    expect(reg.byHelper(90)).toBeUndefined()
    expect(reg.attachHelper(id, 90)).toBe(true)
    expect(reg.byHelper(90)).toMatchObject({ id, targetTab: 9, state: 'bound', helperId: 90 })
    expect(reg.attachHelper(id, 91)).toBe(false)
    expect(reg.byHelper(91)).toBeUndefined()
  })

  it('is not made for a claim that expired meanwhile', () => {
    const { reg, wait } = registry()
    const id = issue(reg)
    reg.bind(id, caller)
    wait(BOUND_TTL_MS)
    expect(reg.attachHelper(id, 90)).toBe(false)
    expect(reg.get(id)).toBeUndefined()
  })

  it('is not made for an identifier nobody took, one that was never made, or one whose capture runs', () => {
    const { reg } = registry()
    const free = issue(reg)
    expect(reg.attachHelper(free, 90)).toBe(false)
    expect(reg.attachHelper('00000000-0000-4000-8000-0000000000ff', 90)).toBe(false)
    const taken = issue(reg, 2)
    reg.bind(taken, caller)
    begin(reg, taken)
    expect(reg.attachHelper(taken, 92)).toBe(false)
  })

  it('knows no page that is none of a claim\'s, and is told nothing of an expired claim', () => {
    const { reg, wait } = registry()
    const id = issue(reg)
    reg.bind(id, caller)
    reg.attachHelper(id, 90)
    expect(reg.byHelper(12345)).toBeUndefined()
    wait(BOUND_TTL_MS)
    expect(reg.byHelper(90)).toBeUndefined()
  })

  it('answers a copy: what is done with it changes nothing in the registry', () => {
    const { reg } = registry()
    const id = issue(reg)
    reg.bind(id, caller)
    reg.attachHelper(id, 90)
    ;(reg.byHelper(90) as { targetTab: number }).targetTab = 999
    expect(reg.byHelper(90)?.targetTab).toBe(7)
  })
})

describe('the claims: starting the capture', () => {
  it('turns the claim a page took into a capture, which keeps the state the sound was in', () => {
    const { reg } = registry()
    const id = issue(reg)
    reg.bind(id, caller)
    const started = begin(reg, id, true)
    expect(started).toMatchObject({ ok: true, claim: { id, state: 'active', targetTab: 7, wasMuted: true } })
    expect(reg.actives().map((claim) => claim.id)).toEqual([id])
  })

  it('refuses an identifier that no page took, and one that was never made', () => {
    const { reg } = registry()
    expect(reg.start(issue(reg), false)).toEqual({ ok: false, reason: 'no-claim' })
    expect(reg.start('00000000-0000-4000-8000-0000000000ff', false)).toEqual({ ok: false, reason: 'no-claim' })
  })

  it('serves a claim once: started, it cannot be started again', () => {
    const { reg } = registry()
    const id = issue(reg)
    reg.bind(id, caller)
    expect(begin(reg, id).ok).toBe(true)
    expect(reg.start(id, false)).toEqual({ ok: false, reason: 'no-claim' })
  })

  it('refuses a claim that expired before the stream was asked for', () => {
    const { reg, wait } = registry()
    const id = issue(reg)
    reg.bind(id, caller)
    reg.attachHelper(id, 90)
    wait(BOUND_TTL_MS)
    expect(reg.start(id, false)).toEqual({ ok: false, reason: 'no-claim' })
  })

  it('never expires a capture that runs', () => {
    const { reg, wait } = registry()
    const id = issue(reg)
    reg.bind(id, caller)
    begin(reg, id)
    wait(CLAIM_TTL_MS * 100)
    // Each of these looks for what is stale first: the capture is not.
    expect(reg.byHelper(90)).toMatchObject({ id, state: 'active' })
    expect(reg.start(id, false)).toEqual({ ok: false, reason: 'no-claim' })
    expect(reg.actives()).toHaveLength(1)
    expect(issue(reg, 8)).toBeTruthy()
    expect(reg.actives()).toHaveLength(1)
  })

  it('begins no more captures than the caps allow, whatever the pages took: the third claim, and the second one of a tab, were refused when the page took them', () => {
    const { reg } = registry()
    const ids = [issue(reg, 1), issue(reg, 2), issue(reg, 3), issue(reg, 1)]
    const frames = [FRAME, FRAME_2, { processId: 11, routingId: 5 }, { processId: 11, routingId: 6 }]
    const taken = ids.map((id, i) => reg.bind(id, { ...caller, frame: frames[i]!, contentsId: 40 + i }).ok)
    expect(taken).toEqual([true, true, false, false])
    expect(begin(reg, ids[0]!, false, 90).ok).toBe(true)
    expect(begin(reg, ids[1]!, false, 91).ok).toBe(true)
    expect(reg.attachHelper(ids[2]!, 92)).toBe(false)
    expect(reg.start(ids[2]!, false)).toEqual({ ok: false, reason: 'no-claim' })
    expect(reg.actives()).toHaveLength(CAPTURES_MAX)
  })
})

describe('the claims: ending', () => {
  it('ends one claim in any state, and says what it was', () => {
    const { reg } = registry()
    const id = issue(reg)
    reg.bind(id, caller)
    begin(reg, id, true)
    expect(reg.end(id)).toMatchObject({ id, state: 'active', wasMuted: true, helperId: 90 })
    expect(reg.end(id)).toBeUndefined()
    expect(reg.actives()).toEqual([])
  })

  it('ends the claims of a tab, of web contents, of a page, of an extension in a profile: only those, the captures that ran among them said', () => {
    const { reg } = registry()
    const a = issue(reg, 1)
    const b = issue(reg, 2)
    const c = issue(reg, 3, OTHER)
    reg.bind(a, caller)
    begin(reg, a)
    reg.bind(b, { ...caller, frame: FRAME_2, contentsId: 41 })
    reg.attachHelper(b, 95)
    expect(reg.endWhere({ targetTab: 1 }).map((claim) => [claim.id, claim.state])).toEqual([[a, 'active']])
    expect(reg.endWhere({ helperId: 96 })).toEqual([])
    expect(reg.endWhere({ contentsId: 41 }).map((claim) => claim.id)).toEqual([b])
    expect(reg.endWhere({ frame: FRAME })).toEqual([])
    expect(reg.endWhere({ extensionId: EXT })).toEqual([])
    expect(reg.endWhere({ extensionId: OTHER, profileId: 'work' })).toEqual([])
    expect(reg.endWhere({ extensionId: OTHER, profileId: 'default' }).map((claim) => claim.id)).toEqual([c])
  })

  it('ends the claims of a page that goes, and no other', () => {
    const { reg } = registry()
    const first = issue(reg, 1)
    reg.bind(first, caller)
    begin(reg, first)
    const second = issue(reg, 2)
    reg.bind(second, { ...caller, frame: FRAME_2, contentsId: 41 })
    expect(reg.endWhere({ frame: FRAME }).map((claim) => claim.targetTab)).toEqual([1])
    expect(reg.actives()).toEqual([])
    expect(reg.get(second)).toMatchObject({ state: 'bound' })
  })

  it('ends the claim of a helper page that goes, and no other', () => {
    const { reg } = registry()
    const first = issue(reg, 1)
    reg.bind(first, caller)
    begin(reg, first, false, 90)
    const second = issue(reg, 2)
    reg.bind(second, { ...caller, frame: FRAME_2, contentsId: 41 })
    begin(reg, second, false, 91)
    expect(reg.endWhere({ helperId: 91 }).map((claim) => claim.id)).toEqual([second])
    expect(reg.actives().map((claim) => claim.id)).toEqual([first])
  })
})

describe('what an extension may name in getMediaStreamId', () => {
  it('reads no options, an empty object and a tab id', () => {
    expect(readCaptureOptions(undefined)).toEqual({ ok: true, targetTabId: undefined })
    expect(readCaptureOptions(null)).toEqual({ ok: true, targetTabId: undefined })
    expect(readCaptureOptions({})).toEqual({ ok: true, targetTabId: undefined })
    expect(readCaptureOptions({ targetTabId: 12, consumerTabId: 3 })).toEqual({ ok: true, targetTabId: 12 })
    expect(readCaptureOptions({ targetTabId: 0 })).toEqual({ ok: true, targetTabId: 0 })
  })

  it('refuses what is not options, and a tab id that is not a whole number', () => {
    for (const wrong of ['12', 12, true, ['x']]) expect(readCaptureOptions(wrong)).toMatchObject({ ok: false, message: expect.stringContaining('getMediaStreamId') })
    for (const wrong of ['12', 1.5, -1, NaN, Infinity, 2 ** 60, {}, [1]]) expect(readCaptureOptions({ targetTabId: wrong })).toMatchObject({ ok: false, message: expect.stringContaining('targetTabId') })
  })
})

describe('the tab an extension wants to capture', () => {
  const ok: CaptureTarget = { inProfile: true, url: 'https://meet.example.com/abc-defg-hij', locked: false, lent: true }

  it('may be captured: a web page of the profile, not locked, that the person handed over', () => {
    expect(targetRefusal(7, ok)).toBeNull()
    expect(targetRefusal(7, { ...ok, url: 'http://localhost:3000/' })).toBeNull()
  })

  it('does not exist for an extension when it is not a tab of its profile (another profile, a private window, a page that is not a tab)', () => {
    expect(targetRefusal(7, undefined)).toBe('No tab with id: 7.')
    expect(targetRefusal(7, { ...ok, inProfile: false })).toBe('No tab with id: 7.')
  })

  it('is refused with the sentence of the extension platform when the person did not hand it over', () => {
    expect(targetRefusal(7, { ...ok, lent: false })).toBe(TAB_CAPTURE_ERRORS.notInvoked)
  })

  it('is refused when it is a page of the application, of the browser, of an extension or a file', () => {
    for (const url of ['lucium://settings', 'chrome://extensions', `chrome-extension://${EXT}/popup.html`, 'file:///Users/jane/notes.txt', 'about:blank', 'data:text/html,hi', 'blob:https://a.example/x', 'view-source:https://a.example/', '', 'not an address']) {
      expect(targetRefusal(7, { ...ok, url }), url).toBe(TAB_CAPTURE_ERRORS.notInvoked)
    }
  })

  it('is refused when its space or the application is locked, in the same words', () => {
    expect(targetRefusal(7, { ...ok, locked: true })).toBe(TAB_CAPTURE_ERRORS.notInvoked)
  })
})

describe('the permission of the manifest', () => {
  it('is read from the permissions of the manifest, and from nothing else', () => {
    expect(declaresTabCapture({ manifest_version: 3, permissions: ['activeTab', 'tabCapture'] })).toBe(true)
    expect(declaresTabCapture({ manifest_version: 3, permissions: ['activeTab'] })).toBe(false)
    // A facultative permission opens nothing until the person granted it: the engine then puts it among the permissions it hands this.
    expect(declaresTabCapture({ manifest_version: 3, permissions: [], optional_permissions: ['tabCapture'] })).toBe(false)
    expect(declaresTabCapture({ manifest_version: 3, host_permissions: ['tabCapture'] })).toBe(false)
    expect(declaresTabCapture(undefined)).toBe(false)
    expect(declaresTabCapture({ permissions: 'tabCapture' })).toBe(false)
  })
})

describe('the notices about one extension', () => {
  it('lets one through, then none until the delay is over', () => {
    let now = 0
    const throttle = new NoticeThrottle(10_000, () => now)
    expect(throttle.allow('default:ext')).toBe(true)
    now = 9_999
    expect(throttle.allow('default:ext')).toBe(false)
    now = 10_000
    expect(throttle.allow('default:ext')).toBe(true)
  })

  it('tells the extensions apart', () => {
    const throttle = new NoticeThrottle(10_000, () => 0)
    expect(throttle.allow('default:a')).toBe(true)
    expect(throttle.allow('default:b')).toBe(true)
    expect(throttle.allow('work:a')).toBe(true)
    expect(throttle.allow('default:a')).toBe(false)
  })

  it('forgets the oldest extension when its table is full', () => {
    const throttle = new NoticeThrottle(10_000, () => 0, 2)
    throttle.allow('a')
    throttle.allow('b')
    throttle.allow('c')
    expect(throttle.allow('a')).toBe(true)
    expect(throttle.allow('c')).toBe(false)
  })
})

describe('what the person reads', () => {
  afterEach(() => setLanguage('fr'))

  it('says who listens and to which tab when a capture begins, in French and in English', () => {
    expect(startedNotice('Captions', 'Réunion du lundi')).toBe(frenchSpaces('Captions capte maintenant le son de l’onglet « Réunion du lundi ».'))
    setLanguage('en')
    expect(startedNotice('Captions', 'Monday meeting')).toBe('Captions is now capturing the sound of the tab “Monday meeting”.')
  })

  it('says where to switch the whole function on, as the settings name the place, in the language of the interface', () => {
    expect(TAB_CAPTURE_ERRORS.featureOff).toMatch(/^Lucium: the capture of a tab's sound is switched off in Lucium \(Réglages › .*\)\.$/)
    setLanguage('en')
    expect(TAB_CAPTURE_ERRORS.featureOff).toMatch(/^Lucium: the capture of a tab's sound is switched off in Lucium \(Settings › .*\)\.$/)
  })

  it('says it without the title when the tab has none', () => {
    expect(startedNotice('Captions', '')).toBe('Captions capte maintenant le son d’un onglet.')
    expect(startedNotice('Captions', ' \u0007 ')).toBe('Captions capte maintenant le son d’un onglet.')
    setLanguage('en')
    expect(startedNotice('Captions', '')).toBe('Captions is now capturing a tab’s sound.')
  })

  it('cleans and cuts the title of a page and the name of an extension: both are any text somebody wrote', () => {
    const said = startedNotice(`Evil\u0007\u202E${'n'.repeat(200)}`, `Title\u0007\u202E${'t'.repeat(200)}`)
    expect(said).not.toMatch(/[\u0000-\u001f\u202e]/)
    expect(said.length).toBeLessThan(200)
    expect(startedNotice('', 'A page')).toContain('?')
  })

  it('names the buttons: the details of the extension, and the stop of the capture', () => {
    expect(openDetailsLabel()).toBe('Ouvrir les détails')
    expect(stopLabel()).toBe('Arrêter la capture du son')
    setLanguage('en')
    expect(openDetailsLabel()).toBe('Open details')
    expect(stopLabel()).toBe('Stop capturing the sound')
  })

  it('tells that an extension asked while it is not allowed, with the name cleaned', () => {
    expect(refusedNotice('Captions')).toBe(frenchSpaces('Captions a voulu capter le son d’un onglet : c’est désactivé pour cette extension.'))
    expect(refusedNotice('')).toContain('?')
  })
})
