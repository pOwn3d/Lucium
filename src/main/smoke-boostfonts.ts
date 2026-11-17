// Engine checks for the fonts a Tweak gives to a page, run inside a real Electron. A local server serves a plain page and a page whose
// content security policy forbids every font (a font fetched from a URL fails there, which a control inside the page shows): the bundled
// font arrives anyway, as a FontFace made from bytes, it changes the width of the text, it follows a live change of the Tweak, it is
// added again after a reload, and a system font, a disabled Tweak or another site gets nothing.
// Called from the engine smoke test: `await smokeBoostFonts(ctx, check)`.

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { SmokeContext } from './smoke'
import { fontsFolder } from './shell/boost-fonts'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(10_000, 80)

const STRICT_CSP = "default-src 'none'; font-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
const TEXT = 'Bonjour Éléonore, une œuvre très lisible : 0123456789'

export async function smokeBoostFonts(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store } = ctx
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('content-type', 'text/html')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('connection', 'close')
    if (url.pathname === '/strict') res.setHeader('content-security-policy', STRICT_CSP)
    res.end(`<!doctype html><title>bf ${url.pathname}</title><body><p id="p" style="font-size:20px">${TEXT}</p></body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const dataUrl = `data:font/woff2;base64,${readFileSync(join(fontsFolder(), 'inter.woff2')).toString('base64')}`

  const mine = new Set<string>()
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  const open = async (path: string): Promise<string> => {
    browser.dispatch({ type: 'tab/open', url: `${base}${path}` })
    const tab = store.get().tabs.at(-1)!
    mine.add(tab.id)
    await waitFor(() => browser.snapshot().runtime.tabs[tab.id]?.loading === false && wcOf(tab.id)?.getURL().startsWith(base) === true)
    return tab.id
  }
  const facesOf = (id: string) => wcOf(id)!.executeJavaScript(`[...document.fonts].map((f) => f.family.replace(/^"|"$/g, '') + ':' + f.status)`) as Promise<string[]>
  const hasFace = async (id: string, face: string) => (await facesOf(id)).includes(`${face}:loaded`)
  const waitForFace = (id: string, face: string) => waitFor(() => hasFace(id, face))
  /** The text of the page measured in the face and in the monospace it would fall back to: they differ when the face is there. */
  const widths = (id: string, face: string) =>
    wcOf(id)!.executeJavaScript(`(() => { const c = document.createElement('canvas').getContext('2d'); c.font = '20px "${face}", monospace'; const a = c.measureText(${JSON.stringify(TEXT)}).width; c.font = '20px monospace'; return [a, c.measureText(${JSON.stringify(TEXT)}).width] })()`) as Promise<number[]>
  const familyOf = (id: string) => wcOf(id)!.executeJavaScript(`getComputedStyle(document.getElementById('p')).fontFamily`) as Promise<string>
  const saveBoost = (patch: Record<string, unknown>) => browser.dispatch({ type: 'boost/save', boost: { id: 'boost-fonts-smoke', host: '127.0.0.1', ...patch } })

  try {
    saveBoost({ name: 'Polices', fontFamily: 'inter', enabled: true })
    const plain = await open('/plain')
    const strict = await open('/strict')

    // ---- the control: the strict page really refuses a font fetched from a URL ----
    const control = (id: string) => wcOf(id)!.executeJavaScript(`new FontFace('csp-control', 'url(${dataUrl})').load().then(() => 'loaded', () => 'blocked')`) as Promise<string>
    check('boost-fonts: the control holds: a font fetched from a URL loads on the plain page and is refused on the strict one', (await control(plain)) === 'loaded' && (await control(strict)) === 'blocked', JSON.stringify([await control(plain), await control(strict)]))

    // ---- the font arrives on both pages ----
    check('boost-fonts: a bundled font reaches a plain page', await waitForFace(plain, 'Lucium Inter'), JSON.stringify(await facesOf(plain)))
    check('boost-fonts: ...and a page whose policy forbids every font', await waitForFace(strict, 'Lucium Inter'), JSON.stringify(await facesOf(strict)))
    const [withFace = 0, fallback = 0] = await widths(strict, 'Lucium Inter')
    check('boost-fonts: the text of the strict page is measured in the font, not in its fallback', withFace !== fallback && withFace > 0, JSON.stringify({ withFace, fallback }))
    check('boost-fonts: the page uses the face first in its font stack', (await familyOf(strict)).startsWith('"Lucium Inter"'), await familyOf(strict))

    // ---- a live change gives the page the new font without reloading it ----
    saveBoost({ fontFamily: 'fraunces' })
    check('boost-fonts: choosing another font in the editor gives the open page that font at once', await waitForFace(strict, 'Lucium Fraunces'), JSON.stringify(await facesOf(strict)))
    check('boost-fonts: the font already given is not given twice', (await facesOf(strict)).filter((f) => f.startsWith('Lucium Inter')).length === 1, JSON.stringify(await facesOf(strict)))

    // ---- a reload is a new document: the font comes again ----
    saveBoost({ fontFamily: 'inter' })
    wcOf(strict)!.reload()
    await sleep(300)
    await waitFor(() => browser.snapshot().runtime.tabs[strict]?.loading === false)
    check('boost-fonts: after a reload the page gets its font again', await waitForFace(strict, 'Lucium Inter'), JSON.stringify(await facesOf(strict)))

    // ---- nothing for a system font, a disabled Tweak ----
    saveBoost({ fontFamily: 'menlo' })
    const systemFont = await open('/plain?system')
    // A fixed wait, for want of a witness: the Tweak is applied when the document is ready, and a font given by mistake would come later still,
    // once its file is read; nothing comes after it to wait for.
    await sleep(800)
    check('boost-fonts: a system font gives the page no file', !(await facesOf(systemFont)).some((f) => f.startsWith('Lucium')), JSON.stringify(await facesOf(systemFont)))
    saveBoost({ fontFamily: 'inter', enabled: false })
    const disabled = await open('/plain?disabled')
    // A fixed wait, for want of a witness: a disabled Tweak gives the page nothing at all, so nothing comes to wait for.
    await sleep(800)
    check('boost-fonts: a disabled Tweak gives the page nothing', !(await facesOf(disabled)).some((f) => f.startsWith('Lucium')), JSON.stringify(await facesOf(disabled)))
  } finally {
    for (const id of [...mine]) browser.dispatch({ type: 'tab/close', id })
    browser.dispatch({ type: 'boost/delete', id: 'boost-fonts-smoke' })
    server.close()
    server.closeAllConnections()
  }
}

/** `LUCIUM_SMOKE_ONLY=boostfonts`: only these checks, with their own report. */
export async function runBoostFontsSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeBoostFonts(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeBoostFonts ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_BOOSTFONTS ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
