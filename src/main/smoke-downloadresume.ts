// Engine checks for the resumption of downloads after a restart, run inside a real Electron against a local server that honours `Range` and
// `If-Range`: a download that Chromium gives up on is recorded, the "restart" is a new service reading the file again (the partial file is kept
// aside while Chromium cancels the old download, then put back), the click on "Reprendre" completes the file, and the file is compared byte for
// byte with what the server holds. Also: the refusals (the file changed on the server, no ranges, a record too old, a file outside the folder, a link),
// the single stream (the server never sees two requests for one file), the private window (nothing recorded), the setting off (no file, nothing run),
// and that the address with its token is in no log and no row. Called from the engine smoke test: `await smokeDownloadResume(ctx, check)`.

import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, type WebContents } from 'electron'
import { FINGERPRINT_BYTES, RESUME_FILE, RESUME_MAX_AGE_MS, type ResumeRecord } from '@shared/download-resume'
import type { DownloadInfo, Settings } from '@shared/model'
import { persistableState } from '@shared/sidebar'
import { singleStreamActive } from './engine/single-stream'
import { menuItems } from './shell/context-menus'
import { runningGates } from './shell/feature-gate'
import { getWindowManager } from './shell/windows'
import type { SmokeContext } from './smoke'
import { noteCheck, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 80)

const MIB = 1024 * 1024
const BIG_SIZE = 12 * MIB
/** What a cut connection delivers before it is dropped: Chromium resumes five times by itself, and then leaves the download interrupted. */
const DROP_BYTES = 1.5 * MIB
const LAST_MODIFIED = 'Wed, 01 Jan 2025 00:00:00 GMT'
/** An address token as a server may put one: it must be in the file of records and nowhere else. */
const TOKEN = 'smk_tok_7c1e4a9b2d' // gitleaks:allow (invented for the local test server, the secret of no service)
/** The addresses of the downloads made from a private context: one token each, all of this form. */
const CONTEXT_TOKEN = /smk_tok_[a-z]+_55aa/g
const contextToken = (name: string): string => `smk_tok_${name}_55aa`

const bytes = (size: number, seed = 1): Buffer => {
  const out = Buffer.alloc(size)
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 17 + (i >> 8)) & 255
  return out
}
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

interface Resource {
  content: Buffer
  etag: string
  ranges: boolean
  chunk: number
  delayMs: number
  /** What the server says its ETag is now (a file that changed since). */
  etagNow?: string
}

export async function smokeDownloadResume(ctx: SmokeContext, report: Check): Promise<void> {
  const { browser, store, engine, win, overlayView } = ctx
  // What a failing check prints must not carry the addresses the test is about.
  const check: Check = (name, ok, detail) => report(name, ok, detail?.replaceAll(TOKEN, '<jeton>').replace(CONTEXT_TOKEN, '<jeton>'))
  const ui = overlayView.webContents
  const state = () => store.get()
  const settingsNow = (): Settings => state().settings
  const evaluate = <T>(wc: WebContents, script: string) => wc.executeJavaScript(script) as Promise<T>
  const rectOf = (wc: WebContents, selector: string) =>
    evaluate<{ x: number; y: number; width: number; height: number } | null>(wc, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const countOf = (wc: WebContents, selector: string) => evaluate<number>(wc, `document.querySelectorAll(${JSON.stringify(selector)}).length`)
  const clickOn = async (wc: WebContents, selector: string): Promise<boolean> => {
    const r = await rectOf(wc, selector)
    if (!r) return false
    const x = Math.round(r.x + r.width / 2)
    const y = Math.round(r.y + r.height / 2)
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
    await sleep(150)
    return true
  }

  // ---- the server: ranges, If-Range, validators, a throttle, cuts ----
  const resources = new Map<string, Resource>()
  const big = bytes(BIG_SIZE)
  resources.set('/big.bin', { content: big, etag: '"big-1"', ranges: true, chunk: 256 * 1024, delayMs: 15 })
  resources.set('/slow.bin', { content: bytes(8 * MIB, 3), etag: '"slow-1"', ranges: true, chunk: 128 * 1024, delayMs: 80 })
  resources.set('/priv.bin', { content: bytes(BIG_SIZE, 5), etag: '"priv-1"', ranges: true, chunk: 256 * 1024, delayMs: 15 })
  resources.set('/small.bin', { content: bytes(2 * MIB, 7), etag: '"small-1"', ranges: true, chunk: 256 * 1024, delayMs: 5 })
  /** While true, every answer of a file longer than a few bytes is cut after `DROP_BYTES`. */
  let dropMode = false
  const requests: Array<{ path: string; range: string | undefined; ifRange: string | undefined }> = []
  /** Streams of more than a few bytes open at once, per path: two means the file is fetched in parts. */
  const open = new Map<string, number>()
  const mostOpen = new Map<string, number>()
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const resource = resources.get(url.pathname)
    if (!resource) {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      return void res.end('<title>Reprise des téléchargements</title><body style="margin:0"><h1>Reprise</h1></body>')
    }
    const range = req.headers.range
    const ifRange = req.headers['if-range']
    requests.push({ path: url.pathname, range, ifRange: Array.isArray(ifRange) ? ifRange[0] : ifRange })
    const etag = resource.etagNow ?? resource.etag
    const length = resource.content.length
    const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? '')
    let from = 0
    let to = length - 1
    let status = 200
    // A range is honoured when the server supports ranges and the condition of If-Range (if any) still holds.
    if (match && resource.ranges && (ifRange === undefined || ifRange === etag)) {
      from = Number(match[1])
      to = match[2] ? Math.min(Number(match[2]), length - 1) : length - 1
      status = 206
    }
    const headers: Record<string, string | number> = {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${url.pathname.slice(1)}"`,
      etag,
      'last-modified': LAST_MODIFIED,
      'accept-ranges': resource.ranges ? 'bytes' : 'none',
      'content-length': to - from + 1
    }
    if (status === 206) headers['content-range'] = `bytes ${from}-${to}/${length}`
    res.writeHead(status, headers)
    const wanted = to - from + 1
    if (wanted <= 8) return void res.end(resource.content.subarray(from, to + 1))
    const end = dropMode ? Math.min(to, from + DROP_BYTES - 1) : to
    let position = from
    open.set(url.pathname, (open.get(url.pathname) ?? 0) + 1)
    mostOpen.set(url.pathname, Math.max(mostOpen.get(url.pathname) ?? 0, open.get(url.pathname) ?? 0))
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      open.set(url.pathname, (open.get(url.pathname) ?? 1) - 1)
    }
    const timer = setInterval(() => {
      if (res.destroyed) return close()
      const next = Math.min(position + resource.chunk, end + 1)
      res.write(resource.content.subarray(position, next))
      position = next
      if (position > end) {
        close()
        if (end < to) setTimeout(() => res.destroy(), 60)
        else res.end()
      }
    }, resource.delayMs)
    res.on('close', close)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // ---- what the test watches: every line written to the console, the notices of the engine ----
  const written: string[] = []
  const realConsole = { log: console.log, warn: console.warn, error: console.error, debug: console.debug }
  for (const method of ['log', 'warn', 'error', 'debug'] as const) {
    console[method] = (...args: unknown[]) => {
      written.push(args.map((a) => (a instanceof Error ? `${a.name} ${a.message}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      realConsole[method](...args)
    }
  }
  const notices: string[] = []
  const resumeOptions = { profileLive: () => true, notify: (message: string) => void notices.push(message) }

  // ---- the places ----
  const root = mkdtempSync(join(tmpdir(), 'downloadresume-'))
  const folder = join(root, 'Downloads')
  mkdirSync(folder)
  const userData = app.getPath('userData')
  const file = join(userData, RESUME_FILE)
  const profilesBefore = settingsNow().profiles
  const original: Partial<Settings> = { profiles: profilesBefore, downloadResume: settingsNow().downloadResume, downloadPause: settingsNow().downloadPause, guestProfile: settingsNow().guestProfile, privateTabs: settingsNow().privateTabs, tabContainers: settingsNow().tabContainers }
  const patch = (changes: Partial<Settings>) => browser.dispatch({ type: 'settings/update', patch: changes })
  patch({ profiles: { ...profilesBefore, default: { ...profilesBefore['default'], downloadDir: folder } }, downloadResume: false, downloadPause: false })

  const service = () => (engine as unknown as { resume: { recordCount(): number } | null }).resume
  const adopt = (rows: DownloadInfo[]) => (browser as unknown as { adoptSavedDownloads(rows: DownloadInfo[]): void }).adoptSavedDownloads(rows)
  const recordsOnDisk = (): ResumeRecord[] => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { records: ResumeRecord[] }).records : [])
  const downloadsNow = () => browser.snapshot().downloads
  const dlById = (id: string) => downloadsNow().find((d) => d.id === id)
  browser.dispatch({ type: 'tab/open', url: `${base}/page` })
  const tab = state().tabs.at(-1)!
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  await waitFor(() => wcOf(tab.id) !== undefined && browser.snapshot().runtime.tabs[tab.id]?.loading === false)
  const page = wcOf(tab.id)!
  /** Starts a download from the page and answers the id of the row that appears. */
  const start = async (path: string, from: { downloadURL(url: string): void; id: () => string[] } = { downloadURL: (url) => page.downloadURL(url), id: () => downloadsNow().map((d) => d.id) }): Promise<string | null> => {
    const known = new Set(from.id())
    from.downloadURL(`${base}${path}`)
    return (await waitFor(() => from.id().some((id) => !known.has(id)), 10_000)) ? from.id().find((id) => !known.has(id))! : null
  }
  /** Waits until the row has been interrupted and has not moved for a while: Chromium's own attempts are over. */
  const interruptedFor = async (id: string, getRow: (id: string) => DownloadInfo | undefined = dlById): Promise<boolean> => {
    let last = -1
    let steady = 0
    return waitFor(() => {
      const row = getRow(id)
      if (row?.state === 'interrupted' && row.receivedBytes === last) steady++
      else steady = 0
      last = row?.receivedBytes ?? -1
      return steady >= 30
    }, 90_000)
  }
  const openPopover = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      browser.openOverlay({ panel: 'downloads' })
      if (await waitFor(async () => (await rectOf(ui, '.dlpop')) !== null, 2500)) break
    }
    await sleep(300)
  }
  /** A partial file as the engine would have left it, and the record that says so (the "restart" reads it back). */
  const forge = (name: string, size: number, offset: number, patchRecord: Partial<ResumeRecord> = {}, resource = '/big.bin', content = resources.get(resource)!.content): { path: string; record: ResumeRecord } => {
    const path = join(folder, name)
    writeFileSync(path, content.subarray(0, size))
    const r = resources.get(resource)!
    const record: ResumeRecord = {
      id: `rs-${sha(Buffer.from(name)).slice(0, 12)}`,
      profileId: 'default',
      url: `${base}${resource}?token=${TOKEN}`,
      path,
      offset,
      length: r.content.length,
      etag: r.etag,
      lastModified: LAST_MODIFIED,
      startTime: Date.now() / 1000 - 300,
      savedAt: Date.now() - 1000,
      head: sha(content.subarray(0, FINGERPRINT_BYTES)),
      tail: sha(content.subarray(offset - FINGERPRINT_BYTES, offset)),
      ...patchRecord
    }
    return { path, record }
  }
  /** The "restart": the service is stopped without a purge, the file of records is replaced, a new service reads it. */
  const restart = (records: ResumeRecord[]): DownloadInfo[] => {
    engine.stopDownloadResume(false)
    writeFileSync(file, `${JSON.stringify({ version: 1, records })}\n`, { mode: 0o600 })
    const rows = engine.startDownloadResume(resumeOptions)
    adopt(rows)
    return rows
  }
  const menuOf = (row: DownloadInfo) => menuItems({ kind: 'download', id: row.id }, browser, store, win)

  try {
    // ====================================================================================================================
    // Off by default: nothing is read, written or run
    // ====================================================================================================================
    check('downloadresume: the setting is off by default', original.downloadResume === false)
    check('downloadresume: off, no file of records, no service, no gate running', !existsSync(file) && service() === null && !runningGates().includes('download-resume'))
    const quiet = await start('/small.bin')
    check('downloadresume: off, a download completes as before and leaves no file of records', quiet !== null && (await waitFor(() => dlById(quiet!)?.state === 'completed', 20_000)) && !existsSync(file) && service() === null)
    check('downloadresume: off, the row carries no flag of the function', quiet !== null && dlById(quiet!)?.recorded === undefined)
    if (quiet) browser.clearDownload(quiet)

    // ====================================================================================================================
    // On: the file is made, owner-only, and the launch downloads in a single stream
    // ====================================================================================================================
    patch({ downloadResume: true })
    check('downloadresume: switched on, the service runs and the file of records exists', (await waitFor(() => service() !== null && existsSync(file))) && runningGates().includes('download-resume'))
    check('downloadresume: the file is readable by its owner alone', existsSync(file) && (statSync(file).mode & 0o777) === 0o600, existsSync(file) ? (statSync(file).mode & 0o777).toString(8) : 'absent')
    check('downloadresume: this run downloads in a single stream', singleStreamActive())

    // ====================================================================================================================
    // A download that Chromium gives up on is recorded
    // ====================================================================================================================
    dropMode = true
    const firstId = await start(`/big.bin?token=${TOKEN}`)
    check('downloadresume: the download starts', firstId !== null)
    const gaveUp = firstId !== null && (await interruptedFor(firstId))
    dropMode = false
    const gaveUpRow = firstId ? dlById(firstId) : undefined
    check('downloadresume: Chromium gives up after the cuts, the row is interrupted', gaveUp && gaveUpRow?.state === 'interrupted', JSON.stringify(gaveUpRow))
    const first = recordsOnDisk()[0]
    check('downloadresume: the record is on disk with the address, the path of the partial file and its validators', recordsOnDisk().length === 1 && first?.url === `${base}/big.bin?token=${TOKEN}` && first.path.startsWith(`${folder}/`) && first.etag === '"big-1"' && first.lastModified === LAST_MODIFIED && first.offset >= MIB && first.length === BIG_SIZE, JSON.stringify(first))
    check('downloadresume: the row says it can go on after a restart', gaveUpRow?.recorded === true && gaveUpRow.resumable === true)
    const partialPath = first?.path ?? ''
    const partialNow = existsSync(partialPath) ? readFileSync(partialPath) : Buffer.alloc(0)
    check('downloadresume: the partial file holds the first bytes of the file, from its first byte (no hole)', partialNow.length >= (first?.offset ?? Infinity) && partialNow.subarray(0, first?.offset ?? 0).equals(big.subarray(0, first?.offset ?? 0)))

    // The address is nowhere else: not in the state, not in what an export would carry, not in the other files of the data folder.
    const exported = JSON.stringify(persistableState(state()))
    const others = ['state.json', 'windows.json', 'history.json'].map((name) => join(userData, name)).filter(existsSync)
    check('downloadresume: the address is not in the state, an export or the other files of the data folder', !exported.includes(TOKEN) && others.every((path) => !readFileSync(path, 'utf8').includes(TOKEN)), others.join())

    // ====================================================================================================================
    // The restart: a new service reads the file again; the old download is gone, the partial file stays
    // ====================================================================================================================
    const recordId = first?.id ?? ''
    engine.stopDownloadResume(false)
    copyFileSync(partialPath, `${partialPath}.kept`)
    if (firstId) engine.cancelDownload(firstId)
    await waitFor(() => (firstId ? dlById(firstId)?.state === 'cancelled' : true), 10_000)
    await sleep(300)
    rmSync(partialPath, { force: true })
    copyFileSync(`${partialPath}.kept`, partialPath)
    rmSync(`${partialPath}.kept`)
    if (firstId) browser.clearDownload(firstId)
    const rows = engine.startDownloadResume(resumeOptions)
    adopt(rows)
    check('downloadresume: the restart gives back one interrupted row that can resume', rows.length === 1 && rows[0]?.id === recordId && rows[0].state === 'interrupted' && rows[0].resumable === true && rows[0].recorded === true, JSON.stringify(rows))
    check('downloadresume: the row shows host and path, never the token', rows[0]?.url === `${base}/big.bin` && !JSON.stringify(rows).includes(TOKEN) && !JSON.stringify(downloadsNow()).includes(TOKEN), rows[0]?.url)
    const hitsAfterRestart = requests.length
    // A fixed wait, for want of a witness: that nothing is asked while the user has not asked is what is checked, and a request the restart made by
    // itself would come with nothing after it.
    await sleep(500)
    check('downloadresume: nothing is asked of the server before the user asks', requests.length === hitsAfterRestart)

    await openPopover()
    check('downloadresume: the popover offers “Reprendre” for that row (the pause setting is off)', (await countOf(ui, '.dlpop-button[data-action="resume"]')) === 1 && (await countOf(ui, '.dlpop-button[data-action="pause"]')) === 0)
    const menu = menuOf(rows[0]!)
    check('downloadresume: the menu of the row offers it too, and cannot copy a link it does not hold', menu.some((item) => item.label === 'Reprendre le téléchargement') && menu.find((item) => item.label === 'Copier le lien de téléchargement')?.enabled === false)

    // ====================================================================================================================
    // “Reprendre”: the server is asked, then Chromium goes on from the offset, and the file is the server’s file
    // ====================================================================================================================
    const offset = first?.offset ?? 0
    const before = requests.length
    check('downloadresume: a real click on “Reprendre”', await clickOn(ui, '.dlpop-button[data-action="resume"]'))
    const completed = await waitFor(() => dlById(recordId)?.state === 'completed', 60_000)
    check('downloadresume: the same row completes (the download goes on in place)', completed, JSON.stringify(dlById(recordId)))
    const finalFile = existsSync(partialPath) ? readFileSync(partialPath) : Buffer.alloc(0)
    check('downloadresume: the file is the server’s file, byte for byte', finalFile.length === BIG_SIZE && sha(finalFile) === sha(big), `${finalFile.length} bytes`)
    const sent = requests.slice(before).filter((r) => r.path === '/big.bin')
    check('downloadresume: the server was asked first for the one byte at the offset, on the condition of the ETag', sent[0]?.range === `bytes=${offset}-${offset}` && sent[0].ifRange === '"big-1"', JSON.stringify(sent.slice(0, 3)))
    check('downloadresume: then Chromium asked for the rest from the offset, on the same condition', sent.some((r) => r.range === `bytes=${offset}-` && r.ifRange === '"big-1"'), JSON.stringify(sent))
    check('downloadresume: nothing before the offset was fetched again', sent.every((r) => r.range === undefined ? false : Number(/bytes=(\d+)-/.exec(r.range)?.[1]) >= offset))
    check('downloadresume: a finished download loses its record', recordsOnDisk().length === 0 && dlById(recordId)?.recorded !== true)
    check('downloadresume: no message was needed', notices.length === 0, notices.join(' | '))

    // ====================================================================================================================
    // One stream: the server never sees two requests for one file
    // ====================================================================================================================
    const slowId = await start('/slow.bin')
    const slowDone = slowId !== null && (await waitFor(() => dlById(slowId!)?.state === 'completed', 40_000))
    check('downloadresume: single stream: a slow file completes', slowDone)
    check('downloadresume: single stream: it was fetched over one connection at a time', (mostOpen.get('/slow.bin') ?? 0) === 1, String(mostOpen.get('/slow.bin')))
    check('downloadresume: single stream: and it is the server’s file', slowId !== null && existsSync(dlById(slowId)?.path ?? '') && sha(readFileSync(dlById(slowId)!.path)) === sha(resources.get('/slow.bin')!.content))

    // ====================================================================================================================
    // Refusals: each one tells why, asks nothing of Chromium, and keeps its promise about the files
    // ====================================================================================================================
    const askedChromium = (since: number, path: string, from: number) => requests.slice(since).some((r) => r.path === path && r.range === `bytes=${from}-`)
    {
      // The file changed on the server since.
      const { path, record } = forge('changed.bin', 3 * MIB, 2 * MIB)
      const rowsNow = restart([record])
      const since = requests.length
      resources.get('/big.bin')!.etagNow = '"big-2"'
      engine.resumeDownload(rowsNow[0]!.id)
      const told = await waitFor(() => notices.some((n) => n.includes('a changé sur le serveur')), 15_000)
      resources.get('/big.bin')!.etagNow = undefined
      check('downloadresume: a file that changed on the server is refused with a message', told, notices.join(' | '))
      check('downloadresume: …Chromium was not asked, the record and the partial file go', !askedChromium(since, '/big.bin', 2 * MIB) && recordsOnDisk().length === 0 && !existsSync(path))
      check('downloadresume: …the message names the file, not the address', notices.every((n) => !n.includes(TOKEN) && !n.includes('http')))
      notices.length = 0
      browser.clearDownload(rowsNow[0]!.id)
    }
    {
      // A server that does not honour ranges (it answers the whole file).
      const { path, record } = forge('noranges.bin', 3 * MIB, 2 * MIB)
      const rowsNow = restart([record])
      resources.get('/big.bin')!.ranges = false
      engine.resumeDownload(rowsNow[0]!.id)
      const told = await waitFor(() => notices.length > 0, 15_000)
      resources.get('/big.bin')!.ranges = true
      check('downloadresume: a server that ignores ranges is refused with a message, the partial file goes', told && recordsOnDisk().length === 0 && !existsSync(path), notices.join(' | '))
      notices.length = 0
      browser.clearDownload(rowsNow[0]!.id)
    }
    {
      // A record that outlived its time.
      const { path, record } = forge('old.bin', 3 * MIB, 2 * MIB, { savedAt: Date.now() - RESUME_MAX_AGE_MS - 60_000 })
      const rowsNow = restart([record])
      check('downloadresume: a record older than its lifetime is not offered, it is dropped with its partial file, and the user is told', rowsNow.length === 0 && recordsOnDisk().length === 0 && !existsSync(path) && notices.length === 1, notices.join(' | '))
      notices.length = 0
    }
    {
      // A path outside the downloads folder (a file that is not ours, whatever the record says).
      const outside = join(root, 'outside.bin')
      writeFileSync(outside, big.subarray(0, 3 * MIB))
      const { record } = forge('inside.bin', 3 * MIB, 2 * MIB, { path: outside })
      const rowsNow = restart([record])
      check('downloadresume: a path outside the downloads folder is never followed: dropped, the file untouched', rowsNow.length === 0 && recordsOnDisk().length === 0 && readFileSync(outside).equals(big.subarray(0, 3 * MIB)))
      notices.length = 0
    }
    {
      // A link where the partial file was.
      const target = join(root, 'precious.bin')
      writeFileSync(target, 'precious')
      const { path, record } = forge('link.bin', 3 * MIB, 2 * MIB)
      rmSync(path)
      symlinkSync(target, path)
      const rowsNow = restart([record])
      check('downloadresume: a link in place of the partial file is never followed: dropped, the target untouched', rowsNow.length === 0 && recordsOnDisk().length === 0 && readFileSync(target, 'utf8') === 'precious')
      rmSync(path, { force: true })
      notices.length = 0
    }
    {
      // A partial file that was modified below the offset.
      const { path, record } = forge('edited.bin', 3 * MIB, 2 * MIB)
      const edited = Buffer.from(big.subarray(0, 3 * MIB))
      edited[2 * MIB - 3] = edited[2 * MIB - 3]! ^ 0xff
      writeFileSync(path, edited)
      const rowsNow = restart([record])
      check('downloadresume: a partial file modified below the offset is dropped and left in place (it is not ours any more)', rowsNow.length === 0 && recordsOnDisk().length === 0 && readFileSync(path).equals(edited))
      rmSync(path, { force: true })
      notices.length = 0
    }
    {
      // The record file itself is hostile.
      engine.stopDownloadResume(false)
      writeFileSync(file, 'x'.repeat(600 * 1024))
      const rowsNow = engine.startDownloadResume(resumeOptions)
      check('downloadresume: a record file that is too large is removed unread, and nothing resumes from it', rowsNow.length === 0 && (!existsSync(file) || recordsOnDisk().length === 0) && written.some((line) => line.includes('cannot be read')))
      engine.stopDownloadResume(false)
      writeFileSync(file, `${JSON.stringify({ version: 1, records: [] })}\n`, { mode: 0o600 })
      engine.startDownloadResume(resumeOptions)
    }

    // ====================================================================================================================
    // Nothing is recorded from a private context: a private window, a guest window, a private tab of the main window, a container
    // ====================================================================================================================
    // Every one of them has its own session and a `scope` in the engine. Each makes a download that Chromium gives up on after 1.5 Mo, exactly
    // as the recorded one above (same size, same validators): the only reason left for no record is the rule. `resumable` on their row is
    // Chromium's own word for a live item that can go on (it is there with the function off too, and the popover hides it); what the function
    // adds is `recorded` and an `rs-` id, and the file of records.
    interface Context {
      downloadURL(url: string): void
      rows(): DownloadInfo[]
      resume(id: string): void
      close(): Promise<void>
    }
    const inPrivateContext = async (name: string, contextOf: () => Promise<Context>): Promise<void> => {
      const context = await contextOf()
      const recordsBefore = readFileSync(file, 'utf8')
      const secret = contextToken(name.replace(/[^a-z]/g, ''))
      dropMode = true
      const id = await start(`/priv.bin?token=${secret}`, { downloadURL: (url) => context.downloadURL(url), id: () => context.rows().map((d) => d.id) })
      const stuck = id !== null && (await interruptedFor(id, (rowId) => context.rows().find((d) => d.id === rowId)))
      dropMode = false
      const row = id ? context.rows().find((d) => d.id === id) : undefined
      const flags = JSON.stringify({ id: row?.id, state: row?.state, recorded: row?.recorded, resumable: row?.resumable })
      const recordsAfter = readFileSync(file, 'utf8')
      check(`downloadresume: ${name}: a download there is interrupted like any other`, stuck && row?.state === 'interrupted', flags)
      check(`downloadresume: ${name}: the file of records is unchanged`, recordsAfter === recordsBefore, `before=${recordsBefore.length} bytes, after=${recordsAfter.length} bytes`)
      check(`downloadresume: ${name}: no trace of its address in the file of records`, !recordsAfter.includes(secret))
      check(`downloadresume: ${name}: its row is not kept by a record (no flag, not a record’s id)`, row !== undefined && row.recorded === undefined && !/^rs-/.test(row.id), flags)
      const asked = requests.length
      context.resume(id ?? '')
      // A fixed wait, for want of a witness: a resumption goes through the checks of a record before it asks the server, and one that finds no
      // record ends without a sign.
      await sleep(500)
      check(`downloadresume: ${name}: asking to resume it reaches no record and nothing is asked of the server`, !requests.slice(asked).some((r) => r.path === '/priv.bin' && /^bytes=\d+-\d+$/.test(r.range ?? '')), JSON.stringify(requests.slice(asked)))
      await context.close()
    }
    const manager = getWindowManager()
    const ofWindow = (record: ReturnType<typeof manager.openPrivate>) => async (): Promise<Context> => {
      await waitFor(() => !record.win.webContents.isLoading())
      record.browser.dispatch({ type: 'tab/open', url: `${base}/page` })
      const tabId = record.store.get().tabs.at(-1)!.id
      await waitFor(() => record.browser.pageFor(tabId) !== undefined)
      const wc = (record.browser.pageFor(tabId) as unknown as { webContents: WebContents }).webContents
      await waitFor(() => !wc.isLoading())
      return {
        downloadURL: (url) => wc.downloadURL(url),
        rows: () => record.browser.snapshot().downloads,
        resume: (rowId) => record.browser.resumeDownload(rowId),
        close: async () => {
          record.win.close()
          await manager.settled()
        }
      }
    }
    await inPrivateContext('private window', ofWindow(manager.openPrivate()))

    patch({ guestProfile: true })
    const guest = manager.openGuest()
    check('downloadresume: guest window: the window manager opens one', guest !== null)
    if (guest) await inPrivateContext('guest window', ofWindow(guest))

    // A private tab and a container tab are tabs of the main window: their rows are in the main list, their sessions are not the profile’s.
    const ofTab = (tabId: string, closeAfter: () => void) => async (): Promise<Context> => {
      await waitFor(() => wcOf(tabId) !== undefined && browser.snapshot().runtime.tabs[tabId]?.loading === false)
      const wc = wcOf(tabId)!
      return {
        downloadURL: (url) => wc.downloadURL(url),
        rows: () => downloadsNow(),
        resume: (rowId) => browser.resumeDownload(rowId),
        close: async () => closeAfter()
      }
    }
    patch({ privateTabs: true })
    browser.dispatch({ type: 'tab/open', url: `${base}/page`, private: true })
    const privateTab = state().tabs.at(-1)!
    check('downloadresume: private tab: the tab is private', privateTab.private === true)
    await inPrivateContext('private tab', ofTab(privateTab.id, () => browser.dispatch({ type: 'tab/close', id: privateTab.id })))

    patch({ tabContainers: true })
    browser.dispatch({ type: 'container/create', name: 'Reprise', color: 'orange' })
    const container = settingsNow().containers.find((c) => c.name === 'Reprise')
    check('downloadresume: container tab: the container exists', container !== undefined)
    if (container) {
      browser.dispatch({ type: 'tab/open', url: `${base}/page`, container: container.id })
      const containerTab = state().tabs.at(-1)!
      check('downloadresume: container tab: the tab is in the container', containerTab.container === container.id)
      await inPrivateContext('container tab', ofTab(containerTab.id, () => browser.dispatch({ type: 'tab/close', id: containerTab.id })))
      browser.dispatch({ type: 'container/delete', id: container.id })
      check('downloadresume: container tab: the container is erased again', await waitFor(() => !settingsNow().containers.some((c) => c.id === container.id) && engine.containerCount() === 0, 20_000))
    }
    patch({ guestProfile: original.guestProfile ?? false, privateTabs: original.privateTabs ?? false, tabContainers: original.tabContainers ?? false })

    check('downloadresume: no address with a token was written anywhere but the file of records', !exported.includes(TOKEN) && recordsOnDisk().every((r) => !r.url.includes('smk_tok_') || r.url.includes(TOKEN)))

    // ====================================================================================================================
    // Off again: the file and the partial files that are ours go; a download that runs is left alone
    // ====================================================================================================================
    const { path: leftover, record: leftoverRecord } = forge('leftover.bin', 3 * MIB, 2 * MIB)
    restart([leftoverRecord])
    patch({ downloadResume: false })
    check('downloadresume: switched off, the service stops and the file of records is removed', await waitFor(() => service() === null && !existsSync(file)))
    check('downloadresume: …with the partial file that was ours', !existsSync(leftover))
    check('downloadresume: …and the rows that stood for records leave the popover', downloadsNow().every((d) => d.recorded !== true))
    const after = await start('/small.bin')
    check('downloadresume: switched off again, a download leaves no file of records', after !== null && (await waitFor(() => dlById(after!)?.state === 'completed', 20_000)) && !existsSync(file) && service() === null)

    // ====================================================================================================================
    // The address in no log
    // ====================================================================================================================
    const leaked = written.filter((line) => (line.includes(TOKEN) || line.includes('smk_tok_')) && !line.startsWith('DOWNLOADRESUME'))
    check('downloadresume: the address with its token is in no line written to the console', leaked.length === 0, leaked.slice(0, 2).join(' | ').slice(0, 300))
    check('downloadresume: no message to the user held it', notices.every((n) => !n.includes(TOKEN)))
  } finally {
    // A failure halfway must not leave a container, a guest setting or a private-tab setting behind for the suites that follow.
    for (const left of settingsNow().containers.filter((c) => c.name === 'Reprise')) browser.dispatch({ type: 'container/delete', id: left.id })
    patch({ downloadResume: original.downloadResume ?? false, downloadPause: original.downloadPause ?? false, profiles: profilesBefore, guestProfile: original.guestProfile ?? false, privateTabs: original.privateTabs ?? false, tabContainers: original.tabContainers ?? false })
    for (const method of ['log', 'warn', 'error', 'debug'] as const) console[method] = realConsole[method]
    for (const row of downloadsNow()) if (row.state !== 'progressing') browser.clearDownload(row.id)
    browser.dispatch({ type: 'tab/close', id: tab.id })
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
}

export async function runDownloadResumeSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    const verbose = process.env['LUCIUM_DOWNLOADRESUME_VERBOSE'] === '1'
    await smokeDownloadResume(ctx, (name, ok, detail) => {
      noteCheck(checks, name, ok, detail)
      if (verbose) console.log(`DOWNLOADRESUME ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` -- ${detail.slice(0, 400)}`}`)
    })
  } catch (error) {
    noteCheck(checks, 'smokeDownloadResume ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_DOWNLOADRESUME ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
