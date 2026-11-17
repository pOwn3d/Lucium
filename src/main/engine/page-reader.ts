// Reads the text of a web page in a view nobody sees, for the pages being watched (shared/page-watch.ts). The page is loaded as a tab of
// the same profile would load it (its cookies, its logins), but it is a page like any other and may misbehave, so it is kept on a short
// leash: web addresses only, no new window, no dialog, no sound, no download, no permission, no sign-in prompt, a time limit, one at a time,
// and the view is destroyed whatever happened. Called by `ElectronEngine.readPageText`.

import { WebContentsView, type Session } from 'electron'
import { PAGE_WATCH_LOAD_TIMEOUT_MS, PAGE_WATCH_SELECTOR_MAX, PAGE_WATCH_TEXT_MAX, isWatchableUrl } from '@shared/page-watch'
import { markHiddenContents } from './web-auth'
import { t } from '@shared/i18n'

export interface ReadOptions {
  /** CSS selector of the zone to read; absent: the visible text of the whole page. */
  selector?: string
  /** Gives up on a page that has not loaded after this long. */
  timeoutMs?: number
  /** After the page has loaded, scripts get this long to draw it. */
  settleMs: number
}

export type ReadOutcome = { ok: true; text: string } | { ok: false; error: string }

let reading = false

/**
 * The script runs in an isolated world of its own: the page cannot redefine `String`, `slice` or `querySelector` under it, so the bound the
 * script applies is the one written here. Any number outside the ones Chromium hands to extensions would do.
 */
export const PAGE_WATCH_WORLD = 4_200_044

/**
 * What the answer of the script means. The text is cut here again, in this process: the bound is not left to the process that drew the page,
 * and whatever comes next (the folding of the whitespace, the fingerprint) works on a text of a known size.
 */
export function readAnswer(answer: unknown, selector: string | undefined): ReadOutcome {
  const result = (typeof answer === 'object' && answer !== null ? answer : {}) as { text?: unknown; missing?: unknown; error?: unknown }
  if (typeof result.text === 'string') return { ok: true, text: result.text.slice(0, PAGE_WATCH_TEXT_MAX) }
  if (result.missing === true) return { ok: false, error: selector === undefined ? t('page-reader.la-page-est-vide') : t('page-reader.la-zone-surveillee-n-existe-plus-dans-la-page') }
  return { ok: false, error: typeof result.error === 'string' ? t('page-reader.zone-non-valide-error', { error: result.error }).slice(0, 160) : t('page-reader.la-page-n-a-pas-livre-son-texte') }
}

/** The script that reads the zone. The selector goes in as a JSON string: nothing of it is ever code. */
export function extractScript(selector: string | undefined): string {
  return `(() => {
    try {
      const selector = ${JSON.stringify(selector ?? null)};
      const element = selector === null ? document.body : document.querySelector(selector);
      if (!element) return { missing: true };
      return { text: String(element.innerText || element.textContent || '').slice(0, ${PAGE_WATCH_TEXT_MAX}) };
    } catch (error) {
      return { error: String(error && error.message || error) };
    }
  })()`
}

/** The view the page is read in: not attached to any window, with nothing that needs someone to answer. */
function makeView(ses: Session): WebContentsView {
  return new WebContentsView({
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      // Nobody is there to answer: no alert, confirm or prompt, no sound by itself, no picture to download for a text.
      disableDialogs: true,
      autoplayPolicy: 'document-user-activation-required',
      images: false
    }
  })
}

/** Reads the page. Never throws: the outcome says what went wrong, in a sentence a list can show. */
export function readPageText(ses: Session, url: string, options: ReadOptions): Promise<ReadOutcome> {
  if (!isWatchableUrl(url)) return Promise.resolve({ ok: false, error: t('browser.seules-les-pages-web-http-ou-https-peuvent-etre') })
  if (options.selector !== undefined && (options.selector.length > PAGE_WATCH_SELECTOR_MAX || /\p{Cc}/u.test(options.selector))) return Promise.resolve({ ok: false, error: t('page-reader.cette-zone-n-est-pas-un-selecteur-valide') })
  // One look at a time: a second request while one runs is refused, not queued behind a page that may never end.
  if (reading) return Promise.resolve({ ok: false, error: t('page-reader.une-autre-page-est-en-cours-de-lecture') })
  reading = true
  return new Promise<ReadOutcome>((resolve) => {
    let view: WebContentsView
    try {
      view = makeView(ses)
    } catch (error) {
      // The flag must not stay up for a view that was never made: no page would ever be read again.
      reading = false
      console.error('[page-watch] cannot make a view to read a page:', error)
      resolve({ ok: false, error: t('page-reader.le-navigateur-n-a-pas-pu-preparer-la-lecture-de') })
      return
    }
    const wc = view.webContents
    const contentsId = wc.id
    const forget = markHiddenContents(contentsId)
    let done = false
    let settle: NodeJS.Timeout | undefined
    // Where the look is, for the sentence that says why it gave up.
    let stage = t('page-reader.le-chargement-n-a-pas-fini')

    const finish = (outcome: ReadOutcome): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(settle)
      forget()
      reading = false
      // Closed through `view` on purpose: a WebContentsView that nothing refers to is collected, and its page dies with it in the middle of the
      // look. This closure is what keeps it alive until the look ends.
      if (!view.webContents.isDestroyed()) view.webContents.close()
      resolve(outcome)
    }

    wc.setAudioMuted(true)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    // The page may go to other web pages (a redirect, a link it follows by itself), never to a file, an extension or another scheme.
    const guard = (event: { preventDefault(): void }, target: string): void => {
      if (!isWatchableUrl(target)) {
        event.preventDefault()
        finish({ ok: false, error: t('page-reader.la-page-a-voulu-aller-ailleurs-que-sur-le-web') })
      }
    }
    wc.on('will-navigate', (event, target) => guard(event, target))
    wc.on('will-redirect', (event, target) => guard(event, target))
    wc.on('render-process-gone', () => finish({ ok: false, error: t('page-reader.la-page-a-plante') }))
    wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      // -3 is a navigation that was replaced (a redirect), not a failure.
      if (isMainFrame && code !== -3) finish({ ok: false, error: t('page-reader.la-page-n-a-pas-pu-etre-chargee-reason', { reason: description || code }) })
    })
    const timer = setTimeout(() => finish({ ok: false, error: t('page-reader.la-page-n-a-pas-repondu-a-temps-stage', { stage }) }), options.timeoutMs ?? PAGE_WATCH_LOAD_TIMEOUT_MS)

    wc.once('did-finish-load', () => {
      stage = t('page-reader.la-lecture-du-texte-n-a-pas-fini')
      settle = setTimeout(() => {
        if (done || wc.isDestroyed()) return
        ;(wc.executeJavaScriptInIsolatedWorld(PAGE_WATCH_WORLD, [{ code: extractScript(options.selector) }]) as Promise<unknown>).then(
          (answer: unknown) => finish(readAnswer(answer, options.selector)),
          (error: unknown) => finish({ ok: false, error: t('page-reader.la-page-n-a-pas-pu-etre-lue-reason', { reason: error instanceof Error ? error.message : String(error) }).slice(0, 200) })
        )
      }, options.settleMs)
    })

    wc.loadURL(url).catch((error: unknown) => {
      // ERR_ABORTED is a navigation that was replaced; did-fail-load speaks for the others.
      if ((error as { code?: string }).code !== 'ERR_ABORTED') finish({ ok: false, error: t('page-reader.la-page-n-a-pas-pu-etre-chargee-reason-2', { reason: error instanceof Error ? error.message : String(error) }).slice(0, 200) })
    })
  })
}

/** Whether a page is being read now (the engine test checks that none is left behind). */
export const isReading = (): boolean => reading
