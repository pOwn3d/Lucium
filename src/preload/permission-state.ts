// Part of the preload of every web page (installed by chrome-app.ts, in the main frame only: Electron loads a preload into no other frame).
// Electron answers a permission check by yes or no. A site nobody asked yet therefore reads `Notification.permission === 'denied'`, and "denied"
// from `navigator.permissions.query`: it takes that for a refusal of the user, and never offers its notifications (or its camera). In any browser
// such a site reads "default" and "prompt". This gives the page that answer: when Chromium says "denied", the main process is asked whether
// anybody answered for this site (shared/permission-state.ts), and when nobody did the page reads "default" / "prompt". Allowed and refused read
// what Chromium says. The page is given no way to the main process: the channel lives in the isolated world, and answers one bit.

import { ipcRenderer } from 'electron'
import { PERMISSION_STATE, QUERIED_NAMES } from '../shared/permission-state'

/** Self-contained on purpose: Electron serializes this function and runs it in the main world, before the scripts of the page. */
export function mainWorldPermissionState(undecided: (name: string) => boolean): void {
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return
  try {
    // Taken now: a page that replaces `Reflect.apply` later must not be able to steer the calls below.
    const applyNative = Reflect.apply
    const g = globalThis as { Notification?: object; PermissionStatus?: { prototype: object } }
    const notification = g.Notification
    const permission = notification ? Object.getOwnPropertyDescriptor(notification, 'permission') : undefined
    if (notification && permission && typeof permission.get === 'function') {
      Object.defineProperty(notification, 'permission', {
        ...permission,
        get: new Proxy(permission.get, {
          apply(target, thisArg, args) {
            const value: unknown = applyNative(target, thisArg, args)
            return value === 'denied' && undecided('notifications') ? 'default' : value
          }
        })
      })
    }
    // What `navigator.permissions.query` resolves with: its `state` is read each time, so an answer given later is seen.
    const status = g.PermissionStatus?.prototype
    const state = status ? Object.getOwnPropertyDescriptor(status, 'state') : undefined
    const name = status ? Object.getOwnPropertyDescriptor(status, 'name') : undefined
    if (status && state && typeof state.get === 'function' && name && typeof name.get === 'function') {
      const nameOf = name.get
      Object.defineProperty(status, 'state', {
        ...state,
        get: new Proxy(state.get, {
          apply(target, thisArg, args) {
            const value: unknown = applyNative(target, thisArg, args)
            if (value !== 'denied') return value
            const asked: unknown = applyNative(nameOf, thisArg, [])
            return typeof asked === 'string' && undecided(asked) ? 'prompt' : value
          }
        })
      })
    }
  } catch (error) {
    // The page keeps what Chromium says; the console of the page says why.
    console.warn('[lucium] the state of the permissions could not be set up:', error instanceof Error ? error.message : String(error))
  }
}

const NAMES: ReadonlySet<string> = new Set(QUERIED_NAMES)

/** Whether nobody answered yet for this permission and the site of this page. False for a name that is not asked about, and when the browser cannot be reached. */
export function undecided(name: string): boolean {
  if (!NAMES.has(name)) return false
  try {
    return ipcRenderer.sendSync(PERMISSION_STATE.undecided, name) === true
  } catch (error) {
    // The page reads what Chromium says ("denied"); the console says why.
    console.warn('[lucium] the state of a permission could not be asked of the browser:', error instanceof Error ? error.message : String(error))
    return false
  }
}
