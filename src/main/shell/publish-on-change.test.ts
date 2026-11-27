// What a page event and a publish cost the windows: an event of a page that changes nothing the
// interface shows publishes nothing; the colour of a page is read only for a page on screen; the layer of panels is sent the state only
// while a panel is open, and what it missed when the next one opens. The methods of the shell run on a stand-in (browser-fake.test-support.ts).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { UNREAD_HOLD_MS } from '@shared/tab-messages'
import { createInitialState } from '@shared/sidebar'
import { standIn } from '../stand-in.test-support'
import { fakeBrowser, methodsOf, overlayHost } from './browser-fake.test-support'
import { syncHost } from './sync-host.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const { UnreadWatch } = await import('./unread-watch')
const shell = methodsOf(Browser.prototype)

/** A window whose tab `t1` has a live page, on screen or not, at rest: loaded, silent, no unread count. */
function pageHost(own: Record<string, unknown> = {}) {
  const state = { tabs: [{ id: 't1', url: 'https://mail.example/', title: 'Mail', spaceId: 's', pinned: false, createdAt: 1, lastActiveAt: 1 }], settings: { tabStateBadges: false, siteUnreadOff: [] as string[] } }
  const fields = {
    runtime: { canGoBack: false, canGoForward: false, tabs: { t1: { loading: false, audible: false, muted: false, awake: true } } },
    store: { get: () => state, dispatch: vi.fn() },
    pages: new Map([['t1', { showsError: () => false }]]),
    visible: new Set(['t1']),
    colorUnread: new Set<string>(),
    unread: new UnreadWatch({ now: () => Date.now(), attended: () => false, changed: () => undefined }),
    frozen: new Set<string>(),
    committed: new Set<string>(),
    loadEnds: new Map(),
    autoReloader: null,
    shownTabId: 't1',
    historyOf: () => null,
    publish: vi.fn(),
    refreshPageColor: vi.fn(async () => undefined),
    handlePageUpdate: shell['handlePageUpdate'],
    readTitleUnread: shell['readTitleUnread'],
    shownUnread: shell['shownUnread'],
    refreshAllUnread: shell['refreshAllUnread'],
    refreshUnread: shell['refreshUnread'],
    leader: { backgroundEvents: 0 },
    ...own
  }
  const fake = fakeBrowser(fields)
  const update = (patch: Record<string, unknown>): void => void shell['onPageUpdate']!.call(fake.self, 't1', patch)
  return { fake, fields, update }
}

describe('a page event publishes only what changed', () => {
  it('publishes nothing for the end of a load in a page that shows as loaded (a frame that loaded inside it)', () => {
    const { fields, update } = pageHost()
    update({ loading: false, visit: false })
    expect(fields.publish).not.toHaveBeenCalled()
  })

  it('publishes a load that starts, and the end of it', () => {
    const { fields, update } = pageHost()
    update({ loading: true })
    update({ loading: false })
    expect(fields.publish).toHaveBeenCalledTimes(2)
  })

  it('leaves a title to the store, and publishes the unread count it carries', () => {
    const { fields, update } = pageHost()
    update({ title: 'Mail' })
    expect(fields.store.dispatch).toHaveBeenCalledWith({ type: 'tab/update', id: 't1', patch: { url: undefined, title: 'Mail', faviconUrl: undefined } })
    expect(fields.publish).not.toHaveBeenCalled()
    update({ title: '(3) Mail' })
    expect(fields.publish).toHaveBeenCalledTimes(1)
    update({ title: '(3) Mail' })
    expect(fields.publish).toHaveBeenCalledTimes(1)
  })

  // A certificate let through for the page's site: the interface says « Non sécurisé » from the runtime of the tab, never a padlock.
  it('keeps a certificate let through in the runtime of the tab until the page commits an address of a site with none', () => {
    const { fields, update } = pageHost()
    const entry = () => (fields.runtime as { tabs: Record<string, { untrustedCertificate?: true }> }).tabs['t1']!
    update({ untrustedCertificate: true })
    expect(entry().untrustedCertificate).toBe(true)
    expect(fields.publish).toHaveBeenCalledTimes(1)
    // A title, a load: the page is the same one, it stays not secure.
    update({ loading: true })
    update({ loading: false })
    expect(entry().untrustedCertificate).toBe(true)
    // The page committed another address, of a site whose certificate is valid.
    update({ url: 'https://mail.example/inbox', untrustedCertificate: false })
    expect(entry().untrustedCertificate).toBeUndefined()
  })

  it('publishes a change of the history of the page on screen, and of its sound', () => {
    const { fields, update } = pageHost()
    update({ canGoBack: true })
    update({ audible: true })
    expect(fields.publish).toHaveBeenCalledTimes(2)
  })

  it('publishes the Back button of the window coming on, even when the tab already knew it could go back', () => {
    const { fields, update } = pageHost({ runtime: { canGoBack: false, canGoForward: false, tabs: { t1: { loading: false, audible: false, muted: false, awake: true, canGoBack: true } } } })
    update({ canGoBack: true })
    expect(fields.publish).toHaveBeenCalledTimes(1)
  })

  it('publishes the countdown of a tab that reloads itself starting again at the end of a load', () => {
    let at = 1000
    const { fields, update } = pageHost({ autoReloader: { countdownOf: () => ({ at }), loaded: () => (at += 30_000) } })
    update({ loading: false })
    expect(fields.publish).toHaveBeenCalledTimes(1)
  })
})

describe('the colour of a page is read for a page on screen', () => {
  it('reads it at the end of a load of the page on screen', () => {
    const { fields, update } = pageHost()
    update({ loading: false })
    expect(fields.refreshPageColor).toHaveBeenCalledWith('t1')
    expect(fields.colorUnread.size).toBe(0)
  })

  it('does not run a script in a page that loaded off screen: it is read when the page comes on screen', () => {
    const { fields, update } = pageHost({ visible: new Set() })
    update({ loading: false })
    expect(fields.refreshPageColor).not.toHaveBeenCalled()
    expect(fields.colorUnread.has('t1')).toBe(true)
  })

  it('the browser reads the colour of a page left unread when it comes on screen, and only that one', () => {
    const left = syncHost(['https://mail.example/'])
    left.fake.self['colorUnread'] = new Set([left.active()!.id])
    shell['sync']!.call(left.fake.self)
    expect(left.fake.calls.filter((call) => call.name === 'refreshPageColor').map((call) => call.args[0])).toEqual([left.active()!.id])
    expect((left.fake.self['colorUnread'] as Set<string>).size).toBe(0)
    // A page whose colour was read already is not read again.
    const read = syncHost(['https://mail.example/'])
    read.fake.self['colorUnread'] = new Set<string>()
    shell['sync']!.call(read.fake.self)
    expect(read.fake.calls.filter((call) => call.name === 'refreshPageColor')).toEqual([])
  })
})

describe('the layer of panels is sent the state only while a panel is open', () => {
  function publisher(overlayRequest: unknown, overlayMissed = false) {
    const snapshot = { state: 'the snapshot' }
    const fake = fakeBrowser({ publishListeners: new Set(), snapshot: () => snapshot, surfaces: new Map(), floatingShown: false, overlayRequest, overlayMissed })
    shell['publishHere']!.call(fake.self)
    const sentTo = fake.calls.filter((call) => call.name.endsWith('.send') && call.args[0] === Channel.snapshot).map((call) => call.name)
    return { fake, sentTo }
  }

  it('sends the snapshot to the window, not to a closed layer, and remembers that the layer missed it', () => {
    const { fake, sentTo } = publisher(null)
    expect(sentTo).toEqual(['win.webContents.send'])
    expect(fake.self['overlayMissed']).toBe(true)
  })

  it('sends it to the layer while a panel is open', () => {
    const { fake, sentTo } = publisher({ panel: 'commandbar', mode: 'new', initial: '' }, true)
    expect(sentTo).toEqual(['win.webContents.send', 'overlay.webContents.send'])
    expect(fake.self['overlayMissed']).toBe(false)
  })

  it('sends the layer the state it missed before the panel that opens, once', () => {
    const fake = overlayHost({}, { overlayMissed: true, snapshot: () => ({ state: 'now' }), sendMissedSnapshot: shell['sendMissedSnapshot'] })
    shell['openOverlay']!.call(fake.self, { panel: 'shortcuts' })
    const sends = fake.calls.filter((call) => call.name === 'overlay.webContents.send').map((call) => call.args)
    expect(sends).toEqual([[Channel.snapshot, { state: 'now' }], [Channel.showOverlay, { panel: 'shortcuts' }]])
    expect(fake.self['overlayMissed']).toBe(false)
  })

  it('sends nothing more to a layer that missed nothing', () => {
    const fake = overlayHost({}, { overlayMissed: false, snapshot: () => ({ state: 'now' }), sendMissedSnapshot: shell['sendMissedSnapshot'] })
    shell['openOverlay']!.call(fake.self, { panel: 'shortcuts' })
    expect(fake.calls.filter((call) => call.name === 'overlay.webContents.send').map((call) => call.args[0])).toEqual([Channel.showOverlay])
  })
})

describe('the floating sidebar exists only while the sidebar is hidden', () => {
  function publishWith(floatingView: unknown, snapshot: Record<string, unknown>, floatingShown = false) {
    const fake = fakeBrowser({ publishListeners: new Set(), snapshot: () => snapshot, surfaces: new Map(), floatingShown, overlayRequest: null, overlayMissed: false, floating: { current: () => floatingView } })
    shell['publishHere']!.call(fake.self)
    return fake
  }
  const floatingView = () => {
    const sent: unknown[][] = []
    return { sent, webContents: { isDestroyed: () => false, send: (...args: unknown[]) => void sent.push(args) } }
  }

  it('is sent the snapshot while it shows, and once more as it stops, when it was made', () => {
    const view = floatingView()
    publishWith(view, { state: 'shown', floating: 'in' })
    publishWith(view, { state: 'gone' }, true)
    publishWith(view, { state: 'still gone' }, false)
    expect(view.sent).toEqual([[Channel.snapshot, { state: 'shown', floating: 'in' }], [Channel.snapshot, { state: 'gone' }]])
  })

  it('costs a publish nothing while it was not made', () => {
    const fake = publishWith(null, { state: 'shown', floating: 'in' })
    expect(fake.calls.filter((call) => call.name.endsWith('.send')).map((call) => call.name)).toEqual(['win.webContents.send'])
  })

  /** The holder of the floating sidebar, as the layout and the touch of the edge know it: any other member they touch throws. */
  const holder = () => {
    const calls: string[] = []
    return { calls, floating: standIn('floating', { want: (wanted: boolean) => void calls.push(`want ${wanted}`), current: () => null, ensure: () => void calls.push('ensure'), onMade: () => undefined }) }
  }

  it('is wanted by the layout while the sidebar is hidden, made at the touch of the edge, and reached only through its holder', () => {
    const stage = { x: 300, y: 40, width: 1000, height: 700 }
    const laidOut = (sidebarVisible: boolean) => {
      const base = createInitialState({ now: 0, newId: () => 'x' })
      const state = { ...base, settings: { ...base.settings, sidebarVisible } }
      const { calls, floating } = holder()
      const fake = fakeBrowser({ store: { get: () => state }, k: () => 1, toCss: (rect: unknown) => rect, fromCss: (rect: unknown) => rect, frame: () => ({ stage, panel: null }), fullscreenTab: null, pages: new Map(), sidePanel: null, webPanel: null, floatVisible: false, overlayRequest: null, peek: null, floating })
      shell['layout']!.call(fake.self)
      return calls
    }
    expect(laidOut(false)).toEqual(['want true'])
    expect(laidOut(true)).toEqual(['want false'])
    // The touch of the edge makes it (and a hand that leaves does not).
    const touch = holder()
    const hidden = { ...createInitialState({ now: 0, newId: () => 'x' }) }
    hidden.settings = { ...hidden.settings, sidebarVisible: false }
    shell['hotEdge']!.call(fakeBrowser({ floating: touch.floating, store: { get: () => hidden }, fullscreenTab: null, floatTimer: null, floatVisible: false, floatPhase: null }).self, true)
    expect(touch.calls).toEqual(['ensure'])
  })
})

describe('the unread messages of a tab follow its titles, and do not blink with them', () => {
  afterEach(() => vi.useRealTimers())

  /** A window with a Slack tab `t1` (off screen by default, in a window not in front) whose unread memory is the real one, wired as the window wires it. */
  function slackHost(over: { visible?: Set<string>; focused?: boolean } = {}) {
    vi.useFakeTimers({ now: 5_000_000 })
    const state = { tabs: [{ id: 't1', url: 'https://app.slack.com/client/T1/D1', title: 'Loic', spaceId: 's', pinned: false, createdAt: 1, lastActiveAt: 1 }], settings: { tabStateBadges: false, siteUnreadOff: [] as string[] } }
    const visible = over.visible ?? new Set<string>()
    const host = pageHost({ visible, store: { get: () => state, dispatch: vi.fn() }, win: { isDestroyed: () => false, isFocused: () => over.focused === true }, refreshUnread: shell['refreshUnread'] })
    const unread = new UnreadWatch({
      now: () => Date.now(),
      attended: (id) => visible.has(id) && over.focused === true,
      changed: (id) => void shell['refreshUnread']!.call(host.fake.self, id)
    })
    host.fields.unread = unread as never
    const entry = () => (host.fields.runtime as { tabs: Record<string, { unread?: number; unreadMark?: string }> }).tabs['t1']!
    return { ...host, entry, unread, state }
  }

  // A site whose count is turned off: its row shows neither the count nor the mark, whatever its title says; the others keep them.
  it('shows no count and no mark for a site whose count is turned off, and keeps showing them for another site', () => {
    const off = slackHost()
    off.state.settings.siteUnreadOff = ['slack.com']
    off.update({ title: '(2) Loic - Slack' })
    off.update({ title: '! Loic - Slack' })
    expect(off.entry().unread).toBeUndefined()
    expect(off.entry().unreadMark).toBeUndefined()
    expect(off.unread.current('t1')).toBeUndefined()
    // A neighbouring site that is not on the list (a list entry is a domain, not a prefix of a host) is read as before.
    const kept = slackHost()
    kept.state.settings.siteUnreadOff = ['lack.com', 'other.example']
    kept.update({ title: '(2) Loic - Slack' })
    expect(kept.entry().unread).toBe(2)
    // The global switch of the badges does not decide it.
    expect(kept.state.settings.tabStateBadges).toBe(false)
  })

  it('takes the count already on screen away when the site is turned off, and shows the next title again once it is turned back on', () => {
    const { update, entry, state, fields } = slackHost()
    update({ title: '(2) Loic - Slack' })
    expect(entry().unread).toBe(2)
    state.settings.siteUnreadOff = ['app.slack.com']
    fields.publish.mockClear()
    shell['refreshAllUnread']!.call(fakeBrowser(fields).self)
    expect(entry().unread).toBeUndefined()
    expect(fields.publish).toHaveBeenCalledTimes(1)
    state.settings.siteUnreadOff = []
    // Nothing comes back by itself (the memory was dropped), the next title says it.
    shell['refreshAllUnread']!.call(fakeBrowser(fields).self)
    expect(entry().unread).toBeUndefined()
    update({ title: '(3) Loic - Slack' })
    expect(entry().unread).toBe(3)
  })

  it('shows the count a Slack title says, and the mark of a title that has none', () => {
    const { update, entry } = slackHost()
    update({ title: '(2) Loic - Slack' })
    expect(entry().unread).toBe(2)
    update({ title: '! Loic - Slack' })
    expect(entry()).toMatchObject({ unread: 2 })
    expect(entry().unreadMark).toBeUndefined()
  })

  it('shows the mark of a Slack title when no count was ever said', () => {
    const { update, entry, fields } = slackHost()
    update({ title: '* Loic - Slack' })
    expect(entry().unreadMark).toBe('*')
    expect(entry().unread).toBeUndefined()
    expect(fields.publish).toHaveBeenCalledTimes(1)
  })

  // THE GUARD of the hold, as the window wires it: a title that says nothing does not publish the badge away.
  it('does not publish a badge away when a title says nothing, and publishes it away once the hold is over', () => {
    const { update, entry, fields } = slackHost()
    update({ title: '(2) Loic - Slack' })
    fields.publish.mockClear()
    update({ title: 'Loic - Slack' })
    expect(entry().unread).toBe(2)
    expect(fields.publish).not.toHaveBeenCalled()
    vi.advanceTimersByTime(UNREAD_HOLD_MS)
    expect(entry().unread).toBeUndefined()
    expect(fields.publish).toHaveBeenCalledTimes(1)
  })

  it('keeps the badge through an event of the page that carries no title (a load, a sound)', () => {
    const { update, entry } = slackHost()
    update({ title: '(2) Loic - Slack' })
    update({ loading: true })
    update({ loading: false })
    update({ audible: true })
    expect(entry().unread).toBe(2)
  })

  // THE GUARD of the reading, as the window wires it: the tab on screen, in the window in front, loses its badge with the title that no longer says it.
  it('takes the badge away at once in a tab that is on screen in the window in front', () => {
    const { update, entry } = slackHost({ visible: new Set(['t1']), focused: true })
    update({ title: '(2) Loic - Slack' })
    update({ title: 'Loic - Slack' })
    expect(entry().unread).toBeUndefined()
  })

  it('holds the badge in a tab that is on screen in a window that is not in front', () => {
    const { update, entry } = slackHost({ visible: new Set(['t1']), focused: false })
    update({ title: '(2) Loic - Slack' })
    update({ title: 'Loic - Slack' })
    expect(entry().unread).toBe(2)
  })

  it('publishes a badge that went without a title (the tab came on screen), once', () => {
    const { update, entry, fields, unread } = slackHost()
    update({ title: '(2) Loic - Slack' })
    update({ title: 'Loic - Slack' })
    fields.publish.mockClear()
    expect(unread.appeared('t1')).toBe(true)
    shell['refreshUnread']!.call(fakeBrowser(fields).self, 't1')
    expect(entry().unread).toBeUndefined()
    expect(fields.publish).toHaveBeenCalledTimes(1)
    shell['refreshUnread']!.call(fakeBrowser(fields).self, 't1')
    expect(fields.publish).toHaveBeenCalledTimes(1)
  })

  it('the browser lets a held badge go when a tab comes on screen, and forgets the memory with the page', () => {
    // A tab that comes on screen (the shown tab changes): its held badge is read again.
    const appeared = vi.fn(() => true)
    const host = syncHost(['https://app.slack.com/client/T1/D1'], undefined, { shownTabId: null, unread: { appeared } })
    shell['sync']!.call(host.fake.self)
    const id = host.active()!.id
    expect(appeared).toHaveBeenCalledExactlyOnceWith(id)
    expect(host.fake.calls.filter((call) => call.name === 'refreshUnread').map((call) => call.args[0])).toEqual([id])
    // The same tab staying on screen is not a tab that comes on screen.
    const staying = syncHost(['https://app.slack.com/client/T1/D1'], undefined, { unread: { appeared } })
    appeared.mockClear()
    shell['sync']!.call(staying.fake.self)
    expect(appeared).not.toHaveBeenCalled()
    // The page goes: the memory of its titles goes with it.
    const forget = vi.fn()
    shell['dropPageState']!.call(fakeBrowser({ store: { get: () => ({ tabs: [] }) }, runtime: { tabs: {} }, unread: { forget } }).self, 't1')
    expect(forget).toHaveBeenCalledExactlyOnceWith('t1')
  })
})
