// Engine checks for the two features that touch the whole interface, run inside a real Electron:
//  - the translated interface: French to the character by default, English on request in the menu bar, the sidebar and the toolbar, back to French, the
//    menu rebuilt on the change, the setting off whatever the system says;
//  - the local page translation: the entry only while the function is on, the panel, the language of a real page, a pack placed by hand and adopted, a real page
//    translated in the isolated world (script, style, translate="no", a shadow root) and restored, a pack that was tampered with refused, the catalogue and the
//    download only after a click and only what was shown, the engine's binary with the first model (the network of the check is a stub: nothing leaves the
//    machine), and the real Bergamot worker refusing a binary that is not WebAssembly. A real translation needs Mozilla's files: it is checked by hand
//    (docs/traduction-locale.md).
// Called from the engine smoke test: `await smokeTranslate(ctx, check)`.

import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Menu, type WebContents } from 'electron'
import { createHash } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { ATTACHMENTS_HOST, RUNTIME_CATALOGUE_URL, catalogueUrl, type TranslateView } from '@shared/translate-local'
import { Channel } from '@shared/ipc'
import type { SidebarState } from '@shared/model'
import type { SmokeContext } from './smoke'
import { translateEnvironment } from './shell/translate-ipc'
import { noteCheck, recorderOf, sleep, waiterOf } from './smoke-kit'

type Check = (name: string, ok: boolean, detail?: string) => void


const waitFor = waiterOf(8000, 80)

const sha = (data: string): string => createHash('sha256').update(data).digest('hex')
const shaBytes = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

const FRENCH_PAGE = `<!doctype html><html lang="fr"><head><title>Page de test</title></head><body>
  <h1>Bonjour le monde</h1>
  <p>Le chat dort ici et le chien aussi, dans la maison du village, avec les enfants et les amis de la famille qui sont venus pour le déjeuner.</p>
  <p translate="no">Marque déposée</p>
  <pre>code préformaté</pre>
  <script>window.secret = 'ne pas traduire'</script>
  <my-card id="card"></my-card>
  <script>document.getElementById('card').attachShadow({ mode: 'open' }).innerHTML = '<p>Le monde dans l’ombre</p>'</script>
</body></html>`

export async function smokeTranslate(ctx: SmokeContext, check: Check): Promise<void> {
  const { browser, store, win, overlayView } = ctx
  const ui = overlayView.webContents
  const state = (): SidebarState => store.get()
  const patch = (settings: Partial<SidebarState['settings']>) => browser.dispatch({ type: 'settings/update', patch: settings })
  const saved = { ...state().settings }
  const mine: string[] = []
  const workDir = mkdtempSync(join(tmpdir(), 'lucium-translate-smoke-'))
  const modelsDir = join(workDir, 'models')
  const engineDir = join(workDir, 'engine')
  const environment = { ...translateEnvironment }

  // ---- a local site (the page to translate), and a stub for the only two servers the function may speak to ----
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(FRENCH_PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const requested: string[] = []
  const model = 'MODEL-BYTES-'.repeat(30)
  const vocab = 'VOCAB-BYTES-'.repeat(10)
  // Not a WebAssembly binary: the engine must fail to start on it, say so, and leave the page as it was.
  const wasm = 'NOT-A-WASM-'.repeat(10)
  // Records as Mozilla's v2 collections give them: the attachment compressed with zstd, the record saying what it decompresses into.
  const record = (fields: Record<string, unknown>, data: string, location: string) => ({
    ...fields,
    decompressedHash: sha(data),
    decompressedSize: Buffer.byteLength(data),
    filter_expression: '',
    attachment: { hash: shaBytes(zstdCompressSync(data)), size: zstdCompressSync(data).length, filename: `${location.split('/').pop()}`, location, mimetype: 'application/zstd' }
  })
  const routes: Record<string, string | Buffer> = {
    [catalogueUrl('fr', 'en')]: JSON.stringify({
      data: [
        record({ fromLang: 'fr', toLang: 'en', fileType: 'model', version: '3.1', name: 'model.fren.bin' }, model, 'main-workspace/translations-models/model.zst'),
        record({ fromLang: 'fr', toLang: 'en', fileType: 'vocab', version: '3.1', name: 'vocab.fren.spm' }, vocab, 'main-workspace/translations-models/vocab.zst')
      ]
    }),
    [RUNTIME_CATALOGUE_URL]: JSON.stringify({ data: [record({ name: 'bergamot-translator', version: '4.0', release: 'v0.6.0' }, wasm, 'main-workspace/translations-wasm/engine.zst')] }),
    [`https://${ATTACHMENTS_HOST}/main-workspace/translations-models/model.zst`]: zstdCompressSync(model),
    [`https://${ATTACHMENTS_HOST}/main-workspace/translations-models/vocab.zst`]: zstdCompressSync(vocab),
    [`https://${ATTACHMENTS_HOST}/main-workspace/translations-wasm/engine.zst`]: zstdCompressSync(wasm)
  }
  translateEnvironment.fetch = async (url) => {
    requested.push(url)
    const body = routes[url]
    return body === undefined ? new Response('', { status: 404 }) : new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) } })
  }
  translateEnvironment.defaultDir = () => modelsDir
  translateEnvironment.engineDir = () => engineDir
  // The folders above are read at each request (translate-ipc.ts), even by a translator an earlier suite of the chain made; the folder of the settings wins
  // over them (controller.ts `dir`), so it is set to the test's own, whatever an earlier suite left there, and the packs of this test go there.
  patch({ translateModelsDir: modelsDir })
  // The system's translation is not part of this test (the Mac that runs it may have French and English installed): no helper, the packs translate.
  translateEnvironment.systemHelper = () => null

  const ask = <T>(request: unknown) => ui.executeJavaScript(`window.lucium.translate(${JSON.stringify(request)})`) as Promise<T>
  const wcOf = (id: string) => (browser.pageFor(id) as unknown as { webContents: WebContents } | undefined)?.webContents
  const fileMenu = (): string[] => Menu.getApplicationMenu()?.items.find((item) => item.label === 'Fichier' || item.label === 'File')?.submenu?.items.map((item) => item.label) ?? []
  const topMenu = (): string[] => Menu.getApplicationMenu()?.items.map((item) => item.label) ?? []
  const chromeText = (js: string) => win.webContents.executeJavaScript(js) as Promise<string>

  try {
    // ===================================================== the interface language =====================================================
    patch({ interfaceTranslated: false, language: 'auto', translateLocal: false })
    // The menu bar and the window follow the setting (an earlier suite may have left them in another language): waited for, not a fixed time.
    check('i18n: by default the menu bar is the French one, to the character', await waitFor(() => JSON.stringify(topMenu().slice(0, 6)) === JSON.stringify(['Lucium', 'Fichier', 'Édition', 'Affichage', 'Espaces', 'Onglets'])), topMenu().join('|'))
    check('i18n: the sidebar and the toolbar are French too', await waitFor(async () => (await chromeText(`document.querySelector('.footer-downloads')?.getAttribute('aria-label') ?? ''`)) === 'Téléchargements' && (await chromeText(`document.querySelector('.tb-link')?.getAttribute('aria-label') ?? ''`)) === 'Copier l’adresse'))
    patch({ interfaceTranslated: true, language: 'en' })
    check('i18n: English on request: the menu bar is rebuilt in English', await waitFor(() => topMenu().includes('File') && topMenu().includes('Edit') && topMenu().includes('View')), topMenu().join('|'))
    check('i18n: the sidebar and the toolbar follow', await waitFor(async () => (await chromeText(`document.querySelector('.footer-downloads')?.getAttribute('aria-label') ?? ''`)) === 'Downloads' && (await chromeText(`document.querySelector('.tb-link')?.getAttribute('aria-label') ?? ''`)) === 'Copy address'))
    check('i18n: the document says which language it is in', (await chromeText(`document.documentElement.lang`)) === 'en')
    patch({ interfaceTranslated: false })
    check('i18n: with the function off the interface is French again whatever the language setting says', await waitFor(() => topMenu().includes('Fichier')) && (await waitFor(async () => (await chromeText(`document.querySelector('.footer-downloads')?.getAttribute('aria-label') ?? ''`)) === 'Téléchargements')))
    patch({ interfaceTranslated: true, language: 'fr' })
    check('i18n: "Français" chosen while on is French as well', await waitFor(() => topMenu().includes('Fichier')))
    patch({ interfaceTranslated: false, language: 'auto' })

    // ===================================================== the local page translation =====================================================
    const before = fileMenu()
    check('translate: with the function off the File menu has no "Traduire cette page…"', !before.includes('Traduire cette page…'), before.join('|'))
    browser.openOverlay({ panel: 'translate' })
    // No wait: openOverlay decides before it returns (browser-overlay.ts), and a panel it takes is the current one at once.
    check('translate: and the panel does not open', browser.currentPanel() !== 'translate')
    check('translate: and the main process answers nothing to its channel', (await ask<TranslateView | null>({ action: 'refresh' })) === null)

    patch({ translateLocal: true })
    check('translate: switched on, the File menu gets the entry', await waitFor(() => fileMenu().includes('Traduire cette page…')), fileMenu().join('|'))

    browser.dispatch({ type: 'tab/open', url: `${base}/page` })
    const id = state().tabs.at(-1)!.id
    mine.push(id)
    await waitFor(() => state().tabs.find((t) => t.id === id)?.title === 'Page de test' && browser.snapshot().runtime.tabs[id]?.loading === false)
    await sleep(500)
    const inPage = <T>(js: string) => wcOf(id)!.executeJavaScript(js) as Promise<T>
    const original = await inPage<string>(`document.body.innerText`)

    browser.openOverlay({ panel: 'translate' })
    check('translate: the panel opens', await waitFor(() => browser.currentPanel() === 'translate'))
    check('translate: and draws itself', await waitFor(async () => (await ui.executeJavaScript(`document.querySelector('.translate-panel h2')?.textContent ?? ''`)) === 'Traduire cette page'))
    check('translate: the language of the page is read from the page (French)', await waitFor(async () => (await ui.executeJavaScript(`document.querySelector('#translate-from')?.value ?? ''`)) === 'fr'))
    check('translate: opening the panel asked the network for nothing', requested.length === 0, requested.join(','))

    patch({ translateTarget: 'en' })
    const missing = await ask<TranslateView>({ action: 'refresh' })
    check('translate: with no model the route is missing, the address a lookup would use is shown, and nothing was fetched', missing.route?.ok === false && missing.lookupUrl === catalogueUrl('fr', 'en') && requested.length === 0, JSON.stringify(missing.route))

    // A pack placed by hand: files in the folder, then "register" (the fingerprints are computed on that click).
    mkdirSync(join(modelsDir, 'fr-en'), { recursive: true })
    const glossaryFile = join(modelsDir, 'fr-en', 'fr-en.glossary.json')
    writeFileSync(glossaryFile, JSON.stringify({ entries: { bonjour: 'hello', le: 'the', monde: 'world', chat: 'cat', dort: 'sleeps', ici: 'here', chien: 'dog', aussi: 'too', maison: 'house', dans: 'in', 'l’ombre': 'the shadow' } }))
    const adopted = await ask<TranslateView>({ action: 'adopt', from: 'fr', to: 'en' })
    check('translate: a pack placed by hand is registered with its fingerprints', adopted.packs.length === 1 && adopted.packs[0]!.engine === 'glossary', adopted.message)

    const done = await ask<TranslateView>({ action: 'run', from: 'fr', to: 'en' })
    const translated = await inPage<string>(`document.body.innerText`)
    check('translate: the page is translated in place', done.state === 'translated' && /Hello the world/.test(translated) && /The cat sleeps here/.test(translated), `${done.message} | ${translated.slice(0, 120)}`)
    check('translate: what is not prose is left alone (translate="no", code, scripts)', /Marque déposée/.test(translated) && /code préformaté/.test(translated) && (await inPage<string>(`window.secret`)) === 'ne pas traduire')
    check('translate: a shadow root the page opened is translated too', await inPage<boolean>(`document.getElementById('card').shadowRoot.textContent.includes('The world in the shadow')`), await inPage<string>(`document.getElementById('card').shadowRoot.textContent`))
    check('translate: the title of the tab is not touched', state().tabs.find((t) => t.id === id)?.title === 'Page de test')
    check('translate: nothing was fetched to translate', requested.length === 0, requested.join(','))
    await ask<TranslateView>({ action: 'restore' })
    check('translate: the original text comes back exactly', (await inPage<string>(`document.body.innerText`)) === original)

    // The files of a pack are checked before an engine sees them, also when the pack was checked and used a moment ago: a file written since is checked again.
    const goodFile = readFileSync(glossaryFile, 'utf8')
    writeFileSync(glossaryFile, goodFile.replace('hello', 'HACKD'))
    const refused = await ask<TranslateView>({ action: 'run', from: 'fr', to: 'en' })
    check('translate: a pack whose file was changed is refused, and the page stays as it was', refused.state === 'error' && /empreintes/.test(refused.message) && (await inPage<string>(`document.body.innerText`)) === original, refused.message)
    writeFileSync(glossaryFile, goodFile)

    // The catalogue and the files: after a click, and only what was shown. Driven through the panel itself, as a person would.
    await ask<TranslateView>({ action: 'remove', from: 'fr', to: 'en' })
    browser.closeOverlay()
    await sleep(200)
    browser.openOverlay({ panel: 'translate' })
    const clickIn = (selector: string, startsWith = '') =>
      ui.executeJavaScript(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.textContent.startsWith(${JSON.stringify(startsWith)})); if (!b || b.disabled) return false; b.click(); return true })()`) as Promise<boolean>
    // The step that holds the button to look the models up: the panel has another step before it when the system's translation has something to say
    // (TranslatePanel.tsx `translate-system`; here the helper is absent, so it says so).
    const lookupNotes = `(() => { const step = [...document.querySelectorAll('.translate-step')].find((s) => [...s.querySelectorAll('button')].some((b) => b.textContent.startsWith('Chercher les modèles'))); return step ? [...step.querySelectorAll('.translate-note')].map((n) => n.textContent).join(' ') : '' })()`
    check('translate: with no model the panel offers to look for one, naming the server before the click', await waitFor(async () => (await ui.executeJavaScript(lookupNotes)).includes('firefox.settings.services.mozilla.com')), await ui.executeJavaScript(lookupNotes))
    check('translate: nothing was asked of the network until now', requested.length === 0, requested.join(','))
    check('translate: the click on "Chercher les modèles" is found', await waitFor(() => clickIn('.translate-step button', 'Chercher les modèles')))
    const cdn = `https://${ATTACHMENTS_HOST}/main-workspace`
    check(
      'translate: the panel then lists the files with their addresses and the size, the engine first, and downloaded none',
      await waitFor(async () => (await ui.executeJavaScript(`[...document.querySelectorAll('.translate-files li')].map((li) => li.title).join(' ')`)) === `${cdn}/translations-wasm/engine.zst ${cdn}/translations-models/model.zst ${cdn}/translations-models/vocab.zst`)
    )
    check('translate: the lookup was two requests, to the catalogue of the models shown, then to the one of the engine', requested.length === 2 && requested[0] === catalogueUrl('fr', 'en') && requested[1] === RUNTIME_CATALOGUE_URL, requested.join(','))
    const wrongPair = await ask<TranslateView>({ action: 'download', from: 'de', to: 'en' })
    check('translate: a download of a pair nobody looked up is refused, without a request', wrongPair.state === 'error' && requested.length === 2, requested.join(','))
    check('translate: the click on "Télécharger" is found', await waitFor(() => clickIn('.translate-step .button.primary', 'Télécharger')))
    check(
      'translate: the three files are fetched, exactly those, and the pack is installed and verified',
      (await waitFor(async () => (await ui.executeJavaScript(`document.querySelectorAll('.translate-packs li').length`)) === 1)) && requested.length === 5 && requested[2]!.endsWith('/engine.zst') && requested[3]!.endsWith('/model.zst') && requested[4]!.endsWith('/vocab.zst'),
      requested.join(',')
    )
    // The stub binary is no WebAssembly: the real engine, in its worker, must refuse it, and the page must stay as it was.
    const noEngine = await ask<TranslateView>({ action: 'run', from: 'fr', to: 'en' })
    check('translate: an engine binary that is not one fails to load, says so, and the page stays as it was', noEngine.state === 'error' && /n’a pas pu être chargé/.test(noEngine.message) && (await inPage<string>(`document.body.innerText`)) === original, noEngine.message)
    check('translate: running the engine asked the network for nothing', requested.length === 5, requested.join(','))

    // What the interface may not do (the folder of the test is put back to the default first).
    patch({ translateModelsDir: '' })
    // No wait after it: the interface's dispatch is answered once the main process has refused or applied it (ipc.ts).
    const refusedPath = await ui.executeJavaScript(`window.lucium.dispatch({ type: 'settings/update', patch: { translateModelsDir: '/tmp/evil' } }).then(() => 'sent')`)
    check('translate: the interface cannot name the folder of the models', refusedPath === 'sent' && state().settings.translateModelsDir === '')
    check('translate: a request that is not one of the panel is refused', (await ask<TranslateView | null>({ action: 'lookup', from: 'fr', to: 'en', url: 'https://evil.example/' })) === null && (await ask<TranslateView | null>({ action: 'format' })) === null)
    check('translate: the channel is the one of the panel', Channel.translate === 'lucium:translate')

    // The switch off: the entry goes, the panel closes for good.
    browser.closeOverlay()
    patch({ translateLocal: false })
    check('translate: switched off again, the entry leaves the menu', await waitFor(() => !fileMenu().includes('Traduire cette page…')), fileMenu().join('|'))
  } finally {
    Object.assign(translateEnvironment, environment)
    patch({ interfaceTranslated: saved.interfaceTranslated, language: saved.language, translateLocal: saved.translateLocal, translateTarget: saved.translateTarget, translateModelsDir: saved.translateModelsDir })
    for (const tabId of mine) browser.dispatch({ type: 'tab/close', id: tabId })
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(workDir, { recursive: true, force: true })
  }
}

export async function runTranslateSmoke(ctx: SmokeContext): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = []
  try {
    await smokeTranslate(ctx, recorderOf(checks))
  } catch (error) {
    noteCheck(checks, 'smokeTranslate ran to the end', false, String((error as Error)?.stack ?? error))
  }
  const failed = checks.filter((c) => !c.ok)
  console.log(`LUCIUM_SMOKE_TRANSLATE ${JSON.stringify({ checks, failed: failed.length }, null, 2)}`)
  return failed.length === 0 ? 0 : 1
}
