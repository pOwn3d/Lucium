// Engine checks of the origin an extension keeps with activeTab, run inside a real Electron with compat/active-tab-origin-probe, which the suite loads itself and
// takes out again (the other suites must not see it). A click on the icon lends the page the tab shows, on its origin and until the tab leaves it. The extension then
// sends the tab to another address (chrome.tabs.update asks for no permission) and, without waiting, asks for a script or a style sheet: the engine judged the tab on
// the page that was lent, and the call can reach the renderer when the tab already shows another one. What each call does is read in the page the tab ends on: a
// script that ran there (the mark it leaves on the document, the text of the page it answers), a style sheet that applies there. None may, whichever world the script
// runs in, whether it is a function or a file, whether the style sheet is of the author or of the user, and whatever sends the tab away (the extension, a redirect of the
// server, the page itself). What must keep working is checked too: the same origin after a pushState and after a new document, and an extension that holds the host
// permission, which is never asked for a loan. A local server is the only outside world. `LUCIUM_SMOKE_ONLY=activetab-origin` runs this file alone; LUCIUM_EXTENSIONS is
// not needed.
//
// One tab does it all: every page it shows carries the small script that talks to the worker of the probe, so no second page waits in the background (a page nobody
// looks at can be put away). The worker answers a `race` or a `burst` at once and keeps what its calls got; the suite asks for it from the page the tab ends on, and
// reads that page only then, when every call has been answered and nothing is still on its way to it: no wait of a fixed time.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, webContents as allWebContents, type WebContents } from 'electron'
import { activeProfileId } from '@shared/profiles'
import type { SmokeContext } from './smoke'
import { noteCheck, recorderOf, waiterOf, type CheckFn, type CheckRecord } from './smoke-kit'
import { settled } from './smoke-probe-kit'

const PROBE = 'Lucium Active Tab Origin Probe'
const PROBE_FOLDER = 'active-tab-origin-probe'
/** The text of every page of the other origin: if the extension reads it, the origin was not kept. */
const OTHER_TEXT = 'TEXT-OF-THE-OTHER-ORIGIN'
/** Where the calls fall in the time the tab takes to change documents is not known: each try pauses a different time (ms) between sending the tab away and the calls. */
const DELAYS = [0, 4, 9, 16, 28]
const TRIES = DELAYS.length
const BURST = 8

const waitFor = waiterOf(10_000, 60)

/** What every page of the lent origin carries: the way to ask the worker of an extension something, from a page of an origin its manifest lets in. */
const RPC_SCRIPT = `<script>
  window.rpc = (ext, message) => new Promise((resolve) => chrome.runtime.sendMessage(ext, message, (reply) => resolve(reply === undefined ? { ok: false, error: 'no reply: ' + (chrome.runtime.lastError && chrome.runtime.lastError.message) } : reply)))
</script>`

/** What one call of the probe answered. */
interface Reply {
  ok: boolean
  value?: unknown
  error?: string
}
/** What the probe kept of a `race` or a `burst`: whether the browser sent the tab away, and what each of the calls got. */
interface Raced {
  moved?: string | null
  results?: Reply[]
}
/** What the page the tab ended on says of itself, read by the suite in the page's own world. */
interface Evidence {
  href: string
  ran: string | null
  outline: string
}

const EVIDENCE_SCRIPT = `JSON.stringify({ href: location.href, ran: document.documentElement.getAttribute('data-lent-ran'), outline: getComputedStyle(document.documentElement).outlineWidth })`

type How = 'func' | 'file' | 'css' | 'css-file' | 'remove-css'
type Leaves = 'extension' | 'page'
interface Variant {
  id: string
  how: How
  world?: 'ISOLATED' | 'MAIN'
  origin?: 'AUTHOR' | 'USER'
  /** Where the tab goes: another port of the same host, another host, or an address of the lent origin that the server redirects to another host. */
  goes: 'other-origin' | 'other-site' | 'redirect'
  leaves: Leaves
}

const VARIANTS: readonly Variant[] = [
  { id: 'func, isolated world, another origin of the same host', how: 'func', world: 'ISOLATED', goes: 'other-origin', leaves: 'extension' },
  { id: 'file, isolated world, another origin of the same host', how: 'file', world: 'ISOLATED', goes: 'other-origin', leaves: 'extension' },
  { id: 'file, isolated world, a redirect of the server to another site', how: 'file', world: 'ISOLATED', goes: 'redirect', leaves: 'extension' },
  { id: 'file, isolated world, the page itself leaves for another site', how: 'file', world: 'ISOLATED', goes: 'other-site', leaves: 'page' },
  { id: 'func, world of the page, another origin of the same host', how: 'func', world: 'MAIN', goes: 'other-origin', leaves: 'extension' },
  { id: 'file, world of the page, another origin of the same host', how: 'file', world: 'MAIN', goes: 'other-origin', leaves: 'extension' },
  { id: 'func, world of the page, another site', how: 'func', world: 'MAIN', goes: 'other-site', leaves: 'extension' },
  { id: 'file, world of the page, another site', how: 'file', world: 'MAIN', goes: 'other-site', leaves: 'extension' },
  { id: 'style sheet of the author, another origin of the same host', how: 'css', origin: 'AUTHOR', goes: 'other-origin', leaves: 'extension' },
  { id: 'style sheet of the user, another origin of the same host', how: 'css', origin: 'USER', goes: 'other-origin', leaves: 'extension' },
  { id: 'style sheet of the user, another site', how: 'css', origin: 'USER', goes: 'other-site', leaves: 'extension' },
  { id: 'style sheet file, another origin of the same host', how: 'css-file', origin: 'AUTHOR', goes: 'other-origin', leaves: 'extension' },
  { id: 'style sheet file, a redirect of the server to another site', how: 'css-file', origin: 'AUTHOR', goes: 'redirect', leaves: 'extension' }
]

export async function smokeActiveTabOrigin(ctx: SmokeContext, check: CheckFn): Promise<void> {
  const { store, engine, browser } = ctx
  const profile = activeProfileId(store.get())
  const folder = join(app.getAppPath(), 'compat', PROBE_FOLDER)
  let probe: { id: string; name: string } | undefined
  try {
    probe = await engine.loadExtension(profile, folder)
  } catch (error) {
    check(`the probe extension "${PROBE}" is loaded`, false, `${folder}: ${String((error as Error)?.message ?? error)}`)
    return
  }
  check(`the probe extension "${PROBE}" is loaded`, probe.name === PROBE, `${folder} gave "${probe.name}" (${probe.id})`)
  if (probe.name !== PROBE) return

  const startTabs = new Set(store.get().tabs.map((t) => t.id))
  const prior = { sleepAfterMinutes: store.get().settings.sleepAfterMinutes }
  browser.dispatch({ type: 'settings/update', patch: { sleepAfterMinutes: 0 } })

  // ---- two servers: the lent origin, and the other (reached as 127.0.0.1 for another origin of the same site, as localhost for another site) ----
  const lentServer: RequestListener = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('cache-control', 'no-store')
    if (url.pathname === '/bounce') {
      res.statusCode = 302
      res.setHeader('location', url.searchParams.get('to') ?? '/')
      return void res.end()
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<title>A ${url.pathname}</title><body>PAGE-OF-THE-LENT-ORIGIN ${url.pathname}${RPC_SCRIPT}</body>`)
  }
  const otherServer: RequestListener = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<title>B ${url.pathname}</title><body>${OTHER_TEXT} ${url.pathname}${RPC_SCRIPT}</body>`)
  }
  const lent = createServer(lentServer)
  const other = createServer(otherServer)
  await new Promise<void>((resolve) => lent.listen(0, resolve))
  await new Promise<void>((resolve) => other.listen(0, resolve))
  const lentPort = (lent.address() as AddressInfo).port
  const otherPort = (other.address() as AddressInfo).port
  const lentOrigin = `http://127.0.0.1:${lentPort}`
  const otherOrigin = `http://127.0.0.1:${otherPort}`
  const otherSite = `http://localhost:${otherPort}`

  const wcOf = (tabId: string): WebContents | undefined => {
    const number = engine.tabNumberOf(tabId)
    return number === undefined ? undefined : (allWebContents.fromId(number) ?? undefined)
  }
  const titleOf = (tabId: string): string => store.get().tabs.find((t) => t.id === tabId)?.title ?? ''
  const hostFolders: string[] = []

  try {
    // The tab the extension is lent: the only one the checks use.
    browser.dispatch({ type: 'tab/open', url: `${lentOrigin}/first` })
    const target = store.get().tabs.at(-1)!
    const opened = (await waitFor(() => wcOf(target.id) !== undefined)) && (await waitFor(() => titleOf(target.id) === 'A /first'))
    const wc = wcOf(target.id)
    check('activeTab origin: the page of the lent origin loads', opened && wc !== undefined, `title "${titleOf(target.id)}"`)
    if (!wc) return
    const tabNumber = engine.tabNumberOf(target.id) ?? -1
    browser.dispatch({ type: 'tab/select', id: target.id })

    /** Asks the worker of an extension something, from the page the tab shows (a page of the lent origin: it has the way to ask). */
    const ask = <T>(extensionId: string, message: unknown, ms = 15_000): Promise<T> =>
      settled(wc.executeJavaScript(`window.rpc(${JSON.stringify(extensionId)}, ${JSON.stringify(message)})`) as Promise<T>, (why) => ({ ok: false, error: `no answer: ${why}` }) as T, ms)
    const awake = (extensionId: string): Promise<boolean> => waitFor(async () => (await ask<{ ok?: boolean }>(extensionId, { type: 'ping' }, 4000)).ok === true, 25_000)
    const loadLent = async (path: string): Promise<boolean> => {
      browser.pageFor(target.id)?.loadURL(`${lentOrigin}${path}`)
      return waitFor(() => titleOf(target.id) === `A ${path}` && !wc.isDestroyed() && !wc.isLoading())
    }
    const run = (extensionId: string, how: How, extra: { world?: 'ISOLATED' | 'MAIN'; origin?: 'AUTHOR' | 'USER' } = {}): Promise<Reply> =>
      ask<Reply>(extensionId, { type: 'run', tabId: tabNumber, how, world: extra.world, origin: extra.origin })
    /** The click: the tab is on screen, and the extension is lent it when a call of its own is answered (that call is the proof, not a pause). */
    const lendTo = async (extensionId: string): Promise<boolean> => {
      browser.dispatch({ type: 'tab/select', id: target.id })
      if (!(await waitFor(() => store.get().activeTabBySpace[store.get().activeSpaceId] === target.id))) return false
      await browser.activateExtension(extensionId)
      return waitFor(async () => (await run(extensionId, 'func', { world: 'ISOLATED' })).ok === true, 8000)
    }
    /** What the page the tab shows says of itself; `why` instead when it cannot be read, so that a try whose page is unreadable fails and never passes for want of evidence. */
    const evidenceOf = async (): Promise<Evidence | { why: string }> => {
      if (wc.isDestroyed()) return { why: 'the tab is gone' }
      const text = await settled(wc.executeJavaScript(EVIDENCE_SCRIPT) as Promise<unknown>, (why) => `unreadable: ${why}`, 8000)
      try {
        return JSON.parse(String(text)) as Evidence
      } catch (error) {
        return { why: `${String(text).slice(0, 120)} (${(error as Error).message})` }
      }
    }
    const outlineOf = (evidence: Evidence | { why: string }): string => ('outline' in evidence ? evidence.outline : evidence.why)
    /** What the worker kept of its last `race` or `burst`, asked from a page of the lent origin; waited for until its calls have all been answered. */
    const keptBy = async (extensionId: string): Promise<Raced> => {
      let kept: Raced | null = null
      await waitFor(async () => {
        kept = await ask<Raced | null>(extensionId, { type: 'last' }, 4000)
        return kept !== null && Array.isArray(kept.results)
      }, 15_000)
      return kept ?? { moved: 'the probe kept no answer' }
    }

    check('activeTab origin: the worker of the probe answers the page', await awake(probe.id))

    // ================= the witnesses: on the origin that was lent, what the click gives still works =================
    check('activeTab origin: before the click, the extension is refused', (await run(probe.id, 'func', { world: 'ISOLATED' })).ok === false)
    const lentOk = await lendTo(probe.id)
    check('activeTab origin: the click lends the tab: a function runs in the isolated world and answers the text of the page', lentOk, JSON.stringify(await run(probe.id, 'func', { world: 'ISOLATED' })))
    const inMain = await run(probe.id, 'file', { world: 'MAIN' })
    check('activeTab origin: ...a file runs in the world of the page', inMain.ok === true && String(inMain.value).includes('PAGE-OF-THE-LENT-ORIGIN'), JSON.stringify(inMain))
    const styled = await run(probe.id, 'css', { origin: 'AUTHOR' })
    const styledOutline = outlineOf(await evidenceOf())
    check('activeTab origin: ...a style sheet applies to the page', styled.ok === true && styledOutline === '7px', `${JSON.stringify(styled)}; outline ${styledOutline}`)
    const removed = await run(probe.id, 'remove-css', { origin: 'AUTHOR' })
    const removedOutline = outlineOf(await evidenceOf())
    check('activeTab origin: ...and the one the extension inserted can be taken away', removed.ok === true && removedOutline !== '7px', `${JSON.stringify(removed)}; outline ${removedOutline}`)

    // Same origin: a new entry of the history, then a new document, keep the loan.
    const pushed = await settled(wc.executeJavaScript(`history.pushState({}, '', '/pushed'); location.pathname`) as Promise<unknown>, (why) => why, 5000)
    const afterPush = await run(probe.id, 'func', { world: 'ISOLATED' })
    check('activeTab origin: a pushState on the same origin keeps the loan', pushed === '/pushed' && afterPush.ok === true && String(afterPush.value).includes('PAGE-OF-THE-LENT-ORIGIN'), `${String(pushed)}; ${JSON.stringify(afterPush)}`)
    void ask(probe.id, { type: 'race', tabId: tabNumber, url: `${lentOrigin}/same-origin-next`, how: 'func', world: 'ISOLATED', burst: BURST })
    const reachedNext = await waitFor(() => titleOf(target.id) === 'A /same-origin-next' && !wc.isLoading())
    const sameOrigin = await keptBy(probe.id)
    const sameResults = sameOrigin.results ?? []
    check(
      'activeTab origin: a new document of the same origin keeps the loan: every call made while the tab changes documents is answered',
      reachedNext && sameOrigin.moved === null && sameResults.length === BURST && sameResults.every((r) => r.ok === true && String(r.value).includes('PAGE-OF-THE-LENT-ORIGIN')),
      JSON.stringify(sameOrigin).slice(0, 600)
    )

    // ================= the race, for each way to run or to insert and each way to leave =================
    for (const variant of VARIANTS) {
      const seen = { breaches: [] as string[], ranInLent: 0, refused: 0, otherErrors: [] as string[], unreadable: [] as string[], neverArrived: 0, skipped: 0 }
      for (let i = 0; i < TRIES; i++) {
        const arrivedAt = `/b-${i}`
        const destination = variant.goes === 'other-origin' ? `${otherOrigin}${arrivedAt}` : `${otherSite}${arrivedAt}`
        const via = variant.goes === 'redirect' ? `${lentOrigin}/bounce?to=${encodeURIComponent(`${otherSite}${arrivedAt}`)}` : destination
        const loadedLent = await loadLent(`/race-${i}`)
        const lentOnClick = loadedLent && (await lendTo(probe.id))
        if (!loadedLent || !lentOnClick) {
          seen.skipped++
          const where = wc.isDestroyed() ? 'tab gone' : `tab at ${wc.getURL()}, title "${titleOf(target.id)}", loading ${wc.isLoading()}`
          seen.otherErrors.push(`try ${i}: ${loadedLent ? 'the click lent nothing' : 'the lent page did not load'} (${where})`)
          continue
        }
        // Started and not waited for: the page that asks is gone by the time the calls are answered, and the worker keeps what they got.
        if (variant.leaves === 'extension') void ask(probe.id, { type: 'race', tabId: tabNumber, url: via, how: variant.how, world: variant.world, origin: variant.origin, burst: BURST, delay: DELAYS[i] })
        else {
          void wc.executeJavaScript(`setTimeout(() => { location.href = ${JSON.stringify(via)} }, 0); 0`)
          void ask(probe.id, { type: 'burst', tabId: tabNumber, how: variant.how, world: variant.world, origin: variant.origin, burst: BURST })
        }
        const arrived = await waitFor(() => !wc.isDestroyed() && wc.getURL().includes(arrivedAt) && !wc.isLoading() && titleOf(target.id) === `B ${arrivedAt}`, 12_000)
        if (!arrived) seen.neverArrived++
        // What the calls got is asked from the page the tab ended on, which carries the way to ask; the page is read once they have all been answered.
        const answer = await keptBy(probe.id)
        const evidence = await evidenceOf()
        if ('why' in evidence) seen.unreadable.push(`try ${i}: ${evidence.why}`)
        else {
          if (evidence.ran && !evidence.ran.startsWith(lentOrigin)) seen.breaches.push(`try ${i}: a script of the extension ran in ${evidence.ran}`)
          if (evidence.outline === '7px' && !evidence.href.startsWith(lentOrigin)) seen.breaches.push(`try ${i}: a style sheet of the extension applies to ${evidence.href}`)
        }
        if (answer.moved) seen.otherErrors.push(`try ${i}: the browser did not send the tab away: ${answer.moved}`)
        for (const reply of answer.results ?? []) {
          if (reply.ok && typeof reply.value === 'string' && reply.value.includes(OTHER_TEXT)) seen.breaches.push(`try ${i}: the extension read the text of the other page`)
          else if (reply.ok) seen.ranInLent++
          else if (/Cannot access contents of the page/.test(reply.error ?? '')) seen.refused++
          else seen.otherErrors.push(`try ${i}: ${reply.error ?? 'no error'}`)
        }
      }
      const said = `${TRIES} tries of ${BURST} calls: ${seen.ranInLent} answered on the lent page, ${seen.refused} refused, ${seen.breaches.length} on the other origin${seen.breaches.length > 0 ? ` (${[...new Set(seen.breaches)].slice(0, 4).join('; ')})` : ''}; the tab reached the other page ${TRIES - seen.neverArrived} times; other: ${JSON.stringify([...new Set(seen.otherErrors)].slice(0, 4))}`
      check(
        `activeTab origin: ${variant.id}: nothing of the extension runs, applies or is read on the origin that was not lent`,
        seen.breaches.length === 0 && seen.neverArrived === 0 && seen.unreadable.length === 0 && seen.skipped === 0,
        `${said}${seen.unreadable.length > 0 ? `; page unreadable: ${JSON.stringify(seen.unreadable.slice(0, 3))}` : ''}`
      )
    }

    // ================= an extension that holds the host permission is never asked for a loan =================
    const hostFolder = mkdtempSync(join(tmpdir(), 'lucium-ato-host-'))
    hostFolders.push(hostFolder)
    cpSync(folder, hostFolder, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(hostFolder, 'manifest.json'), 'utf8')) as Record<string, unknown>
    writeFileSync(
      join(hostFolder, 'manifest.json'),
      JSON.stringify({ ...manifest, name: `${PROBE} (host permission)`, permissions: ['scripting'], host_permissions: [`${lentOrigin}/*`, `http://127.0.0.1/*`, `http://localhost/*`], action: undefined })
    )
    let withHosts: { id: string } | undefined
    try {
      withHosts = await engine.loadExtension(profile, hostFolder)
    } catch (error) {
      check('activeTab origin: the copy of the probe that holds the host permission is loaded', false, `${hostFolder}: ${String((error as Error)?.message ?? error)}`)
    }
    if (withHosts) {
      check('activeTab origin: the copy of the probe that holds the host permission is loaded', true, withHosts.id)
      const hostsId = withHosts.id
      check('activeTab origin: ...its worker answers the page', await awake(hostsId))
      const everywhere = await loadLent('/host-permission')
      // No click and no loan: it acts on the tab by its permission, on the origin it was on and on the one it goes to.
      const here = await run(hostsId, 'func', { world: 'ISOLATED' })
      void ask(hostsId, { type: 'race', tabId: tabNumber, url: `${otherSite}/b-host`, how: 'func', world: 'ISOLATED', burst: BURST })
      const reachedOther = await waitFor(() => titleOf(target.id) === 'B /b-host' && !wc.isLoading())
      const gone = await keptBy(hostsId)
      check(
        'activeTab origin: an extension that holds the host permission runs its script with no click, and still in the page the tab goes to (no loan is asked of it, and none is checked)',
        everywhere && reachedOther && here.ok === true && gone.moved === null && (gone.results ?? []).length === BURST && (gone.results ?? []).every((r) => r.ok === true),
        `${JSON.stringify(here)}; ${JSON.stringify(gone).slice(0, 500)}`
      )
    }
  } catch (error) {
    check('activeTab origin: the checks ran to the end', false, String((error as Error)?.stack ?? error))
  } finally {
    for (const tab of store.get().tabs) if (!startTabs.has(tab.id)) browser.dispatch({ type: 'tab/close', id: tab.id })
    browser.dispatch({ type: 'settings/update', patch: prior })
    lent.close()
    lent.closeAllConnections()
    other.close()
    other.closeAllConnections()
    // Nothing of the probe stays in the profile of the run, nor in the profiles made after this suite.
    const forget = engine as unknown as { forgetExtensionFolder(path: string): void }
    forget.forgetExtensionFolder(folder)
    for (const hostFolder of hostFolders) {
      forget.forgetExtensionFolder(hostFolder)
      rmSync(hostFolder, { recursive: true, force: true })
    }
  }
}

/** `LUCIUM_SMOKE_ONLY=activetab-origin`: only these checks, with their own report (the detail of every check, passed or not, says what was seen). */
export async function runActiveTabOriginSmoke(ctx: SmokeContext): Promise<number> {
  const checks: CheckRecord[] = []
  try {
    await smokeActiveTabOrigin(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeActiveTabOrigin ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_ACTIVETAB_ORIGIN ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
