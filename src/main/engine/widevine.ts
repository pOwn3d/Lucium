// Widevine, the module Netflix, Disney+ and the other video services need to play their protected films. The Electron of the project has no way to load it
// (docs/drm.md): the castLabs build of Electron ("ECS") does, through a `components` module that installs it from Google's component updater.
// A build of Lucium on ECS asks for it at start; on the Electron of the project there is no such module and nothing happens (nothing is contacted).
// The connection this makes, on the DRM build only: Google's component updater, at each launch, with no switch (README, docs/fonctions.md).
// Asking later, at the first protected video, would not spare it: the updater of ECS checks on its own timer once the browser runs, installed
// module or not, and only `--disable-component-update` before `app.ready` stops it (docs/drm.md). It would only make the first film after an
// installation fail while the module downloads. A switch for it is a setting read before `app.ready`, taken at the next launch (docs/drm.md §7).

import { t } from '@shared/i18n'

/** The part of the `components` module of the castLabs build that is used here. */
export interface Components {
  whenReady(): Promise<unknown>
  status(): Record<string, { status?: string; title?: string; version?: string } | undefined>
}

/** The `components` module of the electron module, or null when it is not the castLabs build. */
export function componentsOf(electron: unknown): Components | null {
  const candidate = (electron as { components?: unknown } | null | undefined)?.components
  return typeof candidate === 'object' && candidate !== null && typeof (candidate as Components).whenReady === 'function' && typeof (candidate as Components).status === 'function' ? (candidate as Components) : null
}

export type WidevineOutcome = { state: 'absent' } | { state: 'ready'; version: string | undefined } | { state: 'failed'; reason: string }

/** What the application says when the module could not be installed. */
export interface WidevineNotice {
  title: string
  body: string
}

export const widevineNotice = (reason: string): WidevineNotice => ({
  title: t('widevine.contenus-proteges-indisponibles'),
  body: t('widevine.module-non-installe-reason', { reason })
})

/** What the application says when the module arrives after the notice above: the wait was too short for the line, and nothing is wrong any more. */
export const widevineLateNotice = (): WidevineNotice => ({
  title: t('widevine.contenus-proteges-disponibles'),
  body: t('widevine.module-installe-apres-l-attente')
})

/** Long enough for a first download on a slow line; the pages do not wait for it (a service that asks before it is there is told to try again, as on a fresh install). */
export const WIDEVINE_TIMEOUT_MS = 120_000

/**
 * Has Widevine installed (or updated) and says what came of it. Never throws: a failure is the outcome, and `log` says why. The caller does not wait for it to start the browser.
 */
export async function installWidevine(components: Components | null, options: { timeoutMs?: number; log?: (line: string) => void; notify?: (notice: WidevineNotice) => void } = {}): Promise<WidevineOutcome> {
  if (!components) return { state: 'absent' }
  const log = options.log ?? (() => undefined)
  const timeoutMs = options.timeoutMs ?? WIDEVINE_TIMEOUT_MS
  // Said in the log each time: this is the one connection of the DRM build that nobody asked for at that moment.
  log('[widevine] asking Google’s component updater for the module (DRM build only)')
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  let ready: Promise<unknown> | undefined
  try {
    ready = components.whenReady()
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error(`not ready after ${Math.round(timeoutMs / 1000)} s`))
        }, timeoutMs)
      })
    ])
    const widevine = Object.values(components.status()).find((component) => /widevine/i.test(component?.title ?? ''))
    log(`[widevine] ready${widevine?.version ? ` (version ${widevine.version})` : ''}`)
    return { state: 'ready', version: widevine?.version }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log(`[widevine] cannot install the module, so protected videos will not play: ${reason}`)
    // The log is for the maintainer: a person who opens Netflix would only see the service's own code (M7701-1003), so the application says it.
    options.notify?.(widevineNotice(reason))
    // The wait ended, not the installation: on a slow line the module can still arrive. The person was told the videos would not play, so they are
    // told when they do; without this, Netflix works at the next launch and nobody knows why.
    if (timedOut && ready) {
      void ready.then(
        () => {
          log('[widevine] ready after the wait: protected videos play from now on')
          options.notify?.(widevineLateNotice())
        },
        (late: unknown) => log(`[widevine] the installation failed after the wait too: ${late instanceof Error ? late.message : String(late)}`)
      )
    }
    return { state: 'failed', reason }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
