// Autoplay: whether a page may start sound by itself. Chromium asks for a gesture first; Electron's own default does not, which is
// why the engine now says it explicitly. Pure rules (which mode a site gets, what a saved choice may hold, when a page must be built
// again); the engine applies a mode when it creates a page (engine/electron-engine.ts) and the shell chooses it (shell/browser.ts).

import type { Settings } from './model'
import { zoomHostOf } from './site-zoom'
import { t } from './i18n'

/**
 * `block` is Chromium's own policy (`document-user-activation-required`), the default: sound starts only
 * once the document has had a user activation, or was reached by a click on a link of the same origin (the activation is carried over);
 * a reload forgets it, a Web Audio context stays suspended until then, and a muted video in a tab on screen may start by itself.
 * `allow` lets any media start (Electron's default, `no-user-gesture-required`). Electron's third value (`user-gesture-required`) is not
 * offered: measured, it refuses even the page reached by a click on a link of the same origin (which `block` lets play) and lets Web Audio run.
 */
export const AUTOPLAY_MODES = ['block', 'allow'] as const
export type AutoplayMode = (typeof AUTOPLAY_MODES)[number]

export const DEFAULT_AUTOPLAY: AutoplayMode = 'block'

/** Sites with a choice of their own; beyond this the list is a damaged or hand-edited file. */
export const SITE_AUTOPLAY_MAX = 500

export const isAutoplayMode = (value: unknown): value is AutoplayMode => (AUTOPLAY_MODES as readonly unknown[]).includes(value)

/** What the interface says for each mode: the name in a menu, the sentence under it, and what « En savoir plus » adds. */
export const AUTOPLAY_LABELS: Record<AutoplayMode, { name: string; hint: string; more?: string }> = {
  block: { get name() { return t('autoplay.bloquer-le-son-avant-un-geste') }, get hint() { return t('autoplay.un-son-ne-demarre-qu-apres-un-clic-ou-une') }, get more() { return t('autoplay.la-regle-par-defaut-du-moteur-un-son-ne-demarre-qu') } },
  allow: { get name() { return t('autoplay.autoriser') }, get hint() { return t('autoplay.les-sons-et-les-videos-peuvent-demarrer-seuls') } }
}

/** The key a site's choice is kept under: its host name without "www." (the same key as the page zoom), or null for an address with no host. */
export const autoplayHostOf = zoomHostOf

/** The key to remember for what the user typed or for a tab's address: a host or a whole address. Null when it names no web host. */
export function autoplayKeyOf(site: unknown): string | null {
  if (typeof site !== 'string') return null
  const text = site.trim()
  // An address with a scheme is read as it is: "file:///tmp/a" must not become the host "file" by being prefixed with https://.
  if (/^[a-z][a-z0-9+.-]*:(?:\/\/|[^0-9])/i.test(text)) return zoomHostOf(text)
  return zoomHostOf(`https://${text}/`)
}

/** A saved choice for the whole browser: an unknown word is Chromium's policy, the default, never the permissive one. */
export const cleanAutoplayPolicy = (value: unknown): AutoplayMode => (isAutoplayMode(value) ? value : DEFAULT_AUTOPLAY)

/**
 * The per-site choices of a saved or imported file: a site written any way the user likes ("Example.com", "www.example.com") is kept
 * under its canonical key, one with an unknown mode is dropped, no prototype key, at most `SITE_AUTOPLAY_MAX`.
 */
export function cleanSiteAutoplay(raw: unknown): Record<string, AutoplayMode> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out = new Map<string, AutoplayMode>()
  for (const [site, mode] of Object.entries(raw)) {
    const key = site === '__proto__' ? null : autoplayKeyOf(site)
    if (key === null || !isAutoplayMode(mode)) continue
    if (!out.has(key) && out.size >= SITE_AUTOPLAY_MAX) continue
    out.set(key, mode)
  }
  return Object.fromEntries(out)
}

/** The choices with `mode` remembered for `site`, or forgotten when it is null (the site follows the general choice again). A new object. */
export function withSiteAutoplay(choices: Readonly<Record<string, AutoplayMode>>, site: unknown, mode: unknown): Record<string, AutoplayMode> {
  const key = autoplayKeyOf(site)
  if (key === null) return { ...choices }
  const { [key]: _old, ...rest } = choices
  if (mode === null) return rest
  if (!isAutoplayMode(mode)) return { ...choices }
  // A full list refuses a new site; a site already on it can still change.
  if (!(key in choices) && Object.keys(choices).length >= SITE_AUTOPLAY_MAX) return { ...choices }
  return { ...rest, [key]: mode }
}

/** The choice remembered for a page: its own host, else the nearest parent domain ("music.example.com" follows "example.com"). */
export function siteAutoplayOf(choices: Readonly<Record<string, AutoplayMode>>, url: string): AutoplayMode | null {
  const host = autoplayHostOf(url)
  if (host === null) return null
  const labels = host.split('.')
  for (let at = 0; at < labels.length; at++) {
    const key = labels.slice(at).join('.')
    // Own keys only: a host called "constructor" must not read the prototype.
    if (Object.hasOwn(choices, key)) return choices[key] ?? null
  }
  return null
}

/**
 * The mode a page gets: its site's choice, else the general one. The choice of a site always applies: the switch that could turn them all off
 * (`autoplayPerSite`, « Un réglage pour chaque site ») is gone, and a state file that kept it off no longer hides the choices it holds.
 */
export function autoplayModeFor(settings: Pick<Settings, 'autoplayPolicy' | 'siteAutoplay'>, url: string): AutoplayMode {
  return siteAutoplayOf(settings.siteAutoplay, url) ?? settings.autoplayPolicy
}

/**
 * Electron fixes the policy when a page is created, so a page keeps the mode it was made with. When it commits a navigation to a site
 * that wants another one, the page is built again (its history is carried over). The delay keeps two sites that send each other
 * to the other from rebuilding the page for ever.
 */
export const AUTOPLAY_REBUILD_GAP_MS = 5000

export function mustRebuildForAutoplay(input: { applied: AutoplayMode | undefined; wanted: AutoplayMode; lastRebuildAt: number | undefined; now: number }): boolean {
  if (input.applied === undefined || input.applied === input.wanted) return false
  return input.lastRebuildAt === undefined || input.now - input.lastRebuildAt >= AUTOPLAY_REBUILD_GAP_MS
}
