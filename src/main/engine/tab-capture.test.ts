// The engine side of the capture of the sound of a tab, with a stand-in for Electron: who may ask, which tab, what the helper page is given, what the page of the extension
// is handed and what is not, what the person sees and how it ends. The rules alone (claims, caps, tab, chunks and their pace) are in shared/tab-capture.test.ts and
// shared/tab-capture-pcm.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPTURES_MAX, CLAIM_TTL_MS, PENDING_MAX, TAB_CAPTURE_ERRORS, TabCaptureRegistry } from '@shared/tab-capture'
import { PCM_HEADER_BYTES, PCM_MESSAGE_MAX } from '@shared/tab-capture-pcm'
import { FIRST_SOUND_MS, START_TIMEOUT_MS, STOP_GRACE_MS, TabCaptures, extensionOfUrl, type CaptureHelper, type CaptureSender, type TabCaptureEvent, type TabCaptureHost } from './tab-capture'

const EXT = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const MEET = 'https://meet.example.com/abc-defg-hij'
const MANIFEST = { manifest_version: 3, permissions: ['activeTab', 'tabCapture', 'offscreen'] }
const FRAME = { processId: 11, routingId: 3, contentsId: 40 }
const FRAME_2 = { processId: 12, routingId: 2, contentsId: 41 }

/** A chunk of sound as the helper page packs it: the four integers (sequence, rate, channels, frames), then the planes. 20 ms of a mono sound at 48 kHz unless said. */
function chunk(seq: number, over: { rate?: number; channels?: number; frames?: number; value?: number } = {}): ArrayBuffer {
  const rate = over.rate ?? 48_000
  const channels = over.channels ?? 1
  const frames = over.frames ?? 960
  const buffer = new ArrayBuffer(PCM_HEADER_BYTES + channels * frames * 4)
  const view = new DataView(buffer)
  for (const [at, value] of [seq, rate, channels, frames].entries()) view.setUint32(at * 4, value, true)
  new Float32Array(buffer, PCM_HEADER_BYTES).fill(over.value ?? 0.25)
  return buffer
}

interface TabState {
  profileId: string
  url: string
  muted: boolean
  locked: boolean
}

/** A helper page of the stand-in: what it was asked, and whether it was destroyed. */
interface FakeHelper extends CaptureHelper {
  starts: number
  closed: number
}

/** A host with two tabs of the `default` profile, an extension that may capture and holds tab 7, and what Electron would be asked to do written down. */
function setup(over: { manifests?: Record<string, unknown>; allowed?: boolean; lent?: Array<[string, number]> } = {}) {
  const tabs = new Map<number, TabState>([
    [7, { profileId: 'default', url: MEET, muted: false, locked: false }],
    [8, { profileId: 'default', url: 'https://other.example.com/', muted: true, locked: false }],
    [9, { profileId: 'work', url: 'https://work.example.com/', muted: false, locked: false }]
  ])
  const state = {
    manifests: { [`default:${EXT}`]: MANIFEST, [`default:${OTHER}`]: MANIFEST, ...over.manifests } as Record<string, unknown>,
    allowed: new Set<string>(over.allowed === false ? [] : [`default:${EXT}`, `default:${OTHER}`]),
    featureOn: true,
    // What was handed over: the origin the tab was on when the person did, as `ActiveTabGrants` keeps it.
    lent: new Map<string, string>((over.lent ?? [[EXT, 7]]).map(([extension, tab]) => [`${extension}:${tab}`, tab === 7 ? new URL(MEET).origin : tab === 8 ? 'https://other.example.com' : 'https://third.example.com'])),
    shown: 7 as number | undefined,
    stopped: [] as Array<[unknown, string]>,
    reloaded: [] as number[],
    revoked: [] as string[],
    warnings: [] as string[],
    muteCalls: [] as Array<[number, boolean]>,
    failMute: false,
    failStop: false,
    failReload: false,
    // The helper pages: the ones made, in order, and what they do. By default a helper page asks for the stream, then answers.
    helpers: [] as FakeHelper[],
    streams: [] as Array<ReturnType<TabCaptures['answerHelper']>>,
    helperAsks: true,
    /** The helper page sends its first chunk as soon as it began (the real one does so by IPC, a moment later). */
    helperSends: true,
    helperFails: false,
    helperHangs: false,
    openFails: false,
    openNone: false,
    /** Runs inside the helper page, once it asked for the stream and before it sends a chunk. */
    whileStarting: undefined as (() => void) | undefined,
    /** What was handed to the page of an extension: the frame, the claim, the chunk. */
    delivered: [] as Array<{ frame: unknown; claimId: string; chunk: ArrayBuffer }>,
    failDeliver: false
  }
  let nextHelper = 90
  const host: TabCaptureHost = {
    manifestOf: (profileId, extensionId) => state.manifests[`${profileId}:${extensionId}`],
    nameOf: (_profileId, extensionId) => (extensionId === EXT ? 'Captions' : 'Other'),
    featureOn: () => state.featureOn,
    allowed: (profileId, extensionId) => state.allowed.has(`${profileId}:${extensionId}`),
    tab: (tabNumber) => {
      const tab = tabs.get(tabNumber)
      return tab ? { profileId: tab.profileId, url: tab.url } : undefined
    },
    shownTab: () => state.shown,
    locked: (tabNumber) => tabs.get(tabNumber)?.locked === true,
    lent: (extensionId, tabNumber, url) => state.lent.get(`${extensionId}:${tabNumber}`) === (URL.canParse(url) ? new URL(url).origin : url),
    revoke: (extensionId, tabNumber) => {
      state.lent.delete(`${extensionId}:${tabNumber}`)
      state.revoked.push(`${extensionId}:${tabNumber}`)
    },
    muted: (tabNumber) => tabs.get(tabNumber)?.muted,
    setMuted: (tabNumber, muted) => {
      state.muteCalls.push([tabNumber, muted])
      if (state.failMute) throw new Error('the web contents is gone')
      const tab = tabs.get(tabNumber)
      if (tab) tab.muted = muted
    },
    targetFrame: (tabNumber) => (tabs.has(tabNumber) ? { frameOfTab: tabNumber } : null),
    openHelper: (profileId) => {
      if (state.openFails) throw new Error('no window could be made')
      if (state.openNone) return null
      const contentsId = nextHelper++
      const helper: FakeHelper = {
        contentsId,
        starts: 0,
        closed: 0,
        close() {
          helper.closed++
        },
        start: async () => {
          helper.starts++
          if (state.helperHangs) return new Promise<void>(() => undefined)
          // The page asks for the stream: the engine answers (the display handler of the session does this for the real page).
          if (state.helperAsks) state.streams.push(captures.answerHelper({ frame: { id: contentsId } }, contentsId, profileId))
          state.whileStarting?.()
          if (state.helperFails) throw new Error('the page could not begin')
          if (state.helperSends && state.helperAsks) captures.pcm(contentsId, chunk(0))
        }
      }
      state.helpers.push(helper)
      return helper
    },
    deliver: (frame, claimId, sound) => {
      if (state.failDeliver) throw new Error('the page that listens is gone')
      state.delivered.push({ frame, claimId, chunk: sound })
    },
    tellStop: (frame, claimId) => {
      if (state.failStop) throw new Error('the frame is gone')
      state.stopped.push([frame, claimId])
    },
    forceEnd: (contentsId) => {
      if (state.failReload) throw new Error('already gone')
      state.reloaded.push(contentsId)
    },
    warn: (message) => void state.warnings.push(message)
  }
  const registry = new TabCaptureRegistry()
  const captures = new TabCaptures(host, registry)
  const events: TabCaptureEvent[] = []
  captures.onChange((event) => events.push(event))
  const worker: CaptureSender = { extensionId: EXT, profileId: 'default', context: 'worker:5' }
  const page: CaptureSender = { extensionId: EXT, profileId: 'default', context: 'frame:40', frame: FRAME }
  const page2: CaptureSender = { extensionId: EXT, profileId: 'default', context: 'frame:41', frame: FRAME_2 }
  /** The whole way a page takes: an identifier, the request to listen, the first chunk of the helper page. */
  const capture = async (tab = 7, sender: CaptureSender = page) => {
    const id = captures.id(worker, { targetTabId: tab })
    const format = await captures.listen(sender, id)
    return { id, format, stream: state.streams.at(-1) ?? null, helper: state.helpers.at(-1)! }
  }
  return { captures, registry, host, state, tabs, events, worker, page, page2, capture }
}

type World = ReturnType<typeof setup>

const refusalOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    return (error as Error).message
  }
  return 'NOT REFUSED'
}

/** What an offer is refused with, as the page reads it. */
const offerRefusal = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
  } catch (error) {
    return (error as Error).message
  }
  return 'NOT REFUSED'
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the extension a frame belongs to', () => {
  it('is read from the address, and only a real extension address has one', () => {
    expect(extensionOfUrl(`chrome-extension://${EXT}/a.html`)).toBe(EXT)
    expect(extensionOfUrl(`chrome-extension://${EXT}`)).toBe(EXT)
    for (const wrong of ['https://a.example/', `chrome-extension://${'z'.repeat(32)}/`, `chrome-extension://${EXT}x/`, 'chrome-extension://short/', '', undefined, null, 5, `https://x.example/chrome-extension://${EXT}/`]) expect(extensionOfUrl(wrong)).toBeNull()
  })
})

describe('getMediaStreamId: who may ask', () => {
  it('hands an identifier to an extension that declared tabCapture, is allowed, and was handed the tab', () => {
    const { captures, worker } = setup()
    expect(captures.id(worker, { targetTabId: 7 })).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('names the tab on screen when the extension names none', () => {
    const { captures, worker, registry } = setup()
    captures.id(worker, undefined)
    expect(captures.id(worker, {})).toBeTruthy()
    expect(registry.get(captures.id(worker, undefined))?.targetTab).toBe(7)
  })

  it('refuses when no tab is shown and none is named', () => {
    const { captures, worker, state } = setup()
    state.shown = undefined
    expect(refusalOf(() => captures.id(worker, {}))).toBe(TAB_CAPTURE_ERRORS.noTab)
  })

  it('refuses an extension whose manifest does not declare tabCapture', () => {
    const { captures, worker } = setup({ manifests: { [`default:${EXT}`]: { manifest_version: 3, permissions: ['activeTab'] } } })
    expect(refusalOf(() => captures.id(worker, { targetTabId: 7 }))).toBe(TAB_CAPTURE_ERRORS.noPermission)
  })

  it('refuses an extension that does not run in the profile (not installed, switched off), whatever it declares', () => {
    const { captures, state } = setup()
    delete state.manifests[`default:${EXT}`]
    expect(refusalOf(() => captures.id({ extensionId: EXT, profileId: 'default', context: 'worker:5' }, { targetTabId: 7 }))).toBe(TAB_CAPTURE_ERRORS.noPermission)
  })

  it('reads the profile of the manifest from the sender, not from anything the call says', () => {
    const { captures } = setup()
    // The extension runs in `default` only: a sender of the profile `work` has no manifest.
    expect(refusalOf(() => captures.id({ extensionId: EXT, profileId: 'work', context: 'worker:5' }, { targetTabId: 9 }))).toBe(TAB_CAPTURE_ERRORS.noPermission)
  })

  it('is refused, with a notice, while the person did not switch the capture on for the extension', () => {
    const { captures, worker, events, state } = setup({ allowed: false })
    expect(refusalOf(() => captures.id(worker, { targetTabId: 7 }))).toBe(TAB_CAPTURE_ERRORS.switchedOff)
    expect(events).toEqual([{ kind: 'refused', profileId: 'default', extensionId: EXT, name: 'Captions' }])
    expect(state.warnings.join('\n')).toContain(`refused for ${EXT} (profile default, worker:5)`)
  })

  it('tells the person once in a while, not each time an extension that is not allowed asks again', () => {
    const { captures, worker, events } = setup({ allowed: false })
    for (let i = 0; i < 5; i++) refusalOf(() => captures.id(worker, { targetTabId: 7 }))
    expect(events).toHaveLength(1)
    vi.advanceTimersByTime(30_000)
    refusalOf(() => captures.id(worker, { targetTabId: 7 }))
    expect(events).toHaveLength(2)
  })

  it('tells the person about each profile an extension is not allowed in', () => {
    const { captures, events, state } = setup({ allowed: false })
    state.manifests[`work:${EXT}`] = MANIFEST
    refusalOf(() => captures.id({ extensionId: EXT, profileId: 'default', context: 'worker:5' }, { targetTabId: 7 }))
    refusalOf(() => captures.id({ extensionId: EXT, profileId: 'work', context: 'worker:6' }, { targetTabId: 9 }))
    expect(events.map((event) => (event.kind === 'refused' ? event.profileId : ''))).toEqual(['default', 'work'])
  })

  it('does not tell the person about an extension that never declared the permission', () => {
    const { captures, worker, events } = setup({ allowed: false, manifests: { [`default:${EXT}`]: { manifest_version: 3, permissions: [] } } })
    refusalOf(() => captures.id(worker, { targetTabId: 7 }))
    expect(events).toEqual([])
  })

  it('is refused, in a sentence that says where to switch it on, while the whole function is off: and nobody is told that an extension asked', () => {
    const { captures, worker, events, state } = setup()
    state.featureOn = false
    expect(refusalOf(() => captures.id(worker, { targetTabId: 7 }))).toBe(TAB_CAPTURE_ERRORS.featureOff)
    expect(TAB_CAPTURE_ERRORS.featureOff).toContain('switched off in Lucium')
    expect(events).toEqual([])
  })

  it('is refused while the whole function is off, even for an extension the person allowed one by one', () => {
    const { captures, worker, state } = setup()
    state.featureOn = false
    expect(state.allowed.has(`default:${EXT}`)).toBe(true)
    expect(refusalOf(() => captures.id(worker, { targetTabId: 7 }))).not.toBe('NOT REFUSED')
    state.featureOn = true
    expect(captures.id(worker, { targetTabId: 7 })).toBeTruthy()
  })

  it('refuses a tab the person did not hand over, in the words of the extension platform', () => {
    const { captures, worker } = setup({ lent: [] })
    expect(refusalOf(() => captures.id(worker, { targetTabId: 7 }))).toBe(TAB_CAPTURE_ERRORS.notInvoked)
  })

  it('refuses a tab handed over to another extension', () => {
    const { captures, worker } = setup({ lent: [[OTHER, 7]] })
    expect(refusalOf(() => captures.id(worker, { targetTabId: 7 }))).toBe(TAB_CAPTURE_ERRORS.notInvoked)
  })

  it('refuses a tab that does not exist, and a tab of another profile, as one that does not exist', () => {
    const { captures, worker } = setup({ lent: [[EXT, 9]] })
    expect(refusalOf(() => captures.id(worker, { targetTabId: 404 }))).toBe('No tab with id: 404.')
    expect(refusalOf(() => captures.id(worker, { targetTabId: 9 }))).toBe('No tab with id: 9.')
  })

  it('refuses a page that is not an ordinary web page (the application, the browser, a file), even handed over', () => {
    for (const url of ['lucium://settings', 'chrome://extensions', 'file:///Users/jane/notes.txt', 'about:blank', `chrome-extension://${EXT}/popup.html`]) {
      // Handed over at that address (the host answers the grant for the address the tab is at), which is the strongest case for the extension.
      const held = setup()
      held.tabs.get(7)!.url = url
      expect(refusalOf(() => held.captures.id(held.worker, { targetTabId: 7 })), url).toBe(TAB_CAPTURE_ERRORS.notInvoked)
    }
  })

  it('refuses a tab whose space is locked, even handed over', () => {
    const { captures, worker, tabs } = setup()
    tabs.get(7)!.locked = true
    expect(refusalOf(() => captures.id(worker, { targetTabId: 7 }))).toBe(TAB_CAPTURE_ERRORS.notInvoked)
  })

  it('refuses options that are not options, in the words of the platform', () => {
    const { captures, worker } = setup()
    expect(refusalOf(() => captures.id(worker, 'seven'))).toContain('getMediaStreamId')
    expect(refusalOf(() => captures.id(worker, { targetTabId: '7' }))).toContain('targetTabId')
  })

  it('refuses a second capture of a tab that is captured', async () => {
    const { captures, worker, capture } = setup()
    await capture(7)
    expect(refusalOf(() => captures.id(worker, { targetTabId: 7 }))).toBe(TAB_CAPTURE_ERRORS.busy)
  })

  it('refuses a third capture while two run, whatever the tab', async () => {
    const { captures, worker, tabs, capture, page2 } = setup({ lent: [[EXT, 7], [EXT, 8], [EXT, 10]] })
    tabs.set(10, { profileId: 'default', url: 'https://third.example.com/', muted: false, locked: false })
    await capture(7)
    await capture(8, page2)
    expect(captures.list(worker)).toHaveLength(CAPTURES_MAX)
    expect(refusalOf(() => captures.id(worker, { targetTabId: 10 }))).toBe(TAB_CAPTURE_ERRORS.tooMany)
  })
})

describe('listen: who may ask, and what the page is answered with', () => {
  it('is answered with the format of the first chunk, for the page that took the identifier, and that chunk is handed to that page', async () => {
    const { capture, state } = setup()
    const { id, format, helper } = await capture(7)
    expect(format).toEqual({ sampleRate: 48_000, channels: 1 })
    expect(helper.starts).toBe(1)
    // The chunk reached the page before its question was answered, and it is the chunk the helper page sent, byte for byte.
    expect(state.delivered).toHaveLength(1)
    expect(state.delivered[0]).toMatchObject({ frame: { processId: 11, routingId: 3 }, claimId: id })
    expect(new Uint8Array(state.delivered[0]!.chunk)).toEqual(new Uint8Array(chunk(0)))
  })

  it('tells the format the sound has: the rate and the channels of the first chunk, not a guess', async () => {
    const { captures, worker, page, state } = setup()
    state.helperSends = false
    const id = captures.id(worker, { targetTabId: 7 })
    const pending = captures.listen(page, id)
    captures.pcm(state.helpers[0]!.contentsId, chunk(0, { rate: 44_100, channels: 2, frames: 882 }))
    expect(await pending).toEqual({ sampleRate: 44_100, channels: 2 })
  })

  it('is refused for a worker, which has no page to give a stream to', async () => {
    const { captures, worker, state } = setup()
    const id = captures.id(worker, { targetTabId: 7 })
    expect(await offerRefusal(() => captures.listen(worker, id))).toBe(TAB_CAPTURE_ERRORS.badIdentifier)
    expect(state.helpers).toEqual([])
  })

  it('is refused for another extension, and in another profile', async () => {
    const { captures, worker, state } = setup()
    state.manifests['work:' + EXT] = MANIFEST
    state.allowed.add('work:' + EXT)
    const id = captures.id(worker, { targetTabId: 7 })
    expect(await offerRefusal(() => captures.listen({ extensionId: OTHER, profileId: 'default', context: 'frame:41', frame: FRAME_2 }, id))).toContain('foreign')
    expect(await offerRefusal(() => captures.listen({ extensionId: EXT, profileId: 'work', context: 'frame:42', frame: { processId: 13, routingId: 1, contentsId: 42 } }, id))).toContain('foreign')
    expect(state.helpers).toEqual([])
  })

  it('is refused once the whole function was switched off', async () => {
    const { captures, worker, page, state } = setup()
    const id = captures.id(worker, { targetTabId: 7 })
    state.featureOn = false
    expect(await offerRefusal(() => captures.listen(page, id))).toBe(TAB_CAPTURE_ERRORS.featureOff)
    expect(state.helpers).toEqual([])
  })

  it('is refused when the identifier was made up, is not the shape of one, or has expired: nothing is made, nothing the size of a document is looked up', async () => {
    const { captures, worker, page, state, registry } = setup()
    const looked = vi.spyOn(registry, 'bind')
    expect(await offerRefusal(() => captures.listen(page, '00000000-0000-4000-8000-000000000000'))).toContain('unknown')
    expect(looked).toHaveBeenCalledTimes(1)
    // What is not even the shape of an identifier is refused before anything is looked up.
    for (const wrong of [12, null, undefined, {}, 'x'.repeat(10_000_000), '../../etc/passwd', '00000000-0000-4000-8000-00000000000']) expect(await offerRefusal(() => captures.listen(page, wrong))).toContain('malformed')
    expect(looked).toHaveBeenCalledTimes(1)
    const id = captures.id(worker, { targetTabId: 7 })
    vi.advanceTimersByTime(CLAIM_TTL_MS)
    expect(await offerRefusal(() => captures.listen(page, id))).toContain('expired')
    expect(state.helpers).toEqual([])
  })

  it('is refused once the person switched the capture off, and by an extension that no longer declares it', async () => {
    const { captures, worker, page, state } = setup()
    const id = captures.id(worker, { targetTabId: 7 })
    state.allowed.clear()
    expect(await offerRefusal(() => captures.listen(page, id))).toBe(TAB_CAPTURE_ERRORS.switchedOff)
    state.allowed.add(`default:${EXT}`)
    state.manifests[`default:${EXT}`] = { permissions: [] }
    expect(await offerRefusal(() => captures.listen(page, id))).toBe(TAB_CAPTURE_ERRORS.noPermission)
    expect(state.helpers).toEqual([])
  })

  it('is taken once for one identifier', async () => {
    const { captures, page, capture, state } = setup()
    const { id } = await capture(7)
    expect(await offerRefusal(() => captures.listen(page, id))).toContain('used')
    expect(state.helpers).toHaveLength(1)
  })

  it('is refused when the tab left the origin it was handed over on, or was locked, or taken back, since the identifier was made', async () => {
    for (const change of [(s: World) => (s.tabs.get(7)!.url = 'https://elsewhere.example.com/'), (s: World) => (s.tabs.get(7)!.locked = true), (s: World) => s.state.lent.clear()]) {
      const held = setup()
      const id = held.captures.id(held.worker, { targetTabId: 7 })
      change(held)
      expect(await offerRefusal(() => held.captures.listen(held.page, id))).toBe(TAB_CAPTURE_ERRORS.notInvoked)
      expect(held.state.helpers).toEqual([])
      expect(held.state.muteCalls).toEqual([])
    }
  })

  it('is refused when the tab is gone', async () => {
    const { captures, worker, page, tabs, state } = setup()
    const id = captures.id(worker, { targetTabId: 7 })
    tabs.delete(7)
    expect(await offerRefusal(() => captures.listen(page, id))).toBe('No tab with id: 7.')
    expect(state.helpers).toEqual([])
  })

  it('is refused when no helper page can be made, and the log says why', async () => {
    for (const how of ['openFails', 'openNone'] as const) {
      const { captures, worker, page, state, tabs } = setup()
      state[how] = true
      const id = captures.id(worker, { targetTabId: 7 })
      expect(await offerRefusal(() => captures.listen(page, id)), how).toBe(TAB_CAPTURE_ERRORS.noHelper)
      expect(captures.list(worker)).toEqual([])
      expect(tabs.get(7)!.muted).toBe(false)
      if (how === 'openFails') expect(state.warnings.join('\n')).toContain('could not be made')
      // The identifier was used up by the try: it cannot be taken again.
      expect(await offerRefusal(() => captures.listen(page, id)), how).toContain('unknown')
    }
  })

  it('is refused when the helper page cannot begin: the capture ends, the page goes, the sound is as it was, and the log says what the page said', async () => {
    const { captures, worker, page, state, tabs, events } = setup()
    state.helperFails = true
    const id = captures.id(worker, { targetTabId: 7 })
    const refusal = await offerRefusal(() => captures.listen(page, id))
    expect(refusal).toContain(TAB_CAPTURE_ERRORS.linkFailed)
    expect(refusal).toContain('the page could not begin')
    expect(state.warnings.join('\n')).toContain('the page could not begin')
    expect(state.helpers[0]!.closed).toBe(1)
    expect(captures.isHelper(state.helpers[0]!.contentsId)).toBe(false)
    expect(captures.list(worker)).toEqual([])
    expect(tabs.get(7)!.muted).toBe(false)
    // The stream had been given: the person was told, and is told that it ended.
    expect(events.map((event) => event.kind)).toEqual(['started', 'ended'])
  })

  it('is refused when the helper page does not begin in time', async () => {
    const { captures, worker, page, state, tabs } = setup()
    state.helperHangs = true
    const id = captures.id(worker, { targetTabId: 7 })
    const pending = offerRefusal(() => captures.listen(page, id))
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS - 1)
    expect(state.helpers[0]!.closed).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(START_TIMEOUT_MS).toBe(15_000)
    expect(await pending).toContain('did not start in time')
    expect(state.helpers[0]!.closed).toBe(1)
    expect(tabs.get(7)!.muted).toBe(false)
  })

  it('is refused when the helper page begins without having asked for the stream: there is no capture to carry', async () => {
    const { captures, worker, page, state } = setup()
    state.helperAsks = false
    const id = captures.id(worker, { targetTabId: 7 })
    expect(await offerRefusal(() => captures.listen(page, id))).toContain('ended before the sound came')
    expect(state.helpers[0]!.closed).toBe(1)
    expect(captures.list(worker)).toEqual([])
  })

  it('is refused when the capture ended while the helper page began (the tab was closed)', async () => {
    const { captures, worker, page, state, tabs } = setup()
    state.whileStarting = () => captures.tabGone(7)
    const id = captures.id(worker, { targetTabId: 7 })
    expect(await offerRefusal(() => captures.listen(page, id))).toContain(TAB_CAPTURE_ERRORS.linkFailed)
    expect(state.helpers[0]!.closed).toBe(1)
    expect(tabs.get(7)!.muted).toBe(false)
  })

  it('is refused, with the reason, when the tab gives no sound within three seconds, and not before', async () => {
    const { captures, worker, page, state, tabs } = setup()
    state.helperSends = false
    const id = captures.id(worker, { targetTabId: 7 })
    const pending = offerRefusal(() => captures.listen(page, id))
    await vi.advanceTimersByTimeAsync(FIRST_SOUND_MS - 1)
    expect(state.helpers[0]!.closed).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    const refusal = await pending
    expect(FIRST_SOUND_MS).toBe(3_000)
    expect(refusal).toContain(TAB_CAPTURE_ERRORS.linkFailed)
    expect(refusal).toContain('no sound within 3 seconds')
    expect(state.helpers[0]!.closed).toBe(1)
    expect(captures.list(worker)).toEqual([])
    expect(tabs.get(7)!.muted).toBe(false)
  })

  it('counts the three seconds from the moment the helper page began to read, not from the request', async () => {
    const { captures, worker, page, state } = setup()
    state.helperSends = false
    const id = captures.id(worker, { targetTabId: 7 })
    const pending = captures.listen(page, id)
    // The page was slow to begin: its three seconds are for the sound alone.
    await vi.advanceTimersByTimeAsync(FIRST_SOUND_MS - 1)
    captures.pcm(state.helpers[0]!.contentsId, chunk(0))
    expect(await pending).toEqual({ sampleRate: 48_000, channels: 1 })
  })

  it('ends the wait of the page at once when the capture ends before any sound came: no wait for the delay', async () => {
    const { captures, worker, page, state } = setup()
    state.helperHangs = true
    const id = captures.id(worker, { targetTabId: 7 })
    const pending = offerRefusal(() => captures.listen(page, id))
    expect(captures.stop(7)).toBe(false)
    expect(await pending).toContain('ended before the sound came')
    expect(state.helpers[0]!.closed).toBe(1)
  })

  it('ends the wait for the first sound at once when the capture ends after the helper page began: the person stops it, the tab is closed', async () => {
    for (const end of [(w: World) => w.captures.stop(7), (w: World) => w.captures.tabGone(7), (w: World) => w.captures.contentsGone(40)]) {
      const world = setup()
      world.state.helperSends = false
      const id = world.captures.id(world.worker, { targetTabId: 7 })
      const pending = offerRefusal(() => world.captures.listen(world.page, id))
      // The helper page began (the stream was given), and no sound came yet.
      await vi.advanceTimersByTimeAsync(0)
      expect(world.captures.mayShare(world.state.helpers[0]!.contentsId, 'default')).toBe(false)
      end(world)
      // No timer is advanced: the page is not left waiting for its three seconds.
      expect(await pending).toContain('ended before the sound came')
      expect(world.state.helpers[0]!.closed).toBe(1)
    }
  })

  it('leaves no timer behind, whether it answered or refused: the delays are for the wait only', async () => {
    const answered = setup()
    await answered.capture(7)
    expect(vi.getTimerCount()).toBe(0)
    const refused = setup()
    refused.state.helperFails = true
    const id = refused.captures.id(refused.worker, { targetTabId: 7 })
    await offerRefusal(() => refused.captures.listen(refused.page, id))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is refused, and the capture ends, when the first chunk cannot be handed to the page', async () => {
    const { captures, worker, page, state, tabs } = setup()
    state.failDeliver = true
    const id = captures.id(worker, { targetTabId: 7 })
    expect(await offerRefusal(() => captures.listen(page, id))).toContain(TAB_CAPTURE_ERRORS.linkFailed)
    expect(state.warnings.join('\n')).toContain('could not be handed to the page')
    expect(state.helpers[0]!.closed).toBe(1)
    expect(tabs.get(7)!.muted).toBe(false)
  })
})

describe('the sound: what the helper page sends, and who is handed it', () => {
  it('hands each chunk to the page that holds the claim, and to no other frame, whatever the other captures hold', async () => {
    const { capture, captures, state, page2 } = setup({ lent: [[EXT, 7], [EXT, 8]] })
    const first = await capture(7)
    const second = await capture(8, page2)
    state.delivered.length = 0
    captures.pcm(first.helper.contentsId, chunk(1))
    captures.pcm(second.helper.contentsId, chunk(1))
    captures.pcm(first.helper.contentsId, chunk(2))
    expect(state.delivered.map((each) => [each.claimId, each.frame])).toEqual([
      [first.id, { processId: 11, routingId: 3 }],
      [second.id, { processId: 12, routingId: 2 }],
      [first.id, { processId: 11, routingId: 3 }]
    ])
  })

  it('takes no chunk from a web contents that is no helper page: the page of the extension, a tab, one nobody knows', async () => {
    const { capture, captures, state } = setup()
    await capture(7)
    state.delivered.length = 0
    for (const contentsId of [40, 41, 7, 99_999]) captures.pcm(contentsId, chunk(5))
    expect(state.delivered).toEqual([])
    expect(captures.list({ extensionId: EXT, profileId: 'default', context: 'worker:5' })).toHaveLength(1)
    expect(state.warnings).toEqual([])
  })

  it('takes no chunk before the capture has begun: the helper page that is still asking for the screen sends none that count', async () => {
    const { captures, worker, page, state } = setup()
    state.helperHangs = true
    const id = captures.id(worker, { targetTabId: 7 })
    const pending = offerRefusal(() => captures.listen(page, id))
    captures.pcm(state.helpers[0]!.contentsId, chunk(0))
    expect(state.delivered).toEqual([])
    expect(captures.mayShare(state.helpers[0]!.contentsId, 'default')).toBe(true)
    captures.stop(7)
    await pending
  })

  it('drops what comes after the capture ended, without a word: a few chunks are on the way when it ends', async () => {
    const { capture, captures, state, page } = setup()
    const { id, helper } = await capture(7)
    captures.end(page, id)
    state.delivered.length = 0
    state.warnings.length = 0
    captures.pcm(helper.contentsId, chunk(1))
    captures.pcm(helper.contentsId, 'not bytes')
    expect(state.delivered).toEqual([])
    expect(state.warnings).toEqual([])
  })

  it('ends the capture, tells the page, destroys the helper page and gives the sound back when a chunk breaks a rule: and says which, never the sound', async () => {
    const lies = chunk(1, { frames: 10 }).slice(0, PCM_HEADER_BYTES + 3)
    // A chunk is at most 64 kB, a third of a second of mono sound at 48 kHz: the pace is broken by the second of two.
    const violations: Array<[string, unknown, string, ArrayBuffer?]> = [
      ['not bytes', 'abc', 'not bytes'],
      ['too long', new ArrayBuffer(PCM_MESSAGE_MAX + 1), 'longer than'],
      ['shorter than a header', new ArrayBuffer(8), 'shorter than a header'],
      ['a length that is not its header\'s', lies, 'length'],
      ['a rate out of range', chunk(1, { rate: 1_000 }), 'sample rate'],
      ['three channels', chunk(1, { channels: 3 }), 'channels'],
      ['a sequence that does not grow', chunk(0), 'sequence does not grow'],
      ['a format that changes', chunk(1, { rate: 44_100 }), 'format of the sound changed'],
      ['more sound than real time', chunk(2, { frames: 16_000, value: 0.123456 }), 'faster than real time', chunk(1, { frames: 16_000 })]
    ]
    for (const [name, raw, why, before] of violations) {
      const { capture, captures, state, tabs, worker } = setup()
      const { id, helper } = await capture(7)
      if (before) captures.pcm(helper.contentsId, before)
      state.delivered.length = 0
      captures.pcm(helper.contentsId, raw)
      expect(state.delivered, name).toEqual([])
      expect(captures.list(worker), name).toEqual([])
      expect(state.stopped, name).toEqual([[{ processId: 11, routingId: 3 }, id]])
      expect(helper.closed, name).toBe(1)
      expect(tabs.get(7)!.muted, name).toBe(false)
      const log = state.warnings.join('\n')
      expect(log, name).toContain(`sent a chunk of sound it must not (`)
      expect(log, name).toContain(why)
      // Nothing of the sound is in the log.
      expect(log, name).not.toMatch(/0\.1234|ArrayBuffer|Float32/)
    }
  })

  it('ends the capture, and asks the page to end its stream, when the helper page says the sound is over', async () => {
    const { capture, captures, state, tabs, events, worker } = setup()
    const { id, helper } = await capture(7)
    captures.pcm(helper.contentsId, new ArrayBuffer(0))
    expect(captures.list(worker)).toEqual([])
    expect(state.stopped).toEqual([[{ processId: 11, routingId: 3 }, id]])
    expect(helper.closed).toBe(1)
    expect(tabs.get(7)!.muted).toBe(false)
    expect(events.map((event) => event.kind)).toEqual(['started', 'ended'])
    expect(state.warnings).toEqual([])
  })

  it('ends the capture, with the cause in the log, when a chunk cannot be handed to the page', async () => {
    const { capture, captures, state, worker, tabs } = setup()
    const { helper } = await capture(7)
    state.failDeliver = true
    captures.pcm(helper.contentsId, chunk(1))
    expect(captures.list(worker)).toEqual([])
    expect(state.warnings.join('\n')).toContain('could not be handed to the page')
    expect(helper.closed).toBe(1)
    expect(tabs.get(7)!.muted).toBe(false)
  })

  it('judges the pace by the clock: what is too fast at once is right a moment later', async () => {
    const { capture, captures, state, worker } = setup()
    const { helper } = await capture(7)
    // 20 ms were taken: a third of a second more is inside the head start.
    captures.pcm(helper.contentsId, chunk(1, { frames: 16_000 }))
    expect(state.delivered).toHaveLength(2)
    // Ten times that at once would break the pace (see above); after a second it is what four times real time allows.
    vi.advanceTimersByTime(1_000)
    for (let seq = 2; seq < 12; seq++) captures.pcm(helper.contentsId, chunk(seq, { frames: 16_000 }))
    expect(state.delivered).toHaveLength(12)
    expect(captures.list(worker)).toHaveLength(1)
  })

  it('keeps nothing of a capture that ended: what judged its chunks is gone with it', async () => {
    const { capture, captures, page } = setup()
    const gates = (captures as unknown as { gates: Map<string, unknown> }).gates
    const { id } = await capture(7)
    expect(gates.size).toBe(1)
    captures.end(page, id)
    expect(gates.size).toBe(0)
  })

  it('judges each capture by itself: a new one begins at its own first chunk, whatever the last one reached', async () => {
    const { capture, captures, state, page } = setup()
    const first = await capture(7)
    captures.pcm(first.helper.contentsId, chunk(1))
    captures.end(page, first.id)
    const second = await capture(7)
    expect(state.warnings).toEqual([])
    expect(captures.capturedBy(7)).toMatchObject({ extensionId: EXT })
    expect(second.helper.contentsId).not.toBe(first.helper.contentsId)
  })
})

/** The helper pages that are still there: made, and not destroyed. */
const alive = (world: World): number => world.state.helpers.filter((helper) => helper.closed === 0).length

describe('no helper page is left alive', () => {
  it('when its claim is lost from under a request that is waiting: a flood of identifiers asked for meanwhile, or whatever else takes a claim out of the registry', async () => {
    const world = setup()
    const { captures, worker, page, state, registry } = world
    state.helperHangs = true
    const first = captures.id(worker, { targetTabId: 7 })
    const listening = offerRefusal(() => captures.listen(page, first))
    await vi.advanceTimersByTimeAsync(0)
    expect(alive(world)).toBe(1)
    // The worker of the extension asks for more identifiers than it may hold.
    for (let i = 0; i < PENDING_MAX; i++) captures.id(worker, { targetTabId: 7 })
    // Whatever then took the claim away (nothing says it ended), the page is not left behind when the request fails.
    registry.endWhere({})
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS)
    expect(await listening).toContain(TAB_CAPTURE_ERRORS.linkFailed)
    expect(alive(world)).toBe(0)
    expect(captures.isHelper(state.helpers[0]!.contentsId)).toBe(false)
  })

  it('does not lose the claim of a request that is waiting to a flood of identifiers: the claim goes on, and ends with the page', async () => {
    const world = setup()
    const { captures, worker, page, state } = world
    state.helperAsks = false
    state.helperHangs = true
    const first = captures.id(worker, { targetTabId: 7 })
    const listening = offerRefusal(() => captures.listen(page, first))
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < PENDING_MAX * 2; i++) captures.id(worker, { targetTabId: 7 })
    expect(captures.mayShare(state.helpers[0]!.contentsId, 'default')).toBe(true)
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS)
    expect(await listening).toContain('did not start in time')
    expect(alive(world)).toBe(0)
  })

  it('at the end of the application: every helper page goes, with a claim or without one', async () => {
    const world = setup({ lent: [[EXT, 7], [EXT, 8]] })
    const { captures, worker, page2, state, registry } = world
    // One capture that runs, and one request that waits for its page; then the registry loses the second one.
    await world.capture(7)
    state.helperHangs = true
    const waiting = offerRefusal(() => captures.listen(page2, captures.id(worker, { targetTabId: 8 })))
    await vi.advanceTimersByTimeAsync(0)
    expect(alive(world)).toBe(2)
    registry.endWhere({ contentsId: 41 })
    captures.shutdown()
    expect(alive(world)).toBe(0)
    expect(await waiting).toContain('ended before the sound came')
  })

  it('after each end, each failure and the end of the application: none is left, whatever way the capture went', async () => {
    const ways: Array<[string, (w: World) => Promise<void>]> = [
      ['a capture that ran and was stopped', async (w) => void (await w.capture(7), w.captures.stop(7))],
      ['a capture whose stream the page ended', async (w) => void w.captures.end(w.page, (await w.capture(7)).id)],
      ['a capture whose helper page failed to begin', async (w) => {
        w.state.helperFails = true
        await offerRefusal(() => w.captures.listen(w.page, w.captures.id(w.worker, { targetTabId: 7 })))
      }],
      ['a capture whose helper page began without the stream', async (w) => {
        w.state.helperAsks = false
        await offerRefusal(() => w.captures.listen(w.page, w.captures.id(w.worker, { targetTabId: 7 })))
      }],
      ['a capture that got no sound', async (w) => {
        w.state.helperSends = false
        const pending = offerRefusal(() => w.captures.listen(w.page, w.captures.id(w.worker, { targetTabId: 7 })))
        await vi.advanceTimersByTimeAsync(FIRST_SOUND_MS)
        await pending
      }],
      ['a capture ended by the helper page that sent too fast', async (w) => {
        const { helper } = await w.capture(7)
        w.captures.pcm(helper.contentsId, new ArrayBuffer(3))
      }],
      ['a request that never began, and the extension that went', async (w) => {
        w.state.helperHangs = true
        const pending = offerRefusal(() => w.captures.listen(w.page, w.captures.id(w.worker, { targetTabId: 7 })))
        await vi.advanceTimersByTimeAsync(0)
        w.captures.extensionGone('default', EXT)
        await pending
      }]
    ]
    for (const [name, way] of ways) {
      const world = setup()
      await way(world)
      expect(alive(world), name).toBe(0)
      world.captures.shutdown()
      expect(alive(world), `${name}, then the end of the application`).toBe(0)
    }
  })
})

describe('a flood of pages that listen', () => {
  /** Eight pages of the extension, each with an identifier for a tab of its own, in the profile `default`. */
  function flood() {
    const world = setup({ lent: [[EXT, 7], [EXT, 8]] })
    const senders: CaptureSender[] = []
    for (let n = 0; n < PENDING_MAX; n++) {
      const tab = 20 + n
      world.tabs.set(tab, { profileId: 'default', url: `https://tab-${n}.example.com/`, muted: false, locked: false })
      world.state.lent.set(`${EXT}:${tab}`, `https://tab-${n}.example.com`)
      senders.push({ extensionId: EXT, profileId: 'default', context: `frame:${50 + n}`, frame: { processId: 30 + n, routingId: n, contentsId: 50 + n } })
    }
    return { ...world, senders }
  }

  it('opens as many hidden windows as captures may run, and no more: the others are refused before any window is made', async () => {
    const world = flood()
    world.state.helperHangs = true
    const listening = world.senders.map((sender, n) => offerRefusal(() => world.captures.listen(sender, world.captures.id(world.worker, { targetTabId: 20 + n }))))
    await vi.advanceTimersByTimeAsync(0)
    expect(world.state.helpers).toHaveLength(CAPTURES_MAX)
    expect(alive(world)).toBe(CAPTURES_MAX)
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS)
    const answers = await Promise.all(listening)
    expect(answers.filter((answer) => answer.includes(TAB_CAPTURE_ERRORS.tooMany))).toHaveLength(PENDING_MAX - CAPTURES_MAX)
    expect(alive(world)).toBe(0)
  })

  it('counts a capture that runs with the requests that wait: one that runs and a second that waits are the most', async () => {
    const world = flood()
    await world.capture(7)
    world.state.helperHangs = true
    const listening = world.senders.slice(0, 3).map((sender, n) => offerRefusal(() => world.captures.listen(sender, world.captures.id(world.worker, { targetTabId: 20 + n }))))
    await vi.advanceTimersByTimeAsync(0)
    // The second helper page is the only one made: the first window is the capture that runs.
    expect(world.state.helpers).toHaveLength(2)
    expect(alive(world)).toBe(2)
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS)
    await Promise.all(listening)
    expect(alive(world)).toBe(1)
  })

  it('opens one window for a tab, however many pages ask for it, and says the tab is captured', async () => {
    const world = flood()
    world.state.helperHangs = true
    const ids = world.senders.slice(0, 3).map(() => world.captures.id(world.worker, { targetTabId: 20 }))
    const listening = world.senders.slice(0, 3).map((sender, n) => offerRefusal(() => world.captures.listen(sender, ids[n]!)))
    await vi.advanceTimersByTimeAsync(0)
    expect(world.state.helpers).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS)
    const answers = await Promise.all(listening)
    expect(answers.filter((answer) => answer.includes(TAB_CAPTURE_ERRORS.busy))).toHaveLength(2)
    expect(alive(world)).toBe(0)
  })
})

describe('the helper page', () => {
  it('is made for a claim, in the profile of the extension, one for each capture', async () => {
    const { capture, state, captures, page2 } = setup({ lent: [[EXT, 7], [EXT, 8]] })
    const first = await capture(7)
    const second = await capture(8, page2)
    expect(state.helpers).toHaveLength(2)
    expect(first.helper.contentsId).not.toBe(second.helper.contentsId)
    expect(captures.isHelper(first.helper.contentsId)).toBe(true)
    expect(captures.isHelper(second.helper.contentsId)).toBe(true)
    expect(captures.isHelper(40)).toBe(false)
    expect(captures.isHelper(123456)).toBe(false)
  })

  it('goes with the capture that made it, and not with another', async () => {
    const { capture, state, captures, page, page2 } = setup({ lent: [[EXT, 7], [EXT, 8]] })
    const first = await capture(7)
    const second = await capture(8, page2)
    captures.end(page, first.id)
    expect(first.helper.closed).toBe(1)
    expect(second.helper.closed).toBe(0)
    expect(captures.isHelper(second.helper.contentsId)).toBe(true)
    expect(state.warnings).toEqual([])
  })

  it('is destroyed once when the capture it carried ends, whichever way it ends', async () => {
    const endings: Array<[string, (w: World, id: string) => void]> = [
      ['the person stops the capture', (w) => void w.captures.stop(7)],
      ['the page of the extension ends its stream', (w, id) => w.captures.end(w.page, id)],
      ['the tab is closed', (w) => w.captures.tabGone(7)],
      ['the page of the extension goes away', (w) => w.captures.contentsGone(40)],
      ['the extension is switched off or removed', (w) => w.captures.extensionGone('default', EXT)],
      [
        'the person switches the whole function off',
        (w) => {
          w.state.featureOn = false
          w.captures.reconsider()
        }
      ],
      [
        'the person takes the permission back',
        (w) => {
          w.state.allowed.clear()
          w.captures.reconsider()
        }
      ],
      ['the tab goes to another site', (w) => w.captures.targetNavigated(7, 'https://elsewhere.example.com/')],
      ['the application quits', (w) => w.captures.shutdown()]
    ]
    for (const [name, end] of endings) {
      const world = setup()
      const { id, helper } = await world.capture(7)
      expect(helper.closed, name).toBe(0)
      end(world, id)
      expect(helper.closed, name).toBe(1)
      expect(world.captures.isHelper(helper.contentsId), name).toBe(false)
      expect(world.captures.mayShare(helper.contentsId, 'default'), name).toBe(false)
      expect(world.captures.list(world.worker), name).toEqual([])
    }
  })

  it('is destroyed when it was made and the capture never began, whichever way the claim ends', async () => {
    const endings: Array<[string, (w: World) => void]> = [
      ['the person stops', (w) => void w.captures.stop(7)],
      ['the tab is closed', (w) => w.captures.tabGone(7)],
      ['the page of the extension goes away', (w) => w.captures.contentsGone(40)],
      ['the extension is switched off or removed', (w) => w.captures.extensionGone('default', EXT)],
      ['the application quits', (w) => w.captures.shutdown()]
    ]
    for (const [name, end] of endings) {
      const world = setup()
      world.state.helperHangs = true
      const id = world.captures.id(world.worker, { targetTabId: 7 })
      const pending = offerRefusal(() => world.captures.listen(world.page, id))
      const helper = world.state.helpers[0]!
      expect(world.captures.mayShare(helper.contentsId, 'default'), name).toBe(true)
      end(world)
      expect(helper.closed, name).toBe(1)
      expect(world.captures.isHelper(helper.contentsId), name).toBe(false)
      expect(world.captures.mayShare(helper.contentsId, 'default'), name).toBe(false)
      expect(await pending, name).toContain('ended before the sound came')
    }
  })

  it('ends the capture it carried when it goes by itself (its window closed, its process died), and the page of the extension is asked to end its stream', async () => {
    const { capture, captures, tabs, state, events } = setup()
    const { id, helper } = await capture(7)
    captures.helperGone(helper.contentsId)
    expect(tabs.get(7)!.muted).toBe(false)
    expect(state.stopped).toEqual([[{ processId: 11, routingId: 3 }, id]])
    expect(events.map((event) => event.kind)).toEqual(['started', 'ended'])
    expect(captures.isHelper(helper.contentsId)).toBe(false)
    // A page whose process died still has its window: it is destroyed all the same.
    expect(helper.closed).toBe(1)
  })

  it('leaves the other captures alone when it goes', async () => {
    const { capture, captures, worker, page2 } = setup({ lent: [[EXT, 7], [EXT, 8]] })
    const first = await capture(7)
    await capture(8, page2)
    captures.helperGone(first.helper.contentsId)
    expect(captures.list(worker).map((entry) => entry.tabId)).toEqual([8])
    captures.helperGone(123456)
    expect(captures.list(worker)).toHaveLength(1)
  })

  it('says in the log when it cannot be destroyed, and the capture ends all the same', async () => {
    const { capture, captures, state, tabs } = setup()
    const { helper } = await capture(7)
    helper.close = () => {
      throw new Error('already destroyed')
    }
    expect(() => captures.stop(7)).not.toThrow()
    expect(state.warnings.join('\n')).toContain('could not be destroyed')
    expect(tabs.get(7)!.muted).toBe(false)
  })
})

describe('the screen: who may ask for it', () => {
  /** A helper page whose capture has not begun: the answer of the page of the extension is still being waited for. */
  const waiting = async (over: Parameters<typeof setup>[0] = {}) => {
    const world = setup(over)
    world.state.helperHangs = true
    const id = world.captures.id(world.worker, { targetTabId: 7 })
    const pending = offerRefusal(() => world.captures.listen(world.page, id))
    const helper = world.state.helpers[0]!
    return { ...world, id, helper, pending }
  }

  it('is held by the helper page of a capture that has not begun, for an extension that is allowed, in the profile it was made in', async () => {
    const { captures, helper } = await waiting()
    expect(captures.mayShare(helper.contentsId, 'default')).toBe(true)
  })

  it('is held by no one before a helper page exists, and by no page of an extension, whatever it claimed', async () => {
    const { captures, helper } = await waiting()
    // The page of the extension (web contents 40) took the identifier, and still holds nothing of the screen.
    expect(captures.mayShare(40, 'default')).toBe(false)
    expect(captures.mayShare(41, 'default')).toBe(false)
    expect(captures.mayShare(123456, 'default')).toBe(false)
    expect(captures.mayShare(helper.contentsId + 1, 'default')).toBe(false)
  })

  it('is not held in another profile than the one the helper page was made in, even for a profile the extension runs in and is allowed in', async () => {
    const { captures, helper, state } = await waiting()
    state.manifests[`work:${EXT}`] = MANIFEST
    state.allowed.add(`work:${EXT}`)
    expect(captures.mayShare(helper.contentsId, 'work')).toBe(false)
    expect(captures.mayShare(helper.contentsId, 'default')).toBe(true)
  })

  it('is not held once the person switched the capture off for the extension, switched the whole function off, or the extension no longer declares it', async () => {
    const off = await waiting()
    off.state.allowed.clear()
    expect(off.captures.mayShare(off.helper.contentsId, 'default')).toBe(false)
    const whole = await waiting()
    whole.state.featureOn = false
    expect(whole.captures.mayShare(whole.helper.contentsId, 'default')).toBe(false)
    const declared = await waiting()
    declared.state.manifests[`default:${EXT}`] = { permissions: ['activeTab'] }
    expect(declared.captures.mayShare(declared.helper.contentsId, 'default')).toBe(false)
  })

  it('is not held again once the stream was given: one request, one stream', async () => {
    const { captures, capture } = setup()
    const { helper } = await capture(7)
    expect(captures.mayShare(helper.contentsId, 'default')).toBe(false)
  })
})

describe('the stream: what the helper page is given', () => {
  it('is the sound of the tab it was made for, and the picture of the helper page itself, never anything of the tab', async () => {
    const { capture, state } = setup()
    const { stream, helper } = await capture(7)
    expect(stream?.audio).toEqual({ frameOfTab: 7 })
    // The picture is the helper page's own frame, which the page takes off its stream before it has it: the frame of the tab is only ever the sound.
    expect(stream?.video).toEqual({ id: helper.contentsId })
    expect(stream?.video).not.toEqual(stream?.audio)
    expect(state.streams).toHaveLength(1)
  })

  it('is refused to a request that names no frame, to a web contents that is no helper page, and to a page of another profile', async () => {
    const { captures, worker, page, state, tabs } = setup()
    state.helperHangs = true
    const id = captures.id(worker, { targetTabId: 7 })
    const pending = offerRefusal(() => captures.listen(page, id))
    const helper = state.helpers[0]!
    expect(captures.answerHelper({ frame: null }, helper.contentsId, 'default')).toBeNull()
    expect(captures.answerHelper({ frame: { id: 40 } }, 40, 'default')).toBeNull()
    expect(captures.answerHelper({ frame: { id: 41 } }, 41, 'default')).toBeNull()
    expect(captures.answerHelper({ frame: { id: helper.contentsId } }, helper.contentsId, 'work')).toBeNull()
    expect(state.warnings.join('\n')).toContain('holds no claim it may use')
    expect(tabs.get(7)!.muted).toBe(false)
    expect(captures.answerHelper({ frame: { id: helper.contentsId } }, helper.contentsId, 'default')).not.toBeNull()
    captures.stop(7)
    await pending
  })

  it('is given once for one identifier, and a second request does not end the capture that runs', async () => {
    const { captures, capture, worker, tabs } = setup()
    const { helper } = await capture(7)
    expect(captures.answerHelper({ frame: { id: helper.contentsId } }, helper.contentsId, 'default')).toBeNull()
    expect(captures.list(worker)).toHaveLength(1)
    expect(tabs.get(7)!.muted).toBe(true)
    expect(helper.closed).toBe(0)
  })

  it('is refused when the person switched the capture off since the identifier was made, with a notice', async () => {
    const { captures, worker, page, state, events } = setup()
    state.helperAsks = false
    const id = captures.id(worker, { targetTabId: 7 })
    const pending = offerRefusal(() => captures.listen(page, id))
    const helper = state.helpers[0]!
    state.allowed.clear()
    expect(captures.answerHelper({ frame: { id: helper.contentsId } }, helper.contentsId, 'default')).toBeNull()
    expect(events.map((event) => event.kind)).toEqual(['refused'])
    expect(state.muteCalls).toEqual([])
    expect(helper.closed).toBe(1)
    await pending
  })

  it('is refused when the whole function was switched off since the identifier was made, with no notice', async () => {
    const { captures, worker, page, state, events } = setup()
    state.helperAsks = false
    const id = captures.id(worker, { targetTabId: 7 })
    const pending = offerRefusal(() => captures.listen(page, id))
    const helper = state.helpers[0]!
    state.featureOn = false
    expect(captures.answerHelper({ frame: { id: helper.contentsId } }, helper.contentsId, 'default')).toBeNull()
    expect(events).toEqual([])
    expect(state.muteCalls).toEqual([])
    expect(state.warnings.join('\n')).toContain('switched off in Lucium')
    await pending
  })

  it('is refused when the extension no longer declares the permission, or the tab left the origin it was handed over on, was locked, or taken back', async () => {
    const changes: Array<(s: World) => void> = [
      (s) => (s.state.manifests[`default:${EXT}`] = { permissions: [] }),
      (s) => (s.tabs.get(7)!.url = 'https://elsewhere.example.com/'),
      (s) => (s.tabs.get(7)!.locked = true),
      (s) => s.state.lent.clear()
    ]
    for (const change of changes) {
      const held = setup()
      held.state.helperAsks = false
      const id = held.captures.id(held.worker, { targetTabId: 7 })
      const pending = offerRefusal(() => held.captures.listen(held.page, id))
      const helper = held.state.helpers[0]!
      change(held)
      expect(held.captures.answerHelper({ frame: { id: helper.contentsId } }, helper.contentsId, 'default')).toBeNull()
      expect(held.state.muteCalls).toEqual([])
      expect(helper.closed).toBe(1)
      await pending
    }
  })

  it('is refused when the tab is gone, or has no frame to take the sound from, or its sound cannot be read: and nothing is made silent', async () => {
    for (const how of ['gone', 'noFrame', 'unreadable'] as const) {
      const { captures, worker, page, state, tabs, host, events } = setup()
      state.helperAsks = false
      const id = captures.id(worker, { targetTabId: 7 })
      const pending = offerRefusal(() => captures.listen(page, id))
      const helper = state.helpers[0]!
      if (how === 'gone') tabs.delete(7)
      if (how === 'noFrame') host.targetFrame = () => null
      if (how === 'unreadable') host.muted = () => undefined
      expect(captures.answerHelper({ frame: { id: helper.contentsId } }, helper.contentsId, 'default'), how).toBeNull()
      expect(state.muteCalls, how).toEqual([])
      expect(events.map((event) => event.kind), how).not.toContain('started')
      expect(captures.list(worker), how).toEqual([])
      await pending
    }
  })

  it('is refused for a third tab while two are captured', async () => {
    const { captures, worker, state, tabs, page, page2 } = setup({ lent: [[EXT, 7], [EXT, 8], [EXT, 10]] })
    tabs.set(10, { profileId: 'default', url: 'https://third.example.com/', muted: false, locked: false })
    // Three identifiers are made while none is captured, then used one after the other.
    const ids = [7, 8, 10].map((tab) => captures.id(worker, { targetTabId: tab }))
    const third: CaptureSender = { extensionId: EXT, profileId: 'default', context: 'frame:42', frame: { processId: 13, routingId: 2, contentsId: 42 } }
    expect(await captures.listen(page, ids[0]!)).toEqual({ sampleRate: 48_000, channels: 1 })
    expect(await captures.listen(page2, ids[1]!)).toEqual({ sampleRate: 48_000, channels: 1 })
    // Refused when the page asks, before any window is made for it.
    expect(await offerRefusal(() => captures.listen(third, ids[2]!))).toBe(TAB_CAPTURE_ERRORS.tooMany)
    expect(tabs.get(10)!.muted).toBe(false)
    expect(state.helpers).toHaveLength(2)
  })

  it('drops the claim at once when the registry no longer has it to begin (it was not taken in time): the helper page holds nothing and goes', async () => {
    const { captures, worker, state, tabs, page, registry } = setup()
    state.helperAsks = false
    const pending = offerRefusal(() => captures.listen(page, captures.id(worker, { targetTabId: 7 })))
    const helper = state.helpers[0]!
    vi.spyOn(registry, 'start').mockReturnValueOnce({ ok: false, reason: 'no-claim' })
    expect(captures.mayShare(helper.contentsId, 'default')).toBe(true)
    expect(captures.answerHelper({ frame: { id: helper.contentsId } }, helper.contentsId, 'default')).toBeNull()
    // Before the page that waits has even been answered.
    expect(captures.mayShare(helper.contentsId, 'default')).toBe(false)
    expect(helper.closed).toBe(1)
    expect(tabs.get(7)!.muted).toBe(false)
    await pending
  })

  it('ends the capture when the stream cannot be handed to the page: the sound comes back, the helper page goes', async () => {
    const { capture, captures, tabs, state } = setup()
    const { stream, helper } = await capture(7)
    captures.abort(stream!.claim.id)
    expect(tabs.get(7)!.muted).toBe(false)
    expect(helper.closed).toBe(1)
    expect(state.stopped).toEqual([])
  })
})

describe('the sound of the tab while it is captured', () => {
  it('is silent for the person during the capture, and comes back as it was when it ends', async () => {
    const { capture, captures, tabs, page } = setup()
    const { id } = await capture(7)
    expect(tabs.get(7)!.muted).toBe(true)
    captures.end(page, id)
    expect(tabs.get(7)!.muted).toBe(false)
  })

  it('stays silent after the capture when it was silent before: the state before, not "not silent"', async () => {
    const { captures, state, tabs, capture, page } = setup({ lent: [[EXT, 8]] })
    const { id } = await capture(8)
    expect(tabs.get(8)!.muted).toBe(true)
    captures.end(page, id)
    expect(tabs.get(8)!.muted).toBe(true)
    expect(state.muteCalls).toEqual([[8, true], [8, true]])
  })

  it('comes back when the person stops the capture', async () => {
    const { capture, captures, tabs } = setup()
    await capture(7)
    expect(captures.stop(7)).toBe(true)
    expect(tabs.get(7)!.muted).toBe(false)
  })

  it('comes back when the page that listens goes away', async () => {
    const { capture, captures, tabs } = setup()
    await capture(7)
    captures.contentsGone(40)
    expect(tabs.get(7)!.muted).toBe(false)
  })

  it('comes back when the extension is switched off or removed', async () => {
    const { capture, captures, tabs } = setup()
    await capture(7)
    captures.extensionGone('default', EXT)
    expect(tabs.get(7)!.muted).toBe(false)
  })

  it('goes on when the same extension is switched off in another profile', async () => {
    const { capture, captures, tabs } = setup()
    await capture(7)
    captures.extensionGone('work', EXT)
    expect(tabs.get(7)!.muted).toBe(true)
    captures.extensionGone('default', OTHER)
    expect(tabs.get(7)!.muted).toBe(true)
  })

  it('comes back when the person switches the whole function off', async () => {
    const { capture, captures, tabs, state } = setup()
    await capture(7)
    state.featureOn = false
    captures.reconsider()
    expect(tabs.get(7)!.muted).toBe(false)
    expect(captures.capturedBy(7)).toBeUndefined()
  })

  it('goes on for an extension that is still allowed when the person takes the permission back from another', async () => {
    const { captures, worker, tabs, state, capture } = setup({ lent: [[EXT, 7], [OTHER, 8]] })
    await capture(7)
    const other: CaptureSender = { extensionId: OTHER, profileId: 'default', context: 'frame:41', frame: FRAME_2 }
    await captures.listen(other, captures.id({ ...worker, extensionId: OTHER }, { targetTabId: 8 }))
    state.allowed.delete(`default:${EXT}`)
    captures.reconsider()
    expect(tabs.get(7)!.muted).toBe(false)
    expect(captures.capturedBy(8)).toMatchObject({ extensionId: OTHER })
    expect(captures.capturedBy(7)).toBeUndefined()
  })

  it('comes back when the lock hides the tab (its space is locked, or the application is): the capture of another tab goes on', async () => {
    const world = setup({ lent: [[EXT, 7], [EXT, 8]] })
    await world.capture(7)
    await world.capture(8, world.page2)
    world.tabs.get(7)!.locked = true
    world.captures.reconsider()
    expect(world.tabs.get(7)!.muted).toBe(false)
    expect(world.captures.capturedBy(7)).toBeUndefined()
    expect(world.state.stopped.map(([, id]) => id)).toHaveLength(1)
    expect(world.captures.capturedBy(8)).toMatchObject({ extensionId: EXT })
    expect(world.tabs.get(8)!.muted).toBe(true)
  })

  it('comes back when the extension no longer holds tabCapture (an optional permission that is taken back): the capture of another extension goes on', async () => {
    const { captures, worker, tabs, state, capture } = setup({ lent: [[EXT, 7], [OTHER, 8]] })
    await capture(7)
    const other: CaptureSender = { extensionId: OTHER, profileId: 'default', context: 'frame:41', frame: FRAME_2 }
    await captures.listen(other, captures.id({ ...worker, extensionId: OTHER }, { targetTabId: 8 }))
    state.manifests[`default:${EXT}`] = { manifest_version: 3, permissions: ['activeTab', 'offscreen'] }
    captures.reconsider()
    expect(tabs.get(7)!.muted).toBe(false)
    expect(captures.capturedBy(7)).toBeUndefined()
    expect(state.stopped).toHaveLength(1)
    expect(captures.capturedBy(8)).toMatchObject({ extensionId: OTHER })
    expect(tabs.get(8)!.muted).toBe(true)
  })

  it('comes back when the extension is no longer loaded in the profile at all', async () => {
    const { capture, captures, tabs, state } = setup()
    await capture(7)
    delete state.manifests[`default:${EXT}`]
    captures.reconsider()
    expect(tabs.get(7)!.muted).toBe(false)
  })

  it('comes back when the person takes the permission back', async () => {
    const { capture, captures, tabs, state } = setup()
    await capture(7)
    state.allowed.clear()
    captures.reconsider()
    expect(tabs.get(7)!.muted).toBe(false)
  })

  it('comes back when the tab goes to another origin: the extension no longer holds it', async () => {
    const { capture, captures, tabs, state } = setup()
    await capture(7)
    tabs.get(7)!.url = 'https://elsewhere.example.com/'
    captures.targetNavigated(7, 'https://elsewhere.example.com/')
    expect(tabs.get(7)!.muted).toBe(false)
    expect(state.stopped).toHaveLength(1)
  })

  it('goes on while the tab stays on the origin it was handed over on', async () => {
    const { capture, captures, tabs, state } = setup()
    const { helper } = await capture(7)
    tabs.get(7)!.url = 'https://meet.example.com/another-room'
    captures.targetNavigated(7, 'https://meet.example.com/another-room')
    expect(tabs.get(7)!.muted).toBe(true)
    expect(captures.list({ extensionId: EXT, profileId: 'default', context: 'worker:5' })).toHaveLength(1)
    expect(state.stopped).toEqual([])
    expect(helper.closed).toBe(0)
  })

  it('goes on when another tab goes to another origin', async () => {
    const { capture, captures, tabs } = setup()
    await capture(7)
    tabs.get(8)!.url = 'https://elsewhere.example.com/'
    captures.targetNavigated(8, 'https://elsewhere.example.com/')
    expect(tabs.get(7)!.muted).toBe(true)
  })

  it('comes back when the application quits', async () => {
    const { capture, captures, tabs } = setup()
    await capture(7)
    captures.shutdown()
    expect(tabs.get(7)!.muted).toBe(false)
  })

  it('is not touched when the tab is gone: there is nothing to put back, and nothing is said of it', async () => {
    const { capture, captures, tabs, state } = setup()
    await capture(7)
    tabs.delete(7)
    state.muteCalls.length = 0
    captures.tabGone(7)
    expect(state.muteCalls).toEqual([])
  })

  it('goes back even when putting it back fails, and the log says so', async () => {
    const { capture, captures, state, events } = setup()
    await capture(7)
    state.failMute = true
    expect(() => captures.stop(7)).not.toThrow()
    expect(state.warnings.join('\n')).toContain('could not be put back')
    expect(events.map((event) => event.kind)).toEqual(['started', 'ended'])
  })
})

describe('the mark of a captured tab', () => {
  it('says that the capture began, and who listens', async () => {
    const { capture, captures, events } = setup()
    await capture(7)
    expect(events).toEqual([{ kind: 'started', tabNumber: 7, profileId: 'default', extensionId: EXT, name: 'Captions' }])
    expect(captures.capturedBy(7)).toEqual({ profileId: 'default', extensionId: EXT, name: 'Captions' })
    expect(captures.capturedBy(8)).toBeUndefined()
  })

  it('says that the capture ended, and whether the tab is silent now', async () => {
    const { capture, captures, events, tabs } = setup()
    tabs.get(7)!.muted = true
    await capture(7)
    captures.stop(7)
    expect(events.at(-1)).toEqual({ kind: 'ended', tabNumber: 7, profileId: 'default', extensionId: EXT, name: 'Captions', muted: true })
    expect(captures.capturedBy(7)).toBeUndefined()
  })

  it('says that the tab is not silent when it was not before', async () => {
    const { capture, captures, events } = setup()
    await capture(7)
    captures.stop(7)
    expect(events.at(-1)).toMatchObject({ kind: 'ended', muted: false })
  })

  it('says nothing of an identifier that never became a capture', async () => {
    const { captures, worker, page, events, state } = setup()
    state.helperAsks = false
    const id = captures.id(worker, { targetTabId: 7 })
    await offerRefusal(() => captures.listen(page, id))
    expect(events).toEqual([])
  })

  it('goes on ending and restoring when a listener fails, and the log says so', async () => {
    const { capture, captures, tabs, state } = setup()
    captures.onChange(() => {
      throw new Error('a listener bug')
    })
    await capture(7)
    expect(() => captures.stop(7)).not.toThrow()
    expect(tabs.get(7)!.muted).toBe(false)
    expect(state.warnings.join('\n')).toContain('a listener of the captures failed')
  })
})

describe('what the extension reads of what it captures', () => {
  it('lists the tabs it captures, in the profile it asks from, and no other extension\'s', async () => {
    const { capture, captures, worker, state } = setup()
    state.manifests[`work:${EXT}`] = MANIFEST
    expect(captures.list(worker)).toEqual([])
    await capture(7)
    expect(captures.list(worker)).toEqual([{ tabId: 7, status: 'active', fullscreen: false }])
    expect(captures.list({ extensionId: OTHER, profileId: 'default', context: 'worker:6' })).toEqual([])
    expect(captures.list({ extensionId: EXT, profileId: 'work', context: 'worker:7' })).toEqual([])
    state.manifests[`default:${EXT}`] = { permissions: [] }
    expect(refusalOf(() => captures.list(worker))).toBe(TAB_CAPTURE_ERRORS.noPermission)
  })
})

describe('ending a capture', () => {
  it('is done by the page that holds it when its tracks end, and only by it', async () => {
    const { capture, captures, page, tabs } = setup()
    const { id } = await capture(7)
    captures.end({ ...page, frame: { processId: 11, routingId: 4, contentsId: 41 } }, id)
    expect(tabs.get(7)!.muted).toBe(true)
    captures.end({ ...page, extensionId: OTHER }, id)
    expect(tabs.get(7)!.muted).toBe(true)
    captures.end({ ...page, profileId: 'work' }, id)
    expect(tabs.get(7)!.muted).toBe(true)
    captures.end(page, id)
    expect(tabs.get(7)!.muted).toBe(false)
  })

  it('looks up nothing of what is not the shape of an identifier: nothing the size of a document is searched', async () => {
    const { captures, page, registry } = setup()
    const looked = vi.spyOn(registry, 'get')
    for (const wrong of [12, null, undefined, {}, 'x'.repeat(10_000_000), '../../etc/passwd']) captures.end(page, wrong)
    expect(looked).not.toHaveBeenCalled()
    captures.end(page, '00000000-0000-4000-8000-000000000000')
    expect(looked).toHaveBeenCalledTimes(1)
  })

  it('is idempotent, and ignores what is not an identifier', async () => {
    const { capture, captures, page, state } = setup()
    const { id } = await capture(7)
    captures.end(page, id)
    state.muteCalls.length = 0
    captures.end(page, id)
    captures.end(page, 12)
    captures.end(page, { id })
    captures.end(page, 'x'.repeat(10_000_000))
    expect(state.muteCalls).toEqual([])
  })

  it('lets the tab be captured again once it ended', async () => {
    const { capture, captures, page, worker } = setup()
    const { id } = await capture(7)
    captures.end(page, id)
    expect(() => captures.id(worker, { targetTabId: 7 })).not.toThrow()
  })

  it('does not end the captures of the other tabs when one tab goes', async () => {
    const { captures, worker, tabs, state, capture, page2 } = setup({ lent: [[EXT, 7], [EXT, 8]] })
    await capture(7)
    await capture(8, page2)
    tabs.delete(7)
    captures.tabGone(7)
    expect(captures.list(worker).map((entry) => entry.tabId)).toEqual([8])
    expect(state.stopped).toHaveLength(1)
  })
})

describe('asking the page to end its stream', () => {
  it('asks the page that holds it when the person stops, switches off or removes, and leaves the page alone when it ended itself', async () => {
    const { capture, captures, state } = setup()
    const { id } = await capture(7)
    captures.stop(7)
    expect(state.stopped).toEqual([[{ processId: 11, routingId: 3 }, id]])
    // A page that ended by itself is not asked.
    const second = setup()
    const made = await second.capture(7)
    second.captures.end(second.page, made.id)
    expect(second.state.stopped).toEqual([])
  })

  it('replaces the document of a page that did not end its stream within the delay, and not one that did', async () => {
    const { capture, captures, state } = setup()
    await capture(7)
    captures.stop(7)
    vi.advanceTimersByTime(STOP_GRACE_MS - 1)
    expect(state.reloaded).toEqual([])
    vi.advanceTimersByTime(1)
    expect(state.reloaded).toEqual([40])
    expect(state.warnings.join('\n')).toContain('did not end its stream')
    // The page that answers in time is left alone.
    const second = setup()
    const made = await second.capture(7)
    second.captures.stop(7)
    second.captures.end(second.page, made.id)
    vi.advanceTimersByTime(STOP_GRACE_MS * 2)
    expect(second.state.reloaded).toEqual([])
  })

  it('does not take the answer of another page for the answer of the one that was asked', async () => {
    const { capture, captures, state, page } = setup()
    const { id } = await capture(7)
    captures.stop(7)
    captures.end({ ...page, frame: { processId: 99, routingId: 9, contentsId: 99 } }, id)
    vi.advanceTimersByTime(STOP_GRACE_MS)
    expect(state.reloaded).toEqual([40])
  })

  it('does not replace a document that is gone', async () => {
    const { capture, captures, state } = setup()
    await capture(7)
    captures.contentsGone(40)
    vi.advanceTimersByTime(STOP_GRACE_MS * 2)
    expect(state.stopped).toEqual([])
    expect(state.reloaded).toEqual([])
  })

  it('does not replace the document of a page that went away by itself while it was asked to end its stream', async () => {
    const { capture, captures, state } = setup()
    await capture(7)
    captures.stop(7)
    captures.contentsGone(40)
    vi.advanceTimersByTime(STOP_GRACE_MS * 2)
    expect(state.reloaded).toEqual([])
  })

  it('keeps waiting for the page of another web contents', async () => {
    const { capture, captures, state } = setup()
    await capture(7)
    captures.stop(7)
    captures.contentsGone(41)
    vi.advanceTimersByTime(STOP_GRACE_MS)
    expect(state.reloaded).toEqual([40])
  })

  it('says in the log when the page cannot be asked, or reloaded, and goes on', async () => {
    const { capture, captures, state } = setup()
    state.failStop = true
    state.failReload = true
    await capture(7)
    expect(() => captures.stop(7)).not.toThrow()
    vi.advanceTimersByTime(STOP_GRACE_MS)
    const log = state.warnings.join('\n')
    expect(log).toContain('could not be asked to end its stream')
    expect(log).toContain('could not be reloaded')
  })

  it('stops waiting for the pages when the application quits', async () => {
    const { capture, captures, state } = setup()
    await capture(7)
    captures.stop(7)
    captures.shutdown()
    vi.advanceTimersByTime(STOP_GRACE_MS * 2)
    expect(state.reloaded).toEqual([])
  })
})

describe('the person stops a capture', () => {
  it('takes the tab back from the extension: it has to be invoked again', async () => {
    const { capture, captures, state, worker } = setup()
    await capture(7)
    captures.stop(7)
    expect(state.revoked).toEqual([`${EXT}:7`])
    expect(refusalOf(() => captures.id(worker, { targetTabId: 7 }))).toBe(TAB_CAPTURE_ERRORS.notInvoked)
  })

  it('says whether something was captured', async () => {
    const { captures, worker, page, state } = setup()
    expect(captures.stop(7)).toBe(false)
    // An offer taken, whose capture has not begun, is not a capture: it is dropped, with its helper page, and nothing is said of one.
    state.helperHangs = true
    const pending = offerRefusal(() => captures.listen(page, captures.id(worker, { targetTabId: 7 })))
    const helper = state.helpers[0]!
    expect(captures.stop(7)).toBe(false)
    expect(captures.mayShare(helper.contentsId, 'default')).toBe(false)
    expect(helper.closed).toBe(1)
    await pending
  })
})
