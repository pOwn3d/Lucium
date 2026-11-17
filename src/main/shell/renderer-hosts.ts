// What every renderer process of the application draws, for the task manager (shared/processes.ts names the rows): what the window group
// accounts for (Browser.rendererHosts), then every other web contents by what it is (an extension's page, a window of our interface, a
// private window's page…), then the running service workers. No address leaves here: the scheme, the file of the interface, the name of an
// extension or of a tab.

import { execFile } from 'node:child_process'
import { webContents as allWebContents, type Session, type WebContents } from 'electron'
import { contentsHost, type RendererHost } from '@shared/processes'
import { isSurfaceLocked } from './surface-guard'

export interface RendererInventoryInput {
  /** What the window group accounts for (Browser.rendererHosts). */
  group: ReadonlyMap<number, readonly RendererHost[]>
  /** The processes of the tabs' pages (Browser.pageProcesses): named after their tab, nothing more is looked up for them. */
  pages: ReadonlyMap<number, string>
  /** The OS pids of every renderer Electron measured: a service worker may run in one that no web contents shares. */
  renderers: readonly number[]
  /** The name of a tab of the group on this origin, for the service worker of a site. */
  tabOnOrigin: (origin: string) => string | undefined
}

/** The command lines of these processes, from which the Chromium id of a renderer is read. Some output even when one of them is gone. The system's ps, by its absolute path: never one found on a PATH. */
export function commandLines(pids: readonly number[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-ww', '-o', 'pid=,args=', '-p', pids.join(',')], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => (stdout ? resolve(stdout) : reject(error ?? new Error('ps printed nothing'))))
  })
}

/**
 * The Chromium id of a renderer by its OS pid: `--renderer-client-id`, the id that `webContents.getProcessId()` and the `renderProcessId` of
 * a service worker give (-1: its command line has none). Read once per process, and only for the processes no web contents or frame is in.
 */
const clientIdOfPid = new Map<number, number>()

/** The frames of a web contents; none when they cannot be read (the next refresh reads them again). */
function framesOf(wc: WebContents): Array<{ processId: number; osProcessId: number }> {
  try {
    return wc.mainFrame.framesInSubtree
  } catch (error) {
    console.warn('[task manager] the frames of a web contents could not be read:', (error as Error).message)
    return []
  }
}

function extensionName(ses: Session, url: string): string | undefined {
  if (!url.startsWith('chrome-extension://') || !URL.canParse(url)) return undefined
  return ses.extensions.getExtension(new URL(url).hostname)?.name
}

function hostOfWorker(ses: Session, scope: string, tabOnOrigin: (origin: string) => string | undefined): RendererHost {
  if (scope.startsWith('chrome-extension://')) return contentsHost({ url: scope, surface: false, extension: extensionName(ses, scope), persistent: true })
  if (!ses.isPersistent()) return { kind: 'worker', private: true }
  const owner = URL.canParse(scope) ? tabOnOrigin(new URL(scope).origin) : undefined
  return { kind: 'worker', ...(owner ? { owner } : {}) }
}

/**
 * What each renderer process draws, by OS pid: the group's own hosts, then for the processes it does not account for (nor `pages`) what their
 * web contents show, then the service workers. A worker is placed by the Chromium id of its process: that of a web contents or of a frame in
 * the same process, else the one read from the command line (`readCommandLines`); one that cannot be placed is left out. What cannot be read
 * leaves the group's hosts as they are, and says why in the log: the task manager lists its processes whatever happens here.
 */
export async function rendererHosts(input: RendererInventoryInput, readCommandLines: (pids: readonly number[]) => Promise<string> = commandLines): Promise<Map<number, RendererHost[]>> {
  const hosts = new Map<number, RendererHost[]>()
  for (const [pid, list] of input.group) hosts.set(pid, [...list])
  const add = (pid: number, host: RendererHost): void => {
    if (pid > 0) hosts.set(pid, [...(hosts.get(pid) ?? []), host])
  }
  const osPidOf = new Map<number, number>()
  const workers: Array<{ clientId: number; host: RendererHost }> = []
  try {
    const sessions = new Set<Session>()
    const found: Array<[number, RendererHost]> = []
    for (const wc of allWebContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue
      const pid = wc.getOSProcessId()
      if (pid <= 0) continue
      sessions.add(wc.session)
      osPidOf.set(wc.getProcessId(), pid)
      for (const frame of framesOf(wc)) if (frame.osProcessId > 0) osPidOf.set(frame.processId, frame.osProcessId)
      if (input.pages.has(pid) || hosts.has(pid)) continue
      const url = wc.getURL()
      found.push([pid, contentsHost({ url, surface: isSurfaceLocked(wc), extension: extensionName(wc.session, url), persistent: wc.session.isPersistent() })])
    }
    for (const [pid, host] of found) add(pid, host)
    for (const ses of sessions) {
      for (const info of Object.values(ses.serviceWorkers.getAllRunning())) workers.push({ clientId: info.renderProcessId, host: hostOfWorker(ses, info.scope, input.tabOnOrigin) })
    }
  } catch (error) {
    console.warn('[task manager] the renderers that are not tabs could not all be named:', (error as Error).message)
    return hosts
  }

  const live = new Set(input.renderers)
  for (const pid of [...clientIdOfPid.keys()]) if (!live.has(pid)) clientIdOfPid.delete(pid)
  const withContents = new Set(osPidOf.values())
  const placed = (clientId: number): number | undefined => osPidOf.get(clientId) ?? [...clientIdOfPid].find(([, id]) => id === clientId)?.[0]
  const unread = input.renderers.filter((pid) => !clientIdOfPid.has(pid) && !withContents.has(pid))
  if (unread.length > 0 && workers.some((worker) => placed(worker.clientId) === undefined)) {
    try {
      for (const line of (await readCommandLines(unread)).split('\n')) {
        const match = /^\s*(\d+)\s.*--renderer-client-id=(\d+)/.exec(line)
        if (match) clientIdOfPid.set(Number(match[1]), Number(match[2]))
      }
    } catch (error) {
      console.warn('[task manager] the command lines of the renderers could not be read; their service workers stay unnamed:', (error as Error).message)
    }
    // Read once: a process whose line said nothing (or could not be read) is not asked about again at every refresh.
    for (const pid of unread) if (!clientIdOfPid.has(pid)) clientIdOfPid.set(pid, -1)
  }
  for (const worker of workers) add(placed(worker.clientId) ?? 0, worker.host)
  return hosts
}
