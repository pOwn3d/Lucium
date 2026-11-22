// A layer of the class ElectronEngine (electron-engine.ts; the order of the layers: docs/architecture.md). The downloads: the folder and the names, the
// handler of will-download, pause and resume, the resumption after a restart, the staging folder.

import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { app, type Session } from 'electron'
import type { DownloadInfo } from '@shared/model'
import { interruptedBecause } from '@shared/downloads-view'
import { safeDownloadName } from '@shared/chrome-compat'
import { isAuthContents } from './web-auth'
import { hostOf as hostOfUrl, logOrigin } from '@shared/url'
import { uniquePath } from './download-paths'
import { chosenFilePath } from './download-names'
import { DownloadStaging, stagedOutcome, stagingRootFor } from './download-staging'
import { earlyQuarantine, quarantineDownload } from './download-quarantine'
import { DownloadResume, defaultRandom, describeError, realResumeFs, type ProbeRequest, type ResumePorts, type Tracker } from './download-resume'
import { singleStreamActive } from './single-stream'
import { RESUME_FILE, type ItemView, type ProbeAnswer } from '@shared/download-resume'
import { suggestedFileName } from '@shared/file-names'
import { currentPlatform } from '../platform'
import { isExecutableDownload } from '@shared/open-with'
import { warnsBeforeSaving } from '@shared/download-warning'
import type { DownloadPolicy, DownloadResumeOptions, SaveRequest } from './types'
import { t } from '@shared/i18n'
import { DOWNLOAD_EMIT_INTERVAL_MS, RESUME_PROBE_TIMEOUT_MS, type Scope, type ActiveDownload, freeBytesOf } from './electron-engine-base'
import { ElectronEnginePermissions } from './electron-engine-permissions'

export abstract class ElectronEngineDownloads extends ElectronEnginePermissions {
  setDownloadDirResolver(resolver: ((profileId: string, sourcePageId?: string) => string | undefined) | null): void {
    this.downloadDirResolver = resolver
  }

  /** The folder a profile's downloads go to: its own when it can be created, else the system Downloads folder. */
  private downloadFolder(profileId: string, resolver = this.downloadDirResolver, sourcePageId?: string): string {
    const own = resolver?.(profileId, sourcePageId)
    if (!own) return app.getPath('downloads')
    try {
      mkdirSync(own, { recursive: true })
      return own
    } catch (error) {
      console.warn(`[downloads] cannot use ${own} for profile ${profileId}, using the Downloads folder:`, (error as Error).message)
      return app.getPath('downloads')
    }
  }

  setDownloadNamer(namer: ((filename: string, url: string) => string) | null): void {
    this.downloadNamer = namer
  }

  onDownload(listener: (download: DownloadInfo, sourcePageId: string | undefined, profileId: string) => void): void {
    this.downloadListeners.push(listener)
  }

  cancelDownload(id: string): void {
    this.downloads.get(id)?.item.cancel()
  }

  pauseDownload(id: string): void {
    const active = this.downloads.get(id)
    if (!active || active.item.getState() !== 'progressing' || active.item.isPaused()) return
    active.item.pause()
    active.refresh()
  }

  resumeDownload(id: string): void {
    // Not running in this launch: a record on disk may carry it on (after the checks of download-resume.ts).
    if (!this.downloads.has(id)) {
      void this.resume?.resume(id)
      return
    }
    this.resumeLiveDownload(id)
  }

  /** @internal For `EphemeralScope`, whose downloads have no record: only a download that is running in this launch. */
  resumeLiveDownload(id: string): void {
    const active = this.downloads.get(id)
    if (!active || !active.item.canResume()) return
    if (active.item.getState() === 'progressing' && !active.item.isPaused()) return
    active.item.resume()
    active.refresh()
  }

  startDownloadResume(options: DownloadResumeOptions): DownloadInfo[] {
    if (this.resume) return []
    const ports: ResumePorts = {
      fs: realResumeFs,
      file: join(app.getPath('userData'), RESUME_FILE),
      now: () => Date.now(),
      random: defaultRandom,
      folderOf: (profileId) => this.downloadFolder(profileId),
      profileLive: options.profileLive,
      probe: (profileId, request) => this.probeDownloadServer(profileId, request),
      createInterrupted: (profileId, created) => this.ensureProfile(profileId).session.createInterruptedDownload(created),
      emit: (info, profileId) => {
        for (const listener of this.downloadListeners) listener(info, undefined, profileId)
      },
      notify: options.notify,
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
      log: (level, message) => console[level](message)
    }
    const service = new DownloadResume(ports)
    // A launch that did not download in a single stream (see single-stream.ts) only makes the file, so that the next one does.
    const recording = singleStreamActive()
    const rows = service.start(recording)
    this.resume = service
    if (!recording) {
      console.warn('[downloads] this launch did not download in a single stream: downloads are recorded from the next launch')
      options.notify(t('engine.redemarrez-lucium-pour-que-les'))
    }
    return rows
  }

  stopDownloadResume(purge: boolean): void {
    this.resume?.stop(purge)
    this.resume = null
  }

  forgetSavedDownload(id: string): void {
    this.resume?.forget(id)
  }

  flushDownloadResume(): void {
    this.resume?.flush()
  }

  /**
   * One byte of the file, asked of its server with the session of the profile that downloaded it: the answer says whether the server still
   * holds the same file (see `judgeProbe`). Redirections are not followed, and the body is not read.
   */
  private async probeDownloadServer(profileId: string, request: ProbeRequest): Promise<ProbeAnswer> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), RESUME_PROBE_TIMEOUT_MS)
    try {
      const response = await this.ensureProfile(profileId).session.fetch(request.url, {
        method: 'GET',
        headers: request.headers,
        redirect: 'manual',
        credentials: 'include',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      const headers: Record<string, string | null> = {}
      for (const name of ['content-range', 'content-encoding', 'etag', 'last-modified']) headers[name] = response.headers.get(name)
      await response.body?.cancel().catch((error: unknown) => console.debug('[downloads] cannot cancel the body of a check:', describeError(error)))
      return { status: response.status, headers }
    } finally {
      clearTimeout(timer)
    }
  }

  setDownloadPolicy(policy: DownloadPolicy): void {
    this.downloadPolicy = policy
  }

  /** @internal For `EphemeralScope`. */
  scopeSetDownloadPolicy(scope: Scope, policy: DownloadPolicy): void {
    scope.downloadPolicy = policy
  }

  private stagingFolder(): DownloadStaging {
    this.staging ??= new DownloadStaging(stagingRootFor(app.getPath('userData'), app.getPath('temp')))
    return this.staging
  }

  sweepDownloadStaging(): void {
    // A folder that was never made is nothing to sweep, and costs one look.
    const staging = this.staging ?? new DownloadStaging(stagingRootFor(app.getPath('userData'), app.getPath('temp')))
    const { failures } = staging.sweep()
    for (const failure of failures) console.error(`[downloads] cannot remove ${failure.path} from the temporary folder: ${failure.error}`)
  }

  startDownload(profileId: string, url: string, options: { filename?: string; extensionId: string }): Promise<string> {
    const profile = this.profiles.get(profileId)
    if (!profile) return Promise.reject(new Error('No such profile'))
    if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error('Invalid URL'))
    if (options.filename !== undefined && safeDownloadName(options.filename) === null) return Promise.reject(new Error('Invalid filename'))
    return new Promise((resolve, reject) => {
      const pending = { ses: profile.session, url, ...(options.filename !== undefined ? { filename: options.filename } : {}), resolve }
      this.pendingDownloads.add(pending)
      // A download that never starts (the server is unreachable) must not leave its request waiting for ever.
      const timer = setTimeout(() => {
        this.pendingDownloads.drop(pending)
        reject(new Error('Download did not start'))
      }, 15_000)
      pending.resolve = (id) => {
        clearTimeout(timer)
        resolve(id)
      }
      profile.session.downloadURL(url)
    })
  }

  protected installDownloads(ses: Session, profileId: string, scope?: Scope): void {
    ses.on('will-download', (_e, item, sourceContents) => {
      // The page of a sign-in flow (a hidden one included) starts no download.
      if (isAuthContents(sourceContents)) return _e.preventDefault()
      // A download this launch asked Chromium to recreate (a resumption after a restart) is the record's: its id, its file, no question.
      const resumed = scope ? null : this.resume?.takeExpected(profileId, item.getURL()) ?? null
      const id = resumed?.id ?? `dl-${++this.downloadCounter}`
      // A download that starts in a popup belongs to the tab that opened it.
      const sourcePageId = sourceContents ? this.pageIdOf(sourceContents) ?? this.popups.ownerKeyOf(sourceContents) : undefined
      const namer = scope ? scope.namer : this.downloadNamer
      const listeners = scope ? scope.downloadListeners : this.downloadListeners
      const policy = scope ? scope.downloadPolicy : this.downloadPolicy
      // A private context or a container is of no profile: the page the download started from says which tab, hence which space, it is for.
      const folder = scope ? this.downloadFolder(profileId, scope.dirResolver, sourcePageId?.startsWith(scope.prefix) ? sourcePageId.slice(scope.prefix.length) : undefined) : this.downloadFolder(profileId)
      // An extension that started this download chose the file name; its folders are created inside the downloads folder. Only a download
      // no page started can be one (see RequestedDownloads.take): the user's own download of the same address stays the user's.
      const requested = scope || resumed ? undefined : this.pendingDownloads.take(ses, sourceContents, [item.getURL(), ...item.getURLChain()], id)
      const wanted = requested?.filename !== undefined ? safeDownloadName(requested.filename) : null
      const mimeType = item.getMimeType().slice(0, 100)
      // A link the user asked to open without keeping. A file that could run is kept like any other: it is never opened from here.
      const asked = policy.openUnsaved && !requested && !resumed && this.unsaved.take(ses, [item.getURL(), ...item.getURLChain()])
      const temporary = asked && !isExecutableDownload(item.getFilename(), mimeType)
      const proposed = wanted ?? namer?.(item.getFilename(), item.getURL()) ?? item.getFilename()
      // The place the user is asked for: not for a file an extension named, nor one opened without keeping.
      const ask = !requested && !temporary && !resumed ? policy.ask : null
      // A file that can run is not written to its place before the user has said yes (never on a resumption, nor for a file kept in the temporary folder).
      const confirmExecutable = policy.confirmExecutable ?? null
      const warn = confirmExecutable !== null && warnsBeforeSaving({ enabled: true, resumed: resumed !== null, temporary: Boolean(temporary), filename: basename(proposed), mimeType })
      let path: string
      let reserved = false
      let staging: DownloadStaging | null = null
      try {
        if (resumed) {
          // The file the record names, judged again just before Chromium was asked (download-resume.ts): not a new name.
          path = resumed.path
          this.reservedPaths.reserve(path)
          reserved = true
        } else if (temporary || ask || warn) {
          staging = this.stagingFolder()
          path = staging.allocate(id, proposed)
        } else {
          if (wanted?.includes('/')) mkdirSync(dirname(join(folder, wanted)), { recursive: true })
          path = uniquePath(folder, proposed, this.reservedPaths, existsSync)
          this.reservedPaths.reserve(path)
          reserved = true
        }
      } catch (error) {
        // No place to put the file (the temporary folder cannot be made): the download stops, and the log says which one.
        console.error(`[downloads] cannot prepare the place of download ${id} (${logOrigin(item.getURL())}):`, error)
        item.cancel()
        return
      }
      item.setSavePath(path)
      // Recorded for a resumption after a restart: never in a private window or tab (`scope`), never a file that waits in the temporary folder.
      const tracker: Tracker | null =
        !staging && !temporary && this.resume
          ? this.resume.track({
              profileId,
              path,
              folder,
              privateScope: scope !== undefined,
              view: () => ({ url: item.getURL(), received: item.getReceivedBytes(), total: item.getTotalBytes(), etag: item.getETag(), lastModified: item.getLastModifiedTime(), startTime: item.getStartTime(), mimeType } satisfies ItemView),
              ...(resumed ? { recordId: resumed.id } : {})
            })
          : null
      let chosen: string | null = null
      // The user refused the place (or the question failed): the download is cancelled, even when Chromium finished it first (see stagedOutcome).
      let placeRefused = false
      const downloadPath = (): string => chosen ?? path
      const entry: ActiveDownload = { item, refresh: () => emit(item.getState() === 'interrupted' ? 'interrupted' : 'progressing', true) }
      this.downloads.set(id, entry)
      const startedAt = resumed ? Math.round(resumed.startTime * 1000) : Date.now()
      let lastEmit = 0
      let lastState: DownloadInfo['state'] | null = null
      let finished = false
      // The finished file could not be marked as downloaded from the Internet (macOS): the row says so (see download-quarantine.ts).
      let unmarked = false
      const emit = (state: DownloadInfo['state'], force: boolean) => {
        const now = Date.now()
        if (!force && now - lastEmit < DOWNLOAD_EMIT_INTERVAL_MS) return
        lastEmit = now
        lastState = state
        const info: DownloadInfo = {
          id,
          filename: basename(downloadPath()),
          url: item.getURL(),
          path: downloadPath(),
          state,
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          startedAt
        }
        if (mimeType) info.mimeType = mimeType
        // Read only while the item is live: after its end Electron refuses to answer.
        if (!finished && state === 'progressing' && item.isPaused()) info.paused = true
        if (!finished && state === 'interrupted' && item.canResume()) info.resumable = true
        if (temporary) info.temporary = true
        if (unmarked) info.unmarked = true
        // Electron never says why a download stopped: a full disk is the one cause that can be told from the room left (see `interruptedBecause`).
        if (state === 'interrupted') {
          const reason = interruptedBecause({ freeBytes: freeBytesOf(dirname(downloadPath())), receivedBytes: info.receivedBytes, totalBytes: info.totalBytes })
          if (reason) info.reason = reason
        }
        if (tracker?.recorded()) {
          info.recorded = true
          if (state === 'interrupted') info.resumable = true
        }
        for (const listener of listeners) listener(info, sourcePageId, profileId)
      }
      // Chromium recreated a resumed download as interrupted: it goes on from the recorded offset only when told to. The row says what became of it.
      let restarted = true
      if (resumed) {
        try {
          item.resume()
        } catch (error) {
          restarted = false
          console.error(`[downloads] Chromium would not resume ${id} (${describeError(error)})`)
        }
      }
      emit(restarted ? 'progressing' : 'interrupted', true)
      // Asked once, at the start: the file downloads into the temporary folder meanwhile, and moves when the user has answered and the file is complete.
      // First the warning (a file that can run), then the place when it is asked; a « no » to either cancels the download.
      let reservedChosen: string | null = null
      const answered: Promise<void> =
        ask || warn
          ? Promise.resolve()
              .then(() => (warn && confirmExecutable ? confirmExecutable({ filename: basename(proposed), host: hostOfUrl(item.getURL()) }) : true))
              .then(async (go) => {
                if (!go) {
                  placeRefused = true
                  return item.cancel()
                }
                if (!ask) {
                  // Allowed, with no place to ask: the file goes where it would have gone without the question.
                  if (wanted?.includes('/')) mkdirSync(dirname(join(folder, wanted)), { recursive: true })
                  chosen = uniquePath(folder, proposed, this.reservedPaths, existsSync)
                  this.reservedPaths.reserve(chosen)
                  reservedChosen = chosen
                  if (!finished) emit(item.getState() === 'interrupted' ? 'interrupted' : 'progressing', true)
                  return
                }
                const answer = await ask({ filename: suggestedFileName(proposed, { platform: currentPlatform().id, folder }), folder, url: item.getURL() } satisfies SaveRequest)
                if (answer === null) {
                  placeRefused = true
                  return item.cancel()
                }
                const place = chosenFilePath(answer)
                if (place === null) {
                  console.error(`[downloads] the place chosen for download ${id} is not a file path, it is cancelled:`, answer)
                  placeRefused = true
                  return item.cancel()
                }
                chosen = place
                if (!finished) emit(item.getState() === 'interrupted' ? 'interrupted' : 'progressing', true)
              })
              .catch((error: unknown) => {
                console.error(`[downloads] the question before download ${id} (the place, or the warning about a file that can run) failed, it is cancelled:`, error)
                placeRefused = true
                item.cancel()
              })
          : Promise.resolve()
      // A change of state (a drop of the connection) is always told: it would be the last word of an interrupted download.
      // The file carries the mark of the system while it is still being written, not only once it is whole (download-quarantine.ts, `earlyQuarantine`).
      const markEarly = earlyQuarantine(() => path)
      item.on('updated', (_ev, state) => {
        markEarly(item.getReceivedBytes())
        const next = state === 'interrupted' ? 'interrupted' : 'progressing'
        if (next === 'interrupted') tracker?.interrupted()
        else tracker?.progress()
        emit(next, next !== lastState)
      })
      item.once('done', (_ev, state) => {
        // Asked now: once this event is over Electron no longer answers. A completed or cancelled download loses its record; an interrupted one keeps it if Chromium cannot go on by itself.
        if (tracker) {
          let canResume: boolean | undefined
          try {
            canResume = item.canResume()
          } catch (error) {
            console.debug(`[downloads] cannot ask whether ${id} can resume (${describeError(error)}): its record is kept, the checks before a resumption decide`)
          }
          tracker.finish(state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted', canResume)
        }
        this.downloads.delete(id)
        if (reserved) this.reservedPaths.release(path)
        void (async () => {
          await answered
          let outcome: DownloadInfo['state'] = stagedOutcome(state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted', placeRefused)
          let keepStaged = temporary
          if (staging && !temporary && outcome === 'completed' && chosen !== null) {
            try {
              staging.moveOut(path, chosen)
            } catch (error) {
              // The file stays in the temporary folder (swept at the next start) and the row says the download did not end well.
              console.error(`[downloads] cannot move download ${id} from ${path} to ${chosen}:`, error)
              outcome = 'interrupted'
              chosen = null
              keepStaged = true
            }
          }
          // A file that arrived whole carries the mark of the system before anyone can open it (Electron does not put it there itself).
          if (outcome === 'completed') {
            const marked = await quarantineDownload(downloadPath())
            if (!marked.ok) {
              unmarked = true
              console.error(`[downloads] cannot mark ${id} (${basename(downloadPath())}) as downloaded from the Internet: ${marked.reason}`)
            }
          }
          finished = true
          if (reservedChosen !== null) this.reservedPaths.release(reservedChosen)
          emit(outcome, true)
          // The folder of a file that waited for a place goes, moved or not; one opened without keeping stays until the application quits.
          if (staging && !keepStaged) {
            try {
              staging.release(path)
            } catch (error) {
              console.error(`[downloads] cannot remove ${path} from the temporary folder:`, error)
            }
          }
        })()
      })
    })
  }
}
