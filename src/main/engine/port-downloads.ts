// The engine port (types.ts), the downloads: their progress, pause and resumption (after a restart too), where they go, under which name, and
// the question the user may be asked. Re-exported by types.ts, which the rest of Lucium imports.

import type { DownloadInfo } from '@shared/model'

/** The downloads of the engine. */
export interface EngineDownloads {
  /** Called on every download state or progress change. `sourcePageId` is the page that triggered it, when known. */
  onDownload(listener: (download: DownloadInfo, sourcePageId: string | undefined, profileId: string) => void): void
  cancelDownload(id: string): void
  /** Pauses a running download (it keeps its connection and its file), or resumes a paused one or an interrupted one that can go on. Nothing happens for another state. */
  pauseDownload(id: string): void
  /**
   * Resumes a paused download, an interrupted one that can go on, or (setting `downloadResume`, main window only) one that a record on disk
   * can carry on after a restart: the server is asked first, and a refusal is told to the user.
   */
  resumeDownload(id: string): void
  /**
   * Turns on the resumption of downloads after a restart (main window only; a private window answers nothing and records nothing). The file
   * of records is read, each record is judged again and the ones that can go on come back as interrupted, resumable rows. A launch that did
   * not download in a single stream records nothing and says so.
   */
  startDownloadResume(options: DownloadResumeOptions): DownloadInfo[]
  /** Turns it off. `purge` (the setting went off): the records, the file and the partial files that are ours are removed. Otherwise (the window closes) they stay for the next launch. */
  stopDownloadResume(purge: boolean): void
  /** The user removed the row of a download that is not running: its record and its partial file (when certainly ours) go. */
  forgetSavedDownload(id: string): void
  /** Brings the records up to date; the application is about to quit. */
  flushDownloadResume(): void
  /**
   * Where each profile's downloads go (absolute folder), or undefined for the system Downloads folder. A private context or a container is of no
   * profile: its resolver is given the page the download started from as well (when one did), which is how the shell finds the space of the tab.
   */
  setDownloadDirResolver(resolver: ((profileId: string, sourcePageId?: string) => string | undefined) | null): void
  /** What the engine does with downloads beyond the default: ask where a file goes, honour "open without keeping" on links (see DownloadPolicy). */
  setDownloadPolicy(policy: DownloadPolicy): void
  /** Empties the application's temporary folder of downloads (files opened without keeping, files waiting for a place). Failures are logged with their path. */
  sweepDownloadStaging(): void
  /** Picks the name a download is saved under, given the server's filename and the URL. `null` keeps the server's name. */
  setDownloadNamer(namer: ((filename: string, url: string) => string) | null): void
}

/** What the user is asked when a download starts and the dialog proposes: the name (clean), the folder the profile saves to, and where it comes from. */
export interface SaveRequest {
  filename: string
  folder: string
  url: string
}

/**
 * The optional behaviours of downloads, each at zero cost while off. `ask`: called when a download starts, resolves with the file the user
 * chose or null when they gave up (the download is then cancelled); null means never ask. `openUnsaved`: a link may be downloaded to the
 * application's temporary folder to be opened and not kept.
 */
export interface DownloadPolicy {
  ask: ((request: SaveRequest) => Promise<string | null>) | null
  openUnsaved: boolean
  /**
   * Called before a file that can run is saved (see download-warning.ts): true saves it, false cancels the download and keeps nothing. Absent or
   * null means the warning is off. The file waits in the temporary folder meanwhile, as it does when the place is asked.
   */
  confirmExecutable?: ((request: ExecutableRequest) => Promise<boolean>) | null
}

/** What the user is told before a file that can run is saved: the name it would have, and the host it comes from (never the full address). */
export interface ExecutableRequest {
  filename: string
  host: string
}

export const NO_DOWNLOAD_POLICY: DownloadPolicy = { ask: null, openUnsaved: false, confirmExecutable: null }

/** What the shell gives the engine to resume downloads after a restart. */
export interface DownloadResumeOptions {
  /** Whether a profile still has a space: a record of a profile that is gone is dropped, its file is left alone. */
  profileLive(profileId: string): boolean
  /** A sentence for the user (a refusal, a record dropped). It names the file, never the address. */
  notify(message: string): void
}
