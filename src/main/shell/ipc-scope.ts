import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { isMainFrameSender } from '@shared/surface-guard'

/** The part of Electron's `ipcMain` the shell registers handlers with. */
export interface IpcHost {
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): unknown
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): unknown
}

/** What `registerIpc` sees in place of `ipcMain`: same calls, but the handlers only answer the windows of one scope. */
export interface ScopedIpc {
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void
}

/** The senders a scope answers: the ids of its windows, or (for the Extensions page in a tab) whatever says of an id whether a tab of the window shows the page now. */
export interface Trusted {
  has(id: number): boolean
}

interface Entry<E> {
  /** The webContents ids of the scope's windows: a message from one of them goes to this entry. */
  trusted: Trusted
  listener: (event: E, ...args: any[]) => unknown
}

interface Route {
  on: Entry<IpcMainEvent>[]
  handle: Entry<IpcMainInvokeEvent>[]
  registeredOn: boolean
  registeredHandle: boolean
}

// Electron lets one handler answer a channel. With several windows, each with its own browser and state, the single
// real handler of a channel looks at who sent the message and runs the one registered for that window.
const routes = new WeakMap<object, Map<string, Route>>()

function routeOf(host: object, channel: string): Route {
  let byChannel = routes.get(host)
  if (!byChannel) routes.set(host, (byChannel = new Map()))
  let route = byChannel.get(channel)
  if (!route) byChannel.set(channel, (route = { on: [], handle: [], registeredOn: false, registeredHandle: false }))
  return route
}

/** The entry for the sender's window, or none when no scope trusts it (a page that has the preload but is not one of our surfaces, a window that is gone). */
function pick<E extends { sender: { id: number } }>(entries: Entry<E>[], event: E): Entry<E> | undefined {
  return entries.find((entry) => entry.trusted.has(event.sender.id))
}

/**
 * Says no to a sender no scope trusts, before any handler sees the message: the `guard` each handler calls is a second line, no longer the only one
 * (a handler added later without it would answer any page that has `ipcRenderer`). The line keeps the wording of the guard's. The address loses its
 * query and fragment, and a web contents already destroyed has none to give.
 */
function refuseStranger(channel: string, event: { sender: { getURL?: () => string } }): void {
  let from = 'a page that is gone'
  try {
    from = event.sender.getURL?.().split(/[?#]/)[0] ?? from
  } catch {
    // Destroyed under the message: the channel is enough.
  }
  console.warn(`[ipc] ignored ${channel} from untrusted sender ${from}`)
}

/** `ipcMain` for one scope of windows (`trusted` = their webContents ids). Call once per window group; release it when they are gone. */
export function scopedIpc(host: IpcHost, trusted: Trusted): ScopedIpc {
  return {
    on(channel, listener) {
      const route = routeOf(host, channel)
      route.on.push({ trusted, listener })
      if (route.registeredOn) return
      route.registeredOn = true
      host.on(channel, (event, ...args) => {
        // Only the top frame of a surface speaks for it: a frame inside one (or a document that took its place) is not ours.
        if (!isMainFrameSender(event)) return console.warn(`[ipc] ignored ${channel} from a subframe or a frame that is gone`)
        const entry = pick(route.on, event)
        if (!entry) return refuseStranger(channel, event)
        entry.listener(event, ...args)
      })
    },
    handle(channel, listener) {
      const route = routeOf(host, channel)
      route.handle.push({ trusted, listener })
      if (route.registeredHandle) return
      route.registeredHandle = true
      host.handle(channel, (event, ...args) => {
        if (!isMainFrameSender(event)) {
          console.warn(`[ipc] ignored ${channel} from a subframe or a frame that is gone`)
          return undefined
        }
        // Like the subframe above: nothing is answered (the value of a refusal is `undefined`, the handlers' own refusals differ and are not run).
        const entry = pick(route.handle, event)
        if (!entry) return void refuseStranger(channel, event)
        return entry.listener(event, ...args)
      })
    }
  }
}

/** Forgets every handler a scope registered (its windows are closed): they would keep its browser alive. */
export function releaseIpcScope(host: object, trusted: Trusted): void {
  for (const route of routes.get(host)?.values() ?? []) {
    route.on = route.on.filter((entry) => entry.trusted !== trusted)
    route.handle = route.handle.filter((entry) => entry.trusted !== trusted)
  }
}
