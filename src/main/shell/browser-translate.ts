// A layer of the class Browser (browser.ts; the order of the layers: docs/architecture.md). The summary of a page, in a tab of its own,
// and the translation of a tab (the local one, and the page of an online translator). Cut out of browser-commands.ts as it was.

import { tabName } from '@shared/model'
import { activeTab, tabOpenedSince } from '@shared/sidebar'
import { isLocalOllamaAddress, isOllamaAddress, ollamaTokens, resolveOllamaModel, summarizeWithOllama } from '@shared/ollama'
import { summaryPaintScript, type SummaryLabels, type SummaryTabState } from '@shared/summary-html'
import { LENGTH_CHARS, LENGTH_TOKENS, addressForSummary, type SummaryLength } from '@shared/summary-prompt'
import type { PageSummaryReply } from '@shared/ipc'
import type { Page } from '../engine/types'
import { getLanguage, t } from '@shared/i18n'
import type { TabTranslation } from '@shared/model'
import { sameData } from '@shared/row-equality'
import { targetLanguage } from '@shared/translate-local'
import { translatesByItself } from '@shared/translate-quick'
import { ollamaFetch } from './ollama-fetch'
import type { TranslateController } from '../translate/controller'
import { BrowserResources } from './browser-resources'
import { settingsPath } from '@shared/settings-path'

/** How a window reaches its translation (shell/translate-ipc.ts): `get` makes it at its first use (null while 'translate-local' is off), `made` only answers it. */
export interface TranslatorAccess {
  get(): TranslateController | null
  made(): TranslateController | null
}

export abstract class BrowserTranslate extends BrowserResources {
  /** The translation of this window, handed by translate-ipc.ts; made at its first use only. */
  private translatorAccess: TranslatorAccess | null = null

  /** Runs an action that may open a tab, and traces the empty tab it opened: `origin` is the path that asked for it (see [blank-tab] created). */
  protected openedBy(origin: string, open: () => void): void {
    const before = new Set(this.store.get().tabs.map((t) => t.id))
    open()
    for (const t of this.store.get().tabs) if (!before.has(t.id) && t.url === 'about:blank') console.info(`[blank-tab] created: tab ${t.id} (${origin}, space ${t.spaceId})`)
  }

  /** The summary in a tab of its own: the tab opens at once with "Résumé en cours…", and is filled when the answer comes. Navigating
   * elsewhere does not stop it: the request runs here, on the source tab it was asked for. */
  openSummaryTab(length: SummaryLength = 'normal'): void {
    this.followPaneFocus()
    const source = activeTab(this.store.get())
    if (!source) return this.showToast(t('summary.page-indisponible'))
    const sourceId = source.id
    const sourceName = tabName(source)
    const before = this.store.get()
    // The summary of a private tab is private too: it carries the title and the text of the page, which an ordinary tab would keep in the saved state.
    this.openedBy('summary', () => this.dispatch({ type: 'tab/open', url: 'about:blank', background: false, container: null, ...(source.private === true ? { private: true } : {}) }))
    // The tab just made, never the one on screen when nothing was opened: the summary would be tied to a tab of the user.
    const opened = tabOpenedSince(before, this.store.get())
    if (!opened) return
    this.summaryTabs.add(opened.id)
    const labels: SummaryLabels = {
      title: t('summary.titre'),
      loading: t('summary.chargement'),
      copy: t('summary.copier'),
      copied: t('summary.copie'),
      model: (model, duration) => t('summary.modele', { model, duration })
    }
    const paint = (state: SummaryTabState) => {
      // The user may have gone to another page in this tab while the model answered: the summary is not written over it.
      if (this.store.get().tabs.find((tab) => tab.id === opened.id)?.url !== 'about:blank') return
      void this.whenPage(opened.id).then((page) => page?.runScript(summaryPaintScript(sourceName, state, labels)))
    }
    paint({ status: 'loading' })
    void this.summarizeTab(sourceId, length).then((reply) => paint(reply.ok ? { status: 'ok', summary: reply.summary, model: reply.model, duration: reply.duration } : { status: 'error', message: reply.error }))
  }

  /** The page of a tab once it exists (a new tab gets its page a moment after it is opened); undefined when it never does. */
  private async whenPage(tabId: string): Promise<Page | undefined> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const page = this.pages.get(tabId)
      if (page) return page
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return undefined
  }

  /** The summary of one tab (the one it was asked for, even when another tab has come to the front meanwhile). */
  /** "Traduire cette page…": the translation when it is on; when it is off, the Outils settings where it is turned on (it downloads models, so it stays off by default). */
  protected openTranslatePage(): void {
    if (this.store.get().settings.translateLocal) this.openOverlay({ panel: 'translate' })
    else this.openOverlay({ panel: 'settings', pane: 'tools' })
  }

  /** Hands this window its translation (shell/translate-ipc.ts). */
  useTranslator(access: TranslatorAccess): void {
    this.translatorAccess = access
  }

  /**
   * « Traduire en <langue> » (the page's menu, File) for a tab: translated at once with the pair the panel would propose, without the panel; « Afficher
   * l'original » for a tab translated or being translated. The panel opens only when the translation cannot be done that way (a language not installed in
   * macOS and no model, a language not recognised), on the tab still on screen: it says why and what to do.
   */
  translateTabNow(tabId: string): void {
    const translator = this.translatorAccess?.get() ?? null
    if (!translator) return this.openTranslatePage()
    const failed = (error: unknown): void => console.warn('[translate] the one-click translation of a tab failed:', error instanceof Error ? error.message : String(error))
    if (translator.translationOf(tabId) !== null) {
      void translator.restoreTab(tabId).catch(failed)
      return
    }
    void translator.quickTab(tabId).then((view) => {
      if (view.state === 'error' && activeTab(this.store.get())?.id === tabId) this.openOverlay({ panel: 'translate' })
    }, failed)
  }

  /** The translation of a tab changed (translate/controller.ts): its runtime says it, for the toolbar button and the menus. */
  showTabTranslation(tabId: string, translation: TabTranslation | null): void {
    const entry = this.runtime.tabs[tabId]
    if (!entry) return
    const { translation: _was, ...rest } = entry
    const next = translation ? { ...rest, translation } : rest
    if (sameData(entry, next)) return
    this.runtime = { ...this.runtime, tabs: { ...this.runtime.tabs, [tabId]: next } }
    this.publish()
  }

  /** The first time macOS translated a page in one click: a notice says it, once (Apple may count the use of its translation, never the text). */
  translationNotice(): void {
    this.showToast(t('translate.system-notice'), { label: t('translate.system-notice-settings'), run: () => this.openOverlay({ panel: 'settings', pane: 'tools' }) }, undefined, { detail: t('translate.system-usage-note', { settingsPath: settingsPath('translateSystem') }) })
  }

  /**
   * A page told its language, another one than the target: it is translated by itself when « Toujours traduire » has that language and its site is not one
   * of « Ne jamais traduire ce site » (`translatesByItself`). Nothing is made for a page no list asks for: the translation exists only once there is one to do.
   */
  protected translateIfAlways(tabId: string, language: string): void {
    const { settings, tabs } = this.store.get()
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab || !translatesByItself(settings, tab.url, language, targetLanguage(settings, getLanguage()))) return
    void this.translatorAccess?.get()?.autoTranslate(tabId).catch((error: unknown) => console.warn('[translate] the page of a tab could not be translated by itself:', error instanceof Error ? error.message : String(error)))
  }

  /** The page of a tab left its document, or went away: its translation is over (asked only of a translation that exists). */
  protected forgetTranslation(tabId: string): void {
    this.translatorAccess?.made()?.forgetTab(tabId)
  }

  private async summarizeTab(tabId: string, length: SummaryLength): Promise<PageSummaryReply> {
    const settings = this.store.get().settings
    const config = settings.ollamaConfig
    if (!settings.aiSummary || !config.enabled) return { ok: false, error: t('summary.desactive', { settingsPath: settingsPath('summary') }) }
    // The page text goes to Ollama on this Mac or on a computer of the local network, and nowhere else: any other address is refused before the
    // page is read, and before any request (not even the list of its models is asked).
    if (!isOllamaAddress(config.url)) return { ok: false, error: t('summary.adresse-non-locale', { settingsPath: settingsPath('summary') }) }
    const tab = this.store.get().tabs.find((item) => item.id === tabId)
    const page = tab ? this.pages.get(tab.id) : undefined
    if (!tab || !page?.readText) return { ok: false, error: t('summary.page-indisponible') }
    // A page of a private tab, of a private or a guest window never leaves the Mac: another computer is refused there, before the page is read
    // (Ollama on this Mac still answers). A private window does not mark its tabs private: the window says it.
    if (!isLocalOllamaAddress(config.url) && (tab.private === true || this.isPrivate())) return { ok: false, error: t('summary.reseau-prive', { settingsPath: settingsPath('summary') }) }
    const content = await page.readText(LENGTH_CHARS[length]).catch(() => '')
    if (!content.trim()) return { ok: false, error: t('summary.page-vide') }
    const resolved = await resolveOllamaModel(config.url, config.model, ollamaFetch)
    if (!resolved.ok && resolved.reason === 'refused') return { ok: false, error: t('summary.nom-sans-adresse-privee', { host: new URL(config.url).hostname }) }
    if (!resolved.ok) return { ok: false, error: resolved.reason === 'none' ? t('summary.aucun-modele') : t('summary.echec', { url: config.url }) }
    // The model gets the origin and path of the address, not its query or fragment, and no title.
    // The length's ceiling, lowered by the one of the settings.
    const maxTokens = Math.min(LENGTH_TOKENS[length], ollamaTokens(config.maxTokens))
    const result = await summarizeWithOllama({ ...config, model: resolved.model, maxTokens }, { content, url: addressForSummary(tab.url), length }, ollamaFetch)
    if (!result) return { ok: false, error: t('summary.echec', { url: config.url }) }
    return { ok: true, summary: result.summary, model: result.model, duration: result.duration }
  }
}
